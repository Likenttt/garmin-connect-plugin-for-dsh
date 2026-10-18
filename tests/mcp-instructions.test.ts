import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp'

describe('MCP connection instructions', () => {
  it('delivers account and HRV guidance in the initialization handshake', async () => {
    await withClient(async client => {
      expect(client.getServerVersion()).toEqual({
        name: 'garmin-connect',
        version: (require('../package.json') as { version: string }).version,
      })
      expect(client.getInstructions()).toEqual(expect.stringContaining('get_garmin_profile'))
      expect(client.getInstructions()).toEqual(expect.stringContaining('get_garmin_hrv_summaries'))
      expect(client.getInstructions()).toEqual(expect.stringContaining('get_garmin_hrv'))
    })
  })

  it('keeps initialization and tool discovery passive', async () => {
    await withClient(async (client, service) => {
      const { tools } = await client.listTools()
      expect(tools.length).toBeGreaterThan(0)
      for (const method of Object.values(service)) {
        expect(method).not.toHaveBeenCalled()
      }
    })
  })

  it('references registered tools without inventing an automatic upgrade tool', async () => {
    await withClient(async client => {
      const instructions = client.getInstructions() ?? ''
      const referencedTools = [...new Set(
        instructions.match(/\b(?:get|create|download)_[a-z0-9_]+\b/g) ?? [],
      )]
      const { tools } = await client.listTools()
      const toolNames = tools.map(tool => tool.name)
      expect(referencedTools.length).toBeGreaterThan(0)
      for (const name of referencedTools) {
        expect(toolNames).toContain(name)
      }
      expect(toolNames.some(name => /(?:upgrade|update)/i.test(name))).toBe(false)
      expect(instructions).toMatch(/null.*\[\]/)
      expect(instructions).toMatch(/(?:cannot|does not) guarantee.*HRV/i)
    })
  })
})

function serviceStub() {
  return {
    getActivities: jest.fn(),
    getSleep: jest.fn(),
    getSteps: jest.fn(),
    getHeartRate: jest.fn(),
    getWeight: jest.fn(),
    getWorkouts: jest.fn(),
    getProfile: jest.fn(),
    getRunningAdvice: jest.fn(),
    createWorkout: jest.fn(),
    downloadActivityFit: jest.fn(),
    getHealthMetric: jest.fn(),
  }
}

async function withClient(
  action: (client: Client, service: ReturnType<typeof serviceStub>) => Promise<void>,
): Promise<void> {
  const service = serviceStub()
  const server = createMcpServer(service)
  const client = new Client({ name: 'instructions-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    await action(client, service)
  } finally {
    await client.close()
    await server.close()
  }
}
