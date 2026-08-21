import axios from 'axios'
import { resolve } from 'node:path'
import type { GarminRegion } from './config'
import {
  GARMIN_DI_CLIENT_ID,
  isDiSessionFile,
  sessionFileMatchesAccount,
  sessionFileMatchesProfile,
  type GarminDiSessionFile,
  writeSessionTokenFile,
} from './session-store'
import { PublicToolError } from './utils/errors'

const ACCESS_REFRESH_WINDOW_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_REFRESH_RESPONSE_BYTES = 64 * 1024
const MAX_PROFILE_RESPONSE_BYTES = 256 * 1024
const DI_REFRESH_FAILED_MESSAGE = 'Garmin DI session could not be refreshed'
const DI_SESSION_EXPIRED_MESSAGE =
  'Garmin DI session has expired; run garmin-connect-auth login --browser again'
const DI_SESSION_REJECTED_MESSAGE =
  'Garmin DI session was rejected; run garmin-connect-auth login --browser again'
const DI_PERSIST_FAILED_MESSAGE = 'Garmin DI session could not be persisted'

interface SharedSessionState {
  binding: string
  session: GarminDiSessionFile
  owners: number
  refreshPromise?: Promise<GarminDiSessionFile>
  pendingSession?: GarminDiSessionFile
  persistPromise?: Promise<GarminDiSessionFile>
  terminal?: 'expired' | 'rejected'
}

const sharedSessionByPath = new Map<string, SharedSessionState>()

export interface GarminDiRefreshResult {
  status: number
  contentType: string
  body: unknown
}

export interface GarminDiSessionRuntimeDependencies {
  now(): number
  refresh(input: {
    region: GarminRegion
    refreshToken: string
    timeoutMs: number
    method: 'POST'
    url: string
    headers: Record<string, string>
    body: string
    maxResponseBytes: number
  }): Promise<GarminDiRefreshResult>
  probeProfile(input: {
    region: GarminRegion
    accessToken: string
    timeoutMs: number
    method: 'GET'
    url: string
    headers: Record<string, string>
    maxResponseBytes: number
  }): Promise<GarminDiRefreshResult>
  writeSession(path: string, session: GarminDiSessionFile): Promise<void>
}

export interface GarminDiSessionRuntimeOptions {
  username: string
  region: GarminRegion
  session: GarminDiSessionFile
  sessionPath: string
  requestTimeoutMs?: number
  dependencies: GarminDiSessionRuntimeDependencies
}

/** Production HTTP/file boundaries for a DI runtime. */
export function createGarminDiSessionRuntimeDependencies(): GarminDiSessionRuntimeDependencies {
  return {
    now: Date.now,
    refresh: requestDiEndpoint,
    probeProfile: requestDiEndpoint,
    writeSession: writeSessionTokenFile,
  }
}

/**
 * Installs DI bearer authentication on the Garmin SDK's Axios instance.
 * Tokens are attached only to the configured regional Connect API origin.
 */
export class GarminDiSessionRuntime {
  private readonly connectApiOrigin: string
  private readonly diTokenUrl: string
  private readonly profileUrl: string
  private readonly binding: string
  private readonly sessionPath: string
  private readonly shared: SharedSessionState
  private invalidated = false
  private released = false

  constructor(private readonly options: GarminDiSessionRuntimeOptions) {
    if (!sessionFileMatchesAccount(options.session, options.username, options.region)) {
      throw new PublicToolError(
        'Garmin session token file does not match the configured account or region',
      )
    }
    const domain = options.region === 'cn' ? 'garmin.cn' : 'garmin.com'
    this.connectApiOrigin = `https://connectapi.${domain}`
    this.diTokenUrl = `https://diauth.${domain}/di-oauth2-service/oauth/token`
    this.profileUrl = `${this.connectApiOrigin}/userprofile-service/socialProfile`
    this.binding = sessionBinding(options.session)
    this.sessionPath = resolve(options.sessionPath)
    const shared = sharedSessionByPath.get(this.sessionPath)
    if (shared !== undefined && shared.binding !== this.binding) {
      throw new PublicToolError(
        'Garmin DI session file cannot be shared across account bindings',
      )
    }
    this.shared = shared ?? {
      binding: this.binding,
      session: options.session,
      owners: 0,
    }
    this.shared.owners += 1
    if (!shared) sharedSessionByPath.set(this.sessionPath, this.shared)
  }

