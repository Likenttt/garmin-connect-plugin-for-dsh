import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { GarminConnect } from 'garmin-connect'
import type { Config } from './config'
import {
  createGarminDiSessionRuntimeDependencies,
  GarminDiSessionRuntime,
  replaceGarminDiSessionPath,
} from './di-session'
import { MAX_ZIP_BYTES } from './fit-export'
import { detectGarminBrowserChallenge } from './garmin-auth-challenge'
import {
  GarminDiSessionFileError,
  GarminSessionTokenFileInvalidError,
  GarminSessionTokenFileMissingError,
  type GarminSessionFile,
  isDiSessionFile,
  prepareSessionTokenWriteDestination,
  readSessionTokenFile,
  sessionFileMatchesAccount,
} from './session-store'
import { MemoryCache } from './utils/cache'
import { parseLocalDate } from './utils/date'
import {
  GARMIN_BROWSER_AUTH_COMMAND,
  GarminAuthenticationRequiredError,
  type GarminAuthenticationRequiredReason,
  PublicToolError,
} from './utils/errors'

type LogLevel = Config['logLevel']

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const DI_SESSION_REJECTED_MESSAGE =
  `Garmin DI session was rejected; run ${GARMIN_BROWSER_AUTH_COMMAND}`
const DI_SESSION_EXPIRED_MESSAGE =
  `Garmin DI session has expired; run ${GARMIN_BROWSER_AUTH_COMMAND}`
const SESSION_TOKEN_REJECTED_MESSAGE =
  `Garmin session token was rejected; run ${GARMIN_BROWSER_AUTH_COMMAND}`
const PASSWORD_SIGN_IN_FAILED_MESSAGE =
  'Garmin password sign-in did not complete; check email, region, and password'
const MISSING_SESSION_FILE_FINGERPRINT = 'missing'
const UNREADABLE_SESSION_FILE_FINGERPRINT = 'unreadable'

export interface GarminClientOptions {
  /** Let the local dsh UI load before its out-of-band authentication finishes. */
  allowUnconfigured?: boolean
}

export interface GarminAuthenticatedAccount {
  email: string
  region: Config['region']
}

export interface GarminAuthenticationRequirement {
  reason: GarminAuthenticationRequiredReason
  region: Config['region']
  revision: number
}

type SessionRestoreResult = false | 'verified' | 'unverified'
type SessionFileSnapshot =
  | { fingerprint: string; session: GarminSessionFile }
  | { error: unknown; fingerprint: string }

/**
 * Thin wrapper around the `garmin-connect` npm package that adds:
 *   - Cordis-aware logging
 *   - Automatic session persistence / restore
 *   - An in-memory cache to reduce API calls and avoid rate limits
 *   - Automatic retries on rate-limit / session expiration
 */
export class GarminClient {
  private gc: GarminConnect
  private cache: MemoryCache
  private ctx: Context
  private config: Config
  private requestTimeoutMs: number
  private connected = false
  private connecting: Promise<void> | null = null
  private sessionTokenRejected = false
  private selectedSessionFileFingerprint?: string
  private rejectedSessionFileFingerprint?: string
  private pendingChangedSessionFile?: SessionFileSnapshot
  private diSessionSelected = false
  private diRuntime: GarminDiSessionRuntime | null = null
  private sessionReplacementGate: Promise<void> | null = null
  private authEpoch = 0
  private authenticatedAccount?: GarminAuthenticatedAccount
  private authenticationRequirement?: GarminAuthenticationRequirement
  private authenticationRequirementRevision = 0
  private active = true

  constructor(
    ctx: Context,
    config: Config,
    options: GarminClientOptions = {},
  ) {
    if (!options.allowUnconfigured && !config.username.trim()) {
      throw new Error('Garmin username is required')
    }
    if (
      !options.allowUnconfigured
      && !config.password?.trim()
      && !config.sessionToken?.trim()
      && !config.sessionTokenFile?.trim()
    ) {
      throw new Error('Garmin password, session token, or session token file is required')
    }

    this.ctx = ctx
    this.config = config
    this.cache = new MemoryCache(config.cacheTtl)
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000

    this.gc = new GarminConnect({
      username: config.username,
      password: config.password ?? '',
    }, config.region === 'cn' ? 'garmin.cn' : 'garmin.com')
    this.hardenUpstreamClient()
    this.gc.client.client.defaults.timeout = this.requestTimeoutMs
    // The pinned SDK requests original ZIPs as one ArrayBuffer. Bound Axios at
    // the transport layer so an oversized response is aborted before the full
    // archive can be retained in memory.
    this.gc.client.client.defaults.maxContentLength = MAX_ZIP_BYTES
  }

