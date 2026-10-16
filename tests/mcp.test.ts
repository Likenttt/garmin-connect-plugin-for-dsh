import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer, standaloneConfig } from '../src/mcp'
import { GarminAuthenticationRequiredError, PublicToolError } from '../src/utils/errors'

const healthRoutes = [
  { name: 'get_garmin_hrv', method: 'getHrvData', args: { date: '2026-10-07' } },
  { name: 'get_garmin_hrv_summaries', method: 'getHrvSummaries', args: { startDate: '2026-10-01', endDate: '2026-10-07' } },
  { name: 'get_garmin_stress', method: 'getStressData', args: { date: '2026-10-07' } },
  { name: 'get_garmin_stress_summaries', method: 'getStressSummaries', args: { startDate: '2026-10-01', endDate: '2026-10-07' } },
  { name: 'get_garmin_body_battery', method: 'getBodyBattery', args: { startDate: '2026-10-01', endDate: '2026-10-07' } },
  { name: 'get_garmin_training_readiness', method: 'getTrainingReadiness', args: { date: '2026-10-07' } },
  { name: 'get_garmin_daily_training_status', method: 'getDailyTrainingStatus', args: { date: '2026-10-07' } },
  { name: 'get_garmin_training_status', method: 'getTrainingStatus', args: { date: '2026-10-07' } },
  { name: 'get_garmin_training_load_balance', method: 'getTrainingLoadBalance', args: { date: '2026-10-07' } },
  { name: 'get_garmin_max_metrics', method: 'getMaxMetrics', args: { date: '2026-10-07' } },
  { name: 'get_garmin_max_metrics_range', method: 'getMaxMetricsRange', args: { startDate: '2026-10-01', endDate: '2026-10-07' } },
  { name: 'get_garmin_race_predictions', method: 'getRacePredictions', args: {} },
  { name: 'get_garmin_race_predictions_range', method: 'getRacePredictionsRange', args: { startDate: '2026-10-01', endDate: '2026-10-07', aggregation: 'monthly' } },
] as const

