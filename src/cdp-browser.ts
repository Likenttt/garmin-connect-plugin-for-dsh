import {
  spawn as spawnChildProcess,
  type ChildProcess,
} from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserCanaryControlError } from './browser-auth-canary'
import { createWindowsPrivateAcl } from './windows-private-acl'

const BRIDGE_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/garmin-auth\/bridge\/[A-Fa-f0-9]{64}$/
const DEVTOOLS_BROWSER_URL_PATTERN = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/devtools\/browser\/([A-Za-z0-9._~-]{1,256})$/
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 2_000
const MAX_VERSION_RESPONSE_BYTES = 64 * 1024
const CLEANUP_TIMEOUT_MS = 2_000

type Environment = Readonly<Record<string, string | undefined>>

type Spawn = (
  command: string,
  args: readonly string[],
  options: {
    env: Record<string, string>
    shell: false
    stdio: 'ignore'
    windowsHide: true
  },
) => ChildProcess

interface PlaywrightCdpBrowser {
  on(event: 'disconnected', listener: () => void): void
  off?(event: 'disconnected', listener: () => void): void
  close(): Promise<void>
}

interface PlaywrightCdpModule {
  chromium: {
    connectOverCDP(
      endpoint: string,
      options?: { timeout?: number },
    ): Promise<PlaywrightCdpBrowser>
  }
}

export interface CdpBrowserSession {
  /** Settles after the owned browser and private profile have been cleaned up. */
  readonly closed: Promise<void>
  close(): Promise<void>
}

export interface CdpBrowserLauncher {
  /** Open one validated loopback bridge in a plugin-owned Chromium profile. */
  open(bridgeUrl: string, signal?: AbortSignal): Promise<CdpBrowserSession>
}

export interface CdpBrowserLauncherOptions {
  /** Internal/test override; production auto-detects an installed browser. */
  browserPath?: string
  env?: Environment
  platform?: string
  exists?: (candidate: string) => boolean
  which?: (binary: string) => string | undefined
  spawn?: Spawn
  fetch?: typeof globalThis.fetch
  loadPlaywright?: () => unknown
  allocatePort?: () => Promise<number>
  createProfileDirectory?: () => Promise<string>
  removeProfileDirectory?: (directory: string) => Promise<void>
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  startupTimeoutMs?: number
}

const MAC_BROWSERS = [
  ['Google Chrome.app', 'Google Chrome'],
  ['Microsoft Edge.app', 'Microsoft Edge'],
  ['Brave Browser.app', 'Brave Browser'],
  ['Chromium.app', 'Chromium'],
  ['Vivaldi.app', 'Vivaldi'],
  ['Arc.app', 'Arc'],
] as const

const WINDOWS_BROWSERS = [
  ['Google\\Chrome\\Application\\chrome.exe'],
  ['Microsoft\\Edge\\Application\\msedge.exe'],
  ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ['Chromium\\Application\\chrome.exe'],
  ['Vivaldi\\Application\\vivaldi.exe'],
] as const

const LINUX_BROWSERS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
  'brave-browser',
  'vivaldi',
] as const

const LINUX_ABSOLUTE_BROWSERS = [
  '/snap/bin/chromium',
  '/snap/bin/google-chrome',
  '/snap/bin/microsoft-edge',
  '/var/lib/flatpak/exports/bin/com.google.Chrome',
  '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
] as const

/**
 * CDP is used only as a controlled browser lifecycle transport. Authentication
 * still terminates at the existing loopback bridge and DI session pipeline.
 */
