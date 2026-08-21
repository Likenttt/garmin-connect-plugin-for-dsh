import type { GarminRegion } from './config'
import { PublicToolError } from './utils/errors'

const DI_CLIENT_ID = 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2'
const DI_GRANT_TYPE =
  'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket'
const PROFILE_PATH = '/userprofile-service/socialProfile'
const SERVICE_TICKET_PATTERN = /^ST-[A-Za-z0-9._~-]+$/
const REQUEST_TIMEOUT_MS = 30_000
const MAX_OBSERVED_RESPONSE_BYTES = 64 * 1024
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
const MAX_PROFILE_RESPONSE_BYTES = 256 * 1024
const MAX_TOKEN_BYTES = 16 * 1024

const BROWSER_FAILED_MESSAGE = 'Garmin browser authentication canary failed'
const TICKET_MISSING_MESSAGE =
  'Garmin browser authentication did not return a usable service ticket'
const DI_EXCHANGE_FAILED_MESSAGE = 'Garmin DI token exchange canary failed'
const PROFILE_FAILED_MESSAGE = 'Garmin DI profile probe failed'

const BROWSER_DI_AUTH_CANARY_STAGES = [
  'browser_opened',
  'portal_loaded',
  'login_response_seen',
  'mfa_response_seen',
  'ticket_captured',
  'di_exchange_started',
  'di_exchange_succeeded',
  'profile_probe_started',
  'profile_probe_succeeded',
] as const

export type BrowserDiAuthCanaryStage =
  typeof BROWSER_DI_AUTH_CANARY_STAGES[number]

export type BrowserCanaryControlCode =
  | 'BROWSER_UNAVAILABLE'
  | 'CANCELLED'
  | 'DRIVER_UNAVAILABLE'
  | 'TIMED_OUT'
  | 'UNSAFE_BROWSER_POLICY'
  | 'UNSAFE_DEBUG'
  | 'UNSAFE_HTTP_POLICY'

const CONTROL_MESSAGES: Record<BrowserCanaryControlCode, string> = {
  BROWSER_UNAVAILABLE:
    'System Google Chrome could not be started for Garmin browser authentication',
  CANCELLED: 'Garmin browser authentication was cancelled',
  DRIVER_UNAVAILABLE:
    'Garmin browser authentication requires the optional playwright-core driver',
  TIMED_OUT: 'Garmin browser authentication timed out',
  UNSAFE_BROWSER_POLICY: 'Garmin browser authentication navigation policy is invalid',
  UNSAFE_DEBUG:
    'Disable runtime debug and TLS tracing before Garmin browser authentication',
  UNSAFE_HTTP_POLICY: 'Garmin browser authentication HTTP policy is invalid',
}

/** A fixed-message control-flow error safe to display without raw browser data. */
export class BrowserCanaryControlError extends PublicToolError {
  override name = 'BrowserCanaryControlError'

  constructor(readonly code: BrowserCanaryControlCode) {
    super(CONTROL_MESSAGES[code])
  }
}

export interface BrowserObservedResponse {
  url: string
  status: number
  contentType?: string
  json(): Promise<unknown>
}

export interface BlockedTicketRedirect {
  origin: string
  pathname: string
  searchParameter: 'ticket'
}

export interface BrowserCaptureOptions {
  portalUrl: string
  serviceUrl: string
  allowedResponseUrls: readonly string[]
  /** The adapter must install this block before navigating to portalUrl. */
  blockedTicketRedirect: BlockedTicketRedirect
  /** The adapter must reject larger bodies before calling onResponse. */
  maxObservedResponseBytes: number
  signal?: AbortSignal
  /** Report only fixed, data-free lifecycle stages. */
  onStage?: (stage: BrowserDiAuthCanaryStage) => void
  /** Return true once the adapter can close its temporary browser context. */
  onResponse(response: BrowserObservedResponse): Promise<boolean>
}

export interface BrowserDiAuthCanaryBrowser {
  openAndCapture(options: BrowserCaptureOptions): Promise<void>
}

export interface BrowserDiHttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Readonly<Record<string, string>>
  body?: string
  followRedirects: false
  maxResponseBytes: number
  retry: false
  timeoutMs: number
  useProxy: false
  signal?: AbortSignal
}

