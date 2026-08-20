import type { Context } from '@deepseek-ai/cordis'
import { GarminConnect } from 'garmin-connect'
import { GarminClient } from '../src/client'
import type { Config } from '../src/config'

jest.mock('garmin-connect', () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    client: { client: { defaults: {} } },
    login: jest.fn().mockResolvedValue(undefined),
    loadToken: jest.fn(),
    exportToken: jest.fn(),
    getActivities: jest.fn(),
    getSteps: jest.fn(),
    getSleepData: jest.fn(),
    getHeartRate: jest.fn(),
    getDailyWeightData: jest.fn(),
    getWorkouts: jest.fn(),
    addWorkout: jest.fn(),
    getUserProfile: jest.fn(),
  })),
}))

type MockGarmin = {
  client: { client: { defaults: { timeout?: number } } }
  login: jest.Mock
  loadToken: jest.Mock
  exportToken: jest.Mock
  getActivities: jest.Mock
  getSteps: jest.Mock
  getSleepData: jest.Mock
  getHeartRate: jest.Mock
  getDailyWeightData: jest.Mock
  getWorkouts: jest.Mock
  addWorkout: jest.Mock
  getUserProfile: jest.Mock
}

const baseConfig: Config = {
  username: 'runner@example.test',
  password: 'password-value',
  sessionToken: '',
  region: 'global',
  cacheTtl: 0,
  logLevel: 'info',
  activityDetail: 'compact',
}