  // ---------- Lifecycle ---------------------------------------------------

  /** Fence old requests and credentials when Cordis unloads this instance. */
  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.connected = false
    this.authenticatedAccount = undefined
    this.authenticationRequirement = undefined
    this.authEpoch += 1
    this.cache.clear()
    this.diRuntime?.invalidate()
    this.diRuntime = null
    const upstream = this.gc.client as any
    upstream.oauth1Token = undefined
    upstream.oauth2Token = undefined
  }

  private assertActive(): void {
    if (!this.active) throw authenticationChangedError()
  }

  /**
   * Log in (or restore a session token) exactly once. Concurrent callers
   * share the same in-flight promise, so eager warm-up and lazy first-use
   * never race each other.
   */
  async connect(): Promise<void> {
    this.assertActive()
    while (this.sessionReplacementGate) {
      await this.sessionReplacementGate
      this.assertActive()
    }
    if (!this.connecting) {
      let tracked!: Promise<void>
      tracked = this.login().finally(() => {
        if (this.connecting === tracked) this.connecting = null
      })
      this.connecting = tracked
    }
    return this.connecting
  }

  /** Return only an account identity established by a trusted Host auth path. */
  getAuthenticatedAccount(): GarminAuthenticatedAccount | undefined {
    if (!this.active || this.sessionReplacementGate || !this.authenticatedAccount) return undefined
    return { ...this.authenticatedAccount }
  }

  /** Return only coarse browser-recovery state; never upstream error details. */
  getAuthenticationRequirement(): GarminAuthenticationRequirement | undefined {
    if (!this.active) return undefined
    return this.authenticationRequirement
      ? { ...this.authenticationRequirement }
      : undefined
  }

  private async login(): Promise<void> {
    try {
      this.assertActive()
      let identityVerified = false
      if (!this.config.username.trim()) {
        throw new PublicToolError('Garmin username is required')
      }
      await this.acceptChangedSessionFile()
      if (this.hasConfiguredSession() && !this.sessionTokenRejected) {
        this.log('info', '[garmin] Restoring session from token…')
        const restored = await this.restoreConfiguredSession()
        if (!restored) {
          this.log('warn', '[garmin] Configured session is unavailable; falling back to password login.')
          await this.loginWithPassword()
          identityVerified = true
        } else {
          identityVerified = restored === 'verified'
        }
      } else if (this.diSessionSelected) {
        throw new GarminAuthenticationRequiredError(
          'rejected',
          DI_SESSION_REJECTED_MESSAGE,
        )
      } else if (this.config.password?.trim()) {
        this.log('info', '[garmin] Logging in with username/password…')
        await this.loginWithPassword()
        identityVerified = true
      } else if (this.sessionTokenRejected) {
        throw new GarminAuthenticationRequiredError(
          'rejected',
          SESSION_TOKEN_REJECTED_MESSAGE,
        )
      } else {
        throw new GarminAuthenticationRequiredError('missing')
      }
      this.assertActive()
      this.connected = true
      this.clearAuthenticationRequirement()
      if (identityVerified) this.markAuthenticatedAccount()
      this.log('info', '[garmin] ✅ Connected successfully.')
    } catch (err) {
      this.connected = false
      if (!this.active) throw authenticationChangedError()
      const status = getHttpStatus(err)
      if (err instanceof GarminAuthenticationRequiredError) {
        this.publishAuthenticationRequirement(err.reason)
      } else {
        this.clearAuthenticationRequirement()
      }
      const reason = err instanceof PublicToolError
        ? err.message
        : status
          ? `Garmin connection failed (HTTP ${status})`
          : 'Garmin connection failed'
      this.log('error', `[garmin] ❌ ${reason}`)
      throw err
    }
  }

  private async loginWithPassword(): Promise<void> {
    try {
      await this.withRequestTimeout(() => this.gc.login())
    } catch (error) {
      if (error instanceof PublicToolError) throw error
      throw new PublicToolError(PASSWORD_SIGN_IN_FAILED_MESSAGE)
    }
  }

  private async restoreConfiguredSession(): Promise<SessionRestoreResult> {
    const inlineToken = this.config.sessionToken?.trim()
    try {
      let tokens: unknown
      if (inlineToken) {
        tokens = JSON.parse(inlineToken) as unknown
        if (!isRecord(tokens) || !isRecord(tokens.oauth1) || !isRecord(tokens.oauth2)) {
          throw new Error('Invalid token structure')
        }
      } else {
        const sessionPath = resolve(this.config.sessionTokenFile!.trim())
        const snapshot = this.pendingChangedSessionFile
          ?? await readSessionFileSnapshot(sessionPath)
        this.pendingChangedSessionFile = undefined
        this.selectedSessionFileFingerprint = snapshot.fingerprint
        if ('error' in snapshot) throw snapshot.error
        const sessionFile = snapshot.session
        if (!sessionFileMatchesAccount(
          sessionFile,
          this.config.username,
          this.config.region,
        )) {
          throw new PublicToolError(
            'Garmin session token file does not match the configured account or region',
          )
        }
        if (isDiSessionFile(sessionFile)) {
          this.diSessionSelected = true
          if (!sessionFileIsLocallyUsable(
            sessionFile,
            this.config.username,
            this.config.region,
          )) {
            throw new GarminAuthenticationRequiredError(
              'expired',
              DI_SESSION_EXPIRED_MESSAGE,
            )
          }
          const runtime = new GarminDiSessionRuntime({
            username: this.config.username,
            region: this.config.region,
            session: sessionFile,
            sessionPath,
            requestTimeoutMs: this.requestTimeoutMs,
            dependencies: createGarminDiSessionRuntimeDependencies(),
          })
          this.diRuntime = runtime
          runtime.install(this.gc.client.client)
          let profile: unknown
          try {
            profile = await this.gc.getUserProfile()
          } catch (error) {
            if (isRecord(error) && error.timedOut === true) {
              throw new PublicToolError(
                `Garmin request timed out after ${this.requestTimeoutMs}ms`,
              )
            }
            throw error
          }
          runtime.validateProfile(profile)
          return 'verified'
        }
        tokens = sessionFile
      }
      if (!isRecord(tokens) || !isRecord(tokens.oauth1) || !isRecord(tokens.oauth2)) {
        throw new Error('Invalid token structure')
      }
      this.gc.loadToken(tokens.oauth1 as any, tokens.oauth2 as any)
      return 'unverified'
    } catch (error) {
      if (error instanceof GarminDiSessionFileError) {
        this.discardLoadedSessionToken()
        throw error
      }
      if (error instanceof GarminSessionTokenFileInvalidError) {
        this.discardLoadedSessionToken()
        if (this.config.password?.trim()) return false
        throw error
      }
      if (inlineToken && !(error instanceof PublicToolError)) {
        this.discardLoadedSessionToken()
        if (this.config.password?.trim()) return false
        throw new PublicToolError('Garmin inline session token is invalid')
      }
      if (
        error instanceof PublicToolError
        && !(error instanceof GarminSessionTokenFileMissingError)
        && !(error instanceof GarminAuthenticationRequiredError)
      ) {
        this.discardLoadedSessionToken()
        throw error
      }
      if (
        error instanceof GarminSessionTokenFileMissingError
        && this.config.sessionTokenFile?.trim()
      ) {
        await prepareSessionTokenWriteDestination(
          resolve(this.config.sessionTokenFile.trim()),
        )
      }
      if (this.diSessionSelected) {
        if (error instanceof GarminAuthenticationRequiredError) {
          this.rejectConfiguredSessionToken()
          throw error
        }
        if (getHttpStatus(error) === 401) {
          this.rejectConfiguredSessionToken()
          throw new GarminAuthenticationRequiredError(
            'rejected',
            DI_SESSION_REJECTED_MESSAGE,
          )
        }
        this.discardLoadedSessionToken()
        throw error
      }
      this.rejectConfiguredSessionToken()
      if (!this.config.password?.trim()) {
        if (error instanceof GarminSessionTokenFileMissingError) {
          throw new GarminAuthenticationRequiredError('missing')
        }
        if (!inlineToken && error instanceof PublicToolError) throw error
        throw new GarminAuthenticationRequiredError(
          'rejected',
          `Garmin session token is invalid; run ${GARMIN_BROWSER_AUTH_COMMAND}`,
        )
      }
      return false
    }
  }

  private hasConfiguredSession(): boolean {
    return Boolean(
      this.config.sessionToken?.trim() || this.config.sessionTokenFile?.trim(),
    )
  }

  private rejectConfiguredSessionToken(): void {
    this.sessionTokenRejected = true
    this.rejectedSessionFileFingerprint = this.config.sessionToken?.trim()
      ? undefined
      : this.selectedSessionFileFingerprint
    this.discardLoadedSessionToken()
  }

  /**
   * A terminal/browser auth helper writes the configured file out of process.
   * Retry it only when its private parsed contents changed, so the MCP process
   * hot-loads new credentials without probing one rejected token repeatedly.
   */
  private async acceptChangedSessionFile(): Promise<void> {
    const sessionPath = this.config.sessionTokenFile?.trim()
    const rejectedInlineToken = Boolean(this.config.sessionToken?.trim())
    if (
      !this.sessionTokenRejected
      || !sessionPath
      || (!rejectedInlineToken && !this.rejectedSessionFileFingerprint)
    ) return

    const snapshot = await readSessionFileSnapshot(resolve(sessionPath))
    if (
      !rejectedInlineToken
      && snapshot.fingerprint === this.rejectedSessionFileFingerprint
    ) return
    if ('error' in snapshot) return
    if (rejectedInlineToken && snapshot.session.account === undefined) return
    if (!sessionFileIsLocallyUsable(
      snapshot.session,
      this.config.username,
      this.config.region,
    )) return

    this.sessionTokenRejected = false
    this.diSessionSelected = false
    this.selectedSessionFileFingerprint = undefined
    this.rejectedSessionFileFingerprint = undefined
    this.pendingChangedSessionFile = snapshot
    if (rejectedInlineToken) {
      this.config = { ...this.config, sessionToken: '' }
    }
  }

  private discardLoadedSessionToken(): void {
    this.connected = false
    this.authenticatedAccount = undefined
    this.authEpoch += 1
    this.cache.clear()
    this.diRuntime?.invalidate()
    this.diRuntime = null
    const upstream = this.gc.client as any
    upstream.oauth1Token = undefined
    upstream.oauth2Token = undefined
  }

  /**
   * Own the trusted Host's complete session replacement transaction. New
   * Garmin work is fenced while old DI refresh writes drain, then the supplied
   * atomic writer installs the new file last.
   */
  async replacePersistedSession(writeSession: () => Promise<void>): Promise<void> {
    this.assertActive()
    const sessionTokenFile = this.config.sessionTokenFile?.trim()
    if (!sessionTokenFile) {
      throw new PublicToolError('Garmin session token file is not configured')
    }
    if (typeof writeSession !== 'function') {
      throw new PublicToolError('Garmin DI session could not be persisted')
    }

    while (this.sessionReplacementGate) {
      await this.sessionReplacementGate
      this.assertActive()
    }
    let releaseReplacement!: () => void
    const replacementGate = new Promise<void>(resolveReplacement => {
      releaseReplacement = resolveReplacement
    })
    this.sessionReplacementGate = replacementGate
    this.clearAuthenticationRequirement()

    let committed = false
    let verifiedReplacement = false
    try {
      const pendingConnection = this.connecting
      if (pendingConnection) await pendingConnection.catch(() => undefined)
      this.assertActive()

      this.connected = false
      this.authEpoch += 1
      this.cache.clear()
      this.diRuntime?.invalidate()
      this.diRuntime = null

      await replaceGarminDiSessionPath(sessionTokenFile, writeSession)
      committed = true
      this.assertActive()
      try {
        const session = await readSessionTokenFile(resolve(sessionTokenFile))
        verifiedReplacement = isDiSessionFile(session)
          && sessionFileIsLocallyUsable(
            session,
            this.config.username,
            this.config.region,
          )
      } catch {
        verifiedReplacement = false
      }
    } finally {
      this.connected = false
      this.sessionTokenRejected = false
      this.selectedSessionFileFingerprint = undefined
      this.rejectedSessionFileFingerprint = undefined
      this.pendingChangedSessionFile = undefined
      this.diSessionSelected = false
      this.cache.clear()
      this.config = {
        ...this.config,
        ...(committed ? { password: '', sessionToken: '' } : {}),
        sessionTokenFile,
      }
      const upstream = this.gc.client as any
      upstream.oauth1Token = undefined
      upstream.oauth2Token = undefined
      if (committed && this.active) {
        if (verifiedReplacement) {
          this.markAuthenticatedAccount()
          this.clearAuthenticationRequirement()
        }
        else this.authenticatedAccount = undefined
      }

      releaseReplacement()
      if (this.sessionReplacementGate === replacementGate) {
        this.sessionReplacementGate = null
      }
    }
  }

  /** Lazily connect on first use. Failures are logged and rethrown to the caller. */
  private async ensureConnected(): Promise<void> {
    this.assertActive()
    while (this.sessionReplacementGate) {
      await this.sessionReplacementGate
      this.assertActive()
    }
    if (!this.connected) {
      await this.connect()
    }
    this.assertActive()
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    await this.ensureConnected()

    for (let i = 0; i <= retries; i++) {
      this.assertActive()
      const attemptEpoch = this.authEpoch
      try {
        const result = await fn()
        if (attemptEpoch !== this.authEpoch) {
          if (i === retries) throw authenticationChangedError()
          await this.ensureConnected()
          continue
        }
        return result
      } catch (err: any) {
        if (attemptEpoch !== this.authEpoch) {
          if (i === retries) throw authenticationChangedError()
          await this.ensureConnected()
          continue
        }
        if (err instanceof GarminAuthenticationRequiredError) {
          this.publishAuthenticationRequirement(err.reason)
        }
        if (
          err instanceof GarminAuthenticationRequiredError
          && this.diSessionSelected
        ) {
          this.rejectConfiguredSessionToken()
          throw err
        }
        if (i === retries) throw err
        
        const status = getHttpStatus(err)
        
        // Session expired -> auto-reconnect
        if (status === 401 || status === 403) {
          if (this.diSessionSelected) {
            if (status === 401) {
              this.rejectConfiguredSessionToken()
              throw this.trackAuthenticationRequirement(
                new GarminAuthenticationRequiredError(
                  'rejected',
                  DI_SESSION_REJECTED_MESSAGE,
                ),
              )
            }
            throw err
          }
          if (this.hasConfiguredSession() && !this.sessionTokenRejected) {
            // A configured token and password can belong to different Garmin
            // accounts. Never carry health data across that identity boundary.
            this.rejectConfiguredSessionToken()
            if (!this.config.password?.trim()) {
              throw this.trackAuthenticationRequirement(
                new GarminAuthenticationRequiredError(
                  'rejected',
                  SESSION_TOKEN_REJECTED_MESSAGE,
                ),
              )
            }
          }
          this.log('warn', '[garmin] Session expired, reconnecting…')
          this.connected = false
          this.authenticatedAccount = undefined
          await this.connect()
          continue
        }
        
        // Rate limited -> exponential backoff
        if (status === 429) {
          const delay = Math.pow(2, i) * 1000
          this.log('warn', `[garmin] Rate limited, waiting ${delay}ms…`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        
        throw err
      }
    }
    throw new Error('Unreachable')
  }

  private async withRequestTimeout<T>(
    factory: () => Promise<T>,
    timeoutMessage = `Garmin request timed out after ${this.requestTimeoutMs}ms`,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new PublicToolError(timeoutMessage))
      }, this.requestTimeoutMs)
    })

    try {
      return await Promise.race([factory(), timeout])
    } catch (error) {
      if (isRecord(error) && error.timedOut === true) {
        throw new PublicToolError(timeoutMessage)
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private log(level: LogLevel, message: string): void {
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[this.config.logLevel]) return

    if (level === 'debug') this.ctx.logger.debug(message)
    else if (level === 'info') this.ctx.logger.info(message)
    else if (level === 'warn') this.ctx.logger.warn(message)
    else this.ctx.logger.error(message)
  }

  private async getCachedForCurrentAuth<T>(
    key: string,
    factory: () => Promise<T>,
  ): Promise<T> {
    // Keep retry/auth-epoch handling outside the cache. This protects both
    // network responses and fresh cache hits with one state machine, while a
    // token-to-password transition clears/detaches the old cache generation.
    // Put the deadline inside the cache factory so a timeout rejects and
    // removes that pending entry instead of pinning a hung request forever.
    return this.withRetry(() =>
      this.cache.getOrSet(key, () => this.withRequestTimeout(factory)))
  }

  /**
   * garmin-connect 1.6.x logs full response bodies before throwing and drops
   * the HTTP status. Replace those instance hooks with quiet, normalized
   * errors so secrets/health data cannot bypass the host logger.
   */
  private hardenUpstreamClient(): void {
    hardenGarminHttpClient(this.gc.client as any, {
      getAuthEpoch: () => this.authEpoch,
      discardStaleRefresh: () => this.discardStaleRefresh(),
    })
  }

  private publishAuthenticationRequirement(
    reason: GarminAuthenticationRequiredReason,
  ): void {
    if (this.authenticationRequirement?.reason === reason) return
    this.authenticationRequirementRevision += 1
    this.authenticationRequirement = {
      reason,
      region: this.config.region,
      revision: this.authenticationRequirementRevision,
    }
  }

  private clearAuthenticationRequirement(): void {
    this.authenticationRequirement = undefined
  }

  private trackAuthenticationRequirement(
    error: GarminAuthenticationRequiredError,
  ): GarminAuthenticationRequiredError {
    this.publishAuthenticationRequirement(error.reason)
    return error
  }

  private discardStaleRefresh(): void {
    this.connected = false
    this.authenticatedAccount = undefined
    this.authEpoch += 1
    this.cache.clear()
    const upstream = this.gc.client as any
    upstream.oauth1Token = undefined
    upstream.oauth2Token = undefined
  }

  // ---------- Data accessors (cached) ------------------------------------

  /** Return the most recent activities. */
  async getActivities(start = 0, limit = 10): Promise<unknown[]> {
    const key = `activities:${start}:${limit}`
    return this.getCachedForCurrentAuth(key, () => this.gc.getActivities(start, limit))
  }

  /** Download the original Garmin activity archive into a private caller-owned directory. */
  async downloadOriginalActivityZip(
    activityId: number,
    destinationDir: string,
  ): Promise<string> {
    if (!Number.isSafeInteger(activityId) || activityId <= 0) {
      throw new PublicToolError('Invalid activityId: expected a positive integer')
    }
    if (typeof destinationDir !== 'string' || !destinationDir.trim()) {
      throw new PublicToolError('The activity download directory is invalid')
    }

    await this.withRetry(() => this.withRequestTimeout(
      () => this.gc.downloadOriginalActivityData(
        { activityId },
        destinationDir,
        'zip',
      ),
      `Garmin activity download timed out after ${this.requestTimeoutMs}ms`,
    ))
    return join(destinationDir, `${activityId}.zip`)
  }

  /** Return step count data for a given date (YYYY-MM-DD). */
  async getSteps(date: string): Promise<unknown> {
    return this.getCachedForCurrentAuth(`steps:${date}`, async () => {
      const result = await this.gc.getSteps(parseLocalDate(date))
      return typeof result === 'number'
        ? { calendarDate: date, totalSteps: result }
        : result
    })
  }

  /** Return sleep data for a given date (YYYY-MM-DD). */
  async getSleep(date: string): Promise<unknown> {
    return this.getCachedForCurrentAuth(`sleep:${date}`, () =>
      this.gc.getSleepData(parseLocalDate(date)))
  }

  /** Return heart rate data for a given date (YYYY-MM-DD). */
  async getHeartRate(date: string): Promise<unknown> {
    return this.getCachedForCurrentAuth(`hr:${date}`, () =>
      this.gc.getHeartRate(parseLocalDate(date)))
  }

  /** Return weight/body composition data for a given date (YYYY-MM-DD). */
  async getWeight(date: string): Promise<unknown> {
    return this.getCachedForCurrentAuth(`weight:${date}`, () =>
      this.gc.getDailyWeightData(parseLocalDate(date)))
  }

  /** Return workout templates from the user's Garmin workout library. */
  async getWorkouts(start = 0, limit = 10): Promise<unknown[]> {
    const key = `workouts:${start}:${limit}`
    return this.getCachedForCurrentAuth(key, () => this.gc.getWorkouts(start, limit))
  }

  /** Create a workout in Garmin Connect. Returns the created workout object. */
  async addWorkout(workout: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureConnected()
    const attemptEpoch = this.authEpoch
    // A timed-out POST may still have reached Garmin. Force any subsequent
    // verification query to bypass a previously cached workout list.
    this.cache.invalidatePrefix('workouts:')
    try {
      const result = await this.withRequestTimeout(
        () => (this.gc as any).addWorkout(workout),
        `Garmin workout creation timed out after ${this.requestTimeoutMs}ms; ` +
          'outcome is unknown; check the Garmin workout library before retrying',
      )
      if (attemptEpoch !== this.authEpoch) {
        throw new PublicToolError(
          'Garmin authentication changed during workout creation; outcome is unknown; ' +
          'check the Garmin workout library before retrying',
        )
      }
      this.log('info', '[garmin] ✅ Workout created successfully.')
      return result as Record<string, unknown>
    } catch (error) {
      if (
        error instanceof GarminAuthenticationRequiredError
        && this.diSessionSelected
      ) {
        this.rejectConfiguredSessionToken()
        throw error
      }
      const status = getHttpStatus(error)
      if (status === 401 || status === 403) {
        if (this.diSessionSelected && status === 403) throw error
        if (this.hasConfiguredSession() && !this.sessionTokenRejected) {
          this.rejectConfiguredSessionToken()
        } else {
          this.connected = false
          this.authenticatedAccount = undefined
        }
        throw new PublicToolError(
          'Garmin authentication expired before workout creation; ' +
          'request a new preview and confirmation before trying again',
        )
      }
      throw error
    }
  }

  /** Return user profile summary. */
  async getUserProfile(): Promise<unknown> {
    return this.getCachedForCurrentAuth('profile', () => this.gc.getUserProfile())
  }

  /** Export a session token so it can be stored securely for future logins. */
  async exportSession(): Promise<string> {
    await this.ensureConnected()
    if (this.diSessionSelected) {
      throw new PublicToolError(
        'Garmin DI sessions remain in the configured session token file',
      )
    }
    return JSON.stringify(this.gc.exportToken())
  }

  private markAuthenticatedAccount(): void {
    const email = this.config.username.trim()
    if (
      email.length === 0
      || email.length > 320
      || /[\u0000-\u001f\u007f-\u009f]/.test(email)
    ) {
      this.authenticatedAccount = undefined
      return
    }
    this.authenticatedAccount = {
      email,
      region: this.config.region,
    }
  }
}