export interface BrowserDiHttpResponse {
  status: number
  contentType?: string
  body: unknown
}

export interface BrowserDiAuthCanaryHttp {
  request(request: BrowserDiHttpRequest): Promise<BrowserDiHttpResponse>
}

export interface BrowserDiAuthCanaryDependencies {
  browser: BrowserDiAuthCanaryBrowser
  http: BrowserDiAuthCanaryHttp
}

export interface BrowserDiAuthCanaryOptions {
  region: GarminRegion
  signal?: AbortSignal
  onStage?: (stage: BrowserDiAuthCanaryStage) => void
}

export interface CapturedServiceTicketDiCanaryOptions {
  region: GarminRegion
  serviceTicket: string
  signal?: AbortSignal
  onStage?: (stage: BrowserDiAuthCanaryStage) => void
}

export interface CapturedServiceTicketDiCanaryDependencies {
  http: BrowserDiAuthCanaryHttp
}

export interface BrowserDiAuthCanaryResult {
  ok: true
  region: GarminRegion
  persisted: false
}

/**
 * Experimental, non-persisting probe for Garmin's browser-to-DI login path.
 * The browser owns all credential/MFA UI; this seam only handles a short-lived
 * service ticket and keeps every ticket, token, and profile out of its result.
 */
export async function runBrowserDiAuthCanary(
  options: BrowserDiAuthCanaryOptions,
  dependencies: BrowserDiAuthCanaryDependencies,
): Promise<BrowserDiAuthCanaryResult> {
  assertCanaryRegion(options.region)
  const endpoints = endpointsFor(options.region)
  const reportStage = createStageReporter(options.onStage)
  let serviceTicket: string | undefined

  try {
    try {
      await dependencies.browser.openAndCapture({
        portalUrl: endpoints.portalUrl,
        serviceUrl: endpoints.serviceUrl,
        allowedResponseUrls: endpoints.allowedResponseUrls,
        blockedTicketRedirect: endpoints.blockedTicketRedirect,
        maxObservedResponseBytes: MAX_OBSERVED_RESPONSE_BYTES,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onStage ? { onStage: reportStage } : {}),
        onResponse: async (response) => {
          if (serviceTicket) return true
          if (!isAllowedPortalResponseUrl(
            response.url,
            endpoints.allowedResponseUrls,
            endpoints.serviceUrl,
          )) return false
          const responseStage = portalResponseStage(response.url)
          if (responseStage) reportStage(responseStage)
          if (!isSuccessful(response.status) || !isJson(response.contentType)) return false

          let body: unknown
          try {
            body = await response.json()
          } catch {
            return false
          }
          if (!isSuccessfulTicketResponse(body)) return false
          if (serviceTicket) return true
          serviceTicket = body.serviceTicketId
          reportStage('ticket_captured')
          return true
        },
      })
    } catch (error) {
      if (error instanceof BrowserCanaryControlError) throw error
      throw new PublicToolError(BROWSER_FAILED_MESSAGE)
    }

    if (!serviceTicket) throw new PublicToolError(TICKET_MISSING_MESSAGE)
    return await runCapturedServiceTicketDiCanaryWithReporter(
      options.region,
      serviceTicket,
      endpoints,
      dependencies.http,
      options.signal,
      reportStage,
    )
  } finally {
    serviceTicket = undefined
  }
}

/**
 * Probe DI using a one-time service ticket captured by a trusted browser seam.
 * No ticket, token, or profile data is retained or returned.
 */
export async function runCapturedServiceTicketDiCanary(
  options: CapturedServiceTicketDiCanaryOptions,
  dependencies: CapturedServiceTicketDiCanaryDependencies,
): Promise<BrowserDiAuthCanaryResult> {
  assertCanaryRegion(options.region)
  if (!isUsableServiceTicket(options.serviceTicket)) {
    throw new PublicToolError(TICKET_MISSING_MESSAGE)
  }
  throwIfAborted(options.signal)

  return runCapturedServiceTicketDiCanaryWithReporter(
    options.region,
    options.serviceTicket,
    endpointsFor(options.region),
    dependencies.http,
    options.signal,
    createStageReporter(options.onStage),
  )
}

