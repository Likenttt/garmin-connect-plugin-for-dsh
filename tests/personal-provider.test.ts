import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Config } from '../src/config'
import { GarminPersonalClient } from '../src/personal-client'
import { GarminPersonalApiClient, PersonalApiError } from '../src/vendor/connect-personal-api/index'
import { GarminToolService } from '../src/tool-service'
import { createMcpServer, standaloneAccountAlias, standaloneConfig } from '../src/mcp'
import { PERSONAL_TOOL_NAMES } from '../src/personal-capabilities'
import { registerTools } from '../src/tools'

const config: Config = {
  provider: 'personal', username: '', personalApiKey: 'test-key-not-real', region: 'cn',
  cacheTtl: 0, requestTimeoutMs: 15000, logLevel: 'error', activityDetail: 'full', fitDownloadDir: '',
}
function fixture() {
  const sdk = {
    getUserProfileSettings: jest.fn().mockResolvedValue({ displayName: 'test' }),
    getDailyHrv: jest.fn().mockResolvedValue({ readings: [1, 2], extraField: 'preserved' }),
    getDailySteps: jest.fn().mockResolvedValue(null),
    getDailySummaries: jest.fn().mockResolvedValue({ data: [{ calendarDate: '2026-10-22', respiration: { avgValue: 15, algorithmVersion: 2 }, unrelatedPrivateField: 'omit' }] }),
    clearToken: jest.fn(),
  }
  const client = new GarminPersonalClient(config, sdk as unknown as GarminPersonalApiClient)
  return { sdk, client }
}

