import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createWorkspaceMcpServer, parseWorkspaceMcpArguments } from '../src/workspace-mcp'

async function setup() {
  const owner = {
    invokeTool: jest.fn(async (_name: string, _args: Record<string, unknown>): Promise<unknown> => ({ ok: true })),
    openPage: jest.fn(async () => ({ url: 'http://127.0.0.1:64231/' })),
    close: jest.fn(async () => undefined),
  }
  const dependencies = {
    resolveWorkspace: jest.fn(async () => ({ scopeId: 'profile-a', dataDirectory: '/private/tmp/garmin-workspace-test' })),
    connectWorkspace: jest.fn(async () => owner),
  }
  const server = createWorkspaceMcpServer({ scopeId: 'profile-a' }, dependencies)
  const client = new Client({ name: 'test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server, owner, dependencies, close: async () => { await server.close(); await client.close() } }
}
function body(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ text: string }>
  return JSON.parse(content[0].text)
}

describe('shared workspace MCP adapter', () => {
  it('advertises all existing tools without starting the workspace and forwards account selection', async () => {
    const test = await setup()
    try {
      const tools = await test.client.listTools()
      expect(tools.tools).toHaveLength(31)
      expect(test.client.getInstructions()).toContain('set accountId on account-data tools')
      expect(test.client.getInstructions()).not.toContain('This MCP process is bound to one configured Garmin account')
      expect(test.dependencies.resolveWorkspace).not.toHaveBeenCalled()
      expect(tools.tools.find(tool => tool.name === 'get_garmin_profile')?.inputSchema.properties).toHaveProperty('accountId')
      await test.client.callTool({ name: 'get_garmin_profile', arguments: { accountId: 'account-a' } })
      expect(test.owner.invokeTool).toHaveBeenCalledWith('get_garmin_profile', { account: 'account-a' })
      expect(test.dependencies.resolveWorkspace).toHaveBeenCalledWith({ scopeId: 'profile-a' })
      expect(test.owner.openPage).not.toHaveBeenCalled()
      await test.client.callTool({ name: 'get_garmin_activities', arguments: { accountId: 'account-b', limit: 3 } })
      expect(test.owner.invokeTool).toHaveBeenLastCalledWith('get_garmin_activities', { account: 'account-b', limit: 3 })
      expect(test.dependencies.connectWorkspace).toHaveBeenCalledTimes(1)
    } finally { await test.close() }
    expect(test.owner.close).toHaveBeenCalledTimes(1)
  })

  it('keeps ambiguous-account errors visible and sends MFA back to the account page', async () => {
    const test = await setup()
    try {
      test.owner.invokeTool.mockResolvedValueOnce({ error: true, message: 'Multiple accounts; use list_garmin_accounts and set account.' })
      const ambiguous = await test.client.callTool({ name: 'get_garmin_profile' })
      expect(ambiguous.isError).toBe(true)
      expect(body(ambiguous).message).toContain('Multiple accounts')
      expect(test.owner.invokeTool).toHaveBeenCalledWith('get_garmin_profile', {})
      test.owner.invokeTool.mockResolvedValueOnce({ error: true, message: 'Garmin session expired' })
      const authentication = await test.client.callTool({ name: 'get_garmin_profile', arguments: { accountId: 'account-a' } })
      expect(authentication.isError).toBe(true)
      expect(body(authentication).message).toContain('open_garmin_workspace')
    } finally { await test.close() }
  })

  it('preserves account-bound write preview/confirmation arguments and rejects invalid selectors', async () => {
    const test = await setup()
    try {
      const args = { accountId: 'account-b', workoutId: '123', date: '2026-11-05', confirmed: true, confirmationId: '65d408ac-ce60-4a9a-85d9-c972930247b5' }
      await test.client.callTool({ name: 'schedule_garmin_workout', arguments: args })
      const { accountId, ...rest } = args
      expect(test.owner.invokeTool).toHaveBeenCalledWith('schedule_garmin_workout', { ...rest, account: accountId })
      const invalid = await test.client.callTool({ name: 'get_garmin_profile', arguments: { accountId: '../wrong-account' } })
      expect(invalid.isError).toBe(true)
      expect(test.owner.invokeTool).toHaveBeenCalledTimes(1)
    } finally { await test.close() }
  })

  it('lists accounts without opening a browser and opens the page only on explicit tool calls', async () => {
    const test = await setup()
    try {
      test.owner.invokeTool.mockResolvedValueOnce({ accounts: [{ accountId: 'account-a', alias: '备注' }], total: 1 })
      expect(body(await test.client.callTool({ name: 'list_garmin_accounts' }))).toMatchObject({ total: 1 })
      expect(test.owner.invokeTool).toHaveBeenCalledWith('list_garmin_accounts', {})
      expect(test.owner.openPage).not.toHaveBeenCalled()
      expect(body(await test.client.callTool({ name: 'open_garmin_workspace' }))).toHaveProperty('url')
      expect(test.owner.openPage).toHaveBeenCalledTimes(1)
    } finally { await test.close() }
  })
})

describe('workspace CLI arguments', () => {
  it('keeps legacy mode as the default and supports explicit shared profile selection', () => {
    expect(parseWorkspaceMcpArguments([])).toEqual({ workspace: false, help: false, options: {} })
    expect(parseWorkspaceMcpArguments(['--workspace'])).toEqual({ workspace: true, help: false, options: {} })
    expect(parseWorkspaceMcpArguments(['--workspace', 'profile-a', '--data-directory', '/tmp/workspace']).options)
      .toEqual({ scopeId: 'profile-a', dataDirectory: '/tmp/workspace' })
    expect(parseWorkspaceMcpArguments(['--workspace=profile-a']).options.scopeId).toBe('profile-a')
    expect(parseWorkspaceMcpArguments(['--help']).help).toBe(true)
    expect(() => parseWorkspaceMcpArguments(['--data-directory', '/tmp/workspace'])).toThrow('--workspace')
    expect(() => parseWorkspaceMcpArguments(['--workspace', '--data-directory'])).toThrow('requires one directory')
  })
})
