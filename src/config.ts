import z from '@deepseek-ai/schemastery'
import * as dotenv from 'dotenv'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { ACCOUNT_ALIAS_PATTERN, defaultAccountSessionPath } from './account-session'
import { resolveFitDownloadDir } from './utils/path'

export { resolveFitDownloadDir } from './utils/path'

// Load .env file — only takes effect if the file exists.
// In production, credentials should be set directly in the shell environment.
dotenv.config()

// ---------------------------------------------------------------------------
// Configuration Schema
// ---------------------------------------------------------------------------

export type GarminRegion = 'global' | 'cn'
export const MAX_GARMIN_ACCOUNTS = 5

export interface AccountMetadata {
  /** Stable opaque identity; never derived from the region or email. */
  id: string
  region: GarminRegion
  alias: string
  /** One of the five private email fields. The slot may be reused with a new ID. */
  slot: number
}

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
  /** Explicit China account slot. Empty with cnConfigured=true disables legacy fallback. */
  cnUsername?: string
  cnAlias?: string
  cnConfigured?: boolean
  /** Explicit international account slot. Empty with globalConfigured=true disables legacy fallback. */
  globalUsername?: string
  globalAlias?: string
  globalConfigured?: boolean
  /** Public account list; emails are stored separately in secret slot fields. */
  accounts?: AccountMetadata[]
  /** True once the account list was explicitly saved, including an empty list. */
  accountsConfigured?: boolean
  account1Username?: string
  account2Username?: string
  account3Username?: string
  account4Username?: string
  account5Username?: string
  /** Bind each private email to its stable ID so a reused slot cannot inherit it. */
  account1UsernameId?: string
  account2UsernameId?: string
  account3UsernameId?: string
  account4UsernameId?: string
  account5UsernameId?: string
  /** In-memory cache TTL in seconds (0 = disabled) */
  cacheTtl: number
  /** Garmin request timeout in milliseconds */
  requestTimeoutMs?: number
  /** Logging verbosity */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Default activity detail: full data with private fields filtered, or compact */
  activityDetail: 'compact' | 'full'
  /** User-selected FIT parent; output is separated by Garmin region and account */
  fitDownloadDir: string
}

/** Cordis keeps editable account fields in stable references. */
interface ConfigReference<T> {
  get(): T
}

export type PluginConfig = Omit<Config,
  'username' | 'region' | 'cnUsername' | 'cnAlias' | 'cnConfigured'
  | 'globalUsername' | 'globalAlias' | 'globalConfigured'
  | 'accounts' | 'accountsConfigured'
  | 'account1Username' | 'account2Username' | 'account3Username'
  | 'account4Username' | 'account5Username'
  | 'account1UsernameId' | 'account2UsernameId' | 'account3UsernameId'
  | 'account4UsernameId' | 'account5UsernameId'> & {
  username: ConfigReference<string>
  region: ConfigReference<GarminRegion>
  cnUsername?: string | ConfigReference<string>
  cnAlias?: string | ConfigReference<string>
  cnConfigured?: boolean | ConfigReference<boolean>
  globalUsername?: string | ConfigReference<string>
  globalAlias?: string | ConfigReference<string>
  globalConfigured?: boolean | ConfigReference<boolean>
  accounts?: AccountMetadata[] | ConfigReference<unknown>
  accountsConfigured?: boolean | ConfigReference<boolean>
  account1Username?: string | ConfigReference<string>
  account2Username?: string | ConfigReference<string>
  account3Username?: string | ConfigReference<string>
  account4Username?: string | ConfigReference<string>
  account5Username?: string | ConfigReference<string>
  account1UsernameId?: string | ConfigReference<string>
  account2UsernameId?: string | ConfigReference<string>
  account3UsernameId?: string | ConfigReference<string>
  account4UsernameId?: string | ConfigReference<string>
  account5UsernameId?: string | ConfigReference<string>
}

export interface ResolvedAccountConfig {
  accountId: string
  slot: number
  region: GarminRegion
  alias: string
  configured: boolean
  config: Config
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
    .description('Garmin account email. Env: GARMIN_USERNAME')
    .volatile(),

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
    .description('Server region: global | cn. Env: GARMIN_REGION')
    .volatile(),

  cnUsername: z.string()
    .role('secret')
    .default('')
    .description('China Garmin account email; set in the plugin account settings.')
    .volatile(),

  cnAlias: z.string()
    .default('')
    .description('Display name for the China Garmin account.')
    .volatile(),

  cnConfigured: z.boolean()
    .default(false)
    .description('China account slot has been explicitly set in plugin settings.')
    .volatile(),

  globalUsername: z.string()
    .role('secret')
    .default('')
    .description('International Garmin account email; set in the plugin account settings.')
    .volatile(),

