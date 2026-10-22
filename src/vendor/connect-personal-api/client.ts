/*
 * Copyright 2026 Garmin Ltd. or its subsidiaries.
 * Copyright 2026 李二牛 (Likenttt)
 * SPDX-License-Identifier: Apache-2.0
 * Changed: community TypeScript translation; guarded fetch, memory-only token
 * cache, single-flight refresh, bounded bodies, validation, and generated types.
 * Python reference: ac111a0ff8e37dfbc24c616fcc27691520c7278b. See NOTICE.
 */
import { PersonalApiError } from './errors.js';
import { date, range, positiveId, integer } from './validation.js';
import type { PersonalApiResponses as Responses } from './generated.js';

export const REGION_BASE_URLS = Object.freeze({
  global: 'https://personal.connectapi.garmin.com',
  cn: 'https://personal.connectapi.garmin.cn',
});
export type PersonalApiRegion = keyof typeof REGION_BASE_URLS;
export const DEFAULT_BASE_URL = REGION_BASE_URLS.global;
export const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
export type SecretProvider = string | (() => string | Promise<string>);
export type QueryValue = string | number | boolean;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[] | undefined>;

export interface GarminPersonalApiClientOptions {
  apiKey?: SecretProvider;
  bearerToken?: SecretProvider;
  /** Explicit account region; cn routes to .cn but service availability needs verification. */
  region?: PersonalApiRegion;
  /** Explicitly trusted HTTPS origin. No path, query, fragment, or credentials. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxDownloadBytes?: number;
  maxJsonBytes?: number;
  /** Millisecond clock, for deterministic applications and tests. */
  clock?: () => number;
}

export interface ActivitySearchOptions {
  start?: number;
  limit?: number;
  favorite?: number;
  sortOrder?: 'asc' | 'desc';
  excludeChildren?: boolean;
  sortBy?: string;
  search?: string;
  activityType?: string;
  activitySubType?: string;
  eventType?: string;
  minDistance?: number;
  maxDistance?: number;
  minDuration?: number;
  maxDuration?: number;
  minElevation?: number;
  maxElevation?: number;
  startDate?: string;
  endDate?: string;
  upperLatitude?: number;
  rightLongitude?: number;
  lowerLatitude?: number;
  leftLongitude?: number;
  lowerMaxDepth?: number;
  upperMaxDepth?: number;
  decoDive?: boolean;
  minElapsedDuration?: number;
  maxElapsedDuration?: number;
  minBottomTime?: number;
  maxBottomTime?: number;
  minAvgPower?: number;
  excludedActivitySubType?: readonly string[];
  requiredField?: readonly string[];
}

interface CachedToken { value: string; expiresAt: number }
interface PendingToken { epoch: number; promise: Promise<string> }
interface RawResponse { status: number; bytes: Uint8Array; retryAfterSeconds?: number }

/** Read-only Personal API client. Credentials and tokens stay in private memory. */
export class GarminPersonalApiClient {
  #baseUrl: string;
  #apiKey: SecretProvider | undefined;
  #bearerToken: SecretProvider | undefined;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #maxDownloadBytes: number;
  #maxJsonBytes: number;
  #clock: () => number;
  #token: CachedToken | undefined;
  #pendingToken: PendingToken | undefined;
  #credentialEpoch = 0;

