import {
  BrowserCanaryControlError,
  type BrowserCaptureOptions,
  type BrowserDiHttpRequest,
} from '../src/browser-auth-canary'
import {
  createAxiosCanaryHttpAdapter,
  createPlaywrightBrowserAdapter,
} from '../src/browser-auth-canary-runtime'

function browserFixture() {
  const handlers = new Map<string, (...args: any[]) => any>()
  let routeHandler: ((route: any) => Promise<void>) | undefined
  const mainFrame = {}
  const responseBody = Buffer.from(JSON.stringify({
    responseStatus: { type: 'SUCCESSFUL' },
    serviceTicketId: 'ST-runtime-ticket',
  }))
  const response = {
    url: () => 'https://sso.garmin.cn/portal/api/login',
    status: () => 200,
    headers: () => ({
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(responseBody.length),
    }),
    body: jest.fn().mockResolvedValue(responseBody),
  }
  const page = {
    route: jest.fn(async (_pattern: string, handler: (route: any) => Promise<void>) => {
      routeHandler = handler
    }),
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler)
    }),
    off: jest.fn(),
    mainFrame: jest.fn(() => mainFrame),
    goto: jest.fn(async () => {
      await handlers.get('response')?.(response)
    }),
    close: jest.fn().mockResolvedValue(undefined),
  }
  const context = {
    newPage: jest.fn().mockResolvedValue(page),
    close: jest.fn().mockResolvedValue(undefined),
  }
  const browser = {
    newContext: jest.fn().mockResolvedValue(context),
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(`browser:${event}`, handler)
    }),
    off: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  }
  const launch = jest.fn().mockResolvedValue(browser)
  const loadPlaywright = jest.fn(() => ({ chromium: { launch } }))

  return {
    browser,
    context,
    handlers,
    launch,
    loadPlaywright,
    mainFrame,
    page,
    response,
    getRouteHandler: () => routeHandler,
  }
}

function captureOptions(
  onResponse: BrowserCaptureOptions['onResponse'] = async response => {
    await response.json()
    return true
  },
): BrowserCaptureOptions {
  return {
    portalUrl: 'https://sso.garmin.cn/portal/sso/en-US/sign-in' +
      '?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.cn%2Fapp',
    serviceUrl: 'https://connect.garmin.cn/app',
    allowedResponseUrls: [
      'https://sso.garmin.cn/portal/api/login',
      'https://sso.garmin.cn/portal/api/mfa/verifyCode',
    ],
    blockedTicketRedirect: {
      origin: 'https://connect.garmin.cn',
      pathname: '/app',
      searchParameter: 'ticket',
    },
    maxObservedResponseBytes: 64 * 1024,
    onResponse,
  }
}

