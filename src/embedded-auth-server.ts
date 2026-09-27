import { randomBytes, timingSafeEqual } from 'node:crypto'
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  parseGarminEmbeddedAuthMessage,
  type GarminEmbeddedAuthTicket,
} from './embedded-auth-message'
import { PublicToolError } from './utils/errors'

const LOOPBACK_HOST = '127.0.0.1'
const BRIDGE_PATH_PREFIX = '/garmin-auth/bridge/'
const FLOW_ID_PATTERN = /^[a-f0-9]{64}$/
const CSRF_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const MAX_REQUEST_BODY_BYTES = 4 * 1024
const MAX_REQUEST_TARGET_BYTES = 512
const FIXED_ERROR_BODY = '{"ok":false,"error":"request_rejected"}'
const BRIDGE_AWAITING_STATUS = '请完成登录或验证。'
const UNSAFE_IDENTITY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g
const BRIDGE_ROUTE_PATTERN =
  /^\/garmin-auth\/bridge\/([a-f0-9]{64})(?:\/(ticket|status|confirm|cancel))?$/

export const GARMIN_EMBEDDED_AUTH_SERVER_REJECTED =
  'Garmin embedded authentication server request was rejected'

/** A fixed-message error safe to expose outside the trusted bridge process. */
export class GarminEmbeddedAuthServerError extends PublicToolError {
  override name = 'GarminEmbeddedAuthServerError'

  constructor() {
    super(GARMIN_EMBEDDED_AUTH_SERVER_REJECTED)
  }
}

export type EmbeddedAuthBridgeState =
  | 'awaiting_garmin'
  | 'exchanging'
  | 'waiting_confirmation'
  | 'saving'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'

export interface EmbeddedAuthBridgeIdentity {
  displayName?: string
  userName?: string
}

export interface EmbeddedAuthBridgeStatus {
  state: EmbeddedAuthBridgeState
  identity?: EmbeddedAuthBridgeIdentity
}

export interface EmbeddedAuthBridgeBootstrap {
  csrf: string
  frameUrl: string
  ssoOrigin: string
  serviceUrl: string
}

type Awaitable<T> = T | Promise<T>

/** Adapter implemented by the in-memory flow coordinator. */
export interface EmbeddedAuthServerAdapter {
  bridgeBootstrap(flowId: string): Awaitable<EmbeddedAuthBridgeBootstrap>
  bridgeStatus(
    flowId: string,
    csrf: string,
  ): Awaitable<EmbeddedAuthBridgeStatus>
  submitTicket(
    flowId: string,
    csrf: string,
    ticket: GarminEmbeddedAuthTicket,
  ): Awaitable<void>
  confirm(flowId: string, csrf: string, accepted: boolean): Awaitable<void>
  cancel(flowId: string, csrf: string): Awaitable<void>
}

/**
 * Dedicated loopback-only bridge for Garmin's embedded GAuth widget.
 *
 * Garmin's service ticket terminates here and is delivered straight to the
 * host-side flow adapter. The containing DSH page receives no ticket, session,
 * credential, or identity message from this server.
 */
export class EmbeddedAuthServer {
  private readonly adapter: EmbeddedAuthServerAdapter
  private server?: Server
  private originValue?: string
  private hostHeaderValue?: string
  private startOperation?: Promise<string>

  constructor(adapter: EmbeddedAuthServerAdapter) {
    if (!isAdapter(adapter)) throw rejection()
    this.adapter = adapter
  }

  async start(): Promise<string> {
    if (this.originValue) return this.originValue
    if (this.startOperation) return this.startOperation

    const operation = this.listen()
    this.startOperation = operation
    try {
      return await operation
    } finally {
      if (this.startOperation === operation) this.startOperation = undefined
    }
  }

  bridgeUrl(flowId: string): string {
    if (!this.originValue || !FLOW_ID_PATTERN.test(flowId)) throw rejection()
    return `${this.originValue}${BRIDGE_PATH_PREFIX}${flowId}`
  }

