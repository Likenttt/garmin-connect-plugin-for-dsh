import type { Config } from '../src/config'
import { HEALTH_TOOLS } from '../src/health-tools'
import { GarminToolService } from '../src/tool-service'
import { registerTools } from '../src/tools'
import type { GarminToolAccount } from '../src/tools'

interface ToolDefinition {
  name: string
  parameters: {
    additionalProperties: boolean
    properties: Record<string, { pattern?: string; enum?: string[] }>
  }
  execute(args?: unknown): Promise<unknown>
}

const date = '2026-10-07'
const startDate = '2026-10-01'
const endDate = '2026-10-07'
const routes = [
  { name: 'get_garmin_spo2', method: 'getSpO2Data', args: { date }, native: [date] },
  { name: 'get_garmin_respiration', method: 'getRespirationData', args: { date }, native: [date] },
  { name: 'get_garmin_hrv', method: 'getHrvData', args: { date }, native: [date] },
  { name: 'get_garmin_hrv_summaries', method: 'getHrvSummaries', args: { startDate, endDate }, native: [startDate, endDate] },
  { name: 'get_garmin_stress', method: 'getStressData', args: { date }, native: [date] },
  { name: 'get_garmin_stress_summaries', method: 'getStressSummaries', args: { startDate, endDate }, native: [startDate, endDate] },
  { name: 'get_garmin_body_battery', method: 'getBodyBattery', args: { startDate, endDate }, native: [startDate, endDate] },
  { name: 'get_garmin_training_readiness', method: 'getTrainingReadiness', args: { date }, native: [date] },
  { name: 'get_garmin_daily_training_status', method: 'getDailyTrainingStatus', args: { date }, native: [date] },
  { name: 'get_garmin_training_status', method: 'getTrainingStatus', args: { date }, native: [date] },
  { name: 'get_garmin_training_load_balance', method: 'getTrainingLoadBalance', args: { date }, native: [date] },
  { name: 'get_garmin_max_metrics', method: 'getMaxMetrics', args: { date }, native: [date] },
  { name: 'get_garmin_max_metrics_range', method: 'getMaxMetricsRange', args: { startDate, endDate }, native: [startDate, endDate] },
  { name: 'get_garmin_race_predictions', method: 'getRacePredictions', args: {}, native: [] },
  { name: 'get_garmin_race_predictions_range', method: 'getRacePredictionsRange', args: { startDate, endDate, aggregation: 'monthly' }, native: [startDate, endDate, 'monthly'] },
] as const

function clientWith(raw: unknown = { healthy: true }): Record<string, jest.Mock> {
  const client: Record<string, jest.Mock> = {}
  for (const { method } of routes) {
    client[method] = jest.fn(function (this: unknown) {
      expect(this).toBe(client)
      return Promise.resolve(raw)
    })
  }
  return client
}

function account(
  accountId: string,
  client: Record<string, jest.Mock>,
  configured = true,
): GarminToolAccount {
  const config: Config = {
    username: configured ? `${accountId}@example.test` : '',
    region: 'global', cacheTtl: 0, logLevel: 'info',
    activityDetail: 'compact', fitDownloadDir: '',
  }
  return {
    accountId, slot: accountId === 'first' ? 1 : 2,
    region: 'global', client: client as any, configured, config,
  }
}

function registry(accounts: GarminToolAccount[]): Map<string, ToolDefinition> {
  const definitions = new Map<string, ToolDefinition>()
  registerTools({
    tools: { register: (definition: ToolDefinition) => definitions.set(definition.name, definition) },
    logger: { info: jest.fn() },
  } as any, accounts)
  return definitions
}

function expectNoRequests(...clients: Array<Record<string, jest.Mock>>): void {
  for (const client of clients) {
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled()
  }
}

function expectToolError(result: unknown, message: string): void {
  expect(result).toEqual({ error: true, message: expect.stringContaining(message) })
}

