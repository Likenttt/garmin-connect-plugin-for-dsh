import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config'
import type { GarminClientLike } from './client'
import { MAX_ZIP_BYTES } from './fit-export'
import { GarminPersonalApiClient, PersonalApiError } from './vendor/connect-personal-api/index'
import { MemoryCache } from './utils/cache'
import { PublicToolError } from './utils/errors'

type PersonalSdk = GarminPersonalApiClient

/** Adapter with a separate credential, cache, and lifecycle from browser SSO. */
export class GarminPersonalClient implements GarminClientLike {
  private active = true
  private connected = false
  private connecting?: Promise<void>
  private sdk?: PersonalSdk
  private readonly cache: MemoryCache

  constructor(private readonly config: Config, sdk?: PersonalSdk) {
    this.cache = new MemoryCache(config.cacheTtl)
    this.sdk = sdk ?? new GarminPersonalApiClient({
      apiKey: () => readPersonalApiKey(config),
      region: config.region,
      timeoutMs: config.requestTimeoutMs ?? 15_000,
      maxDownloadBytes: MAX_ZIP_BYTES,
    })
  }

  deactivate(): void {
    this.active = false
    this.connected = false
    this.cache.clear()
    this.sdk?.clearToken()
    this.sdk = undefined
  }

  personalApiConnected(): boolean { return this.active && this.connected }
  // Personal settings do not establish an email identity for the SSO UI.
  getAuthenticatedAccount(): undefined { return undefined }
  getAuthenticationRequirement(): undefined { return undefined }

  async connect(): Promise<void> {
    this.assertActive()
    if (!this.connecting) {
      const request = this.request(sdk => sdk.getUserProfileSettings()).then(profile => {
        if (!isRecord(profile) || !['displayName', 'measurementSystem', 'timeZone'].some(key => Object.hasOwn(profile, key))) {
          throw new PublicToolError('Garmin Personal API did not return valid account settings')
        }
        this.assertActive()
        this.connected = true
        this.cache.invalidate('profile')
      })
      let tracked: Promise<void>
      tracked = request.catch(error => { this.connected = false; throw error }).finally(() => {
        if (this.connecting === tracked) this.connecting = undefined
      })
      this.connecting = tracked
    }
    return this.connecting
  }

  private assertActive(): void {
    if (!this.active || !this.sdk) throw new PublicToolError('Garmin account configuration changed; retry with the current account')
  }

  private async request<T>(action: (sdk: PersonalSdk) => Promise<T>): Promise<T> {
    this.assertActive()
    try {
      const result = await action(this.sdk!)
      this.assertActive()
      return result
    } catch (error) {
      this.assertActive()
      if (error instanceof PublicToolError) throw error
      if (error instanceof PersonalApiError) {
        if (error.status === 401 || error.status === 403 || error.status === 404) this.connected = false
        if (error.status === 404) {
          throw new PublicToolError('Garmin Personal API did not recognize the API Key or resource (HTTP 404). Check the key and account availability in plugin settings.')
        }
        if (error.status === 401 || error.status === 403) {
          throw new PublicToolError(`Garmin Personal API access failed (HTTP ${error.status}). Check the API Key, expiration, and account permissions in plugin settings.`)
        }
        if (error.status === 429) throw new PublicToolError('Garmin Personal API rate limit reached; wait before retrying')
        if (error.status === 526) throw new PublicToolError('Garmin Personal API endpoint is currently unavailable (HTTP 526). Keep the selected region and retry later.')
        throw new PublicToolError(`Garmin Personal API: ${error.message}`)
      }
      throw new PublicToolError('Garmin Personal API request failed; check the local API Key configuration and connection')
    }
  }

  private async read<T>(key: string, action: (sdk: PersonalSdk) => Promise<T>): Promise<T> {
    this.assertActive()
    if (!this.connected) await this.connect()
    const result = await this.cache.getOrSet(key, () => this.request(action))
    this.assertActive()
    return result
  }

