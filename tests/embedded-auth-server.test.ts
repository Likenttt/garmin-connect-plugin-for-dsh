import http from 'node:http'
import { Script } from 'node:vm'
import { EmbeddedAuthFlowManager } from '../src/embedded-auth-flow'
import {
  EmbeddedAuthServer,
  GARMIN_EMBEDDED_AUTH_SERVER_REJECTED,
  type EmbeddedAuthServerAdapter,
} from '../src/embedded-auth-server'

const FLOW_ID = 'ab'.repeat(32)
const CSRF = 'c'.repeat(43)
const SSO_ORIGIN = 'https://sso.garmin.cn'
const SERVICE_URL = `${SSO_ORIGIN}/sso/embed`
const FRAME_URL = frameUrlFor('http://127.0.0.1:9999')

function frameUrlFor(bridgeOrigin: string): string {
  return `${SSO_ORIGIN}/sso/signin?id=gauth-widget&embedWidget=true&gauthHost=${encodeURIComponent(`${SSO_ORIGIN}/sso`)}&service=${encodeURIComponent(SERVICE_URL)}&source=${encodeURIComponent(bridgeOrigin)}&consumeServiceTicket=false`
}

interface RequestResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

interface BridgeMessageEvent {
  data: unknown
  origin: string
  source: object
}

interface BridgeScriptHarness {
  dispatchMessage(
    data: unknown,
    options?: { origin?: string; sourceMatches?: boolean },
  ): void
  flushRequests(): Promise<void>
  frameHidden(): boolean
  cancelHidden(): boolean
  statusRequestCount(): number
  statusText(): string
  ticketRequestCount(): number
}

type TestAdapter = jest.Mocked<EmbeddedAuthServerAdapter> & {
  setBridgeOrigin(origin: string): void
}

function createAdapter(): TestAdapter {
  let bridgeOrigin = 'http://127.0.0.1:9999'
  return {
    bridgeBootstrap: jest.fn((_flowId: string) => ({
      csrf: CSRF,
      frameUrl: frameUrlFor(bridgeOrigin),
      ssoOrigin: SSO_ORIGIN,
      serviceUrl: SERVICE_URL,
    })),
    bridgeStatus: jest.fn((_flowId: string, _csrf: string) => ({
      state: 'awaiting_garmin' as const,
    })),
    submitTicket: jest.fn(),
    confirm: jest.fn(),
    cancel: jest.fn(),
    setBridgeOrigin(origin: string) {
      bridgeOrigin = origin
    },
  }
}

function request(
  url: string,
  options: {
    method?: string
    headers?: http.OutgoingHttpHeaders
    body?: string
  } = {},
): Promise<RequestResult> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function bridgeHeaders(origin: string): http.OutgoingHttpHeaders {
  return {
    Origin: origin,
    'Content-Type': 'application/json',
    'X-Garmin-Auth-CSRF': CSRF,
  }
}

function extractInlineScript(html: string): string {
  const matches = Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi),
  )
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error('expected exactly one bridge script')
  }
  return matches[0][1]
}

