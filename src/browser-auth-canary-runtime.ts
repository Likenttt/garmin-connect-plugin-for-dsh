import axios from 'axios'
import { Agent as HttpsAgent } from 'node:https'
import {
  BrowserCanaryControlError,
  isAllowedPortalResponseUrl,
  type BrowserCaptureOptions,
  type BrowserDiAuthCanaryBrowser,
  type BrowserDiAuthCanaryHttp,
  type BrowserDiHttpRequest,
} from './browser-auth-canary'

const DEFAULT_BROWSER_TIMEOUT_MS = 5 * 60_000
const BROWSER_CLEANUP_TIMEOUT_MS = 250
const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024
const MAX_HTTP_TIMEOUT_MS = 30_000

type Environment = Readonly<Record<string, string | undefined>>

interface PlaywrightResponseLike {
  url(): string
  status(): number
  headers(): Record<string, string>
  body(): Promise<Buffer | Uint8Array>
}

interface PlaywrightRequestLike {
  url(): string
  method(): string
  isNavigationRequest(): boolean
  frame(): unknown
}

interface PlaywrightRouteLike {
  request(): PlaywrightRequestLike
  abort(code?: string): Promise<void>
  continue(): Promise<void>
}

interface PlaywrightPageLike {
  route(
    pattern: string,
    handler: (route: PlaywrightRouteLike) => Promise<void>,
  ): Promise<void>
  on(event: string, handler: (...args: any[]) => void): void
  off?(event: string, handler: (...args: any[]) => void): void
  mainFrame(): unknown
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded'; timeout: number },
  ): Promise<unknown>
  close(options?: { runBeforeUnload?: boolean }): Promise<void>
}

interface PlaywrightContextLike {
  newPage(): Promise<PlaywrightPageLike>
  close(): Promise<void>
}

interface PlaywrightBrowserLike {
  newContext(options: {
    acceptDownloads: false
    ignoreHTTPSErrors: false
    permissions: []
  }): Promise<PlaywrightContextLike>
  on(event: string, handler: (...args: any[]) => void): void
  off?(event: string, handler: (...args: any[]) => void): void
  close(): Promise<void>
}

interface PlaywrightModuleLike {
  chromium: {
    launch(options: Record<string, unknown>): Promise<PlaywrightBrowserLike>
  }
}

export interface PlaywrightBrowserAdapterOptions {
  loadPlaywright?: () => unknown
  env?: Environment
  timeoutMs?: number
}

export interface AxiosCanaryHttpAdapterOptions {
  axiosRequest?: (config: Record<string, unknown>) => Promise<{
    status: number
    headers?: Record<string, unknown>
    data: unknown
  }>
  env?: Environment
}

/**
 * Drive a temporary, visible Chrome context without inspecting form fields,
 * request bodies, cookies, page HTML, or browser storage.
 */
