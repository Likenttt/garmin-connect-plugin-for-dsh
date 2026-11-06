import { spawn as spawnChildProcess, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'
import type { GarminRegion } from './config'
import {
  reportAuthDiagnostic,
  type AuthDiagnosticReporter,
} from './auth-diagnostics'
import {
  BrowserCanaryControlError,
} from './browser-auth-canary'
import type {
  EmbeddedAuthBeginResult,
  EmbeddedAuthCancelResult,
  EmbeddedAuthStatusResult,
} from './embedded-auth-controller'
import type { EmbeddedAuthPublicState } from './embedded-auth-flow'
import { PublicToolError } from './utils/errors'

const FLOW_ID_PATTERN = /^[a-f0-9]{64}$/
const DEFAULT_POLL_INTERVAL_MS = 300
const DEFAULT_SUCCESS_GRACE_MS = 2_000
const DEFAULT_COMMIT_DRAIN_TIMEOUT_MS = 30_000
const BROWSER_LAUNCH_OBSERVATION_MS = 750
const COMMIT_OUTCOME_UNKNOWN_MESSAGE =
  'Garmin authentication is already being saved; completion is unknown. Wait before retrying.'

export interface LocalAuthBrokerController {
  begin(
    signal?: AbortSignal,
    requestedRegion?: GarminRegion,
  ): Promise<EmbeddedAuthBeginResult>
  status(payload: unknown): EmbeddedAuthStatusResult
  cancel(payload: unknown): EmbeddedAuthCancelResult
  close(): Promise<void>
}

export interface LocalAuthBrokerOptions {
  controller: LocalAuthBrokerController
  diagnostics?: AuthDiagnosticReporter
  openBrowser?: (url: string) => Promise<void>
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs?: number
  successGraceMs?: number
  commitDrainTimeoutMs?: number
  now?: () => number
}

export interface LocalAuthBeginResult {
  url: string
  expiresAt: number
}

export interface LocalAuthSuccessResult {
  success: true
  region: GarminRegion
}

interface ActiveFlow extends LocalAuthBeginResult {
  flowId: string
  terminal?: EmbeddedAuthPublicState
  commitPending?: boolean
}

/**
 * Own one local browser-authentication lifecycle without exposing its ticket,
 * token, account, or session path. CLI and MCP adapters may choose who opens
 * the returned loopback URL, but only this broker polls the coarse Host state.
 */
export class LocalAuthBroker {
  private readonly controller: LocalAuthBrokerController
  private readonly diagnostics?: AuthDiagnosticReporter
  private readonly openBrowser: (url: string) => Promise<void>
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly successGraceMs: number
  private readonly commitDrainTimeoutMs: number
  private readonly now: () => number
  private readonly closeController = new AbortController()
  private commitDrain?: Promise<EmbeddedAuthPublicState>
  private controllerClose?: Promise<void>
  private closeOperation?: Promise<void>
  private active?: ActiveFlow
  private closed = false

  constructor(options: LocalAuthBrokerOptions) {
    if (!options || !isController(options.controller)) {
      throw unavailableError()
    }
    this.controller = options.controller
    this.diagnostics = options.diagnostics
    this.openBrowser = options.openBrowser ?? openLoopbackAuthInSystemBrowser
    this.sleep = options.sleep ?? abortableSleep
    this.pollIntervalMs = boundedDelay(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      50,
      5_000,
    )
    this.successGraceMs = boundedDelay(
      options.successGraceMs,
      DEFAULT_SUCCESS_GRACE_MS,
      0,
      10_000,
    )
    this.commitDrainTimeoutMs = boundedDelay(
      options.commitDrainTimeoutMs,
      DEFAULT_COMMIT_DRAIN_TIMEOUT_MS,
      100,
      60_000,
    )
    this.now = options.now ?? Date.now
  }

  async begin(
    region: GarminRegion,
    signal?: AbortSignal,
  ): Promise<LocalAuthBeginResult> {
    if (isAborted(signal)) {
      throw new BrowserCanaryControlError('CANCELLED')
    }
    if (this.closed || this.active) {
      throw unavailableError()
    }

    try {
      const started = await this.controller.begin(signal, region)
      if (isAborted(signal)) {
        if (started.success && FLOW_ID_PATTERN.test(started.flowId)) {
          try {
            this.controller.cancel({ flowId: started.flowId })
          } catch {
            // Cancellation is best effort at this already-aborted boundary.
          }
        }
        throw new BrowserCanaryControlError('CANCELLED')
      }
      if (
        !started.success
        || !isSafeBridgeUrl(started.bridgeUrl, started.flowId)
        || !Number.isSafeInteger(started.expiresAt)
        || started.expiresAt <= 0
      ) {
        throw unavailableError()
      }
      this.active = {
        flowId: started.flowId,
        url: started.bridgeUrl,
        expiresAt: started.expiresAt,
      }
      return { url: started.bridgeUrl, expiresAt: started.expiresAt }
    } catch (error) {
      await this.close()
      if (error instanceof PublicToolError) throw error
      throw unavailableError()
    }
  }

  async wait(signal?: AbortSignal): Promise<EmbeddedAuthPublicState> {
    const active = this.active
    if (!active) throw unavailableError()
    if (this.closed) {
      if (active.terminal) return active.terminal
      if (active.commitPending) return this.drainCommittedFlow(active)
      throw unavailableError()
    }
    if (active.terminal) return active.terminal
    const waitController = new AbortController()
    const abortWait = (): void => waitController.abort()
    signal?.addEventListener('abort', abortWait, { once: true })
    this.closeController.signal.addEventListener('abort', abortWait, { once: true })
    if (isAborted(signal) || this.closed) abortWait()

    try {
      for (;;) {
        if (this.closed) {
          if (active.terminal) return active.terminal
          if (active.commitPending) return this.drainCommittedFlow(active)
          return 'cancelled'
        }
        if (isAborted(signal)) {
          if (!this.cancelActive()) return this.drainCommittedFlow(active)
          throw new BrowserCanaryControlError('CANCELLED')
        }

        let result: EmbeddedAuthStatusResult
        try {
          result = this.controller.status({ flowId: active.flowId })
        } catch {
          throw unavailableError()
        }
        if (!result.success) throw unavailableError()
        if (result.status !== 'in_progress') {
          active.terminal = result.status
          return result.status
        }

        try {
          await this.sleep(this.pollIntervalMs, waitController.signal)
        } catch (error) {
          if (this.closed) {
            if (active.terminal) return active.terminal
            if (active.commitPending) return this.drainCommittedFlow(active)
            return 'cancelled'
          }
          if (isAborted(signal)) {
            if (!this.cancelActive()) return this.drainCommittedFlow(active)
            throw new BrowserCanaryControlError('CANCELLED')
          }
          if (error instanceof BrowserCanaryControlError) throw error
          throw unavailableError()
        }
      }
    } finally {
      signal?.removeEventListener('abort', abortWait)
      this.closeController.signal.removeEventListener('abort', abortWait)
    }
  }

  async authenticateInSystemBrowser(
    region: GarminRegion,
    signal?: AbortSignal,
  ): Promise<LocalAuthSuccessResult> {
    try {
      const started = await this.begin(region, signal)
      try {
        reportAuthDiagnostic(this.diagnostics, 'system_browser_open_started')
        await this.openBrowser(started.url)
        reportAuthDiagnostic(this.diagnostics, 'system_browser_open_succeeded')
      } catch {
        reportAuthDiagnostic(
          this.diagnostics,
          'system_browser_open_failed',
          'browser_launch_failed',
        )
        this.cancelActive()
        throw new PublicToolError('The system browser could not be opened')
      }

      const state = await this.wait(signal)
      if (state === 'succeeded') {
        // The atomic session commit has already completed. Ignore subsequent
        // cancellation during this short display-only grace period.
        if (this.successGraceMs > 0) {
          await this.sleep(this.successGraceMs, undefined).catch(() => undefined)
        }
        return { success: true, region }
      }
      if (state === 'cancelled') {
        throw new BrowserCanaryControlError('CANCELLED')
      }
      if (state === 'expired') {
        throw new BrowserCanaryControlError('TIMED_OUT')
      }
      throw new PublicToolError('Garmin browser authentication failed')
    } finally {
      await this.close()
    }
  }

  cancel(): void {
    this.cancelActive()
  }

  async close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation
    this.closed = true
    const operation = this.closeOnce()
    this.closeOperation = operation
    return operation
  }

  private async closeOnce(): Promise<void> {
    const active = this.active
    const cancelled = this.cancelActive()
    this.closeController.abort()
    const drain = !cancelled && active
      ? this.drainCommittedFlow(active).catch(() => undefined)
      : Promise.resolve()
    const closeController = this.closeControllerOnce()

    // Both layers use the same commit operation but serve different callers:
    // the broker reports a coarse outcome while the controller keeps the
    // listener alive. Start their bounded drains together so their deadlines
    // cannot accumulate into a minute-long sequential shutdown.
    await Promise.all([drain, closeController])
  }

  private cancelActive(): boolean {
    const active = this.active
    if (!active || active.terminal) return true
    try {
      const result = this.controller.cancel({ flowId: active.flowId })
      if (!result.success) {
        active.commitPending = true
        void this.closeControllerOnce()
        return false
      }
    } catch {
      active.commitPending = true
      void this.closeControllerOnce()
      return false
    }
    active.terminal = 'cancelled'
    return true
  }

  private drainCommittedFlow(active: ActiveFlow): Promise<EmbeddedAuthPublicState> {
    if (active.terminal) return Promise.resolve(active.terminal)
    if (!this.commitDrain) {
      const operation = this.pollCommittedFlow(active)
      this.commitDrain = operation
      void operation.catch(() => undefined)
    }
    return this.commitDrain
  }

  private closeControllerOnce(): Promise<void> {
    this.controllerClose ??= Promise.resolve()
      .then(() => this.controller.close())
      .catch(() => undefined)
    return this.controllerClose
  }

  private async pollCommittedFlow(
    active: ActiveFlow,
  ): Promise<EmbeddedAuthPublicState> {
    let deadline: number
    try {
      deadline = this.now() + this.commitDrainTimeoutMs
    } catch {
      throw commitOutcomeUnknownError()
    }

    for (;;) {
      let result: EmbeddedAuthStatusResult
      try {
        result = this.controller.status({ flowId: active.flowId })
      } catch {
        throw commitOutcomeUnknownError()
      }
      if (!result.success) throw commitOutcomeUnknownError()
      if (result.status !== 'in_progress') {
        active.terminal = result.status
        return result.status
      }

      let remaining: number
      try {
        remaining = deadline - this.now()
      } catch {
        throw commitOutcomeUnknownError()
      }
      if (!Number.isFinite(remaining) || remaining <= 0) {
        throw commitOutcomeUnknownError()
      }
      await this.sleep(
        Math.min(this.pollIntervalMs, remaining),
        undefined,
      ).catch(() => {
        throw commitOutcomeUnknownError()
      })
    }
  }
}

