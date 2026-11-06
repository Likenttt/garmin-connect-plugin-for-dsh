import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import {
  GARMIN_BROWSER_AUTH_COMMAND,
  PublicToolError,
} from './utils/errors'
import { verifyNoGrantingDarwinAcl } from './darwin-private-acl'
import {
  authDiagnosticCodeFromError,
  type AuthDiagnosticCode,
} from './auth-diagnostics'
import {
  createWindowsPrivateAcl,
  type WindowsPrivateAcl,
} from './windows-private-acl'

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

/** The configured session path is absent and may be created by browser auth. */
export class GarminSessionTokenFileMissingError extends PublicToolError {
  override name = 'GarminSessionTokenFileMissingError'

  constructor() {
    super('Garmin session token file does not exist')
  }
}

class GarminSessionDestinationPreparationError extends PublicToolError {
  constructor(readonly authDiagnosticCode: AuthDiagnosticCode) {
    super('Garmin session token destination could not be prepared')
  }
}

/** The file exists but does not contain a supported Garmin session shape. */
export class GarminSessionTokenFileInvalidError extends PublicToolError {
  override name = 'GarminSessionTokenFileInvalidError'

  constructor(message = 'Garmin session token file is invalid') {
    super(message)
  }
}

/** Base class for a file that selected DI auth but cannot be used safely. */
export class GarminDiSessionFileError extends GarminSessionTokenFileInvalidError {
  override name = 'GarminDiSessionFileError'

  constructor(message = 'Garmin session token file is invalid') {
    super(message)
  }
}

/** A recognized pre-release DI shape that must never fall back to password login. */
export class ObsoleteGarminDiSessionError extends GarminDiSessionFileError {
  override name = 'ObsoleteGarminDiSessionError'

  constructor() {
    super(
      `Garmin DI session format is obsolete; run ${GARMIN_BROWSER_AUTH_COMMAND}`,
    )
  }
}

/** Read one strictly validated legacy OAuth or DI OAuth session file. */
export async function readSessionTokenFile(path: string): Promise<GarminSessionFile> {
  let file: FileHandle | undefined
  let source: string
  try {
    let destination = resolve(path)
    if (process.platform === 'win32') {
      const entry = await lstat(destination)
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new PublicToolError('Garmin session token file could not be read')
      }
      try {
        const windowsAcl = await createWindowsPrivateAcl()
        // The existing parent is only verified (never rewritten), then the
        // exact owner/DACL and full reparse chain are checked before secrets.
        await windowsAcl.prepareDirectory(dirname(destination))
        await windowsAcl.verifyFile(destination)
      } catch {
        throw new PublicToolError('Garmin session token file could not be read')
      }
    } else {
      try {
        // Preserve the distinct "missing" state so browser auth can run the
        // stricter write-destination preflight before creating anything.
        await lstat(destination)
        destination = await resolvePrivatePosixReadDestination(destination)
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') throw error
        throw new PublicToolError(
          'Garmin session token file permissions are unsafe; require owner-only access',
        )
      }
    }
    const safeFlags = constants.O_RDONLY | (process.platform === 'win32'
      ? 0
      : constants.O_NOFOLLOW | constants.O_NONBLOCK)
    file = await open(destination, safeFlags)
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_SESSION_FILE_BYTES) {
      throw new PublicToolError('Garmin session token file could not be read')
    }
    if (process.platform !== 'win32') {
      try {
        await verifyPrivatePosixFileHandle(file, destination)
        await verifyPrivatePosixReadParent(dirname(destination))
      } catch {
        throw new PublicToolError(
          'Garmin session token file permissions are unsafe; require owner-only access',
        )
      }
    }
    source = await file.readFile('utf8')
  } catch (error) {
    if (error instanceof PublicToolError) throw error
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new GarminSessionTokenFileMissingError()
    }
    throw new PublicToolError('Garmin session token file could not be read')
  } finally {
    await file?.close().catch(() => undefined)
  }
  try {
    const parsed = JSON.parse(source) as unknown
    if (isObsoleteDiSessionFile(parsed)) throw new ObsoleteGarminDiSessionError()
    if (isRecord(parsed) && parsed.kind === 'di-oauth' && !isDiSessionFile(parsed)) {
      throw new GarminDiSessionFileError()
    }
    if (!isSessionFile(parsed)) throw new Error('Invalid token structure')
    return parsed
  } catch (error) {
    if (error instanceof GarminDiSessionFileError) throw error
    throw new GarminSessionTokenFileInvalidError()
  }
}

/**
 * Resolve parent symlinks once, then read only from the canonical private
 * directory. This preserves the writer's supported private-directory alias
 * while removing the requested symlink chain from all subsequent file access.
 */
async function resolvePrivatePosixReadDestination(path: string): Promise<string> {
  const requestedParent = dirname(path)
  const canonicalParent = await realpath(requestedParent)
  await verifyPrivatePosixReadParent(canonicalParent)
  return join(canonicalParent, basename(path))
}