async function runCapturedServiceTicketDiCanaryWithReporter(
  region: GarminRegion,
  capturedTicket: string,
  endpoints: RegionEndpoints,
  http: BrowserDiAuthCanaryHttp,
  signal: AbortSignal | undefined,
  reportStage: (stage: BrowserDiAuthCanaryStage) => void,
): Promise<BrowserDiAuthCanaryResult> {
  let serviceTicket: string | undefined = capturedTicket
  let accessToken: string | undefined
  try {
    reportStage('ticket_captured')
    throwIfAborted(signal)
    reportStage('di_exchange_started')
    accessToken = await exchangeServiceTicket(
      serviceTicket,
      endpoints,
      http,
      signal,
    )
    reportStage('di_exchange_succeeded')
    serviceTicket = undefined
    throwIfAborted(signal)
    reportStage('profile_probe_started')
    await probeProfile(accessToken, endpoints, http, signal)
    reportStage('profile_probe_succeeded')
    return { ok: true, region, persisted: false }
  } finally {
    // Strings cannot be zeroized in JavaScript, but release our references as
    // soon as the one-shot probe finishes and never retain them in the result.
    serviceTicket = undefined
    accessToken = undefined
  }
}

export function isBrowserDiAuthCanaryStage(
  value: unknown,
): value is BrowserDiAuthCanaryStage {
  return typeof value === 'string'
    && (BROWSER_DI_AUTH_CANARY_STAGES as readonly string[]).includes(value)
}

function createStageReporter(
  onStage: BrowserDiAuthCanaryOptions['onStage'],
): (stage: BrowserDiAuthCanaryStage) => void {
  const reported = new Set<BrowserDiAuthCanaryStage>()
  return (stage) => {
    if (!isBrowserDiAuthCanaryStage(stage)) return
    if (reported.has(stage)) return
    reported.add(stage)
    try {
      onStage?.(stage)
    } catch {
      // Progress reporting must not alter or disclose the authentication flow.
    }
  }
}

function portalResponseStage(
  candidate: string,
): 'login_response_seen' | 'mfa_response_seen' | undefined {
  try {
    const pathname = new URL(candidate).pathname
    if (pathname === '/portal/api/login') return 'login_response_seen'
    if (pathname === '/portal/api/mfa/verifyCode') return 'mfa_response_seen'
  } catch {
    // The caller already rejects malformed URLs; keep this helper fail-closed.
  }
  return undefined
}

/**
 * Match Garmin's portal response without trusting arbitrary query strings.
 * Current portal requests include a fixed three-parameter query; fixtures and
 * older deployments may omit it. Every other query shape fails closed.
 */
export function isAllowedPortalResponseUrl(
  candidate: string,
  allowedBaseUrls: readonly string[],
  serviceUrl: string,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return false
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
  ) return false

  const baseMatches = allowedBaseUrls.some((baseUrl) => {
    try {
      const base = new URL(baseUrl)
      return parsed.origin === base.origin && parsed.pathname === base.pathname
    } catch {
      return false
    }
  })
  if (!baseMatches) return false
  if (parsed.search === '') return true

  const expected = new Map<string, string>([
    ['clientId', 'GarminConnect'],
    ['locale', 'en-US'],
    ['service', serviceUrl],
  ])
  const entries = Array.from(parsed.searchParams.entries())
  if (entries.length !== expected.size) return false
  return Array.from(expected.entries()).every(([key, value]) => {
    const values = parsed.searchParams.getAll(key)
    return values.length === 1 && values[0] === value
  })
}

interface RegionEndpoints {
  portalUrl: string
  serviceUrl: string
  allowedResponseUrls: readonly string[]
  blockedTicketRedirect: BlockedTicketRedirect
  diTokenUrl: string
  profileUrl: string
}