describe('Personal API provider integration', () => {
  it('connects without an email and keeps the browser identity unset', async () => {
    const { client } = fixture()
    await client.connect()
    expect(client.personalApiConnected()).toBe(true)
    expect(client.getAuthenticatedAccount()).toBeUndefined()
    expect(client.getAuthenticationRequirement()).toBeUndefined()
    await expect(client.getHrvData('2026-10-22')).resolves.toEqual({ readings: [1, 2], extraField: 'preserved' })
  })

  it('labels respiration summaries and exposes only the respiration fields', async () => {
    const { client } = fixture()
    await expect(client.getRespirationData('2026-10-22')).resolves.toMatchObject({
      provider: 'personal', resolution: 'daily_summary',
      respiration: [{ calendarDate: '2026-10-22', respiration: { avgValue: 15, algorithmVersion: 2 } }],
    })
    expect(JSON.stringify(await client.getRespirationData('2026-10-22'))).not.toContain('unrelatedPrivateField')
  })

  it('preserves empty Personal data instead of formatting it as zero steps', async () => {
    const { client } = fixture()
    const service = new GarminToolService(client, { provider: 'personal', activityDetail: 'full', fitDownloadDir: '', accountUsername: 'personal:test', accountRegion: 'cn' })
    await expect(service.getSteps({ startDate: '2026-10-22' })).resolves.toEqual({ provider: 'personal', calendarDate: '2026-10-22', data: null })
  })

  it('adds the configured Personal connection alias to the allow-listed profile only', async () => {
    const { client, sdk } = fixture()
    sdk.getUserProfileSettings.mockResolvedValue({ displayName: 'test', email: 'private@example.test', apiKey: 'never-output' } as any)
    const service = new GarminToolService(client, {
      provider: 'personal', accountId: 'personal-test', accountAlias: '我的国际账号',
      activityDetail: 'full', fitDownloadDir: '', accountUsername: 'personal:personal-test', accountRegion: 'global',
    })
    await expect(service.getProfile()).resolves.toEqual({
      displayName: 'test', fullName: '', profileImageUrl: null, primaryActivity: null,
      connection: { accountId: 'personal-test', alias: '我的国际账号', provider: 'personal', region: 'global' },
    })
  })

  it('rejects unsupported writes and session replacement before making any request', async () => {
    const { sdk, client } = fixture()
    await expect(client.deleteWorkout()).rejects.toThrow('not available through the official Garmin Personal API')
    await expect(client.replacePersistedSession()).rejects.toThrow('not available')
    expect(sdk.getUserProfileSettings).not.toHaveBeenCalled()
  })

  it('discards an old in-flight connection when its account is removed', async () => {
    const { sdk, client } = fixture()
    let resolve!: (value: unknown) => void
    sdk.getUserProfileSettings.mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = client.connect()
    client.deactivate()
    resolve({ displayName: 'old-account' })
    await expect(pending).rejects.toThrow('configuration changed')
    expect(client.personalApiConnected()).toBe(false)
  })

  it('never forwards an SDK response containing a credential into public errors', async () => {
    const { sdk, client } = fixture()
    sdk.getUserProfileSettings.mockRejectedValue(new PersonalApiError('secret=not-for-output', 'HTTP_ERROR', 404))
    await expect(client.connect()).rejects.toThrow('HTTP 404')
    try { await client.connect() } catch (error) { expect(String(error)).not.toContain('not-for-output') }
    expect(client.getAuthenticationRequirement()).toBeUndefined()
  })

  it('advertises only supported Personal tools and never creates browser auth', async () => {
    const createAuthentication = jest.fn()
    const server = createMcpServer({} as any, { provider: 'personal', createAuthentication })
    const peer = new Client({ name: 'personal-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), peer.connect(clientTransport)])
    try {
      const result = await peer.listTools()
      expect(result.tools.map(tool => tool.name).sort()).toEqual([...PERSONAL_TOOL_NAMES].sort())
      expect(createAuthentication).not.toHaveBeenCalled()
    } finally { await peer.close(); await server.close() }
  })

  it('uses the same Personal tool set in a Personal-only DSH configuration', () => {
    const definitions: string[] = []
    registerTools({ logger: { info: jest.fn() }, tools: { register: (value: { name: string }) => definitions.push(value.name) } } as any, [{
      accountId: 'personal-test', slot: 1, region: 'cn', configured: true, config, client: fixture().client,
    }])
    expect(definitions.sort()).toEqual([...PERSONAL_TOOL_NAMES].sort())
  })

  it('uses the DSH account alias with its stable ID in Personal profile output', async () => {
    const definitions: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> = []
    registerTools({ logger: { info: jest.fn() }, tools: { register: (value: typeof definitions[number]) => definitions.push(value) } } as any, [{
      accountId: 'personal-test', alias: '跑步账号', slot: 1, region: 'cn', configured: true, config, client: fixture().client,
    }])
    await expect(definitions.find(tool => tool.name === 'get_garmin_profile')!.execute({ account: 'personal-test' }))
      .resolves.toMatchObject({ connection: { accountId: 'personal-test', alias: '跑步账号', provider: 'personal', region: 'cn' } })
  })

  it('configures standalone Personal MCP with a display alias and clears old web credentials', () => {
    const saved = { ...process.env }
    try {
      process.env.GARMIN_USERNAME = 'old-web@example.test'
      process.env.GARMIN_PASSWORD = 'old-password'
      process.env.GARMIN_SESSION_TOKEN = 'old-session'
      process.env.GARMIN_SESSION_TOKEN_FILE = '/private/old-session'
      process.env.GARMIN_PROVIDER = 'personal'
      process.env.GARMIN_ALIAS = '  我的国际账号  '
      delete process.env.GARMIN_ACCOUNT
      process.env.GARMIN_PERSONAL_API_KEY_FILE = '/private/test-key-file'
      process.env.GARMIN_REGION = 'cn'
      expect(standaloneConfig()).toMatchObject({
        provider: 'personal', username: '', password: '', sessionToken: '', sessionTokenFile: '',
        accountAlias: '我的国际账号', region: 'cn', personalApiKeyFile: '/private/test-key-file',
      })
      expect(standaloneAccountAlias()).toBe('default')
    } finally { process.env = saved }
  })

  it.each([undefined, '', '   ', 'x'.repeat(65), 'alias\nnext', '\talias', 'alias\u0085next'])(
    'rejects a missing or invalid Personal MCP display alias (%j)', alias => {
      const saved = { ...process.env }
      try {
        process.env.GARMIN_PROVIDER = 'personal'
        process.env.GARMIN_PERSONAL_API_KEY = 'test-key-not-real'
        if (alias === undefined) delete process.env.GARMIN_ALIAS
        else process.env.GARMIN_ALIAS = alias
        expect(() => standaloneConfig()).toThrow('GARMIN_ALIAS is required for Personal API')
      } finally { process.env = saved }
    },
  )
})
