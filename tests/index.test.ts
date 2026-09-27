import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/config'

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
const mockRegisterEmbeddedAuthRpc = jest.fn()
const mockResolveEmbeddedAuthConfig = jest.fn((config: Config) => ({
  ...config,
  sessionTokenFile: '/private/config/accounts/default.session.json',
}))

jest.mock('../src/client', () => ({
  GarminClient: jest.fn(() => mockClient),
}))
jest.mock('../src/config', () => ({
  Config: {},
  resolveConfig: (value: Config) => value,
}))
jest.mock('../src/tools', () => ({ registerTools: mockRegisterTools }))
jest.mock('../src/embedded-auth-rpc', () => ({
  registerEmbeddedAuthRpc: mockRegisterEmbeddedAuthRpc,
  resolveEmbeddedAuthConfig: mockResolveEmbeddedAuthConfig,
}))

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
  function createContext() {
    let onVolatileUpdate: (paths: readonly (readonly string[])[]) => void = () => undefined
    let disposeClient: () => void = () => undefined
    const restart = jest.fn().mockResolvedValue(undefined)
    const ctx = {
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

  it('registers embedded auth even when eager Garmin connection is unavailable', async () => {
    const { ctx } = createContext()
    apply(ctx, config)
    await Promise.resolve()

    expect(GarminClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionTokenFile: '/private/config/accounts/default.session.json',
      }),
      { allowUnconfigured: true },
    )
    expect(mockRegisterTools).toHaveBeenCalledTimes(1)
    expect(mockRegisterEmbeddedAuthRpc).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        getAuthenticatedAccount: expect.any(Function),
        getAuthenticationRequirement: expect.any(Function),
        replaceSession: expect.any(Function),
      },
    )

    const options = mockRegisterEmbeddedAuthRpc.mock.calls[0][2]
    await expect(options.getAuthenticatedAccount()).resolves.toEqual({
      email: 'runner@example.test',
      region: 'global',
    })
    expect(mockGetAuthenticatedAccount).toHaveBeenCalledTimes(1)
    await expect(options.getAuthenticationRequirement()).resolves.toEqual({
      reason: 'challenge',
      region: 'global',
      revision: 2,
    })
    expect(mockGetAuthenticationRequirement).toHaveBeenCalledTimes(1)
    const writer = jest.fn().mockResolvedValue(undefined)
    await options.replaceSession(writer)
    expect(mockReplacePersistedSession).toHaveBeenCalledWith(writer)
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('coalesces account changes into one whole-plugin restart', async () => {
    const { ctx, emitVolatileUpdate, restart } = createContext()
    apply(ctx, config)

    emitVolatileUpdate([['cacheTtl']])
    expect(restart).not.toHaveBeenCalled()
    emitVolatileUpdate([['username']])
    emitVolatileUpdate([['region']])
    expect(restart).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('deactivates the old client when its fiber is unloaded', () => {
    const { ctx, disposeClient } = createContext()
    apply(ctx, config)
    disposeClient()
    expect(mockDeactivate).toHaveBeenCalledTimes(1)
  })
})