export function createCdpBrowserLauncher(
  options: CdpBrowserLauncherOptions = {},
): CdpBrowserLauncher {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const which = options.which
    ?? (binary => findExecutableOnPath(binary, env, exists))
  const spawn = options.spawn ?? (spawnChildProcess as Spawn)
  const request = options.fetch ?? globalThis.fetch
  const allocatePort = options.allocatePort ?? freeLoopbackPort
  const createProfileDirectory = options.createProfileDirectory
    ?? (() => createPrivateProfileDirectory(platform, env))
  const removeProfileDirectory = options.removeProfileDirectory
    ?? (directory => rm(directory, { force: true, recursive: true }))
  const sleep = options.sleep ?? abortableDelay
  const startupTimeoutMs = normalizeStartupTimeout(options.startupTimeoutMs)

  return {
    async open(bridgeUrl: string, signal?: AbortSignal): Promise<CdpBrowserSession> {
      if (!isSafeBridgeUrl(bridgeUrl)) {
        throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
      }
      if (isAborted(signal)) throw new BrowserCanaryControlError('CANCELLED')
      const playwright = requirePlaywright(options.loadPlaywright)
      const browserPath = resolveBrowserPath(
        options.browserPath,
        platform,
        env,
        exists,
        which,
      )
      if (!browserPath) throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')

      let profileDirectory: string | undefined
      let child: ChildProcess | undefined
      let browser: PlaywrightCdpBrowser | undefined
      let childStopped: ReturnType<typeof monitorChildBeforeConnection> | undefined
      const startupController = new AbortController()
      const timeout = setTimeout(() => startupController.abort(), startupTimeoutMs)
      timeout.unref?.()
      const abortStartup = (): void => startupController.abort()
      signal?.addEventListener('abort', abortStartup, { once: true })

      try {
        const createdProfileDirectory = await waitForOwnedProfile(
          createProfileDirectory(),
          startupController.signal,
          platform,
          removeProfileDirectory,
        )
        if (!isAbsolutePrivateProfilePath(createdProfileDirectory, platform)) {
          throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
        }
        profileDirectory = createdProfileDirectory
        if (isAborted(signal)) throw new BrowserCanaryControlError('CANCELLED')
        if (startupController.signal.aborted) {
          throw new BrowserCanaryControlError('TIMED_OUT')
        }
        const port = await raceWithAbort(
          allocatePort(),
          startupController.signal,
        )
        if (!isLoopbackPort(port)) {
          throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
        }
        if (isAborted(signal)) throw new BrowserCanaryControlError('CANCELLED')
        if (startupController.signal.aborted) {
          throw new BrowserCanaryControlError('TIMED_OUT')
        }

        child = spawn(browserPath, browserArguments(
          port,
          profileDirectory,
          bridgeUrl,
        ), {
          env: safeBrowserEnvironment(env),
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        })
        childStopped = monitorChildBeforeConnection(child)
        const wsUrl = await Promise.race([
          waitForDevTools(port, request, sleep, startupController.signal),
          childStopped.promise,
        ])
        if (isAborted(signal)) throw new BrowserCanaryControlError('CANCELLED')
        if (startupController.signal.aborted) {
          throw new BrowserCanaryControlError('TIMED_OUT')
        }
        browser = await connectOwnedBrowser(
          playwright.chromium.connectOverCDP(wsUrl, {
            timeout: Math.min(startupTimeoutMs, 10_000),
          }),
          startupController.signal,
          childStopped.promise,
        )
        if (isAborted(signal)) throw new BrowserCanaryControlError('CANCELLED')
        if (startupController.signal.aborted) {
          throw new BrowserCanaryControlError('TIMED_OUT')
        }

        const session = new OwnedCdpBrowserSession({
          browser,
          child,
          platform,
          profileDirectory,
          removeProfileDirectory,
          spawn,
          env,
          exists,
        })
        childStopped.dispose()
        browser = undefined
        child = undefined
        profileDirectory = undefined
        return session
      } catch (error) {
        await closeBrowserQuietly(browser)
        await terminateOwnedBrowser(child, platform, spawn, env, exists)
        if (profileDirectory) {
          await removeProfileQuietly(removeProfileDirectory, profileDirectory)
        }
        if (isAborted(signal)) throw new BrowserCanaryControlError('CANCELLED')
        if (startupController.signal.aborted) {
          throw new BrowserCanaryControlError('TIMED_OUT')
        }
        if (error instanceof BrowserCanaryControlError) throw error
        throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
      } finally {
        childStopped?.dispose()
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abortStartup)
      }
    },
  }
}

class OwnedCdpBrowserSession implements CdpBrowserSession {
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private closing?: Promise<void>
  private readonly browser: PlaywrightCdpBrowser
  private readonly child: ChildProcess
  private readonly platform: string
  private readonly profileDirectory: string
  private readonly removeProfileDirectory: (directory: string) => Promise<void>
  private readonly spawn: Spawn
  private readonly env: Environment
  private readonly exists: (candidate: string) => boolean