  install(client: any): void {
    clearInterceptors(client.interceptors.request)
    clearInterceptors(client.interceptors.response)
    client.interceptors.request.use(async (config: any) => {
      if (requestOrigin(config.url, config.baseURL) !== this.connectApiOrigin) {
        return config
      }
      await this.ensureFreshAccessToken()
      this.assertActive()
      config.maxRedirects = 0
      const headers = nativeHeaders()
      if (config.headers && typeof config.headers.set === 'function') {
        for (const [name, value] of Object.entries(headers)) {
          config.headers.set(name, value)
        }
        config.headers.set('Authorization', `Bearer ${this.shared.session.tokens.accessToken}`)
      } else {
        config.headers = {
          ...headers,
          ...config.headers,
          Authorization: `Bearer ${this.shared.session.tokens.accessToken}`,
        } as typeof config.headers
      }
      return config
    })
    client.interceptors.response.use(
      (response: any) => {
        if (
          requestOrigin(response?.config?.url, response?.config?.baseURL)
          === this.connectApiOrigin
        ) {
          this.assertActive()
        }
        return response
      },
      async (error: unknown) => {
        if (error instanceof PublicToolError) throw error
        const request = errorRequest(error)
        const status = errorStatus(error)
        const method = typeof request?.method === 'string'
          ? request.method.toLowerCase()
          : ''
        const mayReplay = method === 'get' || method === 'head' || method === 'options'
        if (
          status === 401
          && request
          && requestOrigin(request.url, request.baseURL) === this.connectApiOrigin
          && mayReplay
          && request.__garminDiRefreshRetried !== true
        ) {
          await this.ensureFreshAccessToken(true, requestBearerToken(request))
          this.assertActive()
          return client.request({
            ...request,
            __garminDiRefreshRetried: true,
          })
        }
        throw normalizedRequestError(status, isTimeoutError(error))
      },
    )
  }

  validateProfile(profile: unknown): void {
    const profileId = isRecord(profile) ? profile.profileId : undefined
    if (
      typeof profileId !== 'number'
      || !Number.isSafeInteger(profileId)
      || profileId <= 0
      || !sessionFileMatchesProfile(this.shared.session, profileId)
    ) {
      throw new PublicToolError(
        'Garmin DI session does not match the authenticated Garmin profile',
      )
    }
  }

  invalidate(): void {
    this.invalidated = true
    if (!this.released) {
      this.released = true
      this.shared.owners -= 1
      this.cleanupSharedState()
    }
  }

  private async ensureFreshAccessToken(
    force = false,
    rejectedAccessToken?: string,
  ): Promise<void> {
    this.assertActive()
    if (this.shared.terminal) throw terminalSessionError(this.shared.terminal)
    const nowMs = this.options.dependencies.now()
    if (!isValidNow(nowMs)) throw new PublicToolError(DI_REFRESH_FAILED_MESSAGE)
    if (this.shared.pendingSession) {
      await this.persistPendingSession()
      this.assertActive()
      return
    }
    if (
      force
      && rejectedAccessToken !== undefined
      && rejectedAccessToken !== this.shared.session.tokens.accessToken
    ) {
      return
    }
    if (
      !force
      && this.shared.session.tokens.accessExpiresAtMs > nowMs + ACCESS_REFRESH_WINDOW_MS
    ) {
      return
    }

    if (!this.shared.refreshPromise) {
      const promise = this.refreshAndPersist(nowMs).finally(() => {
        if (this.shared.refreshPromise === promise) {
          this.shared.refreshPromise = undefined
        }
        this.cleanupSharedState()
      })
      this.shared.refreshPromise = promise
    }
    const refreshed = await this.shared.refreshPromise
    if (sessionBinding(refreshed) !== this.binding) {
      throw new PublicToolError(
        'Garmin DI session file cannot be shared across account bindings',
      )
    }
    this.assertActive()
  }

  private assertActive(): void {
    if (this.invalidated) throw new PublicToolError(DI_SESSION_REJECTED_MESSAGE)
  }

