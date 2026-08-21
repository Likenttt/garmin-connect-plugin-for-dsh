import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { PublicToolError } from './utils/errors'

const MAX_SESSION_FILE_BYTES = 1024 * 1024
export const GARMIN_DI_CLIENT_ID = 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2'
const MAX_DI_TOKEN_BYTES = 16 * 1024

export interface GarminSessionTokens {
  oauth1: Record<string, unknown>
  oauth2: Record<string, unknown>
}

export interface GarminSessionAccountBinding {
  usernameHash: string
  region: 'global' | 'cn'
}

export interface GarminDiSessionAccountBinding extends GarminSessionAccountBinding {
  profileIdHash: string
}

export interface GarminLegacySessionFile extends GarminSessionTokens {
  account?: GarminSessionAccountBinding
}

export interface GarminDiSessionTokens {
  accessToken: string
  refreshToken: string
  clientId: typeof GARMIN_DI_CLIENT_ID
  accessExpiresAtMs: number
  refreshExpiresAtMs: number | null
}

export interface GarminDiSessionFile {
  kind: 'di-oauth'
  schemaVersion: 2
  clientId: typeof GARMIN_DI_CLIENT_ID
  tokens: Omit<GarminDiSessionTokens, 'clientId'>
  account: GarminDiSessionAccountBinding
}

export type GarminSessionFile = GarminLegacySessionFile | GarminDiSessionFile

/** A recognized pre-release DI shape that must never fall back to password login. */
export class ObsoleteGarminDiSessionError extends PublicToolError {
  override name = 'ObsoleteGarminDiSessionError'

  constructor() {
    super('Garmin DI session format is obsolete; run browser authentication again')
  }
}

/** Read one strictly validated legacy OAuth or DI OAuth session file. */
export async function readSessionTokenFile(path: string): Promise<GarminSessionFile> {
  let file: FileHandle | undefined
  let source: string
  try {
    const safeFlags = constants.O_RDONLY | (process.platform === 'win32'
      ? 0
      : constants.O_NOFOLLOW | constants.O_NONBLOCK)
    file = await open(path, safeFlags)
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_SESSION_FILE_BYTES) {
      throw new PublicToolError('Garmin session token file could not be read')
    }
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new PublicToolError(
        'Garmin session token file permissions are unsafe; require owner-only access',
      )
    }
    source = await file.readFile('utf8')
  } catch (error) {
    if (error instanceof PublicToolError) throw error
    throw new PublicToolError('Garmin session token file could not be read')
  } finally {
    await file?.close().catch(() => undefined)
  }
  try {
    const parsed = JSON.parse(source) as unknown
    if (isObsoleteDiSessionFile(parsed)) throw new ObsoleteGarminDiSessionError()
    if (!isSessionFile(parsed)) throw new Error('Invalid token structure')
    return parsed
  } catch (error) {
    if (error instanceof ObsoleteGarminDiSessionError) throw error
    throw new PublicToolError('Garmin session token file is invalid')
  }
}

/** Persist one complete token set without exposing a partially written file. */
export async function writeSessionTokenFile(
  path: string,
  tokens: unknown,
): Promise<void> {
  if (!isSessionFile(tokens)) {
    throw new PublicToolError('Garmin session token file is invalid')
  }

  let serialized: string
  try {
    serialized = JSON.stringify(tokens)
  } catch {
    throw new PublicToolError('Garmin session token file is invalid')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_FILE_BYTES) {
    throw new PublicToolError('Garmin session token file is too large')
  }

  const parent = dirname(path)
  const temporaryPath = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error('Unsafe session directory')
    }
    if (process.platform !== 'win32' && (parentInfo.mode & 0o077) !== 0) {
      throw new Error('Unsafe session directory permissions')
    }
    await writeFile(temporaryPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporaryPath, path)
  } catch {
    try {
      await unlink(temporaryPath)
    } catch {
      // The temporary file may not exist yet or may already have been renamed.
    }
    throw new PublicToolError('Garmin session token file could not be written')
  }
}

export function bindSessionTokensToAccount(
  tokens: GarminSessionTokens,
  username: string,
  region: 'global' | 'cn',
): GarminLegacySessionFile {
  return {
    oauth1: tokens.oauth1,
    oauth2: tokens.oauth2,
    account: sessionAccountBinding(username, region),
  }
}

export function bindDiSessionTokensToAccount(
  tokens: GarminDiSessionTokens,
  username: string,
  region: 'global' | 'cn',
  profileId: number,
): GarminDiSessionFile {
  if (!isValidProfileId(profileId)) {
    throw new PublicToolError('Garmin session account identity is invalid')
  }
  return {
    kind: 'di-oauth',
    schemaVersion: 2,
    clientId: tokens.clientId,
    tokens: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAtMs: tokens.accessExpiresAtMs,
      refreshExpiresAtMs: tokens.refreshExpiresAtMs,
    },
    account: {
      ...sessionAccountBinding(username, region),
      profileIdHash: profileIdHash(profileId),
    },
  }
}

