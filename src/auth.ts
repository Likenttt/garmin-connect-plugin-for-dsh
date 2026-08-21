import axios from 'axios'
import { wrapper } from 'axios-cookiejar-support'
import { GarminConnect } from 'garmin-connect'
import { CookieJar } from 'tough-cookie'
import type { GarminRegion } from './config'
import { hardenGarminHttpClient } from './client'
import type { GarminSessionTokens } from './session-store'
import { PublicToolError } from './utils/errors'

const CSRF_PATTERN = /name=["']_csrf["']\s+value=["'](.+?)["']/i
const TICKET_PATTERN = /(?:[?&]|&amp;)ticket=(ST-[^"&\s<]+)/i
const MFA_VARIABLE_PATTERN =
  /(?:var|let|const)\s+(customerGuid|mfaMethod|locale|clientId|codeSentTo)\s*=\s*["']([^"']*)["']\s*;?/gi
const MFA_CODE_INPUT_PATTERN =
  /<input\b[^>]*\bname\s*=\s*["']mfa-code["'][^>]*>/i
const MFA_FORM_ACTION_PATTERN =
  /<form\b[^>]*\baction\s*=\s*["'][^"']*verifyMFA[^"']*["'][^>]*>/i
const BROWSER_VERIFICATION_PATTERN =
  /(?:g-recaptcha|h-captcha|hcaptcha|cf-turnstile|cf-chl-|challenge-platform|recaptcha\/api)/i
const BROWSER_VERIFICATION_MESSAGE =
  'Open Garmin Connect in a browser and complete the verification, then retry; automatic browser authentication is not yet supported'
const MFA_REJECTED_MESSAGE =
  'Garmin did not accept the MFA code; request a new code and try again'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json'
const MAX_AUTH_RESPONSE_BYTES = 5 * 1024 * 1024

export interface MfaPromptContext {
  method: string
}

export interface GarminAuthOptions {
  username: string
  password: string
  region: GarminRegion
  promptMfa(context: MfaPromptContext): Promise<string>
  requestTimeoutMs?: number
}

interface SsoClientLike {
  get(url: string, config?: Record<string, unknown>): Promise<{ data: unknown }>
  post(
    url: string,
    data?: unknown,
    config?: Record<string, unknown>,
  ): Promise<{ data: unknown }>
}

interface GarminAuthClientLike {
  client: {
    client?: { defaults: Record<string, unknown> }
    OAUTH_CONSUMER?: { key: string; secret: string }
    getOauth1Token(ticket: string): Promise<unknown>
    exchange(oauth1: unknown): Promise<void>
    oauth1Token?: unknown
    oauth2Token?: unknown
  }
  getUserProfile(): Promise<unknown>
  exportToken(): unknown
}

/** Injection seams are public only so the private SSO flow can be tested offline. */
export interface GarminAuthDependencies {
  createSsoClient(timeoutMs: number): SsoClientLike
  createGarminClient(
    credentials: { username: string; password: string },
    domain: 'garmin.com' | 'garmin.cn',
  ): GarminAuthClientLike
  wait?(milliseconds: number): Promise<void>
  random?(): number
}

export interface GarminAuthResult {
  tokens: GarminSessionTokens
  displayName?: string
  usedMfa: boolean
}

/**
 * Authenticate in a foreground process, pausing for a locally supplied MFA
 * code when Garmin asks for it. Passwords and codes are never returned.
 */
export async function authenticateGarminSession(
  options: GarminAuthOptions,
  dependencies: GarminAuthDependencies = defaultDependencies,
): Promise<GarminAuthResult> {
  const username = options.username.trim()
  if (!username) throw new PublicToolError('Garmin username is required')
  if (!options.password) throw new PublicToolError('Garmin password is required')

  const timeoutMs = options.requestTimeoutMs ?? 30_000
  const domain = options.region === 'cn' ? 'garmin.cn' : 'garmin.com'
  const ssoOrigin = `https://sso.${domain}`
  const ssoBase = `${ssoOrigin}/sso`
  const ssoEmbed = `${ssoBase}/embed`
  const signinUrl = `${ssoBase}/signin`
  const connectModern = `https://connect.${domain}/modern`
  const sso = dependencies.createSsoClient(timeoutMs)
  const garmin = dependencies.createGarminClient(
    { username, password: options.password },
    domain,
  )

  try {
    const initialParams = {
      clientId: 'GarminConnect',
      locale: 'en',
      service: connectModern,
    }
    const widgetParams = {
      id: 'gauth-widget',
      embedWidget: 'true',
      locale: 'en',
      gauthHost: ssoEmbed,
    }
    const signinParams = {
      ...widgetParams,
      clientId: 'GarminConnect',
      service: ssoEmbed,
      source: ssoEmbed,
      redirectAfterAccountLoginUrl: ssoEmbed,
      redirectAfterAccountCreationUrl: ssoEmbed,
    }
    const commonHeaders = { 'User-Agent': USER_AGENT }

    await sso.get(ssoEmbed, { params: initialParams, headers: commonHeaders })
    const signinPage = await sso.get(signinUrl, {
      params: widgetParams,
      headers: { ...commonHeaders, Referer: ssoEmbed },
    })
    const signinHtml = requireHtml(signinPage.data)
    const csrf = extractRequired(CSRF_PATTERN, signinHtml)

    // Garmin rate-limits automated credential submissions aggressively. The
    // short jitter mirrors the browser widget's normal dwell time.
    const random = dependencies.random?.() ?? Math.random()
    const delayMs = 3_000 + Math.floor(Math.max(0, Math.min(random, 1)) * 5_000)
    await (dependencies.wait ?? wait)(delayMs)

    const loginResponse = await sso.post(
      signinUrl,
      new URLSearchParams({
        username,
        password: options.password,
        embed: 'true',
        _csrf: csrf,
      }).toString(),
      {
        params: signinParams,
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: ssoOrigin,
          Referer: signinUrl,
          Dnt: '1',
        },
      },
    )

    let responseHtml = requireHtml(loginResponse.data)
    let ticket = TICKET_PATTERN.exec(responseHtml)?.[1]
    let usedMfa = false

    if (!ticket) {
      throwIfBrowserVerification(responseHtml)

      const mfaVariables = parseMfaVariables(responseHtml)
      const mfaMethod = (mfaVariables.mfaMethod ?? '').toLowerCase()
      const needsMfa = hasMfaChallenge(responseHtml, mfaVariables)

      if (needsMfa) {
        usedMfa = true
        if (
          (mfaMethod === 'email' || mfaMethod === 'sms')
          && !mfaVariables.codeSentTo
        ) {
          if (
            !mfaVariables.customerGuid
            || !mfaVariables.clientId
            || !mfaVariables.locale
          ) {
            throw new Error('Garmin MFA delivery metadata is incomplete')
          }
          await sso.post(
            `${ssoBase}/verifyMFA/mfaCode`,
            {
              customerGuid: mfaVariables.customerGuid,
              mfaMethod: mfaVariables.mfaMethod,
              locale: mfaVariables.locale,
            },
            {
              params: { clientId: mfaVariables.clientId },
              headers: {
                ...commonHeaders,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/plain, */*',
                Referer: signinUrl,
              },
            },
          )
        }

        const mfaCode = (await options.promptMfa({
          method: mfaMethod || 'verification',
        })).trim()
        if (!mfaCode) throw new PublicToolError('MFA code is required')
        if (mfaCode.length > 32) throw new PublicToolError('MFA code is invalid')
        const mfaCsrf = extractRequired(CSRF_PATTERN, responseHtml)
        let mfaResponse: { data: unknown }
        try {
          mfaResponse = await sso.post(
            `${ssoBase}/verifyMFA/loginEnterMfaCode`,
            new URLSearchParams({
              'mfa-code': mfaCode,
              embed: 'true',
              _csrf: mfaCsrf,
              fromPage: 'setupEnterMfaCode',
            }).toString(),
            {
              params: signinParams,
              headers: {
                ...commonHeaders,
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: ssoOrigin,
                Referer: signinUrl,
                Dnt: '1',
              },
            },
          )
        } catch (error) {
          const status = httpStatus(error)
          if (status === 400 || status === 401 || status === 403) {
            throw new PublicToolError(MFA_REJECTED_MESSAGE)
          }
          throw error
        }
        responseHtml = requireHtml(mfaResponse.data)
        ticket = TICKET_PATTERN.exec(responseHtml)?.[1]
      }
    }

    if (!ticket) {
      throwIfBrowserVerification(responseHtml)
      if (usedMfa) throw new PublicToolError(MFA_REJECTED_MESSAGE)
      throw new Error('Garmin SSO did not return a service ticket')
    }

    // Reuse the pinned library's OAuth exchange so the resulting token remains
    // byte-for-byte compatible with GarminClient.loadToken().
    hardenGarminHttpClient(garmin.client as any)
    if (garmin.client.client?.defaults) {
      garmin.client.client.defaults.timeout = timeoutMs
      garmin.client.client.defaults.maxContentLength = MAX_AUTH_RESPONSE_BYTES
    }
    const consumerResponse = await sso.get(OAUTH_CONSUMER_URL)
    const consumer = parseOauthConsumer(consumerResponse.data)
    garmin.client.OAUTH_CONSUMER = consumer
    const oauth1 = await garmin.client.getOauth1Token(ticket)
    await garmin.client.exchange(oauth1)
    const profile = await garmin.getUserProfile()
    const tokens = parseExportedTokens(garmin.exportToken())
    const displayName = isRecord(profile) && typeof profile.displayName === 'string'
      ? profile.displayName
      : undefined

    return { tokens, displayName, usedMfa }
  } catch (error) {
    if (error instanceof PublicToolError) throw error
    const status = httpStatus(error)
    if (status === 429) {
      throw new PublicToolError(
        'Garmin authentication is rate limited; wait before trying again',
      )
    }
    throw new PublicToolError('Garmin authentication failed')
  }
}

const defaultDependencies: GarminAuthDependencies = {
  createSsoClient(timeoutMs): SsoClientLike {
    // axios-cookiejar-support@5 was compiled against an earlier Axios 1.x
    // generic signature. The runtime API is compatible; keep the cast at this
    // single adapter boundary instead of weakening the auth flow types.
    const client = axios.create({
      jar: new CookieJar(),
      withCredentials: true,
      timeout: timeoutMs,
      maxRedirects: 10,
      maxContentLength: MAX_AUTH_RESPONSE_BYTES,
      maxBodyLength: 256 * 1024,
    } as any)
    return wrapper(client as any) as unknown as SsoClientLike
  },
  createGarminClient(credentials, domain): GarminAuthClientLike {
    return new GarminConnect(credentials, domain)
  },
}

function parseMfaVariables(html: string): Record<string, string> {
  const values: Record<string, string> = {}
  MFA_VARIABLE_PATTERN.lastIndex = 0
  for (const match of html.matchAll(MFA_VARIABLE_PATTERN)) {
    values[match[1]] = match[2]
  }
  return values
}

function hasMfaChallenge(
  html: string,
  variables: Record<string, string> = parseMfaVariables(html),
): boolean {
  return Boolean(variables.mfaMethod)
    || MFA_CODE_INPUT_PATTERN.test(html)
    || MFA_FORM_ACTION_PATTERN.test(html)
}

function throwIfBrowserVerification(html: string): void {
  if (BROWSER_VERIFICATION_PATTERN.test(html)) {
    throw new PublicToolError(BROWSER_VERIFICATION_MESSAGE)
  }
}

function extractRequired(pattern: RegExp, html: string): string {
  const value = pattern.exec(html)?.[1]
  if (!value) throw new Error('Required Garmin SSO field is missing')
  return value
}

function requireHtml(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Garmin SSO returned an invalid response')
  return value
}

function parseExportedTokens(value: unknown): GarminSessionTokens {
  if (!isRecord(value) || !isRecord(value.oauth1) || !isRecord(value.oauth2)) {
    throw new Error('Garmin token exchange returned an invalid session')
  }
  return { oauth1: value.oauth1, oauth2: value.oauth2 }
}

function parseOauthConsumer(value: unknown): { key: string; secret: string } {
  if (
    !isRecord(value)
    || typeof value.consumer_key !== 'string'
    || typeof value.consumer_secret !== 'string'
    || !value.consumer_key
    || !value.consumer_secret
  ) {
    throw new Error('Garmin OAuth consumer response is invalid')
  }
  return { key: value.consumer_key, secret: value.consumer_secret }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function httpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  const value = isRecord(error.response) ? error.response.status : error.status
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
