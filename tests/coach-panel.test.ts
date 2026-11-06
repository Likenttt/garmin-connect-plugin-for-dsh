import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoachPanelService, handleCoachFetch, isCoachLoopback, type CoachPanelAccount } from '../src/coach-panel'
import { CoachStorageError, SqliteCoachStore, type CoachPersistence } from '../src/coach-store'
import { GarminAuthenticationRequiredError, PublicToolError } from '../src/utils/errors'
import { itWithSqlite } from './helpers/sqlite'

const now = () => new Date('2026-11-05T04:00:00Z')
const fakeStore = (): CoachPersistence => ({
  notes: jest.fn(async () => []), save: jest.fn(), remove: jest.fn(),
  preferences: jest.fn(async () => ({ selfAccountId: null })),
  setPreferences: jest.fn(async () => undefined), close: jest.fn(),
})

function account(id = 'athlete-a'): CoachPanelAccount {
  return {
    accountId: id, region: 'cn', alias: id, configured: true,
    config: { provider: 'connect-web', username: `${id}@example.test` } as CoachPanelAccount['config'],
    client: {
      getUserProfile: jest.fn(async () => ({ email: 'private@example.test' })),
      verifyConnection: jest.fn(async () => undefined),
      getAuthenticatedAccount: jest.fn(() => ({ email: 'private@example.test', region: 'cn' as const })),
      getAuthenticationRequirement: jest.fn(() => undefined),
      getActivities: jest.fn(async () => []),
      getScheduledWorkouts: jest.fn(async () => []),
    },
  }
}

it('lists local metadata without logging in or claiming an in-memory identity was freshly verified', async () => {
  const a = account()
  const service = new CoachPanelService([a], { store: fakeStore(), now })
  const result = await service.handle('members', {})
  expect(result).toMatchObject({ success: true, members: [{ accountId: a.accountId, status: 'unknown' }] })
  expect(a.client.verifyConnection).not.toHaveBeenCalled()
  expect(a.client.getUserProfile).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain('@example.test')
  service.close()
})

it('reuses the verified profile for a cached raster avatar without another Garmin profile request', async () => {
  const a = account()
  const url = 'https://s3.cn-north-1.amazonaws.com.cn/garmin-connect-prod/profile_images/example-small.png'
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(png))
  jest.mocked(a.client.verifyConnection!).mockResolvedValue({ profileId: 42, profileImageUrlSmall: url })
  const service = new CoachPanelService([a], { store: fakeStore(), now })
  try {
    const first = await service.handle('check', { accountId: a.accountId })
    expect(first).toMatchObject({ member: { status: 'valid', avatarUrl: `data:image/png;base64,${png.toString('base64')}` } })
    expect(a.client.getUserProfile).not.toHaveBeenCalled()
    expect(JSON.stringify(await service.handle('members', {}))).not.toContain(url)
    expect(await service.handle('members', {})).toMatchObject({ members: [{ avatarUrl: expect.stringContaining('data:image/png;base64,') }] })
    await service.handle('check', { accountId: a.accountId })
    expect(request).toHaveBeenCalledTimes(1)
  } finally { service.close(); request.mockRestore() }
})

it('keeps connection verification successful when an avatar cannot be downloaded', async () => {
  const a = account()
  const request = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('image unavailable'))
  jest.mocked(a.client.verifyConnection!).mockResolvedValue({ profileId: 42,
    profileImageUrlSmall: 'https://s3.amazonaws.com/garmin-connect-prod/profile_images/example.jpg' })
  const service = new CoachPanelService([a], { store: fakeStore(), now })
  try {
    expect(await service.handle('check', { accountId: a.accountId })).toMatchObject({ member: { status: 'valid' } })
    expect(JSON.stringify(await service.handle('members', {}))).not.toContain('avatarUrl')
  } finally { service.close(); request.mockRestore() }
})

it('deduplicates real checks and preserves successful evidence after a later network failure', async () => {
  const a = account()
  let finish!: () => void
  jest.mocked(a.client.verifyConnection!).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const service = new CoachPanelService([a], { store: fakeStore(), now })
  const first = service.handle('check', { accountId: a.accountId })
  const second = service.handle('check', { accountId: a.accountId })
  expect(a.client.verifyConnection).toHaveBeenCalledTimes(1)
  expect(await service.handle('members', {})).toMatchObject({ members: [{ status: 'checking' }] })
  finish()
  expect(await first).toMatchObject({ member: { status: 'valid', lastVerifiedAt: now().toISOString() } })
  await second
  jest.mocked(a.client.verifyConnection!).mockRejectedValueOnce(new Error('secret/path/private'))
  const result = await service.handle('check', { accountId: a.accountId })
  expect(result).toMatchObject({ member: { status: 'unavailable', lastVerifiedAt: now().toISOString() } })
  expect(JSON.stringify(result)).not.toContain('secret/path')
  service.close()
})

it('distinguishes authentication requirements and known Personal authorization failures from network errors', async () => {
  const a = account()
  const service = new CoachPanelService([a], { store: fakeStore(), now })
  jest.mocked(a.client.verifyConnection!).mockRejectedValueOnce(new GarminAuthenticationRequiredError('expired'))
  expect(await service.handle('check', { accountId: a.accountId })).toMatchObject({ member: { status: 'auth_required' } })
  jest.mocked(a.client.verifyConnection!).mockRejectedValueOnce(new PublicToolError('Personal access failed (HTTP 403).'))
  expect(await service.handle('check', { accountId: a.accountId })).toMatchObject({ member: { status: 'auth_required' } })
  service.close()
})

