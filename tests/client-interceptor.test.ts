import { GarminClient, installSafeResponseInterceptor } from '../src/client'

type RejectHandler = (error: any) => Promise<unknown>

function upstreamFixture(guard?: {
  getAuthEpoch: () => number
  discardStaleRefresh: () => void
}) {
  let rejectHandler!: RejectHandler
  const request = jest.fn().mockResolvedValue({ data: 'retried' })
  const response = {
    clear: jest.fn(),
    use: jest.fn((_fulfilled: unknown, rejected: RejectHandler) => {
      rejectHandler = rejected
      return 0
    }),
  }
  const upstream: any = {
    client: {
      interceptors: { response },
      request,
    },
    OAUTH_CONSUMER: { key: 'consumer', secret: 'secret' },
    oauth1Token: { oauth_token: 'one', oauth_token_secret: 'two' },
    oauth2Token: { access_token: 'old' },
    getOauthClient: jest.fn().mockReturnValue({}),
    exchange: jest.fn().mockResolvedValue(undefined),
  }

  installSafeResponseInterceptor(upstream, guard)
  return { upstream, response, request, reject: (error: any) => rejectHandler(error) }
}

describe('safe Garmin response interceptor', () => {
  it('replaces the upstream global interceptor and normalizes response errors', async () => {
    const { response, reject } = upstreamFixture()
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {})
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

    await expect(reject({
      config: { method: 'get', url: '/data' },
      response: { status: 429, data: { access_token: 'SECRET' } },
    })).rejects.toEqual(expect.objectContaining({
      message: 'Garmin request failed (HTTP 429)',
      status: 429,
    }))

    expect(response.clear).toHaveBeenCalledTimes(1)
    expect(consoleLog).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    consoleLog.mockRestore()
    consoleError.mockRestore()
  })

  it('marks Axios timeout codes without retaining request configuration', async () => {
    const { reject } = upstreamFixture()
    const result = reject({
      code: 'ECONNABORTED',
      config: { headers: { Authorization: 'Bearer SECRET' } },
    })

    await expect(result).rejects.toEqual(expect.objectContaining({
      message: 'Garmin request failed',
      timedOut: true,
    }))
    await expect(result).rejects.not.toHaveProperty('config')
  })

  it('shares one refresh per client for concurrent idempotent 401 responses', async () => {
    const { upstream, reject, request } = upstreamFixture()
    let finishRefresh!: () => void
    upstream.exchange.mockImplementation(() => new Promise<void>((resolve) => {
      finishRefresh = () => {
        upstream.oauth2Token = { access_token: 'fresh' }
        resolve()
      }
    }))

    const first = reject({ config: { method: 'get', url: '/first' }, response: { status: 401 } })
    const second = reject({ config: { method: 'get', url: '/second' }, response: { status: 401 } })
    await Promise.resolve()

    expect(upstream.exchange).toHaveBeenCalledTimes(1)
    finishRefresh()
    await expect(first).resolves.toEqual({ data: 'retried' })
    await expect(second).resolves.toEqual({ data: 'retried' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('unlocks after refresh failure and never exposes the refresh error', async () => {
    const { upstream, reject } = upstreamFixture()
    upstream.exchange
      .mockRejectedValueOnce(new Error('Authorization: Bearer SECRET private@example.test'))
      .mockImplementationOnce(async () => {
        upstream.oauth2Token = { access_token: 'fresh' }
      })

    const failedRefresh = reject({
      config: { method: 'get', url: '/first' },
      response: { status: 401 },
    })
    await expect(failedRefresh).rejects.toEqual(expect.objectContaining({
      message: 'Garmin request failed',
    }))
    await expect(failedRefresh).rejects.not.toHaveProperty('status')
    await expect(reject({
      config: { method: 'get', url: '/second' },
      response: { status: 401 },
    })).resolves.toEqual({ data: 'retried' })
    expect(upstream.exchange).toHaveBeenCalledTimes(2)
  })

  it('preserves a safe refresh failure status instead of invalidating the session', async () => {
    const { upstream, reject } = upstreamFixture()
    const originalOauth2 = upstream.oauth2Token
    upstream.exchange.mockImplementationOnce(async () => {
      upstream.oauth2Token = undefined
      throw Object.assign(
        new Error('rate limited response body must not escape'),
        { status: 429 },
      )
    })

    await expect(reject({
      config: { method: 'get', url: '/data' },
      response: { status: 401 },
    })).rejects.toEqual(expect.objectContaining({
      message: 'Garmin request failed (HTTP 429)',
      status: 429,
    }))
    expect(upstream.oauth2Token).toBe(originalOauth2)
  })

  it('never restores an old token when refresh fails after an identity change', async () => {
    let epoch = 0
    const fixture = upstreamFixture({
      getAuthEpoch: () => epoch,
      discardStaleRefresh: jest.fn(),
    })
    fixture.upstream.exchange.mockImplementationOnce(async () => {
      fixture.upstream.oauth2Token = undefined
      epoch = 1
      fixture.upstream.oauth2Token = { access_token: 'password-account' }
      throw Object.assign(new Error('rate limited'), { status: 429 })
    })

    await expect(fixture.reject({
      config: { method: 'get', url: '/data' },
      response: { status: 401 },
    })).rejects.toEqual(expect.objectContaining({ status: 429 }))
    expect(fixture.upstream.oauth2Token).toEqual({ access_token: 'password-account' })
  })

  it('discards a refresh that completes after the authentication identity changes', async () => {
    let epoch = 0
    let upstreamRef: any
    const discardStaleRefresh = jest.fn(() => {
      upstreamRef.oauth1Token = undefined
      upstreamRef.oauth2Token = undefined
    })
    const fixture = upstreamFixture({
      getAuthEpoch: () => epoch,
      discardStaleRefresh,
    })
    upstreamRef = fixture.upstream
    let finishRefresh!: () => void
    fixture.upstream.exchange.mockImplementation(() => new Promise<void>((resolve) => {
      finishRefresh = () => {
        fixture.upstream.oauth2Token = { access_token: 'stale-token-account' }
        resolve()
      }
    }))

    const request = fixture.reject({
      config: { method: 'get', url: '/data' },
      response: { status: 401 },
    })
    await Promise.resolve()
    epoch = 1
    fixture.upstream.oauth2Token = { access_token: 'password-account' }
    finishRefresh()

    await expect(request).rejects.toEqual(expect.objectContaining({ status: 401 }))
    expect(discardStaleRefresh).toHaveBeenCalledTimes(1)
    expect(fixture.upstream.oauth2Token).toBeUndefined()
    expect(fixture.request).not.toHaveBeenCalled()
  })

  it('preserves a retried request failure after refresh succeeds', async () => {
    const { upstream, reject, request } = upstreamFixture()
    const rateLimit = Object.assign(new Error('Garmin request failed (HTTP 429)'), {
      status: 429,
    })
    request.mockRejectedValueOnce(rateLimit)

    await expect(reject({
      config: { method: 'get', url: '/data' },
      response: { status: 401 },
    })).rejects.toBe(rateLimit)
  })

  it('never refreshes or replays a non-idempotent request', async () => {
    const { upstream, reject, request } = upstreamFixture()

    await expect(reject({
      config: { method: 'post', url: '/workout' },
      response: { status: 401 },
    })).rejects.toEqual(expect.objectContaining({ status: 401 }))
    expect(upstream.exchange).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('prevents the real Garmin SDK from replaying a workout POST after HTTP 401', async () => {
    const context = {
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    }
    const client = new GarminClient(context as any, {
      username: 'fixture@example.test',
      password: 'fixture-password',
      sessionToken: JSON.stringify({
        oauth1: { oauth_token: 'one', oauth_token_secret: 'two' },
        oauth2: { access_token: 'expired' },
      }),
      region: 'global',
      cacheTtl: 0,
      requestTimeoutMs: 1_000,
      logLevel: 'error',
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-test',
    })
    const axiosClient = (client as any).gc.client.client
    let postCount = 0
    axiosClient.defaults.adapter = async (config: any) => {
      if (String(config.method).toLowerCase() === 'post') postCount += 1
      const error = Object.assign(new Error('raw response must not escape'), {
        config,
        response: {
          status: 401,
          data: { access_token: 'SECRET' },
          config,
          headers: {},
        },
      })
      throw error
    }

    await expect(client.addWorkout({ workoutName: 'No hidden replay' })).rejects.toThrow(
      'Garmin authentication expired before workout creation',
    )
    expect(postCount).toBe(1)
  })

  it('allows at most one real Axios replay for an idempotent request', async () => {
    const context = {
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    }
    const client = new GarminClient(context as any, {
      username: 'fixture@example.test',
      password: 'fixture-password',
      sessionToken: JSON.stringify({
        oauth1: { oauth_token: 'one', oauth_token_secret: 'two' },
        oauth2: { access_token: 'expired' },
      }),
      region: 'global',
      cacheTtl: 0,
      requestTimeoutMs: 1_000,
      logLevel: 'error',
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-test',
    })
    await client.connect()
    const upstream = (client as any).gc.client
    upstream.OAUTH_CONSUMER = { key: 'consumer', secret: 'secret' }
    upstream.exchange = jest.fn(async () => {
      upstream.oauth2Token = { access_token: 'fresh' }
    })
    let getCount = 0
    upstream.client.defaults.adapter = async (config: any) => {
      getCount += 1
      throw Object.assign(new Error('unauthorized'), {
        config,
        response: { status: 401, config, headers: {}, data: {} },
      })
    }

    await expect(upstream.client.get('/fixture')).rejects.toEqual(
      expect.objectContaining({ message: 'Garmin request failed (HTTP 401)', status: 401 }),
    )
    expect(getCount).toBe(2)
    expect(upstream.exchange).toHaveBeenCalledTimes(1)
  })
})