export function createPlaywrightBrowserAdapter(
  runtime: PlaywrightBrowserAdapterOptions = {},
): BrowserDiAuthCanaryBrowser {
  const env = runtime.env ?? process.env
  const timeoutMs = runtime.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS

  return {
    async openAndCapture(options: BrowserCaptureOptions): Promise<void> {
      if (unsafeRuntimeDiagnostics(env)) {
        throw new BrowserCanaryControlError('UNSAFE_DEBUG')
      }
      assertSafeBrowserPolicy(options)
      if (
        !Number.isInteger(timeoutMs)
        || timeoutMs < 1
        || !Number.isInteger(options.maxObservedResponseBytes)
        || options.maxObservedResponseBytes < 1
        || options.maxObservedResponseBytes > MAX_HTTP_RESPONSE_BYTES
      ) {
        throw new BrowserCanaryControlError('UNSAFE_HTTP_POLICY')
      }
      if (options.signal?.aborted) {
        throw new BrowserCanaryControlError('CANCELLED')
      }

      const playwright = requirePlaywright(runtime.loadPlaywright)
      let browser: PlaywrightBrowserLike | undefined
      let context: PlaywrightContextLike | undefined
      let page: PlaywrightPageLike | undefined
      let closing = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let captureResolve: (() => void) | undefined
      let controlReject: ((error: Error) => void) | undefined
      let captured = false
      let controlSettled = false

      const capture = new Promise<void>((resolve) => {
        captureResolve = resolve
      })
      const control = new Promise<never>((_resolve, reject) => {
        controlReject = reject
      })
      void control.catch(() => undefined)
      const resolveCapture = (): void => {
        if (captured) return
        captured = true
        captureResolve?.()
      }
      const rejectControl = (error: BrowserCanaryControlError): void => {
        if (controlSettled) return
        controlSettled = true
        controlReject?.(error)
      }
      const cancel = (): void => {
        if (!closing && !captured) {
          rejectControl(new BrowserCanaryControlError('CANCELLED'))
        }
      }
      const onAbort = (): void => cancel()
      const onDisconnected = (): void => cancel()
      const onPageClose = (): void => cancel()
      const withControl = <T>(operation: Promise<T>): Promise<T> => (
        Promise.race([operation, control])
      )

      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => rejectControl(new BrowserCanaryControlError('TIMED_OUT')),
        timeoutMs,
      )

      try {
        try {
          const launch = playwright.chromium.launch({
            channel: 'chrome',
            chromiumSandbox: true,
            env: safeBrowserEnvironment(env),
            handleSIGHUP: false,
            handleSIGINT: false,
            handleSIGTERM: false,
            headless: false,
          })
          void launch.then((lateBrowser) => {
            if (closing && browser !== lateBrowser) void closeQuietly(lateBrowser)
          }).catch(() => undefined)
          browser = await withControl(launch)
          reportStageQuietly(options, 'browser_opened')
        } catch (error) {
          if (error instanceof BrowserCanaryControlError) throw error
          throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
        }

        browser.on('disconnected', onDisconnected)
        const openContext = browser.newContext({
          acceptDownloads: false,
          ignoreHTTPSErrors: false,
          permissions: [],
        })
        void openContext.then((lateContext) => {
          if (closing && context !== lateContext) void closeQuietly(lateContext)
        }).catch(() => undefined)
        context = await withControl(openContext)
        const openPage = context.newPage()
        void openPage.then((latePage) => {
          if (closing && page !== latePage) {
            void closeQuietly(latePage, { runBeforeUnload: false })
          }
        }).catch(() => undefined)
        page = await withControl(openPage)
        page.on('close', onPageClose)

        await withControl(page.route('**/*', async (route) => {
          if (shouldBlockTicketRedirect(route.request(), page!, options)) {
            await route.abort('blockedbyclient')
            return
          }
          await route.continue()
        }))

        page.on('response', (response: PlaywrightResponseLike) => {
          void handleObservedResponse(response, options)
            .then((complete) => {
              if (complete) resolveCapture()
            })
            .catch(() => {
              // A malformed/oversized response is ignored. The user may retry
              // within this same isolated page until the overall timeout.
            })
        })

        await withControl(page.goto(options.portalUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(timeoutMs, 30_000),
        }))
        reportStageQuietly(options, 'portal_loaded')
        await Promise.race([capture, control])
      } finally {
        closing = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        page?.off?.('close', onPageClose)
        browser?.off?.('disconnected', onDisconnected)
        await closeBrowserResourcesQuietly(page, context, browser)
        captureResolve = undefined
        controlReject = undefined
      }
    },
  }
}

function reportStageQuietly(
  options: BrowserCaptureOptions,
  stage: 'browser_opened' | 'portal_loaded',
): void {
  try {
    options.onStage?.(stage)
  } catch {
    // A progress sink is observational and must not control authentication.
  }
}