  private async refreshAndPersist(nowMs: number): Promise<GarminDiSessionFile> {
    const current = this.shared.session
    const refreshExpiry = current.tokens.refreshExpiresAtMs
    if (refreshExpiry !== null && refreshExpiry <= nowMs) {
      this.shared.terminal = 'expired'
      throw new PublicToolError(DI_SESSION_EXPIRED_MESSAGE)
    }

    const refreshToken = current.tokens.refreshToken
    let response: GarminDiRefreshResult
    try {
      response = await this.options.dependencies.refresh({
        region: this.options.region,
        refreshToken,
        timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        method: 'POST',
        url: this.diTokenUrl,
        headers: {
          ...nativeHeaders(),
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${GARMIN_DI_CLIENT_ID}:`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: GARMIN_DI_CLIENT_ID,
          refresh_token: refreshToken,
        }).toString(),
        maxResponseBytes: MAX_REFRESH_RESPONSE_BYTES,
      })
    } catch (error) {
      const terminal = terminalRefreshFailure(error)
      if (terminal) {
        this.shared.terminal = terminal
        throw terminalSessionError(terminal)
      }
      throw new PublicToolError(DI_REFRESH_FAILED_MESSAGE)
    }

    const terminal = terminalRefreshResponse(response)
    if (terminal) {
      this.shared.terminal = terminal
      throw terminalSessionError(terminal)
    }

    const next = refreshedSessionFromResponse(
      response,
      current,
      nowMs,
    )
    await this.verifyRefreshedProfile(next.tokens.accessToken)
    this.shared.pendingSession = next
    return this.persistPendingSession()
  }

  private async persistPendingSession(): Promise<GarminDiSessionFile> {
    const pending = this.shared.pendingSession
    if (!pending) return this.shared.session
    if (!this.shared.persistPromise) {
      const promise = Promise.resolve()
        .then(() => this.options.dependencies.writeSession(this.sessionPath, pending))
        .then(() => {
          if (this.shared.pendingSession === pending) {
            this.shared.session = pending
            this.shared.pendingSession = undefined
          }
          return this.shared.session
        })
        .catch(() => {
          throw new PublicToolError(DI_PERSIST_FAILED_MESSAGE)
        })
        .finally(() => {
          if (this.shared.persistPromise === promise) {
            this.shared.persistPromise = undefined
          }
          this.cleanupSharedState()
        })
      this.shared.persistPromise = promise
    }
    return this.shared.persistPromise
  }

  private cleanupSharedState(): void {
    if (
      this.shared.owners === 0
      && !this.shared.refreshPromise
      && !this.shared.persistPromise
      && !this.shared.pendingSession
      && sharedSessionByPath.get(this.sessionPath) === this.shared
    ) {
      sharedSessionByPath.delete(this.sessionPath)
    }
  }

  private async verifyRefreshedProfile(accessToken: string): Promise<void> {
    let response: GarminDiRefreshResult
    try {
      response = await this.options.dependencies.probeProfile({
        region: this.options.region,
        accessToken,
        timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        method: 'GET',
        url: this.profileUrl,
        headers: {
          ...nativeHeaders(),
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        maxResponseBytes: MAX_PROFILE_RESPONSE_BYTES,
      })
    } catch {
      throw new PublicToolError(DI_REFRESH_FAILED_MESSAGE)
    }
    if (
      !Number.isInteger(response.status)
      || response.status < 200
      || response.status >= 300
      || !/^application\/json(?:\s*;|$)/i.test(response.contentType)
      || !isRecord(response.body)
    ) {
      throw new PublicToolError(DI_REFRESH_FAILED_MESSAGE)
    }
    this.validateProfile(response.body)
  }
}

function requestOrigin(url: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url, baseUrl).origin
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sessionBinding(session: GarminDiSessionFile): string {
  return [
    session.account.region,
    session.account.usernameHash,
    session.account.profileIdHash,
  ].join(':')
}

function refreshedSessionFromResponse(
  response: GarminDiRefreshResult,
  current: GarminDiSessionFile,
  nowMs: number,
): GarminDiSessionFile {
  if (
    !Number.isInteger(response.status)
    || response.status < 200
    || response.status >= 300
    || !/^application\/json(?:\s*;|$)/i.test(response.contentType)
    || !isRecord(response.body)
  ) {
    throw new PublicToolError(DI_REFRESH_FAILED_MESSAGE)
  }

  const accessToken = response.body.access_token
  const refreshToken = response.body.refresh_token === undefined
    ? current.tokens.refreshToken
    : response.body.refresh_token
  const accessExpiresIn = response.body.expires_in
  const refreshExpiresIn = response.body.refresh_token_expires_in
  const accessExpiresAtMs = expiryFromSeconds(nowMs, accessExpiresIn)
  const refreshExpiresAtMs = refreshExpiresIn === undefined
    ? current.tokens.refreshExpiresAtMs
    : expiryFromSeconds(nowMs, refreshExpiresIn)
  const candidate: GarminDiSessionFile = {
    ...current,
    tokens: {
      accessToken: typeof accessToken === 'string' ? accessToken : '',
      refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
      accessExpiresAtMs: accessExpiresAtMs ?? 0,
      refreshExpiresAtMs: refreshExpiresAtMs === undefined ? 0 : refreshExpiresAtMs,
    },
  }
  if (!isDiSessionFile(candidate)) {
    throw new PublicToolError(DI_REFRESH_FAILED_MESSAGE)
  }
  return candidate
}

function expiryFromSeconds(nowMs: number, seconds: unknown): number | undefined {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return undefined
  }
  const milliseconds = seconds * 1_000
  if (!Number.isSafeInteger(milliseconds)) return undefined
  const expiry = nowMs + milliseconds
  return Number.isSafeInteger(expiry) && expiry > nowMs ? expiry : undefined
}

function isValidNow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function terminalRefreshResponse(
  response: GarminDiRefreshResult,
): 'expired' | 'rejected' | undefined {
  if (response.status === 401 || response.status === 403) return 'rejected'
  if (!isRecord(response.body)) return undefined
  if (response.body.error === 'invalid_client') return 'rejected'
  return response.body.error === 'invalid_grant' || response.body.error === 'invalid_token'
    ? 'expired'
    : undefined
}

function terminalRefreshFailure(error: unknown): 'rejected' | undefined {
  const status = errorStatus(error)
  return status === 401 || status === 403 ? 'rejected' : undefined
}

function terminalSessionError(kind: 'expired' | 'rejected'): PublicToolError {
  return new PublicToolError(
    kind === 'expired' ? DI_SESSION_EXPIRED_MESSAGE : DI_SESSION_REJECTED_MESSAGE,
  )
}

function nativeHeaders(): Record<string, string> {
  return {
    'Accept-Encoding': 'identity',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'User-Agent': 'GCM-Android-5.23',
    'X-App-Ver': '10861',
    'X-Garmin-Client-Platform': 'Android',
    'X-Garmin-Paired-App-Version': '10861',
    'X-Garmin-User-Agent':
      'com.garmin.android.apps.connectmobile/5.23; ; ' +
      'Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
    'X-GCExperience': 'GC5',
    'X-Lang': 'en',
  }
}

async function requestDiEndpoint(input: {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  maxResponseBytes: number
}): Promise<GarminDiRefreshResult> {
  const response = await axios.request({
    method: input.method,
    url: input.url,
    headers: input.headers,
    ...(input.body === undefined ? {} : { data: input.body }),
    timeout: input.timeoutMs,
    maxRedirects: 0,
    maxContentLength: input.maxResponseBytes,
    maxBodyLength: input.body === undefined
      ? 0
      : Buffer.byteLength(input.body, 'utf8'),
    proxy: false,
    validateStatus: () => true,
  })
  return {
    status: response.status,
    contentType: typeof response.headers['content-type'] === 'string'
      ? response.headers['content-type']
      : '',
    body: response.data as unknown,
  }
}

function clearInterceptors(manager: any): void {
  if (typeof manager?.clear === 'function') {
    manager.clear()
    return
  }
  if (Array.isArray(manager?.handlers) && typeof manager?.eject === 'function') {
    manager.handlers.forEach((_handler: unknown, index: number) => manager.eject(index))
  }
}

function errorRequest(error: unknown): any | undefined {
  return isRecord(error) && isRecord(error.config) ? error.config : undefined
}

function requestBearerToken(request: any): string | undefined {
  const headers = request?.headers
  const authorization = typeof headers?.get === 'function'
    ? headers.get('Authorization')
    : headers?.Authorization ?? headers?.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return undefined
  }
  const token = authorization.slice('Bearer '.length)
  return token.length > 0 ? token : undefined
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.response)) return undefined
  const status = error.response.status
  return typeof status === 'number'
    && Number.isInteger(status)
    && status >= 100
    && status <= 599
    ? status
    : undefined
}

function isTimeoutError(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
}

function normalizedRequestError(
  status: number | undefined,
  timedOut: boolean,
): Error & { status?: number; timedOut?: boolean } {
  const error: Error & { status?: number; timedOut?: boolean } = new Error(
    status ? `Garmin request failed (HTTP ${status})` : 'Garmin request failed',
  )
  if (status !== undefined) error.status = status
  if (timedOut) error.timedOut = true
  return error
}