  async close(): Promise<void> {
    if (this.startOperation) {
      try {
        await this.startOperation
      } catch {
        return
      }
    }

    const server = this.server
    this.server = undefined
    this.originValue = undefined
    this.hostHeaderValue = undefined
    if (!server) return

    await new Promise<void>((resolve, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(rejection())
        else resolve()
      })
    })
  }

  private listen(): Promise<string> {
    return new Promise((resolve, rejectListen) => {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request, response).catch(() => {
          if (!response.headersSent) {
            sendRejected(response, 400)
          } else {
            response.destroy()
          }
        })
      })
      server.maxHeadersCount = 32
      server.headersTimeout = 5_000
      server.requestTimeout = 10_000
      server.keepAliveTimeout = 1_000

      const fail = () => {
        server.close()
        rejectListen(rejection())
      }
      server.once('error', fail)
      server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
        server.off('error', fail)
        const address = server.address()
        if (!isLoopbackAddress(address)) {
          server.close()
          rejectListen(rejection())
          return
        }
        const hostHeader = `${LOOPBACK_HOST}:${address.port}`
        this.server = server
        this.hostHeaderValue = hostHeader
        this.originValue = `http://${hostHeader}`
        resolve(this.originValue)
      })
    })
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const origin = this.originValue
    const expectedHost = this.hostHeaderValue
    if (!origin || !expectedHost || request.headers.host !== expectedHost) {
      request.resume()
      sendRejected(response, 403)
      return
    }

    const route = parseRoute(request.url)
    if (!route) {
      request.resume()
      sendRejected(response, 404)
      return
    }

    if (!route.action) {
      if (request.method !== 'GET') {
        request.resume()
        sendRejected(response, 405)
        return
      }
      const bootstrap = normalizeBootstrap(
        await this.adapter.bridgeBootstrap(route.flowId),
        origin,
      )
      sendBridgePage(response, bootstrap, origin)
      return
    }

    if (request.method !== 'POST') {
      request.resume()
      sendRejected(response, 405)
      return
    }
    if (request.headers.origin !== origin) {
      request.resume()
      sendRejected(response, 403)
      return
    }
    if (!hasJsonContentType(request.headers['content-type'])) {
      request.resume()
      sendRejected(response, 415)
      return
    }

    const csrfHeader = request.headers['x-garmin-auth-csrf']
    if (typeof csrfHeader !== 'string') {
      request.resume()
      sendRejected(response, 403)
      return
    }

    const declaredLength = parseContentLength(request.headers['content-length'])
    if (declaredLength === 'invalid') {
      request.resume()
      sendRejected(response, 400)
      return
    }
    if (declaredLength !== undefined && declaredLength > MAX_REQUEST_BODY_BYTES) {
      request.resume()
      sendRejected(response, 413)
      return
    }

    const bodyResult = await readBoundedBody(request)
    if (bodyResult.tooLarge) {
      sendRejected(response, 413)
      return
    }

    const bootstrap = normalizeBootstrap(
      await this.adapter.bridgeBootstrap(route.flowId),
      origin,
    )
    if (!constantTimeEqual(csrfHeader, bootstrap.csrf)) {
      sendRejected(response, 403)
      return
    }

    let body: unknown
    try {
      body = JSON.parse(bodyResult.text)
    } catch {
      sendRejected(response, 400)
      return
    }

    switch (route.action) {
      case 'ticket': {
        const message = parseGarminEmbeddedAuthMessage(body, {
          observedOrigin: bootstrap.ssoOrigin,
          expectedOrigin: bootstrap.ssoOrigin,
          sourceMatches: true,
          expectedServiceUrl: bootstrap.serviceUrl,
          expectedBridgeOrigin: origin,
        })
        await this.adapter.submitTicket(
          route.flowId,
          bootstrap.csrf,
          message,
        )
        sendJson(response, 202, { ok: true })
        return
      }
      case 'status': {
        if (!isExactObject(body, [])) {
          sendRejected(response, 400)
          return
        }
        const status = normalizeBridgeStatus(
          await this.adapter.bridgeStatus(route.flowId, bootstrap.csrf),
        )
        sendJson(response, 200, { ok: true, status })
        return
      }
      case 'confirm': {
        if (!isExactObject(body, ['accepted']) || typeof body.accepted !== 'boolean') {
          sendRejected(response, 400)
          return
        }
        await this.adapter.confirm(
          route.flowId,
          bootstrap.csrf,
          body.accepted,
        )
        sendJson(response, 200, { ok: true })
        return
      }
      case 'cancel': {
        if (!isExactObject(body, [])) {
          sendRejected(response, 400)
          return
        }
        await this.adapter.cancel(route.flowId, bootstrap.csrf)
        sendJson(response, 200, { ok: true })
      }
    }
  }
}

