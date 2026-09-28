import type { Context } from '@deepseek-ai/cordis'
import {
  registerEmbeddedAuthRpc,
  registerEmbeddedAuthRpcAccounts,
  resolveEmbeddedAuthConfig,
  type EmbeddedAuthAccountOption,
  type EmbeddedAuthRpcController,
} from '../src/embedded-auth-rpc'
import {
  parseGarminAuthAccountRpcResult,
  parseGarminAuthAccountsRpcResult,
} from '../src/client/protocol'

function fixture() {
  const controller: jest.Mocked<EmbeddedAuthRpcController> = {
    begin: jest.fn().mockResolvedValue({
      success: true,
      flowId: 'a'.repeat(64),
      bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${'a'.repeat(64)}`,
      expiresAt: 1_900_000_000_000,
    }),
    status: jest.fn().mockReturnValue({ success: true, status: 'in_progress' }),
    cancel: jest.fn().mockReturnValue({ success: true }),
    close: jest.fn().mockResolvedValue(undefined),
  }
  const disposeRpc = jest.fn().mockResolvedValue(undefined)
  const handle = jest.fn().mockReturnValue(disposeRpc)
  let disposeEffect: (() => Promise<void>) | undefined
  const child = {
    connection: { rpc: { handle } },
    effect: jest.fn((execute: () => () => Promise<void>) => {
      disposeEffect = execute()
      return jest.fn()
    }),
  }
  const ctx = {
    inject: jest.fn((_services: string[], callback: (nested: typeof child) => void) => {
      callback(child)
      return {}
    }),
  }
  return {
    controller,
    factory: jest.fn(() => controller),
    disposeRpc,
    handle,
    child,
    ctx,
    disposeEffect: () => disposeEffect,
  }
}

function multiAccountFixture(
  configuredGlobal = true,
  sameRegion = false,
  cnUsername = 'cn@example.test',
  cnRevision?: string,
) {
  const subject = fixture()
  const accountIds = { cn: 'acct-cn', global: 'acct-global' }
  const flowIds = { cn: 'a'.repeat(64), global: 'b'.repeat(64) }
  const controllers = Object.fromEntries((['cn', 'global'] as const).map(region => [
    region,
    {
      begin: jest.fn().mockResolvedValue({
        success: true,
        flowId: flowIds[region],
        bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${flowIds[region]}`,
        expiresAt: 1_900_000_000_000,
      }),
      status: jest.fn().mockReturnValue({ success: true, status: 'in_progress' }),
      cancel: jest.fn().mockReturnValue({ success: true }),
      close: jest.fn().mockResolvedValue(undefined),
    } as jest.Mocked<EmbeddedAuthRpcController>,
  ])) as Record<'cn' | 'global', jest.Mocked<EmbeddedAuthRpcController>>
  const clients = Object.fromEntries((['cn', 'global'] as const).map(region => [
    region,
    {
      getAuthenticatedAccount: jest.fn().mockReturnValue(undefined),
      getAuthenticationRequirement: jest.fn().mockReturnValue(undefined),
      replacePersistedSession: jest.fn().mockImplementation(async (write: () => Promise<void>) => write()),
    },
  ])) as Record<'cn' | 'global', {
    getAuthenticatedAccount: jest.Mock
    getAuthenticationRequirement: jest.Mock
    replacePersistedSession: jest.Mock
  }>
  const accounts = (['cn', 'global'] as const).map(region => ({
    accountId: accountIds[region],
    slot: region === 'cn' ? 1 : 2,
    region: sameRegion && region === 'global' ? 'cn' : region,
    config: {
      username: region === 'cn' ? cnUsername : `${region}@example.test`,
      region: sameRegion && region === 'global' ? 'cn' : region,
      sessionTokenFile: `/private/${region}.session.json`,
    } as never,
    configured: region === 'cn' || configuredGlobal,
    alias: region === 'cn' ? '国内训练' : 'International',
    ...(region === 'cn' && cnRevision ? { revision: cnRevision } : {}),
    client: clients[region] as never,
    initialConnection: Promise.resolve(),
  })) satisfies EmbeddedAuthAccountOption[]
  const createController = jest.fn((_config, account: EmbeddedAuthAccountOption) => (
    controllers[account.accountId === accountIds.cn ? 'cn' : 'global']
  ))
  registerEmbeddedAuthRpcAccounts(
    subject.ctx as unknown as Context,
    accounts,
    { createController },
  )
  const handler = subject.handle.mock.calls[0][1]
  const signal = new AbortController().signal
  return { ...subject, accountIds, flowIds, controllers, clients, accounts, createController, handler, signal }
}