describe('DSH recovery and training tools', () => {
  it.each(routes)('routes $name through the real registered execute handler to $method', async (route) => {
    const raw = { source: route.method, nested: { futureField: [0, null, -1] } }
    const client = clientWith(raw)
    const tools = registry([account('first', client)])
    expect(HEALTH_TOOLS.find(tool => tool.name === route.name)?.method).toBe(route.method)

    await expect(tools.get(route.name)!.execute(route.args)).resolves.toBe(raw)

    expect(client[route.method]).toHaveBeenCalledTimes(1)
    expect(client[route.method]).toHaveBeenCalledWith(...route.native)
    for (const { method } of routes) {
      if (method !== route.method) expect(client[method]).not.toHaveBeenCalled()
    }
  })

  it('publishes usable date patterns, strict argument keys, and aggregation choices', () => {
    const tools = registry([account('first', clientWith())])
    for (const route of routes) {
      const schema = tools.get(route.name)!.parameters
      expect(schema.additionalProperties).toBe(false)
      const expectedKeys = route.method === 'getRacePredictionsRange'
        ? ['account', 'startDate', 'endDate', 'aggregation']
        : route.method === 'getRacePredictions' ? ['account']
          : 'date' in route.args ? ['account', 'date'] : ['account', 'startDate', 'endDate']
      expect(Object.keys(schema.properties)).toEqual(expectedKeys)
      for (const [key, property] of Object.entries(schema.properties)) {
        if (key === 'date' || key === 'startDate' || key === 'endDate') {
          expect(new RegExp(property.pattern!).test(date)).toBe(true)
          expect(new RegExp(property.pattern!).test(`${date}T00:00:00Z`)).toBe(false)
        }
      }
    }
    expect(tools.get('get_garmin_race_predictions_range')!.parameters.properties.aggregation.enum)
      .toEqual(['daily', 'monthly'])
  })

  it('isolates every health method between two accounts in the same region', async () => {
    const firstRaw = { accountMarker: 'first' }
    const secondRaw = { accountMarker: 'second' }
    const first = clientWith(firstRaw)
    const second = clientWith(secondRaw)
    const tools = registry([account('first', first), account('second', second)])

    for (const route of routes) {
      const args = Object.freeze({ ...route.args, account: 'second' })
      await expect(tools.get(route.name)!.execute(args)).resolves.toBe(secondRaw)
      expect(first[route.method]).not.toHaveBeenCalled()
      await expect(tools.get(route.name)!.execute({ ...route.args, account: 'first' })).resolves.toBe(firstRaw)
      expect(first[route.method]).toHaveBeenCalledTimes(1)
      expect(second[route.method]).toHaveBeenCalledTimes(1)
    }
  })

  it('requires an exact account when two same-region accounts are configured', async () => {
    const first = clientWith()
    const second = clientWith()
    const tools = registry([account('first', first), account('second', second)])
    for (const route of routes) {
      expectToolError(await tools.get(route.name)!.execute(route.args), 'Set account to an account ID')
      expectToolError(await tools.get(route.name)!.execute({ ...route.args, account: 'global' }), 'Select a specific account ID')
    }
    expectNoRequests(first, second)
  })

  it('defaults only to the configured account and refuses unknown or empty account slots', async () => {
    const first = clientWith({ selected: 'first' })
    const empty = clientWith()
    const tools = registry([account('first', first), account('empty', empty, false)])
    await expect(tools.get('get_garmin_hrv')!.execute({ date })).resolves.toEqual({ selected: 'first' })
    for (const [id, message] of [
      ['empty', 'has no email configured'], ['missing', 'is not configured'], ['Invalid Account', 'valid Garmin account ID'],
    ]) {
      expectToolError(await tools.get('get_garmin_hrv')!.execute({ date, account: id }), message)
    }
    expect(first.getHrvData).toHaveBeenCalledTimes(1)
    expectNoRequests(empty)
    expectToolError(await registry([]).get('get_garmin_hrv')!.execute({ date }), 'No Garmin account is configured')
  })

  it('rejects impossible, non-calendar, and non-string daily dates before the SDK', async () => {
    const client = clientWith()
    const tools = registry([account('first', client)])
    const daily = routes.filter(route => 'date' in route.args)
    for (const route of daily) {
      for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-07T00:00:00Z', ' 2026-10-07', '', null, 0, new Date(0)]) {
        expectToolError(await tools.get(route.name)!.execute({ date: invalid }), 'Invalid date')
      }
    }
    expectNoRequests(client)
  })

  it('rejects invalid or reversed native ranges before making any SDK request', async () => {
    const client = clientWith()
    const tools = registry([account('first', client)])
    for (const route of routes.filter(route => 'startDate' in route.args)) {
      for (const args of [
        { startDate: '2026-02-30', endDate },
        { startDate, endDate: null },
        { startDate: 0, endDate },
        { startDate: endDate, endDate: startDate },
      ]) {
        const message = typeof args.startDate !== 'string' || args.startDate === '2026-02-30'
          ? 'Invalid startDate' : args.endDate === null ? 'Invalid endDate' : 'startDate must not be after endDate'
        expectToolError(await tools.get(route.name)!.execute(args), message)
      }
    }
    expectNoRequests(client)
  })

  it('rejects invalid aggregation and unsupported arguments instead of forwarding them', async () => {
    const client = clientWith()
    const tools = registry([account('first', client)])
    for (const aggregation of ['weekly', '', null, 0]) {
      expectToolError(await tools.get('get_garmin_race_predictions_range')!.execute({ startDate, endDate, aggregation }), 'aggregation must be daily or monthly')
    }
    for (const route of routes) {
      expectToolError(await tools.get(route.name)!.execute({ ...route.args, unexpected: true }), 'Unsupported health metric argument')
    }
    expectToolError(await tools.get('get_garmin_race_predictions')!.execute({ displayName: 'another-user' }), 'Unsupported health metric argument')
    expectToolError(await tools.get('get_garmin_hrv')!.execute({ date, aggregation: 'daily' }), 'Unsupported health metric argument')
    expectNoRequests(client)
  })

  it('defaults daily dates to local today, range end to start, and race aggregation to daily', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 9, 16, 0, 30))
    try {
      const client = clientWith()
      const tools = registry([account('first', client)])
      await tools.get('get_garmin_hrv')!.execute()
      await tools.get('get_garmin_spo2')!.execute()
      await tools.get('get_garmin_respiration')!.execute()
      await tools.get('get_garmin_body_battery')!.execute({ startDate: date })
      await tools.get('get_garmin_stress_summaries')!.execute()
      await tools.get('get_garmin_race_predictions_range')!.execute({ startDate: date })
      await tools.get('get_garmin_race_predictions')!.execute()
      expect(client.getHrvData).toHaveBeenCalledWith('2026-10-16')
      expect(client.getSpO2Data).toHaveBeenCalledWith('2026-10-16')
      expect(client.getRespirationData).toHaveBeenCalledWith('2026-10-16')
      expect(client.getBodyBattery).toHaveBeenCalledWith(date, date)
      expect(client.getStressSummaries).toHaveBeenCalledWith('2026-10-16', '2026-10-16')
      expect(client.getRacePredictionsRange).toHaveBeenCalledWith(date, date, 'daily')
      expect(client.getRacePredictions).toHaveBeenCalledWith()
    } finally {
      jest.useRealTimers()
    }
  })

  it('uses one native request per long range and enforces the 366-day race span boundary', async () => {
    const client = clientWith([])
    const tools = registry([account('first', client)])
    for (const route of routes.filter(route => 'startDate' in route.args)) {
      const race = route.method === 'getRacePredictionsRange'
      const args = { startDate: '2025-01-01', endDate: '2026-01-02', ...(race ? { aggregation: 'monthly' } : {}) }
      await expect(tools.get(route.name)!.execute(args)).resolves.toEqual([])
      expect(client[route.method]).toHaveBeenCalledTimes(1)
      expect(client[route.method]).toHaveBeenCalledWith('2025-01-01', '2026-01-02', ...(race ? ['monthly'] : []))
    }
    expectToolError(await tools.get('get_garmin_race_predictions_range')!.execute({ startDate: '2025-01-01', endDate: '2026-01-03' }), 'more than 366 days')
    expect(client.getRacePredictionsRange).toHaveBeenCalledTimes(1)
  })

  it('preserves complete arrays, device maps, unknown fields, zero, sentinels and null', async () => {
    const readings = Array.from({ length: 3_000 }, (_, index) => [index, index % 2 ? null : 0, -1])
    const fixtures: unknown[] = [
      { hrvReadings: readings, futureField: { unknown: true, zero: 0, absent: null } },
      [{ readiness: 0 }, { readiness: null }, { device: { futureField: readings } }],
      { recordedDevices: [{ deviceId: 'synthetic-a' }, { deviceId: 'synthetic-b' }], metricsTrainingLoadBalanceDTOMap: { a: { load: 0 }, b: { load: null } } },
      [], null, 0, false,
    ]
    for (const raw of fixtures) {
      const client = clientWith(raw)
      const tools = registry([account('first', client)])
      for (const route of routes) await expect(tools.get(route.name)!.execute(route.args)).resolves.toBe(raw)
    }
    expect(readings).toHaveLength(3_000)
  })

  it('explains old SDK incompatibility and sanitizes unexpected upstream failures', async () => {
    const oldTools = registry([account('first', {})])
    for (const route of routes) {
      expectToolError(await oldTools.get(route.name)!.execute(route.args), 'installed Garmin SDK does not support this health metric; update the plugin')
    }
    const client = clientWith()
    client.getHrvData.mockRejectedValue(new Error('Bearer synthetic-secret account=private@example.test'))
    await expect(registry([account('first', client)]).get('get_garmin_hrv')!.execute({ date })).resolves.toEqual({
      error: true, message: 'Failed to fetch Garmin health data',
    })
  })

  it('rejects malformed service arguments and unknown methods without SDK access', async () => {
    const client = clientWith()
    const service = new GarminToolService(client as any, {
      activityDetail: 'full', fitDownloadDir: '', accountUsername: 'synthetic@example.test', accountRegion: 'global',
    })
    for (const args of [null, [], '2026-10-07', 0, false]) {
      await expect(service.getHealthMetric('getHrvData', args as any)).rejects.toThrow('arguments must be an object')
    }
    await expect(service.getHealthMetric('deleteAccount' as any, {})).rejects.toThrow('Unknown Garmin health metric')
    expectNoRequests(client)
  })
})
