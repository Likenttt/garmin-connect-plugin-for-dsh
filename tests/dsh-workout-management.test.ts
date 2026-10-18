import type { Config } from '../src/config'
import { registerTools } from '../src/tools'

function backend() {
  return {
    getScheduledWorkouts: jest.fn().mockResolvedValue([]),
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutId: '42', workoutName: 'Easy' }),
    getScheduledWorkout: jest.fn().mockResolvedValue({ scheduleId: '51', workoutId: '42', workoutName: 'Easy', date: '2026-10-18' }),
    deleteWorkout: jest.fn().mockResolvedValue(undefined),
    unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
  }
}

function fixture() {
  const definitions: any[] = []
  const a = backend()
  const b = backend()
  const ctx = { tools: { register: (tool: any) => definitions.push(tool) }, logger: { info: jest.fn() } }
  const config = {
    username: 'fixture@example.test', region: 'cn', cacheTtl: 0,
    logLevel: 'info', activityDetail: 'full', fitDownloadDir: '',
  } satisfies Config
  registerTools(ctx as any, [
    { accountId: 'athlete-a', slot: 1, region: 'cn', configured: true, client: a as any, config },
    { accountId: 'athlete-b', slot: 2, region: 'cn', configured: true, client: b as any, config },
  ])
  const tool = (name: string) => definitions.find(item => item.name === name)!
  return { a, b, tool }
}

describe('DSH workout management', () => {
  it('selects the explicit account for schedule reads and preserves full response data', async () => {
    const { a, b, tool } = fixture()
    const scheduled = tool('get_garmin_scheduled_workouts')
    const response = [{ scheduleId: '51', date: '2026-10-18', extra: { values: [0, null] } }]
    b.getScheduledWorkouts.mockResolvedValue(response)
    expect(scheduled.parameters.additionalProperties).toBe(false)
    expect(scheduled.parameters.properties.account).toMatchObject({ type: 'string' })
    const result = await scheduled.execute({ account: 'athlete-b', startDate: '2026-10-18', endDate: '2026-11-17' })
    expect(result).toBe(response)
    expect(b.getScheduledWorkouts).toHaveBeenCalledWith('2026-10-18', '2026-11-17')
    expect(a.getScheduledWorkouts).not.toHaveBeenCalled()

    for (const args of [
      {},
      { account: 'athlete-a', startDate: '2026-10-18', endDate: '2026-11-18' },
      { account: 'athlete-a', startDate: '2026-02-30' },
      { account: 'athlete-a', unexpected: true },
    ]) {
      expect(await scheduled.execute(args)).toMatchObject({ error: true })
    }
    expect(a.getScheduledWorkouts).not.toHaveBeenCalled()
    expect(b.getScheduledWorkouts).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'delete_garmin_workout', method: 'deleteWorkout', id: 'workoutId', value: '42' },
    { name: 'unschedule_garmin_workout', method: 'unscheduleWorkout', id: 'scheduleId', value: '51' },
  ] as const)('isolates $name confirmations even between two accounts in the same region', async route => {
    const { a, b, tool } = fixture()
    const remove = tool(route.name)
    expect(remove.parameters).toMatchObject({ required: [route.id], additionalProperties: false })
    expect(remove.parameters.properties[route.id].oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'integer', maximum: Number.MAX_SAFE_INTEGER }),
      expect.objectContaining({ type: 'string', pattern: expect.any(String) }),
    ]))
    const preview = await remove.execute({ account: 'athlete-a', [route.id]: route.value })
    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.preview.accountId).toBe('athlete-a')
    expect(a.deleteWorkout).not.toHaveBeenCalled()
    expect(a.unscheduleWorkout).not.toHaveBeenCalled()
    const request = { [route.id]: route.value, confirmed: true, confirmationId: preview.confirmationId }
    const wrongAccount = await remove.execute({ account: 'athlete-b', ...request })
    expect(wrongAccount).toMatchObject({ error: true })
    expect(b.deleteWorkout).not.toHaveBeenCalled()
    expect(b.unscheduleWorkout).not.toHaveBeenCalled()

    const approved = await remove.execute({ account: 'athlete-a', ...request })
    expect(approved.success).toBe(true)
    expect(a[route.method]).toHaveBeenCalledTimes(1)
    expect(a[route.method]).toHaveBeenCalledWith(route.value)
    if (route.method === 'unscheduleWorkout') {
      expect(approved.workoutTemplatePreserved).toBe(true)
      expect(a.deleteWorkout).not.toHaveBeenCalled()
    }
    expect(await remove.execute({ account: 'athlete-a', ...request })).toMatchObject({ error: true })
    expect(a[route.method]).toHaveBeenCalledTimes(1)
  })

  it('blocks invalid or unexpected destructive arguments before reading or deleting a target', async () => {
    const { a, b, tool } = fixture()
    for (const [name, id] of [
      ['delete_garmin_workout', 'workoutId'],
      ['unschedule_garmin_workout', 'scheduleId'],
    ]) {
      for (const invalid of [0, Number.MAX_SAFE_INTEGER + 1, '01', '42/43', '42\n']) {
        const result = await tool(name).execute({ account: 'athlete-a', [id]: invalid })
        expect(result).toMatchObject({ error: true })
      }
      expect(await tool(name).execute({ account: 'athlete-a', [id]: '42', unexpected: true }))
        .toMatchObject({ error: true })
    }
    for (const client of [a, b]) {
      expect(client.getWorkoutDetail).not.toHaveBeenCalled()
      expect(client.getScheduledWorkout).not.toHaveBeenCalled()
      expect(client.deleteWorkout).not.toHaveBeenCalled()
      expect(client.unscheduleWorkout).not.toHaveBeenCalled()
    }
  })
})
