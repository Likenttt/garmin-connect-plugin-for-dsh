import type { Context } from '@deepseek-ai/cordis'
import type { AccountSource } from '../src/account-registry'
import type { Config } from '../src/config'
import type { GarminClientLike } from '../src/client'
import { registerTools, type GarminToolAccount } from '../src/tools'

function account(id: string, provider: 'connect-web' | 'personal' = 'connect-web', revision = 'a'.repeat(32)) {
  const client = {
    getUserProfile: jest.fn(async () => ({ displayName: id, fullName: id })),
    getActivities: jest.fn(async () => []),
    getWorkoutDetail: jest.fn(async () => ({ workoutId: '42', workoutName: 'Easy' })),
    scheduleWorkout: jest.fn(async () => ({ scheduleId: '61' })),
    addWorkout: jest.fn(async () => ({ workoutId: '42' })),
  }
  return {
    accountId: id, slot: 1, region: 'cn' as const, alias: `成员 ${id}`,
    configured: true, revision,
    config: {
      provider, username: `${id}@example.test`, password: 'private-password',
      personalApiKey: 'private-api-key', region: 'cn', cacheTtl: 0,
      logLevel: 'error', activityDetail: 'compact', fitDownloadDir: '',
    } satisfies Config,
    client: client as unknown as GarminClientLike,
    fixtureClient: client,
  }
}

function fixture(initial: readonly GarminToolAccount[], ready: Promise<void> = Promise.resolve()) {
  let current = initial
  const listeners = new Set<() => void>()
  const source = {
    ready: jest.fn(() => ready), list: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  } as unknown as AccountSource
  const definitions = new Map<string, any>()
  const disposers: (() => void)[] = []
  const ctx = {
    tools: { register: (definition: { name: string }) => definitions.set(definition.name, definition) },
    effect: (callback: () => () => void) => { disposers.push(callback()) },
    logger: { info: jest.fn() },
  } as unknown as Context
  registerTools(ctx, source)
  return {
    source, definitions,
    tool: (name: string) => definitions.get(name)!,
    replace(accounts: readonly GarminToolAccount[]) { current = accounts; for (const listener of listeners) listener() },
    dispose() { for (const dispose of disposers) dispose() },
  }
}

it('keeps concepts local and waits for the loaded catalog before choosing a default account', async () => {
  const a = account('athlete-a'), b = account('athlete-b')
  let finish!: () => void
  const ready = new Promise<void>(resolve => { finish = resolve })
  const f = fixture([a], ready)
  try {
    expect(await f.tool('get_running_skill_advice').execute({ mode: 'explain', query: 'threshold' }))
      .toMatchObject({ mode: 'explain', requiresUserInput: false })
    expect(f.source.ready).not.toHaveBeenCalled()
    const pending = f.tool('get_garmin_profile').execute({})
    expect(a.fixtureClient.getUserProfile).not.toHaveBeenCalled()
    f.replace([a, b]); finish()
    expect(await pending).toMatchObject({ error: true, message: expect.stringContaining('list_garmin_accounts') })
    expect(a.fixtureClient.getUserProfile).not.toHaveBeenCalled()
    expect(b.fixtureClient.getUserProfile).not.toHaveBeenCalled()
  } finally { f.dispose() }
})

it('routes accounts added after registration and stops serving accounts removed from the live source', async () => {
  const a = account('athlete-a'), b = account('athlete-b')
  const f = fixture([a])
  try {
    expect(a.fixtureClient.getUserProfile).not.toHaveBeenCalled()
    f.replace([a, b])
    expect(await f.tool('get_garmin_profile').execute({ account: b.accountId }))
      .toMatchObject({ displayName: b.accountId })
    expect(a.fixtureClient.getUserProfile).not.toHaveBeenCalled()
    f.replace([a])
    expect(await f.tool('get_garmin_profile').execute({ account: b.accountId })).toMatchObject({ error: true })
    expect(b.fixtureClient.getUserProfile).toHaveBeenCalledTimes(1)
  } finally { f.dispose() }
})

it('keeps the dynamic tool catalog usable when Connect is added after a Personal-only startup', async () => {
  const personal = account('personal-a', 'personal')
  const connect = account('connect-a')
  const f = fixture([personal])
  const args = { name: 'Easy', steps: [{ type: 'warmup', endCondition: 'time', endValue: 600 }] }
  try {
    expect(f.definitions.size).toBe(30)
    const create = f.tool('create_garmin_workout')
    expect(await create.execute({ account: personal.accountId, ...args })).toMatchObject({ error: true })
    expect(personal.fixtureClient.addWorkout).not.toHaveBeenCalled()
    f.replace([personal, connect])
    expect(await create.execute({ account: connect.accountId, ...args }))
      .toMatchObject({ requiresConfirmation: true, accountId: connect.accountId })
    expect(connect.fixtureClient.addWorkout).not.toHaveBeenCalled()
  } finally { f.dispose() }
})

it('invalidates confirmations on account revision changes and rejects removed-account writes', async () => {
  const a = account('athlete-a')
  const f = fixture([a])
  const args = { account: a.accountId, workoutId: '42', date: '2026-11-06' }
  try {
    const schedule = f.tool('schedule_garmin_workout')
    const preview = await schedule.execute(args)
    expect(preview).toMatchObject({ requiresConfirmation: true })
    f.replace([{ ...a, revision: 'b'.repeat(32) }])
    expect(await schedule.execute({ ...args, confirmed: true, confirmationId: preview.confirmationId }))
      .toMatchObject({ error: true })
    expect(a.fixtureClient.scheduleWorkout).not.toHaveBeenCalled()
    const fresh = await schedule.execute(args)
    f.replace([])
    expect(await schedule.execute({ ...args, confirmed: true, confirmationId: fresh.confirmationId }))
      .toMatchObject({ error: true })
    expect(a.fixtureClient.scheduleWorkout).not.toHaveBeenCalled()
  } finally { f.dispose() }
})

it('paginates and searches more than five accounts without exposing credentials or contacting Garmin', async () => {
  const accounts = Array.from({ length: 100 }, (_, index) => account(`athlete-${index}`))
  const f = fixture(accounts)
  try {
    const list = f.tool('list_garmin_accounts')
    const first = await list.execute({})
    expect(first).toMatchObject({ total: 100, offset: 0, limit: 20, hasMore: true })
    expect(first.accounts).toHaveLength(20)
    expect((await list.execute({ offset: 90, limit: 50 })).accounts).toHaveLength(10)
    expect(await list.execute({ search: 'athlete-99' })).toMatchObject({ total: 1, accounts: [{ accountId: 'athlete-99' }] })
    expect(await list.execute({ limit: 51 })).toMatchObject({ error: true })
    expect(JSON.stringify(first)).not.toMatch(/@example\.test|private-password|private-api-key|username|sessionToken/)
    for (const a of accounts) expect(a.fixtureClient.getUserProfile).not.toHaveBeenCalled()
    expect(await f.tool('get_garmin_profile').execute({})).toMatchObject({ error: true,
      message: 'Multiple Garmin accounts are configured. Call list_garmin_accounts and set account to a specific account ID.' })
  } finally { f.dispose() }
})
