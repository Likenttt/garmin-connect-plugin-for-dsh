import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  createCdpBrowserLauncher,
  type CdpBrowserLauncherOptions,
} from '../src/cdp-browser'

const BRIDGE_URL = `http://127.0.0.1:39999/garmin-auth/bridge/${'a'.repeat(64)}`
const BROWSER_PATH = '/opt/test-chromium'
const PROFILE_DIRECTORY = '/tmp/garmin-connect-owned-profile'
const CDP_PORT = 43_123

type FakeChild = ChildProcess & {
  kill: jest.Mock<boolean, [NodeJS.Signals?]>
}
type SpawnFunction = NonNullable<CdpBrowserLauncherOptions['spawn']>

function setChildExit(
  child: ChildProcess,
  exitCode: number | null,
  signalCode: NodeJS.Signals | null,
): void {
  const mutable = child as unknown as {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }
  mutable.exitCode = exitCode
  mutable.signalCode = signalCode
}

function fakeChild(pid = 8_421): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  Object.assign(child, { pid, exitCode: null, signalCode: null })
  child.kill = jest.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    setChildExit(child, null, signal)
    child.emit('exit', null, signal)
    return true
  })
  return child
}

function fakeBrowser() {
  const events = new EventEmitter()
  return {
    on: jest.fn((event: 'disconnected', listener: () => void) => {
      events.on(event, listener)
    }),
    off: jest.fn((event: 'disconnected', listener: () => void) => {
      events.off(event, listener)
    }),
    close: jest.fn(async () => undefined),
    disconnect: (): void => { events.emit('disconnected') },
  }
}

function versionResponse(
  webSocketDebuggerUrl: string,
  overrides: Partial<{
    ok: boolean
    redirected: boolean
    status: number
    url: string
    contentLength: string | null
  }> = {},
): Response {
  const body = JSON.stringify({ webSocketDebuggerUrl })
  return {
    ok: overrides.ok ?? true,
    redirected: overrides.redirected ?? false,
    status: overrides.status ?? 200,
    url: overrides.url ?? '',
    headers: {
      get: jest.fn((name: string) => name.toLowerCase() === 'content-length'
        ? (overrides.contentLength ?? String(Buffer.byteLength(body, 'utf8')))
        : null),
    },
    text: jest.fn(async () => body),
    body: null,
  } as unknown as Response
}

function launcherFixture(
  webSocketDebuggerUrl = `ws://127.0.0.1:${CDP_PORT}/devtools/browser/test-id`,
) {
  const child = fakeChild()
  const browser = fakeBrowser()
  const connectOverCDP = jest.fn(async () => browser)
  const spawn = jest.fn<ReturnType<SpawnFunction>, Parameters<SpawnFunction>>(
    () => child,
  )
  const removeProfileDirectory = jest.fn(async () => undefined)
  const createProfileDirectory = jest.fn(async () => PROFILE_DIRECTORY)
  const fetch = jest.fn(async () => versionResponse(webSocketDebuggerUrl))
  const options: CdpBrowserLauncherOptions = {
    browserPath: BROWSER_PATH,
    env: {
      PATH: '/usr/bin',
      HOME: '/home/test-user',
      LANG: 'en_US.UTF-8',
      GARMIN_PASSWORD: 'must-not-reach-browser',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-browser',
      NODE_OPTIONS: '--require=/tmp/untrusted.js',
    },
    platform: 'linux',
    exists: candidate => candidate === BROWSER_PATH,
    spawn,
    fetch: fetch as unknown as typeof globalThis.fetch,
    loadPlaywright: () => ({ chromium: { connectOverCDP } }),
    allocatePort: async () => CDP_PORT,
    createProfileDirectory,
    removeProfileDirectory,
    sleep: async () => undefined,
    startupTimeoutMs: 1_000,
  }
  return {
    browser,
    child,
    connectOverCDP,
    createProfileDirectory,
    fetch,
    options,
    removeProfileDirectory,
    spawn,
  }
}

