import type { GarminRegion } from './config'

export const AUTH_DIAGNOSTIC_PREFIX = '[garmin-auth:diagnostic]'

const AUTH_DIAGNOSTIC_EVENTS = [
  'diagnostics_started',
  'begin_started',
  'begin_rejected',
  'session_destination_prepare_started',
  'session_destination_prepare_succeeded',
  'session_destination_prepare_failed',
  'loopback_server_start_started',
  'loopback_server_start_succeeded',
  'loopback_server_start_failed',
  'auth_flow_start_started',
  'auth_flow_start_succeeded',
  'auth_flow_start_failed',
  'bridge_url_validation_failed',
  'system_browser_open_started',
  'system_browser_open_succeeded',
  'system_browser_open_failed',
  'cdp_browser_open_started',
  'cdp_browser_open_succeeded',
  'cdp_browser_open_failed',
  'cdp_browser_closed',
  'cdp_browser_cleanup_failed',
  'status_poll_failed',
  'browser_opened',
  'portal_loaded',
  'login_response_seen',
  'mfa_response_seen',
  'ticket_captured',
  'di_exchange_started',
  'di_exchange_succeeded',
  'profile_probe_started',
  'profile_probe_succeeded',
  'identity_confirmation_started',
  'identity_confirmation_accepted',
  'identity_confirmation_declined',
  'identity_confirmation_failed',
  'session_persist_started',
  'session_persist_succeeded',
  'session_persist_failed',
  'terminal_auth_started',
  'terminal_auth_succeeded',
  'terminal_auth_failed',
  'terminal_browser_fallback',
  'auth_flow_succeeded',
  'auth_flow_failed',
  'auth_flow_cancelled',
  'auth_flow_expired',
] as const

const AUTH_DIAGNOSTIC_CODES = [
  'configuration',
  'region_mismatch',
  'busy',
  'unavailable',
  'cancelled',
  'destination_prepare_failed',
  'windows_system_root_invalid',
  'windows_target_invalid',
  'windows_powershell_unavailable',
  'windows_acl_timeout',
  'windows_acl_rejected',
  'loopback_start_failed',
  'loopback_origin_invalid',
  'flow_start_failed',
  'bridge_url_invalid',
  'browser_launch_failed',
  'cdp_browser_unavailable',
  'cdp_driver_unavailable',
  'cdp_start_timeout',
  'status_poll_failed',
  'authentication_failed',
] as const

const AUTH_DIAGNOSTIC_SOURCES = [
  'cli_login',
  'cli_browser',
  'cli_serve',
  'cli_canary',
  'dsh',
] as const

const AUTH_DIAGNOSTIC_PATH_SOURCES = [
  'explicit',
  'xdg',
  'local_appdata',
  'appdata',
  'home',
] as const

export type AuthDiagnosticEvent = typeof AUTH_DIAGNOSTIC_EVENTS[number]
export type AuthDiagnosticCode = typeof AUTH_DIAGNOSTIC_CODES[number]
export type AuthDiagnosticSource = typeof AUTH_DIAGNOSTIC_SOURCES[number]
export type AuthDiagnosticPathSource =
  typeof AUTH_DIAGNOSTIC_PATH_SOURCES[number]

export type AuthDiagnosticReporter = (
  event: AuthDiagnosticEvent,
  code?: AuthDiagnosticCode,
) => void

export interface AuthDiagnosticContext {
  source: AuthDiagnosticSource
  region?: GarminRegion
  accountSlot?: number
  sessionPathSource?: AuthDiagnosticPathSource
}

type Environment = Readonly<Record<string, string | undefined>>

interface AuthDiagnosticRecord {
  event: AuthDiagnosticEvent
  code?: AuthDiagnosticCode
  source: AuthDiagnosticSource
  region?: GarminRegion
  platform: 'win32' | 'darwin' | 'linux' | 'other'
  node_major: number
  plugin_version: string
  account_slot?: number
  session_path_source?: AuthDiagnosticPathSource
}

const PLUGIN_VERSION = validatedPluginVersion(
  (require('../package.json') as { version?: unknown }).version,
)

/**
 * Build a logger that accepts only closed enums and serializes no caller data.
 * The returned line intentionally has no newline so CLI and Host loggers can
 * choose their own transport without ever receiving an Error object.
 */