/**
 * Replace garmin-connect 1.6.x's module-global refresh queue with a quiet,
 * per-client refresh state machine. Only idempotent requests may be replayed.
 */
interface AuthRefreshGuard {
  getAuthEpoch(): number
  discardStaleRefresh(): void
}

export function installSafeResponseInterceptor(
  upstream: any,
  authGuard?: AuthRefreshGuard,
): void {
  const axiosClient = upstream?.client
  const manager = axiosClient?.interceptors?.response
  if (!manager || typeof manager.use !== 'function') return

  if (typeof manager.clear === 'function') {
    manager.clear()
  } else if (Array.isArray(manager.handlers) && typeof manager.eject === 'function') {
    manager.handlers.forEach((_handler: unknown, index: number) => manager.eject(index))
  }

  let refreshPromise: Promise<void> | null = null
  manager.use(
    (response: unknown) => response,
    async (error: any) => {
      const request = error?.config
      const status = validHttpStatus(error?.response?.status)
      const timedOut = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT'
      const method = typeof request?.method === 'string'
        ? request.method.toLowerCase()
        : ''
      const mayReplay = ['get', 'head', 'options'].includes(method)
      const hasRefreshState = Boolean(
        refreshPromise || (upstream.oauth1Token && upstream.oauth2Token),
      )

      if (
        status === 401 &&
        request &&
        mayReplay &&
        !request.__garminRefreshRetried &&
        hasRefreshState
      ) {
        const retryRequest = { ...request, __garminRefreshRetried: true }
        try {
          if (!refreshPromise) {
            const refreshEpoch = authGuard?.getAuthEpoch()
            const oauth2Snapshot = upstream.oauth2Token
            refreshPromise = refreshOauth2Quietly(upstream)
              .catch((refreshError) => {
                // garmin-connect clears oauth2Token before exchanging it. A
                // transient refresh failure must not destroy the last known
                // token, but an identity change must never restore an old
                // account's credentials.
                if (
                  !authGuard
                  || refreshEpoch === undefined
                  || refreshEpoch === authGuard.getAuthEpoch()
                ) {
                  upstream.oauth2Token = oauth2Snapshot
                }
                throw refreshError
              })
              .then(() => {
                if (
                  authGuard &&
                  refreshEpoch !== undefined &&
                  refreshEpoch !== authGuard.getAuthEpoch()
                ) {
                  authGuard.discardStaleRefresh()
                  throw normalizedHttpError(401)
                }
              })
              .finally(() => {
                refreshPromise = null
              })
          }
          await refreshPromise
        } catch (refreshError) {
          const code = isRecord(refreshError) ? refreshError.code : undefined
          const timedOut = isRecord(refreshError) && (
            refreshError.timedOut === true
            || code === 'ECONNABORTED'
            || code === 'ETIMEDOUT'
          )
          // A refresh can fail because of a transient rate limit, server
          // outage, or network timeout. Preserve only the safe status/timeout
          // signal so callers do not permanently reject a still-valid token.
          throw normalizedHttpError(getHttpStatus(refreshError), timedOut)
        }
        return axiosClient.request(retryRequest)
      }

      throw normalizedHttpError(status, timedOut)
    },
  )
}

