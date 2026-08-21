import { Context } from '@deepseek-ai/cordis'
import { join, resolve } from 'node:path'
import { GarminConnect } from 'garmin-connect'
import type { Config } from './config'
import {
  createGarminDiSessionRuntimeDependencies,
  GarminDiSessionRuntime,
} from './di-session'
import { MAX_ZIP_BYTES } from './fit-export'
import {
  GarminDiSessionFileError,
  isDiSessionFile,
  readSessionTokenFile,
  sessionFileMatchesAccount,
} from './session-store'
import { MemoryCache } from './utils/cache'
import { parseLocalDate } from './utils/date'
import { PublicToolError } from './utils/errors'

type LogLevel = Config['logLevel']

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const DI_SESSION_REJECTED_MESSAGE =
  'Garmin DI session was rejected; run garmin-connect-auth login --browser again'

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
  private diSessionSelected = false
  private diRuntime: GarminDiSessionRuntime | null = null
  private authEpoch = 0

  constructor(ctx: Context, config: Config) {
    if (!config.username.trim()) {
      throw new Error('Garmin username is required')
    }
    if (
      !config.password?.trim()
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

  /**
   * Log in (or restore a session token) exactly once. Concurrent callers
   * share the same in-flight promise, so eager warm-up and lazy first-use
   * never race each other.
   */
  async connect(): Promise<void> {
    if (!this.connecting) {
      let tracked!: Promise<void>
      tracked = this.login().finally(() => {
        if (this.connecting === tracked) this.connecting = null
      })
      this.connecting = tracked
    }
    return this.connecting
  }

  private async login(): Promise<void> {
    try {
      if (this.hasConfiguredSession() && !this.sessionTokenRejected) {
        this.log('info', '[garmin] Restoring session from token…')
        if (!await this.restoreConfiguredSession()) {
          this.log('warn', '[garmin] Configured session is unavailable; falling back to password login.')
          await this.withRequestTimeout(() => this.gc.login())
        }
      } else if (this.diSessionSelected) {
        throw new PublicToolError(DI_SESSION_REJECTED_MESSAGE)
      } else if (this.config.password?.trim()) {
        this.log('info', '[garmin] Logging in with username/password…')
        await this.withRequestTimeout(() => this.gc.login())
      } else {
        throw new PublicToolError(
          'Garmin session token was rejected; provide a new token or password',
        )
      }
      this.connected = true
      this.log('info', '[garmin] ✅ Connected successfully.')
    } catch (err) {
      this.connected = false
      const status = getHttpStatus(err)
      const reason = err instanceof PublicToolError
        ? err.message
        : status
          ? `Garmin connection failed (HTTP ${status})`
          : 'Garmin connection failed'
      this.log('error', `[garmin] ❌ ${reason}`)
      throw err
    }
  }

  private async restoreConfiguredSession(): Promise<boolean> {
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
        const sessionFile = await readSessionTokenFile(sessionPath)
        if (isDiSessionFile(sessionFile)) {
          this.diSessionSelected = true
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
          return true
        }
        if (!sessionFileMatchesAccount(
          sessionFile,
          this.config.username,
          this.config.region,
        )) {
          throw new PublicToolError(
            'Garmin session token file does not match the configured account or region',
          )
        }
        tokens = sessionFile
      }
      if (!isRecord(tokens) || !isRecord(tokens.oauth1) || !isRecord(tokens.oauth2)) {
        throw new Error('Invalid token structure')
      }
      this.gc.loadToken(tokens.oauth1 as any, tokens.oauth2 as any)
      return true
    } catch (error) {
      if (error instanceof GarminDiSessionFileError) {
        this.diSessionSelected = true
      }
      this.rejectConfiguredSessionToken()
      if (this.diSessionSelected) {
        if (error instanceof PublicToolError) throw error
        throw new PublicToolError(DI_SESSION_REJECTED_MESSAGE)
      }
      if (!this.config.password?.trim()) {
        if (!inlineToken && error instanceof PublicToolError) throw error
        throw new PublicToolError(
          'Garmin session token is invalid; provide a valid token or password',
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
    this.connected = false
    this.authEpoch += 1
    this.cache.clear()
    this.diRuntime?.invalidate()
    const upstream = this.gc.client as any
    upstream.oauth1Token = undefined
    upstream.oauth2Token = undefined
  }

  /** Lazily connect on first use. Failures are logged and rethrown to the caller. */
  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect()
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    await this.ensureConnected()

    for (let i = 0; i <= retries; i++) {
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
        if (i === retries) throw err
        
        const status = getHttpStatus(err)
        
        // Session expired -> auto-reconnect
        if (status === 401 || status === 403) {
          if (this.diSessionSelected) {
            if (status === 401) {
              this.rejectConfiguredSessionToken()
              throw new PublicToolError(DI_SESSION_REJECTED_MESSAGE)
            }
            throw err
          }
          if (this.hasConfiguredSession() && !this.sessionTokenRejected) {
            // A configured token and password can belong to different Garmin
            // accounts. Never carry health data across that identity boundary.
            this.rejectConfiguredSessionToken()
            if (!this.config.password?.trim()) {
              throw new PublicToolError(
                'Garmin session token was rejected; provide a new token or password',
              )
            }
          }
          this.log('warn', '[garmin] Session expired, reconnecting…')
          this.connected = false
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

  private discardStaleRefresh(): void {
    this.connected = false
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
      const status = getHttpStatus(error)
      if (status === 401 || status === 403) {
        if (this.diSessionSelected && status === 403) throw error
        if (this.hasConfiguredSession() && !this.sessionTokenRejected) {
          this.rejectConfiguredSessionToken()
        } else {
          this.connected = false
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
