import type { GarminRegion } from './config'
import type { EmbeddedAuthRuntimeConfig } from './embedded-auth-runtime'
import {
  authDiagnosticCodeFromError,
  reportAuthDiagnostic,
  type AuthDiagnosticCode,
  type AuthDiagnosticEvent,
  type AuthDiagnosticReporter,
} from './auth-diagnostics'
import type {
  EmbeddedAuthFlowManager,
  EmbeddedAuthPublicState,
} from './embedded-auth-flow'
import type { EmbeddedAuthServer } from './embedded-auth-server'
import { isExactLoopbackOrigin } from './embedded-auth-url'
import type { CdpBrowserLauncher, CdpBrowserSession } from './cdp-browser'

const MAX_USERNAME_LENGTH = 320
const MAX_SESSION_TOKEN_PATH_LENGTH = 4 * 1024
const FLOW_ID_PATTERN = /^[a-f0-9]{64}$/
const CSRF_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/
const DEFAULT_COMMIT_DRAIN_TIMEOUT_MS = 30_000
const MAX_COMMIT_DRAIN_TIMEOUT_MS = 2 * 60 * 1000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export type EmbeddedAuthControllerFlowPort = Pick<
  EmbeddedAuthFlowManager,
  'start' | 'publicStatus' | 'bridgeBootstrap' | 'cancel' | 'waitForTerminal'
>

export type EmbeddedAuthControllerServerPort = Pick<
  EmbeddedAuthServer,
  'start' | 'bridgeUrl' | 'close'
>

export interface EmbeddedAuthControllerOptions extends EmbeddedAuthRuntimeConfig {
  flows: EmbeddedAuthControllerFlowPort
  server: EmbeddedAuthControllerServerPort
  prepareDestination: (path: string) => Promise<void>
  diagnostics?: AuthDiagnosticReporter
  /** Explicit, user-triggered fallback that owns an isolated Chromium process. */
  cdpBrowser?: CdpBrowserLauncher
  /** Internal clock seam for deterministic CDP expiry cleanup tests. */
  now?: () => number
  /** Internal test seam; production uses a bounded 30-second commit drain. */
  commitDrainTimeoutMs?: number
}

export type EmbeddedAuthBeginResult =
  | {
    success: true
    flowId: string
    bridgeUrl: string
    expiresAt: number
  }
  | {
    success: false
    code: 'configuration' | 'region_mismatch' | 'busy' | 'unavailable'
  }

export type EmbeddedAuthStatusResult =
  | { success: true; status: EmbeddedAuthPublicState }
  | { success: false; code: 'invalid' | 'unavailable' }

export type EmbeddedAuthCancelResult =
  | { success: true }
  | { success: false; code: 'invalid' | 'unavailable' }

type NormalizedConfiguration = EmbeddedAuthRuntimeConfig

/**
 * Host-side facade used by a DSH route (or another trusted local caller).
 *
 * It deliberately exposes only an opaque flow handle and coarse status. The
 * account, token path, Garmin ticket, CSRF, profile, and dependency errors stay
 * behind the controller boundary.
 */
export class EmbeddedAuthController {
  private readonly username: unknown
  private readonly region: unknown
  private readonly sessionTokenFile: unknown
  private readonly flows?: EmbeddedAuthControllerFlowPort
  private readonly server?: EmbeddedAuthControllerServerPort
  private readonly prepareDestination?: (path: string) => Promise<void>
  private readonly diagnostics?: AuthDiagnosticReporter
  private readonly cdpBrowser?: CdpBrowserLauncher
  private readonly now: () => number
  private readonly commitDrainTimeoutMs: number
  private currentFlowId?: string
  private bridgeOrigin?: string
  private beginning = false
  private closed = false
  private closeOperation?: Promise<void>
  private activeCdp?: {
    flowId: string
    session: CdpBrowserSession
    cleanupTimer: ReturnType<typeof setTimeout>
  }