/** Enforce the one-shot DI request policy at the real Axios boundary. */
export function createAxiosCanaryHttpAdapter(
  runtime: AxiosCanaryHttpAdapterOptions = {},
): BrowserDiAuthCanaryHttp {
  const env = runtime.env ?? process.env
  const axiosRequest = runtime.axiosRequest
    ?? ((config: Record<string, unknown>) => axios.request(config as any))

  return {
    async request(request: BrowserDiHttpRequest) {
      if (unsafeRuntimeDiagnostics(env)) {
        throw new BrowserCanaryControlError('UNSAFE_DEBUG')
      }
      assertSafeHttpRequest(request)
      if (request.signal?.aborted) {
        throw new BrowserCanaryControlError('CANCELLED')
      }

      const agent = new HttpsAgent({ keepAlive: false })
      try {
        const response = await axiosRequest({
          data: request.body,
          decompress: true,
          headers: request.headers,
          httpsAgent: agent,
          maxBodyLength: 64 * 1024,
          maxContentLength: request.maxResponseBytes,
          maxRedirects: 0,
          method: request.method,
          proxy: false,
          responseType: 'json',
          signal: request.signal,
          timeout: request.timeoutMs,
          transitional: { silentJSONParsing: false },
          url: request.url,
          validateStatus: () => true,
        })
        return {
          status: response.status,
          contentType: responseContentType(response.headers),
          body: response.data,
        }
      } catch {
        if (request.signal?.aborted) {
          throw new BrowserCanaryControlError('CANCELLED')
        }
        throw new Error('Garmin canary HTTP request failed')
      } finally {
        agent.destroy()
      }
    },
  }
}

function requirePlaywright(loader?: () => unknown): PlaywrightModuleLike {
  let value: unknown
  if (loader) {
    try {
      value = loader()
    } catch {
      throw new BrowserCanaryControlError('DRIVER_UNAVAILABLE')
    }
  } else {
    try {
      value = require('playwright-core')
    } catch {
      try {
        value = require('playwright')
      } catch {
        throw new BrowserCanaryControlError('DRIVER_UNAVAILABLE')
      }
    }
  }

  if (
    !isRecord(value)
    || !isRecord(value.chromium)
    || typeof value.chromium.launch !== 'function'
  ) {
    throw new BrowserCanaryControlError('DRIVER_UNAVAILABLE')
  }
  return value as unknown as PlaywrightModuleLike
}

async function handleObservedResponse(
  response: PlaywrightResponseLike,
  options: BrowserCaptureOptions,
): Promise<boolean> {
  const url = response.url()
  if (!isAllowedPortalResponseUrl(
    url,
    options.allowedResponseUrls,
    options.serviceUrl,
  )) return false
  const headers = response.headers()
  const declaredLength = parseContentLength(headers['content-length'])
  if (
    declaredLength !== undefined
    && declaredLength > options.maxObservedResponseBytes
  ) {
    return false
  }
  const bytes = Buffer.from(await response.body())
  if (bytes.byteLength > options.maxObservedResponseBytes) return false
  let parsed = false
  let value: unknown
  return options.onResponse({
    url,
    status: response.status(),
    contentType: headers['content-type'],
    json: async () => {
      if (!parsed) {
        value = JSON.parse(bytes.toString('utf8')) as unknown
        parsed = true
      }
      return value
    },
  })
}

function shouldBlockTicketRedirect(
  request: PlaywrightRequestLike,
  page: PlaywrightPageLike,
  options: BrowserCaptureOptions,
): boolean {
  if (
    request.method() !== 'GET'
    || !request.isNavigationRequest()
    || request.frame() !== page.mainFrame()
  ) return false

  try {
    const url = new URL(request.url())
    const expected = options.blockedTicketRedirect
    return url.protocol === 'https:'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.origin === expected.origin
      && url.pathname === expected.pathname
      && url.searchParams.getAll(expected.searchParameter).length === 1
  } catch {
    return false
  }
}

