import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountRegistry, type MutableAccountRegistry, type RuntimeAccount } from '../src/account-registry'
import type { Config, ResolvedAccountConfig } from '../src/config'
import type { GarminClientLike } from '../src/client'
import { hasNodeSqlite, itWithSqlite } from './helpers/sqlite'

const base: Config = { username: '', region: 'cn', cacheTtl: 300, logLevel: 'error', activityDetail: 'compact', fitDownloadDir: '' }
const temporary: string[] = []
const registries: MutableAccountRegistry[] = []
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'garmin-registry-test-'))
  temporary.push(root)
  return join(root, 'private')
}
function seed(index: number): ResolvedAccountConfig {
  return { accountId: `legacy-${index}`, slot: index + 1, region: 'cn', alias: `学员 ${index}`, configured: true,
    revision: index.toString(16).padStart(32, '0'),
    config: { ...base, provider: 'connect-web', username: `runner${index}@example.test`,
      sessionTokenFile: `/private/kept-session-${index}.json` } }
}
function client(): GarminClientLike {
  return { getAuthenticatedAccount: jest.fn(() => undefined), getAuthenticationRequirement: jest.fn(() => undefined),
    personalApiConnected: jest.fn(() => false), getUserProfile: jest.fn(async () => ({ profileId: 1 })),
    connect: jest.fn(async () => undefined), verifyConnection: jest.fn(async () => undefined),
    deactivate: jest.fn(),
  } as unknown as GarminClientLike
}
function registry(dataDirectory?: string, seeds: ResolvedAccountConfig[] = [], extra: Record<string, unknown> = {}) {
  const createClient = jest.fn(() => client())
  const value = createAccountRegistry({ baseConfig: base, legacySeeds: seeds, scopeId: 'test-workspace', dataDirectory,
    createClient, ...extra })
  registries.push(value)
  return { value, createClient }
}
afterEach(async () => {
  for (const value of registries.splice(0)) value.close()
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

itWithSqlite('migrates 100 accounts without creating clients, preserving IDs, revisions and existing session paths', async () => {
  const dir = await directory()
  const seeds = Array.from({ length: 100 }, (_, index) => seed(index))
  const { value, createClient } = registry(dir, seeds)
  expect(value.list()).toHaveLength(100)
  expect(createClient).not.toHaveBeenCalled()
  await value.ready()
  expect(value.managed).toBe(true)
  expect(value.list()).toHaveLength(100)
  expect(value.list()[99]).toMatchObject({ accountId: seeds[99].accountId, revision: seeds[99].revision,
    config: { sessionTokenFile: seeds[99].config.sessionTokenFile } })
  for (const account of value.list()) {
    expect(account.client.getAuthenticatedAccount()).toBeUndefined()
    expect(account.client.getAuthenticationRequirement()).toBeUndefined()
  }
  expect(createClient).not.toHaveBeenCalled()
  await value.upsert({ alias: '第101位', region: 'global', provider: 'connect-web', username: 'new@example.test' })
  expect(value.list()).toHaveLength(101)
  expect(createClient).not.toHaveBeenCalled()
})

itWithSqlite('imports once and never resurrects archived legacy accounts, including an explicit empty catalog', async () => {
  const dir = await directory()
  const seeds = [seed(0)]
  const first = registry(dir, seeds).value
  await first.ready()
  await first.remove('legacy-0', first.list()[0].revision!)
  expect(first.list()).toEqual([])
  first.close()
  const reopened = registry(dir, seeds).value
  await reopened.ready()
  expect(reopened.managed).toBe(true)
  expect(reopened.list()).toEqual([])
  const created = await reopened.upsert({ alias: '新成员', region: 'cn', provider: 'connect-web', username: 'new@example.test' })
  expect(created.accountId).not.toBe('legacy-0')
  expect(reopened.list()[0].slot).toBe(2)
})

itWithSqlite('serializes edits with optimistic revisions and requires a new Personal key when changing region', async () => {
  const { value } = registry(await directory())
  await value.ready()
  const original = await value.upsert({ alias: 'Personal', region: 'cn', provider: 'personal', personalApiKey: 'private-cn-key' })
  const edits = await Promise.allSettled([
    value.upsert({ ...original, expectedRevision: original.revision, alias: '更新一', region: 'cn', provider: 'personal' }),
    value.upsert({ ...original, expectedRevision: original.revision, alias: '更新二', region: 'cn', provider: 'personal' }),
  ])
  expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(edits.filter(result => result.status === 'rejected')).toHaveLength(1)
  const current = value.list()[0]
  await expect(value.upsert({ accountId: current.accountId, expectedRevision: current.revision,
    alias: '国际', region: 'global', provider: 'personal' })).rejects.toMatchObject({ code: 'invalid' })
  expect(current.config.personalApiKey).toBe('private-cn-key')
})

itWithSqlite('keeps legacy passwords and inline tokens memory-only and credentials out of SQLite', async () => {
  const dir = await directory()
  const legacy = seed(0)
  legacy.config.password = 'PASSWORD-MUST-NOT-PERSIST'
  legacy.config.sessionToken = 'INLINE-MUST-NOT-PERSIST'
  const { value } = registry(dir, [legacy])
  await value.ready()
  expect(value.list()[0].config.password).toBe(legacy.config.password)
  expect(value.list()[0].config.sessionToken).toBe(legacy.config.sessionToken)
  const names = await readdir(dir)
  const credentialDir = names.find(name => name.startsWith('credentials-'))!
  const files = await readdir(join(dir, credentialDir))
  const text = (await Promise.all(files.map(name => readFile(join(dir, credentialDir, name), 'utf8')))).join('')
  expect(text).not.toMatch(/PASSWORD-MUST|INLINE-MUST/)
  expect(text).toContain('runner0@example.test')
  const db = await readFile(join(dir, names.find(name => name.endsWith('.sqlite'))!))
  expect(db.toString()).not.toContain('runner0@example.test')
  if (process.platform !== 'win32') {
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, credentialDir, files[0]))).mode & 0o777).toBe(0o600)
  }
})

