import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireWorkspaceLease, isWorkspaceOrigin, readWorkspaceEndpoint, registerWorkspace,
  workspaceDigest, type WorkspaceLease } from '../src/workspace-runtime'
import { connectWorkspace, resolveWorkspace } from '../src/workspace-client'

const directories: string[] = []
const leases: WorkspaceLease[] = []
async function workspace(scopeId = 'test-workspace') {
  const root = await mkdtemp(join(tmpdir(), 'garmin-workspace-test-'))
  directories.push(root)
  return { scopeId, dataDirectory: join(root, 'private') }
}
async function lease(descriptor: Awaited<ReturnType<typeof workspace>>) {
  const value = await acquireWorkspaceLease(descriptor)
  if (!value) throw new Error('Expected a lease')
  leases.push(value)
  return value
}
afterEach(async () => {
  for (const value of leases.splice(0)) await value.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

it('discovers one shared scope and requires explicit selection when multiple workspaces exist', async () => {
  const descriptor = await workspace()
  await registerWorkspace(descriptor)
  expect(await resolveWorkspace({ dataDirectory: descriptor.dataDirectory })).toEqual(descriptor)
  await registerWorkspace({ ...descriptor, scopeId: 'second-workspace' })
  await expect(resolveWorkspace({ dataDirectory: descriptor.dataDirectory })).rejects.toThrow('Multiple Garmin workspaces')
  expect(await resolveWorkspace({ ...descriptor })).toEqual(descriptor)
})

it('does not replace an undiscovered legacy Harness catalog with an empty standalone workspace', async () => {
  const descriptor = await workspace()
  await mkdir(descriptor.dataDirectory, { mode: 0o700 })
  await writeFile(join(descriptor.dataDirectory, `accounts-${'a'.repeat(64)}.sqlite`), '', { mode: 0o600 })
  await expect(resolveWorkspace({ dataDirectory: descriptor.dataDirectory })).rejects.toThrow('Open Harness once')
  expect((await readdir(descriptor.dataDirectory)).some(name => name.startsWith('workspace-'))).toBe(false)
})

it('publishes one private endpoint per scope and retains the current owner until it closes', async () => {
  const descriptor = await workspace()
  const owner = await lease(descriptor)
  await expect(acquireWorkspaceLease(descriptor)).resolves.toBeUndefined()
  await owner.publish({ origin: 'http://127.0.0.1:8811', accessToken: 'a'.repeat(48) })
  expect(await readWorkspaceEndpoint(descriptor)).toMatchObject({ scopeId: descriptor.scopeId,
    instanceId: owner.instanceId, pid: process.pid, origin: 'http://127.0.0.1:8811' })
  const names = await readdir(descriptor.dataDirectory)
  const manifest = names.find(name => name.startsWith('workspace-'))!
  expect(await readFile(join(descriptor.dataDirectory, manifest), 'utf8')).not.toContain('a'.repeat(48))
  if (process.platform !== 'win32') {
    const path = join(descriptor.dataDirectory, `runtime-${workspaceDigest(descriptor.scopeId)}.lock`, 'endpoint.json')
    expect((await stat(descriptor.dataDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  }
  await owner.close()
  expect(await readWorkspaceEndpoint(descriptor)).toBeUndefined()
  expect(await acquireWorkspaceLease(descriptor)).toBeDefined()
})

it('reclaims a confirmed dead process without adopting its bearer token or instance', async () => {
  const descriptor = await workspace()
  const previous = await lease(descriptor)
  const path = join(descriptor.dataDirectory, `runtime-${workspaceDigest(descriptor.scopeId)}.lock`, 'owner.json')
  await writeFile(path, JSON.stringify({ version: 1, pid: 2147483647, instanceId: previous.instanceId }), { mode: 0o600 })
  expect(await readWorkspaceEndpoint(descriptor)).toBeUndefined()
  const next = await lease(descriptor)
  expect(next.instanceId).not.toBe(previous.instanceId)
})

it('recovers when a stale-owner reclaimer was killed before removing its gate', async () => {
  const descriptor = await workspace()
  await registerWorkspace(descriptor)
  const gate = join(descriptor.dataDirectory, `runtime-${workspaceDigest(descriptor.scopeId)}.reclaim`)
  await mkdir(gate, { mode: 0o700 })
  await writeFile(join(gate, 'owner.json'), JSON.stringify({ version: 1, pid: 2147483647,
    instanceId: 'd'.repeat(48) }), { mode: 0o600 })
  const owner = await lease(descriptor)
  await owner.publish({ origin: 'http://127.0.0.1:8815', accessToken: 'e'.repeat(48) })
  expect((await readWorkspaceEndpoint(descriptor))?.instanceId).toBe(owner.instanceId)
  expect((await readdir(descriptor.dataDirectory)).some(name => name.includes('.reclaim'))).toBe(false)
})

it('keeps connection creation lazy and forwards calls only to the authenticated shared owner', async () => {
  const descriptor = await workspace()
  const owner = await lease(descriptor)
  const token = 'b'.repeat(48)
  await owner.publish({ origin: 'http://127.0.0.1:8812', accessToken: token })
  const start = jest.fn(async () => undefined)
  const fetchRequest = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` })
    if (String(url).endsWith('/internal/health')) return new Response(JSON.stringify({ success: true, instanceId: owner.instanceId }))
    expect(JSON.parse(String(init?.body))).toEqual({ accountId: 'account-a' })
    return new Response(JSON.stringify({ success: true, accountId: 'account-a' }))
  }) as unknown as typeof fetch
  const connection = await connectWorkspace(descriptor, { start, fetch: fetchRequest })
  expect(start).not.toHaveBeenCalled()
  expect(fetchRequest).not.toHaveBeenCalled()
  expect(await connection.call('members', { accountId: 'account-a' })).toEqual({ success: true, accountId: 'account-a' })
  expect(fetchRequest).toHaveBeenCalledWith('http://127.0.0.1:8812/internal/coach/members', expect.objectContaining({ method: 'POST' }))
  expect(start).not.toHaveBeenCalled()
  await connection.close()
  await expect(connection.call('members', {})).rejects.toThrow('connection is closed')
})

it('starts the daemon only on demand and rejects path traversal before contacting it', async () => {
  const descriptor = await workspace()
  const token = 'c'.repeat(48)
  let owner: WorkspaceLease
  const start = jest.fn(async () => {
    owner = await lease(descriptor)
    await owner.publish({ origin: 'http://127.0.0.1:8813', accessToken: token })
  })
  const fetchRequest = jest.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).endsWith('/internal/health') ? { success: true, instanceId: owner.instanceId } : { success: true },
  ))) as unknown as typeof fetch
  const connection = await connectWorkspace(descriptor, { start, fetch: fetchRequest })
  expect(() => connection.call('../keys', {})).toThrow('Invalid Garmin workspace operation')
  expect(start).not.toHaveBeenCalled()
  await connection.invokeTool('get_garmin_profile', { accountId: 'account-a' })
  expect(start).toHaveBeenCalledTimes(1)
  expect(fetchRequest).toHaveBeenCalledWith('http://127.0.0.1:8813/internal/tool/get_garmin_profile', expect.objectContaining({ method: 'POST' }))
  await connection.close()
})

it('reapplies accepted Harness runtime settings before dispatching to a restarted owner', async () => {
  const descriptor = await workspace()
  let owner = await lease(descriptor)
  let token = 'f'.repeat(48)
  await owner.publish({ origin: 'http://127.0.0.1:8816', accessToken: token })
  const calls: string[] = []
  const config = { cacheTtl: 0, logLevel: 'debug', activityDetail: 'compact', fitDownloadDir: '', authVerbose: true }
  const fetchRequest = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` })
    if (String(url).endsWith('/internal/health')) return new Response(JSON.stringify({ success: true, instanceId: owner.instanceId }))
    calls.push(String(url))
    if (String(url).endsWith('/internal/configure')) expect(JSON.parse(String(init?.body))).toEqual(config)
    return new Response(JSON.stringify({ success: true }))
  }) as unknown as typeof fetch
  const connection = await connectWorkspace(descriptor, { fetch: fetchRequest, start: jest.fn() })
  await connection.configure(config)
  await connection.call('members', {})
  await owner.close()
  owner = await lease(descriptor)
  token = '1'.repeat(48)
  await owner.publish({ origin: 'http://127.0.0.1:8817', accessToken: token })
  await connection.invokeTool('get_garmin_profile', { accountId: 'account-a' })
  expect(calls).toEqual([
    'http://127.0.0.1:8816/internal/configure', 'http://127.0.0.1:8816/internal/coach/members',
    'http://127.0.0.1:8817/internal/configure', 'http://127.0.0.1:8817/internal/tool/get_garmin_profile',
  ])
  await connection.close()
})

it('accepts only exact loopback origins and rejects public, credentialed and path-bearing URLs', () => {
  expect(isWorkspaceOrigin('http://127.0.0.1:8811')).toBe(true)
  for (const value of ['http://localhost:8811', 'http://127.0.0.1:8811/', 'https://127.0.0.1:8811',
    'http://127.0.0.1:8811/path', 'http://user:secret@127.0.0.1:8811', 'http://192.168.1.1:8811']) {
    expect(isWorkspaceOrigin(value)).toBe(false)
  }
})