/** Apply all quiet error and authentication hardening to a raw SDK client. */
export function hardenGarminHttpClient(
  upstream: any,
  authGuard?: AuthRefreshGuard,
): void {
  installSafeResponseInterceptor(upstream, authGuard)
  upstream.handleHttpError = (response: any): never => {
    const status = validHttpStatus(response?.status)
    throw normalizedHttpError(status)
  }
  upstream.handlePageTitle = (html: unknown): void => {
    if (typeof html !== 'string') return
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]
    if (title?.includes('Update Phone Number')) {
      throw new PublicToolError(
        'Garmin login requires a phone-number update in Garmin Connect',
      )
    }
  }
  upstream.handleAccountLocked = (html: unknown): void => {
    if (typeof html === 'string' && /var\s+status\s*=\s*"[^"]*"/i.test(html)) {
      throw new PublicToolError('Garmin account is locked; unlock it in Garmin Connect')
    }
  }
  upstream.handleMFA = (html: unknown): void => {
    if (detectGarminBrowserChallenge(html)) {
      throw new GarminAuthenticationRequiredError('challenge')
    }
  }
}

async function refreshOauth2Quietly(upstream: any): Promise<void> {
  if (!upstream.OAUTH_CONSUMER) await upstream.fetchOauthConsumer()
  if (!upstream.oauth1Token || !upstream.oauth2Token) {
    throw normalizedHttpError(401)
  }

  const oauth1 = {
    oauth: upstream.getOauthClient(upstream.OAUTH_CONSUMER),
    token: upstream.oauth1Token,
  }
  await upstream.exchange(oauth1)
}