itWithSqlite('uses scoped session destinations and isolates two workspace catalogs', async () => {
  const dir = await directory()
  const first = registry(dir).value
  const second = registry(dir, [], { scopeId: 'another-workspace' }).value
  await first.ready(); await second.ready()
  await first.upsert({ alias: '只属于第一工作区', region: 'cn', provider: 'connect-web', username: 'one@example.test' })
  expect(second.list()).toEqual([])
  const path = first.list()[0].config.sessionTokenFile!
  expect(path).toMatch(/acct-[0-9a-f]{24}\.session\.json$/)
})

it('creates SDK clients only on demand and evicts idle instances without retiring account identities', async () => {
  const { value, createClient } = registry(await directory(), [seed(0), seed(1), seed(2)], { maxClients: 1 })
  await value.ready()
  const accounts = value.list()
  await accounts[0].client.getUserProfile()
  const first = createClient.mock.results[0].value
  await accounts[1].client.getUserProfile()
  expect(first.deactivate).toHaveBeenCalledTimes(1)
  expect(createClient).toHaveBeenCalledTimes(2)
  await accounts[0].client.getUserProfile()
  expect(createClient).toHaveBeenCalledTimes(3)
})

it('bounds shared request concurrency without creating one process or active client per account', async () => {
  let active = 0, maximum = 0
  const createClient = jest.fn(() => ({ ...client(), getUserProfile: async () => {
    active += 1; maximum = Math.max(maximum, active)
    await new Promise(resolve => setImmediate(resolve))
    active -= 1
    return { profileId: 1 }
  } } as GarminClientLike))
  const { value } = registry(await directory(), Array.from({ length: 20 }, (_, index) => seed(index)),
    { createClient, maxClients: 3, maxConcurrent: 2 })
  await value.ready()
  await Promise.all(value.list().map(account => account.client.getUserProfile()))
  expect(maximum).toBe(2)
  expect(createClient).toHaveBeenCalledTimes(20)
})

it('reconfigures the shared runtime lazily without changing account identity, revision or credentials', async () => {
  const { value, createClient } = registry(await directory(), [seed(0)])
  await value.ready()
  const previous = value.list()[0]
  await previous.client.getUserProfile()
  const previousSdk = createClient.mock.results[0].value
  const notify = jest.fn()
  value.subscribe(notify)
  const config = { cacheTtl: 0, requestTimeoutMs: 30_000, authVerbose: true, logLevel: 'debug' as const,
    activityDetail: 'full' as const, fitDownloadDir: '/private/exports' }
  await value.reconfigure!(config)
  const current = value.list()[0]
  expect(current).toMatchObject({ accountId: previous.accountId, revision: previous.revision,
    config: { ...config, username: previous.config.username, sessionTokenFile: previous.config.sessionTokenFile } })
  expect(current.client).not.toBe(previous.client)
  expect(previousSdk.deactivate).toHaveBeenCalledTimes(1)
  expect(createClient).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledTimes(1)
  await expect(previous.client.getUserProfile()).rejects.toThrow('configuration changed')
  await current.client.getUserProfile()
  expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining(config))
  await value.reconfigure!(config)
  expect(value.list()[0].client).toBe(current.client)
  expect(notify).toHaveBeenCalledTimes(1)
  await expect(value.reconfigure!({ ...config, username: 'other@example.test', password: 'not-permitted' } as any))
    .rejects.toMatchObject({ code: 'invalid' })
  expect(value.list()[0].config.username).toBe(previous.config.username)
})

