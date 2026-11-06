import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  LocalAuthBroker,
  openLoopbackAuthInSystemBrowser,
  type LocalAuthBrokerController,
} from '../src/local-auth-broker'
import { EmbeddedAuthController } from '../src/embedded-auth-controller'
import { EmbeddedAuthFlowManager } from '../src/embedded-auth-flow'

const FLOW_ID = 'a'.repeat(64)
const BRIDGE_URL = `http://127.0.0.1:43127/garmin-auth/bridge/${FLOW_ID}`

function controllerFixture(
  states: Array<'in_progress' | 'succeeded' | 'failed' | 'cancelled' | 'expired'> = [
    'in_progress',
    'succeeded',
  ],
): jest.Mocked<LocalAuthBrokerController> {
  return {
    begin: jest.fn().mockResolvedValue({
      success: true,
      flowId: FLOW_ID,
      bridgeUrl: BRIDGE_URL,
      expiresAt: 1_900_000_000_000,
    }),
    status: jest.fn().mockImplementation(() => ({
      success: true,
      status: states.shift() ?? 'succeeded',
    })),
    cancel: jest.fn().mockReturnValue({ success: true }),
    close: jest.fn().mockResolvedValue(undefined),
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('local Garmin authentication broker', () => {
  it('opens the system browser, waits for success, keeps a display grace, and closes', async () => {
    const controller = controllerFixture()
    const openBrowser = jest.fn().mockResolvedValue(undefined)
    const sleep = jest.fn().mockResolvedValue(undefined)
    const diagnostics = jest.fn()
    const broker = new LocalAuthBroker({
      controller,
      openBrowser,
      sleep,
      diagnostics,
      pollIntervalMs: 250,
      successGraceMs: 1_500,
    })

    await expect(broker.authenticateInSystemBrowser('cn')).resolves.toEqual({
      success: true,
      region: 'cn',
    })

    expect(controller.begin).toHaveBeenCalledWith(undefined, 'cn')
    expect(openBrowser).toHaveBeenCalledWith(BRIDGE_URL)
    expect(controller.status).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(sleep.mock.calls[0]?.[0]).toBe(250)
    expect(sleep.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(sleep.mock.calls[1]).toEqual([1_500, undefined])
    expect(controller.close).toHaveBeenCalledTimes(1)
    expect(controller.cancel).not.toHaveBeenCalled()
    expect(diagnostics.mock.calls).toEqual([
      ['system_browser_open_started', undefined],
      ['system_browser_open_succeeded', undefined],
    ])
  })

  it.each([
    ['failed', 'Garmin browser authentication failed'],
    ['cancelled', 'Garmin browser authentication was cancelled'],
    ['expired', 'Garmin browser authentication timed out'],
  ] as const)('collapses %s to a fixed public error and closes', async (state, message) => {
    const controller = controllerFixture([state])
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn().mockResolvedValue(undefined),
      sleep: jest.fn().mockResolvedValue(undefined),
    })

    await expect(broker.authenticateInSystemBrowser('global')).rejects.toThrow(message)
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('cancels and closes when the browser cannot be opened without exposing the URL', async () => {
    const controller = controllerFixture()
    const marker = `${BRIDGE_URL}?token=ST-secret`
    const diagnostics = jest.fn()
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn().mockRejectedValue(new Error(marker)),
      sleep: jest.fn().mockResolvedValue(undefined),
      diagnostics,
    })

    const operation = broker.authenticateInSystemBrowser('cn')
    await expect(operation).rejects.toThrow('The system browser could not be opened')
    await expect(operation).rejects.not.toThrow(marker)
    expect(controller.cancel).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(controller.close).toHaveBeenCalledTimes(1)
    expect(diagnostics.mock.calls).toEqual([
      ['system_browser_open_started', undefined],
      ['system_browser_open_failed', 'browser_launch_failed'],
    ])
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/st-secret|bridge\//i)
  })

  it('cancels an active flow when the caller aborts', async () => {
    const controller = controllerFixture(['in_progress'])
    const abort = new AbortController()
    const sleep = jest.fn().mockImplementation(async () => {
      abort.abort()
    })
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn().mockResolvedValue(undefined),
      sleep,
    })

    await expect(broker.authenticateInSystemBrowser('cn', abort.signal))
      .rejects.toThrow('Garmin browser authentication was cancelled')
    expect(controller.cancel).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('reports a pre-aborted begin as cancellation without starting the controller', async () => {
    const controller = controllerFixture()
    const abort = new AbortController()
    abort.abort()
    const broker = new LocalAuthBroker({ controller })

    await expect(broker.begin('cn', abort.signal)).rejects.toThrow(
      'Garmin browser authentication was cancelled',
    )
    expect(controller.begin).not.toHaveBeenCalled()
  })

  it('preserves cancellation when controller begin returns unavailable after abort', async () => {
    const controller = controllerFixture()
    const abort = new AbortController()
    controller.begin.mockImplementation(async () => {
      abort.abort()
      return { success: false, code: 'unavailable' }
    })
    const broker = new LocalAuthBroker({ controller })

    await expect(broker.begin('cn', abort.signal)).rejects.toThrow(
      'Garmin browser authentication was cancelled',
    )
    expect(controller.cancel).not.toHaveBeenCalled()
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('does not open a browser when cancellation wins immediately after begin', async () => {
    const controller = controllerFixture()
    const abort = new AbortController()
    controller.begin.mockImplementation(async () => {
      abort.abort()
      return {
        success: true,
        flowId: FLOW_ID,
        bridgeUrl: BRIDGE_URL,
        expiresAt: 1_900_000_000_000,
      }
    })
    const openBrowser = jest.fn()
    const broker = new LocalAuthBroker({ controller, openBrowser })

    await expect(broker.authenticateInSystemBrowser('cn', abort.signal))
      .rejects.toThrow('Garmin browser authentication was cancelled')
    expect(openBrowser).not.toHaveBeenCalled()
    expect(controller.cancel).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('can start without opening a browser so MCP URL elicitation can own navigation', async () => {
    const controller = controllerFixture(['succeeded'])
    const openBrowser = jest.fn()
    const broker = new LocalAuthBroker({
      controller,
      openBrowser,
      sleep: jest.fn().mockResolvedValue(undefined),
    })

    await expect(broker.begin('global')).resolves.toEqual({
      url: BRIDGE_URL,
      expiresAt: 1_900_000_000_000,
    })
    await expect(broker.wait()).resolves.toBe('succeeded')

    expect(openBrowser).not.toHaveBeenCalled()
    await broker.close()
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('wakes a pending wait when close cancels a flow whose status stays in progress', async () => {
    const controller = controllerFixture([])
    controller.status.mockReturnValue({ success: true, status: 'in_progress' })
    let sleepSignal: AbortSignal | undefined
    const sleep = jest.fn((_milliseconds: number, signal?: AbortSignal) => (
      new Promise<void>((_resolve, reject) => {
        sleepSignal = signal
        signal?.addEventListener('abort', () => {
          reject(new Error('sleep aborted'))
        }, { once: true })
      })
    ))
    const broker = new LocalAuthBroker({ controller, sleep })
    await broker.begin('global')
    const waiting = broker.wait()
    while (!sleepSignal) await Promise.resolve()

    const closing = broker.close()

    await expect(waiting).resolves.toBe('cancelled')
    await expect(closing).resolves.toBeUndefined()
    expect(sleepSignal?.aborted).toBe(true)
    expect(controller.cancel).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('drains an irrevocable save instead of reporting a cancelled authentication', async () => {
    const controller = controllerFixture(['in_progress', 'succeeded'])
    controller.cancel.mockReturnValue({ success: false, code: 'unavailable' })
    const abort = new AbortController()
    const sleep = jest.fn().mockImplementation(async () => {
      abort.abort()
    })
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn().mockResolvedValue(undefined),
      sleep,
      successGraceMs: 0,
    })

    await expect(broker.authenticateInSystemBrowser('cn', abort.signal))
      .resolves.toEqual({ success: true, region: 'cn' })
    expect(controller.cancel).toHaveBeenCalledWith({ flowId: FLOW_ID })
    expect(controller.status).toHaveBeenCalledTimes(2)
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('reports an unknown outcome when an irrevocable save cannot be drained', async () => {
    const controller = controllerFixture(['in_progress'])
    controller.cancel.mockReturnValue({ success: false, code: 'unavailable' })
    controller.status
      .mockReturnValueOnce({ success: true, status: 'in_progress' })
      .mockReturnValueOnce({ success: false, code: 'unavailable' })
    const abort = new AbortController()
    const sleep = jest.fn().mockImplementation(async () => {
      abort.abort()
    })
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn().mockResolvedValue(undefined),
      sleep,
    })

    await expect(broker.authenticateInSystemBrowser('global', abort.signal))
      .rejects.toThrow(
        'Garmin authentication is already being saved; completion is unknown',
      )
    expect(controller.close).toHaveBeenCalledTimes(1)
  })

  it('does not stack broker and controller timeouts for a hung save', async () => {
    jest.useFakeTimers()
    const saveGate = deferred()
    const flows = new EmbeddedAuthFlowManager({
      authenticate: async (input) => {
        await input.confirmIdentity({ userName: 'runner' })
        await saveGate.promise
      },
    })
    const origin = 'http://127.0.0.1:43127'
    const server = {
      start: jest.fn().mockResolvedValue(origin),
      bridgeUrl: jest.fn((flowId: string) => (
        `${origin}/garmin-auth/bridge/${flowId}`
      )),
      close: jest.fn().mockResolvedValue(undefined),
    }
    const controller = new EmbeddedAuthController({
      username: 'runner@example.com',
      region: 'cn',
      sessionTokenFile: '/private/account/session.json',
      flows,
      server,
      prepareDestination: jest.fn().mockResolvedValue(undefined),
      commitDrainTimeoutMs: 100,
    })
    const broker = new LocalAuthBroker({
      controller,
      pollIntervalMs: 50,
      commitDrainTimeoutMs: 100,
      successGraceMs: 0,
    })

    try {
      const begun = await broker.begin('cn')
      const flowId = new URL(begun.url).pathname.split('/').pop()
      if (!flowId) throw new Error('expected flow id')
      const { csrf } = flows.bridgeBootstrap(flowId)
      flows.submitTicket(flowId, csrf, {
        serviceTicket: 'ST-hung-save',
        serviceUrl: origin,
      })
      await settle()
      flows.confirm(flowId, csrf, true)

      const closing = broker.close()
      let closed = false
      void closing.then(() => {
        closed = true
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(closed).toBe(true)
      expect(server.close).toHaveBeenCalledTimes(1)
      await expect(closing).resolves.toBeUndefined()
    } finally {
      saveGate.resolve()
      await settle()
      jest.useRealTimers()
    }
  })

  it('does not stack drain timeouts when aborting browser auth during a hung save', async () => {
    jest.useFakeTimers()
    const saveGate = deferred()
    const savingStarted = deferred()
    const abort = new AbortController()
    const flows = new EmbeddedAuthFlowManager({
      authenticate: async (input) => {
        await input.confirmIdentity({ userName: 'runner' })
        await saveGate.promise
      },
    })
    const origin = 'http://127.0.0.1:43128'
    const server = {
      start: jest.fn().mockResolvedValue(origin),
      bridgeUrl: jest.fn((flowId: string) => (
        `${origin}/garmin-auth/bridge/${flowId}`
      )),
      close: jest.fn().mockResolvedValue(undefined),
    }
    const controller = new EmbeddedAuthController({
      username: 'runner@example.com',
      region: 'cn',
      sessionTokenFile: '/private/account/session.json',
      flows,
      server,
      prepareDestination: jest.fn().mockResolvedValue(undefined),
      commitDrainTimeoutMs: 100,
    })
    const broker = new LocalAuthBroker({
      controller,
      openBrowser: jest.fn(async (url: string) => {
        const flowId = new URL(url).pathname.split('/').pop()
        if (!flowId) throw new Error('expected flow id')
        const { csrf } = flows.bridgeBootstrap(flowId)
        flows.submitTicket(flowId, csrf, {
          serviceTicket: 'ST-aborted-hung-save',
          serviceUrl: origin,
        })
        await settle()
        flows.confirm(flowId, csrf, true)
        abort.abort()
        savingStarted.resolve()
      }),
      pollIntervalMs: 50,
      commitDrainTimeoutMs: 100,
      successGraceMs: 0,
    })

    try {
      const authentication = broker.authenticateInSystemBrowser('cn', abort.signal)
      await savingStarted.promise
      let settled = false
      void authentication.catch(() => undefined).then(() => {
        settled = true
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(settled).toBe(true)
      expect(server.close).toHaveBeenCalledTimes(1)
      await expect(authentication).rejects.toThrow(
        'Garmin authentication is already being saved; completion is unknown',
      )
    } finally {
      saveGate.resolve()
      await settle()
      jest.useRealTimers()
    }
  })

  it('rejects unsafe controller URLs before passing them to a browser', async () => {
    const controller = controllerFixture()
    controller.begin.mockResolvedValue({
      success: true,
      flowId: FLOW_ID,
      bridgeUrl: `https://attacker.example/garmin-auth/bridge/${FLOW_ID}`,
      expiresAt: 1_900_000_000_000,
    })
    const openBrowser = jest.fn()
    const broker = new LocalAuthBroker({ controller, openBrowser })

    await expect(broker.authenticateInSystemBrowser('cn')).rejects.toThrow(
      'Garmin browser authentication is unavailable',
    )
    expect(openBrowser).not.toHaveBeenCalled()
    expect(controller.close).toHaveBeenCalledTimes(1)
  })
})

describe('system browser opener', () => {
  function spawnFixture(exitCode = 0) {
    const child = new EventEmitter() as ChildProcess
    child.unref = jest.fn()
    const spawn = jest.fn(() => {
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('exit', exitCode, null)
      })
      return child
    })
    return { child, spawn }
  }

  it.each([
    ['darwin', '/usr/bin/open', [BRIDGE_URL]],
    ['linux', 'xdg-open', [BRIDGE_URL]],
  ])('uses a shell-free %s launcher', async (platform, command, args) => {
    const { child, spawn } = spawnFixture()

    await expect(openLoopbackAuthInSystemBrowser(BRIDGE_URL, {
      platform,
      spawn: spawn as never,
    })).resolves.toBeUndefined()

    expect(spawn).toHaveBeenCalledWith(command, args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
    })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('uses the absolute System32 browser launcher on Windows', async () => {
    const { child, spawn } = spawnFixture()

    await expect(openLoopbackAuthInSystemBrowser(BRIDGE_URL, {
      platform: 'win32',
      spawn: spawn as never,
      systemRoot: 'C:\\Windows',
    })).resolves.toBeUndefined()

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\rundll32.exe',
      ['url.dll,FileProtocolHandler', BRIDGE_URL],
      {
        detached: true,
        shell: false,
        stdio: 'ignore',
      },
    )
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('reports a launcher that spawns but exits non-zero as a browser-open failure', async () => {
    const { child, spawn } = spawnFixture(3)

    await expect(openLoopbackAuthInSystemBrowser(BRIDGE_URL, {
      platform: 'linux',
      spawn: spawn as never,
    })).rejects.toThrow('The system browser could not be opened')

    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it.each([
    '',
    'Windows',
    'C:\\Windows\\..\\Temp',
    'C:\\Windows/Temp',
    'C:\\Windows\0PRIVATE',
    'C:\\Windows\\Bad|Root',
  ])('rejects an unsafe Windows SystemRoot before spawning (%s)', async (systemRoot) => {
    const { spawn } = spawnFixture()

    const operation = openLoopbackAuthInSystemBrowser(BRIDGE_URL, {
      platform: 'win32',
      spawn: spawn as never,
      systemRoot,
    })

    await expect(operation).rejects.toThrow('The system browser could not be opened')
    if (systemRoot.length > 0) {
      await expect(operation).rejects.not.toThrow(systemRoot)
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps a late launcher error from becoming an unhandled process error', async () => {
    const { child, spawn } = spawnFixture()

    await openLoopbackAuthInSystemBrowser(BRIDGE_URL, {
      platform: 'darwin',
      spawn: spawn as never,
    })

    expect(() => child.emit('error', new Error('late launcher error'))).not.toThrow()
  })

  it('rejects non-loopback and malformed bridge URLs before spawning', async () => {
    const { spawn } = spawnFixture()

    for (const url of [
      `https://attacker.example/garmin-auth/bridge/${FLOW_ID}`,
      `http://127.0.0.1:43127/other/${FLOW_ID}`,
      `http://127.0.0.1:43127/garmin-auth/bridge/${FLOW_ID}?secret=1`,
    ]) {
      await expect(openLoopbackAuthInSystemBrowser(url, {
        platform: 'darwin',
        spawn: spawn as never,
      })).rejects.toThrow('The system browser could not be opened')
    }
    expect(spawn).not.toHaveBeenCalled()
  })
})