async function verifyPrivatePosixReadParent(path: string): Promise<void> {
  if (await realpath(path) !== path) {
    throw new Error('Unsafe session directory')
  }
  await verifySafePosixAncestorChain(path)
  await verifyPrivatePosixParent(path)
  if (await realpath(path) !== path) {
    throw new Error('Unsafe session directory')
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

  let destination = resolve(path)
  let parent = dirname(destination)
  let temporaryPath: string | undefined
  let temporaryFile: FileHandle | undefined
  try {
    let windowsAcl: WindowsPrivateAcl | undefined
    if (process.platform === 'win32') {
      windowsAcl = await createWindowsPrivateAcl()
      // Existing directories are verified without mutation. Missing parents
      // are created by Directory.CreateDirectory(path, DirectorySecurity), so
      // the exact DACL exists atomically from the first observable instant.
      await windowsAcl.prepareDirectory(parent)
    } else {
      const prepared = await preparePosixSessionWriteDestination(destination)
      destination = prepared.destination
      parent = prepared.parent
    }

    temporaryPath = join(
      parent,
      `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error('Unsafe session directory')
    }
    if (process.platform !== 'win32') {
      await verifyPrivatePosixParent(parent)
    }

    const temporaryFlags = process.platform === 'win32'
      ? 'wx'
      : constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW
    temporaryFile = await open(temporaryPath, temporaryFlags, 0o600)
    // Windows ignores POSIX mode bits. Secure the still-empty file before any
    // credential bytes are written; the same-directory rename then preserves
    // this DACL on the final session file.
    await windowsAcl?.secureFile(temporaryPath)
    if (process.platform !== 'win32') {
      await verifyPrivatePosixFileHandle(temporaryFile, temporaryPath)
    }
    await temporaryFile.writeFile(serialized, { encoding: 'utf8' })
    await temporaryFile.sync()
    await temporaryFile.close()
    temporaryFile = undefined
    if (process.platform !== 'win32') {
      await verifyPrivatePosixParent(parent)
      await verifySafeExistingPosixDestination(destination)
    }
    await rename(temporaryPath, destination)
  } catch {
    await temporaryFile?.close().catch(() => undefined)
    if (temporaryPath !== undefined) {
      try {
        await unlink(temporaryPath)
      } catch {
        // The temporary file may not exist yet or may already have been renamed.
      }
    }
    throw new PublicToolError('Garmin session token file could not be written')
  }
}

/**
 * Validate and prepare a write destination before browser authentication
 * starts. POSIX resolves existing symlinks to a canonical private target and
 * creates each missing directory owner-only. Windows atomically creates a
 * missing exact-private parent, or read-only verifies that an existing parent
 * already has the exact current-user DACL.
 */
export async function prepareSessionTokenWriteDestination(path: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const parent = dirname(resolve(path))
      const windowsAcl = await createWindowsPrivateAcl()
      await windowsAcl.prepareDirectory(parent)
      return
    }

    await preparePosixSessionWriteDestination(path)
  } catch (error) {
    throw new GarminSessionDestinationPreparationError(
      authDiagnosticCodeFromError(error, 'destination_prepare_failed'),
    )
  }
}

interface PreparedPosixSessionDestination {
  destination: string
  parent: string
}

/**
 * Canonicalize and prepare a POSIX session destination without ever using
 * recursive mkdir. Existing symlink components are resolved once, then only
 * the canonical path is used for creation and writes.
 */
async function preparePosixSessionWriteDestination(
  path: string,
): Promise<PreparedPosixSessionDestination> {
  const requestedDestination = resolve(path)
  const destinationName = basename(requestedDestination)
  if (destinationName.length === 0) throw new Error('Invalid session destination')

  const requestedParent = dirname(requestedDestination)
  const { existingPath, missingComponents } = await findDeepestExistingPath(
    requestedParent,
  )
  const canonicalExistingPath = await realpath(existingPath)
  await verifySafePosixAncestorChain(canonicalExistingPath)

  let canonicalParent = canonicalExistingPath
  if (missingComponents.length > 0) {
    // The exact existing directory into which the first component is created
    // must be controlled and writable by this process. A shared sticky temp
    // directory is an acceptable ancestor, but never a creation anchor.
    await verifyPosixCreationAnchor(canonicalParent)
    for (const component of missingComponents) {
      const next = join(canonicalParent, component)
      try {
        await mkdir(next, { mode: 0o700 })
      } catch (error) {
        if (!isRecord(error) || error.code !== 'EEXIST') throw error
      }
      await verifyPrivatePosixParent(next)
      if (await realpath(next) !== next) {
        throw new Error('Unsafe session directory')
      }
      canonicalParent = next
    }
  }

  if (await realpath(canonicalParent) !== canonicalParent) {
    throw new Error('Unsafe session directory')
  }
  await verifySafePosixAncestorChain(canonicalParent)
  await verifyPrivatePosixParent(canonicalParent)

  const destination = join(canonicalParent, destinationName)
  await verifySafeExistingPosixDestination(destination)
  return { destination, parent: canonicalParent }
}

async function findDeepestExistingPath(path: string): Promise<{
  existingPath: string
  missingComponents: string[]
}> {
  let current = path
  const missingComponents: string[] = []
  while (true) {
    try {
      await lstat(current)
      return { existingPath: current, missingComponents }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }

    const parent = dirname(current)
    if (parent === current) throw new Error('Session directory has no anchor')
    missingComponents.unshift(basename(current))
    current = parent
  }
}

async function verifySafePosixAncestorChain(path: string): Promise<void> {
  const effectiveUid = currentEffectiveUid()
  for (const ancestor of ancestorPaths(path)) {
    const before = await lstat(ancestor)
    assertSafePosixAncestor(before, effectiveUid)
    const after = await verifyDarwinAclBoundToEntry(ancestor, before)
    assertSafePosixAncestor(after, effectiveUid)
  }
}

async function verifyPosixCreationAnchor(path: string): Promise<void> {
  const effectiveUid = currentEffectiveUid()
  const before = await lstat(path)
  assertPosixCreationAnchor(before, effectiveUid)
  const after = await verifyDarwinAclBoundToEntry(path, before)
  assertPosixCreationAnchor(after, effectiveUid)
}

async function verifyPrivatePosixParent(path: string): Promise<void> {
  const effectiveUid = currentEffectiveUid()
  const before = await lstat(path)
  assertPrivatePosixParent(before, effectiveUid)
  const after = await verifyDarwinAclBoundToEntry(path, before)
  assertPrivatePosixParent(after, effectiveUid)
}

async function verifySafeExistingPosixDestination(path: string): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return
    throw error
  }
  const effectiveUid = currentEffectiveUid()
  assertPrivatePosixFile(info, effectiveUid, 'Unsafe session destination')
  const after = await verifyDarwinAclBoundToEntry(path, info)
  assertPrivatePosixFile(after, effectiveUid, 'Unsafe session destination')
}

async function verifyPrivatePosixFileHandle(
  file: FileHandle,
  path: string,
): Promise<void> {
  const info = await file.stat()
  const effectiveUid = currentEffectiveUid()
  assertPrivatePosixFile(info, effectiveUid, 'Unsafe session file')
  const before = await lstat(path)
  assertSameFileSystemEntry(info, before)
  assertPrivatePosixFile(before, effectiveUid, 'Unsafe session file')
  const after = await verifyDarwinAclBoundToEntry(path, before)
  assertSameFileSystemEntry(info, after)
  assertPrivatePosixFile(after, effectiveUid, 'Unsafe session file')
}

async function verifyDarwinAclBoundToEntry(
  path: string,
  before: Stats,
): Promise<Stats> {
  if (process.platform !== 'darwin') return before
  await verifyNoGrantingDarwinAcl(path)
  const after = await lstat(path)
  assertSameFileSystemEntry(before, after)
  return after
}

function assertSafePosixAncestor(
  info: Stats,
  effectiveUid: number | undefined,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Unsafe session directory')
  }
  if (
    effectiveUid !== undefined
    && info.uid !== 0
    && info.uid !== effectiveUid
  ) {
    throw new Error('Unsafe session directory owner')
  }
  if (
    (info.mode & 0o022) !== 0
    && !(info.uid === 0 && (info.mode & 0o1000) !== 0)
  ) {
    throw new Error('Unsafe session directory permissions')
  }
}

function assertPosixCreationAnchor(
  info: Stats,
  effectiveUid: number | undefined,
): void {
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (effectiveUid !== undefined && info.uid !== effectiveUid)
    || (info.mode & 0o300) !== 0o300
    || (info.mode & 0o022) !== 0
  ) {
    throw new Error('Unsafe session directory anchor')
  }
}

function assertPrivatePosixParent(
  info: Stats,
  effectiveUid: number | undefined,
): void {
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (effectiveUid !== undefined && info.uid !== effectiveUid)
    || (info.mode & 0o300) !== 0o300
    || (info.mode & 0o077) !== 0
  ) {
    throw new Error('Unsafe session directory')
  }
}

function assertPrivatePosixFile(
  info: Stats,
  effectiveUid: number | undefined,
  message: string,
): void {
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.nlink !== 1
    || (effectiveUid !== undefined && info.uid !== effectiveUid)
    || (info.mode & 0o077) !== 0
  ) {
    throw new Error(message)
  }
}

function assertSameFileSystemEntry(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error('Session path changed during verification')
  }
}

function ancestorPaths(path: string): string[] {
  const paths: string[] = []
  let current = path
  while (true) {
    paths.unshift(current)
    const parent = dirname(current)
    if (parent === current) return paths
    current = parent
  }
}

function currentEffectiveUid(): number | undefined {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined
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