interface ParsedRoute {
  flowId: string
  action?: 'ticket' | 'status' | 'confirm' | 'cancel'
}

function parseRoute(target: string | undefined): ParsedRoute | undefined {
  if (
    typeof target !== 'string'
    || Buffer.byteLength(target, 'utf8') > MAX_REQUEST_TARGET_BYTES
    || !target.startsWith('/')
    || target.startsWith('//')
    || target.includes('%')
    || target.includes('\\')
    || target.includes('?')
    || target.includes('#')
  ) {
    return undefined
  }
  const match = BRIDGE_ROUTE_PATTERN.exec(target)
  if (!match) return undefined
  const action = match[2] as ParsedRoute['action']
  return action
    ? { flowId: match[1], action }
    : { flowId: match[1] }
}

function parseContentLength(
  value: string | undefined,
): number | undefined | 'invalid' {
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return 'invalid'
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 'invalid'
}

async function readBoundedBody(
  request: IncomingMessage,
): Promise<{ text: string; tooLarge: boolean }> {
  const chunks: Buffer[] = []
  let byteLength = 0
  let tooLarge = false
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
      tooLarge = true
      continue
    }
    chunks.push(bytes)
  }
  return {
    text: tooLarge ? '' : Buffer.concat(chunks, byteLength).toString('utf8'),
    tooLarge,
  }
}

function normalizeBootstrap(
  value: unknown,
  bridgeOrigin: string,
): EmbeddedAuthBridgeBootstrap {
  if (!isExactObject(value, ['csrf', 'frameUrl', 'ssoOrigin', 'serviceUrl'])) {
    throw rejection()
  }
  const { csrf, frameUrl, ssoOrigin, serviceUrl } = value
  if (
    typeof csrf !== 'string'
    || !CSRF_PATTERN.test(csrf)
    || (ssoOrigin !== 'https://sso.garmin.com'
      && ssoOrigin !== 'https://sso.garmin.cn')
    || serviceUrl !== `${ssoOrigin}/sso/embed`
    || !isGAuthFrameUrl(frameUrl, ssoOrigin, serviceUrl, bridgeOrigin)
  ) {
    throw rejection()
  }
  return { csrf, frameUrl, ssoOrigin, serviceUrl }
}

function isGAuthFrameUrl(
  value: unknown,
  ssoOrigin: string,
  serviceUrl: string,
  bridgeOrigin: string,
): value is string {
  if (typeof value !== 'string' || value.length > 4 * 1024) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const parameterNames = Array.from(url.searchParams.keys())
  const expectedParameterNames = [
    'id',
    'embedWidget',
    'gauthHost',
    'service',
    'source',
    'consumeServiceTicket',
  ]
  return parameterNames.length === expectedParameterNames.length
    && new Set(parameterNames).size === expectedParameterNames.length
    && expectedParameterNames.every(name => parameterNames.includes(name))
    && url.origin === ssoOrigin
    && url.pathname === '/sso/signin'
    && url.username === ''
    && url.password === ''
    && url.hash === ''
    && url.searchParams.get('id') === 'gauth-widget'
    && url.searchParams.get('embedWidget') === 'true'
    && url.searchParams.get('gauthHost') === `${ssoOrigin}/sso`
    && url.searchParams.get('service') === serviceUrl
    && url.searchParams.get('source') === bridgeOrigin
    && url.searchParams.get('consumeServiceTicket') === 'false'
}

function normalizeBridgeStatus(value: unknown): EmbeddedAuthBridgeStatus {
  if (!isPlainObject(value)) throw rejection()
  const keys = Object.keys(value)
  if (!keys.every(key => key === 'state' || key === 'identity')) {
    throw rejection()
  }
  if (!BRIDGE_STATES.has(value.state as EmbeddedAuthBridgeState)) {
    throw rejection()
  }
  const status: EmbeddedAuthBridgeStatus = {
    state: value.state as EmbeddedAuthBridgeState,
  }
  if (value.identity !== undefined) {
    const identity = normalizeIdentity(value.identity)
    if (!identity) throw rejection()
    status.identity = identity
  }
  return status
}