export function sessionFileMatchesAccount(
  session: GarminSessionFile,
  username: string,
  region: 'global' | 'cn',
): boolean {
  if (!session.account) return true
  const expected = sessionAccountBinding(username, region)
  return session.account.usernameHash === expected.usernameHash
    && session.account.region === expected.region
}

export function sessionFileMatchesProfile(
  session: GarminSessionFile,
  profileId: number,
): boolean {
  if (!isDiSessionFile(session) || !isValidProfileId(profileId)) return false
  return session.account.profileIdHash === profileIdHash(profileId)
}

function sessionAccountBinding(
  username: string,
  region: 'global' | 'cn',
): GarminSessionAccountBinding {
  const normalizedUsername = username.trim().normalize('NFKC').toLowerCase()
  return {
    usernameHash: createHash('sha256').update(normalizedUsername).digest('hex'),
    region,
  }
}

function isSessionFile(value: unknown): value is GarminSessionFile {
  if (isDiSessionFile(value)) return true
  if (!isRecord(value) || !isRecord(value.oauth1) || !isRecord(value.oauth2)) return false
  const keys = Object.keys(value).sort()
  const validTopLevelKeys = keys.length === 2
    ? keys[0] === 'oauth1' && keys[1] === 'oauth2'
    : keys.length === 3
      && keys[0] === 'account'
      && keys[1] === 'oauth1'
      && keys[2] === 'oauth2'
  if (!validTopLevelKeys) return false
  if (value.account === undefined) return true
  if (!isRecord(value.account)) return false
  const accountKeys = Object.keys(value.account).sort()
  return accountKeys.length === 2
    && accountKeys[0] === 'region'
    && accountKeys[1] === 'usernameHash'
    && (value.account.region === 'global' || value.account.region === 'cn')
    && typeof value.account.usernameHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.account.usernameHash)
}

export function isDiSessionFile(value: unknown): value is GarminDiSessionFile {
  if (!isRecord(value) || value.kind !== 'di-oauth') return false
  const keys = Object.keys(value).sort()
  if (
    keys.length !== 5
    || keys[0] !== 'account'
    || keys[1] !== 'clientId'
    || keys[2] !== 'kind'
    || keys[3] !== 'schemaVersion'
    || keys[4] !== 'tokens'
  ) {
    return false
  }
  if (
    value.schemaVersion !== 2
    || value.clientId !== GARMIN_DI_CLIENT_ID
    || !isRecord(value.tokens)
    || !isValidDiAccountBinding(value.account)
  ) return false
  const tokenKeys = Object.keys(value.tokens).sort()
  return tokenKeys.length === 4
    && tokenKeys[0] === 'accessExpiresAtMs'
    && tokenKeys[1] === 'accessToken'
    && tokenKeys[2] === 'refreshExpiresAtMs'
    && tokenKeys[3] === 'refreshToken'
    && isPositiveTimestamp(value.tokens.accessExpiresAtMs)
    && (
      value.tokens.refreshExpiresAtMs === null
      || isPositiveTimestamp(value.tokens.refreshExpiresAtMs)
    )
    && isBoundedOpaqueToken(value.tokens.accessToken)
    && isBoundedOpaqueToken(value.tokens.refreshToken)
}

function isValidDiAccountBinding(value: unknown): value is GarminDiSessionAccountBinding {
  if (!isRecord(value)) return false
  const accountKeys = Object.keys(value).sort()
  return accountKeys.length === 3
    && accountKeys[0] === 'profileIdHash'
    && accountKeys[1] === 'region'
    && accountKeys[2] === 'usernameHash'
    && isValidAccountBinding({
      region: value.region,
      usernameHash: value.usernameHash,
    })
    && typeof value.profileIdHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.profileIdHash)
}

function isValidAccountBinding(value: unknown): value is GarminSessionAccountBinding {
  if (!isRecord(value)) return false
  const accountKeys = Object.keys(value).sort()
  return accountKeys.length === 2
    && accountKeys[0] === 'region'
    && accountKeys[1] === 'usernameHash'
    && (value.region === 'global' || value.region === 'cn')
    && typeof value.usernameHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.usernameHash)
}

function isBoundedOpaqueToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_DI_TOKEN_BYTES
    && /^[\x21-\x7e]+$/.test(value)
}

function isPositiveTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isValidProfileId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isObsoleteDiSessionFile(value: unknown): boolean {
  return isRecord(value)
    && value.kind === 'di-oauth'
    && value.schemaVersion === 1
}

function profileIdHash(profileId: number): string {
  return createHash('sha256')
    .update(`garmin-profile-id:v1:${profileId}`)
    .digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