  constructor(options: {
    browser: PlaywrightCdpBrowser
    child: ChildProcess
    platform: string
    profileDirectory: string
    removeProfileDirectory(directory: string): Promise<void>
    spawn: Spawn
    env: Environment
    exists(candidate: string): boolean
  }) {
    this.browser = options.browser
    this.child = options.child
    this.platform = options.platform
    this.profileDirectory = options.profileDirectory
    this.removeProfileDirectory = options.removeProfileDirectory
    this.spawn = options.spawn
    this.env = options.env
    this.exists = options.exists
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
    this.browser.on('disconnected', this.onDisconnected)
    this.child.once('exit', this.onChildExit)
    this.child.once('error', this.onChildExit)
    if (hasExited(this.child)) void this.close()
  }

  close(): Promise<void> {
    this.closing ??= this.closeOnce()
    return this.closing
  }

  private readonly onDisconnected = (): void => { void this.close() }
  private readonly onChildExit = (): void => { void this.close() }

  private async closeOnce(): Promise<void> {
    try { this.browser.off?.('disconnected', this.onDisconnected) } catch {}
    try { this.child.off('exit', this.onChildExit) } catch {}
    try { this.child.off('error', this.onChildExit) } catch {}
    try {
      await closeBrowserQuietly(this.browser)
      await terminateOwnedBrowser(
        this.child,
        this.platform,
        this.spawn,
        this.env,
        this.exists,
      )
      await removeProfileQuietly(
        this.removeProfileDirectory,
        this.profileDirectory,
      )
    } finally {
      this.resolveClosed()
    }
  }
}