  constructor(options: EmbeddedAuthControllerOptions) {
    this.username = options?.username
    this.region = options?.region
    this.sessionTokenFile = options?.sessionTokenFile
    this.flows = options?.flows
    this.server = options?.server
    this.prepareDestination = options?.prepareDestination
    this.diagnostics = options?.diagnostics
    this.cdpBrowser = options?.cdpBrowser
    this.now = options?.now ?? Date.now
    this.commitDrainTimeoutMs = normalizeCommitDrainTimeout(
      options?.commitDrainTimeoutMs,
    )
  }

  async begin(
    signal?: AbortSignal,
    requestedRegion?: GarminRegion,
  ): Promise<EmbeddedAuthBeginResult> {
    reportAuthDiagnostic(this.diagnostics, 'begin_started')
    const configuration = normalizeConfiguration(
      this.username,
      this.region,
      this.sessionTokenFile,
    )
    if (!configuration) {
      reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'configuration')
      return configurationFailure()
    }
    if (
      requestedRegion !== undefined
      && requestedRegion !== configuration.region
    ) {
      reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'region_mismatch')
      return regionMismatchFailure()
    }
    if (this.closed || isAborted(signal)) {
      reportAuthDiagnostic(
        this.diagnostics,
        'begin_rejected',
        isAborted(signal) ? 'cancelled' : 'unavailable',
      )
      return unavailableFailure()
    }
    if (this.beginning) {
      reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'busy')
      return busyFailure()
    }
    if (!this.flows || !this.server || !this.prepareDestination) {
      reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'unavailable')
      return unavailableFailure()
    }

    if (this.currentFlowId) {
      const currentStatus = this.readPublicStatus(this.currentFlowId)
      if (!currentStatus) {
        reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'unavailable')
        return unavailableFailure()
      }
      if (currentStatus === 'in_progress') {
        reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'busy')
        return busyFailure()
      }
      this.closeCdpBestEffort(this.currentFlowId)
    }

    this.beginning = true
    let orphanFlowId: string | undefined
    let failureEvent: AuthDiagnosticEvent = 'session_destination_prepare_failed'
    let failureCode: AuthDiagnosticCode = 'destination_prepare_failed'
    try {
      reportAuthDiagnostic(this.diagnostics, 'session_destination_prepare_started')
      await this.prepareDestination(configuration.sessionTokenFile)
      reportAuthDiagnostic(this.diagnostics, 'session_destination_prepare_succeeded')
      if (this.closed || isAborted(signal)) {
        reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'cancelled')
        return unavailableFailure()
      }

      failureEvent = 'loopback_server_start_failed'
      failureCode = 'loopback_start_failed'
      let bridgeOrigin = this.bridgeOrigin
      if (!bridgeOrigin) {
        reportAuthDiagnostic(this.diagnostics, 'loopback_server_start_started')
        bridgeOrigin = await this.server.start()
      }
      if (
        this.closed
        || isAborted(signal)
      ) {
        reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'cancelled')
        return unavailableFailure()
      }
      if (!isExactLoopbackOrigin(bridgeOrigin)) {
        reportAuthDiagnostic(
          this.diagnostics,
          'loopback_server_start_failed',
          'loopback_origin_invalid',
        )
        return unavailableFailure()
      }
      if (!this.bridgeOrigin) {
        reportAuthDiagnostic(this.diagnostics, 'loopback_server_start_succeeded')
      }
      this.bridgeOrigin = bridgeOrigin

      failureEvent = 'auth_flow_start_failed'
      failureCode = 'flow_start_failed'
      reportAuthDiagnostic(this.diagnostics, 'auth_flow_start_started')
      const started = this.flows.start({
        ...configuration,
        bridgeOrigin,
      })
      if (!isStartedFlow(started)) {
        reportAuthDiagnostic(
          this.diagnostics,
          'auth_flow_start_failed',
          'flow_start_failed',
        )
        return unavailableFailure()
      }
      reportAuthDiagnostic(this.diagnostics, 'auth_flow_start_succeeded')
      orphanFlowId = started.flowId

      if (this.closed || isAborted(signal)) {
        this.cancelBestEffort(orphanFlowId)
        reportAuthDiagnostic(this.diagnostics, 'begin_rejected', 'cancelled')
        return unavailableFailure()
      }

      failureEvent = 'bridge_url_validation_failed'
      failureCode = 'bridge_url_invalid'
      const bridgeUrl = this.server.bridgeUrl(started.flowId)
      if (!isSafeBridgeUrl(bridgeUrl, bridgeOrigin, started.flowId)) {
        this.cancelBestEffort(orphanFlowId)
        reportAuthDiagnostic(
          this.diagnostics,
          'bridge_url_validation_failed',
          'bridge_url_invalid',
        )
        return unavailableFailure()
      }

      this.currentFlowId = started.flowId
      orphanFlowId = undefined
      return {
        success: true,
        flowId: started.flowId,
        bridgeUrl,
        expiresAt: started.expiresAt,
      }
    } catch (error) {
      if (orphanFlowId) this.cancelBestEffort(orphanFlowId)
      reportAuthDiagnostic(
        this.diagnostics,
        failureEvent,
        authDiagnosticCodeFromError(error, failureCode),
      )
      return unavailableFailure()
    } finally {
      this.beginning = false
    }
  }

  /** Start the same trusted bridge in an owned, isolated Chromium CDP session. */
  async beginCdp(
    signal?: AbortSignal,
    requestedRegion?: GarminRegion,
  ): Promise<EmbeddedAuthBeginResult> {
    if (!this.cdpBrowser) {
      reportAuthDiagnostic(
        this.diagnostics,
        'cdp_browser_open_failed',
        'browser_launch_failed',
      )
      return unavailableFailure()
    }

    const started = await this.begin(signal, requestedRegion)
    if (!started.success) return started
    reportAuthDiagnostic(this.diagnostics, 'cdp_browser_open_started')
    let session: CdpBrowserSession | undefined
    try {
      session = await this.cdpBrowser.open(started.bridgeUrl, signal)
      if (
        this.closed
        || isAborted(signal)
        || this.currentFlowId !== started.flowId
        || this.readPublicStatus(started.flowId) !== 'in_progress'
      ) {
        await session.close().catch(() => undefined)
        this.cancelBestEffort(started.flowId)
        reportAuthDiagnostic(
          this.diagnostics,
          'cdp_browser_open_failed',
          'cancelled',
        )
        return unavailableFailure()
      }
      const cleanupTimer = setTimeout(
        () => this.handleCdpExpiry(started.flowId, session!),
        this.cdpCleanupDelay(started.expiresAt),
      )
      cleanupTimer.unref?.()
      this.activeCdp = { flowId: started.flowId, session, cleanupTimer }
      reportAuthDiagnostic(this.diagnostics, 'cdp_browser_open_succeeded')
      void Promise.resolve(session.closed).then(
        () => this.handleCdpClosed(started.flowId, session!),
        () => this.handleCdpClosed(started.flowId, session!),
      )
      return started
    } catch (error) {
      if (session) await session.close().catch(() => undefined)
      this.cancelBestEffort(started.flowId)
      reportAuthDiagnostic(
        this.diagnostics,
        'cdp_browser_open_failed',
        cdpDiagnosticCodeFromError(error),
      )
      return unavailableFailure()
    }
  }

  status(payload: unknown): EmbeddedAuthStatusResult {
    const flowId = exactCurrentFlowId(payload, this.currentFlowId)
    if (!flowId) return invalidFailure()

    const status = this.readPublicStatus(flowId)
    if (!status) return unavailableFailure()
    if (status !== 'in_progress') this.closeCdpBestEffort(flowId)
    return { success: true, status }
  }

  cancel(payload: unknown): EmbeddedAuthCancelResult {
    const flowId = exactCurrentFlowId(payload, this.currentFlowId)
    if (!flowId) return invalidFailure()
    this.closeCdpBestEffort(flowId)
    if (!this.flows) return unavailableFailure()

    try {
      const bootstrap = this.flows.bridgeBootstrap(flowId)
      if (!isTrustedCsrf(bootstrap?.csrf)) return unavailableFailure()
      this.flows.cancel(flowId, bootstrap.csrf)
      return { success: true }
    } catch {
      return unavailableFailure()
    }
  }

  close(): Promise<void> {
    this.closed = true
    this.closeOperation ??= this.closeInternal()
    return this.closeOperation
  }

  private async closeInternal(): Promise<void> {
    const flowId = this.currentFlowId
    if (flowId && !this.cancelBestEffort(flowId)) {
      await this.drainFlowBestEffort(flowId)
    }
    await this.closeCdp(flowId)
    try {
      await this.server?.close()
    } catch {
      // Shutdown is best effort and must not surface sensitive dependency text.
    }
  }

  private handleCdpClosed(flowId: string, session: CdpBrowserSession): void {
    if (this.activeCdp?.flowId !== flowId || this.activeCdp.session !== session) return
    clearTimeout(this.activeCdp.cleanupTimer)
    this.activeCdp = undefined
    reportAuthDiagnostic(this.diagnostics, 'cdp_browser_closed')
    if (this.readPublicStatus(flowId) === 'in_progress') {
      this.cancelBestEffort(flowId)
    }
  }

  private handleCdpExpiry(flowId: string, session: CdpBrowserSession): void {
    if (this.activeCdp?.flowId !== flowId || this.activeCdp.session !== session) return
    this.cancelBestEffort(flowId)
    this.closeCdpBestEffort(flowId)
  }

  private cdpCleanupDelay(expiresAt: number): number {
    try {
      const current = this.now()
      if (!Number.isFinite(current)) return 0
      return Math.max(0, Math.min(MAX_TIMER_DELAY_MS, expiresAt - current))
    } catch {
      return 0
    }
  }

  private closeCdpBestEffort(flowId: string): void {
    void this.closeCdp(flowId)
  }

  private async closeCdp(flowId: string | undefined): Promise<void> {
    const active = this.activeCdp
    if (!active || (flowId !== undefined && active.flowId !== flowId)) return
    this.activeCdp = undefined
    clearTimeout(active.cleanupTimer)
    try {
      await active.session.close()
      reportAuthDiagnostic(this.diagnostics, 'cdp_browser_closed')
    } catch {
      reportAuthDiagnostic(this.diagnostics, 'cdp_browser_cleanup_failed')
    }
  }

  private readPublicStatus(flowId: string): EmbeddedAuthPublicState | undefined {
    try {
      const status = this.flows?.publicStatus(flowId)
      if (!isExactPublicStatus(status)) return undefined
      return status.state
    } catch {
      return undefined
    }
  }

  private cancelBestEffort(flowId: string): boolean {
    if (!this.flows) return false
    try {
      const bootstrap = this.flows.bridgeBootstrap(flowId)
      if (!isTrustedCsrf(bootstrap?.csrf)) return false
      this.flows.cancel(flowId, bootstrap.csrf)
      return true
    } catch {
      // Cleanup failures are intentionally collapsed at this trust boundary.
      return false
    }
  }

  private async drainFlowBestEffort(flowId: string): Promise<void> {
    if (!this.flows) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.commitDrainTimeoutMs)
      })
      await Promise.race([
        Promise.resolve(this.flows.waitForTerminal(flowId)).then(() => undefined),
        timeout,
      ])
    } catch {
      // A failed drain is indistinguishable from an unavailable flow here.
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

function normalizeCommitDrainTimeout(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_COMMIT_DRAIN_TIMEOUT_MS
    ? value
    : DEFAULT_COMMIT_DRAIN_TIMEOUT_MS
}

function normalizeConfiguration(
  usernameValue: unknown,
  regionValue: unknown,
  sessionTokenFileValue: unknown,
): NormalizedConfiguration | undefined {
  if (typeof usernameValue !== 'string') return undefined
  const username = usernameValue.trim()
  if (
    username.length === 0
    || username.length > MAX_USERNAME_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(username)
  ) {
    return undefined
  }
  if (regionValue !== 'global' && regionValue !== 'cn') return undefined
  if (
    typeof sessionTokenFileValue !== 'string'
    || sessionTokenFileValue.trim().length === 0
    || sessionTokenFileValue.length > MAX_SESSION_TOKEN_PATH_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(sessionTokenFileValue)
  ) {
    return undefined
  }
  return {
    username,
    region: regionValue,
    sessionTokenFile: sessionTokenFileValue,
  }
}

function exactCurrentFlowId(
  payload: unknown,
  currentFlowId: string | undefined,
): string | undefined {
  try {
    if (!isPlainObject(payload)) return undefined
    const keys = Object.keys(payload)
    if (keys.length !== 1 || keys[0] !== 'flowId') return undefined
    const flowId = payload.flowId
    if (typeof flowId !== 'string' || flowId !== currentFlowId) return undefined
    return flowId
  } catch {
    return undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExactPublicStatus(
  value: unknown,
): value is { state: EmbeddedAuthPublicState } {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1
    && keys[0] === 'state'
    && isPublicState(value.state)
}

function isPublicState(value: unknown): value is EmbeddedAuthPublicState {
  return value === 'in_progress'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'expired'
}

function isStartedFlow(
  value: unknown,
): value is { flowId: string; expiresAt: number } {
  if (!isPlainObject(value)) return false
  return FLOW_ID_PATTERN.test(String(value.flowId))
    && typeof value.expiresAt === 'number'
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > 0
}

function isTrustedCsrf(value: unknown): value is string {
  return typeof value === 'string' && CSRF_PATTERN.test(value)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true
  } catch {
    return true
  }
}

function cdpDiagnosticCodeFromError(error: unknown): AuthDiagnosticCode {
  try {
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code
      if (code === 'CANCELLED') return 'cancelled'
      if (code === 'DRIVER_UNAVAILABLE') return 'cdp_driver_unavailable'
      if (code === 'TIMED_OUT') return 'cdp_start_timeout'
      if (code === 'BROWSER_UNAVAILABLE') return 'cdp_browser_unavailable'
    }
  } catch {
    // Fall through to the existing closed diagnostic-code seam.
  }
  return authDiagnosticCodeFromError(error, 'browser_launch_failed')
}

function isSafeBridgeUrl(
  value: unknown,
  expectedOrigin: string,
  flowId: string,
): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  try {
    const parsed = new URL(value)
    return parsed.origin === expectedOrigin
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === `/garmin-auth/bridge/${flowId}`
      && parsed.search === ''
      && parsed.hash === ''
  } catch {
    return false
  }
}

function configurationFailure(): EmbeddedAuthBeginResult {
  return { success: false, code: 'configuration' }
}

function regionMismatchFailure(): EmbeddedAuthBeginResult {
  return { success: false, code: 'region_mismatch' }
}

function busyFailure(): EmbeddedAuthBeginResult {
  return { success: false, code: 'busy' }
}

function invalidFailure(): EmbeddedAuthStatusResult & EmbeddedAuthCancelResult {
  return { success: false, code: 'invalid' }
}

function unavailableFailure():
  EmbeddedAuthBeginResult & EmbeddedAuthStatusResult & EmbeddedAuthCancelResult {
  return { success: false, code: 'unavailable' }
}
