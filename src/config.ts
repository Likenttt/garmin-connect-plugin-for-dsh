import { Schema } from 'cordis'
import * as dotenv from 'dotenv'

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
  /** Garmin server region */
  region: GarminRegion
  /** In-memory cache TTL in seconds (0 = disabled) */
  cacheTtl: number
  /** Logging verbosity */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Cordis configuration schema.
 *
 * Credential resolution priority:
 *   1. Values supplied directly in the Harness config file (plugin config)
 *   2. Environment variables (GARMIN_USERNAME, GARMIN_PASSWORD, …)
 *   3. Defaults defined below
 *
 * Passwords and session tokens are NEVER logged, serialized, or written to
 * the Harness trajectory / tool-call history.
 */
export const Config: Schema<Config> = Schema.object({
  username: Schema.string()
    .default(process.env.GARMIN_USERNAME ?? '')
    .description('Garmin account email. Env: GARMIN_USERNAME'),

  password: Schema.string()
    .role('secret')
    .default(process.env.GARMIN_PASSWORD || '')
    .description('Garmin password (prefer session token). Env: GARMIN_PASSWORD'),

  sessionToken: Schema.string()
    .role('secret')
    .default(process.env.GARMIN_SESSION_TOKEN || '')
    .description('Pre-auth session token. Env: GARMIN_SESSION_TOKEN'),

  region: Schema.union(['global', 'cn'] as const)
    .default((process.env.GARMIN_REGION as GarminRegion) ?? 'global')
    .description('Server region: global | cn. Env: GARMIN_REGION'),

  cacheTtl: Schema.number()
    .default(Number(process.env.GARMIN_CACHE_TTL) || 300)
    .description('Cache TTL in seconds (0 to disable). Env: GARMIN_CACHE_TTL'),

  logLevel: Schema.union(['debug', 'info', 'warn', 'error'] as const)
    .default((process.env.GARMIN_LOG_LEVEL as Config['logLevel']) ?? 'info')
    .description('Log verbosity. Env: GARMIN_LOG_LEVEL'),
})