  globalAlias: z.string()
    .default('')
    .description('Display name for the international Garmin account.')
    .volatile(),

  globalConfigured: z.boolean()
    .default(false)
    .description('International account slot has been explicitly set in plugin settings.')
    .volatile(),

  accounts: z.array(z.object({
    id: z.string(),
    region: z.union(['global', 'cn'] as const),
    alias: z.string(),
    slot: z.number().min(1).max(MAX_GARMIN_ACCOUNTS),
  }))
    .max(MAX_GARMIN_ACCOUNTS)
    .default([])
    .description('Public metadata for up to five Garmin accounts; account emails are stored separately.')
    .volatile(),

  accountsConfigured: z.boolean()
    .default(false)
    .description('Account list was explicitly saved, including an empty list.')
    .volatile(),

  account1Username: z.string().role('secret').default('').volatile(),
  account2Username: z.string().role('secret').default('').volatile(),
  account3Username: z.string().role('secret').default('').volatile(),
  account4Username: z.string().role('secret').default('').volatile(),
  account5Username: z.string().role('secret').default('').volatile(),
  account1UsernameId: z.string().default('').volatile(),
  account2UsernameId: z.string().default('').volatile(),
  account3UsernameId: z.string().default('').volatile(),
  account4UsernameId: z.string().default('').volatile(),
  account5UsernameId: z.string().default('').volatile(),

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
      'full',
    ))
    .description('Activity detail: full by default with available expanded fitness/location fields and private fields filtered; compact for a smaller response. Env: GARMIN_ACTIVITY_DETAIL'),

  fitDownloadDir: z.string()
    .default('')
    .description('User-selected FIT parent; output is separated by region and account. Env: GARMIN_FIT_DOWNLOAD_DIR'),
})

