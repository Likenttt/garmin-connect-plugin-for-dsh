import type { Context } from '@deepseek-ai/cordis'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config'
import * as registries from '../src/account-registry'
import * as factories from '../src/client-factory'
import { registerHarnessWorkspace } from '../src/workspace-harness'
import * as runtime from '../src/workspace-runtime'
import * as services from '../src/workspace-service'
import * as servers from '../src/workspace-server'
import { hasNodeSqlite } from './helpers/sqlite'

interface Route { path: string; fetch(request: Request): Promise<Response> }
const roots: string[] = []
const fixtures: Array<{ dispose(): Promise<void> }> = []
const releases: Array<() => void> = []
const baseConfig: Config = {
  username: '', region: 'cn', cacheTtl: 300, requestTimeoutMs: 15_000,
  logLevel: 'error', activityDetail: 'full', fitDownloadDir: '',
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose()
  jest.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'garmin-harness-retry-'))
  roots.push(root)
  const directory = join(root, 'workspace')
  jest.spyOn(runtime, 'defaultWorkspaceDirectory').mockReturnValue(directory)
  const createClient = jest.spyOn(factories, 'createGarminClient').mockImplementation(() => {
    throw new Error('Local catalog probes must not construct a Garmin SDK client')
  })
  const routes = new Map<string, Route>()
  const disposers: Array<() => unknown> = []
  let membersRoute: Route | undefined
  let disposed = false
  const context: any = {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    tools: { register: jest.fn() }, on: jest.fn(),
    effect(install: () => (() => unknown) | undefined) {
      const cleanup = install()
      if (cleanup) disposers.push(cleanup)
    },
    inject(_dependencies: string[], install: (ctx: Context) => void) { install(context) },
    connection: {
      fetch: { register(route: Route) {
        routes.set(route.path, route)
        if (route.path === '/api/garmin-coach/members') membersRoute = route
        return () => { routes.delete(route.path) }
      } },
      rpc: { handle() { throw new Error('The actual Fetch route must serve this fixture') } },
    },
  }
  const value = {
    directory, routes, createClient,
    start() { registerHarnessWorkspace(context, { scopeId: 'synthetic-retry-profile', legacySeeds: [], baseConfig }) },
    async probe() {
      if (!membersRoute) throw new Error('Missing actual Host members Fetch route')
      // Keep this registered function after disposal to exercise late transport work.
      const response = await membersRoute.fetch(new Request('http://127.0.0.1/api/garmin-coach/members', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'retry-regression', method: 'garmin-coach/members', payload: {} }),
      }))
      expect(response.status).toBe(200)
      const envelope = await response.json() as { result: { ok: boolean; value: any } }
      expect(envelope.result.ok).toBe(true)
      return envelope.result.value
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const cleanup of disposers.splice(0).reverse()) await cleanup()
    },
  }
  fixtures.push(value)
  return value
}

function stubOwner() {
  const registry = {
    managed: true, ready: jest.fn(async () => undefined), list: () => [],
    subscribe: () => () => undefined, close: jest.fn(), upsert: jest.fn(), remove: jest.fn(),
  } satisfies registries.MutableAccountRegistry
  const service = {
    tools: [], call: jest.fn(async () => ({ success: true, managed: true, members: [] })),
    auth: jest.fn(), invokeTool: jest.fn(), close: jest.fn(async () => undefined),
  } satisfies services.WorkspaceService
  const server = { origin: 'http://127.0.0.1:43127', openPage: () => ({ url: '' }), close: jest.fn(async () => undefined) }
  const lease = { instanceId: 'a'.repeat(48), publish: jest.fn(async () => undefined), close: jest.fn(async () => undefined) }
  const createRegistry = jest.spyOn(registries, 'createAccountRegistry').mockReturnValue(registry)
  jest.spyOn(services, 'createWorkspaceService').mockReturnValue(service)
  const startServer = jest.spyOn(servers, 'startWorkspaceServer').mockResolvedValue(server)
  const acquireLease = jest.spyOn(runtime, 'acquireWorkspaceLease').mockResolvedValue(lease)
  return { registry, service, server, lease, createRegistry, startServer, acquireLease }
}

const itWithPrivateSqlite = hasNodeSqlite && process.platform !== 'win32' ? it : it.skip

