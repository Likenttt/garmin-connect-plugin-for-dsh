import z from '@deepseek-ai/schemastery'
import * as dotenv from 'dotenv'
import { resolveFitDownloadDir } from './utils/path'

export { resolveFitDownloadDir } from './utils/path'

// Load .env file — only takes effect if the file exists.
// In production, credentials should be set directly in the shell environment.
dotenv.config()

// ---------------------------------------------------------------------------
// Configuration Schema
// ---------------------------------------------------------------------------

export type GarminRegion = 'global' | 'cn'

export interface Config {
  /** Garmin account email address */
  username: string
  /** Garmin account password (loaded from env by default) */
  password?: string
  /** Pre-authenticated session token — avoids storing the password entirely */
  sessionToken?: string
  /** Path to a JSON file containing a pre-authenticated session token */
  sessionTokenFile?: string
  /** Garmin server region */
  region: GarminRegion
  /** In-memory cache TTL in seconds (0 = disabled) */
  cacheTtl: number
  /** Garmin request timeout in milliseconds */
  requestTimeoutMs?: number
  /** Logging verbosity */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Default activity detail: compact, or expanded full data with private fields filtered */
  activityDetail: 'compact' | 'full'
  /** User-selected FIT parent; output is separated by Garmin region and account */
  fitDownloadDir: string
}

/**
 * DeepSeek Harness plugin configuration schema (schemastery).
 *
 * Credential resolution priority:
 *   1. Values supplied directly in the Harness config file (plugin config)
 *   2. Environment variables resolved by `resolveConfig()` at apply time
 *   3. Empty schema defaults (credentials never enter schema metadata)
 *
 * Passwords and session tokens are NEVER logged, serialized, or written to
 * the Harness trajectory / tool-call history.
 */
export const Config = z.object({
  username: z.string()
    .role('secret')
    .default('')
    .description('Garmin account email. Env: GARMIN_USERNAME'),

  password: z.string()
    .role('secret')
    .default('')
    .description('Garmin password (prefer session token). Env: GARMIN_PASSWORD'),

  sessionToken: z.string()
    .role('secret')
    .default('')
    .description('Pre-auth session token. Env: GARMIN_SESSION_TOKEN'),

  sessionTokenFile: z.string()
    .role('secret')
    .default('')
    .description('Path to a pre-auth session token JSON file. Env: GARMIN_SESSION_TOKEN_FILE'),

  region: z.union(['global', 'cn'] as const)
    .default(envChoice(process.env.GARMIN_REGION, ['global', 'cn'] as const, 'global'))
    .description('Server region: global | cn. Env: GARMIN_REGION'),

  cacheTtl: z.number()
    .min(0)
    .default(nonNegativeEnvNumber(process.env.GARMIN_CACHE_TTL, 300))
    .description('Cache TTL in seconds (0 to disable). Env: GARMIN_CACHE_TTL'),

  requestTimeoutMs: z.number()
    .min(1)
    .default(positiveEnvNumber(process.env.GARMIN_REQUEST_TIMEOUT_MS, 15_000))
    .description('Garmin request timeout in milliseconds. Env: GARMIN_REQUEST_TIMEOUT_MS'),

  logLevel: z.union(['debug', 'info', 'warn', 'error'] as const)
    .default(envChoice(
      process.env.GARMIN_LOG_LEVEL,
      ['debug', 'info', 'warn', 'error'] as const,
      'info',
    ))
    .description('Log verbosity. Env: GARMIN_LOG_LEVEL'),

  activityDetail: z.union(['compact', 'full'] as const)
    .default(envChoice(
      process.env.GARMIN_ACTIVITY_DETAIL,
      ['compact', 'full'] as const,
      'compact',
    ))
    .description('Activity detail: compact, or full with expanded fitness/location data and private fields filtered. Env: GARMIN_ACTIVITY_DETAIL'),

  fitDownloadDir: z.string()
    .default('')
    .description('User-selected FIT parent; output is separated by region and account. Env: GARMIN_FIT_DOWNLOAD_DIR'),
})

/** Resolve secrets at runtime so schema metadata never contains credentials. */
export function resolveConfig(input: Config): Config {
  return {
    ...input,
    username: preferNonEmpty(input.username, process.env.GARMIN_USERNAME),
    password: preferNonEmpty(input.password, process.env.GARMIN_PASSWORD),
    sessionToken: preferNonEmpty(input.sessionToken, process.env.GARMIN_SESSION_TOKEN),
    sessionTokenFile: preferNonEmpty(
      input.sessionTokenFile,
      process.env.GARMIN_SESSION_TOKEN_FILE,
    ),
    fitDownloadDir: resolveFitDownloadDir(preferNonEmpty(
      input.fitDownloadDir,
      process.env.GARMIN_FIT_DOWNLOAD_DIR,
    )),
  }
}

function preferNonEmpty(primary: string | undefined, fallback: string | undefined): string {
  if (primary?.trim()) return primary
  return fallback?.trim() ? fallback : ''
}

function nonNegativeEnvNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function positiveEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = nonNegativeEnvNumber(value, fallback)
  return parsed > 0 ? parsed : fallback
}

function envChoice<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  return value !== undefined && allowed.includes(value)
    ? value as T[number]
    : fallback
}