describe('CDP browser launcher', () => {
  it.each([
    `https://127.0.0.1:39999/garmin-auth/bridge/${'a'.repeat(64)}`,
    `http://localhost:39999/garmin-auth/bridge/${'a'.repeat(64)}`,
    `http://127.1:39999/garmin-auth/bridge/${'a'.repeat(64)}`,
    `http://127.0.0.1/garmin-auth/bridge/${'a'.repeat(64)}`,
    `http://127.0.0.1:039999/garmin-auth/bridge/${'a'.repeat(64)}`,
    `http://user@127.0.0.1:39999/garmin-auth/bridge/${'a'.repeat(64)}`,
    `http://127.0.0.1:39999/garmin-auth/bridge/${'a'.repeat(64)}?flow=secret`,
    `http://127.0.0.1:39999/garmin-auth/bridge/${'a'.repeat(64)}#secret`,
    `http://127.0.0.1:39999/garmin-auth/other/${'a'.repeat(64)}`,
    `http://127.0.0.1:65536/garmin-auth/bridge/${'a'.repeat(64)}`,
    `http://127.0.0.1:39999/garmin-auth/bridge/${'g'.repeat(64)}`,
  ])('rejects an unsafe bridge before creating or spawning anything: %s', async url => {
    const fixture = launcherFixture()
    const launcher = createCdpBrowserLauncher(fixture.options)

    await expect(launcher.open(url)).rejects.toMatchObject({
      name: 'BrowserCanaryControlError',
      code: 'BROWSER_UNAVAILABLE',
    })
    expect(fixture.createProfileDirectory).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('spawns Chromium with a private profile, minimal environment, and safe flags', async () => {
    const fixture = launcherFixture()
    const session = await createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)

    expect(fixture.spawn).toHaveBeenCalledTimes(1)
    const [command, args, spawnOptions] = fixture.spawn.mock.calls[0]
    expect(command).toBe(BROWSER_PATH)
    expect(args).toEqual(expect.arrayContaining([
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIRECTORY}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-save-password-bubble',
      BRIDGE_URL,
    ]))
    expect(args.some((argument: string) => argument === '--disable-web-security'
      || argument === '--ignore-certificate-errors'
      || argument.startsWith('--remote-allow-origins'))).toBe(false)
    expect(spawnOptions).toEqual({
      env: {
        HOME: '/home/test-user',
        LANG: 'en_US.UTF-8',
        PATH: '/usr/bin',
      },
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    expect(JSON.stringify(spawnOptions)).not.toMatch(
      /GARMIN_PASSWORD|AWS_SECRET_ACCESS_KEY|NODE_OPTIONS|must-not-reach-browser/,
    )
    expect(fixture.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:${CDP_PORT}/json/version`,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }),
    )
    expect(fixture.connectOverCDP).toHaveBeenCalledWith(
      `ws://127.0.0.1:${CDP_PORT}/devtools/browser/test-id`,
      { timeout: 1_000 },
    )

    await Promise.all([session.close(), session.close()])
    await session.closed
    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
    expect(fixture.child.kill).toHaveBeenCalledTimes(1)
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fixture.removeProfileDirectory).toHaveBeenCalledTimes(1)
    expect(fixture.removeProfileDirectory).toHaveBeenCalledWith(PROFILE_DIRECTORY)
  })

  it.each([
    `wss://127.0.0.1:${CDP_PORT}/devtools/browser/test-id`,
    `ws://localhost:${CDP_PORT}/devtools/browser/test-id`,
    `ws://127.1:${CDP_PORT}/devtools/browser/test-id`,
    `ws://127.0.0.1:${CDP_PORT + 1}/devtools/browser/test-id`,
    `ws://user@127.0.0.1:${CDP_PORT}/devtools/browser/test-id`,
    `ws://127.0.0.1:${CDP_PORT}/devtools/browser/test-id?token=secret`,
    `ws://127.0.0.1:${CDP_PORT}/devtools/browser/test-id#secret`,
    `ws://127.0.0.1:${CDP_PORT}/devtools/page/test-id`,
    `ws://127.0.0.1:0${CDP_PORT}/devtools/browser/test-id`,
    `ws://127.0.0.1:${CDP_PORT}/devtools/browser/.`,
    `ws://127.0.0.1:${CDP_PORT}/devtools/browser/..`,
  ])('rejects an unsafe DevTools websocket and cleans owned resources: %s', async ws => {
    const fixture = launcherFixture(ws)

    await expect(createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(fixture.connectOverCDP).not.toHaveBeenCalled()
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fixture.removeProfileDirectory).toHaveBeenCalledWith(PROFILE_DIRECTORY)
  })

  it('rejects redirects and oversized version responses before connecting', async () => {
    const redirected = launcherFixture()
    redirected.options.fetch = jest.fn(async () => versionResponse(
      `ws://127.0.0.1:${CDP_PORT}/devtools/browser/test-id`,
      { status: 302, ok: false, redirected: true },
    )) as unknown as typeof globalThis.fetch

    await expect(createCdpBrowserLauncher(redirected.options).open(BRIDGE_URL))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(redirected.connectOverCDP).not.toHaveBeenCalled()
    expect(redirected.removeProfileDirectory).toHaveBeenCalledTimes(1)

    const oversized = launcherFixture()
    oversized.options.fetch = jest.fn(async () => versionResponse(
      `ws://127.0.0.1:${CDP_PORT}/devtools/browser/test-id`,
      { contentLength: String(64 * 1024 + 1) },
    )) as unknown as typeof globalThis.fetch

    await expect(createCdpBrowserLauncher(oversized.options).open(BRIDGE_URL))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(oversized.connectOverCDP).not.toHaveBeenCalled()
    expect(oversized.removeProfileDirectory).toHaveBeenCalledTimes(1)

    const oversizedStream = launcherFixture()
    oversizedStream.options.fetch = jest.fn(async () => new Response(
      'x'.repeat(64 * 1024 + 1),
      { status: 200 },
    )) as unknown as typeof globalThis.fetch

    await expect(createCdpBrowserLauncher(oversizedStream.options).open(BRIDGE_URL))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(oversizedStream.connectOverCDP).not.toHaveBeenCalled()
    expect(oversizedStream.removeProfileDirectory).toHaveBeenCalledTimes(1)
  })

  it('returns BROWSER_UNAVAILABLE without spawning when no Chromium is installed', async () => {
    const spawn = jest.fn()
    const createProfileDirectory = jest.fn(async () => PROFILE_DIRECTORY)
    const launcher = createCdpBrowserLauncher({
      platform: 'linux',
      exists: () => false,
      which: () => undefined,
      spawn: spawn as unknown as NonNullable<CdpBrowserLauncherOptions['spawn']>,
      loadPlaywright: () => ({
        chromium: { connectOverCDP: jest.fn() },
      }),
      createProfileDirectory,
    })

    await expect(launcher.open(BRIDGE_URL)).rejects.toMatchObject({
      code: 'BROWSER_UNAVAILABLE',
    })
    expect(createProfileDirectory).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('auto-discovers an installed Linux Chromium binary', async () => {
    const fixture = launcherFixture()
    delete fixture.options.browserPath
    fixture.options.exists = candidate => candidate === '/usr/bin/chromium'

    const session = await createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)
    expect(fixture.spawn.mock.calls[0][0]).toBe('/usr/bin/chromium')
    await session.close()
  })

  it('auto-discovers a per-user macOS Chromium app', async () => {
    const fixture = launcherFixture()
    const expected = '/Users/runner/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    delete fixture.options.browserPath
    fixture.options.platform = 'darwin'
    fixture.options.env = { HOME: '/Users/runner', PATH: '/usr/bin' }
    fixture.options.exists = candidate => candidate === expected

    const session = await createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)
    expect(fixture.spawn.mock.calls[0][0]).toBe(expected)
    await session.close()
  })

  it('ignores relative macOS HOME and Linux PATH entries during discovery', async () => {
    const mac = launcherFixture()
    delete mac.options.browserPath
    mac.options.platform = 'darwin'
    mac.options.env = { HOME: 'relative-home' }
    const macExists = jest.fn((candidate: string) => candidate.startsWith('relative-home/'))
    mac.options.exists = macExists

    await expect(createCdpBrowserLauncher(mac.options).open(BRIDGE_URL))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(macExists.mock.calls.every(([candidate]) => candidate.startsWith('/'))).toBe(true)
    expect(mac.spawn).not.toHaveBeenCalled()

    const linux = launcherFixture()
    delete linux.options.browserPath
    linux.options.env = { PATH: 'relative-bin:.:/missing' }
    const linuxExists = jest.fn((candidate: string) => candidate.startsWith('relative-bin/'))
    linux.options.exists = linuxExists

    await expect(createCdpBrowserLauncher(linux.options).open(BRIDGE_URL))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(linuxExists.mock.calls.every(([candidate]) => candidate.startsWith('/'))).toBe(true)
    expect(linux.spawn).not.toHaveBeenCalled()
  })

  it('auto-discovers Windows Chromium and taskkills only its owned PID', async () => {
    const fixture = launcherFixture()
    const browserPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const profilePath = 'C:\\Users\\runner\\AppData\\Local\\owned-cdp-profile'
    const taskkillPath = 'C:\\Windows\\System32\\taskkill.exe'
    const killer = fakeChild(9_999)
    setChildExit(killer, 0, null)
    const spawn = jest.fn<ReturnType<SpawnFunction>, Parameters<SpawnFunction>>(
      (command, args) => {
        if (command === taskkillPath) {
          expect(args).toEqual(['/pid', String(fixture.child.pid), '/T', '/F'])
          setChildExit(fixture.child, 0, null)
          return killer
        }
        return fixture.child
      },
    )
    delete fixture.options.browserPath
    fixture.options.platform = 'win32'
    fixture.options.env = {
      PROGRAMFILES: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local',
      SystemRoot: 'C:\\Windows',
    }
    fixture.options.exists = candidate => candidate === browserPath
      || candidate === taskkillPath
    fixture.options.spawn = spawn
    fixture.options.createProfileDirectory = async () => profilePath

    const session = await createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)
    expect(spawn.mock.calls[0][0]).toBe(browserPath)
    await session.close()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1][0]).toBe(taskkillPath)
    expect(fixture.child.kill).not.toHaveBeenCalled()
    expect(fixture.removeProfileDirectory).toHaveBeenCalledWith(profilePath)
  })

  it('never resolves taskkill through an unsafe Windows system root', async () => {
    const fixture = launcherFixture()
    fixture.options.platform = 'win32'
    fixture.options.browserPath = 'C:\\Program Files\\Chromium\\chrome.exe'
    fixture.options.env = { SystemRoot: 'C:\\Windows\\..\\attacker' }
    fixture.options.exists = () => true
    fixture.options.createProfileDirectory = async () => (
      'C:\\Users\\runner\\AppData\\Local\\owned-cdp-profile'
    )

    const session = await createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)
    await session.close()
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('returns DRIVER_UNAVAILABLE before creating a profile when Playwright is missing', async () => {
    const fixture = launcherFixture()
    fixture.options.loadPlaywright = () => { throw new Error('private module path') }

    await expect(createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL))
      .rejects.toMatchObject({
        name: 'BrowserCanaryControlError',
        code: 'DRIVER_UNAVAILABLE',
      })
    expect(fixture.createProfileDirectory).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('cancels startup and removes only the profile and process it created', async () => {
    const fixture = launcherFixture()
    const controller = new AbortController()
    fixture.options.spawn = jest.fn(() => {
      queueMicrotask(() => controller.abort())
      return fixture.child
    }) as unknown as NonNullable<CdpBrowserLauncherOptions['spawn']>
    fixture.options.fetch = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      const rejectAbort = (): void => reject(signal?.reason ?? new Error('aborted'))
      if (signal?.aborted) rejectAbort()
      else signal?.addEventListener('abort', rejectAbort, { once: true })
    })) as unknown as typeof globalThis.fetch

    await expect(createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL, controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fixture.connectOverCDP).not.toHaveBeenCalled()
    expect(fixture.child.kill).toHaveBeenCalledTimes(1)
    expect(fixture.removeProfileDirectory).toHaveBeenCalledTimes(1)
    expect(fixture.removeProfileDirectory).toHaveBeenCalledWith(PROFILE_DIRECTORY)
  })

  it('reports cancellation, not timeout, when aborted during CDP connection', async () => {
    const fixture = launcherFixture()
    const controller = new AbortController()
    const connectOverCDP = jest.fn(() => {
      queueMicrotask(() => controller.abort())
      return new Promise<never>(() => undefined)
    })
    fixture.options.loadPlaywright = () => ({ chromium: { connectOverCDP } })

    await expect(createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL, controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(connectOverCDP).toHaveBeenCalledTimes(1)
    expect(fixture.child.kill).toHaveBeenCalledTimes(1)
    expect(fixture.removeProfileDirectory).toHaveBeenCalledTimes(1)
  })

  it('cleans a private profile that finishes creating after cancellation', async () => {
    const fixture = launcherFixture()
    const controller = new AbortController()
    let resolveProfile!: (directory: string) => void
    fixture.options.createProfileDirectory = () => new Promise(resolve => {
      resolveProfile = resolve
    })

    const opening = createCdpBrowserLauncher(fixture.options)
      .open(BRIDGE_URL, controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fixture.spawn).not.toHaveBeenCalled()

    resolveProfile(PROFILE_DIRECTORY)
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.removeProfileDirectory).toHaveBeenCalledWith(PROFILE_DIRECTORY)
  })

  it('observes owned-process exit during CDP connect and closes a late connection', async () => {
    const fixture = launcherFixture()
    let resolveConnect!: (browser: ReturnType<typeof fakeBrowser>) => void
    const connectOverCDP = jest.fn(() => new Promise<ReturnType<typeof fakeBrowser>>(resolve => {
      resolveConnect = resolve
    }))
    fixture.options.loadPlaywright = () => ({ chromium: { connectOverCDP } })

    const opening = createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)
    for (let attempt = 0; attempt < 10 && connectOverCDP.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }
    expect(connectOverCDP).toHaveBeenCalledTimes(1)
    setChildExit(fixture.child, 1, null)
    fixture.child.emit('exit', 1, null)

    await expect(opening).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(fixture.removeProfileDirectory).toHaveBeenCalledTimes(1)

    resolveConnect(fixture.browser)
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
  })

  it('closes immediately when the process exited just before session handoff', async () => {
    const fixture = launcherFixture()
    const connectOverCDP = jest.fn(async () => {
      setChildExit(fixture.child, 1, null)
      return fixture.browser
    })
    fixture.options.loadPlaywright = () => ({ chromium: { connectOverCDP } })

    const session = await createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)
    await session.closed
    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
    expect(fixture.removeProfileDirectory).toHaveBeenCalledTimes(1)
  })

  it('settles closed after the owned browser process exits without killing another process', async () => {
    const fixture = launcherFixture()
    const session = await createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)

    setChildExit(fixture.child, 0, null)
    fixture.child.emit('exit', 0, null)
    await session.closed

    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
    expect(fixture.child.kill).not.toHaveBeenCalled()
    expect(fixture.removeProfileDirectory).toHaveBeenCalledTimes(1)
  })

  it('settles closed after a browser disconnect and terminates its owned process', async () => {
    const fixture = launcherFixture()
    const session = await createCdpBrowserLauncher(fixture.options).open(BRIDGE_URL)

    fixture.browser.disconnect()
    await session.closed

    expect(fixture.browser.close).toHaveBeenCalledTimes(1)
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fixture.removeProfileDirectory).toHaveBeenCalledTimes(1)
  })
})
