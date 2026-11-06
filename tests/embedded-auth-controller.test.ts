import type { GarminRegion } from '../src/config'
import type { AuthDiagnosticReporter } from '../src/auth-diagnostics'
import {
  EmbeddedAuthController,
  type EmbeddedAuthControllerFlowPort,
  type EmbeddedAuthControllerServerPort,
} from '../src/embedded-auth-controller'
import type { CdpBrowserLauncher, CdpBrowserSession } from '../src/cdp-browser'

const FLOW_ONE = '1'.repeat(64)
const FLOW_TWO = '2'.repeat(64)
const CSRF = 'c'.repeat(43)
const ORIGIN = 'http://127.0.0.1:43123'
const BRIDGE_ONE = `${ORIGIN}/garmin-auth/bridge/${FLOW_ONE}`
const BRIDGE_TWO = `${ORIGIN}/garmin-auth/bridge/${FLOW_TWO}`

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createFlows(): jest.Mocked<EmbeddedAuthControllerFlowPort> {
  return {
    start: jest.fn().mockReturnValue({
      flowId: FLOW_ONE,
      expiresAt: 50_000,
    }),
    publicStatus: jest.fn().mockReturnValue({ state: 'in_progress' }),
    bridgeBootstrap: jest.fn().mockReturnValue({
      csrf: CSRF,
      frameUrl: 'https://sso.garmin.cn/sso/signin',
      ssoOrigin: 'https://sso.garmin.cn',
      serviceUrl: 'https://sso.garmin.cn/sso/embed',
    }),
    cancel: jest.fn(),
    waitForTerminal: jest.fn().mockResolvedValue({ state: 'cancelled' }),
  }
}

function createServer(): jest.Mocked<EmbeddedAuthControllerServerPort> {
  return {
    start: jest.fn().mockResolvedValue(ORIGIN),
    bridgeUrl: jest.fn((flowId: string) => (
      `${ORIGIN}/garmin-auth/bridge/${flowId}`
    )),
    close: jest.fn().mockResolvedValue(undefined),
  }
}

function createController(overrides: {
  username?: unknown
  region?: unknown
  sessionTokenFile?: unknown
  flows?: EmbeddedAuthControllerFlowPort
  server?: EmbeddedAuthControllerServerPort
  prepareDestination?: (path: string) => Promise<void>
  commitDrainTimeoutMs?: number
  diagnostics?: AuthDiagnosticReporter
  cdpBrowser?: CdpBrowserLauncher
  now?: () => number
} = {}) {
  const flows = overrides.flows ?? createFlows()
  const server = overrides.server ?? createServer()
  const controller = new EmbeddedAuthController({
    username: (overrides.username ?? 'runner@example.com') as string,
    region: (overrides.region ?? 'cn') as GarminRegion,
    sessionTokenFile: (
      overrides.sessionTokenFile ?? '/private/account/session.json'
    ) as string,
    flows,
    server,
    prepareDestination: overrides.prepareDestination
      ?? jest.fn().mockResolvedValue(undefined),
    commitDrainTimeoutMs: overrides.commitDrainTimeoutMs,
    diagnostics: overrides.diagnostics,
    cdpBrowser: overrides.cdpBrowser,
    now: overrides.now ?? (() => 0),
  })
  return {
    controller,
    flows: flows as jest.Mocked<EmbeddedAuthControllerFlowPort>,
    server: server as jest.Mocked<EmbeddedAuthControllerServerPort>,
  }
}