it('does not touch storage for unknown accounts or invalid note revisions', async () => {
  const store = fakeStore()
  const a = account()
  const service = new CoachPanelService([a], { store, now })
  expect(await service.handle('notes', { accountId: 'another' })).toEqual({ success: false, code: 'account_not_found' })
  expect(await service.handle('save-note', { accountId: a.accountId, id: 'existing', title: 'T', body: 'B' }))
    .toEqual({ success: false, code: 'invalid' })
  expect(await service.handle('save-preferences', { selfAccountId: 'another' })).toEqual({ success: false, code: 'invalid' })
  expect(store.notes).not.toHaveBeenCalled()
  expect(store.save).not.toHaveBeenCalled()
  service.close()
})

it('keeps metadata usable without a stable workspace scope and fails notes clearly', async () => {
  const a = account()
  const service = new CoachPanelService([a], { now })
  expect(await service.handle('members', {})).toMatchObject({ success: true })
  expect(await service.handle('notes', { accountId: a.accountId })).toMatchObject({ success: false, code: 'storage_unavailable' })
  service.close()
})

it('normalizes timeline data without credentials and reports failed calendar reads', async () => {
  const a = account()
  jest.mocked(a.client.getActivities).mockResolvedValueOnce([
    { activityId: 1, activityName: '轻松跑', activityType: { typeKey: 'running' },
      startTimeLocal: '2026-11-04 08:00:00', duration: 1800, distance: 5000, access_token: 'PRIVATE' },
    { activityId: 2, activityName: 'Old', startTimeLocal: '2026-10-01', duration: 20 },
  ])
  jest.mocked(a.client.getScheduledWorkouts!).mockRejectedValueOnce(new Error('PRIVATE'))
  const service = new CoachPanelService([a], { store: fakeStore(), now })
  const result = await service.handle('timeline', { accountId: a.accountId, days: 7 })
  expect(result).toMatchObject({ success: true, partial: true, planError: 'unavailable', activities: [
    { id: '1', name: '轻松跑', type: 'running', date: '2026-11-04', durationSeconds: 1800, distanceMeters: 5000 },
  ] })
  expect(JSON.stringify(result)).not.toMatch(/access_token|PRIVATE/)
  service.close()
})

it('requires the exact Fetch envelope and does not cache private replies', async () => {
  const service = new CoachPanelService([account()], { store: fakeStore(), now })
  const request = (method: string) => new Request('http://dsh.internal/api/garmin-coach/members', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'request-1', method, payload: {} }),
  })
  expect((await handleCoachFetch('members', request('garmin-auth/members'), service)).status).toBe(400)
  const response = await handleCoachFetch('members', request('garmin-coach/members'), service)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({ type: 'server-response', rpcId: 'request-1', result: { ok: true, value: { success: true } } })
  service.close()
})

it('only trusts physical loopback IP addresses', () => {
  expect(['127.0.0.1', '127.2.3.4', '::1', '::ffff:127.0.0.1'].map(isCoachLoopback)).toEqual([true, true, true, true])
  expect([undefined, 'localhost', '127.attacker.test', '192.168.1.1', '::ffff:192.168.1.1'].map(isCoachLoopback))
    .toEqual([false, false, false, false, false])
})

itWithSqlite('persists notes with account/owner/workspace isolation and optimistic revisions in private SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'garmin-coach-test-'))
  const directory = join(root, 'private')
  const first = new SqliteCoachStore(directory, 'workspace-a', now)
  const second = new SqliteCoachStore(directory, 'workspace-b', now)
  try {
    const note = await first.save('owner-a', 'athlete-a', { title: '目标', body: '提高连续性', category: '长期备注' })
    expect(await first.notes('owner-a', 'athlete-a')).toHaveLength(1)
    expect(await first.notes('owner-b', 'athlete-a')).toEqual([])
    expect(await first.notes('owner-a', 'athlete-b')).toEqual([])
    expect(await second.notes('owner-a', 'athlete-a')).toEqual([])
    const changed = await first.save('owner-a', 'athlete-a', { ...note, expectedRevision: 1, body: '新的目标' })
    expect(changed.revision).toBe(2)
    await expect(first.save('owner-a', 'athlete-a', { ...note, expectedRevision: 1 })).rejects.toBeInstanceOf(CoachStorageError)
    await expect(first.remove('owner-a', 'athlete-b', note.id, 2)).rejects.toBeInstanceOf(CoachStorageError)
    await first.setPreferences('athlete-a')
    expect(await first.preferences()).toEqual({ selfAccountId: 'athlete-a' })
    expect(await second.preferences()).toEqual({ selfAccountId: null })
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'coach.sqlite'))).mode & 0o777).toBe(0o600)
    }
    first.close()
    const reopened = new SqliteCoachStore(directory, 'workspace-a', now)
    try { expect((await reopened.notes('owner-a', 'athlete-a'))[0].body).toBe('新的目标') }
    finally { reopened.close() }
  } finally {
    first.close(); second.close()
    await rm(root, { recursive: true, force: true })
  }
})
