import { GarminToolService } from '../src/tool-service'
import type { GarminDataClient, GarminToolServiceOptions } from '../src/tool-service'
import type { DeleteWorkoutArgs, ScheduledWorkoutsArgs } from '../src/workout-management'

const workout = {
  workoutId: 410,
  workoutName: 'Easy intervals',
  owner: { email: 'synthetic@example.invalid', displayName: 'Synthetic runner' },
  steps: [{ duration: 600 }],
}
const scheduled = {
  workoutScheduleId: 820,
  workoutId: 410,
  date: '2026-10-20',
  workout: { workoutName: 'Easy intervals' },
}

function fixture() {
  const client = {
    getActivities: jest.fn(async () => []),
    getSleep: jest.fn(),
    getSteps: jest.fn(),
    getHeartRate: jest.fn(),
    getWeight: jest.fn(),
    getWorkouts: jest.fn(async () => []),
    downloadOriginalActivityZip: jest.fn(),
    addWorkout: jest.fn(),
    getUserProfile: jest.fn(),
    getWorkoutDetail: jest.fn(async (_id: string | number): Promise<unknown> => structuredClone(workout)),
    getScheduledWorkout: jest.fn(async (_id: string | number): Promise<unknown> => structuredClone(scheduled)),
    getScheduledWorkouts: jest.fn(async (_start: string, _end: string): Promise<unknown> => [scheduled]),
    deleteWorkout: jest.fn(async (_id: string | number): Promise<void> => undefined),
    unscheduleWorkout: jest.fn(async (_id: string | number): Promise<void> => undefined),
  } satisfies GarminDataClient
  const options: GarminToolServiceOptions = {
    activityDetail: 'full',
    fitDownloadDir: '/tmp/garmin-synthetic-workouts',
    accountUsername: 'synthetic@example.invalid',
    accountRegion: 'cn',
  }
  return { client, options, service: new GarminToolService(client, options) }
}

function token(preview: Record<string, unknown>): string {
  expect(preview.requiresConfirmation).toBe(true)
  expect(preview.confirmationId).toEqual(expect.any(String))
  return preview.confirmationId as string
}

