import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer, standaloneConfig } from '../src/mcp'

describe('MCP adapter', () => {
  it('exposes the same nine non-secret Garmin tools as the plugin', async () => {
    const service = serviceStub()
    const server = createMcpServer(service as any)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
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
      ])
      const createWorkout = result.tools.find(tool => tool.name === 'create_garmin_workout')!
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
      expect(result.tools
        .filter(tool => tool.name !== 'create_garmin_workout')
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
  }
}