  async getActivities(start = 0, limit = 10): Promise<unknown[]> {
    const result = await this.read(`activities:${start}:${limit}`, sdk => sdk.searchActivities({ start, limit }))
    if (result === null) return []
    if (!Array.isArray(result)) throw new PublicToolError('Garmin Personal API returned an invalid activity list')
    return result
  }
  getSteps(date: string): Promise<unknown> {
    return this.read(`steps:${date}`, sdk => sdk.getDailySteps(date, date))
  }
  getSleep(date: string): Promise<unknown> { return this.read(`sleep:${date}`, sdk => sdk.getDailySleep(date)) }
  getHeartRate(date: string): Promise<unknown> { return this.read(`hr:${date}`, sdk => sdk.getDailyHeartRate(date)) }
  getWeight(date: string): Promise<unknown> { return this.read(`weight:${date}`, sdk => sdk.getWeightMeasurements(date, date)) }
  getHrvData(date: string): Promise<unknown> { return this.read(`hrv:${date}`, sdk => sdk.getDailyHrv(date)) }
  getHrvSummaries(start: string, end: string): Promise<unknown> {
    return this.read(`hrv:${start}:${end}`, sdk => sdk.getDailyHrvSummaries(start, end))
  }
  getSpO2Data(date: string): Promise<unknown> { return this.read(`spo2:${date}`, sdk => sdk.getDailySpO2(date)) }
  async getRespirationData(date: string): Promise<unknown> {
    const response = await this.read(`respiration:${date}`, sdk => sdk.getDailySummaries(date, date))
    const data = isRecord(response) && Array.isArray(response.data) ? response.data : []
    return {
      provider: 'personal', resolution: 'daily_summary', calendarDate: date,
      respiration: data.filter(isRecord).map(day => ({
        calendarDate: day.calendarDate ?? date, respiration: day.respiration ?? null,
      })),
      note: 'Daily respiration summaries only; the official Personal API does not publish a full-day respiration time-series endpoint.',
    }
  }
  async getStressData(date: string): Promise<unknown> {
    const data = await this.read(`stress:${date}`, sdk => sdk.getDailyStress(date, date))
    return { provider: 'personal', resolution: 'daily_summary', calendarDate: date, data }
  }
  getStressSummaries(start: string, end: string): Promise<unknown> {
    return this.read(`stress:${start}:${end}`, sdk => sdk.getDailyStress(start, end))
  }
  getBodyBattery(start: string, end = start): Promise<unknown> {
    return this.read(`battery:${start}:${end}`, sdk => sdk.getDailyBodyBattery(start, end))
  }
  getUserProfile(): Promise<unknown> { return this.read('profile', sdk => sdk.getUserProfileSettings()) }

  async downloadOriginalActivityZip(activityId: number, destinationDir: string): Promise<string> {
    if (!Number.isSafeInteger(activityId) || activityId <= 0) throw new PublicToolError('Invalid activityId: expected a positive integer')
    if (!destinationDir?.trim()) throw new PublicToolError('The activity download directory is invalid')
    if (!this.connected) await this.connect()
    const bytes = await this.request(sdk => sdk.downloadActivity(activityId))
    this.assertActive()
    const path = join(destinationDir, `${activityId}.zip`)
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    this.assertActive()
    return path
  }

  private unsupported(): never {
    throw new PublicToolError('This operation is not available through the official Garmin Personal API. Select a browser-login account that supports it.')
  }
  async getWorkouts(): Promise<never> { return this.unsupported() }
  async getWorkoutDetail(): Promise<never> { return this.unsupported() }
  async getScheduledWorkouts(): Promise<never> { return this.unsupported() }
  async getScheduledWorkout(): Promise<never> { return this.unsupported() }
  async scheduleWorkout(): Promise<never> { return this.unsupported() }
  async deleteWorkout(): Promise<never> { return this.unsupported() }
  async unscheduleWorkout(): Promise<never> { return this.unsupported() }
  async addWorkout(): Promise<never> { return this.unsupported() }
  async getTrainingReadiness(): Promise<never> { return this.unsupported() }
  async getDailyTrainingStatus(): Promise<never> { return this.unsupported() }
  async getTrainingStatus(): Promise<never> { return this.unsupported() }
  async getTrainingLoadBalance(): Promise<never> { return this.unsupported() }
  async getMaxMetrics(): Promise<never> { return this.unsupported() }
  async getMaxMetricsRange(): Promise<never> { return this.unsupported() }
  async getRacePredictions(): Promise<never> { return this.unsupported() }
  async getRacePredictionsRange(): Promise<never> { return this.unsupported() }
  async replacePersistedSession(): Promise<never> { return this.unsupported() }
  async exportSession(): Promise<never> { return this.unsupported() }
}

async function readPersonalApiKey(config: Config): Promise<string> {
  if (config.personalApiKeyFile?.trim()) {
    let handle
    try {
      handle = await open(config.personalApiKeyFile.trim(), 'r')
      const info = await handle.stat()
      if (!info.isFile() || info.size < 1 || info.size > 64 * 1024) throw new Error('invalid key file')
      const key = (await handle.readFile('utf8')).trim()
      if (!key || /\s/.test(key)) throw new Error('invalid key')
      return key
    } catch { throw new PublicToolError('Cannot read a valid Personal API Key from the configured local key file') }
    finally { await handle?.close().catch(() => undefined) }
  }
  const key = config.personalApiKey?.trim()
  if (!key || /\s/.test(key)) throw new PublicToolError('Configure a valid Personal API Key in plugin settings or GARMIN_PERSONAL_API_KEY_FILE')
  return key
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