describe('EmbeddedAuthController', () => {
  it('opens CDP only for an explicit CDP begin and keeps the existing bridge flow', async () => {
    const session: CdpBrowserSession = {
      closed: new Promise(() => undefined),
      close: jest.fn().mockResolvedValue(undefined),
    }
    const cdpBrowser: CdpBrowserLauncher = {
      open: jest.fn().mockResolvedValue(session),
    }
    const { controller, flows } = createController({ cdpBrowser })

    await expect(controller.beginCdp(undefined, 'cn')).resolves.toEqual({
      success: true,
      flowId: FLOW_ONE,
      bridgeUrl: BRIDGE_ONE,
      expiresAt: 50_000,
    })
    expect(cdpBrowser.open).toHaveBeenCalledWith(BRIDGE_ONE, undefined)
    expect(flows.start).toHaveBeenCalledTimes(1)
  })

  it('does not open CDP for the default embedded begin', async () => {
    const cdpBrowser: CdpBrowserLauncher = {
      open: jest.fn(),
    }
    const { controller } = createController({ cdpBrowser })

    await expect(controller.begin()).resolves.toMatchObject({ success: true })
    expect(cdpBrowser.open).not.toHaveBeenCalled()
  })

  it('cancels the new flow and returns a fixed result when CDP cannot start', async () => {
    const diagnostics = jest.fn()
    const cdpBrowser: CdpBrowserLauncher = {
      open: jest.fn().mockRejectedValue(
        new Error('ws://127.0.0.1:43123 private@example.test'),
      ),
    }
    const { controller, flows } = createController({ cdpBrowser, diagnostics })

    await expect(controller.beginCdp()).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(flows.cancel).toHaveBeenCalledWith(FLOW_ONE, CSRF)
    expect(diagnostics.mock.calls).toContainEqual([
      'cdp_browser_open_failed',
      'browser_launch_failed',
    ])
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/ws:|43123|private@/i)
  })

  it.each([
    ['BROWSER_UNAVAILABLE', 'cdp_browser_unavailable'],
    ['DRIVER_UNAVAILABLE', 'cdp_driver_unavailable'],
    ['TIMED_OUT', 'cdp_start_timeout'],
    ['CANCELLED', 'cancelled'],
  ] as const)('maps CDP %s to the safe diagnostic code %s', async (
    upstreamCode,
    diagnosticCode,
  ) => {
    const diagnostics = jest.fn()
    const cdpBrowser: CdpBrowserLauncher = {
      open: jest.fn().mockRejectedValue(Object.assign(
        new Error('ws://127.0.0.1:43123 private@example.test'),
        { code: upstreamCode },
      )),
    }
    const { controller } = createController({ cdpBrowser, diagnostics })

    await expect(controller.beginCdp()).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(diagnostics.mock.calls).toContainEqual([
      'cdp_browser_open_failed',
      diagnosticCode,
    ])
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/ws:|43123|private@/i)
  })

  it.each(['succeeded', 'failed', 'cancelled', 'expired'] as const)(
    'closes the owned CDP browser when the flow becomes %s',
    async (state) => {
      const close = jest.fn().mockResolvedValue(undefined)
      const cdpBrowser: CdpBrowserLauncher = {
        open: jest.fn().mockResolvedValue({
          closed: new Promise(() => undefined),
          close,
        }),
      }
      const { controller, flows } = createController({ cdpBrowser })
      const started = await controller.beginCdp()
      expect(started.success).toBe(true)
      flows.publicStatus.mockReturnValue({ state })

      expect(controller.status({ flowId: FLOW_ONE })).toEqual({
        success: true,
        status: state,
      })
      await Promise.resolve()
      expect(close).toHaveBeenCalledTimes(1)
    },
  )

  it('cancels the flow if the user closes the owned CDP browser early', async () => {
    const browserClosed = deferred<void>()
    const cdpBrowser: CdpBrowserLauncher = {
      open: jest.fn().mockResolvedValue({
        closed: browserClosed.promise,
        close: jest.fn().mockResolvedValue(undefined),
      }),
    }
    const { controller, flows } = createController({ cdpBrowser })
    await controller.beginCdp()

    browserClosed.resolve()
    await browserClosed.promise
    await Promise.resolve()

    expect(flows.cancel).toHaveBeenCalledWith(FLOW_ONE, CSRF)
  })

  it('closes and cancels an abandoned CDP flow at its public expiry', async () => {
    jest.useFakeTimers()
    try {
      const close = jest.fn().mockResolvedValue(undefined)
      const cdpBrowser: CdpBrowserLauncher = {
        open: jest.fn().mockResolvedValue({
          closed: new Promise(() => undefined),
          close,
        }),
      }
      const { controller, flows } = createController({ cdpBrowser })
      await controller.beginCdp()

      jest.advanceTimersByTime(50_000)
      await Promise.resolve()

      expect(flows.cancel).toHaveBeenCalledWith(FLOW_ONE, CSRF)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
  it('lazily starts the bridge and returns only the public flow handle', async () => {
    const { controller, flows, server } = createController()

    const result = await controller.begin()

    expect(server.start).toHaveBeenCalledTimes(1)
    expect(flows.start).toHaveBeenCalledWith({
      username: 'runner@example.com',
      region: 'cn',
      sessionTokenFile: '/private/account/session.json',
      bridgeOrigin: ORIGIN,
    })
    expect(server.bridgeUrl).toHaveBeenCalledWith(FLOW_ONE)
    expect(result).toEqual({
      success: true,
      flowId: FLOW_ONE,
      bridgeUrl: BRIDGE_ONE,
      expiresAt: 50_000,
    })
    expect(JSON.stringify(result)).not.toMatch(/runner|private|session|csrf/i)
  })

  it('preflights the private destination before starting a bridge or flow', async () => {
    const prepareDestination = jest.fn().mockRejectedValue(
      new Error('/private/account/session.json is not writable'),
    )
    const { controller, flows, server } = createController({ prepareDestination })

    await expect(controller.begin()).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(prepareDestination).toHaveBeenCalledWith('/private/account/session.json')
    expect(server.start).not.toHaveBeenCalled()
    expect(flows.start).not.toHaveBeenCalled()
  })

  it('reports a fixed destination failure code without forwarding the error text', async () => {
    const diagnostics = jest.fn()
    const unsafeError = Object.assign(
      new Error('runner@example.com C:\\Users\\runner\\session.json SECRET_TICKET'),
      { authDiagnosticCode: 'windows_acl_rejected' as const },
    )
    const prepareDestination = jest.fn().mockRejectedValue(unsafeError)
    const { controller } = createController({ prepareDestination, diagnostics })

    await expect(controller.begin()).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(diagnostics.mock.calls).toEqual([
      ['begin_started', undefined],
      ['session_destination_prepare_started', undefined],
      ['session_destination_prepare_failed', 'windows_acl_rejected'],
    ])
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(
      /runner|users|session\.json|secret|ticket/i,
    )
  })

  it('distinguishes loopback startup from destination and flow failures', async () => {
    const diagnostics = jest.fn()
    const server = createServer()
    server.start.mockRejectedValue(
      new Error('listen failed for runner@example.com at C:\\private'),
    )
    const { controller } = createController({ diagnostics, server })

    await expect(controller.begin()).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(diagnostics.mock.calls).toEqual([
      ['begin_started', undefined],
      ['session_destination_prepare_started', undefined],
      ['session_destination_prepare_succeeded', undefined],
      ['loopback_server_start_started', undefined],
      ['loopback_server_start_failed', 'loopback_start_failed'],
    ])
  })

  it('does not start a bridge when cancellation happens during destination preflight', async () => {
    const preflight = deferred<void>()
    const prepareDestination = jest.fn().mockReturnValue(preflight.promise)
    const { controller, flows, server } = createController({ prepareDestination })
    const abort = new AbortController()

    const result = controller.begin(abort.signal)
    abort.abort()
    preflight.resolve()

    await expect(result).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(server.start).not.toHaveBeenCalled()
    expect(flows.start).not.toHaveBeenCalled()
  })

  it.each([
    ['cn', 'global'],
    ['global', 'cn'],
  ] as const)('rejects a %s-configured account when %s is selected as a region mismatch', async (configuredRegion, requestedRegion) => {
    const { controller, flows, server } = createController({ region: configuredRegion })

    await expect(controller.begin(undefined, requestedRegion)).resolves.toEqual({
      success: false,
      code: 'region_mismatch',
    })
    expect(server.start).not.toHaveBeenCalled()
    expect(flows.start).not.toHaveBeenCalled()
  })

  it.each([
    ['empty username', { username: '   ' }],
    ['control character in username', { username: 'runner\n@example.com' }],
    ['oversized username', { username: 'x'.repeat(321) }],
    ['unknown region', { region: 'eu' }],
    ['empty session path', { sessionTokenFile: '' }],
    ['control character in session path', { sessionTokenFile: '/tmp/a\0b' }],
    ['oversized session path', { sessionTokenFile: `/${'x'.repeat(4096)}` }],
  ])('rejects %s as a fixed configuration failure', async (_label, overrides) => {
    const { controller, flows, server } = createController(overrides)

    await expect(controller.begin()).resolves.toEqual({
      success: false,
      code: 'configuration',
    })
    expect(server.start).not.toHaveBeenCalled()
    expect(flows.start).not.toHaveBeenCalled()
  })

  it('collapses bridge startup errors without leaking their details', async () => {
    const server = createServer()
    server.start.mockRejectedValue(
      new Error('listen failed for runner@example.com at /private/session'),
    )
    const { controller, flows } = createController({ server })

    const result = await controller.begin()

    expect(result).toEqual({ success: false, code: 'unavailable' })
    expect(JSON.stringify(result)).not.toMatch(/runner|private|listen|session/i)
    expect(flows.start).not.toHaveBeenCalled()
  })

  it('allows only one begin operation while the lazy server start is pending', async () => {
    const startGate = deferred<string>()
    const server = createServer()
    server.start.mockReturnValue(startGate.promise)
    const { controller, flows } = createController({ server })

    const first = controller.begin()
    await expect(controller.begin()).resolves.toEqual({
      success: false,
      code: 'busy',
    })

    startGate.resolve(ORIGIN)
    await expect(first).resolves.toEqual({
      success: true,
      flowId: FLOW_ONE,
      bridgeUrl: BRIDGE_ONE,
      expiresAt: 50_000,
    })
    expect(flows.start).toHaveBeenCalledTimes(1)
  })

  it('rejects a new flow while the current flow is not terminal', async () => {
    const { controller, flows, server } = createController()
    await controller.begin()

    await expect(controller.begin()).resolves.toEqual({
      success: false,
      code: 'busy',
    })
    expect(flows.publicStatus).toHaveBeenCalledWith(FLOW_ONE)
    expect(flows.start).toHaveBeenCalledTimes(1)
    expect(server.start).toHaveBeenCalledTimes(1)
  })

  it.each(['succeeded', 'failed', 'cancelled', 'expired'] as const)(
    'replaces a current %s flow',
    async (state) => {
      const flows = createFlows()
      flows.start
        .mockReturnValueOnce({ flowId: FLOW_ONE, expiresAt: 50_000 })
        .mockReturnValueOnce({ flowId: FLOW_TWO, expiresAt: 60_000 })
      flows.publicStatus.mockReturnValue({ state })
      const { controller } = createController({ flows })

      await controller.begin()
      await expect(controller.begin()).resolves.toEqual({
        success: true,
        flowId: FLOW_TWO,
        bridgeUrl: BRIDGE_TWO,
        expiresAt: 60_000,
      })
      expect(flows.start).toHaveBeenCalledTimes(2)
    },
  )

  it('returns only the coarse public status for the exact current-flow payload', async () => {
    const { controller, flows } = createController()
    await controller.begin()
    flows.publicStatus.mockReturnValue({ state: 'succeeded' })

    expect(controller.status({ flowId: FLOW_ONE })).toEqual({
      success: true,
      status: 'succeeded',
    })
    expect(JSON.stringify(controller.status({ flowId: FLOW_ONE })))
      .not.toMatch(/runner|private|session|identity|csrf/i)
  })

  it.each([
    null,
    undefined,
    {},
    { flowId: FLOW_ONE, extra: true },
    { flowId: 1 },
    { flowId: FLOW_TWO },
    Object.create({ flowId: FLOW_ONE }),
  ])('rejects a non-exact or non-current status payload', (payload) => {
    const { controller, flows } = createController()

    expect(controller.status(payload)).toEqual({
      success: false,
      code: 'invalid',
    })
    expect(flows.publicStatus).not.toHaveBeenCalled()
  })

  it('collapses malformed or failed public-status dependencies', async () => {
    const { controller, flows } = createController()
    await controller.begin()
    flows.publicStatus.mockReturnValueOnce({
      state: 'runner@example.com',
    } as never)

    expect(controller.status({ flowId: FLOW_ONE })).toEqual({
      success: false,
      code: 'unavailable',
    })

    flows.publicStatus.mockImplementationOnce(() => {
      throw new Error('/private/session token=secret')
    })
    expect(controller.status({ flowId: FLOW_ONE })).toEqual({
      success: false,
      code: 'unavailable',
    })
  })

  it('cancels only the current flow using its trusted private CSRF', async () => {
    const { controller, flows } = createController()
    await controller.begin()

    expect(controller.cancel({ flowId: FLOW_ONE })).toEqual({ success: true })
    expect(flows.bridgeBootstrap).toHaveBeenCalledWith(FLOW_ONE)
    expect(flows.cancel).toHaveBeenCalledWith(FLOW_ONE, CSRF)
  })

  it.each([
    null,
    {},
    { flowId: FLOW_ONE, extra: true },
    { flowId: FLOW_TWO },
  ])('rejects a non-exact or non-current cancellation payload', async (payload) => {
    const { controller, flows } = createController()
    await controller.begin()
    jest.clearAllMocks()

    expect(controller.cancel(payload)).toEqual({
      success: false,
      code: 'invalid',
    })
    expect(flows.bridgeBootstrap).not.toHaveBeenCalled()
    expect(flows.cancel).not.toHaveBeenCalled()
  })

  it('collapses cancellation errors without returning CSRF or dependency details', async () => {
    const { controller, flows } = createController()
    await controller.begin()
    flows.cancel.mockImplementation(() => {
      throw new Error('csrf-secret runner@example.com')
    })

    const result = controller.cancel({ flowId: FLOW_ONE })

    expect(result).toEqual({ success: false, code: 'unavailable' })
    expect(JSON.stringify(result)).not.toMatch(/csrf|runner|secret/i)
  })

  it('closes an owned CDP browser even when flow cancellation fails', async () => {
    const close = jest.fn().mockResolvedValue(undefined)
    const cdpBrowser: CdpBrowserLauncher = {
      open: jest.fn().mockResolvedValue({
        closed: new Promise(() => undefined),
        close,
      }),
    }
    const { controller, flows } = createController({ cdpBrowser })
    await controller.beginCdp()
    flows.cancel.mockImplementation(() => {
      throw new Error('csrf-secret runner@example.com')
    })

    expect(controller.cancel({ flowId: FLOW_ONE })).toEqual({
      success: false,
      code: 'unavailable',
    })
    await Promise.resolve()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('cancels an active current flow and closes the server', async () => {
    const { controller, flows, server } = createController()
    await controller.begin()

    await controller.close()

    expect(flows.bridgeBootstrap).toHaveBeenCalledWith(FLOW_ONE)
    expect(flows.cancel).toHaveBeenCalledWith(FLOW_ONE, CSRF)
    expect(server.close).toHaveBeenCalledTimes(1)
    await expect(controller.begin()).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
  })

  it('still closes the server when flow cancellation or close itself fails', async () => {
    const flows = createFlows()
    flows.cancel.mockImplementation(() => {
      throw new Error('ticket=secret')
    })
    const server = createServer()
    server.close.mockRejectedValue(new Error('/private/server'))
    const { controller } = createController({ flows, server })
    await controller.begin()

    await expect(controller.close()).resolves.toBeUndefined()
    expect(flows.cancel).toHaveBeenCalledTimes(1)
    expect(server.close).toHaveBeenCalledTimes(1)
  })

  it('waits for an irrevocable credential save before closing the server', async () => {
    const terminal = deferred<{ state: 'succeeded' }>()
    const flows = createFlows()
    flows.cancel.mockImplementation(() => {
      throw new Error('saving cannot be cancelled')
    })
    flows.waitForTerminal.mockReturnValue(terminal.promise)
    const { controller, server } = createController({ flows })
    await controller.begin()

    const closing = controller.close()
    await Promise.resolve()

    expect(flows.waitForTerminal).toHaveBeenCalledWith(FLOW_ONE)
    expect(server.close).not.toHaveBeenCalled()

    terminal.resolve({ state: 'succeeded' })
    await expect(closing).resolves.toBeUndefined()
    expect(server.close).toHaveBeenCalledTimes(1)
  })

  it('bounds a stalled credential-save drain and makes close idempotent', async () => {
    const flows = createFlows()
    flows.cancel.mockImplementation(() => {
      throw new Error('saving cannot be cancelled')
    })
    flows.waitForTerminal.mockReturnValue(new Promise(() => undefined))
    const { controller, server } = createController({
      flows,
      commitDrainTimeoutMs: 10,
    })
    await controller.begin()

    const first = controller.close()
    const second = controller.close()

    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    expect(flows.waitForTerminal).toHaveBeenCalledTimes(1)
    expect(server.close).toHaveBeenCalledTimes(1)
  })

  it('does not start a flow for an already-aborted request', async () => {
    const { controller, flows, server } = createController()
    const abort = new AbortController()
    abort.abort()

    await expect(controller.begin(abort.signal)).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(server.start).not.toHaveBeenCalled()
    expect(flows.start).not.toHaveBeenCalled()
  })

  it('does not start a flow when the request aborts during server startup', async () => {
    const gate = deferred<string>()
    const server = createServer()
    server.start.mockReturnValue(gate.promise)
    const { controller, flows } = createController({ server })
    const abort = new AbortController()

    const result = controller.begin(abort.signal)
    abort.abort()
    gate.resolve(ORIGIN)

    await expect(result).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(flows.start).not.toHaveBeenCalled()
  })

  it('fails closed and cancels an orphaned flow when the server URL is invalid', async () => {
    const server = createServer()
    server.bridgeUrl.mockReturnValue(
      `https://attacker.example/collect?flow=${FLOW_ONE}`,
    )
    const { controller, flows } = createController({ server })

    await expect(controller.begin()).resolves.toEqual({
      success: false,
      code: 'unavailable',
    })
    expect(flows.bridgeBootstrap).toHaveBeenCalledWith(FLOW_ONE)
    expect(flows.cancel).toHaveBeenCalledWith(FLOW_ONE, CSRF)
  })
})
