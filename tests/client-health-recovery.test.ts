import type { Context } from '@deepseek-ai/cordis'
import { GarminConnect } from 'garmin-connect'
import { GarminClient } from '../src/client'
import type { Config } from '../src/config'
import type { HealthMetricMethod } from '../src/health-tools'

jest.mock('garmin-connect', () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    client: {
      client: {
        defaults: {},
        interceptors: {
          request: { clear: jest.fn(), use: jest.fn() },
          response: { clear: jest.fn(), use: jest.fn() },
        },
        request: jest.fn(),
      },
    },
    login: jest.fn().mockResolvedValue(undefined),
    loadToken: jest.fn(),
    exportToken: jest.fn(),
    ...Object.fromEntries([
      'getHrvData', 'getHrvSummaries', 'getStressData', 'getStressSummaries',
      'getBodyBattery', 'getTrainingReadiness', 'getDailyTrainingStatus',
      'getTrainingStatus', 'getTrainingLoadBalance', 'getMaxMetrics',
      'getMaxMetricsRange', 'getRacePredictions', 'getRacePredictionsRange',
    ].map(method => [method, jest.fn()])),
  })),
}))

type MockSdk = Record<HealthMetricMethod, jest.Mock> & {
  login: jest.Mock
  loadToken: jest.Mock
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

const date = '2026-10-07'
const start = '2026-10-01'
const calls: Array<{
  method: HealthMetricMethod
  invoke: (client: GarminClient) => Promise<unknown>
  sdkArgs: unknown[]
}> = [
  { method: 'getHrvData', invoke: client => client.getHrvData(date), sdkArgs: [date] },
  { method: 'getHrvSummaries', invoke: client => client.getHrvSummaries(start, date), sdkArgs: [start, date] },
  { method: 'getStressData', invoke: client => client.getStressData(date), sdkArgs: [date] },
  { method: 'getStressSummaries', invoke: client => client.getStressSummaries(start, date), sdkArgs: [start, date] },
  { method: 'getBodyBattery', invoke: client => client.getBodyBattery(start, date), sdkArgs: [start, date] },
  { method: 'getTrainingReadiness', invoke: client => client.getTrainingReadiness(date), sdkArgs: [date] },
  { method: 'getDailyTrainingStatus', invoke: client => client.getDailyTrainingStatus(date), sdkArgs: [date] },
  { method: 'getTrainingStatus', invoke: client => client.getTrainingStatus(date), sdkArgs: [date] },
  { method: 'getTrainingLoadBalance', invoke: client => client.getTrainingLoadBalance(date), sdkArgs: [date] },
  { method: 'getMaxMetrics', invoke: client => client.getMaxMetrics(date), sdkArgs: [date] },
  { method: 'getMaxMetricsRange', invoke: client => client.getMaxMetricsRange(start, date), sdkArgs: [start, date] },
  { method: 'getRacePredictions', invoke: client => client.getRacePredictions(), sdkArgs: [] },
  {
    method: 'getRacePredictionsRange',
    invoke: client => client.getRacePredictionsRange(start, date, 'monthly'),
    sdkArgs: [start, date, { aggregation: 'monthly' }],
  },
]

describe('Garmin recovery client boundary', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each(calls)('routes and caches $method without trimming unknown data', async ({ method, invoke, sdkArgs }) => {
    const { client, sdk } = createClient()
    const raw = {
      calendarDate: date,
      futureMetric: { descriptor: ['timestamp', 'value'], values: [[1, -1], [2, null], [3, 0]] },
      recordedDevices: [{ futureField: 'preserved' }],
    }
    sdk[method].mockResolvedValue(raw)

    await expect(invoke(client)).resolves.toBe(raw)
    await expect(invoke(client)).resolves.toBe(raw)
    expect(sdk[method]).toHaveBeenCalledWith(...sdkArgs)
    expect(sdk[method]).toHaveBeenCalledTimes(1)
    expect(sdk.login).toHaveBeenCalledTimes(1)
  })

  it.each([null, []])('preserves and caches valid empty data %j', async (raw) => {
    const { client, sdk } = createClient()
    sdk.getTrainingReadiness.mockResolvedValue(raw)
    await expect(client.getTrainingReadiness(date)).resolves.toBe(raw)
    await expect(client.getTrainingReadiness(date)).resolves.toBe(raw)
    expect(sdk.getTrainingReadiness).toHaveBeenCalledTimes(1)
  })

  it.each(['2026-02-29', '1900-02-29', '2026-04-31', '0000-01-01', '2026-10-07T00:00:00Z', '', undefined, 123])(
    'rejects an invalid calendar input %j before attempting authentication',
    async (invalid) => {
      const { client, sdk } = createClient()
      await expect(client.getHrvData(invalid as string)).rejects.toThrow('valid calendar date')
      await expect(client.getTrainingStatus(invalid as string)).rejects.toThrow('valid calendar date')
      expect(sdk.login).not.toHaveBeenCalled()
      expect(sdk.getHrvData).not.toHaveBeenCalled()
      expect(sdk.getTrainingStatus).not.toHaveBeenCalled()
    },
  )

  it('keeps leap days and early calendar years literal', async () => {
    const { client, sdk } = createClient()
    sdk.getHrvData.mockResolvedValue(null)
    for (const valid of ['2000-02-29', '2024-02-29', '0001-01-01', '0099-12-31']) {
      await client.getHrvData(valid)
      expect(sdk.getHrvData).toHaveBeenLastCalledWith(valid)
    }
  })

  it('rejects invalid ranges, missing bounds, aggregation and excessive spans before login', async () => {
    const { client, sdk } = createClient()
    await expect(client.getHrvSummaries(date, start)).rejects.toThrow('on or before')
    await expect(client.getStressSummaries(start, '2026-09-31')).rejects.toThrow('valid calendar date')
    await expect(client.getMaxMetricsRange(start, undefined as unknown as string)).rejects.toThrow('valid calendar date')
    await expect(client.getRacePredictionsRange(start, date, 'weekly' as 'daily')).rejects.toThrow('daily or monthly')
    await expect(client.getRacePredictionsRange('2024-01-01', '2025-01-02')).rejects.toThrow('366 days')
    expect(sdk.login).not.toHaveBeenCalled()
  })

  it('defaults Body Battery to a single day and uses a distinct key for every bound', async () => {
    const { client, sdk } = createClient()
    sdk.getBodyBattery.mockImplementation((from, to) => Promise.resolve({ from, to }))
    await expect(client.getBodyBattery(start)).resolves.toEqual({ from: start, to: start })
    await expect(client.getBodyBattery(start, date)).resolves.toEqual({ from: start, to: date })
    await expect(client.getBodyBattery('2026-10-02', date)).resolves.toEqual({ from: '2026-10-02', to: date })
    await client.getBodyBattery(start)
    expect(sdk.getBodyBattery).toHaveBeenCalledTimes(3)
  })

  it('separates daily/monthly history from latest race predictions in the cache', async () => {
    const { client, sdk } = createClient()
    sdk.getRacePredictions.mockResolvedValue({ latest: true })
    sdk.getRacePredictionsRange.mockImplementation((_from, _to, options) => Promise.resolve(options))
    await expect(client.getRacePredictions()).resolves.toEqual({ latest: true })
    await expect(client.getRacePredictionsRange(start, date)).resolves.toEqual({ aggregation: 'daily' })
    await expect(client.getRacePredictionsRange(start, date, 'monthly')).resolves.toEqual({ aggregation: 'monthly' })
    await client.getRacePredictionsRange(start, date)
    await client.getRacePredictionsRange(start, date, 'monthly')
    expect(sdk.getRacePredictionsRange).toHaveBeenCalledTimes(2)
  })

  it('single-flights concurrent recovery requests and keeps account caches separate', async () => {
    const first = createClient()
    const second = createClient({ username: 'other@example.test', region: 'cn' })
    first.sdk.getHrvData.mockResolvedValue({ account: 'first' })
    second.sdk.getHrvData.mockResolvedValue({ account: 'second' })
    const results = await Promise.all([
      first.client.getHrvData(date), first.client.getHrvData(date), second.client.getHrvData(date),
    ])
    expect(results).toEqual([{ account: 'first' }, { account: 'first' }, { account: 'second' }])
    expect(first.sdk.getHrvData).toHaveBeenCalledTimes(1)
    expect(second.sdk.getHrvData).toHaveBeenCalledTimes(1)
  })

  it('discards cached recovery data after session-to-password authentication changes', async () => {
    const { client, sdk } = createClient({ sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }) })
    sdk.getHrvData.mockResolvedValueOnce({ account: 'token' }).mockResolvedValueOnce({ account: 'password' })
    sdk.getTrainingStatus
      .mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401 }))
      .mockResolvedValueOnce({ status: 'fresh' })

    await expect(client.getHrvData(date)).resolves.toEqual({ account: 'token' })
    await expect(client.getTrainingStatus(date)).resolves.toEqual({ status: 'fresh' })
    await expect(client.getHrvData(date)).resolves.toEqual({ account: 'password' })
    expect(sdk.loadToken).toHaveBeenCalledTimes(1)
    expect(sdk.login).toHaveBeenCalledTimes(1)
    expect(sdk.getHrvData).toHaveBeenCalledTimes(2)
  })

  it('fences an old in-flight recovery response when another request changes authentication', async () => {
    const { client, sdk } = createClient({ sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }) })
    let finishOld!: (value: unknown) => void
    let started!: () => void
    const requestStarted = new Promise<void>(resolve => { started = resolve })
    sdk.getHrvData
      .mockImplementationOnce(() => {
        started()
        return new Promise(resolve => { finishOld = resolve })
      })
      .mockResolvedValueOnce({ account: 'current' })
    sdk.getStressData
      .mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401 }))
      .mockResolvedValueOnce({ current: true })

    const pending = client.getHrvData(date)
    await requestStarted
    await client.getStressData(date)
    finishOld({ account: 'old' })
    await expect(pending).resolves.toEqual({ account: 'current' })
    await expect(client.getHrvData(date)).resolves.toEqual({ account: 'current' })
    expect(sdk.getHrvData).toHaveBeenCalledTimes(2)
  })

  it('does not expose even fresh cached recovery data after deactivation', async () => {
    const { client, sdk } = createClient()
    sdk.getRacePredictions.mockResolvedValue({ prediction: 'cached' })
    await client.getRacePredictions()
    client.deactivate()
    await expect(client.getRacePredictions()).rejects.toThrow('authentication changed')
    expect(sdk.getRacePredictions).toHaveBeenCalledTimes(1)
  })

  it('releases a timed-out cache request so a later recovery request can succeed', async () => {
    const { client, sdk } = createClient({ requestTimeoutMs: 10 })
    sdk.getTrainingReadiness
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ready: true })
    await expect(client.getTrainingReadiness(date)).rejects.toThrow('timed out')
    await expect(client.getTrainingReadiness(date)).resolves.toEqual({ ready: true })
    expect(sdk.getTrainingReadiness).toHaveBeenCalledTimes(2)
  })
})
