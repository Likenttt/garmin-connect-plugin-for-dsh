import type { Context } from '@deepseek-ai/cordis'
import {
  registerEmbeddedAuthRpc,
  resolveEmbeddedAuthConfig,
  type EmbeddedAuthRpcController,
} from '../src/embedded-auth-rpc'

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