function normalizedHttpError(
  status: number | undefined,
  timedOut = false,
): Error & { status?: number; timedOut?: boolean } {
  const error: Error & { status?: number; timedOut?: boolean } =
    new Error(status ? `Garmin request failed (HTTP ${status})` : 'Garmin request failed')
  if (status !== undefined) error.status = status
  if (timedOut) error.timedOut = true
  return error
}

function validHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

function authenticationChangedError(): PublicToolError {
  return new PublicToolError(
    'Garmin authentication changed while the request was in flight; retry the request',
  )
}

async function readSessionFileSnapshot(path: string): Promise<SessionFileSnapshot> {
  try {
    const session = await readSessionTokenFile(path)
    return {
      fingerprint: fingerprintSessionFile(session),
      session,
    }
  } catch (error) {
    return {
      error,
      fingerprint: error instanceof GarminSessionTokenFileMissingError
        ? MISSING_SESSION_FILE_FINGERPRINT
        : UNREADABLE_SESSION_FILE_FINGERPRINT,
    }
  }
}

function sessionFileIsLocallyUsable(
  session: GarminSessionFile,
  username: string,
  region: Config['region'],
  nowMs = Date.now(),
): boolean {
  if (!sessionFileMatchesAccount(session, username, region)) return false
  if (!isDiSessionFile(session)) return true
  const refreshExpiry = session.tokens.refreshExpiresAtMs
  return refreshExpiry === null || refreshExpiry > nowMs
}

function fingerprintSessionFile(session: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(session))
    .digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
    cause?: unknown
    message?: unknown
  }
  const direct = candidate.response?.status ?? candidate.status ?? candidate.statusCode
  if (typeof direct === 'number' && Number.isInteger(direct)) return direct

  if (typeof candidate.message === 'string') {
    const match = /(?:ERROR:\s*\(|HTTP\s+|status(?:Code)?[=: ]+)([1-5]\d{2})\b/i.exec(candidate.message)
    if (match) return Number(match[1])
  }

  return candidate.cause === error ? undefined : getHttpStatus(candidate.cause)
}
