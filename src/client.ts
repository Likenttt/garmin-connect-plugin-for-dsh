import { Context } from 'cordis'
import { GarminConnect } from 'garmin-connect'
import type { Config } from './config'
import { MemoryCache } from './utils/cache'

/**
 * Thin wrapper around the `garmin-connect` npm package that adds:
 *   - Cordis-aware logging
 *   - Automatic session persistence / restore
 *   - An in-memory cache to reduce API calls and avoid rate limits
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
        // Restore a previously captured session — no password needed
        this.ctx.logger.info('[garmin] Restoring session from token…')
        await this.gc.restoreLogin(this.config.sessionToken)
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

  // ---------- Data accessors (cached) ------------------------------------

  /** Return the most recent activities. */
  async getActivities(start = 0, limit = 10): Promise<unknown[]> {
    const key = `activities:${start}:${limit}`
    return this.cache.getOrSet(key, () => this.gc.getActivities(start, limit))
  }

  /** Return step count data for a given date (YYYY-MM-DD). */
  async getSteps(date: string): Promise<unknown> {
    return this.cache.getOrSet(`steps:${date}`, () => this.gc.getSteps(date))
  }

  /** Return sleep data for a given date (YYYY-MM-DD). */
  async getSleep(date: string): Promise<unknown> {
    return this.cache.getOrSet(`sleep:${date}`, () => this.gc.getSleepData(date))
  }

  /** Return heart rate data for a given date. */
  async getHeartRate(date: string): Promise<unknown> {
    return this.cache.getOrSet(`hr:${date}`, () => this.gc.getHeartRate(date))
  }

  /** Return user profile summary. */
  async getUserProfile(): Promise<unknown> {
    return this.cache.getOrSet('profile', () => this.gc.getUserProfile())
  }

  /** Export a session token so it can be stored securely for future logins. */
  async exportSession(): Promise<string> {
    return this.gc.exportToken()
  }

  isConnected(): boolean {
    return this.connected
  }
}