itWithPrivateSqlite('recovers the actual members probe after fixing a transient directory permission failure', async () => {
  const f = await fixture()
  await mkdir(f.directory, { mode: 0o700 })
  await chmod(f.directory, 0o755)
  f.start()
  expect(await f.probe()).toMatchObject({ success: false })

  await chmod(f.directory, 0o700)
  expect(await f.probe()).toMatchObject({ success: true, managed: true, members: [] })
  expect(f.createClient).not.toHaveBeenCalled()
  expect((await readdir(f.directory)).some(name => /^runtime-.+\.lock$/.test(name))).toBe(true)
  await f.dispose()
  expect((await readdir(f.directory)).some(name => /^runtime-.+\.(lock|reclaim)$/.test(name))).toBe(false)
})

it('coalesces concurrent retries into one owner after a failed registration', async () => {
  const f = await fixture()
  const owner = stubOwner()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  let repaired = false
  const register = jest.spyOn(runtime, 'registerWorkspace').mockImplementation(async descriptor => {
    if (!repaired) throw new Error('Transient local workspace registration failure')
    await gate
    return descriptor
  })
  f.start()
  expect(await f.probe()).toMatchObject({ success: false })
  const initialRegistrations = register.mock.calls.length
  repaired = true

  const probes = Array.from({ length: 6 }, () => f.probe())
  await new Promise(resolve => setImmediate(resolve))
  const registrationsWhilePending = register.mock.calls.length
  release()
  const results = await Promise.all(probes)
  expect(registrationsWhilePending).toBe(initialRegistrations + 1)
  for (const result of results) expect(result).toMatchObject({ success: true, managed: true })
  expect(owner.acquireLease).toHaveBeenCalledTimes(1)
  expect(owner.createRegistry).toHaveBeenCalledTimes(1)
  expect(owner.startServer).toHaveBeenCalledTimes(1)
  expect(owner.lease.publish).toHaveBeenCalledTimes(1)
  expect(f.createClient).not.toHaveBeenCalled()
  await f.dispose()
  expect(owner.server.close).toHaveBeenCalledTimes(1)
  expect(owner.service.close).toHaveBeenCalledTimes(1)
  expect(owner.registry.close).toHaveBeenCalledTimes(1)
  expect(owner.lease.close).toHaveBeenCalledTimes(1)
  expect(f.routes.size).toBe(0)
})

it('does not retry a failed owner after disposal, including late Fetch work', async () => {
  const f = await fixture()
  const owner = stubOwner()
  const register = jest.spyOn(runtime, 'registerWorkspace').mockRejectedValue(new Error('Transient registration failure'))
  f.start()
  expect(await f.probe()).toMatchObject({ success: false })
  const registrationsBeforeDisposal = register.mock.calls.length
  await f.dispose()
  expect(await f.probe()).toMatchObject({ success: false })
  expect(register).toHaveBeenCalledTimes(registrationsBeforeDisposal)
  expect(owner.acquireLease).not.toHaveBeenCalled()
  expect(owner.createRegistry).not.toHaveBeenCalled()
  expect(owner.startServer).not.toHaveBeenCalled()
  expect(f.routes.size).toBe(0)
})

it('does not acquire an owner when disposed during pending registration', async () => {
  const f = await fixture()
  const owner = stubOwner()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const register = jest.spyOn(runtime, 'registerWorkspace').mockImplementation(async descriptor => {
    await gate
    return descriptor
  })
  f.start()
  const closing = f.dispose()
  release()
  await closing
  expect(await f.probe()).toMatchObject({ success: false })
  expect(register).toHaveBeenCalledTimes(1)
  expect(owner.acquireLease).not.toHaveBeenCalled()
  expect(owner.createRegistry).not.toHaveBeenCalled()
  expect(owner.startServer).not.toHaveBeenCalled()
  expect(f.routes.size).toBe(0)
})

it('releases a lease returned after disposal without constructing a catalog or listener', async () => {
  const f = await fixture()
  const owner = stubOwner()
  jest.spyOn(runtime, 'registerWorkspace').mockImplementation(async descriptor => descriptor)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  owner.acquireLease.mockImplementation(async () => { await gate; return owner.lease })
  f.start()
  await new Promise(resolve => setImmediate(resolve))
  const closing = f.dispose()
  release()
  await closing
  expect(await f.probe()).toMatchObject({ success: false })
  expect(owner.acquireLease).toHaveBeenCalledTimes(1)
  expect(owner.lease.close).toHaveBeenCalledTimes(1)
  expect(owner.createRegistry).not.toHaveBeenCalled()
  expect(owner.startServer).not.toHaveBeenCalled()
  expect(f.routes.size).toBe(0)
})