function runBridgeScript(
  html: string,
  bridgeUrl: string,
  bridgeOrigin: string,
): BridgeScriptHarness {
  const frameWindow = {}
  const messageListeners: Array<(event: BridgeMessageEvent) => void> = []
  const pendingRequests: Array<Promise<unknown>> = []
  const requestedPaths: string[] = []
  const inertListener = (): void => {}
  const element = (contentWindow?: object) => ({
    addEventListener: inertListener,
    contentWindow,
    disabled: false,
    hidden: false,
    textContent: '',
  })
  const elements = new Map<string, ReturnType<typeof element>>([
    ['garmin-auth-frame', element(frameWindow)],
    ['status', element()],
    ['confirmation', element()],
    ['identity', element()],
    ['confirm', element()],
    ['reject', element()],
    ['cancel', element()],
  ])

  const bridgeFetch = (
    path: string,
    options: {
      body?: string
      headers?: http.OutgoingHttpHeaders
      method?: string
    },
  ): Promise<{ ok: boolean; json(): Promise<unknown> }> => {
    const target = new URL(path, bridgeUrl)
    requestedPaths.push(target.pathname)
    const operation = request(target.toString(), {
      method: options.method,
      headers: { ...options.headers, Origin: bridgeOrigin },
      body: options.body,
    }).then(response => ({
      ok: response.status >= 200 && response.status < 300,
      json: async () => JSON.parse(response.body) as unknown,
    }))
    pendingRequests.push(operation)
    return operation
  }

  new Script(extractInlineScript(html)).runInNewContext({
    clearTimeout: () => {},
    document: {
      getElementById: (id: string) => elements.get(id),
    },
    fetch: bridgeFetch,
    location: { pathname: new URL(bridgeUrl).pathname },
    setTimeout: () => 1,
    TextEncoder,
    window: {
      addEventListener: (
        type: string,
        listener: (event: BridgeMessageEvent) => void,
      ) => {
        if (type === 'message') messageListeners.push(listener)
      },
    },
  })

  if (messageListeners.length !== 1) {
    throw new Error('expected exactly one Garmin message listener')
  }
  return {
    dispatchMessage(data, options = {}) {
      messageListeners[0]({
        data,
        origin: options.origin ?? SSO_ORIGIN,
        source: options.sourceMatches === false ? {} : frameWindow,
      })
    },
    async flushRequests() {
      let index = 0
      for (;;) {
        while (index < pendingRequests.length) {
          await pendingRequests[index]
          index += 1
        }
        await new Promise<void>(resolve => setImmediate(resolve))
        if (index === pendingRequests.length) return
      }
    },
    frameHidden: () => elements.get('garmin-auth-frame')?.hidden === true,
    cancelHidden: () => elements.get('cancel')?.hidden === true,
    statusRequestCount: () => requestedPaths.filter(
      path => path.endsWith('/status'),
    ).length,
    statusText: () => elements.get('status')?.textContent ?? '',
    ticketRequestCount: () => requestedPaths.filter(
      path => path.endsWith('/ticket'),
    ).length,
  }
}