describe('DSH embedded Garmin authentication RPC', () => {
  it('uses one default account session path for the Host and Garmin client', () => {
    const config = resolveEmbeddedAuthConfig({
      username: 'runner@example.test',
      region: 'cn',
      sessionTokenFile: '',
    } as never, {
      GARMIN_ACCOUNT: 'personal',
      XDG_CONFIG_HOME: '/private/config',
    })

    expect(config.sessionTokenFile).toBe(
      '/private/config/dsh-plugin-garmin-connect/accounts/personal.session.json',
    )
  })

  it('fails configuration closed for an invalid account alias', () => {
    const config = resolveEmbeddedAuthConfig({
      username: 'runner@example.test',
      region: 'global',
      sessionTokenFile: '',
    } as never, {
      GARMIN_ACCOUNT: '../escape',
      XDG_CONFIG_HOME: '/private/config',
    })

    expect(config.sessionTokenFile).toBe('')
  })

  it('waits for Connection and registers a loopback-only channel', () => {
    const subject = fixture()

    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )

    expect(subject.ctx.inject).toHaveBeenCalledWith(
      ['connection'],
      expect.any(Function),
    )
    expect(subject.handle).toHaveBeenCalledWith(
      '/garmin-auth',
      expect.any(Function),
      { authority: 'loopback' },
    )
    expect(subject.child.effect).toHaveBeenCalledWith(
      expect.any(Function),
      'garmin-connect: embedded auth rpc',
    )
  })

  it('can register authentication routes when the Host no longer supports custom RPC channels', () => {
    const subject = fixture()
    const register = jest.fn().mockReturnValue(jest.fn().mockResolvedValue(undefined))
    subject.handle.mockImplementation(() => {
      throw new Error('cannot get property "webServer" without inject')
    })
    Object.assign(subject.child.connection, { fetch: { register } })

    expect(() => registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )).not.toThrow()
    expect(register.mock.calls.map(([route]) => route.path)).toEqual([
      '/api/garmin-auth/account',
      '/api/garmin-auth/begin',
      '/api/garmin-auth/status',
      '/api/garmin-auth/cancel',
    ])
    for (const [route] of register.mock.calls) {
      expect(route).toEqual(expect.objectContaining({
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: expect.any(Function),
      }))
    }
    expect(subject.handle).not.toHaveBeenCalled()
  })

  it('dispatches a browser RPC envelope through an admitted Host Fetch route', async () => {
    const subject = fixture()
    const register = jest.fn().mockReturnValue(jest.fn().mockResolvedValue(undefined))
    Object.assign(subject.child.connection, { fetch: { register } })
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const beginRoute = register.mock.calls
      .map(([route]) => route)
      .find(route => route.path === '/api/garmin-auth/begin')
    const request = (url: string, method = 'garmin-auth/begin') => ({
      url,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      signal: new AbortController().signal,
      json: async () => ({
        type: 'client-request',
        rpcId: 'request-123',
        method,
        payload: { region: 'cn' },
      }),
    }) as unknown as Request

    // Connection's HTTP bridge uses this internal URL after admitting the
    // original request. It does not preserve the external loopback hostname.
    const response = await beginRoute.fetch(request(
      'http://dsh.internal/api/garmin-auth/begin',
    ))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      type: 'server-response',
      rpcId: 'request-123',
      result: {
        ok: true,
        value: expect.objectContaining({ success: true, flowId: 'a'.repeat(64) }),
      },
    })
    expect(subject.controller.begin).toHaveBeenCalledWith(expect.any(AbortSignal), 'cn')

    const mismatched = await beginRoute.fetch(request(
      'http://dsh.internal/api/garmin-auth/begin',
      'garmin-auth/status',
    ))
    expect(mismatched.status).toBe(400)
    expect(subject.controller.begin).toHaveBeenCalledTimes(1)
  })

  it('dispatches only the closed account/begin/status/cancel endpoints', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const handler = subject.handle.mock.calls[0][1]
    const signal = new AbortController().signal

    await expect(handler('begin', { region: 'cn' }, signal)).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ success: true, flowId: 'a'.repeat(64) }),
    })
    await expect(handler('status', { flowId: 'a'.repeat(64) }, signal))
      .resolves.toEqual({
        ok: true,
        value: { success: true, status: 'in_progress' },
      })
    await expect(handler('cancel', { flowId: 'a'.repeat(64) }, signal))
      .resolves.toEqual({ ok: true, value: { success: true } })

    expect(subject.controller.begin).toHaveBeenCalledWith(signal, 'cn')
    expect(subject.controller.status).toHaveBeenCalledWith({ flowId: 'a'.repeat(64) })
    expect(subject.controller.cancel).toHaveBeenCalledWith({ flowId: 'a'.repeat(64) })
  })

  it('returns only a bounded authenticated account on the optional account endpoint', async () => {
    const subject = fixture()
    const getAuthenticatedAccount = jest.fn().mockResolvedValue({
      email: 'runner@example.test',
      region: 'cn',
    })
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount,
      },
    )
    const handler = subject.handle.mock.calls[0][1]
    const signal = new AbortController().signal

    await expect(handler('account', {}, signal)).resolves.toEqual({
      ok: true,
      value: {
        success: true,
        authenticated: true,
        email: 'runner@example.test',
        region: 'cn',
      },
    })
    expect(getAuthenticatedAccount).toHaveBeenCalledTimes(1)

    await expect(handler('account', { extra: true }, signal)).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    expect(getAuthenticatedAccount).toHaveBeenCalledTimes(1)
  })

  it('returns no email when the Host has no authenticated account', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount: jest.fn().mockResolvedValue(undefined),
      },
    )
    const handler = subject.handle.mock.calls[0][1]

    await expect(handler(
      'account',
      {},
      new AbortController().signal,
    )).resolves.toEqual({
      ok: true,
      value: { success: true, authenticated: false },
    })
  })

  it('returns only coarse browser-recovery state for an unauthenticated Host', async () => {
    const subject = fixture()
    const getAuthenticationRequirement = jest.fn().mockReturnValue({
      reason: 'challenge',
      region: 'cn',
      revision: 3,
    })
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount: jest.fn().mockReturnValue(undefined),
        getAuthenticationRequirement,
      },
    )
    const handler = subject.handle.mock.calls[0][1]

    await expect(handler(
      'account',
      {},
      new AbortController().signal,
    )).resolves.toEqual({
      ok: true,
      value: {
        success: true,
        authenticated: false,
        authenticationRequired: true,
        reason: 'challenge',
        region: 'cn',
        revision: 3,
      },
    })
    expect(getAuthenticationRequirement).toHaveBeenCalledTimes(1)
  })

  it('collapses malformed browser-recovery state without reflecting it', async () => {
    const subject = fixture()
    const secret = 'ST-secret /private/session.json'
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount: jest.fn().mockReturnValue(undefined),
        getAuthenticationRequirement: jest.fn().mockReturnValue({
          reason: 'challenge',
          region: 'global',
          revision: 1,
          token: secret,
        }),
      },
    )
    const handler = subject.handle.mock.calls[0][1]
    const response = await handler('account', {}, new AbortController().signal)

    expect(response).toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    expect(JSON.stringify(response)).not.toContain(secret)
  })

  it('does not reflect an internal browser challenge kind through the RPC', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount: jest.fn().mockReturnValue(undefined),
        getAuthenticationRequirement: jest.fn().mockReturnValue({
          reason: 'challenge',
          region: 'global',
          revision: 1,
          challengeKind: 'mfa',
        }),
      },
    )
    const handler = subject.handle.mock.calls[0][1]

    await expect(handler(
      'account',
      {},
      new AbortController().signal,
    )).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
  })

  it('collapses unsafe account providers without exposing their values', async () => {
    const subject = fixture()
    const secret = 'ST-secret'
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      {
        createController: subject.factory,
        getAuthenticatedAccount: jest.fn().mockResolvedValue({
          email: 'runner@example.test',
          region: 'global',
          token: secret,
        }),
      },
    )
    const handler = subject.handle.mock.calls[0][1]

    const response = await handler(
      'account',
      {},
      new AbortController().signal,
    )

    expect(response).toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    expect(JSON.stringify(response)).not.toContain(secret)
  })

  it('rejects malformed begin and unknown endpoints without reflecting payloads', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const handler = subject.handle.mock.calls[0][1]
    const secret = 'ST-secret runner@example.test /private/session.json'

    const malformedPayloads = [
      { secret },
      {},
      { region: 'eu' },
      { region: 'cn', extra: true },
      ['cn'],
      Object.create({ region: 'cn' }),
    ]
    const malformed = await Promise.all(malformedPayloads.map(payload => (
      handler('begin', payload, new AbortController().signal)
    )))
    const unknown = await handler(secret, { secret }, new AbortController().signal)

    expect(malformed).toEqual(malformedPayloads.map(() => ({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })))
    expect(unknown).toEqual(malformed[0])
    expect(JSON.stringify([malformed, unknown])).not.toContain(secret)
    expect(subject.controller.begin).not.toHaveBeenCalled()
  })

  it('collapses controller failures and request cancellation to a fixed result', async () => {
    const subject = fixture()
    subject.controller.status.mockImplementation(() => {
      throw new Error('ticket=ST-secret account=runner@example.test')
    })
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const handler = subject.handle.mock.calls[0][1]
    const aborted = new AbortController()
    aborted.abort()

    await expect(handler('status', {}, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    await expect(handler('begin', { region: 'cn' }, aborted.signal)).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
  })

  it('cancels a flow that finishes after its begin request was aborted', async () => {
    const subject = fixture()
    type BeginResult = Awaited<ReturnType<EmbeddedAuthRpcController['begin']>>
    let resolveBegin!: (value: BeginResult) => void
    const pendingBegin = new Promise<BeginResult>((resolve) => {
      resolveBegin = resolve
    })
    subject.controller.begin.mockReturnValue(pendingBegin)
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )
    const handler = subject.handle.mock.calls[0][1]
    const request = new AbortController()
    const result = handler('begin', { region: 'cn' }, request.signal)
    request.abort()
    resolveBegin({
      success: true,
      flowId: 'a'.repeat(64),
      bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${'a'.repeat(64)}`,
      expiresAt: 1_900_000_000_000,
    })

    await expect(result).resolves.toEqual({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })
    expect(subject.controller.cancel).toHaveBeenCalledWith({
      flowId: 'a'.repeat(64),
    })
  })

  it('unregisters the RPC before closing its private bridge on unload', async () => {
    const subject = fixture()
    registerEmbeddedAuthRpc(
      subject.ctx as unknown as Context,
      {} as never,
      subject.factory,
    )

    await subject.disposeEffect()?.()

    expect(subject.disposeRpc).toHaveBeenCalledTimes(1)
    expect(subject.controller.close).toHaveBeenCalledTimes(1)
    expect(subject.disposeRpc.mock.invocationCallOrder[0])
      .toBeLessThan(subject.controller.close.mock.invocationCallOrder[0])
  })
})

describe('DSH embedded authentication for named accounts', () => {
  it('constructs independent controllers with the Host-provided session paths', () => {
    const subject = multiAccountFixture()

    expect(subject.createController).toHaveBeenCalledTimes(2)
    expect(subject.createController.mock.calls.map(([config, account]) => [
      account.accountId,
      account.region,
      config.sessionTokenFile,
    ])).toEqual([
      ['acct-cn', 'cn', '/private/cn.session.json'],
      ['acct-global', 'global', '/private/global.session.json'],
    ])
    expect(subject.handle).toHaveBeenCalledTimes(1)
    expect(subject.handle).toHaveBeenCalledWith(
      '/garmin-auth', expect.any(Function), { authority: 'loopback' },
    )
  })

  it('returns independent public account details and omits unconfigured slots from the list', async () => {
    const subject = multiAccountFixture(false)
    subject.clients.cn.getAuthenticatedAccount.mockReturnValue({
      email: 'cn@example.test', region: 'cn',
    })

    await expect(subject.handler('account', { accountId: subject.accountIds.cn }, subject.signal))
      .resolves.toEqual({ ok: true, value: {
        success: true,
        accountId: subject.accountIds.cn,
        slot: 1,
        configured: true,
        authenticated: true,
        region: 'cn',
        alias: '国内训练',
        email: 'cn@example.test',
      } })
    await expect(subject.handler('account', { accountId: subject.accountIds.global }, subject.signal))
      .resolves.toEqual({ ok: true, value: {
        success: true,
        accountId: subject.accountIds.global,
        slot: 2,
        configured: false,
        authenticated: false,
        region: 'global',
      } })
    expect(subject.clients.global.getAuthenticatedAccount).not.toHaveBeenCalled()
    expect(subject.createController).toHaveBeenCalledTimes(1)
    await expect(subject.handler('account', {}, subject.signal))
      .resolves.toEqual({ ok: true, value: {
        success: true,
        accounts: [{
          accountId: subject.accountIds.cn,
          slot: 1,
          region: 'cn',
          alias: '国内训练',
          maskedEmail: 'c****@example.test',
          configured: true,
          authenticated: true,
        }],
      } })
    await expect(subject.handler('begin', { accountId: subject.accountIds.global }, subject.signal))
      .resolves.toEqual({ ok: true, value: {
        success: false, code: 'configuration',
      } })
    await expect(subject.handler('account', { accountId: 'missing' }, subject.signal))
      .resolves.toEqual({ ok: true, value: {
        success: false, code: 'configuration',
      } })
  })

  it('keeps Host account summaries and details compatible with the client parser', async () => {
    const subject = multiAccountFixture(false)
    subject.clients.cn.getAuthenticatedAccount.mockReturnValue({
      email: 'cn@example.test', region: 'cn',
    })

    const listWire = await subject.handler('account', {}, subject.signal)
    expect(parseGarminAuthAccountsRpcResult(listWire)).toEqual({
      success: true,
      accounts: [{
        accountId: subject.accountIds.cn,
        slot: 1,
        region: 'cn',
        alias: '国内训练',
        maskedEmail: 'c****@example.test',
        configured: true,
        authenticated: true,
      }],
    })
    const authenticatedWire = await subject.handler(
      'account', { accountId: subject.accountIds.cn }, subject.signal,
    )
    expect(parseGarminAuthAccountRpcResult(authenticatedWire)).toEqual({
      success: true,
      accountId: subject.accountIds.cn,
      slot: 1,
      region: 'cn',
      alias: '国内训练',
      configured: true,
      authenticated: true,
      email: 'cn@example.test',
    })
    const unconfiguredWire = await subject.handler(
      'account', { accountId: subject.accountIds.global }, subject.signal,
    )
    expect(parseGarminAuthAccountRpcResult(unconfiguredWire)).toEqual({
      success: true,
      accountId: subject.accountIds.global,
      slot: 2,
      region: 'global',
      configured: false,
      authenticated: false,
    })
  })

  it('shows only a masked configured email in account summaries', async () => {
    const subject = multiAccountFixture(false)
    const account = subject.accounts[0] as EmbeddedAuthAccountOption
    for (const [username, maskedEmail] of [
      ['chunhua@88.com', 'chu****@88.com'],
      ['abcde@88.com', 'a****@88.com'],
      ['ab@88.com', 'a****@88.com'],
      ['a@88.com', '****@88.com'],
      ["o'connor@example.test", 'o\'c****@example.test'],
      ['!special@example.test', '!sp****@example.test'],
      ['甲乙丙丁戊己@88.com', '甲乙丙****@88.com'],
      ['invalid@@example.test', undefined],
      ['missing-at', undefined],
      ['a*star@example.test', undefined],
      ['a@example*.test', undefined],
      ['a\n@example.test', undefined],
      ['a@bad domain.test', undefined],
      ['a@example..test', undefined],
    ] as const) {
      account.config.username = username
      const listed = await subject.handler('account', {}, subject.signal)
      expect(listed.value.accounts[0].maskedEmail).toBe(maskedEmail)
      expect(JSON.stringify(listed)).not.toContain(username)
    }
  })

  it('waits for the saved revision before beginning, even when two emails share a mask', async () => {
    const previousEmail = 'chunhua@88.com'
    const savedEmail = 'chutian@88.com'
    const previousRevision = 'a'.repeat(32)
    const savedRevision = 'b'.repeat(32)
    const previous = multiAccountFixture(false, false, previousEmail, previousRevision)
    const request = {
      accountId: previous.accountIds.cn,
      expectedRevision: savedRevision,
      expectedRegion: 'cn',
    }

    const oldList = await previous.handler('account', {}, previous.signal)
    expect(oldList.value.accounts[0].maskedEmail).toBe('chu****@88.com')
    const stale = await previous.handler('begin', request, previous.signal)
    expect(stale).toEqual({ ok: true, value: {
      success: false, code: 'stale_config',
    } })
    expect(previous.controllers.cn.begin).not.toHaveBeenCalled()
    expect(JSON.stringify(stale)).not.toContain(savedEmail)
    expect(JSON.stringify(stale)).not.toContain(previousEmail)

    const current = multiAccountFixture(false, false, savedEmail, savedRevision)
    const newList = await current.handler('account', {}, current.signal)
    expect(newList.value.accounts[0].maskedEmail).toBe('chu****@88.com')
    await expect(current.handler('begin', request, current.signal))
      .resolves.toEqual({ ok: true, value: expect.objectContaining({
        success: true,
        flowId: current.flowIds.cn,
      }) })
    expect(current.controllers.cn.begin).toHaveBeenCalledWith(current.signal, 'cn')
  })

  it('guards every saved revision and rejects malformed begin guards without opening a bridge', async () => {
    const revision = 'c'.repeat(32)
    const subject = multiAccountFixture(false, false, 'cn@example.test', revision)
    const accountId = subject.accountIds.cn
    await expect(subject.handler('begin', {
      accountId: 'new-account', expectedRevision: revision, expectedRegion: 'cn',
    }, subject.signal)).resolves.toEqual({ ok: true, value: {
      success: false, code: 'stale_config',
    } })
    await expect(subject.handler('begin', {
      accountId: subject.accountIds.global,
      expectedRevision: revision, expectedRegion: 'global',
    }, subject.signal)).resolves.toEqual({ ok: true, value: {
      success: false, code: 'stale_config',
    } })
    await expect(subject.handler('begin', {
      accountId, expectedRevision: revision, expectedRegion: 'global',
    }, subject.signal)).resolves.toEqual({ ok: true, value: {
      success: false, code: 'stale_config',
    } })
    for (const payload of [
      { accountId, expectedRevision: revision },
      { accountId, expectedRegion: 'cn' },
      { accountId, expectedRevision: revision, expectedRegion: 'cn', extra: true },
      { accountId, expectedRevision: 'A'.repeat(32), expectedRegion: 'cn' },
      { accountId, expectedRevision: 'a'.repeat(31), expectedRegion: 'cn' },
      { accountId, expectedEmail: 'new@example.test', expectedRegion: 'cn' },
      { accountId, expectedRegion: 'invalid' },
    ]) {
      await expect(subject.handler('begin', payload, subject.signal))
        .resolves.toEqual({ ok: true, value: {
          success: false, code: 'unavailable',
        } })
    }
    expect(subject.controllers.cn.begin).not.toHaveBeenCalled()

    await expect(subject.handler('begin', {
      accountId, expectedRevision: revision, expectedRegion: 'cn',
    }, subject.signal)).resolves.toEqual({ ok: true, value: expect.objectContaining({
      success: true,
      flowId: subject.flowIds.cn,
    }) })
    expect(subject.controllers.cn.begin).toHaveBeenCalledTimes(1)
  })

  it('keeps browser-recovery state inside its selected region', async () => {
    const subject = multiAccountFixture()
    subject.clients.global.getAuthenticationRequirement.mockReturnValue({
      reason: 'challenge', region: 'global', revision: 2,
    })

    await expect(subject.handler('account', { accountId: subject.accountIds.global }, subject.signal))
      .resolves.toEqual({ ok: true, value: {
        success: true,
        accountId: subject.accountIds.global,
        slot: 2,
        configured: true,
        authenticated: false,
        region: 'global',
        alias: 'International',
        authenticationRequired: true,
        reason: 'challenge',
        revision: 2,
      } })
    expect(subject.clients.cn.getAuthenticationRequirement).not.toHaveBeenCalled()

    subject.clients.global.getAuthenticationRequirement.mockReturnValue({
      reason: 'challenge', region: 'cn', revision: 2,
    })
    await expect(subject.handler('account', { accountId: subject.accountIds.global }, subject.signal))
      .resolves.toEqual({ ok: true, value: {
        success: false, code: 'unavailable',
      } })
  })

  it('keeps two accounts in the same region distinct by stable account ID', async () => {
    const subject = multiAccountFixture(true, true)
    subject.clients.cn.getAuthenticatedAccount.mockReturnValue({
      email: 'first@example.test', region: 'cn',
    })
    subject.clients.global.getAuthenticatedAccount.mockReturnValue({
      email: 'second@example.test', region: 'cn',
    })

    const listed = await subject.handler('account', {}, subject.signal)
    expect(listed).toEqual({ ok: true, value: {
      success: true,
      accounts: [
        {
          accountId: subject.accountIds.cn,
          slot: 1,
          region: 'cn',
          alias: '国内训练',
          maskedEmail: 'c****@example.test',
          configured: true,
          authenticated: true,
        },
        {
          accountId: subject.accountIds.global,
          slot: 2,
          region: 'cn',
          alias: 'International',
          maskedEmail: 'glo****@example.test',
          configured: true,
          authenticated: true,
        },
      ],
    } })
    expect(JSON.stringify(listed)).not.toContain('first@example.test')
    expect(JSON.stringify(listed)).not.toContain('second@example.test')

    await expect(subject.handler('account', {
      accountId: subject.accountIds.global,
    }, subject.signal)).resolves.toEqual({ ok: true, value: {
      success: true,
      accountId: subject.accountIds.global,
      slot: 2,
      configured: true,
      authenticated: true,
      region: 'cn',
      alias: 'International',
      email: 'second@example.test',
    } })
    await subject.handler('begin', { accountId: subject.accountIds.cn }, subject.signal)
    await subject.handler('begin', { accountId: subject.accountIds.global }, subject.signal)
    expect(subject.controllers.cn.begin).toHaveBeenCalledWith(subject.signal, 'cn')
    expect(subject.controllers.global.begin).toHaveBeenCalledWith(subject.signal, 'cn')
    await subject.handler('status', { flowId: subject.flowIds.global }, subject.signal)
    expect(subject.controllers.global.status).toHaveBeenCalledTimes(1)
    expect(subject.controllers.cn.status).not.toHaveBeenCalled()
  })

  it('routes begin/status/cancel solely by the issuing account ID and flow ID', async () => {
    const subject = multiAccountFixture()
    for (const region of ['cn', 'global'] as const) {
      await expect(subject.handler('begin', { accountId: subject.accountIds[region] }, subject.signal))
        .resolves.toEqual({ ok: true, value: expect.objectContaining({
          success: true, flowId: subject.flowIds[region],
        }) })
      expect(subject.controllers[region].begin).toHaveBeenCalledWith(
        subject.signal, region,
      )
    }
    await expect(subject.handler('status', {
      flowId: subject.flowIds.global,
    }, subject.signal)).resolves.toEqual({
      ok: true, value: { success: true, status: 'in_progress' },
    })
    await expect(subject.handler('cancel', {
      flowId: subject.flowIds.cn,
    }, subject.signal)).resolves.toEqual({
      ok: true, value: { success: true },
    })
    expect(subject.controllers.global.status).toHaveBeenCalledWith({
      flowId: subject.flowIds.global,
    })
    expect(subject.controllers.cn.cancel).toHaveBeenCalledWith({
      flowId: subject.flowIds.cn,
    })
    expect(subject.controllers.cn.status).not.toHaveBeenCalled()
    expect(subject.controllers.global.cancel).not.toHaveBeenCalled()

    await expect(subject.handler('status', {
      flowId: 'c'.repeat(64),
    }, subject.signal)).resolves.toEqual({
      ok: true, value: { success: false, code: 'invalid' },
    })
    await expect(subject.handler('cancel', {
      flowId: subject.flowIds.cn, extra: true,
    }, subject.signal)).resolves.toEqual({
      ok: true, value: { success: false, code: 'invalid' },
    })
  })

  it('does not reassign a duplicate flow ID from one account to the other', async () => {
    const subject = multiAccountFixture()
    subject.controllers.global.begin.mockResolvedValue({
      success: true,
      flowId: subject.flowIds.cn,
      bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${subject.flowIds.cn}`,
      expiresAt: 1_900_000_000_000,
    })
    await subject.handler('begin', { accountId: subject.accountIds.cn }, subject.signal)

    await expect(subject.handler('begin', { accountId: subject.accountIds.global }, subject.signal))
      .resolves.toEqual({ ok: true, value: {
        success: false, code: 'unavailable',
      } })
    expect(subject.controllers.global.cancel).toHaveBeenCalledWith({
      flowId: subject.flowIds.cn,
    })
    await subject.handler('status', { flowId: subject.flowIds.cn }, subject.signal)
    expect(subject.controllers.cn.status).toHaveBeenCalledTimes(1)
    expect(subject.controllers.global.status).not.toHaveBeenCalled()
  })

  it('releases a flow after returning its first terminal status or successful cancel', async () => {
    const subject = multiAccountFixture()
    subject.controllers.cn.status.mockReturnValue({ success: true, status: 'succeeded' })
    await subject.handler('begin', { accountId: subject.accountIds.cn }, subject.signal)
    await expect(subject.handler('status', {
      flowId: subject.flowIds.cn,
    }, subject.signal)).resolves.toEqual({
      ok: true, value: { success: true, status: 'succeeded' },
    })
    await expect(subject.handler('status', {
      flowId: subject.flowIds.cn,
    }, subject.signal)).resolves.toEqual({
      ok: true, value: { success: false, code: 'invalid' },
    })
    expect(subject.controllers.cn.status).toHaveBeenCalledTimes(1)

    await subject.handler('begin', { accountId: subject.accountIds.global }, subject.signal)
    await expect(subject.handler('cancel', {
      flowId: subject.flowIds.global,
    }, subject.signal)).resolves.toEqual({
      ok: true, value: { success: true },
    })
    await expect(subject.handler('status', {
      flowId: subject.flowIds.global,
    }, subject.signal)).resolves.toEqual({
      ok: true, value: { success: false, code: 'invalid' },
    })
    expect(subject.controllers.global.status).not.toHaveBeenCalled()
  })

  it('unregisters the shared route before closing both private bridges', async () => {
    const subject = multiAccountFixture()
    await subject.disposeEffect()?.()

    expect(subject.disposeRpc).toHaveBeenCalledTimes(1)
    for (const controller of Object.values(subject.controllers)) {
      expect(controller.close).toHaveBeenCalledTimes(1)
      expect(subject.disposeRpc.mock.invocationCallOrder[0])
        .toBeLessThan(controller.close.mock.invocationCallOrder[0])
    }
  })
})