type SupportedPlatform = 'darwin' | 'linux' | 'win32'
type Spawn = (
  command: string,
  args: readonly string[],
  options: {
    detached: true
    shell: false
    stdio: 'ignore'
  },
) => ChildProcess

export interface SystemBrowserOptions {
  platform?: string
  spawn?: Spawn
  systemRoot?: string
}

/** Open only a validated local Garmin bridge URL without invoking a shell. */
export async function openLoopbackAuthInSystemBrowser(
  url: string,
  options: SystemBrowserOptions = {},
): Promise<void> {
  if (!isSafeBridgeUrlWithoutExpectedFlow(url)) {
    throw new PublicToolError('The system browser could not be opened')
  }
  const platform = options.platform ?? process.platform
  const launch = browserLaunch(
    platform as SupportedPlatform,
    url,
    options.systemRoot,
  )
  if (!launch) throw new PublicToolError('The system browser could not be opened')
  const spawn = options.spawn ?? (spawnChildProcess as Spawn)

  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(launch.command, launch.args, {
        detached: true,
        shell: false,
        stdio: 'ignore',
      })
    } catch {
      reject(new PublicToolError('The system browser could not be opened'))
      return
    }
    let settled = false
    let spawned = false
    let observationTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (error?: PublicToolError): void => {
      if (settled) return
      settled = true
      if (observationTimer) clearTimeout(observationTimer)
      if (error) reject(error)
      else resolve()
    }
    const fail = (): void => settle(
      new PublicToolError('The system browser could not be opened'),
    )
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      if (!spawned || code !== 0 || signal !== null) fail()
      else settle()
    })
    child.once('spawn', () => {
      spawned = true
      child.unref()
      observationTimer = setTimeout(
        () => settle(),
        BROWSER_LAUNCH_OBSERVATION_MS,
      )
    })
  })
}

