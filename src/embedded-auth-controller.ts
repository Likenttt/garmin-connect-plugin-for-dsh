import type { GarminRegion } from './config'
import type { EmbeddedAuthRuntimeConfig } from './embedded-auth-runtime'
import type {
  EmbeddedAuthFlowManager,
  EmbeddedAuthPublicState,
} from './embedded-auth-flow'
import type { EmbeddedAuthServer } from './embedded-auth-server'
import { isExactLoopbackOrigin } from './embedded-auth-url'

const MAX_USERNAME_LENGTH = 320
const MAX_SESSION_TOKEN_PATH_LENGTH = 4 * 1024
const FLOW_ID_PATTERN = /^[a-f0-9]{64}$/
const CSRF_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/
const DEFAULT_COMMIT_DRAIN_TIMEOUT_MS = 30_000
const MAX_COMMIT_DRAIN_TIMEOUT_MS = 2 * 60 * 1000

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
  private readonly commitDrainTimeoutMs: number
  private currentFlowId?: string
  private bridgeOrigin?: string
  private beginning = false
  private closed = false
  private closeOperation?: Promise<void>

  constructor(options: EmbeddedAuthControllerOptions) {
    this.username = options?.username
    this.region = options?.region
    this.sessionTokenFile = options?.sessionTokenFile
    this.flows = options?.flows
    this.server = options?.server
    this.prepareDestination = options?.prepareDestination
    this.commitDrainTimeoutMs = normalizeCommitDrainTimeout(
      options?.commitDrainTimeoutMs,
    )
  }

  async begin(
    signal?: AbortSignal,
    requestedRegion?: GarminRegion,
  ): Promise<EmbeddedAuthBeginResult> {
    const configuration = normalizeConfiguration(
      this.username,
      this.region,
      this.sessionTokenFile,
    )
    if (!configuration) return configurationFailure()
    if (
      requestedRegion !== undefined
      && requestedRegion !== configuration.region
    ) {
      return regionMismatchFailure()
    }
    if (this.closed || isAborted(signal)) return unavailableFailure()
    if (this.beginning) return busyFailure()
    if (!this.flows || !this.server || !this.prepareDestination) {
      return unavailableFailure()
    }

    if (this.currentFlowId) {
      const currentStatus = this.readPublicStatus(this.currentFlowId)
      if (!currentStatus) return unavailableFailure()
      if (currentStatus === 'in_progress') return busyFailure()
    }

    this.beginning = true
    let orphanFlowId: string | undefined
    try {
      await this.prepareDestination(configuration.sessionTokenFile)
      if (this.closed || isAborted(signal)) return unavailableFailure()

      const bridgeOrigin = this.bridgeOrigin ?? await this.server.start()
      if (
        this.closed
        || isAborted(signal)
        || !isExactLoopbackOrigin(bridgeOrigin)
      ) {
        return unavailableFailure()
      }
      this.bridgeOrigin = bridgeOrigin

      const started = this.flows.start({
        ...configuration,
        bridgeOrigin,
      })
      if (!isStartedFlow(started)) return unavailableFailure()
      orphanFlowId = started.flowId

      if (this.closed || isAborted(signal)) {
        this.cancelBestEffort(orphanFlowId)
        return unavailableFailure()
      }

      const bridgeUrl = this.server.bridgeUrl(started.flowId)
      if (!isSafeBridgeUrl(bridgeUrl, bridgeOrigin, started.flowId)) {
        this.cancelBestEffort(orphanFlowId)
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
    } catch {
      if (orphanFlowId) this.cancelBestEffort(orphanFlowId)
      return unavailableFailure()
    } finally {
      this.beginning = false
    }
  }

  status(payload: unknown): EmbeddedAuthStatusResult {
    const flowId = exactCurrentFlowId(payload, this.currentFlowId)
    if (!flowId) return invalidFailure()

    const status = this.readPublicStatus(flowId)
    if (!status) return unavailableFailure()
    return { success: true, status }
  }

  cancel(payload: unknown): EmbeddedAuthCancelResult {
    const flowId = exactCurrentFlowId(payload, this.currentFlowId)
    if (!flowId) return invalidFailure()
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
    try {
      await this.server?.close()
    } catch {
      // Shutdown is best effort and must not surface sensitive dependency text.
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
