import { GarminToolService } from '../src/tool-service'
import type { CreateWorkoutArgs, GarminDataClient, GarminToolServiceOptions } from '../src/tool-service'
import type { ScheduleWorkoutArgs } from '../src/workout-management'

const date = '2026-10-23'
const definition: CreateWorkoutArgs = {
  name: 'Synthetic calendar run',
  steps: [{ type: 'warmup', endCondition: 'time', endValue: 600 }],
}
const workout = {
  workoutId: 410,
  workoutName: definition.name,
  owner: { email: 'synthetic@example.invalid' },
  steps: [{ duration: 600 }],
}

function fixture() {
  const client = {
    getActivities: jest.fn(async () => []),
    getSleep: jest.fn(), getSteps: jest.fn(), getHeartRate: jest.fn(), getWeight: jest.fn(),
    getWorkouts: jest.fn(async () => []), downloadOriginalActivityZip: jest.fn(), getUserProfile: jest.fn(),
    addWorkout: jest.fn(async (_workout: Record<string, unknown>): Promise<Record<string, unknown>> => structuredClone(workout)),
    getWorkoutDetail: jest.fn(async (_id: string | number): Promise<unknown> => structuredClone(workout)),
    getScheduledWorkout: jest.fn(),
    getScheduledWorkouts: jest.fn(async (): Promise<unknown> => []),
    scheduleWorkout: jest.fn(async (_id: string | number, _date: string): Promise<unknown> => ({ workoutScheduleId: 820 })),
    deleteWorkout: jest.fn(async (): Promise<void> => undefined),
    unscheduleWorkout: jest.fn(async (): Promise<void> => undefined),
  } satisfies GarminDataClient
  const options: GarminToolServiceOptions = {
    provider: 'connect-web', activityDetail: 'full', fitDownloadDir: '',
    accountUsername: 'synthetic@example.invalid', accountRegion: 'cn', accountId: 'synthetic-cn',
  }
  return { client, options, service: new GarminToolService(client, options) }
}

function token(preview: Record<string, unknown>): string {
  expect(preview.requiresConfirmation).toBe(true)
  expect(preview.confirmationId).toEqual(expect.any(String))
  return preview.confirmationId as string
}