function resolveBrowserPath(
  configured: string | undefined,
  platform: string,
  env: Environment,
  exists: (candidate: string) => boolean,
  which: (binary: string) => string | undefined,
): string | undefined {
  if (configured !== undefined) {
    return isAbsoluteForPlatform(configured, platform) && exists(configured)
      ? configured
      : undefined
  }

  if (platform === 'darwin') {
    const configuredHome = env.HOME?.trim()
    const userHome = configuredHome && path.posix.isAbsolute(configuredHome)
      ? configuredHome
      : homedir()
    for (const root of ['/Applications', path.posix.join(userHome, 'Applications')]) {
      for (const [bundle, binary] of MAC_BROWSERS) {
        const candidate = path.posix.join(root, bundle, 'Contents', 'MacOS', binary)
        if (path.posix.isAbsolute(candidate) && exists(candidate)) return candidate
      }
    }
    return undefined
  }

  if (platform === 'win32') {
    const roots = [
      env.PROGRAMFILES,
      env['PROGRAMFILES(X86)'],
      env.LOCALAPPDATA,
      env.PROGRAMW6432,
    ].filter((root): root is string => Boolean(root && path.win32.isAbsolute(root)))
    for (const [relative] of WINDOWS_BROWSERS) {
      for (const root of roots) {
        const candidate = path.win32.join(root, relative)
        if (exists(candidate)) return candidate
      }
    }
    return undefined
  }

  for (const binary of LINUX_BROWSERS) {
    const candidate = which(binary)
    if (candidate && path.posix.isAbsolute(candidate) && exists(candidate)) return candidate
  }
  for (const candidate of LINUX_ABSOLUTE_BROWSERS) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

function findExecutableOnPath(
  binary: string,
  env: Environment,
  exists: (candidate: string) => boolean,
): string | undefined {
  for (const entry of (env.PATH ?? '').split(path.posix.delimiter)) {
    const directory = entry.trim()
    if (!path.posix.isAbsolute(directory)) continue
    const candidate = path.posix.join(directory, binary)
    if (exists(candidate)) return candidate
  }
  return undefined
}

function browserArguments(
  port: number,
  profileDirectory: string,
  bridgeUrl: string,
): string[] {
  return [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-save-password-bubble',
    '--disable-features=Translate,PasswordManagerOnboarding,PasswordLeakDetection',
    bridgeUrl,
  ]
}

async function waitForDevTools(
  port: number,
  request: typeof globalThis.fetch,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}/json/version`
  for (;;) {
    signal.throwIfAborted()
    const requestSignal = createTimedSignal(signal, FETCH_TIMEOUT_MS)
    try {
      const response = await request(endpoint, {
        redirect: 'manual',
        signal: requestSignal.signal,
      })
      if (response.redirected || (response.url && response.url !== endpoint)) {
        cancelResponseBody(response)
        throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
      }
      if (response.status >= 300 && response.status < 400) {
        cancelResponseBody(response)
        throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
      }
      if (response.ok) {
        const declaredLength = response.headers.get('content-length')
        if (declaredLength && (!/^\d+$/.test(declaredLength)
          || Number(declaredLength) > MAX_VERSION_RESPONSE_BYTES)) {
          cancelResponseBody(response)
          throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
        }
        const text = await readBoundedResponseText(
          response,
          MAX_VERSION_RESPONSE_BYTES,
        )
        const wsUrl = parseDevToolsWebSocket(text, port)
        if (!wsUrl) throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
        return wsUrl
      }
      cancelResponseBody(response)
    } catch (error) {
      if (error instanceof BrowserCanaryControlError) throw error
      signal.throwIfAborted()
    } finally {
      requestSignal.dispose()
    }
    await sleep(250, signal)
  }
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined)
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
      throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
    }
    return text
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function parseDevToolsWebSocket(text: string, port: number): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed) || typeof parsed.webSocketDebuggerUrl !== 'string') return undefined
    const match = DEVTOOLS_BROWSER_URL_PATTERN.exec(parsed.webSocketDebuggerUrl)
    return match
      && Number(match[1]) === port
      && match[2] !== '.'
      && match[2] !== '..'
      ? parsed.webSocketDebuggerUrl
      : undefined
  } catch {
    return undefined
  }
}

async function connectOwnedBrowser(
  operation: Promise<PlaywrightCdpBrowser>,
  signal: AbortSignal,
  childStopped: Promise<never>,
): Promise<PlaywrightCdpBrowser> {
  try {
    return await Promise.race([
      raceWithAbort(operation, signal),
      childStopped,
    ])
  } catch (error) {
    // If cancellation or process exit wins the race, close any connection that
    // the optional driver resolves later instead of losing its handle.
    void operation.then(
      lateBrowser => closeBrowserQuietly(lateBrowser),
      () => undefined,
    )
    throw error
  }
}

async function waitForOwnedProfile(
  operation: Promise<string>,
  signal: AbortSignal,
  platform: string,
  removeProfileDirectory: (directory: string) => Promise<void>,
): Promise<string> {
  try {
    return await raceWithAbort(operation, signal)
  } catch (error) {
    // A Windows ACL operation can finish after cancellation. Remove only a
    // syntactically safe absolute directory returned by the owned creator.
    void operation.then(async lateDirectory => {
      if (isAbsolutePrivateProfilePath(lateDirectory, platform)) {
        await removeProfileQuietly(removeProfileDirectory, lateDirectory)
      }
    }, () => undefined)
    throw error
  }
}

function requirePlaywright(loader?: () => unknown): PlaywrightCdpModule {
  let value: unknown
  try {
    value = loader ? loader() : require('playwright-core')
  } catch {
    if (!loader) {
      try { value = require('playwright') }
      catch { throw new BrowserCanaryControlError('DRIVER_UNAVAILABLE') }
    } else {
      throw new BrowserCanaryControlError('DRIVER_UNAVAILABLE')
    }
  }
  if (!isRecord(value)
    || !isRecord(value.chromium)
    || typeof value.chromium.connectOverCDP !== 'function') {
    throw new BrowserCanaryControlError('DRIVER_UNAVAILABLE')
  }
  return value as unknown as PlaywrightCdpModule
}

async function createPrivateProfileDirectory(
  platform: string,
  env: Environment,
): Promise<string> {
  if (platform === 'win32') {
    const root = env.LOCALAPPDATA?.trim() || env.USERPROFILE?.trim()
    if (!root || !path.win32.isAbsolute(root)) {
      throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
    }
    const directory = path.win32.join(
      root,
      `garmin-connect-cdp-${randomUUID()}`,
    )
    try {
      const acl = await createWindowsPrivateAcl()
      await acl.prepareDirectory(directory)
      return directory
    } catch {
      await bounded(
        rm(directory, { force: true, recursive: true }),
        CLEANUP_TIMEOUT_MS,
      ).catch(() => undefined)
      throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
    }
  }
  let directory: string | undefined
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'garmin-connect-cdp-'))
    await chmod(directory, 0o700)
    return directory
  } catch {
    if (directory) {
      await bounded(
        rm(directory, { force: true, recursive: true }),
        CLEANUP_TIMEOUT_MS,
      ).catch(() => undefined)
    }
    throw new BrowserCanaryControlError('BROWSER_UNAVAILABLE')
  }
}

function isAbsolutePrivateProfilePath(
  value: unknown,
  platform: string,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4 * 1024
    && isAbsoluteForPlatform(value, platform)
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function isAbsoluteForPlatform(value: string, platform: string): boolean {
  return platform === 'win32'
    ? path.win32.isAbsolute(value)
    : path.posix.isAbsolute(value)
}

function isSafeBridgeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  const match = BRIDGE_URL_PATTERN.exec(value)
  return Boolean(match && isLoopbackPort(Number(match[1])))
}

function safeBrowserEnvironment(env: Environment): Record<string, string> {
  const allowed = [
    'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA',
    'LOGNAME', 'PATH', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'TZ',
    'USER', 'USERPROFILE', 'WAYLAND_DISPLAY', 'WINDIR', 'XAUTHORITY',
    'XDG_RUNTIME_DIR',
  ]
  const result: Record<string, string> = {}
  for (const key of allowed) {
    const value = env[key]
    if (value) result[key] = value
  }
  return result
}

function monitorChildBeforeConnection(child: ChildProcess): {
  promise: Promise<never>
  dispose(): void
} {
  let fail!: () => void
  const promise = new Promise<never>((_resolve, reject) => {
    fail = (): void => reject(new BrowserCanaryControlError('BROWSER_UNAVAILABLE'))
    child.once('error', fail)
    child.once('exit', fail)
  })
  return {
    promise,
    dispose(): void {
      child.off('error', fail)
      child.off('exit', fail)
    },
  }
}

async function closeBrowserQuietly(browser: PlaywrightCdpBrowser | undefined): Promise<void> {
  if (!browser) return
  try {
    await bounded(browser.close(), CLEANUP_TIMEOUT_MS).catch(() => undefined)
  } catch {
    // A malformed/failed optional driver must not prevent owned cleanup.
  }
}

async function removeProfileQuietly(
  removeProfileDirectory: (directory: string) => Promise<void>,
  profileDirectory: string,
): Promise<void> {
  try {
    await bounded(
      removeProfileDirectory(profileDirectory),
      CLEANUP_TIMEOUT_MS,
    ).catch(() => undefined)
  } catch {
    // Cleanup errors are intentionally hidden and never contain local paths.
  }
}

async function terminateOwnedBrowser(
  child: ChildProcess | undefined,
  platform: string,
  spawn: Spawn,
  env: Environment,
  exists: (candidate: string) => boolean,
): Promise<void> {
  if (!child?.pid || hasExited(child)) return
  if (platform === 'win32') {
    const taskkill = resolveWindowsTaskkill(env, exists)
    if (taskkill) {
      try {
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
          env: safeBrowserEnvironment(env),
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        })
        await waitForChild(killer, CLEANUP_TIMEOUT_MS)
      } catch {
        // Fall through to the owned process handle below.
      }
    }
    if (hasExited(child)) return
  }
  try { child.kill('SIGTERM') } catch { return }
  await waitForChild(child, 1_000)
  if (hasExited(child)) return
  try { child.kill('SIGKILL') } catch { return }
  await waitForChild(child, 500)
}

function resolveWindowsTaskkill(
  env: Environment,
  exists: (candidate: string) => boolean,
): string | undefined {
  const root = env.SystemRoot?.trim()
    || env.SYSTEMROOT?.trim()
    || env.WINDIR?.trim()
  if (!root
    || !/^[A-Za-z]:\\/.test(root)
    || /[\u0000\r\n]/.test(root)
    || root.split(/[\\/]/).some(part => part === '.' || part === '..')) {
    return undefined
  }
  const normalizedRoot = path.win32.normalize(root)
  const candidate = path.win32.join(normalizedRoot, 'System32', 'taskkill.exe')
  return exists(candidate) ? candidate : undefined
}

function waitForChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve()
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>
    const done = (): void => {
      clearTimeout(timer)
      child.off('exit', done)
      child.off('error', done)
      resolve()
    }
    child.once('exit', done)
    child.once('error', done)
    timer = setTimeout(done, timeoutMs)
    timer.unref?.()
  })
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new BrowserCanaryControlError('TIMED_OUT'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new BrowserCanaryControlError('TIMED_OUT'))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
    operation.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => {
        if (error || !isLoopbackPort(port)) reject(error ?? new Error('invalid port'))
        else resolve(port)
      })
    })
  })
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return delay(milliseconds, undefined, { signal })
}

function createTimedSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    },
  }
}

function normalizeStartupTimeout(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 1_000 && Number(value) <= 60_000
    ? Number(value)
    : DEFAULT_STARTUP_TIMEOUT_MS
}

function isLoopbackPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535
}

function isAborted(signal: AbortSignal | undefined): boolean {
  try { return signal?.aborted === true }
  catch { return true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
