import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp'
import { GarminToolService } from '../src/tool-service'

const removalRoutes = [
  { name: 'delete_garmin_workout', method: 'deleteWorkout', id: 'workoutId' },
  { name: 'unschedule_garmin_workout', method: 'unscheduleWorkout', id: 'scheduleId' },
] as const

async function withMcp(service: unknown, action: (client: Client) => Promise<void>): Promise<void> {
  const server = createMcpServer(service as any)
  const client = new Client({ name: 'workout-management-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    await action(client)
  } finally {
    await client.close()
    await server.close()
  }
}

function serviceStub() {
  return {
    getScheduledWorkouts: jest.fn().mockResolvedValue([]),
    deleteWorkout: jest.fn().mockResolvedValue({ requiresConfirmation: true }),
    unscheduleWorkout: jest.fn().mockResolvedValue({ requiresConfirmation: true }),
  }
}

function resultValue(result: any): Record<string, any> {
  return JSON.parse(result.content[0].text)
}

describe('MCP workout management', () => {
  it('discovers strict read and destructive tools without performing any operation', async () => {
    const service = serviceStub()
    await withMcp(service, async client => {
      const { tools } = await client.listTools()
      const scheduled = tools.find(tool => tool.name === 'get_garmin_scheduled_workouts')!
      expect(scheduled.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(scheduled.inputSchema.additionalProperties).toBe(false)
      expect(scheduled.inputSchema.required ?? []).toEqual([])

      for (const route of removalRoutes) {
        const tool = tools.find(item => item.name === route.name)!
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false, destructiveHint: true, idempotentHint: false,
        })
        expect(tool.inputSchema).toMatchObject({ required: [route.id], additionalProperties: false })
        expect(tool.inputSchema.properties).not.toHaveProperty('account')
        expect(tool.description).toContain('explicit approval')
        expect(tool.description).toContain('automatically retry')
      }
      for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
    })
  })

  it('passes omitted dates and an inclusive range unchanged while retaining schedule details', async () => {
    const service = serviceStub()
    const response = [{ scheduleId: '9007199254740993', date: '2026-10-18', workout: { name: 'Easy', extra: [null, 0] } }]
    service.getScheduledWorkouts.mockResolvedValue(response)
    await withMcp(service, async client => {
      await client.callTool({ name: 'get_garmin_scheduled_workouts' })
      expect(service.getScheduledWorkouts).toHaveBeenLastCalledWith({})
      const args = { startDate: '2026-10-18', endDate: '2026-11-17' }
      const result = await client.callTool({ name: 'get_garmin_scheduled_workouts', arguments: args })
      expect(service.getScheduledWorkouts).toHaveBeenLastCalledWith(args)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(response, null, 2) }])

      for (const invalid of [{ account: 'other' }, { startDate: '2026-1-01' }, { unexpected: true }]) {
        const rejected = await client.callTool({ name: 'get_garmin_scheduled_workouts', arguments: invalid })
        expect(rejected.isError).toBe(true)
      }
      expect(service.getScheduledWorkouts).toHaveBeenCalledTimes(2)
    })
  })

  it.each(removalRoutes)('keeps $id precise and rejects unsafe or unknown input before $method', async route => {
    const service = serviceStub()
    await withMcp(service, async client => {
      for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', '01', '1/2', '1e3', '42\n', '9'.repeat(33)]) {
        const result = await client.callTool({ name: route.name, arguments: { [route.id]: id } })
        expect(result.isError).toBe(true)
      }
      for (const extra of [{ account: 'other' }, { unexpected: true }, { confirmed: 'true' }, { confirmationId: 'not-a-uuid' }]) {
        const result = await client.callTool({ name: route.name, arguments: { [route.id]: '42', ...extra } })
        expect(result.isError).toBe(true)
      }
      expect(service[route.method]).not.toHaveBeenCalled()

      const args = {
        [route.id]: '9007199254740993',
        confirmed: true,
        confirmationId: '90c4d0ef-f0a3-4ea0-b189-60fe9b29b312',
      }
      const result = await client.callTool({ name: route.name, arguments: args })
      expect(result.isError).not.toBe(true)
      expect(service[route.method]).toHaveBeenCalledTimes(1)
      expect(service[route.method]).toHaveBeenCalledWith(args)
    })
  })

  it.each(removalRoutes)('previews $name without writing and executes its approved target only once', async route => {
    const backend = {
      getWorkoutDetail: jest.fn().mockResolvedValue({ workoutId: '42', workoutName: 'Easy' }),
      getScheduledWorkout: jest.fn().mockResolvedValue({ scheduleId: '42', workoutId: '7', date: '2026-10-18', workoutName: 'Easy' }),
      deleteWorkout: jest.fn().mockResolvedValue(undefined),
      unscheduleWorkout: jest.fn().mockResolvedValue(undefined),
    }
    const service = new GarminToolService(backend as any, {
      accountId: 'athlete',
      activityDetail: 'full', fitDownloadDir: '',
      accountUsername: 'fixture@example.test', accountRegion: 'cn',
    })
    await withMcp(service, async client => {
      const preview = await client.callTool({ name: route.name, arguments: { [route.id]: '42' } })
      expect(preview.isError).not.toBe(true)
      const value = resultValue(preview)
      expect(value.requiresConfirmation).toBe(true)
      expect(value.preview).toMatchObject({ accountId: 'athlete', [route.id]: '42', workoutName: 'Easy' })
      expect(backend.deleteWorkout).not.toHaveBeenCalled()
      expect(backend.unscheduleWorkout).not.toHaveBeenCalled()

      const args = { [route.id]: '42', confirmed: true, confirmationId: value.confirmationId }
      const approved = await client.callTool({ name: route.name, arguments: args })
      expect(approved.isError).not.toBe(true)
      expect(resultValue(approved).success).toBe(true)
      expect(backend[route.method]).toHaveBeenCalledTimes(1)
      expect(backend[route.method]).toHaveBeenCalledWith('42')
      const other = route.method === 'deleteWorkout' ? 'unscheduleWorkout' : 'deleteWorkout'
      expect(backend[other]).not.toHaveBeenCalled()

      const replay = await client.callTool({ name: route.name, arguments: args })
      expect(replay.isError).toBe(true)
      expect(backend[route.method]).toHaveBeenCalledTimes(1)
    })
  })
})