/** Resolve secrets at runtime so schema metadata never contains credentials. */
export function resolveConfig(input: Config | PluginConfig): Config {
  return {
    ...input,
    username: preferNonEmpty(readVolatile(input.username), process.env.GARMIN_USERNAME),
    region: readVolatile(input.region) ?? 'global',
    cnUsername: readVolatile(input.cnUsername) ?? '',
    cnAlias: readVolatile(input.cnAlias) ?? '',
    cnConfigured: readVolatile(input.cnConfigured) ?? false,
    globalUsername: readVolatile(input.globalUsername) ?? '',
    globalAlias: readVolatile(input.globalAlias) ?? '',
    globalConfigured: readVolatile(input.globalConfigured) ?? false,
    accounts: accountMetadataValue(readVolatile(input.accounts)),
    accountsConfigured: readVolatile(input.accountsConfigured) ?? false,
    account1Username: readVolatile(input.account1Username) ?? '',
    account2Username: readVolatile(input.account2Username) ?? '',
    account3Username: readVolatile(input.account3Username) ?? '',
    account4Username: readVolatile(input.account4Username) ?? '',
    account5Username: readVolatile(input.account5Username) ?? '',
    account1UsernameId: readVolatile(input.account1UsernameId) ?? '',
    account2UsernameId: readVolatile(input.account2UsernameId) ?? '',
    account3UsernameId: readVolatile(input.account3UsernameId) ?? '',
    account4UsernameId: readVolatile(input.account4UsernameId) ?? '',
    account5UsernameId: readVolatile(input.account5UsernameId) ?? '',
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

/** Resolve active account entries and migrate the former single/two-region layout. */
export function resolveAccountConfigs(input: Config | PluginConfig): ResolvedAccountConfig[] {
  const base = resolveConfig(input)
  const legacyAlias = process.env.GARMIN_ACCOUNT?.trim() || 'default'
  const legacyPath = base.sessionTokenFile?.trim()
    || (ACCOUNT_ALIAS_PATTERN.test(legacyAlias) ? defaultAccountSessionPath(legacyAlias) : '')

  // These IDs and slots are stable across the migration. The old single account
  // remains in its region, and the two old regional fields retain their paths.
  const legacyAccounts = new Map<GarminRegion, ResolvedAccountConfig>()
  for (const [region, slot] of [['cn', 1], ['global', 2]] as const) {
    const explicitUsername = (region === 'cn' ? base.cnUsername : base.globalUsername)?.trim() ?? ''
    const explicit = region === 'cn' ? base.cnConfigured : base.globalConfigured
    const usesExplicit = Boolean(explicit || explicitUsername)
    const inheritsSingle = base.region === region
      && Boolean(base.username.trim())
      && (!usesExplicit || explicitUsername.toLowerCase() === base.username.trim().toLowerCase())
    const username = usesExplicit ? explicitUsername : inheritsSingle ? base.username.trim() : ''
    if (!username) continue
    let sessionTokenFile = inheritsSingle
      ? legacyPath
      : defaultAccountSessionPath(`region-${region}`)
    if (!inheritsSingle && legacyPath && resolve(sessionTokenFile) === resolve(legacyPath)) {
      sessionTokenFile = defaultAccountSessionPath(`region-${region}-slot`)
    }
    legacyAccounts.set(region, {
      accountId: `legacy-${region}`,
      slot,
      region,
      alias: ((region === 'cn' ? base.cnAlias : base.globalAlias) ?? '').trim().slice(0, 64),
      configured: true,
      config: {
        ...base,
        username,
        region,
        password: inheritsSingle ? base.password : '',
        sessionToken: inheritsSingle ? base.sessionToken : '',
        sessionTokenFile,
      },
    })
  }

  const metadata = base.accounts ?? []
  if (!base.accountsConfigured && metadata.length === 0) {
    return [...legacyAccounts.values()]
  }
  if (!Array.isArray(metadata) || metadata.length > MAX_GARMIN_ACCOUNTS) {
    throw new Error('Garmin account list exceeds five entries')
  }
  const seenIds = new Set<string>()
  const seenSlots = new Set<number>()
  return metadata.map(entry => {
    if (
      !entry || typeof entry !== 'object'
      || !ACCOUNT_ALIAS_PATTERN.test(entry.id)
      || (entry.region !== 'cn' && entry.region !== 'global')
      || !Number.isInteger(entry.slot)
      || entry.slot < 1 || entry.slot > MAX_GARMIN_ACCOUNTS
      || typeof entry.alias !== 'string'
      || seenIds.has(entry.id) || seenSlots.has(entry.slot)
    ) {
      throw new Error('Garmin account list contains an invalid or duplicate entry')
    }
    seenIds.add(entry.id)
    seenSlots.add(entry.slot)

    const storedUsername = secretSlotOwner(base, entry.slot) === entry.id
      ? secretSlotUsername(base, entry.slot).trim()
      : ''
    const legacyRegion = entry.id === 'legacy-cn'
      ? 'cn' : entry.id === 'legacy-global' ? 'global' : undefined
    const inherited = legacyRegion ? legacyAccounts.get(legacyRegion) : undefined
    const username = storedUsername || inherited?.config.username || ''
    const sameLegacyBinding = inherited !== undefined
      && entry.region === inherited.region
      && username.toLowerCase() === inherited.config.username.toLowerCase()
    let sessionTokenFile = sameLegacyBinding
      ? inherited.config.sessionTokenFile
      : accountSessionPath(entry.id, entry.region)
    if (!sameLegacyBinding && legacyPath && sessionTokenFile
      && resolve(sessionTokenFile) === resolve(legacyPath)) {
      sessionTokenFile = alternateAccountSessionPath(entry.id, entry.region)
    }
    return {
      accountId: entry.id,
      slot: entry.slot,
      region: entry.region,
      alias: entry.alias.trim().slice(0, 64),
      configured: Boolean(username),
      config: {
        ...base,
        username,
        region: entry.region,
        password: sameLegacyBinding ? inherited.config.password : '',
        sessionToken: sameLegacyBinding ? inherited.config.sessionToken : '',
        sessionTokenFile,
      },
    }
  })
}

function secretSlotUsername(config: Config, slot: number): string {
  switch (slot) {
    case 1: return config.account1Username ?? ''
    case 2: return config.account2Username ?? ''
    case 3: return config.account3Username ?? ''
    case 4: return config.account4Username ?? ''
    case 5: return config.account5Username ?? ''
    default: return ''
  }
}

function secretSlotOwner(config: Config, slot: number): string {
  switch (slot) {
    case 1: return config.account1UsernameId ?? ''
    case 2: return config.account2UsernameId ?? ''
    case 3: return config.account3UsernameId ?? ''
    case 4: return config.account4UsernameId ?? ''
    case 5: return config.account5UsernameId ?? ''
    default: return ''
  }
}

function accountSessionPath(id: string, region: GarminRegion): string {
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 20)
  return defaultAccountSessionPath(`slot-${hash}-${region}`)
}

function alternateAccountSessionPath(id: string, region: GarminRegion): string {
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 20)
  return defaultAccountSessionPath(`acct-${hash}-${region}`)
}

function readVolatile<T>(value: T | ConfigReference<T> | undefined): T | undefined {
  return typeof value === 'object' && value !== null && 'get' in value
    ? (value as ConfigReference<T>).get()
    : value as T | undefined
}

function accountMetadataValue(value: unknown): AccountMetadata[] {
  return Array.isArray(value) ? value as AccountMetadata[] : []
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
