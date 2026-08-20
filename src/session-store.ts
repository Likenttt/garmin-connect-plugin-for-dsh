import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  chmod,
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

export interface GarminSessionTokens {
  oauth1: Record<string, unknown>
  oauth2: Record<string, unknown>
}

export interface GarminSessionAccountBinding {
  usernameHash: string
  region: 'global' | 'cn'
}

export interface GarminSessionFile extends GarminSessionTokens {
  account?: GarminSessionAccountBinding
}

/** Read the session format produced by GarminClient.exportSession(). */
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
    if (!isSessionFile(parsed)) throw new Error('Invalid token structure')
    return parsed
  } catch {
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
    if (process.platform !== 'win32') await chmod(path, 0o600)
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
): GarminSessionFile {
  return {
    oauth1: tokens.oauth1,
    oauth2: tokens.oauth2,
    account: sessionAccountBinding(username, region),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