const BRIDGE_STATES = new Set<EmbeddedAuthBridgeState>([
  'awaiting_garmin',
  'exchanging',
  'waiting_confirmation',
  'saving',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
])

function normalizeIdentity(value: unknown): EmbeddedAuthBridgeIdentity | undefined {
  if (!isPlainObject(value)) return undefined
  const keys = Object.keys(value)
  if (!keys.every(key => key === 'displayName' || key === 'userName')) {
    return undefined
  }
  const displayName = normalizeIdentityValue(value.displayName)
  const userName = normalizeIdentityValue(value.userName)
  if (!displayName && !userName) return undefined
  return {
    ...(displayName ? { displayName } : {}),
    ...(userName ? { userName } : {}),
  }
}

function normalizeIdentityValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return undefined
  const normalized = value
    .normalize('NFKC')
    .replace(UNSAFE_IDENTITY_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized) return undefined
  return Array.from(normalized).slice(0, 120).join('')
}

function isExactObject(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length
    && expectedKeys.every(key => keys.includes(key))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isAdapter(value: unknown): value is EmbeddedAuthServerAdapter {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return [
    'bridgeBootstrap',
    'bridgeStatus',
    'submitTicket',
    'confirm',
    'cancel',
  ].every(method => typeof candidate[method] === 'function')
}

function hasJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string'
    && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value)
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

function isLoopbackAddress(value: unknown): value is AddressInfo {
  return typeof value === 'object'
    && value !== null
    && 'address' in value
    && 'family' in value
    && 'port' in value
    && value.address === LOOPBACK_HOST
    && (value.family === 'IPv4' || value.family === 4)
    && typeof value.port === 'number'
    && Number.isInteger(value.port)
    && value.port >= 1
    && value.port <= 65_535
}

function sendBridgePage(
  response: ServerResponse,
  bootstrap: EmbeddedAuthBridgeBootstrap,
  bridgeOrigin: string,
): void {
  const nonce = randomBytes(18).toString('base64')
  const body = renderBridgePage(bootstrap, nonce, bridgeOrigin)
  applyCommonHeaders(response)
  response.statusCode = 200
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `frame-src ${bootstrap.ssoOrigin}`,
      "connect-src 'self'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'none'",
      "font-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      'frame-ancestors dsh-app://app http://127.0.0.1:* http://localhost:*',
      "require-trusted-types-for 'script'",
      "trusted-types 'none'",
    ].join('; '),
  )
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  )
  response.end(body)
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  applyCommonHeaders(response)
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

function sendRejected(response: ServerResponse, statusCode: number): void {
  applyCommonHeaders(response)
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(FIXED_ERROR_BODY)
}

function applyCommonHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

