import type { Context } from '@deepseek-ai/cordis'
import { GarminConnect } from 'garmin-connect'
import { GarminClient } from '../src/client'
import { GarminPersonalClient } from '../src/personal-client'
import type { Config } from '../src/config'
import type { GarminResourceId } from '../src/workout-management'

jest.mock('garmin-connect', () => {
  const { GarminConnect: ActualSdk } = jest.requireActual('garmin-connect')
  const { HttpClient } = jest.requireActual('garmin-connect/dist/common/HttpClient')
  const { UrlClass } = jest.requireActual('garmin-connect/dist/garmin/UrlClass')
  return {
    GarminConnect: jest.fn().mockImplementation((_credentials, domain) => {
      // Exercise the maintained SDK's actual URL and HTTP-method behavior;
      // only its Axios boundary and authentication are synthetic.
      const http: Record<string, any> = {
        client: {
          defaults: {},
          interceptors: {
            request: { clear: jest.fn(), use: jest.fn() },
            response: { clear: jest.fn(), use: jest.fn() },
          },
          get: jest.fn().mockResolvedValue({ status: 200, data: null }),
          post: jest.fn().mockResolvedValue({ status: 204, data: undefined }),
          request: jest.fn(),
        },
      }
      http.get = jest.fn(HttpClient.prototype.get.bind(http))
      http.post = jest.fn(HttpClient.prototype.post.bind(http))
      http.delete = jest.fn(HttpClient.prototype.delete.bind(http))
      const sdk: Record<string, any> = {
        client: http,
        url: new UrlClass(domain),
        login: jest.fn().mockResolvedValue(undefined),
        loadToken: jest.fn(),
        exportToken: jest.fn(),
      }
      for (const method of ['getWorkouts', 'getWorkoutDetail', 'deleteWorkout']) {
        sdk[method] = jest.fn(ActualSdk.prototype[method].bind(sdk))
      }
      return sdk
    }),
  }
})

interface MockSdk {
  login: jest.Mock
  loadToken: jest.Mock
  getWorkouts: jest.Mock
  getWorkoutDetail: jest.Mock
  deleteWorkout: jest.Mock
  client: {
    get: jest.Mock
    post: jest.Mock
    delete: jest.Mock
    client: { get: jest.Mock; post: jest.Mock; request: jest.Mock }
  }
}

const config: Config = {
  username: 'runner@example.test',
  password: 'synthetic-password',
  sessionToken: '',
  sessionTokenFile: '',
  region: 'global',
  cacheTtl: 300,
  logLevel: 'error',
  activityDetail: 'full',
  fitDownloadDir: '',
}