describe('EmbeddedAuthServer', () => {
  const servers: EmbeddedAuthServer[] = []

  const openBridge = async (adapter = createAdapter()) => {
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)
    const bridgeUrl = server.bridgeUrl(FLOW_ID)
    const response = await request(bridgeUrl)
    return { adapter, bridgeUrl, origin, response }
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()))
  })

  it('binds an ephemeral IPv4 loopback origin and builds opaque bridge URLs', async () => {
    const server = new EmbeddedAuthServer(createAdapter())
    servers.push(server)

    const origin = await server.start()

    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await server.start()).toBe(origin)
    expect(server.bridgeUrl(FLOW_ID)).toBe(
      `${origin}/garmin-auth/bridge/${FLOW_ID}`,
    )
    expect(() => server.bridgeUrl('not-a-256-bit-hex-id'))
      .toThrow(GARMIN_EMBEDDED_AUTH_SERVER_REJECTED)
  })

  it('accepts a class-based flow-manager adapter', async () => {
    class Adapter implements EmbeddedAuthServerAdapter {
      bridgeBootstrap(_flowId: string) {
        return {
          csrf: CSRF,
          frameUrl: FRAME_URL,
          ssoOrigin: SSO_ORIGIN,
          serviceUrl: SERVICE_URL,
        }
      }

      bridgeStatus(_flowId: string, _csrf: string) {
        return { state: 'awaiting_garmin' as const }
      }

      submitTicket(
        _flowId: string,
        _csrf: string,
        _ticket: { serviceTicket: string; serviceUrl: string },
      ) {}
      confirm(_flowId: string, _csrf: string, _accepted: boolean) {}
      cancel(_flowId: string, _csrf: string) {}
    }

    const server = new EmbeddedAuthServer(new Adapter())
    servers.push(server)

    await expect(server.start()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:/)
  })

  it('integrates directly with the real flow manager contract', async () => {
    const manager = new EmbeddedAuthFlowManager({ authenticate: jest.fn() })
    const server = new EmbeddedAuthServer(manager)
    servers.push(server)
    const origin = await server.start()
    const started = manager.start({
      region: 'cn',
      username: 'runner@example.com',
      sessionTokenFile: '/private/account/session.json',
      bridgeOrigin: origin,
    })

    expect(started.flowId).toMatch(/^[a-f0-9]{64}$/)
    const response = await request(server.bridgeUrl(started.flowId))

    expect(response.status).toBe(200)
    expect(response.body).toContain('https://sso.garmin.cn/sso/signin')
  })

  it('serves a no-store bridge that embeds only Garmin GAuth and never forwards secrets', async () => {
    const adapter = createAdapter()
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)

    const response = await request(server.bridgeUrl(FLOW_ID))

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store, max-age=0')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.headers['content-security-policy']).toContain(`frame-src ${SSO_ORIGIN}`)
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'")
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).toContain('id="garmin-auth-frame"')
    expect(response.body).toContain('https://sso.garmin.cn/sso/signin')
    expect(response.body).toContain('请完成登录或验证。')
    expect(response.body).not.toContain('仅在 Garmin 官方页面输入账号、密码和验证码')
    expect(response.body).not.toContain('请在 Garmin 官方页面中完成登录和验证码验证。')
    expect(response.body).toContain('请确认该 Garmin 账号与你配置的邮箱对应')
    expect(response.body).toContain('class="bridge-notice"')
    expect(response.body).toContain('class="primary-action"')
    expect(response.body).not.toContain('<h1>Garmin Connect 登录</h1>')
    expect(response.body).toContain("event.origin !== ssoOrigin")
    expect(response.body).toContain("event.source !== frame.contentWindow")
    expect(response.body).toContain('textContent')
    expect(response.body).not.toContain('allow-top-navigation-by-user-activation')
    expect(response.body).not.toMatch(/parent\.postMessage|localStorage|sessionStorage|document\.cookie/)
    expect(response.body).not.toContain('ST-ticket-secret')
    expect(adapter.bridgeBootstrap).toHaveBeenCalledWith(FLOW_ID)
  })

  it('allows the exact Harness app origin and loopback parents to frame the bridge', async () => {
    const { response } = await openBridge()
    const contentSecurityPolicy = response.headers['content-security-policy']

    if (typeof contentSecurityPolicy !== 'string') {
      throw new Error('expected a single Content-Security-Policy header')
    }
    expect(contentSecurityPolicy.split('; ').find(
      directive => directive.startsWith('frame-ancestors '),
    )).toBe(
      'frame-ancestors dsh-app://app http://127.0.0.1:* http://localhost:*',
    )
  })

  it('serves a bridge whose inline script is valid JavaScript', async () => {
    const { response } = await openBridge()
    const inlineScript = extractInlineScript(response.body)

    expect(response.status).toBe(200)
    expect(() => new Script(inlineScript)).not.toThrow()
  })

  it('hides cancellation after the session save reaches its commit point', async () => {
    const adapter = createAdapter()
    adapter.bridgeStatus.mockReturnValue({ state: 'saving' })
    const { bridgeUrl, origin, response } = await openBridge(adapter)
    const harness = runBridgeScript(response.body, bridgeUrl, origin)

    await harness.flushRequests()

    expect(harness.cancelHidden()).toBe(true)
    expect(harness.statusText()).toBe('正在安全保存会话…')
  })

  it('routes Garmin GAuth SUCCESS messages through the local ticket endpoint', async () => {
    const adapter = createAdapter()
    adapter.submitTicket.mockImplementation(() => {
      adapter.bridgeStatus.mockReturnValue({ state: 'exchanging' })
    })
    const { bridgeUrl, origin, response } = await openBridge(adapter)
    const harness = runBridgeScript(response.body, bridgeUrl, origin)
    const message = JSON.stringify({
      status: 'SUCCESS',
      successDetails: 'Login Successful',
      serviceTicket: 'ST-real_gauth_ticket~1',
      serviceUrl: SERVICE_URL,
    })

    harness.dispatchMessage(message)
    harness.dispatchMessage(message)
    await harness.flushRequests()

    expect(adapter.submitTicket).toHaveBeenCalledTimes(1)
    expect(adapter.submitTicket).toHaveBeenCalledWith(
      FLOW_ID,
      CSRF,
      {
        serviceTicket: 'ST-real_gauth_ticket~1',
        serviceUrl: SERVICE_URL,
      },
    )
    expect(harness.ticketRequestCount()).toBe(1)
    expect(harness.statusRequestCount()).toBeGreaterThanOrEqual(2)
    expect(harness.frameHidden()).toBe(true)
    expect(harness.statusText()).toBe('正在验证 Garmin 登录…')
  })

  it('routes Garmin SUCCESS with this exact loopback bridge origin', async () => {
    const adapter = createAdapter()
    adapter.submitTicket.mockImplementation(() => {
      adapter.bridgeStatus.mockReturnValue({ state: 'exchanging' })
    })
    const { bridgeUrl, origin, response } = await openBridge(adapter)
    const harness = runBridgeScript(response.body, bridgeUrl, origin)

    harness.dispatchMessage(JSON.stringify({
      status: 'SUCCESS',
      successDetails: 'Login Successful',
      serviceTicket: 'ST-loopback_service',
      serviceUrl: origin,
    }))
    await harness.flushRequests()

    expect(adapter.submitTicket).toHaveBeenCalledWith(
      FLOW_ID,
      CSRF,
      {
        serviceTicket: 'ST-loopback_service',
        serviceUrl: origin,
      },
    )
    expect(harness.ticketRequestCount()).toBe(1)
  })

  it('rejects untrusted or malformed Garmin GAuth messages before /ticket', async () => {
    const { adapter, bridgeUrl, origin, response } = await openBridge()
    const harness = runBridgeScript(response.body, bridgeUrl, origin)
    const success = {
      status: 'SUCCESS',
      successDetails: 'Login Successful',
      serviceTicket: 'ST-must_not_be_submitted',
      serviceUrl: SERVICE_URL,
    }

    harness.dispatchMessage(JSON.stringify(success), {
      origin: 'https://sso.garmin.com',
    })
    harness.dispatchMessage(JSON.stringify(success), { sourceMatches: false })
    harness.dispatchMessage(JSON.stringify({ ...success, status: 'FAILURE' }))
    harness.dispatchMessage(JSON.stringify({
      ...success,
      successDetails: 'Unexpected success detail',
    }))
    harness.dispatchMessage(JSON.stringify({ ...success, extra: true }))
    harness.dispatchMessage(JSON.stringify({
      ...success,
      serviceUrl: 'https://sso.garmin.com/sso/embed',
    }))
    harness.dispatchMessage(JSON.stringify({
      ...success,
      serviceUrl: `${origin}/garmin-auth/bridge`,
    }))
    harness.dispatchMessage(JSON.stringify({
      ...success,
      serviceUrl: `${origin}?ticket=secret`,
    }))
    harness.dispatchMessage(JSON.stringify({
      ...success,
      serviceUrl: `${origin}#secret`,
    }))
    harness.dispatchMessage(JSON.stringify({
      ...success,
      serviceUrl: origin.replace('http://', 'http://user:pass@'),
    }))
    harness.dispatchMessage(JSON.stringify({
      ...success,
      serviceTicket: 'not-a-service-ticket',
    }))
    harness.dispatchMessage(JSON.stringify({
      serviceTicket: success.serviceTicket,
      serviceUrl: success.serviceUrl,
    }))
    await harness.flushRequests()

    expect(adapter.submitTicket).not.toHaveBeenCalled()
    expect(harness.ticketRequestCount()).toBe(0)
  })

  it.each([
    ['a mismatched source', (url: URL) => {
      url.searchParams.set('source', 'http://127.0.0.1:1')
    }],
    ['an extra parameter', (url: URL) => {
      url.searchParams.set('unexpected', 'value')
    }],
    ['a duplicate parameter', (url: URL) => {
      url.searchParams.append('service', SERVICE_URL)
    }],
  ])('rejects a GAuth frame URL with %s', async (_label, mutate) => {
    const adapter = createAdapter()
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    const invalidFrameUrl = new URL(frameUrlFor(origin))
    mutate(invalidFrameUrl)
    adapter.bridgeBootstrap.mockReturnValue({
      csrf: CSRF,
      frameUrl: invalidFrameUrl.toString(),
      ssoOrigin: SSO_ORIGIN,
      serviceUrl: SERVICE_URL,
    })

    const response = await request(server.bridgeUrl(FLOW_ID))

    expect(response.status).toBe(400)
    expect(response.body).toBe('{"ok":false,"error":"request_rejected"}')
    expect(response.body).not.toContain('unexpected')
  })

  it('routes a validated one-shot ticket, safe status, confirmation, and cancellation', async () => {
    const adapter = createAdapter()
    adapter.bridgeStatus.mockReturnValue({
      state: 'waiting_confirmation',
      identity: { displayName: 'Runner <One>', userName: 'runner@example.com' },
    })
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)
    const bridgeUrl = server.bridgeUrl(FLOW_ID)
    const headers = bridgeHeaders(origin)

    const ticket = await request(`${bridgeUrl}/ticket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serviceTicket: 'ST-valid_ticket~1',
        serviceUrl: SERVICE_URL,
      }),
    })
    const status = await request(`${bridgeUrl}/status`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    const confirm = await request(`${bridgeUrl}/confirm`, {
      method: 'POST',
      headers,
      body: '{"accepted":true}',
    })
    const cancel = await request(`${bridgeUrl}/cancel`, {
      method: 'POST',
      headers,
      body: '{}',
    })

    expect(ticket.status).toBe(202)
    expect(JSON.parse(ticket.body)).toEqual({ ok: true })
    expect(adapter.submitTicket).toHaveBeenCalledWith(
      FLOW_ID,
      CSRF,
      {
        serviceTicket: 'ST-valid_ticket~1',
        serviceUrl: SERVICE_URL,
      },
    )
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({
      ok: true,
      status: {
        state: 'waiting_confirmation',
        identity: {
          displayName: 'Runner <One>',
          userName: 'runner@example.com',
        },
      },
    })
    expect(adapter.bridgeStatus).toHaveBeenCalledWith(FLOW_ID, CSRF)
    expect(confirm.status).toBe(200)
    expect(adapter.confirm).toHaveBeenCalledWith(FLOW_ID, CSRF, true)
    expect(cancel.status).toBe(200)
    expect(adapter.cancel).toHaveBeenCalledWith(FLOW_ID, CSRF)
  })

  it.each([
    ['wrong origin', (origin: string) => ({
      urlSuffix: '/status',
      headers: { ...bridgeHeaders(origin), Origin: 'http://127.0.0.1:1' },
      body: '{}',
    })],
    ['missing csrf', (origin: string) => ({
      urlSuffix: '/status',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    })],
    ['wrong content type', (origin: string) => ({
      urlSuffix: '/status',
      headers: { ...bridgeHeaders(origin), 'Content-Type': 'text/plain' },
      body: '{}',
    })],
    ['oversized body', (origin: string) => ({
      urlSuffix: '/status',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({ padding: 'x'.repeat(4_200) }),
    })],
    ['invalid ticket service', (origin: string) => ({
      urlSuffix: '/ticket',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-do-not-echo-me',
        serviceUrl: 'https://evil.example/sso/embed',
      }),
    })],
    ['path on bridge service origin', (origin: string) => ({
      urlSuffix: '/ticket',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-do-not-echo-me',
        serviceUrl: `${origin}/garmin-auth/bridge`,
      }),
    })],
    ['query on bridge service origin', (origin: string) => ({
      urlSuffix: '/ticket',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-do-not-echo-me',
        serviceUrl: `${origin}?ticket=secret`,
      }),
    })],
    ['fragment on bridge service origin', (origin: string) => ({
      urlSuffix: '/ticket',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-do-not-echo-me',
        serviceUrl: `${origin}#secret`,
      }),
    })],
    ['credentials on bridge service origin', (origin: string) => ({
      urlSuffix: '/ticket',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-do-not-echo-me',
        serviceUrl: origin.replace('http://', 'http://user:pass@'),
      }),
    })],
    ['extra ticket property', (origin: string) => ({
      urlSuffix: '/ticket',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-do-not-echo-me',
        serviceUrl: SERVICE_URL,
        extra: true,
      }),
    })],
  ])('rejects %s with one fixed response', async (_label, buildRequest) => {
    const adapter = createAdapter()
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)
    const attempt = buildRequest(origin)

    const response = await request(
      `${server.bridgeUrl(FLOW_ID)}${attempt.urlSuffix}`,
      {
        method: 'POST',
        headers: attempt.headers,
        body: attempt.body,
      },
    )

    expect([400, 403, 413, 415]).toContain(response.status)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store, max-age=0')
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.body).toBe('{"ok":false,"error":"request_rejected"}')
    expect(response.body).not.toMatch(/evil|echo|ticket/i)
    expect(adapter.bridgeStatus).not.toHaveBeenCalled()
    expect(adapter.submitTicket).not.toHaveBeenCalled()
  })

  it('collapses manager replay failures without echoing adapter details', async () => {
    const adapter = createAdapter()
    adapter.submitTicket.mockImplementation(() => {
      throw new Error('replayed ST-do-not-echo account@example.com')
    })
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    adapter.setBridgeOrigin(origin)

    const response = await request(`${server.bridgeUrl(FLOW_ID)}/ticket`, {
      method: 'POST',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-valid',
        serviceUrl: SERVICE_URL,
      }),
    })

    expect(response.status).toBe(400)
    expect(response.body).toBe('{"ok":false,"error":"request_rejected"}')
    expect(response.body).not.toMatch(/replay|echo|example|ST-/i)
    expect(adapter.submitTicket).toHaveBeenCalledTimes(1)
  })

  it('rejects forged Host, traversal, queries, and unsupported methods without adapter access', async () => {
    const adapter = createAdapter()
    const server = new EmbeddedAuthServer(adapter)
    servers.push(server)
    const origin = await server.start()
    const bridgeUrl = server.bridgeUrl(FLOW_ID)

    const forgedHost = await request(`${bridgeUrl}/status`, {
      method: 'POST',
      headers: {
        ...bridgeHeaders(origin),
        Host: 'localhost:9999',
      },
      body: '{}',
    })
    const traversal = await request(
      `${origin}/garmin-auth/bridge/${FLOW_ID}/%2e%2e/status`,
    )
    const query = await request(`${bridgeUrl}?ticket=ST-secret`)
    const method = await request(`${bridgeUrl}/ticket`, {
      method: 'PUT',
      headers: bridgeHeaders(origin),
      body: JSON.stringify({
        serviceTicket: 'ST-secret',
        serviceUrl: SERVICE_URL,
      }),
    })

    expect(forgedHost.status).toBe(403)
    expect(traversal.status).toBe(404)
    expect(query.status).toBe(404)
    expect(method.status).toBe(405)
    for (const response of [forgedHost, traversal, query, method]) {
      expect(response.body).toBe('{"ok":false,"error":"request_rejected"}')
      expect(response.body).not.toContain('ST-secret')
    }
    expect(adapter.bridgeBootstrap).not.toHaveBeenCalled()
    expect(adapter.submitTicket).not.toHaveBeenCalled()
  })

  it('stops accepting URLs after close', async () => {
    const server = new EmbeddedAuthServer(createAdapter())
    const origin = await server.start()
    expect(origin).toContain('127.0.0.1')

    await server.close()

    expect(() => server.bridgeUrl(FLOW_ID))
      .toThrow(GARMIN_EMBEDDED_AUTH_SERVER_REJECTED)
  })
})
