import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountSource, RuntimeAccount } from '../src/account-registry'
import { createWorkspaceService, type WorkspaceService } from '../src/workspace-service'
import { createEmbeddedAuthController } from '../src/embedded-auth-runtime'
import { itWithSqlite } from './helpers/sqlite'

jest.mock('../src/embedded-auth-runtime', () => ({ createEmbeddedAuthController: jest.fn() }))
const services: WorkspaceService[] = []
const roots: string[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  jest.clearAllMocks()
})
function account(id: string, revision = 'a'.repeat(32)): RuntimeAccount {
  return {
    accountId: id, slot: 1, alias: `账号 ${id}`, region: 'cn', configured: true, revision,
    config: {
      username: `${id}@example.test`, provider: 'connect-web', region: 'cn', password: '',
      sessionTokenFile: '/synthetic/session.json', cacheTtl: 0,
      logLevel: 'error', activityDetail: 'compact', fitDownloadDir: '',
    },
    client: {
      getAuthenticatedAccount: jest.fn(() => undefined),
      getAuthenticationRequirement: jest.fn(() => undefined),
      getUserProfile: jest.fn(async () => ({ displayName: id, fullName: id })),
      verifyConnection: jest.fn(async () => undefined),
      getActivities: jest.fn(async () => []),
      getScheduledWorkouts: jest.fn(async () => []),
      replacePersistedSession: jest.fn(async (write: () => Promise<void>) => write()),
    },
  } as unknown as RuntimeAccount
}
async function fixture(initial: RuntimeAccount[]) {
  let values = initial
  const listeners = new Set<() => void>()
  const source: AccountSource = {
    ready: jest.fn(async () => undefined), list: () => values,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const root = await mkdtemp(join(tmpdir(), 'garmin-workspace-service-'))
  roots.push(root)
  const options = {
    scopeId: 'shared-workspace', dataDirectory: join(root, 'private'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Context['logger'],
  }
  const service = createWorkspaceService(source, options)
  services.push(service)
  return { service, source, options, publish(next: RuntimeAccount[]) { values = next; for (const listener of listeners) listener() } }
}

itWithSqlite('shares notes with a second adapter while retaining note and account revision guards', async () => {
  const a = account('account-a')
  const f = await fixture([a])
  const other = createWorkspaceService(f.source, f.options)
  services.push(other)
  const saved = await f.service.call('save-note', {
    accountId: a.accountId, expectedAccountRevision: a.revision,
    title: '行程备忘', body: '下周出差，调整训练时间。', category: '一般备忘',
  })
  expect(saved).toMatchObject({ success: true, note: { revision: 1 } })
  const listing = await other.call('notes', { accountId: a.accountId })
  expect(listing).toMatchObject({ success: true, notes: [{ id: saved.note.id, body: '下周出差，调整训练时间。' }] })
  expect(await other.call('save-note', {
    accountId: a.accountId, id: saved.note.id, expectedRevision: 1, expectedAccountRevision: a.revision,
    title: '行程备忘', body: '更新安排', category: '一般备忘',
  })).toMatchObject({ success: true, note: { revision: 2 } })
  expect(await f.service.call('save-note', {
    accountId: a.accountId, id: saved.note.id, expectedRevision: 1, expectedAccountRevision: a.revision,
    title: '旧草稿', body: '不能覆盖新内容', category: '一般备忘',
  })).toEqual({ success: false, code: 'conflict' })
  f.publish([{ ...a, revision: 'b'.repeat(32) }])
  expect(await f.service.call('save-note', {
    accountId: a.accountId, expectedAccountRevision: a.revision,
    title: '旧身份草稿', body: '保留给用户处理', category: '一般备忘',
  })).toEqual({ success: false, code: 'stale_config' })
})

it('uses one live catalog for account tools, connection checks and later account changes', async () => {
  const a = account('account-a'), b = { ...account('account-b'), slot: 2 }
  const f = await fixture([a])
  expect(f.service.tools).toHaveLength(30)
  expect(f.service.tools.map(tool => tool.name)).toContain('list_garmin_accounts')
  expect(await f.service.call('members', {})).toMatchObject({ members: [{ accountId: a.accountId, status: 'unknown' }] })
  expect(a.client.getUserProfile).not.toHaveBeenCalled()
  expect(a.client.verifyConnection).not.toHaveBeenCalled()
  f.publish([a, b])
  const list = await f.service.invokeTool('list_garmin_accounts', {})
  expect(list).toMatchObject({ total: 2, accounts: [{ accountId: a.accountId }, { accountId: b.accountId }] })
  expect(JSON.stringify(list)).not.toContain('@example.test')
  expect(await f.service.invokeTool('get_garmin_profile', { account: b.accountId })).toMatchObject({ displayName: b.accountId })
  expect(b.client.getUserProfile).toHaveBeenCalledTimes(1)
  expect(await f.service.call('check', { accountId: b.accountId })).toMatchObject({ member: { status: 'valid' } })
  expect(b.client.verifyConnection).toHaveBeenCalledTimes(1)
})

it('routes and cancels an opaque login flow and closes its owner when the account is removed', async () => {
  const flowId = 'c'.repeat(64)
  const controller = {
    begin: jest.fn(async () => ({ success: true, flowId, bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${flowId}`, expiresAt: Date.now() + 60_000 })),
    beginCdp: jest.fn(), status: jest.fn(() => ({ success: true, status: 'in_progress' })),
    cancel: jest.fn(() => ({ success: true })), close: jest.fn(async () => undefined),
  }
  jest.mocked(createEmbeddedAuthController).mockReturnValue(controller as unknown as ReturnType<typeof createEmbeddedAuthController>)
  const a = account('account-a')
  const f = await fixture([a])
  expect(createEmbeddedAuthController).not.toHaveBeenCalled()
  expect(await f.service.auth('begin', { accountId: a.accountId, expectedRegion: a.region, expectedRevision: 'b'.repeat(32) }))
    .toEqual({ success: false, code: 'stale_config' })
  expect(createEmbeddedAuthController).not.toHaveBeenCalled()
  expect(await f.service.auth('begin', { accountId: a.accountId, expectedRegion: a.region, expectedRevision: a.revision }))
    .toMatchObject({ success: true, flowId })
  expect(await f.service.auth('status', { flowId })).toEqual({ success: true, status: 'in_progress' })
  expect(await f.service.auth('cancel', { flowId })).toEqual({ success: true })
  expect(controller.cancel).toHaveBeenCalledWith({ flowId })
  f.publish([])
  expect(controller.close).toHaveBeenCalledTimes(1)
  expect(await f.service.auth('status', { flowId })).toMatchObject({ success: false })
})