describe('schedule an existing workout', () => {
  afterEach(() => jest.restoreAllMocks())

  it('previews only the selected account, workout and date without writing', async () => {
    const { client, service } = fixture()
    const preview = await service.scheduleWorkout({ workoutId: 410, date })
    token(preview)
    expect(preview.preview).toMatchObject({
      action: 'schedule_workout', workoutId: '410', date, workoutName: definition.name,
      accountRegion: 'cn', accountId: 'synthetic-cn',
    })
    expect(JSON.stringify(preview)).not.toContain('synthetic@example.invalid')
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
    expect(client.addWorkout).not.toHaveBeenCalled()
  })

  it('schedules the canonical ID once, preserves the schedule ID, and waits for device sync', async () => {
    const { client, service } = fixture()
    const confirmationId = token(await service.scheduleWorkout({ workoutId: 410, date }))
    const args = { workoutId: '410', date, confirmed: true, confirmationId }
    await expect(service.scheduleWorkout(args)).resolves.toMatchObject({
      success: true, action: 'schedule_workout', workoutId: '410', date, scheduleId: '820', deviceSync: 'pending',
    })
    expect(client.scheduleWorkout).toHaveBeenCalledWith('410', date)
    await expect(service.scheduleWorkout(args)).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it('allows only one concurrent use of the same confirmation', async () => {
    const { client, service } = fixture()
    const confirmationId = token(await service.scheduleWorkout({ workoutId: 410, date }))
    const args = { workoutId: 410, date, confirmed: true, confirmationId }
    const results = await Promise.allSettled([service.scheduleWorkout(args), service.scheduleWorkout(args)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(client.scheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it('prevents two separately confirmed previews from adding the same calendar entry concurrently', async () => {
    const { client, service } = fixture()
    const firstToken = token(await service.scheduleWorkout({ workoutId: 410, date }))
    const secondToken = token(await service.scheduleWorkout({ workoutId: 410, date }))
    let started!: () => void
    const requestStarted = new Promise<void>(resolve => { started = resolve })
    let finish!: (value: unknown) => void
    client.scheduleWorkout.mockImplementationOnce(() => {
      started()
      return new Promise(resolve => { finish = resolve })
    })
    const first = service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId: firstToken })
    await requestStarted
    const second = { workoutId: 410, date, confirmed: true, confirmationId: secondToken }
    await expect(service.scheduleWorkout(second)).rejects.toThrow('already in progress')
    finish({ workoutScheduleId: 820 })
    await expect(first).resolves.toMatchObject({ success: true })
    await expect(service.scheduleWorkout(second)).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it('does not mistake a template ID for a schedule ID or echo private response fields', async () => {
    const { client, service } = fixture()
    const confirmationId = token(await service.scheduleWorkout({ workoutId: 410, date }))
    client.scheduleWorkout.mockResolvedValueOnce({ workoutId: 410, id: 820, access_token: 'SYNTHETIC_SECRET' })
    const result = await service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId })
    expect(result).toMatchObject({ success: true, workoutId: '410' })
    expect(result).not.toHaveProperty('scheduleId')
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
  })

  it.each(['2026-02-29', '2026-04-31', '2026-10-23\n', '2026-10-23T00:00:00Z', '', null, 20261023])(
    'rejects invalid date %j before reading or writing', async (invalid) => {
      const { client, service } = fixture()
      await expect(service.scheduleWorkout({ workoutId: 410, date: invalid as string })).rejects.toThrow()
      expect(client.getWorkoutDetail).not.toHaveBeenCalled()
      expect(client.scheduleWorkout).not.toHaveBeenCalled()
    },
  )

  it('validates argument types, ID safety, and unexpected fields before reading', async () => {
    const { client, service } = fixture()
    const invalid: unknown[] = [null, [], {}, { workoutId: 410 }, { date },
      { workoutId: '410/other', date }, { workoutId: Number.MAX_SAFE_INTEGER + 1, date },
      { workoutId: 410, date, confirmed: 'true' }, { workoutId: 410, date, confirmationId: '' },
      { workoutId: 410, date, confirmationId: 'unapproved' }, { workoutId: 410, date, account: 'other' }]
    for (const args of invalid) await expect(service.scheduleWorkout(args as ScheduleWorkoutArgs)).rejects.toThrow()
    expect(client.getWorkoutDetail).not.toHaveBeenCalled()
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it.each([
    { workoutId: 411, date },
    { workoutId: 410, date: '2026-10-24' },
  ])('binds confirmation to the exact target and date %j', async (changed) => {
    const { client, service } = fixture()
    const confirmationId = token(await service.scheduleWorkout({ workoutId: 410, date }))
    await expect(service.scheduleWorkout({ ...changed, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    await expect(service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it.each(['accountUsername', 'accountRegion', 'accountId'] as const)('binds confirmation to %s', async (field) => {
    const { client, service, options } = fixture()
    const confirmationId = token(await service.scheduleWorkout({ workoutId: 410, date }))
    if (field === 'accountRegion') options.accountRegion = 'global'
    else options[field] = 'other'
    await expect(service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('rechecks the full template before scheduling, including unshown changes', async () => {
    const { client, service } = fixture()
    const confirmationId = token(await service.scheduleWorkout({ workoutId: 410, date }))
    client.getWorkoutDetail.mockResolvedValueOnce({ ...workout, steps: [{ duration: 1200 }] })
    await expect(service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId })).rejects.toThrow('changed after the preview')
    await expect(service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('expires a scheduling confirmation after exactly ten minutes', async () => {
    const { client, service } = fixture()
    let now = 1_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const confirmationId = token(await service.scheduleWorkout({ workoutId: 410, date }))
    now += 10 * 60 * 1000
    await expect(service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('keeps schedule, create and delete confirmations separate', async () => {
    const { client, service } = fixture()
    const scheduleToken = token(await service.scheduleWorkout({ workoutId: 410, date }))
    const createToken = token(await service.createWorkout(definition))
    const deleteToken = token(await service.deleteWorkout({ workoutId: 410 }))
    await expect(service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId: createToken })).rejects.toThrow('Invalid workout confirmation')
    await expect(service.scheduleWorkout({ workoutId: 410, date, confirmed: true, confirmationId: deleteToken })).rejects.toThrow('Invalid workout confirmation')
    await expect(service.createWorkout({ ...definition, confirmed: true, confirmationId: scheduleToken })).rejects.toThrow('Invalid workout confirmation')
    await expect(service.deleteWorkout({ workoutId: 410, confirmed: true, confirmationId: scheduleToken })).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
    expect(client.addWorkout).not.toHaveBeenCalled()
    expect(client.deleteWorkout).not.toHaveBeenCalled()
  })

  it('consumes the confirmation even if the detail read or POST fails', async () => {
    const { client, service } = fixture()
    const readToken = token(await service.scheduleWorkout({ workoutId: 410, date }))
    client.getWorkoutDetail.mockRejectedValueOnce(new Error('Synthetic read failure'))
    const readArgs = { workoutId: 410, date, confirmed: true, confirmationId: readToken }
    await expect(service.scheduleWorkout(readArgs)).rejects.toThrow()
    await expect(service.scheduleWorkout(readArgs)).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
    const writeToken = token(await service.scheduleWorkout({ workoutId: 410, date }))
    client.scheduleWorkout.mockRejectedValueOnce(new Error('Synthetic network failure'))
    const writeArgs = { workoutId: 410, date, confirmed: true, confirmationId: writeToken }
    await expect(service.scheduleWorkout(writeArgs)).rejects.toThrow()
    await expect(service.scheduleWorkout(writeArgs)).rejects.toThrow('Invalid workout confirmation')
    expect(client.scheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it('rejects a Personal API account before reading any workout', async () => {
    const { client, service, options } = fixture()
    options.provider = 'personal'
    await expect(service.scheduleWorkout({ workoutId: 410, date })).rejects.toThrow()
    expect(client.getWorkoutDetail).not.toHaveBeenCalled()
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })
})

describe('create and schedule in one confirmed request', () => {
  afterEach(() => jest.restoreAllMocks())

  it('preserves library-only creation when no date was requested', async () => {
    const { client, service } = fixture()
    const confirmationId = token(await service.createWorkout(definition))
    await expect(service.createWorkout({ ...definition, confirmed: true, confirmationId })).resolves.toMatchObject({ success: true })
    expect(client.addWorkout).toHaveBeenCalledTimes(1)
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('includes the date in preview, then creates before scheduling the returned ID', async () => {
    const { client, service } = fixture()
    const args = { ...definition, scheduleDate: date }
    const preview = await service.createWorkout(args)
    expect(preview.preview).toMatchObject({ scheduleDate: date })
    expect(client.addWorkout).not.toHaveBeenCalled()
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
    const confirmationId = token(preview)
    await expect(service.createWorkout({ ...args, confirmed: true, confirmationId })).resolves.toMatchObject({ success: true })
    expect(client.addWorkout).toHaveBeenCalledTimes(1)
    expect(client.addWorkout.mock.calls[0][0]).not.toHaveProperty('scheduleDate')
    expect(client.scheduleWorkout).toHaveBeenCalledWith('410', date)
    expect(client.addWorkout.mock.invocationCallOrder[0]).toBeLessThan(client.scheduleWorkout.mock.invocationCallOrder[0])
  })

  it('allows only one concurrent create-and-schedule with a confirmation', async () => {
    const { client, service } = fixture()
    const args = { ...definition, scheduleDate: date }
    const confirmationId = token(await service.createWorkout(args))
    const confirmed = { ...args, confirmed: true, confirmationId }
    const results = await Promise.allSettled([service.createWorkout(confirmed), service.createWorkout(confirmed)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(client.addWorkout).toHaveBeenCalledTimes(1)
    expect(client.scheduleWorkout).toHaveBeenCalledTimes(1)
  })

  it.each(['changed', 'omitted'] as const)('rejects a %s date after preview without creating anything', async (mode) => {
    const { client, service } = fixture()
    const confirmationId = token(await service.createWorkout({ ...definition, scheduleDate: date }))
    const scheduleDate = mode === 'changed' ? '2026-10-24' : undefined
    await expect(service.createWorkout({ ...definition, scheduleDate, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    expect(client.addWorkout).not.toHaveBeenCalled()
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('requires a new preview to add a date to library-only creation', async () => {
    const { client, service } = fixture()
    const confirmationId = token(await service.createWorkout(definition))
    await expect(service.createWorkout({ ...definition, scheduleDate: date, confirmed: true, confirmationId })).rejects.toThrow('Invalid workout confirmation')
    expect(client.addWorkout).not.toHaveBeenCalled()
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it.each(['2026-02-29', '2026-10-23\n', '', null, 20261023])('rejects invalid scheduleDate %j before creation', async (scheduleDate) => {
    const { client, service } = fixture()
    await expect(service.createWorkout({ ...definition, scheduleDate: scheduleDate as string })).rejects.toThrow()
    expect(client.addWorkout).not.toHaveBeenCalled()
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('rejects an unsupported SDK before it can create an unschedulable workout', async () => {
    const { client, options } = fixture()
    const { scheduleWorkout: _schedule, ...olderClient } = client
    const service = new GarminToolService(olderClient, options)
    await expect(service.createWorkout({ ...definition, scheduleDate: date })).rejects.toThrow('installed Garmin SDK does not support')
    await expect(service.scheduleWorkout({ workoutId: 410, date })).rejects.toThrow('installed Garmin SDK does not support')
    expect(client.addWorkout).not.toHaveBeenCalled()
  })

  it('rejects Personal API creation before any write', async () => {
    const { client, service, options } = fixture()
    options.provider = 'personal'
    await expect(service.createWorkout({ ...definition, scheduleDate: date })).rejects.toThrow()
    expect(client.addWorkout).not.toHaveBeenCalled()
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('returns a safe partial result after an uncertain schedule outcome and never recreates the template', async () => {
    const { client, service } = fixture()
    const args = { ...definition, scheduleDate: date }
    const confirmationId = token(await service.createWorkout(args))
    client.scheduleWorkout.mockRejectedValueOnce(new Error('Bearer SYNTHETIC_SECRET synthetic@example.invalid'))
    const confirmed = { ...args, confirmed: true, confirmationId }
    const result = await service.createWorkout(confirmed)
    expect(result).toMatchObject({
      success: false, partialSuccess: true, workoutCreated: true, workoutId: '410',
      scheduleDate: date, scheduling: { status: 'unconfirmed', outcomeUnknown: true },
    })
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
    expect(JSON.stringify(result)).not.toContain('synthetic@example.invalid')
    expect(JSON.stringify(result)).toMatch(/calendar|scheduled|schedule/i)
    await expect(service.createWorkout(confirmed)).rejects.toThrow('Invalid workout confirmation')
    expect(client.addWorkout).toHaveBeenCalledTimes(1)
    expect(client.scheduleWorkout).toHaveBeenCalledTimes(1)

    // After the calendar has been checked, recovery uses the existing ID.
    const recoveryToken = token(await service.scheduleWorkout({ workoutId: result.workoutId as string, date }))
    await expect(service.scheduleWorkout({ workoutId: '410', date, confirmed: true, confirmationId: recoveryToken })).resolves.toMatchObject({ success: true })
    expect(client.addWorkout).toHaveBeenCalledTimes(1)
    expect(client.scheduleWorkout).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, null, 0, Number.MAX_SAFE_INTEGER + 1, '410/other', ''])('does not schedule after creation returns an invalid ID %j', async (workoutId) => {
    const { client, service } = fixture()
    const args = { ...definition, scheduleDate: date }
    const confirmationId = token(await service.createWorkout(args))
    client.addWorkout.mockResolvedValueOnce({ workoutId, workoutName: definition.name })
    await expect(service.createWorkout({ ...args, confirmed: true, confirmationId })).resolves.toMatchObject({
      success: false, partialSuccess: true, workoutCreated: true, scheduleDate: date,
      scheduling: { status: 'not_attempted' },
    })
    expect(client.addWorkout).toHaveBeenCalledTimes(1)
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })

  it('does not schedule or retry creation when creation itself has an uncertain outcome', async () => {
    const { client, service } = fixture()
    const args = { ...definition, scheduleDate: date }
    const confirmationId = token(await service.createWorkout(args))
    client.addWorkout.mockRejectedValueOnce(new Error('Synthetic creation timeout'))
    const confirmed = { ...args, confirmed: true, confirmationId }
    await expect(service.createWorkout(confirmed)).rejects.toThrow()
    await expect(service.createWorkout(confirmed)).rejects.toThrow('Invalid workout confirmation')
    expect(client.addWorkout).toHaveBeenCalledTimes(1)
    expect(client.scheduleWorkout).not.toHaveBeenCalled()
  })
})