it('rejects late in-flight results when runtime settings retire the old client', async () => {
  let finish!: (value: unknown) => void
  const originalClient = { ...client(), getUserProfile: jest.fn(() => new Promise(resolve => { finish = resolve })) } as unknown as GarminClientLike
  const { value } = registry(await directory(), [seed(0)], { createClient: () => originalClient })
  await value.ready()
  const pending = value.list()[0].client.getUserProfile()
  await new Promise(resolve => setImmediate(resolve))
  await value.reconfigure!({ cacheTtl: 0, logLevel: 'error', activityDetail: 'compact', fitDownloadDir: '' })
  finish({ privateOldResult: true })
  await expect(pending).rejects.toThrow('configuration changed')
})

itWithSqlite('rejects stale in-flight and queued proxies when an account is changed or removed', async () => {
  let finish!: (value: unknown) => void
  const originalClient = { ...client(), getUserProfile: jest.fn(() => new Promise(resolve => { finish = resolve })) } as unknown as GarminClientLike
  const createClient = jest.fn(() => originalClient)
  const { value } = registry(await directory(), [seed(0)], { createClient })
  await value.ready()
  const old = value.list()[0]
  const pending = old.client.getUserProfile()
  await new Promise(resolve => setImmediate(resolve))
  await value.upsert({ accountId: old.accountId, expectedRevision: old.revision, alias: '新身份',
    region: 'cn', provider: 'connect-web', username: 'different@example.test' })
  finish({ privateOldAccount: true })
  await expect(pending).rejects.toThrow('configuration changed')
  await expect(old.client.getUserProfile()).rejects.toThrow('configuration changed')
  const current = value.list()[0]
  expect(current.config.username).toBe('different@example.test')
  expect(current.config.password).toBe('')
  await value.remove(current.accountId, current.revision!)
  await expect(current.client.getUserProfile()).rejects.toThrow('configuration changed')
})

it('preserves local-only legacy access when no stable scope is available but rejects new storage mutations', async () => {
  const { value, createClient } = registry(undefined, [seed(0)], { scopeId: undefined })
  await value.ready()
  expect(value.managed).toBe(false)
  expect(value.list()).toHaveLength(1)
  expect(createClient).not.toHaveBeenCalled()
  await expect(value.upsert({ alias: '无法保存', region: 'cn', provider: 'connect-web', username: 'one@example.test' }))
    .rejects.toMatchObject({ code: 'storage_unavailable' })
})

itWithSqlite('fails closed when an existing catalog cannot be opened instead of reviving old configuration', async () => {
  const dir = await directory()
  const first = registry(dir, [seed(0)]).value
  await first.ready()
  await first.remove(first.list()[0].accountId, first.list()[0].revision!)
  first.close()
  const names = await readdir(dir)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, names.find(name => name.endsWith('.sqlite'))!), 'broken catalog')
  const reopened = registry(dir, [seed(0)]).value
  await expect(reopened.ready()).rejects.toMatchObject({ code: 'storage_unavailable' })
  expect(reopened.managed).toBe(false)
})

;(hasNodeSqlite ? it.skip : it)('keeps legacy accounts usable when a fresh scoped workspace has no SQLite runtime', async () => {
  const { value, createClient } = registry(await directory(), [seed(0)])
  await value.ready()
  expect(value.managed).toBe(false)
  expect(value.list()).toHaveLength(1)
  expect(createClient).not.toHaveBeenCalled()
  await value.list()[0].client.getUserProfile()
  expect(createClient).toHaveBeenCalledTimes(1)
  await expect(value.upsert({ alias: '无法保存', region: 'cn', provider: 'connect-web', username: 'one@example.test' }))
    .rejects.toMatchObject({ code: 'storage_unavailable' })
})