function endpointsFor(region: GarminRegion): RegionEndpoints {
  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com'
  const ssoOrigin = `https://sso.${domain}`
  const connectOrigin = `https://connect.${domain}`
  const serviceUrl = `${connectOrigin}/app`
  const signin = new URL(`${ssoOrigin}/portal/sso/en-US/sign-in`)
  signin.searchParams.set('clientId', 'GarminConnect')
  signin.searchParams.set('service', serviceUrl)

  return {
    portalUrl: signin.toString(),
    serviceUrl,
    allowedResponseUrls: [
      `${ssoOrigin}/portal/api/login`,
      `${ssoOrigin}/portal/api/mfa/verifyCode`,
    ],
    blockedTicketRedirect: {
      origin: connectOrigin,
      pathname: '/app',
      searchParameter: 'ticket',
    },
    diTokenUrl: `https://diauth.${domain}/di-oauth2-service/oauth/token`,
    profileUrl: `https://connectapi.${domain}${PROFILE_PATH}`,
  }
}

async function exchangeServiceTicket(
  ticket: string,
  endpoints: RegionEndpoints,
  http: BrowserDiAuthCanaryHttp,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const response = await http.request({
      method: 'POST',
      url: endpoints.diTokenUrl,
      headers: {
        ...nativeHeaders(),
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${DI_CLIENT_ID}:`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: DI_CLIENT_ID,
        service_ticket: ticket,
        grant_type: DI_GRANT_TYPE,
        service_url: endpoints.serviceUrl,
      }).toString(),
      ...requestPolicy(MAX_TOKEN_RESPONSE_BYTES),
      ...(signal ? { signal } : {}),
    })

    if (!isSuccessful(response.status) || !isJson(response.contentType)) {
      throw new Error('Unexpected DI response')
    }
    if (!isRecord(response.body)) throw new Error('Unexpected DI response')
    const accessToken = response.body.access_token
    const refreshToken = response.body.refresh_token
    if (
      typeof accessToken === 'string'
      && isBoundedToken(accessToken)
      && typeof refreshToken === 'string'
      && isBoundedToken(refreshToken)
    ) {
      return accessToken
    }
    throw new Error('Unexpected DI token')
  } catch (error) {
    if (error instanceof BrowserCanaryControlError) throw error
    throw new PublicToolError(DI_EXCHANGE_FAILED_MESSAGE)
  }
}

async function probeProfile(
  accessToken: string,
  endpoints: RegionEndpoints,
  http: BrowserDiAuthCanaryHttp,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const response = await http.request({
      method: 'GET',
      url: endpoints.profileUrl,
      headers: {
        ...nativeHeaders(),
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      ...requestPolicy(MAX_PROFILE_RESPONSE_BYTES),
      ...(signal ? { signal } : {}),
    })

    if (
      !isSuccessful(response.status)
      || !isJson(response.contentType)
      || !isRecord(response.body)
    ) {
      throw new Error('Unexpected profile response')
    }
  } catch (error) {
    if (error instanceof BrowserCanaryControlError) throw error
    throw new PublicToolError(PROFILE_FAILED_MESSAGE)
  }
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

function requestPolicy(maxResponseBytes: number): Pick<
  BrowserDiHttpRequest,
  | 'followRedirects'
  | 'maxResponseBytes'
  | 'retry'
  | 'timeoutMs'
  | 'useProxy'
> {
  return {
    followRedirects: false,
    maxResponseBytes,
    retry: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    useProxy: false,
  }
}

function isBoundedToken(token: string): boolean {
  return token.length > 0 && Buffer.byteLength(token, 'utf8') <= MAX_TOKEN_BYTES
}

function isSuccessfulTicketResponse(
  value: unknown,
): value is { responseStatus: { type: 'SUCCESSFUL' }; serviceTicketId: string } {
  if (!isRecord(value) || !isRecord(value.responseStatus)) return false
  const ticket = value.serviceTicketId
  return value.responseStatus.type === 'SUCCESSFUL'
    && typeof ticket === 'string'
    && isUsableServiceTicket(ticket)
}

function isUsableServiceTicket(ticket: unknown): ticket is string {
  return typeof ticket === 'string'
    && ticket.length <= 2048
    && SERVICE_TICKET_PATTERN.test(ticket)
}

function assertCanaryRegion(region: unknown): asserts region is GarminRegion {
  if (region !== 'global' && region !== 'cn') {
    throw new PublicToolError('Garmin browser authentication region is invalid')
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BrowserCanaryControlError('CANCELLED')
}

function isSuccessful(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300
}

function isJson(contentType: string | undefined): boolean {
  if (!contentType) return false
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json'
    || (mediaType.startsWith('application/') && mediaType.endsWith('+json'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