export function createAuthDiagnosticReporter(
  writeLine: (line: string) => void,
  context: AuthDiagnosticContext,
): AuthDiagnosticReporter {
  if (typeof writeLine !== 'function' || !isAuthDiagnosticSource(context?.source)) {
    return () => undefined
  }
  const safeContext = {
    source: context.source,
    region: isGarminRegion(context.region) ? context.region : undefined,
    accountSlot: isAccountSlot(context.accountSlot) ? context.accountSlot : undefined,
    sessionPathSource: isAuthDiagnosticPathSource(context.sessionPathSource)
      ? context.sessionPathSource
      : undefined,
  }

  return (event, code) => {
    if (!isAuthDiagnosticEvent(event)) return
    const record: AuthDiagnosticRecord = {
      event,
      ...(isAuthDiagnosticCode(code) ? { code } : {}),
      source: safeContext.source,
      ...(safeContext.region ? { region: safeContext.region } : {}),
      platform: diagnosticPlatform(process.platform),
      node_major: diagnosticNodeMajor(process.versions.node),
      plugin_version: PLUGIN_VERSION,
      ...(safeContext.accountSlot === undefined
        ? {}
        : { account_slot: safeContext.accountSlot }),
      ...(safeContext.sessionPathSource === undefined
        ? {}
        : { session_path_source: safeContext.sessionPathSource }),
    }
    try {
      writeLine(`${AUTH_DIAGNOSTIC_PREFIX} ${JSON.stringify(record)}`)
    } catch {
      // Diagnostics must never alter the authentication result.
    }
  }
}

/** Report a fixed event while isolating an untrusted logging implementation. */
export function reportAuthDiagnostic(
  reporter: AuthDiagnosticReporter | undefined,
  event: AuthDiagnosticEvent,
  code?: AuthDiagnosticCode,
): void {
  if (!isAuthDiagnosticEvent(event) || !reporter) return
  try {
    reporter(event, isAuthDiagnosticCode(code) ? code : undefined)
  } catch {
    // A supplied Host or test sink cannot break authentication.
  }
}

/** Return only the category that selected the session destination root. */
export function resolveAuthDiagnosticPathSource(
  explicitPath: boolean,
  env: Environment,
): AuthDiagnosticPathSource {
  if (explicitPath) return 'explicit'
  if (env.XDG_CONFIG_HOME?.trim()) return 'xdg'
  if (env.LOCALAPPDATA?.trim()) return 'local_appdata'
  if (env.APPDATA?.trim()) return 'appdata'
  return 'home'
}

/** Read only a closed diagnostic code from an error; never inspect its text. */
export function authDiagnosticCodeFromError(
  error: unknown,
  fallback: AuthDiagnosticCode,
): AuthDiagnosticCode {
  try {
    if (typeof error !== 'object' || error === null) return fallback
    const code = (error as { authDiagnosticCode?: unknown }).authDiagnosticCode
    return isAuthDiagnosticCode(code) ? code : fallback
  } catch {
    return fallback
  }
}

export function isAuthDiagnosticEvent(value: unknown): value is AuthDiagnosticEvent {
  return typeof value === 'string'
    && (AUTH_DIAGNOSTIC_EVENTS as readonly string[]).includes(value)
}

export function isAuthDiagnosticCode(value: unknown): value is AuthDiagnosticCode {
  return typeof value === 'string'
    && (AUTH_DIAGNOSTIC_CODES as readonly string[]).includes(value)
}

function isAuthDiagnosticSource(value: unknown): value is AuthDiagnosticSource {
  return typeof value === 'string'
    && (AUTH_DIAGNOSTIC_SOURCES as readonly string[]).includes(value)
}

function isAuthDiagnosticPathSource(
  value: unknown,
): value is AuthDiagnosticPathSource {
  return typeof value === 'string'
    && (AUTH_DIAGNOSTIC_PATH_SOURCES as readonly string[]).includes(value)
}

function isGarminRegion(value: unknown): value is GarminRegion {
  return value === 'global' || value === 'cn'
}

function isAccountSlot(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5
}

function diagnosticPlatform(
  value: string,
): AuthDiagnosticRecord['platform'] {
  return value === 'win32' || value === 'darwin' || value === 'linux'
    ? value
    : 'other'
}

function diagnosticNodeMajor(value: string): number {
  const major = Number.parseInt(value.split('.')[0] ?? '', 10)
  return Number.isSafeInteger(major) && major > 0 ? major : 0
}

function validatedPluginVersion(value: unknown): string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : 'unknown'
}