describe('browser DI canary runtime adapters', () => {
  it('reports only the fixed browser lifecycle stages', async () => {
    const fixture = browserFixture()
    const onStage = jest.fn()
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1_000,
    })

    await adapter.openAndCapture({ ...captureOptions(), onStage })

    expect(onStage.mock.calls).toEqual([
      ['browser_opened'],
      ['portal_loaded'],
    ])
  })

  it('uses an isolated visible system Chrome context and closes every resource', async () => {
    const fixture = browserFixture()
    const onResponse = jest.fn(captureOptions().onResponse)
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: { HOME: '/private/home', GARMIN_PASSWORD: 'MUST_NOT_REACH_CHROME' },
      timeoutMs: 1_000,
    })

    await adapter.openAndCapture(captureOptions(onResponse))

    expect(fixture.launch).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'chrome',
      chromiumSandbox: true,
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      env: expect.not.objectContaining({ GARMIN_PASSWORD: expect.anything() }),
    }))
    expect(fixture.browser.newContext).toHaveBeenCalledWith({
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      permissions: [],
    })
    expect(fixture.page.route.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.page.goto.mock.invocationCallOrder[0])
    expect(fixture.page.goto).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/sso\.garmin\.cn\/portal\/sso\//),
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(fixture.page.close).toHaveBeenCalledTimes(1)
    expect(fixture.context.close).toHaveBeenCalledTimes(1)
    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
  })

  it('blocks only the exact main-frame ticket redirect before it goes out', async () => {
    const fixture = browserFixture()
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1_000,
    })
    await adapter.openAndCapture(captureOptions())
    const handler = fixture.getRouteHandler()
    expect(handler).toBeDefined()

    const abort = jest.fn().mockResolvedValue(undefined)
    const continueRequest = jest.fn().mockResolvedValue(undefined)
    await handler?.({
      request: () => ({
        url: () => 'https://connect.garmin.cn/app?ticket=ST-block-me',
        method: () => 'GET',
        isNavigationRequest: () => true,
        frame: () => fixture.mainFrame,
      }),
      abort,
      continue: continueRequest,
    })
    expect(abort).toHaveBeenCalledWith('blockedbyclient')
    expect(continueRequest).not.toHaveBeenCalled()

    abort.mockClear()
    await handler?.({
      request: () => ({
        url: () => 'https://connect.garmin.cn.evil.test/app?ticket=ST-do-not-trust',
        method: () => 'GET',
        isNavigationRequest: () => true,
        frame: () => fixture.mainFrame,
      }),
      abort,
      continue: continueRequest,
    })
    expect(abort).not.toHaveBeenCalled()
    expect(continueRequest).toHaveBeenCalled()
  })

  it.each([
    ['DEBUG=*', { DEBUG: '*' }],
    ['DEBUG=pw*', { DEBUG: 'pw*' }],
    ['NODE_DEBUG=http', { NODE_DEBUG: 'http' }],
    ['NODE_OPTIONS=--trace-tls', { NODE_OPTIONS: '--trace-tls' }],
    ['SSLKEYLOGFILE', { SSLKEYLOGFILE: '/private/tls.keys' }],
    ['NODE_TLS_REJECT_UNAUTHORIZED=0', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }],
  ]) (
    'fails closed when %s could expose credential-bearing diagnostics',
    async (_label, unsafeEnvironment) => {
    const fixture = browserFixture()
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: unsafeEnvironment,
      timeoutMs: 1_000,
    })

    await expect(adapter.openAndCapture(captureOptions())).rejects.toMatchObject({
      code: 'UNSAFE_DEBUG',
    })
    expect(fixture.loadPlaywright).not.toHaveBeenCalled()
    },
  )

  it('rejects a browser policy that could navigate credentials to another host', async () => {
    const fixture = browserFixture()
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1_000,
    })

    await expect(adapter.openAndCapture({
      ...captureOptions(),
      portalUrl: 'https://attacker.example/portal/sso/en-US/sign-in',
    })).rejects.toMatchObject({ code: 'UNSAFE_BROWSER_POLICY' })
    expect(fixture.loadPlaywright).not.toHaveBeenCalled()
  })

  it('distinguishes user cancellation and still closes browser resources', async () => {
    const fixture = browserFixture()
    fixture.page.goto.mockImplementationOnce(async () => {
      fixture.handlers.get('close')?.()
    })
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1_000,
    })

    await expect(adapter.openAndCapture(captureOptions())).rejects.toMatchObject({
      code: 'CANCELLED',
    })
    expect(fixture.page.close).toHaveBeenCalledTimes(1)
    expect(fixture.context.close).toHaveBeenCalledTimes(1)
    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
  })

  it('honors an abort signal and closes browser resources', async () => {
    const fixture = browserFixture()
    const controller = new AbortController()
    fixture.page.goto.mockImplementationOnce(async () => {
      controller.abort()
    })
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1_000,
    })

    await expect(adapter.openAndCapture({
      ...captureOptions(),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fixture.context.close).toHaveBeenCalledTimes(1)
    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['cancellation', 'CANCELLED', true],
    ['timeout', 'TIMED_OUT', false],
  ] as const)(
    'settles a %s within a bounded deadline when every browser close hangs',
    async (_scenario, expectedCode, abortDuringNavigation) => {
      const fixture = browserFixture()
      const controller = new AbortController()
      const neverSettles = new Promise<void>(() => undefined)
      fixture.page.close.mockReturnValue(neverSettles)
      fixture.context.close.mockReturnValue(neverSettles)
      fixture.browser.close.mockReturnValue(neverSettles)
      fixture.page.goto.mockImplementationOnce(async () => {
        if (abortDuringNavigation) controller.abort()
      })
      const adapter = createPlaywrightBrowserAdapter({
        loadPlaywright: fixture.loadPlaywright,
        env: {},
        timeoutMs: abortDuringNavigation ? 1_000 : 5,
      })

      const operation = adapter.openAndCapture({
        ...captureOptions(),
        signal: controller.signal,
      }).then(
        () => ({ kind: 'resolved' as const }),
        error => ({ kind: 'rejected' as const, error }),
      )
      let guardTimer: ReturnType<typeof setTimeout> | undefined
      const guard = new Promise<{ kind: 'guard' }>(resolve => {
        guardTimer = setTimeout(() => resolve({ kind: 'guard' }), 1_000)
      })
      const outcome = await Promise.race([operation, guard])
      if (guardTimer) clearTimeout(guardTimer)

      expect(outcome.kind).toBe('rejected')
      if (outcome.kind === 'rejected') {
        expect(outcome.error).toMatchObject({ code: expectedCode })
      }
      expect(fixture.page.close).toHaveBeenCalledTimes(1)
      expect(fixture.context.close).toHaveBeenCalledTimes(1)
      expect(fixture.browser.close).toHaveBeenCalledTimes(1)
    },
  )

  it('handles cleanup rejections that arrive after the cleanup deadline', async () => {
    const fixture = browserFixture()
    const controller = new AbortController()
    const rejectClose: Array<(error: Error) => void> = []
    const lateFailure = () => new Promise<void>((_resolve, reject) => {
      rejectClose.push(reject)
    })
    fixture.page.close.mockReturnValue(lateFailure())
    fixture.context.close.mockReturnValue(lateFailure())
    fixture.browser.close.mockReturnValue(lateFailure())
    fixture.page.goto.mockImplementationOnce(async () => {
      controller.abort()
    })
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1_000,
    })

    const error = await adapter.openAndCapture({
      ...captureOptions(),
      signal: controller.signal,
    }).then(
      () => undefined,
      failure => failure,
    )

    expect(error).toMatchObject({ code: 'CANCELLED' })
    expect(String(error)).not.toContain('PRIVATE_CLOSE_FAILURE')
    expect(rejectClose).toHaveLength(3)
    for (const reject of rejectClose) {
      reject(new Error('PRIVATE_CLOSE_FAILURE'))
    }
    await new Promise(resolve => setImmediate(resolve))
  })

  it('cancels while Chrome is still launching and closes a late browser', async () => {
    const fixture = browserFixture()
    const controller = new AbortController()
    let finishLaunch: ((browser: typeof fixture.browser) => void) | undefined
    fixture.launch.mockImplementationOnce(() => new Promise((resolve) => {
      finishLaunch = resolve
    }))
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1_000,
    })

    const operation = adapter.openAndCapture({
      ...captureOptions(),
      signal: controller.signal,
    })
    controller.abort()
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' })

    finishLaunch?.(fixture.browser)
    await new Promise(resolve => setImmediate(resolve))
    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
  })

  it('normalizes a launch rejection without leaking a derived promise error', async () => {
    const fixture = browserFixture()
    fixture.launch.mockRejectedValueOnce(
      new Error('PRIVATE_BROWSER_PATH cookie=PRIVATE_COOKIE'),
    )
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1_000,
    })

    const operation = adapter.openAndCapture(captureOptions())
    await expect(operation).rejects.toMatchObject({
      code: 'BROWSER_UNAVAILABLE',
    })
    await expect(operation).rejects.not.toThrow('PRIVATE_BROWSER_PATH')
    await new Promise(resolve => setImmediate(resolve))
  })

  it('reports a bounded timeout and closes browser resources', async () => {
    const fixture = browserFixture()
    fixture.page.goto.mockResolvedValueOnce(undefined)
    const adapter = createPlaywrightBrowserAdapter({
      loadPlaywright: fixture.loadPlaywright,
      env: {},
      timeoutMs: 1,
    })

    await expect(adapter.openAndCapture(captureOptions())).rejects.toMatchObject({
      code: 'TIMED_OUT',
    })
    expect(fixture.context.close).toHaveBeenCalledTimes(1)
    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
  })

  it('enforces redirect, proxy, timeout, and response limits in Axios', async () => {
    const axiosRequest = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      data: { access_token: 'secret' },
    })
    const adapter = createAxiosCanaryHttpAdapter({ axiosRequest })
    const request: BrowserDiHttpRequest = {
      method: 'POST',
      url: 'https://diauth.garmin.cn/di-oauth2-service/oauth/token',
      headers: { Authorization: 'Basic PUBLIC_CLIENT_ID' },
      body: 'service_ticket=ST-secret',
      followRedirects: false,
      maxResponseBytes: 64 * 1024,
      retry: false,
      timeoutMs: 30_000,
      useProxy: false,
    }

    await expect(adapter.request(request)).resolves.toEqual({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { access_token: 'secret' },
    })
    expect(axiosRequest).toHaveBeenCalledWith(expect.objectContaining({
      data: request.body,
      maxBodyLength: 64 * 1024,
      maxContentLength: 64 * 1024,
      maxRedirects: 0,
      method: 'POST',
      proxy: false,
      responseType: 'json',
      timeout: 30_000,
      url: request.url,
      validateStatus: expect.any(Function),
    }))
  })

  it('rejects weakened HTTP policy before a credential request is sent', async () => {
    const axiosRequest = jest.fn()
    const adapter = createAxiosCanaryHttpAdapter({ axiosRequest })
    const unsafe = {
      method: 'POST',
      url: 'https://diauth.garmin.cn/di-oauth2-service/oauth/token',
      headers: {},
      followRedirects: true,
      maxResponseBytes: 64 * 1024,
      retry: false,
      timeoutMs: 30_000,
      useProxy: false,
    } as unknown as BrowserDiHttpRequest

    await expect(adapter.request(unsafe)).rejects.toBeInstanceOf(
      BrowserCanaryControlError,
    )
    expect(axiosRequest).not.toHaveBeenCalled()
  })

  it('rejects Node HTTP/TLS diagnostics at the Axios boundary', async () => {
    const axiosRequest = jest.fn()
    const adapter = createAxiosCanaryHttpAdapter({
      axiosRequest,
      env: { NODE_DEBUG: 'http' },
    })
    const request: BrowserDiHttpRequest = {
      method: 'GET',
      url: 'https://connectapi.garmin.cn/userprofile-service/socialProfile',
      headers: { Authorization: 'Bearer PRIVATE_TOKEN' },
      followRedirects: false,
      maxResponseBytes: 256 * 1024,
      retry: false,
      timeoutMs: 30_000,
      useProxy: false,
    }

    await expect(adapter.request(request)).rejects.toMatchObject({
      code: 'UNSAFE_DEBUG',
    })
    expect(axiosRequest).not.toHaveBeenCalled()
  })
})
