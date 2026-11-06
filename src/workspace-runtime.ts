import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { defaultAccountSessionPath } from './account-session'
import { PublicToolError } from './utils/errors'
import { createWindowsPrivateAcl, type WindowsPrivateAcl } from './windows-private-acl'

export interface WorkspaceDescriptor {
  scopeId: string
  dataDirectory: string
}
export interface WorkspaceEndpoint {
  version: 1
  scopeId: string
  pid: number
  instanceId: string
  origin: string
  accessToken: string
}
export interface WorkspaceLease {
  readonly instanceId: string
  publish(endpoint: { origin: string; accessToken: string }): Promise<void>
  close(): Promise<void>
}

const INSTANCE = /^[0-9a-f]{48}$/
const MANIFEST = /^workspace-[0-9a-f]{64}\.json$/
let windowsAcl: Promise<WindowsPrivateAcl> | undefined
function windows(): Promise<WindowsPrivateAcl> | undefined {
  if (process.platform !== 'win32') return undefined
  return windowsAcl ??= createWindowsPrivateAcl()
}
export function defaultWorkspaceDirectory(): string {
  return join(dirname(dirname(defaultAccountSessionPath('default'))), 'coach-workspace')
}
export function workspaceDigest(scopeId: string): string {
  return createHash('sha256').update(scopeId).digest('hex')
}
export function normalizeWorkspace(descriptor: WorkspaceDescriptor): WorkspaceDescriptor {
  if (typeof descriptor.scopeId !== 'string' || !descriptor.scopeId.trim() || descriptor.scopeId.length > 512
    || /[\u0000-\u001f\u007f]/.test(descriptor.scopeId)
    || typeof descriptor.dataDirectory !== 'string' || !descriptor.dataDirectory.trim()) throw unavailable()
  return { scopeId: descriptor.scopeId, dataDirectory: resolve(descriptor.dataDirectory) }
}
export async function prepareWorkspaceDirectory(path: string): Promise<void> {
  const acl = await windows()
  if (acl) await acl.prepareDirectory(path)
  else await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (!acl && (info.mode & 0o077) !== 0)) throw unavailable()
}
async function privateJson(path: string): Promise<unknown> {
  const info = await lstat(path)
  const acl = await windows()
  if (acl) await acl.verifyFile(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (!acl && (info.mode & 0o077) !== 0)) throw unavailable()
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { return JSON.parse(await handle.readFile('utf8')) }
  finally { await handle.close() }
}
async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`
  let created = false
  try {
    const handle = await open(temporary, 'wx', 0o600)
    created = true
    try {
      const acl = await windows()
      if (acl) await acl.secureFile(temporary)
      await handle.writeFile(JSON.stringify(value), 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, path)
  }
  finally { if (created) await rm(temporary, { force: true }) }
}

/** Only a contender that won an exclusive mkdir may secure this new directory. */
async function prepareCreatedWorkspaceDirectory(path: string): Promise<void> {
  const acl = await windows()
  if (acl) await acl.secureDirectory(path)
  await prepareWorkspaceDirectory(path)
}

async function removeEmptyCreatedDirectory(path: string): Promise<void> {
  // Do not delete an unexpected file/owner another actor placed, and do not
  // replace the original initialization failure with a cleanup error.
  await rmdir(path).catch(() => undefined)
}
export async function registerWorkspace(input: WorkspaceDescriptor): Promise<WorkspaceDescriptor> {
  const descriptor = normalizeWorkspace(input)
  await prepareWorkspaceDirectory(descriptor.dataDirectory)
  const path = join(descriptor.dataDirectory, `workspace-${workspaceDigest(descriptor.scopeId)}.json`)
  try {
    const stored = await privateJson(path) as Record<string, unknown>
    if (stored?.version !== 1 || stored.scopeId !== descriptor.scopeId) throw unavailable()
  } catch (error) {
    if (!missing(error)) throw error
    await writePrivateJson(path, { version: 1, scopeId: descriptor.scopeId })
  }
  return descriptor
}
export async function listWorkspaces(dataDirectory = defaultWorkspaceDirectory()): Promise<WorkspaceDescriptor[]> {
  const directory = resolve(dataDirectory)
  let names: string[]
  try { names = await readdir(directory) }
  catch (error) { if (missing(error)) return []; throw unavailable() }
  await prepareWorkspaceDirectory(directory)
  const result: WorkspaceDescriptor[] = []
  for (const name of names.filter(value => MANIFEST.test(value)).sort()) {
    const stored = await privateJson(join(directory, name)) as Record<string, unknown>
    if (stored?.version !== 1 || typeof stored.scopeId !== 'string'
      || name !== `workspace-${workspaceDigest(stored.scopeId)}.json`) throw unavailable()
    result.push(normalizeWorkspace({ scopeId: stored.scopeId, dataDirectory: directory }))
  }
  return result
}
function runtimePaths(descriptor: WorkspaceDescriptor) {
  const prefix = join(descriptor.dataDirectory, `runtime-${workspaceDigest(descriptor.scopeId)}`)
  return { lock: `${prefix}.lock`, reclaim: `${prefix}.reclaim` }
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
function validOwner(value: unknown): value is { version: 1; pid: number; instanceId: string } {
  if (!value || typeof value !== 'object') return false
  const owner = value as Record<string, unknown>
  return owner.version === 1 && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
    && typeof owner.instanceId === 'string' && INSTANCE.test(owner.instanceId)
}
async function reclaimGateExists(path: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof lstat>>
  try { info = await lstat(path) }
  catch (error) { if (missing(error)) return false; throw unavailable() }
  if (!info.isDirectory() || info.isSymbolicLink()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw unavailable()
  let owner: unknown
  try { owner = await privateJson(join(path, 'owner.json')) }
  catch (error) { if (!missing(error)) throw unavailable() }
  if (owner !== undefined && !validOwner(owner)) throw unavailable()
  if (validOwner(owner) && processAlive(owner.pid)) return true
  if (!owner && Date.now() - info.mtimeMs < 120_000) return true
  // A reclaimer can itself be killed. Quarantine its gate before removal so
  // no subsequent owner shares the old directory. The main lease is checked
  // again after acquiring the new gate; a live owner is never reclaimed.
  const stale = `${path}.stale-${randomBytes(12).toString('hex')}`
  try { await rename(path, stale) }
  catch (error) { if (missing(error)) return false; throw unavailable() }
  await rm(stale, { recursive: true, force: true })
  return false
}
/** A private filesystem lease ensures only one process ever owns Garmin refresh state. */
export async function acquireWorkspaceLease(input: WorkspaceDescriptor): Promise<WorkspaceLease | undefined> {
  const descriptor = await registerWorkspace(input)
  const paths = runtimePaths(descriptor)
  if (await reclaimGateExists(paths.reclaim)) return undefined
  try { await mkdir(paths.lock, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable()
    // Only one contender may reclaim a dead owner's directory. Every contender
    // checks this gate before creating a lease, so stale cleanup cannot delete a
    // newly published owner's files.
    const reclaimId = randomBytes(24).toString('hex')
    let createdReclaim = false
    try {
      await mkdir(paths.reclaim, { mode: 0o700 })
      createdReclaim = true
      await prepareCreatedWorkspaceDirectory(paths.reclaim)
      await writePrivateJson(join(paths.reclaim, 'owner.json'), { version: 1, pid: process.pid, instanceId: reclaimId })
    }
    catch {
      if (createdReclaim) await removeEmptyCreatedDirectory(paths.reclaim)
      return undefined
    }
    try {
      let owner: unknown
      try { owner = await privateJson(join(paths.lock, 'owner.json')) }
      catch (failure) {
        if (!missing(failure)) throw unavailable()
        // Creation includes securing files on Windows; never steal a lease
        // merely because the owner is between mkdir and durable publication.
        const info = await lstat(paths.lock)
        if (Date.now() - info.mtimeMs < 120_000) return undefined
      }
      if (owner !== undefined && !validOwner(owner)) throw unavailable()
      if (validOwner(owner) && processAlive(owner.pid)) return undefined
      await rm(paths.lock, { recursive: true, force: true })
    } catch (failure) { if (!missing(failure)) throw failure }
    finally {
      try {
        const owner = await privateJson(join(paths.reclaim, 'owner.json'))
        if (validOwner(owner) && owner.pid === process.pid && owner.instanceId === reclaimId) {
          await rm(paths.reclaim, { recursive: true, force: true })
        }
      } catch (error) { if (!missing(error)) throw error }
    }
    return acquireWorkspaceLease(descriptor)
  }
  const instanceId = randomBytes(24).toString('hex')
  let closed = false
  try {
    await prepareCreatedWorkspaceDirectory(paths.lock)
    await writePrivateJson(join(paths.lock, 'owner.json'), { version: 1, pid: process.pid, instanceId })
  } catch (error) { await removeEmptyCreatedDirectory(paths.lock); throw error }
  const own = async () => {
    const owner = await privateJson(join(paths.lock, 'owner.json'))
    return validOwner(owner) && owner.instanceId === instanceId && owner.pid === process.pid
  }
  return {
    instanceId,
    async publish(endpoint) {
      if (closed || !isWorkspaceOrigin(endpoint.origin) || !INSTANCE.test(endpoint.accessToken) || !await own()) throw unavailable()
      await writePrivateJson(join(paths.lock, 'endpoint.json'), { version: 1, scopeId: descriptor.scopeId,
        pid: process.pid, instanceId, origin: endpoint.origin, accessToken: endpoint.accessToken } satisfies WorkspaceEndpoint)
    },
    async close() {
      if (closed) return
      closed = true
      try { if (await own()) await rm(paths.lock, { recursive: true, force: true }) }
      catch (error) { if (!missing(error)) throw error }
    },
  }
}
export async function readWorkspaceEndpoint(input: WorkspaceDescriptor): Promise<WorkspaceEndpoint | undefined> {
  const descriptor = normalizeWorkspace(input)
  const paths = runtimePaths(descriptor)
  let value: unknown
  try {
    const owner = await privateJson(join(paths.lock, 'owner.json'))
    if (!validOwner(owner) || !processAlive(owner.pid)) return undefined
    value = await privateJson(join(paths.lock, 'endpoint.json'))
    const endpoint = value as WorkspaceEndpoint
    if (!endpoint || endpoint.version !== 1 || endpoint.scopeId !== descriptor.scopeId
      || endpoint.pid !== owner.pid || endpoint.instanceId !== owner.instanceId
      || typeof endpoint.accessToken !== 'string' || !INSTANCE.test(endpoint.accessToken)
      || !isWorkspaceOrigin(endpoint.origin)) throw unavailable()
    return endpoint
  } catch (error) { if (missing(error)) return undefined; throw error }
}
export function isWorkspaceOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^[1-9]\d{0,4}$/.test(url.port)
      && Number(url.port) <= 65535 && url.origin === value && !url.username && !url.password
  } catch { return false }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function unavailable(): PublicToolError { return new PublicToolError('The local Garmin workspace is unavailable; check its private storage permissions') }