function browserLaunch(
  platform: SupportedPlatform,
  url: string,
  systemRoot?: string,
): { command: string; args: string[] } | undefined {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [url] }
  if (platform === 'linux') return { command: 'xdg-open', args: [url] }
  if (platform === 'win32') {
    const root = validatedWindowsSystemRoot(systemRoot ?? process.env.SystemRoot)
    if (!root) return undefined
    return {
      command: win32.join(root, 'System32', 'rundll32.exe'),
      args: ['url.dll,FileProtocolHandler', url],
    }
  }
  return undefined
}

function validatedWindowsSystemRoot(value: string | undefined): string | undefined {
  if (
    !value
    || value.length > 240
    || !/^[A-Za-z]:\\[^\\]/.test(value)
  ) {
    return undefined
  }

  let relative = value.slice(3)
  if (relative.endsWith('\\')) relative = relative.slice(0, -1)
  const parts = relative.split('\\')
  if (
    parts.length === 0
    || parts.some(part => (
      part.length === 0
      || part === '.'
      || part === '..'
      || part.endsWith('.')
      || part.endsWith(' ')
      || !/^[^<>:"/\\|?*\u0000-\u001f\u007f]+$/.test(part)
    ))
  ) {
    return undefined
  }

  return win32.normalize(value)
}

function isSafeBridgeUrl(value: string, flowId: string): boolean {
  return FLOW_ID_PATTERN.test(flowId)
    && isSafeBridgeUrlWithoutExpectedFlow(value, flowId)
}

function isSafeBridgeUrlWithoutExpectedFlow(
  value: unknown,
  expectedFlowId?: string,
): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  try {
    const parsed = new URL(value)
    const match = /^\/garmin-auth\/bridge\/([a-f0-9]{64})$/.exec(parsed.pathname)
    return parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && parsed.port.length > 0
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && Boolean(match)
      && (expectedFlowId === undefined || match?.[1] === expectedFlowId)
  } catch {
    return false
  }
}

function isController(value: unknown): value is LocalAuthBrokerController {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LocalAuthBrokerController>
  return typeof candidate.begin === 'function'
    && typeof candidate.status === 'function'
    && typeof candidate.cancel === 'function'
    && typeof candidate.close === 'function'
}

function boundedDelay(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && value! >= minimum && value! <= maximum
    ? value!
    : fallback
}

function isAborted(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true
  } catch {
    return true
  }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (isAborted(signal)) {
    return Promise.reject(new BrowserCanaryControlError('CANCELLED'))
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = (): void => finish(new BrowserCanaryControlError('CANCELLED'))
    const timer = setTimeout(() => finish(), milliseconds)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (isAborted(signal)) onAbort()
  })
}

function unavailableError(): PublicToolError {
  return new PublicToolError('Garmin browser authentication is unavailable')
}

function commitOutcomeUnknownError(): PublicToolError {
  return new PublicToolError(COMMIT_OUTCOME_UNKNOWN_MESSAGE)
}