function assertSafeBrowserPolicy(options: BrowserCaptureOptions): void {
  try {
    const portal = new URL(options.portalUrl)
    const service = new URL(options.serviceUrl)
    const expectedSsoHost = service.hostname === 'connect.garmin.cn'
      ? 'sso.garmin.cn'
      : service.hostname === 'connect.garmin.com'
        ? 'sso.garmin.com'
        : ''
    const expectedResponses = [
      `https://${expectedSsoHost}/portal/api/login`,
      `https://${expectedSsoHost}/portal/api/mfa/verifyCode`,
    ]
    const portalKeys = [...new Set(portal.searchParams.keys())].sort()
    const valid = Boolean(expectedSsoHost)
      && portal.protocol === 'https:'
      && portal.port === ''
      && portal.username === ''
      && portal.password === ''
      && portal.hostname === expectedSsoHost
      && portal.pathname === '/portal/sso/en-US/sign-in'
      && portalKeys.join(',') === 'clientId,service'
      && portal.searchParams.getAll('clientId').length === 1
      && portal.searchParams.get('clientId') === 'GarminConnect'
      && portal.searchParams.getAll('service').length === 1
      && portal.searchParams.get('service') === options.serviceUrl
      && service.protocol === 'https:'
      && service.port === ''
      && service.username === ''
      && service.password === ''
      && service.pathname === '/app'
      && service.search === ''
      && options.allowedResponseUrls.length === 2
      && expectedResponses.every((url, index) => options.allowedResponseUrls[index] === url)
      && options.blockedTicketRedirect.origin === service.origin
      && options.blockedTicketRedirect.pathname === '/app'
      && options.blockedTicketRedirect.searchParameter === 'ticket'
    if (!valid) throw new Error('invalid browser policy')
  } catch {
    throw new BrowserCanaryControlError('UNSAFE_BROWSER_POLICY')
  }
}

function assertSafeHttpRequest(request: BrowserDiHttpRequest): void {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    throw new BrowserCanaryControlError('UNSAFE_HTTP_POLICY')
  }
  const tokenRequest = request.method === 'POST'
    && (url.hostname === 'diauth.garmin.com' || url.hostname === 'diauth.garmin.cn')
    && url.pathname === '/di-oauth2-service/oauth/token'
  const profileRequest = request.method === 'GET'
    && (
      url.hostname === 'connectapi.garmin.com'
      || url.hostname === 'connectapi.garmin.cn'
    )
    && url.pathname === '/userprofile-service/socialProfile'

  if (
    url.protocol !== 'https:'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || (!tokenRequest && !profileRequest)
    || request.followRedirects !== false
    || request.retry !== false
    || request.useProxy !== false
    || !Number.isInteger(request.timeoutMs)
    || request.timeoutMs < 1
    || request.timeoutMs > MAX_HTTP_TIMEOUT_MS
    || !Number.isInteger(request.maxResponseBytes)
    || request.maxResponseBytes < 1
    || request.maxResponseBytes > MAX_HTTP_RESPONSE_BYTES
  ) {
    throw new BrowserCanaryControlError('UNSAFE_HTTP_POLICY')
  }
}

function responseContentType(headers: Record<string, unknown> | undefined): string | undefined {
  if (!headers) return undefined
  const value = headers['content-type']
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function unsafeRuntimeDiagnostics(env: Environment): boolean {
  if (
    env.PWDEBUG?.trim()
    || env.DEBUG?.trim()
    || env.NODE_DEBUG?.trim()
    || env.NODE_OPTIONS?.trim()
    || env.SSLKEYLOGFILE?.trim()
    || env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0'
  ) return true
  // Do not reimplement multiple debug/Node flag parsers around a
  // credential-bearing flow; any matching diagnostic environment fails closed.
  return false
}

function safeBrowserEnvironment(env: Environment): Record<string, string> {
  const allowed = [
    'DBUS_SESSION_BUS_ADDRESS',
    'DISPLAY',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'TEMP',
    'TMP',
    'TMPDIR',
    'TZ',
    'USER',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'XDG_RUNTIME_DIR',
  ]
  const result: Record<string, string> = {}
  for (const key of allowed) {
    const value = env[key]
    if (value) result[key] = value
  }
  return result
}

async function closeQuietly(
  value: { close(options?: any): Promise<void> } | undefined,
  options?: unknown,
): Promise<void> {
  if (!value) return
  try {
    await value.close(options)
  } catch {
    // Cleanup errors must never replace the fixed canary result/error.
  }
}

async function closeBrowserResourcesQuietly(
  page: PlaywrightPageLike | undefined,
  context: PlaywrightContextLike | undefined,
  browser: PlaywrightBrowserLike | undefined,
): Promise<void> {
  const cleanup = Promise.all([
    closeQuietly(page, { runBeforeUnload: false }),
    closeQuietly(context),
    closeQuietly(browser),
  ]).then(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BROWSER_CLEANUP_TIMEOUT_MS)
  })

  try {
    await Promise.race([cleanup, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