function createContext() {
  return {
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as unknown as Context
}

function latestGarmin(): MockGarmin {
  const constructor = GarminConnect as unknown as jest.Mock
  return constructor.mock.results.at(-1)?.value as MockGarmin
}

describe('GarminClient', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('fails fast when the Garmin username is empty', () => {
    expect(() => new GarminClient(createContext(), {
      ...baseConfig,
      username: '',
    })).toThrow('Garmin username is required')
  })

  it('fails fast when neither a password nor a session token is configured', () => {
    expect(() => new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
    })).toThrow('Garmin password or session token is required')
  })

  it('suppresses info logs when the configured threshold is error', async () => {
    const context = createContext()
    const client = new GarminClient(context, { ...baseConfig, logLevel: 'error' })

    await client.connect()

    expect(context.logger.info).not.toHaveBeenCalled()
  })

  it('keeps an in-flight login single-flight when a stale refresh is discarded', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    let finishLogin!: () => void
    latestGarmin().login.mockImplementation(() => new Promise<void>(resolve => {
      finishLogin = resolve
    }))

    const first = client.connect()
    await Promise.resolve()
    ;(client as any).discardStaleRefresh()
    const second = client.connect()

    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    finishLogin()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it('normalizes numeric step totals with the requested calendar date', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().getSteps.mockResolvedValue(12_345)

    await expect(client.getSteps('2026-08-20')).resolves.toEqual({
      calendarDate: '2026-08-20',
      totalSteps: 12_345,
    })
  })

  it('passes YYYY-MM-DD inputs to Garmin as local-midnight dates', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().getSleepData.mockResolvedValue({})

    await client.getSleep('2026-08-20')

    const requestedDate = latestGarmin().getSleepData.mock.calls[0][0] as Date
    expect([
      requestedDate.getFullYear(),
      requestedDate.getMonth() + 1,
      requestedDate.getDate(),
      requestedDate.getHours(),
    ]).toEqual([2026, 8, 20, 0])
  })

  it('maps the China region to the garmin.cn SDK domain', () => {
    new GarminClient(createContext(), { ...baseConfig, region: 'cn' })

    expect(GarminConnect).toHaveBeenCalledWith({
      username: 'runner@example.test',
      password: 'password-value',
    }, 'garmin.cn')
  })

  it('reconnects when the SDK preserves HTTP 401 only in a wrapped message', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().getSleepData
      .mockRejectedValueOnce(new Error(
        'Error in getSleepData: ERROR: (401), Unauthorized, {"message":"expired"}',
      ))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: '2026-08-20' } })

    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: '2026-08-20' },
    })
  })

  it('backs off and retries idempotent reads when the SDK reports HTTP 429', async () => {
    jest.useFakeTimers()
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().getSleepData
      .mockRejectedValueOnce(new Error('ERROR: (429), Too Many Requests, {}'))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: '2026-08-20' } })

    const request = client.getSleep('2026-08-20')
    await jest.runAllTimersAsync()

    await expect(request).resolves.toEqual({
      dailySleepDTO: { calendarDate: '2026-08-20' },
    })
    expect(latestGarmin().getSleepData).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it('falls back to password login after a restored session token is rejected', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    latestGarmin().getSleepData
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: '2026-08-20' } })

    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: '2026-08-20' },
    })
    expect(latestGarmin().loadToken).toHaveBeenCalledTimes(1)
    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
  })

  it('falls back to password without logging malformed session-token fragments', async () => {
    const context = createContext()
    const malformedToken = 'SUPERSECRET_TOKEN_NOT_JSON'
    const client = new GarminClient(context, {
      ...baseConfig,
      sessionToken: malformedToken,
    })

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    const logged = (context.logger.warn as unknown as jest.Mock).mock.calls
      .flat().map(String).join(' ')
    expect(logged).not.toContain(malformedToken)
    expect(logged).not.toContain('SUPERSECRE')
  })

  it('clears cached health data when token auth falls back to password auth', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      cacheTtl: 300,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    latestGarmin().getSleepData
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'account-a' } })
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'account-b-new-day' } })
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'account-b-original-day' } })

    await expect(client.getSleep('2026-08-19')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'account-a' },
    })
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'account-b-new-day' },
    })
    await expect(client.getSleep('2026-08-19')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'account-b-original-day' },
    })
    expect(latestGarmin().getSleepData).toHaveBeenCalledTimes(4)
  })

  it('does not return an old-token response after another request switches identity', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    let resolveOld!: (value: unknown) => void
    let markOldStarted!: () => void
    const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve })
    latestGarmin().getSleepData
      .mockImplementationOnce(() => {
        markOldStarted()
        return new Promise(resolve => { resolveOld = resolve })
      })
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'password-new-day' } })
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'password-original-day' } })

    const oldRequest = client.getSleep('2026-08-19')
    await oldStarted
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'password-new-day' },
    })
    resolveOld({ dailySleepDTO: { calendarDate: 'token-account' } })

    await expect(oldRequest).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'password-original-day' },
    })
  })

  it('fails once with an actionable error when a token-only session is rejected', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    latestGarmin().getSleepData.mockRejectedValue(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    )

    await expect(client.getSleep('2026-08-20')).rejects.toThrow(
      'Garmin session token was rejected; provide a new token or password',
    )
    expect(latestGarmin().getSleepData).toHaveBeenCalledTimes(1)
    expect(latestGarmin().login).not.toHaveBeenCalled()
  })

  it('rejects a Garmin request that exceeds the configured timeout', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      requestTimeoutMs: 10,
    })
    latestGarmin().getActivities.mockReturnValue(new Promise(() => {}))

    const request = client.getActivities()
    const guard = new Promise<string>(resolve => {
      setTimeout(() => resolve('request did not time out'), 50)
    })

    await expect(Promise.race([request, guard])).rejects.toThrow(
      'Garmin request timed out after 10ms',
    )
  })

  it('detaches a timed-out cached read so a later request can recover', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      cacheTtl: 300,
      requestTimeoutMs: 10,
    })
    latestGarmin().getSleepData
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'recovered' } })

    await expect(client.getSleep('2026-08-20')).rejects.toThrow(
      'Garmin request timed out after 10ms',
    )
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'recovered' },
    })
    expect(latestGarmin().getSleepData).toHaveBeenCalledTimes(2)
  })

  it('logs a sanitized login failure without credentials or authorization data', async () => {
    const context = createContext()
    const client = new GarminClient(context, baseConfig)
    latestGarmin().login.mockRejectedValue(new Error(
      'Login failed for runner@example.test password=password-value Authorization: Bearer token-value',
    ))

    await expect(client.connect()).rejects.toThrow('Login failed')

    const errorLogger = context.logger.error as unknown as jest.Mock
    const logged = errorLogger.mock.calls.flat().map(String).join(' ')
    expect(logged).not.toContain('runner@example.test')
    expect(logged).not.toContain('password-value')
    expect(logged).not.toContain('token-value')
  })

  it('replaces the SDK HTTP error logger with a normalized non-sensitive error', () => {
    new GarminClient(createContext(), baseConfig)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const response = {
      status: 500,
      statusText: 'Server Error',
      data: {
        email: 'private@example.test',
        access_token: 'secret-token',
      },
    }

    let thrown: unknown
    try {
      ;(latestGarmin().client as any).handleHttpError(response)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      message: 'Garmin request failed (HTTP 500)',
      status: 500,
    }))
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('reconnects when an expired cache refresh receives HTTP 401', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const client = new GarminClient(createContext(), { ...baseConfig, cacheTtl: 1 })
    latestGarmin().getSleepData
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'old' } })
      .mockRejectedValueOnce(new Error('ERROR: (401), Unauthorized, {}'))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'fresh' } })

    await client.getSleep('2026-08-20')
    now.mockReturnValue(2_001)
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'fresh' },
    })
    now.mockRestore()
  })

  it('does not retry a workout creation rejected with HTTP 429', async () => {
    jest.useFakeTimers()
    const client = new GarminClient(createContext(), baseConfig)
    const rateLimitError = Object.assign(new Error('rate limited'), { status: 429 })
    latestGarmin().addWorkout.mockRejectedValue(rateLimitError)

    const request = client.addWorkout({ workoutName: 'Single write' })
    const rejection = expect(request).rejects.toBe(rateLimitError)
    await jest.runAllTimersAsync()

    await rejection
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it('marks a rejected session token after a workout write receives HTTP 401', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    latestGarmin().addWorkout.mockRejectedValueOnce(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    )
    latestGarmin().getSleepData.mockResolvedValueOnce({
      dailySleepDTO: { calendarDate: 'password-account' },
    })

    await expect(client.addWorkout({ workoutName: 'Auth boundary' })).rejects.toThrow()
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'password-account' },
    })

    expect(latestGarmin().loadToken).toHaveBeenCalledTimes(1)
    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
  })

  it('does not retry a workout creation that times out', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      requestTimeoutMs: 10,
    })
    latestGarmin().addWorkout.mockReturnValue(new Promise(() => {}))

    await expect(client.addWorkout({ workoutName: 'Timed write' })).rejects.toThrow(
      'outcome is unknown; check the Garmin workout library before retrying',
    )
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
  })

  it('keeps the unknown-outcome warning for an Axios-level write timeout', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().addWorkout.mockRejectedValue(
      Object.assign(new Error('Garmin request failed'), { timedOut: true }),
    )

    await expect(client.addWorkout({ workoutName: 'Axios timeout' })).rejects.toThrow(
      'outcome is unknown; check the Garmin workout library before retrying',
    )
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
  })

  it('invalidates the workout-list cache before a write with an unknown outcome', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      cacheTtl: 300,
      requestTimeoutMs: 10,
    })
    latestGarmin().getWorkouts
      .mockResolvedValueOnce([{ workoutName: 'before-write' }])
      .mockResolvedValueOnce([{ workoutName: 'after-unknown-write' }])
    latestGarmin().addWorkout.mockReturnValue(new Promise(() => {}))

    await expect(client.getWorkouts()).resolves.toEqual([{ workoutName: 'before-write' }])
    await expect(client.addWorkout({ workoutName: 'May exist' })).rejects.toThrow(
      'outcome is unknown',
    )
    await expect(client.getWorkouts()).resolves.toEqual([
      { workoutName: 'after-unknown-write' },
    ])
    expect(latestGarmin().getWorkouts).toHaveBeenCalledTimes(2)
  })
})
