import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/config'
import { createHash } from 'node:crypto'

const mockConnect = jest.fn().mockRejectedValue(new Error('not authenticated yet'))
const mockReplacePersistedSession = jest.fn().mockImplementation(
  async (writer: () => Promise<void>) => writer(),
)
const mockGetAuthenticatedAccount = jest.fn().mockReturnValue({
  email: 'runner@example.test',
  region: 'global',
})
const mockGetAuthenticationRequirement = jest.fn().mockReturnValue({
  reason: 'challenge',
  region: 'global',
  revision: 2,
})
const mockDeactivate = jest.fn()
const mockClient = {
  connect: mockConnect,
  getAuthenticatedAccount: mockGetAuthenticatedAccount,
  getAuthenticationRequirement: mockGetAuthenticationRequirement,
  replacePersistedSession: mockReplacePersistedSession,
  deactivate: mockDeactivate,
}
const mockRegisterTools = jest.fn()
const mockRegisterEmbeddedAuthRpcAccounts = jest.fn()
const mockRegisterCoachPanel = jest.fn()
const mockRegisterHarnessWorkspace = jest.fn()
const mockResolveAccountConfigs = jest.fn((config: Config) => ([
  {
    accountId: 'legacy-cn', slot: 1,
    region: 'cn', alias: '', configured: false,
    config: {
      ...config, username: '', region: 'cn', password: '', sessionToken: '',
      sessionTokenFile: '/private/config/accounts/region-cn.session.json',
    },
  },
  {
    accountId: 'legacy-global', slot: 2,
    region: 'global', alias: '', configured: true,
    config: { ...config, sessionTokenFile: '/private/config/accounts/default.session.json' },
  },
]))

jest.mock('../src/client', () => ({
  GarminClient: jest.fn(() => mockClient),
}))
jest.mock('../src/config', () => ({
  Config: {},
  resolveConfig: (value: Config) => value,
  resolveAccountConfigs: mockResolveAccountConfigs,
}))
jest.mock('../src/tools', () => ({ registerTools: mockRegisterTools }))
jest.mock('../src/embedded-auth-rpc', () => ({
  registerEmbeddedAuthRpcAccounts: mockRegisterEmbeddedAuthRpcAccounts,
}))
jest.mock('../src/coach-panel', () => ({ registerCoachPanel: mockRegisterCoachPanel }))
jest.mock('../src/workspace-harness', () => ({ registerHarnessWorkspace: mockRegisterHarnessWorkspace }))

import { GarminClient } from '../src/client'
import { apply } from '../src/index'

const config: Config = {
  username: 'runner@example.test',
  password: '',
  sessionToken: '',
  sessionTokenFile: '',
  region: 'global',
  cacheTtl: 0,
  requestTimeoutMs: 15_000,
  logLevel: 'info',
  activityDetail: 'compact',
  fitDownloadDir: '',
}

describe('plugin activation', () => {
  function createContext(baseUrl: string | null = 'file:///synthetic-dsh-profile/config.yml') {
    let onVolatileUpdate: (paths: readonly (readonly string[])[]) => void = () => undefined
    let disposeClient: () => void = () => undefined
    const restart = jest.fn().mockResolvedValue(undefined)
    const ctx = {
      inject: jest.fn((_dependencies: string[], callback: (child: Context) => void) => callback(Object.assign(Object.create(ctx), {
        loader: { config: baseUrl ? { baseUrl } : {} },
      }) as Context)),
      on: jest.fn((_name: string, listener: typeof onVolatileUpdate) => {
        onVolatileUpdate = listener
      }),
      effect: jest.fn((execute: () => () => void) => {
        disposeClient = execute()
      }),
      fiber: { uid: 1, restart },
      logger: { error: jest.fn() },
    } as unknown as Context
    return {
      ctx,
      emitVolatileUpdate: (paths: readonly (readonly string[])[]) => onVolatileUpdate(paths),
      disposeClient: () => disposeClient(),
      restart,
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })
  afterEach(() => {
    for (const [, source] of mockRegisterEmbeddedAuthRpcAccounts.mock.calls) source.close()
  })

  it('delegates the scoped Host to the shared owner without constructing SDK clients at activation', async () => {
    const { ctx } = createContext()
    apply(ctx, config)
    await Promise.resolve()

    expect(GarminClient).not.toHaveBeenCalled()
    expect(mockRegisterHarnessWorkspace).toHaveBeenCalledTimes(1)
    const [, options] = mockRegisterHarnessWorkspace.mock.calls[0]
    expect(options.scopeId).toBe(createHash('sha256').update('file:///synthetic-dsh-profile/config.yml').digest('hex'))
    expect(options.baseConfig).toBe(config)
    expect(options.legacySeeds).toEqual([
      expect.objectContaining({ accountId: 'legacy-cn', slot: 1, region: 'cn', configured: false }),
      expect.objectContaining({ accountId: 'legacy-global', slot: 2, region: 'global', configured: true }),
    ])
    expect(options.legacySeeds[1].config.sessionTokenFile).toBe('/private/config/accounts/default.session.json')
    expect(mockRegisterTools).not.toHaveBeenCalled()
    expect(mockRegisterEmbeddedAuthRpcAccounts).not.toHaveBeenCalled()
    expect(mockRegisterCoachPanel).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('coalesces account changes into one whole-plugin restart', async () => {
    const { ctx, emitVolatileUpdate, restart } = createContext()
    apply(ctx, config)

    emitVolatileUpdate([['cacheTtl']])
    expect(restart).not.toHaveBeenCalled()
    emitVolatileUpdate([['accounts']])
    emitVolatileUpdate([['account3UsernameId']])
    expect(restart).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('uses the inherited workspace URL when desktop omits Loader config.baseUrl', () => {
    const { ctx } = createContext()
    ;(ctx.inject as jest.Mock).mockImplementation((_dependencies, callback) => callback(Object.assign(Object.create(ctx), {
      loader: { config: {} }, baseUrl: 'file:///synthetic-dsh-desktop/config.yml',
    })))
    apply(ctx, config)
    const options = mockRegisterHarnessWorkspace.mock.calls[0]?.[1]
    expect(options.scopeId).toBe(createHash('sha256').update('file:///synthetic-dsh-desktop/config.yml').digest('hex'))
    expect(options.scopeId).not.toContain('synthetic')
  })

  it('retains the unscoped legacy source and disposes it without disk, network or SDK initialization', async () => {
    const { ctx, disposeClient } = createContext(null)
    apply(ctx, config)
    expect(mockRegisterHarnessWorkspace).not.toHaveBeenCalled()
    expect(mockRegisterTools).toHaveBeenCalledTimes(1)
    expect(mockRegisterEmbeddedAuthRpcAccounts).toHaveBeenCalledTimes(1)
    const source = mockRegisterTools.mock.calls[0][1]
    expect(mockRegisterEmbeddedAuthRpcAccounts.mock.calls[0][1]).toBe(source)
    expect(mockRegisterCoachPanel.mock.calls[0][1]).toBe(source)
    await source.ready()
    expect(source.managed).toBe(false)
    expect(source.list()).toHaveLength(2)
    disposeClient()
    await expect(source.ready()).rejects.toMatchObject({ code: 'closed' })
    expect(GarminClient).not.toHaveBeenCalled()
  })

  it('restarts auth controllers after the diagnostic switch changes', async () => {
    const { ctx, emitVolatileUpdate, restart } = createContext()
    apply(ctx, config)

    emitVolatileUpdate([['authVerbose']])
    await Promise.resolve()

    expect(restart).toHaveBeenCalledTimes(1)
  })
})