function createClient(overrides: Partial<Config> = {}): { client: GarminClient; sdk: MockSdk } {
  const context = {
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as unknown as Context
  const client = new GarminClient(context, { ...config, ...overrides })
  const constructor = GarminConnect as unknown as jest.Mock
  return { client, sdk: constructor.mock.results.at(-1)!.value as MockSdk }
}

const mutations = ['deleteWorkout', 'unscheduleWorkout'] as const

describe('Garmin workout-management client boundary', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    { region: 'cn' as const, domain: 'garmin.cn' },
    { region: 'global' as const, domain: 'garmin.com' },
  ])('uses the authenticated $region transport and distinct template/schedule paths', async ({ region, domain }) => {
    const { client, sdk } = createClient({ region })
    const templateId = '9007199254740993'
    const scheduleId = '9007199254740995'
    const raw = { scheduledWorkouts: [{ scheduleId, workoutId: templateId }], futureField: true }
    const base = `https://connectapi.${domain}/workout-service`
    sdk.client.client.get.mockResolvedValue({ status: 200, data: raw })

    await expect(client.getScheduledWorkouts('2026-10-01', '2026-10-31')).resolves.toBe(raw)
    expect(sdk.client.client.get).toHaveBeenLastCalledWith(
      `${base}/schedule/workoutScheduleByPeriod`,
      { params: { startDate: '2026-10-01', endDate: '2026-10-31' } },
    )
    await expect(client.getScheduledWorkout(scheduleId)).resolves.toBe(raw)
    expect(sdk.client.client.get).toHaveBeenLastCalledWith(`${base}/schedule/${scheduleId}`, undefined)
    await expect(client.getWorkoutDetail(templateId)).resolves.toBe(raw)
    expect(sdk.getWorkoutDetail).toHaveBeenLastCalledWith({ workoutId: templateId })
    expect(sdk.client.client.get).toHaveBeenLastCalledWith(`${base}/workout/${templateId}`, undefined)

    sdk.client.client.post.mockResolvedValueOnce({ status: 200, data: raw })
    await expect(client.scheduleWorkout(templateId, '2026-10-22')).resolves.toBe(raw)
    expect(sdk.client.post).toHaveBeenLastCalledWith(`${base}/schedule/${templateId}`, { date: '2026-10-22' })
    expect(sdk.client.client.post).toHaveBeenLastCalledWith(
      `${base}/schedule/${templateId}`, { date: '2026-10-22' }, undefined,
    )

    await expect(client.deleteWorkout(templateId)).resolves.toBeUndefined()
    expect(sdk.deleteWorkout).toHaveBeenLastCalledWith({ workoutId: templateId })
    expect(sdk.client.client.post).toHaveBeenLastCalledWith(
      `${base}/workout/${templateId}`, null,
      { headers: { 'X-Http-Method-Override': 'DELETE' } },
    )
    await expect(client.unscheduleWorkout(scheduleId)).resolves.toBeUndefined()
    expect(sdk.client.delete).toHaveBeenLastCalledWith(`${base}/schedule/${scheduleId}`)
    expect(sdk.client.client.post).toHaveBeenLastCalledWith(
      `${base}/schedule/${scheduleId}`, null,
      { headers: { 'X-Http-Method-Override': 'DELETE' } },
    )
    expect(sdk.login).toHaveBeenCalledTimes(1)
  })

  it('does not cache either confirmation detail or a schedule range', async () => {
    const { client, sdk } = createClient()
    sdk.client.client.get
      .mockResolvedValueOnce({ data: { revision: 1 } })
      .mockResolvedValueOnce({ data: { revision: 2 } })
    await expect(client.getWorkoutDetail(42)).resolves.toEqual({ revision: 1 })
    await expect(client.getWorkoutDetail(42)).resolves.toEqual({ revision: 2 })
    await client.getScheduledWorkout(55)
    await client.getScheduledWorkout(55)
    await client.getScheduledWorkouts('2026-10-01', '2026-10-02')
    await client.getScheduledWorkouts('2026-10-01', '2026-10-02')
    expect(sdk.client.client.get).toHaveBeenCalledTimes(6)
  })

  it.each([
    Number.MAX_SAFE_INTEGER + 1, 0, -1, 1.1, NaN, Infinity,
    '0', '01', '1e3', '1/other', ' 42 ', '1'.repeat(33), null, undefined,
  ])('rejects unsafe resource ID %j before authentication or requests', async (invalid) => {
    const { client, sdk } = createClient()
    const id = invalid as GarminResourceId
    await expect(client.getWorkoutDetail(id)).rejects.toThrow('Invalid workoutId')
    await expect(client.getScheduledWorkout(id)).rejects.toThrow('Invalid scheduleId')
    await expect(client.scheduleWorkout(id, '2026-10-22')).rejects.toThrow('Invalid workoutId')
    await expect(client.deleteWorkout(id)).rejects.toThrow('Invalid workoutId')
    await expect(client.unscheduleWorkout(id)).rejects.toThrow('Invalid scheduleId')
    expect(sdk.login).not.toHaveBeenCalled()
    expect(sdk.client.client.get).not.toHaveBeenCalled()
    expect(sdk.client.client.post).not.toHaveBeenCalled()
  })

  it.each([
    ['2026-02-29', '2026-03-01'],
    ['2026-10-02', '2026-10-01'],
    ['2026-10-01', '2026-11-01'],
    ['2026-10-01T00:00:00Z', '2026-10-02'],
    [undefined, '2026-10-02'],
  ])('rejects invalid schedule bounds %j to %j before authentication', async (start, end) => {
    const { client, sdk } = createClient()
    await expect(client.getScheduledWorkouts(start as string, end as string)).rejects.toThrow()
    expect(sdk.login).not.toHaveBeenCalled()
    expect(sdk.client.client.get).not.toHaveBeenCalled()
  })

  it.each(mutations)('%s accepts a successful empty or 204 response', async (method) => {
    const { client, sdk } = createClient()
    sdk.client.client.post
      .mockResolvedValueOnce({ status: 204, data: undefined })
      .mockResolvedValueOnce(undefined)
    await expect(client[method](42)).resolves.toBeUndefined()
    await expect(client[method](42)).resolves.toBeUndefined()
    expect(sdk.client.client.post).toHaveBeenCalledTimes(2)
  })

  it.each(mutations)('%s never replays 401, 403 or 429 and strips upstream secrets', async (method) => {
    for (const status of [401, 403, 429]) {
      const { client, sdk } = createClient()
      sdk.client.client.post.mockRejectedValueOnce(Object.assign(
        new Error('Authorization: Bearer SYNTHETIC_SECRET runner@example.test'),
        { response: { status, data: 'private upstream body' } },
      ))
      const request = client[method](42)
      await expect(request).rejects.toThrow(`HTTP ${status}`)
      await expect(request).rejects.toThrow('read-only query before retrying')
      await expect(request).rejects.not.toThrow('SYNTHETIC_SECRET')
      await expect(request).rejects.not.toThrow('runner@example.test')
      expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
      expect(sdk.client.client.request).not.toHaveBeenCalled()
      expect(sdk.login).toHaveBeenCalledTimes(1)
    }
  })

  it.each(mutations)('%s invalidates the cached library even when it times out', async (method) => {
    const { client, sdk } = createClient({ requestTimeoutMs: 10 })
    sdk.client.client.get
      .mockResolvedValueOnce({ data: [{ workoutId: 42 }] })
      .mockResolvedValueOnce({ data: [] })
    sdk.client.client.post.mockReturnValueOnce(new Promise(() => {}))
    await expect(client.getWorkouts()).resolves.toEqual([{ workoutId: 42 }])
    await expect(client.getWorkouts()).resolves.toEqual([{ workoutId: 42 }])
    await expect(client[method](42)).rejects.toThrow('outcome is unknown')
    await expect(client.getWorkouts()).resolves.toEqual([])
    expect(sdk.getWorkouts).toHaveBeenCalledTimes(2)
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
  })

  it('invalidates a list fetched between a timeout and a late remote completion', async () => {
    const { client, sdk } = createClient({ requestTimeoutMs: 10 })
    let finish!: (value: unknown) => void
    sdk.client.client.post.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    sdk.client.client.get
      .mockResolvedValueOnce({ data: [{ workoutId: 42 }] })
      .mockResolvedValueOnce({ data: [] })
    await expect(client.unscheduleWorkout(55)).rejects.toThrow('outcome is unknown')
    await expect(client.getWorkouts()).resolves.toEqual([{ workoutId: 42 }])
    finish({ status: 204 })
    // Drain the SDK HTTP promise and the late invalidation, without a timer.
    await new Promise<void>(resolve => setImmediate(resolve))
    await expect(client.getWorkouts()).resolves.toEqual([])
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
    expect(sdk.getWorkouts).toHaveBeenCalledTimes(2)
  })

  it.each(mutations)('%s fences success if authentication changes in flight', async (method) => {
    const { client, sdk } = createClient()
    let started!: () => void
    const requestStarted = new Promise<void>(resolve => { started = resolve })
    let finish!: (value: unknown) => void
    sdk.client.client.post.mockImplementationOnce(() => {
      started()
      return new Promise(resolve => { finish = resolve })
    })
    const request = client[method](42)
    await requestStarted
    client.deactivate()
    finish({ status: 204 })
    await expect(request).rejects.toThrow('authentication changed')
    await expect(request).rejects.toThrow('outcome is unknown')
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
  })

  it('rejects a failed write session but never falls back and repeats the mutation', async () => {
    const { client, sdk } = createClient({ sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }) })
    sdk.client.client.post.mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401 }))
    await expect(client.deleteWorkout(42)).rejects.toThrow('request a new preview and confirmation')
    expect(sdk.loadToken).toHaveBeenCalledTimes(1)
    expect(sdk.login).not.toHaveBeenCalled()
    await client.getWorkouts()
    expect(sdk.login).toHaveBeenCalledTimes(1)
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
  })

  it.each([
    '2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-10-00',
    '2026-1-01', '2026-10-22\n', '2026-10-22T00:00:00Z', '0000-01-01',
    '1900-02-29', '', null, undefined, 20261022,
  ])('rejects an invalid schedule date %j before authentication or POST', async (date) => {
    const { client, sdk } = createClient()
    await expect(client.scheduleWorkout(42, date as string)).rejects.toThrow('Invalid date')
    expect(sdk.login).not.toHaveBeenCalled()
    expect(sdk.client.client.post).not.toHaveBeenCalled()
  })

  it.each(['2024-02-29', '2000-02-29', '0099-01-01', '2026-10-22'])('keeps the calendar date %s unchanged', async (date) => {
    const { client, sdk } = createClient()
    await client.scheduleWorkout(42, date)
    expect(sdk.client.post).toHaveBeenCalledWith(
      'https://connectapi.garmin.com/workout-service/schedule/42', { date },
    )
  })

  it.each([401, 403, 429, 500, 503])('never replays a schedule POST after HTTP %s and returns only a safe error', async (status) => {
    const { client, sdk } = createClient()
    sdk.client.client.post.mockRejectedValueOnce(Object.assign(
      new Error('Authorization: Bearer SYNTHETIC_SECRET runner@example.test'),
      { response: { status, data: 'private upstream body' } },
    ))
    const request = client.scheduleWorkout(42, '2026-10-22')
    await expect(request).rejects.toThrow(`HTTP ${status}`)
    await expect(request).rejects.toThrow('outcome is unknown')
    await expect(request).rejects.toThrow('the Garmin workout calendar with a read-only query before retrying')
    await expect(request).rejects.not.toThrow('SYNTHETIC_SECRET')
    await expect(request).rejects.not.toThrow('runner@example.test')
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
    expect(sdk.client.client.request).not.toHaveBeenCalled()
    expect(sdk.login).toHaveBeenCalledTimes(1)
  })

  it.each(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'])('does not replay a schedule POST after %s', async (code) => {
    const { client, sdk } = createClient()
    sdk.client.client.post.mockRejectedValueOnce(Object.assign(
      new Error('Bearer SYNTHETIC_SECRET'), { code },
    ))
    const request = client.scheduleWorkout(42, '2026-10-22')
    await expect(request).rejects.toThrow('outcome is unknown')
    await expect(request).rejects.not.toThrow('SYNTHETIC_SECRET')
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
    expect(sdk.client.client.request).not.toHaveBeenCalled()
    expect(sdk.login).toHaveBeenCalledTimes(1)
  })

  it('invalidates cached lists after a schedule succeeds', async () => {
    const { client, sdk } = createClient()
    sdk.client.client.get
      .mockResolvedValueOnce({ data: [{ workoutId: 42 }] })
      .mockResolvedValueOnce({ data: [{ workoutId: 42, scheduled: true }] })
    await client.getWorkouts()
    await client.getWorkouts()
    await client.scheduleWorkout(42, '2026-10-22')
    await expect(client.getWorkouts()).resolves.toEqual([{ workoutId: 42, scheduled: true }])
    expect(sdk.getWorkouts).toHaveBeenCalledTimes(2)
  })

  it('invalidates a list fetched after a schedule timeout again when the POST completes late', async () => {
    const { client, sdk } = createClient({ requestTimeoutMs: 10 })
    let finish!: (value: unknown) => void
    sdk.client.client.post.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    sdk.client.client.get
      .mockResolvedValueOnce({ data: [{ workoutId: 42 }] })
      .mockResolvedValueOnce({ data: [{ workoutId: 42, scheduled: true }] })
    await expect(client.scheduleWorkout(42, '2026-10-22')).rejects.toThrow('outcome is unknown')
    await expect(client.getWorkouts()).resolves.toEqual([{ workoutId: 42 }])
    finish({ status: 200, data: { workoutScheduleId: 55 } })
    await new Promise<void>(resolve => setImmediate(resolve))
    await expect(client.getWorkouts()).resolves.toEqual([{ workoutId: 42, scheduled: true }])
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
    expect(sdk.getWorkouts).toHaveBeenCalledTimes(2)
  })

  it('fences a completed schedule if authentication changed in flight', async () => {
    const { client, sdk } = createClient()
    let started!: () => void
    const requestStarted = new Promise<void>(resolve => { started = resolve })
    let finish!: (value: unknown) => void
    sdk.client.client.post.mockImplementationOnce(() => {
      started()
      return new Promise(resolve => { finish = resolve })
    })
    const request = client.scheduleWorkout(42, '2026-10-22')
    await requestStarted
    client.deactivate()
    finish({ status: 200, data: { workoutScheduleId: 55 } })
    await expect(request).rejects.toThrow('authentication changed')
    await expect(request).rejects.toThrow('outcome is unknown')
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
  })

  it('never falls back to password login to repeat a rejected schedule POST', async () => {
    const { client, sdk } = createClient({ sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }) })
    sdk.client.client.post.mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401 }))
    await expect(client.scheduleWorkout(42, '2026-10-22')).rejects.toThrow('request a new preview and confirmation')
    expect(sdk.loadToken).toHaveBeenCalledTimes(1)
    expect(sdk.login).not.toHaveBeenCalled()
    await client.getWorkouts()
    expect(sdk.login).toHaveBeenCalledTimes(1)
    expect(sdk.client.client.post).toHaveBeenCalledTimes(1)
  })

  it('explicitly rejects scheduling through the read-only Personal API', async () => {
    const client = new GarminPersonalClient(config)
    await expect(client.scheduleWorkout()).rejects.toThrow('not available through the official Garmin Personal API')
  })
})
