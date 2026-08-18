import { Context } from 'cordis'
import { GarminConnect } from 'garmin-connect'
import type { Config } from './config'
import { MemoryCache } from './utils/cache'

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
  private connected = false

  constructor(ctx: Context, config: Config) {
    this.ctx = ctx
    this.config = config
    this.cache = new MemoryCache(config.cacheTtl)

    this.gc = new GarminConnect({
      username: config.username,
      password: config.password ?? '',
    })
  }

  // ---------- Lifecycle ---------------------------------------------------

  async connect(): Promise<void> {
    try {
      if (this.config.sessionToken) {
        this.ctx.logger.info('[garmin] Restoring session from token…')
        const tokens = JSON.parse(this.config.sessionToken)
        this.gc.loadToken(tokens.oauth1, tokens.oauth2)
      } else {
        this.ctx.logger.info('[garmin] Logging in with username/password…')
        await this.gc.login()
      }
      this.connected = true
      this.ctx.logger.info('[garmin] ✅ Connected successfully.')
    } catch (err) {
      this.ctx.logger.error('[garmin] ❌ Connection failed:', err)
      throw err
    }
  }

  destroy(): void {
    this.cache.clear()
    this.connected = false
    this.ctx.logger.info('[garmin] Session destroyed.')
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('[garmin] Not connected. Call connect() first.')
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    this.ensureConnected()

    for (let i = 0; i <= retries; i++) {
      try {
        return await fn()
      } catch (err: any) {
        if (i === retries) throw err
        
        const status = err?.response?.status || err?.status
        
        // Session expired -> auto-reconnect
        if (status === 401 || status === 403) {
          this.ctx.logger.warn('[garmin] Session expired, reconnecting…')
          await this.connect()
          continue
        }
        
        // Rate limited -> exponential backoff
        if (status === 429) {
          const delay = Math.pow(2, i) * 1000
          this.ctx.logger.warn(`[garmin] Rate limited, waiting ${delay}ms…`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        
        throw err
      }
    }
    throw new Error('Unreachable')
  }

  // ---------- Data accessors (cached) ------------------------------------

  /** Return the most recent activities. */
  async getActivities(start = 0, limit = 10): Promise<unknown[]> {
    return this.withRetry(() => {
      const key = `activities:${start}:${limit}`
      return this.cache.getOrSet(key, () => this.gc.getActivities(start, limit))
    })
  }

  /** Return step count data for a given date (YYYY-MM-DD). */
  async getSteps(date: string): Promise<unknown> {
    return this.withRetry(() => {
      return this.cache.getOrSet(`steps:${date}`, () => this.gc.getSteps(new Date(date)))
    })
  }

  /** Return sleep data for a given date (YYYY-MM-DD). */
  async getSleep(date: string): Promise<unknown> {
    return this.withRetry(() => {
      return this.cache.getOrSet(`sleep:${date}`, () => this.gc.getSleepData(new Date(date)))
    })
  }

  /** Return heart rate data for a given date (YYYY-MM-DD). */
  async getHeartRate(date: string): Promise<unknown> {
    return this.withRetry(() => {
      return this.cache.getOrSet(`hr:${date}`, () => this.gc.getHeartRate(new Date(date)))
    })
  }

  /** Return weight/body composition data for a given date (YYYY-MM-DD). */
  async getWeight(date: string): Promise<unknown> {
    return this.withRetry(() => {
      return this.cache.getOrSet(`weight:${date}`, () => this.gc.getDailyWeightData(new Date(date)))
    })
  }

  /** Return planned workouts/calendar. */
  async getWorkouts(start = 0, limit = 10): Promise<unknown[]> {
    return this.withRetry(() => {
      const key = `workouts:${start}:${limit}`
      return this.cache.getOrSet(key, () => this.gc.getWorkouts(start, limit))
    })
  }

  /** Return user profile summary. */
  async getUserProfile(): Promise<unknown> {
    return this.withRetry(() => {
      return this.cache.getOrSet('profile', () => this.gc.getUserProfile())
    })
  }

  /** Export a session token so it can be stored securely for future logins. */
  async exportSession(): Promise<string> {
    this.ensureConnected()
    return JSON.stringify(this.gc.exportToken())
  }

  isConnected(): boolean {
    return this.connected
  }
}