  constructor(options: GarminPersonalApiClientOptions) {
    if (!options || (options.apiKey === undefined) === (options.bearerToken === undefined)) {
      throw new PersonalApiError('Provide exactly one of apiKey or bearerToken.');
    }
    if (options.region !== undefined && options.region !== 'global' && options.region !== 'cn') {
      throw new PersonalApiError('region must be global or cn.');
    }
    let base: URL;
    try { base = new URL(options.baseUrl ?? REGION_BASE_URLS[options.region ?? 'global']); }
    catch { throw new PersonalApiError('baseUrl must be a trusted HTTPS origin.'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new PersonalApiError('baseUrl must be a trusted HTTPS origin without a path or credentials.');
    }
    this.#baseUrl = base.origin;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxDownloadBytes = options.maxDownloadBytes ?? 32 * 1024 * 1024;
    this.#maxJsonBytes = options.maxJsonBytes ?? 16 * 1024 * 1024;
    for (const value of [this.#timeoutMs, this.#maxDownloadBytes, this.#maxJsonBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new PersonalApiError('Timeout and response limits must be positive int32 values.');
      }
    }
    this.#apiKey = options.apiKey;
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? Date.now;
    if (typeof this.#fetch !== 'function') throw new PersonalApiError('A fetch implementation is required.');
  }

  get baseUrl(): string { return this.#baseUrl; }

  /** Invalidate cached and in-flight credentials, including pending data reads. */
  clearToken(): void {
    this.#credentialEpoch++;
    this.#token = undefined;
    this.#pendingToken = undefined;
  }

  /** GET a same-origin relative API path; token exchange is never exposed here. */
  async get<T = unknown>(relativePath: string, params?: QueryParams): Promise<T | null> {
    const epoch = this.#credentialEpoch;
    const bytes = await this.#read(relativePath, params, 'application/json', this.#maxJsonBytes);
    this.#assertEpoch(epoch);
    if (bytes.byteLength === 0) return null;
    try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
    catch { throw new PersonalApiError('Personal API returned invalid JSON.', 'INVALID_RESPONSE'); }
  }

  getUserProfileSettings() {
    return this.get<Responses['/userprofile-service/userprofile/settings']>('/userprofile-service/userprofile/settings');
  }
  getDailySleep(calendarDate: string) {
    return this.get<Responses['/sleep-service/sleep/dailySleep']>('/sleep-service/sleep/dailySleep', { date: date(calendarDate) });
  }
  getDailySleepSummaries(startDate: string, endDate: string) {
    range(startDate, endDate, 31);
    return this.get<Responses['/sleep-service/sleep/dailySleepSummariesByDate']>('/sleep-service/sleep/dailySleepSummariesByDate', { startDate, endDate });
  }
  getDailySteps(startDate: string, endDate: string) {
    range(startDate, endDate, 28);
    return this.get<Responses['/usersummary-service/stats/steps/daily/{startDate}/{endDate}']>(`/usersummary-service/stats/steps/daily/${startDate}/${endDate}`);
  }
  getDailyStress(startDate: string, endDate: string) {
    range(startDate, endDate, 28);
    return this.get<Responses['/usersummary-service/stats/stress/daily/{startDate}/{endDate}']>(`/usersummary-service/stats/stress/daily/${startDate}/${endDate}`);
  }
  getDailyHydration(startDate: string, endDate: string) {
    range(startDate, endDate, 31);
    return this.get<Responses['/usersummary-service/stats/hydration/daily/{startDate}/{endDate}']>(`/usersummary-service/stats/hydration/daily/${startDate}/${endDate}`);
  }
  getEffectiveWeightGoals(startDate: string, endDate: string) {
    range(startDate, endDate);
    return this.get<Responses['/goal-service/goal/user/effective/weightgoal/{startDate}/{endDate}']>(`/goal-service/goal/user/effective/weightgoal/${startDate}/${endDate}`);
  }
  /** Python-compatible weight/range wrapper, with includeAll=true by default. */
  getWeightMeasurements(startDate: string, endDate: string, options: { includeAll?: boolean } = {}) {
    range(startDate, endDate);
    return this.get<Responses['/weight-service/weight/range/{startDate}/{endDate}']>(`/weight-service/weight/range/${startDate}/${endDate}`, { includeAll: options.includeAll ?? true });
  }
  getAllWeightMeasurements(startDate: string, endDate: string) {
    range(startDate, endDate);
    return this.get<Responses['/weight-service/weight/all/{startDate}/{endDate}']>(`/weight-service/weight/all/${startDate}/${endDate}`);
  }
  getDailyFoodLogs(calendarDate: string, options: { includeGoals?: boolean; includeNutrition?: boolean; includeMedia?: boolean; mealId?: number } = {}) {
    if (options.mealId !== undefined) integer(options.mealId, 'mealId', 1, Number.MAX_SAFE_INTEGER);
    return this.get<Responses['/nutrition-service/food/logs/{date}']>(`/nutrition-service/food/logs/${date(calendarDate)}`, options);
  }
  getDailyBodyBattery(startDate: string, endDate: string, options: { chunks?: number } = {}) {
    range(startDate, endDate, 31);
    if (options.chunks !== undefined) integer(options.chunks, 'chunks', 1, 2_147_483_647);
    return this.get<Responses['/wellness-service/wellness/bodyBattery/reports/daily']>('/wellness-service/wellness/bodyBattery/reports/daily', { startDate, endDate, ...options });
  }
  getDailySummaries(startDate: string, endDate: string) {
    range(startDate, endDate, 366);
    return this.get<Responses['/usersummary-service/v2/dailysummaries']>('/usersummary-service/v2/dailysummaries', { startDate, endDate });
  }
  getDailySummary(calendarDate: string) {
    return this.get<Responses['/usersummary-service/usersummary/daily']>('/usersummary-service/usersummary/daily', { calendarDate: date(calendarDate) });
  }
  getDailyHrv(calendarDate: string) {
    return this.get<Responses['/hrv-service/hrv/{calendarDate}']>(`/hrv-service/hrv/${date(calendarDate)}`);
  }
  getDailyHrvSummaries(startDate: string, endDate: string) {
    range(startDate, endDate);
    return this.get<Responses['/hrv-service/hrv/daily/{fromDate}/{toDate}']>(`/hrv-service/hrv/daily/${startDate}/${endDate}`);
  }
  getHeartRateZones(options: { generateDefaults?: boolean } = {}) {
    return this.get<Responses['/biometric-service/heartRateZones/v2']>('/biometric-service/heartRateZones/v2', options);
  }
  getFitnessAge(calendarDate: string, options: { fullHistoryScan?: boolean } = {}) {
    return this.get<Responses['/fitnessage-service/fitnessage/v2/{calendarDate}']>(`/fitnessage-service/fitnessage/v2/${date(calendarDate)}`, options);
  }
  getDailyHeartRate(calendarDate: string) {
    return this.get<Responses['/wellness-service/wellness/dailyHeartRate']>('/wellness-service/wellness/dailyHeartRate', { date: date(calendarDate) });
  }
  getMenstrualCycleSummary(calendarDate: string) {
    return this.get<Responses['/periodichealth-service/menstrualcycle/summary/{calendarDate}']>(`/periodichealth-service/menstrualcycle/summary/${date(calendarDate)}`);
  }
  getMenstrualCycleDayView(calendarDate: string, todayDate: string, options: { reducedResponse?: boolean; skipbm?: boolean; includeAnalysis?: boolean } = {}) {
    return this.get<Responses['/periodichealth-service/menstrualcycle/dayview/{calendarDate}']>(`/periodichealth-service/menstrualcycle/dayview/${date(calendarDate)}`, { todayDate: date(todayDate), ...options });
  }
  getDailySpO2(calendarDate: string) {
    return this.get<Responses['/wellness-service/wellness/daily/spo2acclimation/{calendarDate}']>(`/wellness-service/wellness/daily/spo2acclimation/${date(calendarDate)}`);
  }
  getWellnessActivitySummaries(startDate: string, endDate: string) {
    range(startDate, endDate);
    return this.get<Responses['/wellnessactivity-service/activity/summary/range/{fromDate}/{untilDate}']>(`/wellnessactivity-service/activity/summary/range/${startDate}/${endDate}`);
  }
  searchActivities(options: ActivitySearchOptions = {}) {
    const params = { ...options, start: options.start ?? 0, limit: options.limit ?? 20 };
    integer(params.start, 'start', 0, 2_147_483_647);
    integer(params.limit, 'limit', 1, 100);
    if (options.startDate) date(options.startDate);
    if (options.endDate) date(options.endDate);
    if (options.startDate && options.endDate) range(options.startDate, options.endDate);
    if (options.sortOrder !== undefined && options.sortOrder !== 'asc' && options.sortOrder !== 'desc') {
      throw new PersonalApiError('sortOrder must be asc or desc.');
    }
    return this.get<Responses['/activitylist-service/activities/search/activities']>('/activitylist-service/activities/search/activities', params);
  }
  getActivity(activityId: number | string) {
    return this.get<Responses['/activity-service/activity/{activityId}']>(`/activity-service/activity/${positiveId(activityId)}`);
  }
  getActivityWorkouts(activityId: number | string) {
    return this.get<Responses['/activity-service/activity/{activityId}/workouts']>(`/activity-service/activity/${positiveId(activityId)}/workouts`);
  }
  /** Original ZIP bytes; no extraction, file writes, or content normalization. */
  async downloadActivity(activityId: number | string): Promise<Uint8Array> {
    const epoch = this.#credentialEpoch;
    const bytes = await this.#read(`/download-service/files/activity/${positiveId(activityId)}`, undefined, 'application/zip, application/x-zip-compressed, application/octet-stream', this.#maxDownloadBytes);
    this.#assertEpoch(epoch);
    if (!bytes.byteLength) throw new PersonalApiError('The activity download was empty.', 'INVALID_RESPONSE');
    return bytes;
  }

  #url(path: string, params?: QueryParams): URL {
    if (typeof path !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith('//') || path.split('/').some(part => part === '.' || part === '..')) {
      throw new PersonalApiError('Use a relative API path without a host, query, fragment, or traversal.');
    }
    if (path.startsWith('/personalapitoken-service')) {
      throw new PersonalApiError('Token exchange is internal and cannot be called through get().');
    }
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl) throw new PersonalApiError('Cross-origin requests are not allowed.');
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!['string', 'boolean', 'number'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) {
          throw new PersonalApiError('Query parameters must be finite scalars or scalar arrays.');
        }
        url.searchParams.append(key, String(item));
      }
    }
    return url;
  }

  async #read(path: string, params: QueryParams | undefined, accept: string, maxBytes: number): Promise<Uint8Array> {
    const url = this.#url(path, params);
    const epoch = this.#credentialEpoch;
    let token = await this.#getToken(epoch);
    this.#assertEpoch(epoch);
    let response = await this.#fetchBytes('GET', url, `Bearer ${token}`, accept, maxBytes);
    this.#assertEpoch(epoch);
    if (response.status === 401) {
      token = await this.#getToken(epoch, token);
      this.#assertEpoch(epoch);
      response = await this.#fetchBytes('GET', url, `Bearer ${token}`, accept, maxBytes);
      this.#assertEpoch(epoch);
    }
    this.#requireSuccess(response);
    return response.bytes;
  }

  async #secret(provider: SecretProvider): Promise<string> {
    let secret: unknown;
    try { secret = typeof provider === 'function' ? await provider() : provider; }
    catch { throw new PersonalApiError('Credential provider failed.', 'CREDENTIAL_ERROR'); }
    if (typeof secret !== 'string' || !secret.trim() || /[\r\n]/.test(secret) || secret.trim().length > 32768) {
      throw new PersonalApiError('A non-empty credential without line breaks is required.', 'CREDENTIAL_ERROR');
    }
    return secret.trim();
  }

  #assertEpoch(epoch: number): void {
    if (epoch !== this.#credentialEpoch) {
      throw new PersonalApiError('Credentials changed while the request was in progress. Start a new request.', 'CREDENTIAL_CHANGED');
    }
  }

  async #getToken(epoch: number, rejectedToken?: string): Promise<string> {
    this.#assertEpoch(epoch);
    if (this.#token && this.#token.value !== rejectedToken && this.#token.expiresAt > this.#clock() + 30_000) {
      return this.#token.value;
    }
    if (this.#pendingToken?.epoch === epoch) return this.#pendingToken.promise;
    this.#token = undefined;
    const pending = { epoch, promise: this.#issueToken(epoch) };
    this.#pendingToken = pending;
    try {
      const token = await pending.promise;
      this.#assertEpoch(epoch);
      return token;
    }
    finally { if (this.#pendingToken === pending) this.#pendingToken = undefined; }
  }

  async #issueToken(epoch: number): Promise<string> {
    if (this.#bearerToken !== undefined) {
      const value = await this.#secret(this.#bearerToken);
      this.#assertEpoch(epoch);
      // Opaque bearer tokens are accepted; JWTs use their expiration when present.
      const expiresAt = value.split('.').length === 3 ? this.#jwtExpiration(value) : Infinity;
      this.#token = { value, expiresAt };
      return value;
    }
    const key = await this.#secret(this.#apiKey!);
    this.#assertEpoch(epoch);
    const response = await this.#fetchBytes('POST', new URL(TOKEN_PATH, this.baseUrl), `ApiKey ${key}`, '*/*', 32768);
    this.#assertEpoch(epoch);
    this.#requireSuccess(response, 'TOKEN_EXCHANGE_FAILED');
    const value = new TextDecoder().decode(response.bytes).trim();
    const expiresAt = this.#jwtExpiration(value);
    this.#token = { value, expiresAt };
    return value;
  }

  #jwtExpiration(value: string): number {
    try {
      const parts = value.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) throw new Error();
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp * 1000 <= this.#clock()) throw new Error();
      return payload.exp * 1000;
    } catch {
      throw new PersonalApiError('Token response must be an unexpired JWT with an exp claim.', 'INVALID_TOKEN');
    }
  }

  #requireSuccess(response: RawResponse, code = 'HTTP_ERROR'): void {
    if (response.status < 200 || response.status >= 300) {
      throw new PersonalApiError(`Personal API request failed (HTTP ${response.status}).`, code, response.status, response.retryAfterSeconds);
    }
  }

  async #fetchBytes(method: 'GET' | 'POST', url: URL, authorization: string, accept: string, maxBytes: number): Promise<RawResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PersonalApiError('Personal API request timed out.', 'TIMEOUT'));
      }, this.#timeoutMs);
    });
    const request = async (): Promise<RawResponse> => {
      const response = await this.#fetch(url, {
        method, redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: authorization, Accept: accept },
      });
      // Also guard custom/injected fetch implementations that ignored redirect.
      if ((response.url && new URL(response.url).origin !== this.baseUrl) || response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        throw new PersonalApiError('Redirected API responses are not allowed.', 'REDIRECT_REJECTED');
      }
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
        await response.body?.cancel();
        throw new PersonalApiError('Personal API returned an invalid response status.', 'INVALID_RESPONSE');
      }
      // Never retain a remote error body: it could echo authentication headers.
      if (!response.ok) {
        await response.body?.cancel();
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
        return { status: response.status, bytes: new Uint8Array(), ...(seconds !== undefined && Number.isSafeInteger(seconds) ? { retryAfterSeconds: seconds } : {}) };
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
        await response.body?.cancel();
        throw new PersonalApiError('Personal API response exceeded the configured size limit.', 'RESPONSE_TOO_LARGE');
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, bytes: new Uint8Array() };
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new PersonalApiError('Personal API response exceeded the configured size limit.', 'RESPONSE_TOO_LARGE');
          }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, bytes };
    };
    try { return await Promise.race([request(), timeout]); }
    catch (error) {
      if (error instanceof PersonalApiError) throw error;
      // Deliberately drop fetch exceptions and causes: URLs/headers may be secrets.
      throw new PersonalApiError('Personal API network request failed.', 'NETWORK_ERROR');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