describe('single workout and calendar-entry management', () => {
  afterEach(() => jest.restoreAllMocks())

  it('previews both actions without writing and exposes only target metadata', async () => {
    const { service, client, options } = fixture()
    options.accountId = 'runner-cn-1'
    const libraryPreview = await service.deleteWorkout({ workoutId: 410 })
    const calendarPreview = await service.unscheduleWorkout({ scheduleId: '820' })

    expect(libraryPreview.preview).toEqual({
      action: 'delete_workout', workoutId: '410', accountRegion: 'cn', accountId: 'runner-cn-1', workoutName: 'Easy intervals',
    })
    expect(calendarPreview.preview).toEqual({
      action: 'cancel_scheduled_workout', scheduleId: '820', accountRegion: 'cn',
      accountId: 'runner-cn-1', workoutName: 'Easy intervals', scheduledDate: '2026-10-20', workoutTemplatePreserved: true,
    })
    expect(JSON.stringify(libraryPreview)).not.toContain('synthetic@example.invalid')
    expect(JSON.stringify(libraryPreview)).not.toContain('duration')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
    expect(client.unscheduleWorkout).not.toHaveBeenCalled()
  })

  it('confirms library deletion once, normalizes equivalent IDs, and accepts an empty 204 result', async () => {
    const { service, client } = fixture()
    const confirmationId = token(await service.deleteWorkout({ workoutId: 410 }))
    // Equivalent JSON with reordered keys must still match the preview.
    client.getWorkoutDetail.mockResolvedValueOnce({ steps: workout.steps, owner: workout.owner, workoutName: workout.workoutName, workoutId: workout.workoutId })
    await expect(service.deleteWorkout({ workoutId: '410', confirmed: true, confirmationId }))
      .resolves.toMatchObject({ success: true, workoutId: '410', action: 'delete_workout' })
    expect(client.getWorkoutDetail).toHaveBeenCalledTimes(2)
    expect(client.deleteWorkout).toHaveBeenCalledTimes(1)
    expect(client.deleteWorkout).toHaveBeenCalledWith('410')
    expect(client.unscheduleWorkout).not.toHaveBeenCalled()
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    expect(client.deleteWorkout).toHaveBeenCalledTimes(1)
  })

  it('distinguishes two valid accounts in the same region without disclosing their emails', async () => {
    const { client, options } = fixture()
    const first = new GarminToolService(client, { ...options, accountId: 'cn-runner-1' })
    const second = new GarminToolService(client, { ...options, accountUsername: 'second@example.invalid', accountId: 'cn-runner-2' })
    const firstPreview = await first.deleteWorkout({ workoutId: 410 })
    const secondPreview = await second.deleteWorkout({ workoutId: 410 })
    expect(firstPreview.preview).toMatchObject({ accountRegion: 'cn', accountId: 'cn-runner-1' })
    expect(secondPreview.preview).toMatchObject({ accountRegion: 'cn', accountId: 'cn-runner-2' })
    expect(JSON.stringify([firstPreview, secondPreview])).not.toContain('@example.invalid')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
  })

  it('cancels one calendar entry using its schedule ID and preserves the workout template', async () => {
    const { service, client } = fixture()
    const confirmationId = token(await service.unscheduleWorkout({ scheduleId: 820 }))
    await expect(service.unscheduleWorkout({ scheduleId: 820, confirmed: true, confirmationId }))
      .resolves.toMatchObject({ success: true, scheduleId: '820', workoutTemplatePreserved: true })
    expect(client.getScheduledWorkout).toHaveBeenCalledTimes(2)
    expect(client.unscheduleWorkout).toHaveBeenCalledTimes(1)
    expect(client.unscheduleWorkout).toHaveBeenCalledWith('820')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
  })

  it('rejects tokens for another ID or another operation and consumes each invalid attempt', async () => {
    const { service, client } = fixture()
    const changedIdToken = token(await service.deleteWorkout({ workoutId: 410 }))
    await expect(service.deleteWorkout({ workoutId: 411, confirmed: true, confirmationId: changedIdToken }))
      .rejects.toThrow('Invalid workout confirmation')
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: changedIdToken }))
      .rejects.toThrow('Invalid workout confirmation')
    const otherOperationToken = token(await service.unscheduleWorkout({ scheduleId: 820 }))
    await expect(service.deleteWorkout({ workoutId: 820, confirmed: true, confirmationId: otherOperationToken }))
      .rejects.toThrow('Invalid workout confirmation')
    await expect(service.unscheduleWorkout({ scheduleId: 820, confirmed: true, confirmationId: otherOperationToken }))
      .rejects.toThrow('Invalid workout confirmation')
    expect(client.getWorkoutDetail).toHaveBeenCalledTimes(1)
    expect(client.getScheduledWorkout).toHaveBeenCalledTimes(1)
    expect(client.deleteWorkout).not.toHaveBeenCalled()
    expect(client.unscheduleWorkout).not.toHaveBeenCalled()
  })

  it('binds tokens to the service instance, account identity, and region', async () => {
    const { service, client, options } = fixture()
    const first = token(await service.deleteWorkout({ workoutId: 410 }))
    const otherAccountService = new GarminToolService(client, { ...options, accountUsername: 'other@example.invalid' })
    await expect(otherAccountService.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: first }))
      .rejects.toThrow('Invalid workout confirmation')
    options.accountUsername = 'changed@example.invalid'
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: first }))
      .rejects.toThrow('Invalid workout confirmation')
    const second = token(await service.unscheduleWorkout({ scheduleId: 820 }))
    options.accountRegion = 'global'
    await expect(service.unscheduleWorkout({ scheduleId: 820, confirmed: true, confirmationId: second }))
      .rejects.toThrow('Invalid workout confirmation')
    options.accountId = 'runner-cn-1'
    const third = token(await service.deleteWorkout({ workoutId: 410 }))
    options.accountId = 'runner-cn-2'
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: third }))
      .rejects.toThrow('Invalid workout confirmation')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
    expect(client.unscheduleWorkout).not.toHaveBeenCalled()
  })

  it('detects detail changes beyond the visible preview and consumes the confirmation', async () => {
    const { service, client } = fixture()
    const confirmationId = token(await service.deleteWorkout({ workoutId: 410 }))
    client.getWorkoutDetail.mockResolvedValueOnce({ ...workout, steps: [{ duration: 1200 }] })
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId })).rejects.toThrow('changed after the preview')
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
  })

  it('expires confirmations exactly after ten minutes and retains at most twenty pending previews', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const { service, client } = fixture()
    const expired = token(await service.deleteWorkout({ workoutId: 410 }))
    clock.mockReturnValue(601_000)
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: expired })).rejects.toThrow('Invalid workout confirmation')
    const issued: string[] = []
    for (let index = 0; index < 21; index += 1) issued.push(token(await service.deleteWorkout({ workoutId: 410 })))
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: issued[0] })).rejects.toThrow('Invalid workout confirmation')
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: issued[20] })).resolves.toMatchObject({ success: true })
    expect(client.deleteWorkout).toHaveBeenCalledTimes(1)
  })

  it('does not retry or report success when a read or write rejects; neither token can be replayed', async () => {
    const { service, client } = fixture()
    const readToken = token(await service.deleteWorkout({ workoutId: 410 }))
    client.getWorkoutDetail.mockRejectedValueOnce(new Error('Synthetic read failure'))
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: readToken })).rejects.toThrow('Synthetic read failure')
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: readToken })).rejects.toThrow('Invalid workout confirmation')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
    const writeToken = token(await service.unscheduleWorkout({ scheduleId: 820 }))
    client.unscheduleWorkout.mockRejectedValueOnce(new Error('Synthetic upstream failure'))
    await expect(service.unscheduleWorkout({ scheduleId: 820, confirmed: true, confirmationId: writeToken })).rejects.toThrow('Synthetic upstream failure')
    await expect(service.unscheduleWorkout({ scheduleId: 820, confirmed: true, confirmationId: writeToken })).rejects.toThrow('Invalid workout confirmation')
    expect(client.unscheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it('rejects absent details and mismatched identities before issuing a usable preview', async () => {
    const { service, client } = fixture()
    for (const invalid of [null, undefined, [], {}, { workoutId: 411 }, { id: 411 }, { workoutId: null }]) {
      client.getWorkoutDetail.mockResolvedValueOnce(invalid)
      await expect(service.deleteWorkout({ workoutId: 410 })).rejects.toThrow()
    }
    client.getScheduledWorkout.mockResolvedValueOnce({ workoutScheduleId: 821, workoutId: 820 })
    await expect(service.unscheduleWorkout({ scheduleId: 820 })).rejects.toThrow('different workout target')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
    expect(client.unscheduleWorkout).not.toHaveBeenCalled()
  })

  it('validates confirmation types, unknown keys, and unsafe IDs before reading Garmin', async () => {
    const { service, client } = fixture()
    const invalidArgs: unknown[] = [null, [], {}, { workoutId: 410, confirmed: 'true' }, { workoutId: 410, confirmed: 1 },
      { workoutId: 410, confirmationId: '' }, { workoutId: 410, confirmationId: 12 },
      { workoutId: 410, confirmationId: 'token' }, { workoutId: 410, account: 'other' }]
    for (const workoutId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, false, '', '0', '001', '1e3', '../410', '42\n', '9'.repeat(33)]) {
      invalidArgs.push({ workoutId })
    }
    for (const args of invalidArgs) await expect(service.deleteWorkout(args as DeleteWorkoutArgs)).rejects.toThrow()
    await expect(service.unscheduleWorkout({ scheduleId: 820, confirmed: true })).rejects.toThrow('Invalid workout confirmation')
    expect(client.getWorkoutDetail).not.toHaveBeenCalled()
    expect(client.getScheduledWorkout).not.toHaveBeenCalled()
    expect(client.deleteWorkout).not.toHaveBeenCalled()
    expect(client.unscheduleWorkout).not.toHaveBeenCalled()
  })

  it('accepts a precise decimal string beyond JavaScript safe integer range', async () => {
    const { service, client } = fixture()
    const id = '9007199254740993'
    client.getWorkoutDetail.mockResolvedValue({ workoutId: id, workoutName: 'Large resource ID' })
    const confirmationId = token(await service.deleteWorkout({ workoutId: id }))
    await expect(service.deleteWorkout({ workoutId: id, confirmed: true, confirmationId })).resolves.toMatchObject({ success: true, workoutId: id })
    expect(client.deleteWorkout).toHaveBeenCalledWith(id)
  })

  it('keeps create-workout confirmations separate from destructive confirmations', async () => {
    const { service, client } = fixture()
    const definition = { name: 'Synthetic easy run', steps: [{ type: 'warmup' as const, endCondition: 'time' as const, endValue: 600 }] }
    const createToken = token(await service.createWorkout(definition))
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: createToken })).rejects.toThrow('Invalid workout confirmation')
    const removalToken = token(await service.deleteWorkout({ workoutId: 410 }))
    await expect(service.createWorkout({ ...definition, confirmed: true, confirmationId: removalToken })).rejects.toThrow('Invalid workout confirmation')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
    expect(client.addWorkout).not.toHaveBeenCalled()
  })

  it('lists raw calendar data for an explicit inclusive range of at most 31 real dates', async () => {
    const { service, client } = fixture()
    const raw = { calendar: [scheduled], unrecognizedField: 'preserved' }
    client.getScheduledWorkouts.mockResolvedValueOnce(raw)
    await expect(service.getScheduledWorkouts({ startDate: '2026-10-01', endDate: '2026-10-31' })).resolves.toBe(raw)
    expect(client.getScheduledWorkouts).toHaveBeenCalledWith('2026-10-01', '2026-10-31')
    for (const args of [{ startDate: '2026-02-30' }, { startDate: '2026-10-02', endDate: '2026-10-01' },
      { startDate: '2026-10-01', endDate: '2026-11-01' },
      { startDate: '2026-01-01\n', endDate: '2026-12-31' },
      { startDate: '2026-10-01', endDate: '2026-10-01\n' },
      { startDate: 42 }, { account: 'other' }, null, []]) {
      await expect(service.getScheduledWorkouts(args as ScheduledWorkoutsArgs)).rejects.toThrow()
    }
    expect(client.getScheduledWorkouts).toHaveBeenCalledTimes(1)
    await service.getScheduledWorkouts({ startDate: '2026-10-20' })
    expect(client.getScheduledWorkouts).toHaveBeenLastCalledWith('2026-10-20', '2026-10-20')
  })

  it('reports an unavailable SDK method explicitly rather than calling an undefined function', async () => {
    const { client, options } = fixture()
    const { getScheduledWorkouts: _list, getWorkoutDetail: _detail, unscheduleWorkout: _cancel, ...olderClient } = client
    const service = new GarminToolService(olderClient, options)
    await expect(service.getScheduledWorkouts()).rejects.toThrow('installed Garmin SDK does not support')
    await expect(service.deleteWorkout({ workoutId: 410 })).rejects.toThrow('installed Garmin SDK does not support')
    await expect(service.unscheduleWorkout({ scheduleId: 820 })).rejects.toThrow('installed Garmin SDK does not support')
    expect(client.deleteWorkout).not.toHaveBeenCalled()
  })
})