describe('MCP adapter', () => {
  it('exposes the same twenty-three non-secret Garmin tools as the plugin', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      expect(client.getServerVersion()?.version).toBe(
        (require('../package.json') as { version: string }).version,
      )
      const result = await client.listTools()
      expect(result.tools.map(tool => tool.name).sort()).toEqual([
        'get_garmin_activities',
        'get_garmin_sleep',
        'get_garmin_steps',
        'get_garmin_heart_rate',
        'get_garmin_weight',
        'get_garmin_workouts',
        'get_garmin_profile',
        'get_running_skill_advice',
        'create_garmin_workout',
        'download_garmin_activity_fit',
        'get_garmin_hrv',
        'get_garmin_hrv_summaries',
        'get_garmin_stress',
        'get_garmin_stress_summaries',
        'get_garmin_body_battery',
        'get_garmin_training_readiness',
        'get_garmin_daily_training_status',
        'get_garmin_training_status',
        'get_garmin_training_load_balance',
        'get_garmin_max_metrics',
        'get_garmin_max_metrics_range',
        'get_garmin_race_predictions',
        'get_garmin_race_predictions_range',
      ].sort())
      const createWorkout = result.tools.find(tool => tool.name === 'create_garmin_workout')!
      expect(createWorkout.description).toContain('does not generate a training plan')
      expect(createWorkout.description).toContain('mode=personalized')
      expect(createWorkout.inputSchema).toMatchObject({
        type: 'object',
        properties: expect.objectContaining({
          name: expect.any(Object),
          steps: expect.any(Object),
          confirmed: expect.any(Object),
          confirmationId: expect.any(Object),
        }),
        required: expect.arrayContaining(['name', 'steps']),
      })
      expect(createWorkout.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      })

      const downloadFit = result.tools.find(
        tool => tool.name === 'download_garmin_activity_fit',
      )!
      expect(downloadFit.description).toContain('GARMIN_FIT_DOWNLOAD_DIR')
      expect(downloadFit.description).toContain('GARMIN_FIT_<region>_<account-email>')
      expect(downloadFit.description).toContain('parent directory')
      expect(downloadFit.inputSchema).toMatchObject({
        type: 'object',
        required: ['activityId'],
        additionalProperties: false,
        properties: {
          activityId: expect.any(Object),
        },
      })
      expect(downloadFit.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      })

      const runningAdvice = result.tools.find(
        tool => tool.name === 'get_running_skill_advice',
      )!
      expect(runningAdvice.description).toContain('personalized')
      expect(runningAdvice.description).toContain('Hansons')
      expect(runningAdvice.description).toContain('Jack Daniels')
      expect(runningAdvice.description).toContain('Norwegian')
      expect(runningAdvice.description).toContain('polarized')
      expect(runningAdvice.inputSchema).toMatchObject({
        type: 'object',
        required: ['mode'],
        additionalProperties: false,
        properties: expect.objectContaining({
          mode: expect.objectContaining({
            type: 'string',
            enum: ['explain', 'personalized'],
          }),
          language: expect.objectContaining({ type: 'string', enum: ['zh-CN', 'en'] }),
          goal: expect.objectContaining({
            type: 'string',
            minLength: 4,
            maxLength: 500,
            description: expect.stringContaining('event'),
          }),
          currentPerformance: expect.objectContaining({ type: 'string', minLength: 4, maxLength: 500 }),
          performanceBasis: expect.objectContaining({
            type: 'string',
            enum: ['recent_race', 'time_trial', 'no_recent_benchmark'],
          }),
          trainingBackground: expect.objectContaining({ type: 'string', minLength: 8, maxLength: 1000 }),
          availability: expect.objectContaining({ type: 'string', minLength: 4, maxLength: 750 }),
          healthConstraints: expect.objectContaining({ type: 'string', minLength: 2, maxLength: 750 }),
          hasWarningSymptoms: expect.objectContaining({
            type: 'boolean',
            description: expect.stringContaining('stops'),
          }),
          trainingPreference: expect.objectContaining({
            type: 'string',
            enum: ['steady', 'hard_easy', 'mixed'],
          }),
          maxQualitySessionsPerWeek: expect.objectContaining({
            type: 'integer',
            minimum: 0,
            maximum: 7,
          }),
          intensityGuidancePreference: expect.objectContaining({
            type: 'string',
            enum: ['pace', 'heart_rate', 'rpe', 'mixed'],
            description: expect.stringContaining('intensity'),
          }),
        }),
      })
      expect(result.tools
        .filter(tool => ![
          'create_garmin_workout',
          'download_garmin_activity_fit',
        ].includes(tool.name))
        .every(tool => tool.annotations?.readOnlyHint === true)).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('passes workout confirmation through the shared service', async () => {
    const service = serviceStub()
    service.createWorkout.mockResolvedValue({
      requiresConfirmation: true,
      workoutName: 'Easy Run',
    })
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const result = await client.callTool({
        name: 'create_garmin_workout',
        arguments: {
          name: 'Easy Run',
          steps: [{ type: 'warmup', endCondition: 'time', endValue: 600 }],
        },
      })

      expect(service.createWorkout).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Easy Run',
      }))
      expect(result.isError).not.toBe(true)
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
      ]))
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('strictly validates activityId before invoking the FIT download service', async () => {
    const service = serviceStub()
    service.downloadActivityFit.mockResolvedValue({
      success: true,
      activityId: 42,
      fileName: '42.fit',
      sizeBytes: 14,
      sha256: 'a'.repeat(64),
    })
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      for (const args of [
        { activityId: 0 },
        { activityId: 1.5 },
        { activityId: Number.MAX_SAFE_INTEGER + 1 },
        { activityId: 42, unexpected: true },
      ]) {
        const invalid = await client.callTool({
          name: 'download_garmin_activity_fit',
          arguments: args,
        })
        expect(invalid.isError).toBe(true)
      }
      expect(service.downloadActivityFit).not.toHaveBeenCalled()

      const result = await client.callTool({
        name: 'download_garmin_activity_fit',
        arguments: { activityId: 42 },
      })
      expect(result.isError).not.toBe(true)
      expect(service.downloadActivityFit).toHaveBeenCalledWith({ activityId: 42 })
      expect(JSON.stringify(result.content)).not.toContain('binary')
      expect(JSON.stringify(result.content)).not.toContain('runner@example.com')
      expect(JSON.stringify(result.content)).not.toContain('/private/downloads')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('returns a generic MCP error instead of upstream secrets or response data', async () => {
    const service = serviceStub()
    service.getProfile.mockRejectedValue(new Error(
      'Authorization: Bearer secret-token private@example.test',
    ))
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const result = await client.callTool({ name: 'get_garmin_profile', arguments: {} })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('Garmin request failed')
      expect(JSON.stringify(result.content)).not.toContain('secret-token')
      expect(JSON.stringify(result.content)).not.toContain('private@example.test')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('passes URL authentication elicitation through and never replays the tool', async () => {
    const service = serviceStub()
    service.getProfile.mockRejectedValue(
      new GarminAuthenticationRequiredError('missing'),
    )
    const requireAuthentication = jest.fn(async () => {
      throw new UrlElicitationRequiredError([{
        mode: 'url',
        message: 'Open Garmin authentication',
        url: 'http://127.0.0.1:54321/garmin-auth/bridge/' + 'a'.repeat(64),
        elicitationId: 'auth-id-1',
      }])
    })
    const server = createMcpServer(service as any, {
      createAuthentication: () => ({ requireAuthentication }),
    })
    const client = new Client(
      { name: 'url-elicitation-client', version: '1.0.0' },
      { capabilities: { elicitation: { url: {} } } },
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const operation = client.callTool({
        name: 'get_garmin_profile',
        arguments: {},
      })
      await expect(operation).rejects.toBeInstanceOf(UrlElicitationRequiredError)
      await expect(operation).rejects.toMatchObject({
        elicitations: [expect.objectContaining({ elicitationId: 'auth-id-1' })],
      })
      expect(requireAuthentication).toHaveBeenCalledTimes(1)
      expect(service.getProfile).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('closes authentication exactly once through the server lifecycle', async () => {
    const service = serviceStub()
    const closeAuthentication = jest.fn().mockResolvedValue(undefined)
    const server = createMcpServer(service as any, {
      createAuthentication: () => ({
        requireAuthentication: jest.fn(),
        close: closeAuthentication,
      }),
    })
    const client = new Client({ name: 'lifecycle-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    await client.close()
    await server.close()

    expect(closeAuthentication).toHaveBeenCalledTimes(1)
  })

  it('accepts omitted arguments for zero-argument and all-optional read tools', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const profile = await client.callTool({ name: 'get_garmin_profile' })
      const activities = await client.callTool({ name: 'get_garmin_activities' })

      expect(profile.isError).not.toBe(true)
      expect(activities.isError).not.toBe(true)
      expect(service.getProfile).toHaveBeenCalled()
      expect(service.getActivities).toHaveBeenCalledWith({})
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('requires an explicit running-advice mode before invoking the service', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const missingMode = await client.callTool({
        name: 'get_running_skill_advice',
        arguments: { query: 'threshold' },
      })
      expect(missingMode.isError).toBe(true)
      expect(service.getRunningAdvice).not.toHaveBeenCalled()

      const valid = await client.callTool({
        name: 'get_running_skill_advice',
        arguments: { mode: 'personalized', language: 'zh-CN' },
      })
      expect(valid.isError).not.toBe(true)
      expect(service.getRunningAdvice).toHaveBeenCalledWith({
        mode: 'personalized',
        language: 'zh-CN',
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('rejects unexpected profile arguments while still allowing omission', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const result = await client.callTool({
        name: 'get_garmin_profile',
        arguments: { unexpected: 'value' },
      })
      expect(result.isError).toBe(true)
      expect(service.getProfile).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('rejects nested repeat groups at the MCP schema boundary', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const result = await client.callTool({
        name: 'create_garmin_workout',
        arguments: {
          name: 'Nested repeats',
          steps: [{
            type: 'repeat',
            iterations: 2,
            steps: [{ type: 'repeat', iterations: 2, steps: [] }],
          }],
        },
      })

      expect(result.isError).toBe(true)
      expect(service.createWorkout).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('MCP recovery and training tools', () => {
  it.each(healthRoutes)('routes $name to $method without compressing the response', async route => {
    const service = serviceStub()
    const response = { devices: [{ values: [0, null, 42], extra: { preserved: true } }], empty: [] }
    service.getHealthMetric.mockResolvedValue(response)

    await withMcpClient(service, async client => {
      const result = await client.callTool({ name: route.name, arguments: route.args })

      expect(result.isError).not.toBe(true)
      expect(service.getHealthMetric).toHaveBeenCalledTimes(1)
      expect(service.getHealthMetric).toHaveBeenCalledWith(route.method, route.args)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(response, null, 2) }])
    })
  })

  it('advertises strict optional schemas without the old thirty-day fanout limit', async () => {
    await withMcpClient(serviceStub(), async client => {
      const { tools } = await client.listTools()

      for (const route of healthRoutes) {
        const tool = tools.find(item => item.name === route.name)!
        expect(tool.inputSchema.type).toBe('object')
        expect(tool.inputSchema.additionalProperties).toBe(false)
        expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(route.args).sort())
        expect(tool.inputSchema.required ?? []).toEqual([])
        expect(JSON.stringify(tool.inputSchema)).not.toContain('30 days')
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        })
      }
      const raceRange = tools.find(tool => tool.name === 'get_garmin_race_predictions_range')!
      expect(raceRange.inputSchema.properties?.aggregation).toMatchObject({
        type: 'string',
        enum: ['daily', 'monthly'],
      })
    })
  })

  it('passes omitted arguments unchanged to the service for every new tool', async () => {
    const service = serviceStub()
    await withMcpClient(service, async client => {
      for (const route of healthRoutes) {
        const result = await client.callTool({ name: route.name })
        expect(result.isError).not.toBe(true)
        expect(service.getHealthMetric).toHaveBeenLastCalledWith(route.method, {})
      }
      expect(service.getHealthMetric).toHaveBeenCalledTimes(13)
    })
  })

  it('rejects displayName, unknown keys, invalid date formats and unsupported aggregations before the service', async () => {
    const service = serviceStub()
    await withMcpClient(service, async client => {
      for (const route of healthRoutes) {
        for (const extra of [{ displayName: 'another-account' }, { unexpected: true }]) {
          const result = await client.callTool({
            name: route.name,
            arguments: { ...route.args, ...extra },
          })
          expect(result.isError).toBe(true)
        }
      }

      for (const request of [
        { name: 'get_garmin_hrv', arguments: { date: '2026-10-07T00:00:00Z' } },
        { name: 'get_garmin_stress', arguments: { date: 20261007 } },
        { name: 'get_garmin_hrv_summaries', arguments: { startDate: '2026-1-01' } },
        { name: 'get_garmin_body_battery', arguments: { endDate: null } },
        { name: 'get_garmin_race_predictions', arguments: { date: '2026-10-07' } },
        { name: 'get_garmin_race_predictions_range', arguments: { aggregation: 'weekly' } },
        { name: 'get_garmin_max_metrics_range', arguments: { aggregation: 'daily' } },
      ]) {
        const result = await client.callTool(request)
        expect(result.isError).toBe(true)
      }
      expect(service.getHealthMetric).not.toHaveBeenCalled()
    })
  })

  it('preserves service calendar validation messages and hides upstream secrets', async () => {
    const service = serviceStub()
    service.getHealthMetric
      .mockRejectedValueOnce(new PublicToolError('startDate must not be after endDate'))
      .mockRejectedValueOnce(new Error('Bearer secret-token private@example.test'))

    await withMcpClient(service, async client => {
      const invalid = await client.callTool({
        name: 'get_garmin_hrv_summaries',
        arguments: { startDate: '2026-10-07', endDate: '2026-10-01' },
      })
      expect(invalid.isError).toBe(true)
      expect(JSON.stringify(invalid.content)).toContain('startDate must not be after endDate')

      const upstream = await client.callTool({ name: 'get_garmin_hrv' })
      expect(upstream.isError).toBe(true)
      expect(JSON.stringify(upstream.content)).toContain('Garmin request failed')
      expect(JSON.stringify(upstream.content)).not.toContain('secret-token')
      expect(JSON.stringify(upstream.content)).not.toContain('private@example.test')
      expect(service.getHealthMetric).toHaveBeenCalledTimes(2)
    })
  })

  it('elicits authentication for a new metric without replaying the read', async () => {
    const service = serviceStub()
    service.getHealthMetric.mockRejectedValue(new GarminAuthenticationRequiredError('missing'))
    const requireAuthentication = jest.fn(async () => {
      throw new UrlElicitationRequiredError([{
        mode: 'url',
        message: 'Open Garmin authentication',
        url: 'http://127.0.0.1:54321/garmin-auth/bridge/' + 'a'.repeat(64),
        elicitationId: 'metric-auth-id',
      }])
    })

    await withMcpClient(service, async client => {
      await expect(client.callTool({ name: 'get_garmin_hrv' }))
        .rejects.toBeInstanceOf(UrlElicitationRequiredError)
      expect(requireAuthentication).toHaveBeenCalledTimes(1)
      expect(service.getHealthMetric).toHaveBeenCalledTimes(1)
    }, { createAuthentication: () => ({ requireAuthentication }) })
  })
})

describe('standalone MCP config', () => {
  const original = { ...process.env }

  afterEach(() => {
    process.env = { ...original }
  })

  it('defaults activity detail to full and honors a compact environment override', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    delete process.env.GARMIN_ACTIVITY_DETAIL
    expect(standaloneConfig().activityDetail).toBe('full')

    process.env.GARMIN_ACTIVITY_DETAIL = 'compact'
    expect(standaloneConfig().activityDetail).toBe('compact')
  })

  it('honors allow-listed GARMIN_LOG_LEVEL values and rejects unknown ones', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_PASSWORD = 'fixture-password'
    process.env.GARMIN_LOG_LEVEL = 'warn'
    expect(standaloneConfig().logLevel).toBe('warn')

    process.env.GARMIN_LOG_LEVEL = 'verbose'
    expect(standaloneConfig().logLevel).toBe('info')
  })

  it('does not choose a FIT download directory unless explicitly configured', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_PASSWORD = 'fixture-password'
    delete process.env.GARMIN_FIT_DOWNLOAD_DIR

    expect(standaloneConfig().fitDownloadDir).toBe('')
  })

  it('accepts a session-token file as the only configured credential', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    delete process.env.GARMIN_PASSWORD
    delete process.env.GARMIN_SESSION_TOKEN
    process.env.GARMIN_SESSION_TOKEN_FILE = '/private/session-token.json'
    process.env.GARMIN_FIT_DOWNLOAD_DIR = '/private/garmin-fit-downloads'

    expect(standaloneConfig()).toMatchObject({
      username: 'fixture@example.test',
      password: undefined,
      sessionToken: undefined,
      sessionTokenFile: '/private/session-token.json',
      fitDownloadDir: '/private/garmin-fit-downloads',
    })
  })

  it('starts without a password and assigns the default account session path', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_PASSWORD = '   '
    process.env.GARMIN_SESSION_TOKEN = ''
    process.env.GARMIN_SESSION_TOKEN_FILE = '\t'
    process.env.GARMIN_ACCOUNT = 'default'
    process.env.XDG_CONFIG_HOME = '/private/config'

    expect(standaloneConfig()).toMatchObject({
      username: 'fixture@example.test',
      password: '   ',
      sessionToken: '',
      sessionTokenFile:
        '/private/config/dsh-plugin-garmin-connect/accounts/default.session.json',
    })
  })

  it('isolates the implicit MCP session by account alias', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    delete process.env.GARMIN_PASSWORD
    delete process.env.GARMIN_SESSION_TOKEN
    delete process.env.GARMIN_SESSION_TOKEN_FILE
    process.env.GARMIN_ACCOUNT = 'international'
    process.env.XDG_CONFIG_HOME = '/private/config'

    expect(standaloneConfig().sessionTokenFile).toBe(
      '/private/config/dsh-plugin-garmin-connect/accounts/international.session.json',
    )
  })

  it('rejects an MCP account alias that could escape the account directory', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_ACCOUNT = '../other-user'
    delete process.env.GARMIN_SESSION_TOKEN_FILE

    expect(() => standaloneConfig()).toThrow('Invalid account alias')
  })

  it.each(['CN', 'cn ', 'mars', ''])(
    'rejects an explicitly invalid GARMIN_REGION value (%j)',
    region => {
      process.env.GARMIN_USERNAME = 'fixture@example.test'
      process.env.GARMIN_REGION = region

      expect(() => standaloneConfig()).toThrow(
        'GARMIN_REGION must be exactly global or cn',
      )
    },
  )
})

function serviceStub() {
  return {
    getActivities: jest.fn().mockResolvedValue([]),
    getSleep: jest.fn().mockResolvedValue({}),
    getSteps: jest.fn().mockResolvedValue({}),
    getHeartRate: jest.fn().mockResolvedValue({}),
    getWeight: jest.fn().mockResolvedValue({}),
    getWorkouts: jest.fn().mockResolvedValue([]),
    getProfile: jest.fn().mockResolvedValue({}),
    getRunningAdvice: jest.fn().mockResolvedValue({}),
    createWorkout: jest.fn().mockResolvedValue({}),
    downloadActivityFit: jest.fn().mockResolvedValue({}),
    getHealthMetric: jest.fn().mockResolvedValue({}),
  }
}

async function withMcpClient(
  service: ReturnType<typeof serviceStub>,
  action: (client: Client) => Promise<void>,
  options?: Parameters<typeof createMcpServer>[1],
): Promise<void> {
  const server = createMcpServer(service as any, options)
  const client = new Client(
    { name: 'metric-client', version: '1.0.0' },
    { capabilities: { elicitation: { url: {} } } },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    await action(client)
  } finally {
    await client.close()
    await server.close()
  }
}