function renderBridgePage(
  bootstrap: EmbeddedAuthBridgeBootstrap,
  nonce: string,
  bridgeOrigin: string,
): string {
  const config = safeInlineJson({
    csrf: bootstrap.csrf,
    ssoOrigin: bootstrap.ssoOrigin,
    serviceUrl: bootstrap.serviceUrl,
    bridgeOrigin,
  })
  const frameUrl = escapeHtmlAttribute(bootstrap.frameUrl)
  const script = bridgeScript(config)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Garmin Connect 登录</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f7fb;
      color: #1b2738;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f7fb; color: #1b2738; }
    main {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(28rem, 1fr) auto;
      gap: .65rem;
      padding: .7rem;
    }
    .bridge-notice {
      display: flex;
      align-items: center;
      gap: .65rem;
      min-height: 3.35rem;
      padding: .6rem .75rem;
      background: #f0f8f4;
      border: 1px solid #d1eadc;
      border-radius: .8rem;
      color: #1e6046;
    }
    .notice-icon {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.8rem;
      height: 1.8rem;
      border-radius: 999px;
      background: #dff3e8;
      font-size: .8rem;
      font-weight: 800;
    }
    .notice-copy { min-width: 0; }
    .notice-copy strong { display: block; font-size: .78rem; }
    p { margin: .18rem 0 0; line-height: 1.42; }
    #status { color: #516477; font-size: .72rem; }
    iframe {
      width: 100%;
      min-height: 32rem;
      border: 1px solid #dce4ed;
      border-radius: .8rem;
      background: white;
      box-shadow: 0 .4rem 1.6rem rgba(35, 55, 80, .08);
    }
    #confirmation {
      align-self: center;
      width: min(30rem, calc(100vw - 2.8rem));
      margin: 1rem auto;
      padding: 1.4rem;
      border: 1px solid #dce4ed;
      border-radius: 1rem;
      background: white;
      box-shadow: 0 .8rem 2.5rem rgba(35, 55, 80, .12);
      text-align: center;
    }
    .confirmation-title { color: #1b2738; font-size: .9rem; font-weight: 750; }
    .confirmation-hint { color: #6a7889; font-size: .72rem; }
    #identity {
      margin: .9rem 0 .25rem;
      padding: .75rem;
      border-radius: .7rem;
      background: #f3f7fa;
      color: #26364a;
      font-size: .78rem;
      font-weight: 650;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #result { display: flex; justify-content: flex-end; padding: 0 .1rem .1rem; }
    button {
      min-height: 2.35rem;
      padding: 0 1rem;
      border-radius: .6rem;
      cursor: pointer;
      font: inherit;
      font-size: .74rem;
      font-weight: 700;
      transition: background .16s ease, border-color .16s ease, transform .16s ease;
    }
    button:focus-visible { outline: 3px solid rgba(8, 120, 186, .28); outline-offset: 2px; }
    button:active { transform: translateY(1px); }
    button:disabled { cursor: wait; opacity: .55; }
    .primary-action { border: 1px solid #0878ba; background: #0878ba; color: white; }
    .primary-action:hover { background: #076aa5; border-color: #076aa5; }
    .secondary-action { border: 1px solid #d2dbe5; background: white; color: #48596c; }
    .secondary-action:hover { border-color: #afbdcb; background: #f6f8fa; }
    [hidden] { display: none !important; }
    @media (max-width: 520px) {
      main { gap: .45rem; padding: .45rem; }
      .bridge-notice { border-radius: .65rem; }
      iframe { border-radius: .65rem; }
      #confirmation { width: calc(100vw - 1.8rem); padding: 1rem; }
    }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  </style>
</head>
<body>
  <main>
    <header class="bridge-notice">
        <span aria-hidden="true" class="notice-icon">✓</span>
        <div class="notice-copy">
          <strong>安全登录</strong>
          <p id="status" role="status" aria-live="polite">${BRIDGE_AWAITING_STATUS}</p>
      </div>
    </header>
    <iframe id="garmin-auth-frame" title="Garmin 官方登录" src="${frameUrl}"
      sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-storage-access-by-user-activation"
      referrerpolicy="no-referrer"></iframe>
    <section id="confirmation" hidden>
      <p class="confirmation-title">确认 Garmin 账号</p>
      <p class="confirmation-hint">请确认该 Garmin 账号与你配置的邮箱对应，再安全保存到本机</p>
      <p id="identity"></p>
      <button class="primary-action" id="confirm" type="button">确认并保存</button>
      <button class="secondary-action" id="reject" type="button">取消</button>
    </section>
    <section id="result">
      <button class="secondary-action" id="cancel" type="button">取消登录</button>
    </section>
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`
}

function bridgeScript(config: string): string {
  return `
(() => {
  'use strict'
  const config = Object.freeze(${config})
  const csrf = config.csrf
  const ssoOrigin = config.ssoOrigin
  const serviceUrl = config.serviceUrl
  const bridgeOrigin = config.bridgeOrigin
  const frame = document.getElementById('garmin-auth-frame')
  const statusNode = document.getElementById('status')
  const confirmation = document.getElementById('confirmation')
  const identityNode = document.getElementById('identity')
  const confirmButton = document.getElementById('confirm')
  const rejectButton = document.getElementById('reject')
  const cancelButton = document.getElementById('cancel')
  const encoder = new TextEncoder()
  let ticketSubmitted = false
  let pollHandle

  const endpoint = action => location.pathname + '/' + action
  const setStatus = value => { statusNode.textContent = value }
  const stopPolling = () => {
    if (pollHandle !== undefined) clearTimeout(pollHandle)
    pollHandle = undefined
  }
  const failClosed = () => {
    stopPolling()
    frame.hidden = true
    confirmation.hidden = true
    cancelButton.hidden = true
    setStatus('登录未完成，请关闭此窗口后重试。')
  }
  const post = async (action, body) => {
    const response = await fetch(endpoint(action), {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: {
        'Content-Type': 'application/json',
        'X-Garmin-Auth-CSRF': csrf,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error('request rejected')
    return response.json()
  }
  const decodeGarminMessage = payload => {
    let decoded = payload
    for (let layer = 0; layer < 2 && typeof decoded === 'string'; layer += 1) {
      if (encoder.encode(decoded).byteLength > 4096) return undefined
      try { decoded = JSON.parse(decoded) } catch { return undefined }
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined
    const keys = Object.keys(decoded)
    if (
      keys.length !== 4
      || !keys.includes('status')
      || !keys.includes('successDetails')
      || !keys.includes('serviceTicket')
      || !keys.includes('serviceUrl')
    ) return undefined
    if (decoded.status !== 'SUCCESS' || decoded.successDetails !== 'Login Successful') return undefined
    if (typeof decoded.serviceTicket !== 'string' || typeof decoded.serviceUrl !== 'string') return undefined
    if (decoded.serviceUrl !== serviceUrl && decoded.serviceUrl !== bridgeOrigin) return undefined
    if (decoded.serviceTicket.length > 2048 || !/^ST-[A-Za-z0-9._~-]+$/.test(decoded.serviceTicket)) return undefined
    if (encoder.encode(JSON.stringify(decoded)).byteLength > 4096) return undefined
    return { serviceTicket: decoded.serviceTicket, serviceUrl: decoded.serviceUrl }
  }
  const renderIdentity = identity => {
    const values = []
    if (identity && typeof identity.displayName === 'string') values.push(identity.displayName)
    if (identity && typeof identity.userName === 'string') values.push(identity.userName)
    identityNode.textContent = values.join('\\n')
  }
  const poll = async () => {
    try {
      const result = await post('status', {})
      const current = result && result.status
      if (!current || typeof current.state !== 'string') throw new Error('invalid status')
      confirmation.hidden = true
      switch (current.state) {
        case 'awaiting_garmin':
          setStatus(${JSON.stringify(BRIDGE_AWAITING_STATUS)})
          break
        case 'exchanging':
          frame.hidden = true
          setStatus('正在验证 Garmin 登录…')
          break
        case 'waiting_confirmation':
          frame.hidden = true
          confirmation.hidden = false
          renderIdentity(current.identity)
          setStatus('Garmin 登录成功，请确认账号。')
          break
        case 'saving':
          frame.hidden = true
          cancelButton.hidden = true
          setStatus('正在安全保存会话…')
          break
        case 'succeeded':
          stopPolling()
          frame.hidden = true
          cancelButton.hidden = true
          setStatus('Garmin 账号已连接。现在可以关闭此窗口。')
          return
        case 'failed':
        case 'cancelled':
        case 'expired':
          failClosed()
          return
        default:
          throw new Error('invalid status')
      }
      pollHandle = setTimeout(poll, 900)
    } catch {
      failClosed()
    }
  }

  window.addEventListener('message', event => {
    if (event.origin !== ssoOrigin) return
    if (event.source !== frame.contentWindow) return
    if (ticketSubmitted) return
    const message = decodeGarminMessage(event.data)
    if (!message) return
    ticketSubmitted = true
    frame.hidden = true
    setStatus('正在验证 Garmin 登录…')
    void post('ticket', message).then(poll, failClosed)
  })
  confirmButton.addEventListener('click', () => {
    confirmButton.disabled = true
    rejectButton.disabled = true
    confirmation.hidden = true
    cancelButton.hidden = true
    setStatus('正在安全保存会话…')
    void post('confirm', { accepted: true }).then(poll, failClosed)
  })
  rejectButton.addEventListener('click', () => {
    void post('confirm', { accepted: false }).then(poll, failClosed)
  })
  cancelButton.addEventListener('click', () => {
    void post('cancel', {}).then(poll, failClosed)
  })
  void poll()
})()
`
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function rejection(): GarminEmbeddedAuthServerError {
  return new GarminEmbeddedAuthServerError()
}
