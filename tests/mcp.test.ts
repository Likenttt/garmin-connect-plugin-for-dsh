import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer, standaloneConfig } from '../src/mcp'

describe('MCP adapter', () => {
  it('exposes the same ten non-secret Garmin tools as the plugin', async () => {
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
      expect(result.tools.map(tool => tool.name)).toEqual([
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
      ])
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

describe('standalone MCP config', () => {
  const original = { ...process.env }

  afterEach(() => {
    process.env = { ...original }
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

  it('requires a password, inline token, or token file after trimming whitespace', () => {
    process.env.GARMIN_USERNAME = 'fixture@example.test'
    process.env.GARMIN_PASSWORD = '   '
    process.env.GARMIN_SESSION_TOKEN = ''
    process.env.GARMIN_SESSION_TOKEN_FILE = '\t'

    expect(() => standaloneConfig()).toThrow(
      'GARMIN_PASSWORD, GARMIN_SESSION_TOKEN, or GARMIN_SESSION_TOKEN_FILE is required',
    )
  })
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
  }
}
