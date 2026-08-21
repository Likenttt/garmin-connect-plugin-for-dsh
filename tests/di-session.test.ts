import axios, { type AxiosRequestConfig } from 'axios'
import { resolve } from 'node:path'
import {
  GarminDiSessionRuntime,
  type GarminDiRefreshResult,
  type GarminDiSessionRuntimeDependencies,
} from '../src/di-session'
import {
  bindDiSessionTokensToAccount,
  GARMIN_DI_CLIENT_ID,
  type GarminDiSessionFile,
} from '../src/session-store'

const NOW_MS = 1_800_000_000_000

function session(overrides: Partial<GarminDiSessionFile['tokens']> = {}): GarminDiSessionFile {
  return bindDiSessionTokensToAccount({
    clientId: GARMIN_DI_CLIENT_ID,
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    accessExpiresAtMs: NOW_MS + 3_600_000,
    refreshExpiresAtMs: NOW_MS + 86_400_000,
    ...overrides,
  }, 'runner@example.test', 'global', 123456789)
}

function dependencies(
  overrides: Partial<GarminDiSessionRuntimeDependencies> = {},
): GarminDiSessionRuntimeDependencies {
  return {
    now: () => NOW_MS,
    refresh: jest.fn(),
    probeProfile: jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: { profileId: 123456789 },
    }),
    writeSession: jest.fn(),
    ...overrides,
  }
}

describe('GarminDiSessionRuntime', () => {
  it('sends the DI bearer only to the configured regional Connect API', async () => {
    const observed: AxiosRequestConfig[] = []
    const client = axios.create({
      adapter: async (config) => {
        observed.push(config)
        return {
          config,
          data: { ok: true },
          headers: { 'content-type': 'application/json' },
          status: 200,
          statusText: 'OK',
        }
      },
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session(),
      sessionPath: '/private/account/bearer-session.json',
      dependencies: dependencies(),
    })
    runtime.install(client)

    await client.get('https://connectapi.garmin.com/activitylist-service/activities')
    await client.get('https://example.test/must-not-receive-garmin-credentials')

    expect(observed[0]?.headers?.Authorization).toBe('Bearer access-secret')
    expect(observed[0]?.maxRedirects).toBe(0)
    expect(observed[1]?.headers?.Authorization).toBeUndefined()
  })

  it('rejects a DI session bound to another configured account', () => {
    expect(() => new GarminDiSessionRuntime({
      username: 'other@example.test',
      region: 'global',
      session: session(),
      sessionPath: '/private/account/account-mismatch-session.json',
      dependencies: dependencies(),
    })).toThrow('Garmin session token file does not match the configured account or region')
  })

  it('rejects a profile that does not match the DI session identity', () => {
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session(),
      sessionPath: '/private/account/profile-mismatch-session.json',
      dependencies: dependencies(),
    })

    expect(() => runtime.validateProfile({ profileId: 987654321 })).toThrow(
      'Garmin DI session does not match the authenticated Garmin profile',
    )
  })

  it('persists a strict refresh response before using a near-expiry access token', async () => {
    const events: string[] = []
    let requestAuthorization: unknown
    const refresh = jest.fn(async () => {
      events.push('refresh')
      return {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: {
          access_token: 'fresh-access-secret',
          refresh_token: 'rotated-refresh-secret',
          expires_in: 3_600,
          refresh_token_expires_in: 7_200,
        },
      }
    })
    const writeSession = jest.fn(async () => {
      events.push('write')
    })
    const probeProfile = jest.fn(async () => {
      events.push('probe')
      return {
        status: 200,
        contentType: 'application/json',
        body: { profileId: 123456789 },
      }
    })
    const client = axios.create({
      adapter: async (config) => {
        events.push('request')
        requestAuthorization = config.headers?.Authorization
        return {
          config,
          data: { ok: true },
          headers: {},
          status: 200,
          statusText: 'OK',
        }
      },
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: '/private/account/strict-refresh-session.json',
      dependencies: dependencies({ refresh, probeProfile, writeSession }),
    })
    runtime.install(client)

    await client.get('https://connectapi.garmin.com/userprofile-service/socialProfile')

    expect(events).toEqual(['refresh', 'probe', 'write', 'request'])
    expect(requestAuthorization).toBe('Bearer fresh-access-secret')
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: 'https://diauth.garmin.com/di-oauth2-service/oauth/token',
      body: 'grant_type=refresh_token&client_id=GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2&refresh_token=refresh-secret',
    }))
    expect(writeSession).toHaveBeenCalledWith('/private/account/strict-refresh-session.json', {
      ...session(),
      tokens: {
        accessToken: 'fresh-access-secret',
        refreshToken: 'rotated-refresh-secret',
        accessExpiresAtMs: NOW_MS + 3_600_000,
        refreshExpiresAtMs: NOW_MS + 7_200_000,
      },
    })
    expect(probeProfile).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'https://connectapi.garmin.com/userprofile-service/socialProfile',
      headers: expect.objectContaining({ Authorization: 'Bearer fresh-access-secret' }),
    }))
  })

  it('rejects malformed refresh data with a fixed error and no write', async () => {
    const writeSession = jest.fn()
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: '/private/account/malformed-refresh-session.json',
      dependencies: dependencies({
        refresh: jest.fn().mockResolvedValue({
          status: 200,
          contentType: 'application/json',
          body: {
            access_token: 'MALFORMED_SECRET_FRAGMENT',
            refresh_token: 'rotated-refresh-secret',
            expires_in: '3600',
          },
        }),
        writeSession,
      }),
    })
    const client = axios.create({
      adapter: async () => {
        throw new Error('request must not run')
      },
    })
    runtime.install(client)

    const request = client.get('https://connectapi.garmin.com/userprofile-service/socialProfile')
    await expect(request).rejects.toThrow('Garmin DI session could not be refreshed')
    await expect(request).rejects.not.toThrow('MALFORMED_SECRET_FRAGMENT')
    expect(writeSession).not.toHaveBeenCalled()
  })

  it('refreshes and replays a GET at most once after HTTP 401', async () => {
    let requestCount = 0
    const client = axios.create({
      adapter: async (config) => {
        requestCount += 1
        if (requestCount === 1) {
          throw {
            config,
            response: {
              status: 401,
              data: { access_token: 'RESPONSE_SECRET_MUST_NOT_ESCAPE' },
            },
          }
        }
        return {
          config,
          data: { ok: true },
          headers: {},
          status: 200,
          statusText: 'OK',
        }
      },
    })
    const refresh = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: 'fresh-access-secret',
        refresh_token: 'rotated-refresh-secret',
        expires_in: 3_600,
      },
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session(),
      sessionPath: '/private/account/get-401-session.json',
      dependencies: dependencies({ refresh }),
    })
    runtime.install(client)

    await expect(client.get('https://connectapi.garmin.com/activitylist-service/activities'))
      .resolves.toEqual(expect.objectContaining({ data: { ok: true } }))
    expect(requestCount).toBe(2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('never refreshes or replays a write after HTTP 401', async () => {
    let requestCount = 0
    const client = axios.create({
      adapter: async (config) => {
        requestCount += 1
        throw {
          config,
          response: {
            status: 401,
            data: { access_token: 'WRITE_RESPONSE_SECRET' },
          },
        }
      },
    })
    const refresh = jest.fn()
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session(),
      sessionPath: '/private/account/write-session.json',
      dependencies: dependencies({ refresh }),
    })
    runtime.install(client)

    const request = client.post(
      'https://connectapi.garmin.com/workout-service/workout',
      { workoutName: 'No replay' },
    )
    await expect(request).rejects.toEqual(expect.objectContaining({
      message: 'Garmin request failed (HTTP 401)',
      status: 401,
    }))
    await expect(request).rejects.not.toHaveProperty('response')
    expect(requestCount).toBe(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not persist or publish refreshed tokens for another Garmin profile', async () => {
    const writeSession = jest.fn()
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: '/private/account/refreshed-profile-mismatch-session.json',
      dependencies: dependencies({
        refresh: jest.fn().mockResolvedValue({
          status: 200,
          contentType: 'application/json',
          body: {
            access_token: 'fresh-access-secret',
            refresh_token: 'rotated-refresh-secret',
            expires_in: 3_600,
          },
        }),
        probeProfile: jest.fn().mockResolvedValue({
          status: 200,
          contentType: 'application/json',
          body: { profileId: 987654321 },
        }),
        writeSession,
      }),
    })
    const client = axios.create({
      adapter: async () => {
        throw new Error('business request must not run')
      },
    })
    runtime.install(client)

    await expect(client.get('https://connectapi.garmin.com/activitylist-service/activities'))
      .rejects.toThrow('Garmin DI session does not match the authenticated Garmin profile')
    expect(writeSession).not.toHaveBeenCalled()
  })

  it('refuses to share one live session path across different account bindings', () => {
    const sharedPath = '/private/shared-conflict/session.json'
    new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session(),
      sessionPath: sharedPath,
      dependencies: dependencies(),
    })
    const otherSession = bindDiSessionTokensToAccount({
      clientId: GARMIN_DI_CLIENT_ID,
      accessToken: 'other-access-secret',
      refreshToken: 'other-refresh-secret',
      accessExpiresAtMs: NOW_MS + 3_600_000,
      refreshExpiresAtMs: NOW_MS + 86_400_000,
    }, 'other@example.test', 'global', 987654321)

    expect(() => new GarminDiSessionRuntime({
      username: 'other@example.test',
      region: 'global',
      session: otherSession,
      sessionPath: sharedPath,
      dependencies: dependencies(),
    })).toThrow('Garmin DI session file cannot be shared across account bindings')
  })

  it('releases an idle path binding when its only runtime is invalidated', () => {
    const sharedPath = '/private/released-binding/session.json'
    const firstRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session(),
      sessionPath: sharedPath,
      dependencies: dependencies(),
    })
    firstRuntime.invalidate()
    const otherSession = bindDiSessionTokensToAccount({
      clientId: GARMIN_DI_CLIENT_ID,
      accessToken: 'other-access-secret',
      refreshToken: 'other-refresh-secret',
      accessExpiresAtMs: NOW_MS + 3_600_000,
      refreshExpiresAtMs: NOW_MS + 86_400_000,
    }, 'other@example.test', 'global', 987654321)

    expect(() => new GarminDiSessionRuntime({
      username: 'other@example.test',
      region: 'global',
      session: otherSession,
      sessionPath: sharedPath,
      dependencies: dependencies(),
    })).not.toThrow()
  })

  it('normalizes path aliases before enforcing the account binding', () => {
    const canonicalPath = '/private/alias-binding/session.json'
    new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session(),
      sessionPath: canonicalPath,
      dependencies: dependencies(),
    })
    const otherSession = bindDiSessionTokensToAccount({
      clientId: GARMIN_DI_CLIENT_ID,
      accessToken: 'other-access-secret',
      refreshToken: 'other-refresh-secret',
      accessExpiresAtMs: NOW_MS + 3_600_000,
      refreshExpiresAtMs: NOW_MS + 86_400_000,
    }, 'other@example.test', 'global', 987654321)

    expect(() => new GarminDiSessionRuntime({
      username: 'other@example.test',
      region: 'global',
      session: otherSession,
      sessionPath: '/private/alias-binding/nested/../session.json',
      dependencies: dependencies(),
    })).toThrow('Garmin DI session file cannot be shared across account bindings')
  })

  it('uses the normalized path for refreshed session writes', async () => {
    const writeSession = jest.fn()
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: 'fixtures/nested/../normalized-session.json',
      dependencies: dependencies({
        refresh: jest.fn().mockResolvedValue({
          status: 200,
          contentType: 'application/json',
          body: {
            access_token: 'normalized-access',
            refresh_token: 'normalized-refresh',
            expires_in: 3_600,
          },
        }),
        writeSession,
      }),
    })
    const client = axios.create({
      adapter: async config => ({
        config,
        data: {},
        headers: {},
        status: 200,
        statusText: 'OK',
      }),
    })
    runtime.install(client)

    await client.get('https://connectapi.garmin.com/activities')

    expect(writeSession).toHaveBeenCalledWith(
      resolve('fixtures/normalized-session.json'),
      expect.any(Object),
    )
  })

  it('shares the latest persisted session across runtimes with one path and binding', async () => {
    const sharedPath = '/private/shared-latest/session.json'
    const original = session({ accessExpiresAtMs: NOW_MS + 30_000 })
    const firstRefresh = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: 'shared-fresh-access',
        refresh_token: 'shared-rotated-refresh',
        expires_in: 3_600,
      },
    })
    const secondRefresh = jest.fn()
    const firstRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: original,
      sessionPath: sharedPath,
      dependencies: dependencies({ refresh: firstRefresh }),
    })
    const secondRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: original,
      sessionPath: sharedPath,
      dependencies: dependencies({ refresh: secondRefresh }),
    })
    let firstAuthorization: unknown
    let secondAuthorization: unknown
    const firstClient = axios.create({
      adapter: async config => {
        firstAuthorization = config.headers?.Authorization
        return { config, data: {}, headers: {}, status: 200, statusText: 'OK' }
      },
    })
    const secondClient = axios.create({
      adapter: async config => {
        secondAuthorization = config.headers?.Authorization
        return { config, data: {}, headers: {}, status: 200, statusText: 'OK' }
      },
    })
    firstRuntime.install(firstClient)
    secondRuntime.install(secondClient)

    await firstClient.get('https://connectapi.garmin.com/first')
    await secondClient.get('https://connectapi.garmin.com/second')

    expect(firstAuthorization).toBe('Bearer shared-fresh-access')
    expect(secondAuthorization).toBe('Bearer shared-fresh-access')
    expect(firstRefresh).toHaveBeenCalledTimes(1)
    expect(secondRefresh).not.toHaveBeenCalled()
  })

  it('shares one in-flight refresh across runtimes with one path and binding', async () => {
    let finishRefresh!: () => void
    const firstRefresh = jest.fn(() => new Promise<GarminDiRefreshResult>(resolveRefresh => {
      finishRefresh = () => resolveRefresh({
        status: 200,
        contentType: 'application/json',
        body: {
          access_token: 'concurrent-fresh-access',
          refresh_token: 'concurrent-rotated-refresh',
          expires_in: 3_600,
        },
      })
    }))
    const secondRefresh = jest.fn()
    const sharedPath = '/private/shared-inflight/session.json'
    const expiring = session({ accessExpiresAtMs: NOW_MS + 30_000 })
    const firstRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: expiring,
      sessionPath: sharedPath,
      dependencies: dependencies({ refresh: firstRefresh }),
    })
    const secondRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: expiring,
      sessionPath: sharedPath,
      dependencies: dependencies({ refresh: secondRefresh }),
    })
    const firstClient = axios.create({ adapter: async config => ({
      config, data: {}, headers: {}, status: 200, statusText: 'OK',
    }) })
    const secondClient = axios.create({ adapter: async config => ({
      config, data: {}, headers: {}, status: 200, statusText: 'OK',
    }) })
    firstRuntime.install(firstClient)
    secondRuntime.install(secondClient)

    const first = firstClient.get('https://connectapi.garmin.com/first')
    const second = secondClient.get('https://connectapi.garmin.com/second')
    await Promise.resolve()
    expect(firstRefresh).toHaveBeenCalledTimes(1)
    expect(secondRefresh).not.toHaveBeenCalled()
    finishRefresh()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(firstRefresh).toHaveBeenCalledTimes(1)
    expect(secondRefresh).not.toHaveBeenCalled()
  })

  it('does not rotate again when a late 401 used the previous shared access token', async () => {
    const sharedPath = '/private/shared-late-401/session.json'
    const original = session()
    const firstRefresh = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: 'late-401-fresh-access',
        refresh_token: 'late-401-rotated-refresh',
        expires_in: 3_600,
      },
    })
    const secondRefresh = jest.fn()
    const firstRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: original,
      sessionPath: sharedPath,
      dependencies: dependencies({ refresh: firstRefresh }),
    })
    const secondRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: original,
      sessionPath: sharedPath,
      dependencies: dependencies({ refresh: secondRefresh }),
    })
    let firstCalls = 0
    const firstClient = axios.create({ adapter: async config => {
      firstCalls += 1
      if (firstCalls === 1) throw { config, response: { status: 401, data: {} } }
      return { config, data: {}, headers: {}, status: 200, statusText: 'OK' }
    } })
    let secondCalls = 0
    let releaseLate401!: () => void
    const secondClient = axios.create({ adapter: config => {
      secondCalls += 1
      if (secondCalls === 1) {
        return new Promise((_resolve, reject) => {
          releaseLate401 = () => reject({ config, response: { status: 401, data: {} } })
        })
      }
      return Promise.resolve({
        config, data: {}, headers: {}, status: 200, statusText: 'OK',
      })
    } })
    firstRuntime.install(firstClient)
    secondRuntime.install(secondClient)

    const late = secondClient.get('https://connectapi.garmin.com/late')
    while (!releaseLate401) await Promise.resolve()
    await expect(firstClient.get('https://connectapi.garmin.com/first')).resolves.toEqual(
      expect.objectContaining({ status: 200 }),
    )
    releaseLate401()

    await expect(late).resolves.toEqual(expect.objectContaining({ status: 200 }))
    expect(firstRefresh).toHaveBeenCalledTimes(1)
    expect(secondRefresh).not.toHaveBeenCalled()
    expect(firstCalls).toBe(2)
    expect(secondCalls).toBe(2)
  })

  it('permanently expires a runtime after an exact invalid_grant refresh response', async () => {
    const refresh = jest.fn().mockResolvedValue({
      status: 400,
      contentType: 'application/json',
      body: {
        error: 'invalid_grant',
        error_description: 'PRIVATE_REFRESH_TOKEN_FRAGMENT',
      },
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: '/private/permanent-invalid-grant/session.json',
      dependencies: dependencies({ refresh }),
    })
    const client = axios.create({
      adapter: async () => {
        throw new Error('business request must not run')
      },
    })
    runtime.install(client)

    const first = client.get('https://connectapi.garmin.com/first')
    await expect(first).rejects.toThrow(
      'Garmin DI session has expired; run garmin-connect-auth login --browser again',
    )
    await expect(first).rejects.not.toThrow('PRIVATE_REFRESH_TOKEN_FRAGMENT')
    await expect(client.get('https://connectapi.garmin.com/second')).rejects.toThrow(
      'Garmin DI session has expired; run garmin-connect-auth login --browser again',
    )
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 401, error: 'anything', label: 'HTTP 401' },
    { status: 403, error: 'anything', label: 'HTTP 403' },
    { status: 400, error: 'invalid_token', label: 'invalid_token' },
    { status: 400, error: 'invalid_client', label: 'invalid_client' },
  ])('permanently rejects refresh after $label without retrying', async ({
    status,
    error,
    label,
  }) => {
    const refresh = jest.fn().mockResolvedValue({
      status,
      contentType: 'application/json',
      body: { error, detail: 'PRIVATE_REJECTION_BODY' },
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: `/private/permanent-${label.replaceAll(' ', '-')}/session.json`,
      dependencies: dependencies({ refresh }),
    })
    const client = axios.create({ adapter: async () => {
      throw new Error('business request must not run')
    } })
    runtime.install(client)

    const first = client.get('https://connectapi.garmin.com/first')
    await expect(first).rejects.toThrow(
      error === 'invalid_token'
        ? 'Garmin DI session has expired; run garmin-connect-auth login --browser again'
        : 'Garmin DI session was rejected; run garmin-connect-auth login --browser again',
    )
    await expect(first).rejects.not.toThrow('PRIVATE_REJECTION_BODY')
    await expect(client.get('https://connectapi.garmin.com/second')).rejects.toThrow(
      /Garmin DI session (?:has expired|was rejected)/,
    )
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      label: 'HTTP 429',
      failure: { status: 429, contentType: 'application/json', body: { error: 'rate_limited' } },
    },
    {
      label: 'HTTP 500',
      failure: { status: 500, contentType: 'application/json', body: { error: 'server_error' } },
    },
    {
      label: 'non-exact invalid grant',
      failure: {
        status: 400,
        contentType: 'application/json',
        body: { error: 'invalid_grant_retryable' },
      },
    },
    { label: 'network error', failure: new Error('PRIVATE_NETWORK_DETAIL') },
  ])('keeps $label refresh failures transient', async ({ label, failure }) => {
    const refresh = jest.fn()
    if (failure instanceof Error) refresh.mockRejectedValueOnce(failure)
    else refresh.mockResolvedValueOnce(failure)
    refresh.mockResolvedValueOnce({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: 'recovered-access',
        refresh_token: 'recovered-refresh',
        expires_in: 3_600,
      },
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: `/private/transient-${label.replaceAll(' ', '-')}/session.json`,
      dependencies: dependencies({ refresh }),
    })
    const client = axios.create({
      adapter: async config => ({
        config,
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      }),
    })
    runtime.install(client)

    await expect(client.get('https://connectapi.garmin.com/first')).rejects.toThrow(
      'Garmin DI session could not be refreshed',
    )
    await expect(client.get('https://connectapi.garmin.com/second')).resolves.toEqual(
      expect.objectContaining({ data: { ok: true } }),
    )
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('persists a verified rotated token but blocks business use after concurrent invalidate', async () => {
    let finishRefresh!: () => void
    const refresh = jest.fn(() => new Promise<GarminDiRefreshResult>((resolveRefresh) => {
      finishRefresh = () => resolveRefresh({
        status: 200,
        contentType: 'application/json',
        body: {
          access_token: 'verified-rotated-access',
          refresh_token: 'verified-rotated-refresh',
          expires_in: 3_600,
        },
      })
    }))
    const probeProfile = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: { profileId: 123456789 },
    })
    const writeSession = jest.fn()
    let businessRequests = 0
    const client = axios.create({
      adapter: async config => {
        businessRequests += 1
        return { config, data: {}, headers: {}, status: 200, statusText: 'OK' }
      },
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: '/private/invalidate-during-refresh/session.json',
      dependencies: dependencies({ refresh, probeProfile, writeSession }),
    })
    runtime.install(client)

    const request = client.get('https://connectapi.garmin.com/activitylist-service/activities')
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
    runtime.invalidate()
    finishRefresh()

    await expect(request).rejects.toThrow(
      'Garmin DI session was rejected; run garmin-connect-auth login --browser again',
    )
    expect(probeProfile).toHaveBeenCalledTimes(1)
    expect(writeSession).toHaveBeenCalledWith(
      '/private/invalidate-during-refresh/session.json',
      expect.objectContaining({
        tokens: expect.objectContaining({ accessToken: 'verified-rotated-access' }),
      }),
    )
    expect(businessRequests).toBe(0)
  })

  it('rejects an in-flight Connect API success that returns after invalidate', async () => {
    let finishRequest!: () => void
    let requestDispatched = false
    const client = axios.create({
      adapter: config => new Promise(resolveResponse => {
        requestDispatched = true
        finishRequest = () => resolveResponse({
          config,
          data: { privateHealthData: 'PRIVATE_SUCCESS_BODY' },
          headers: {},
          status: 200,
          statusText: 'OK',
        })
      }),
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session(),
      sessionPath: '/private/invalidate-after-dispatch/session.json',
      dependencies: dependencies(),
    })
    runtime.install(client)

    const request = client.get('https://connectapi.garmin.com/activitylist-service/activities')
    while (!requestDispatched) await Promise.resolve()
    runtime.invalidate()
    finishRequest()

    await expect(request).rejects.toThrow(
      'Garmin DI session was rejected; run garmin-connect-auth login --browser again',
    )
    await expect(request).rejects.not.toThrow('PRIVATE_SUCCESS_BODY')
  })

  it('keeps the current refresh token when Garmin does not rotate it', async () => {
    const writeSession = jest.fn()
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({
        accessExpiresAtMs: NOW_MS + 30_000,
        refreshExpiresAtMs: null,
      }),
      sessionPath: '/private/account/no-rotation-session.json',
      dependencies: dependencies({
        refresh: jest.fn().mockResolvedValue({
          status: 200,
          contentType: 'application/json',
          body: {
            access_token: 'fresh-access-secret',
            expires_in: 3_600,
          },
        }),
        writeSession,
      }),
    })
    const client = axios.create({
      adapter: async config => ({
        config,
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: 'OK',
      }),
    })
    runtime.install(client)

    await client.get('https://connectapi.garmin.com/activitylist-service/activities')

    expect(writeSession).toHaveBeenCalledWith(
      '/private/account/no-rotation-session.json',
      expect.objectContaining({
        tokens: expect.objectContaining({
          refreshToken: 'refresh-secret',
          refreshExpiresAtMs: null,
        }),
      }),
    )
  })

  it('retries atomic persistence without reusing an already-rotated refresh token', async () => {
    const refresh = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: 'fresh-access-secret',
        refresh_token: 'rotated-refresh-secret',
        expires_in: 3_600,
      },
    })
    const writeSession = jest.fn()
      .mockRejectedValueOnce(new Error('disk path and token must not escape'))
      .mockResolvedValueOnce(undefined)
    let requestAuthorization: unknown
    const client = axios.create({
      adapter: async config => {
        requestAuthorization = config.headers?.Authorization
        return {
          config,
          data: { ok: true },
          headers: {},
          status: 200,
          statusText: 'OK',
        }
      },
    })
    const runtime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: session({ accessExpiresAtMs: NOW_MS + 30_000 }),
      sessionPath: '/private/account/persistence-retry-session.json',
      dependencies: dependencies({ refresh, writeSession }),
    })
    runtime.install(client)

    await expect(client.get('https://connectapi.garmin.com/activitylist-service/activities'))
      .rejects.toThrow('Garmin DI session could not be persisted')
    await expect(client.get('https://connectapi.garmin.com/activitylist-service/activities'))
      .resolves.toEqual(expect.objectContaining({ data: { ok: true } }))

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(writeSession).toHaveBeenCalledTimes(2)
    expect(requestAuthorization).toBe('Bearer fresh-access-secret')
  })

  it('shares a verified pending write across runtimes without another refresh', async () => {
    const sharedPath = '/private/shared-pending/session.json'
    const expiring = session({ accessExpiresAtMs: NOW_MS + 30_000 })
    const firstRefresh = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: 'pending-shared-access',
        refresh_token: 'pending-shared-refresh',
        expires_in: 3_600,
      },
    })
    const firstRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: expiring,
      sessionPath: sharedPath,
      dependencies: dependencies({
        refresh: firstRefresh,
        writeSession: jest.fn().mockRejectedValue(new Error('disk unavailable')),
      }),
    })
    const secondRefresh = jest.fn()
    const secondWrite = jest.fn().mockResolvedValue(undefined)
    const secondRuntime = new GarminDiSessionRuntime({
      username: 'runner@example.test',
      region: 'global',
      session: expiring,
      sessionPath: sharedPath,
      dependencies: dependencies({ refresh: secondRefresh, writeSession: secondWrite }),
    })
    const firstClient = axios.create({ adapter: async () => {
      throw new Error('first business request must not run')
    } })
    let secondAuthorization: unknown
    const secondClient = axios.create({ adapter: async config => {
      secondAuthorization = config.headers?.Authorization
      return { config, data: {}, headers: {}, status: 200, statusText: 'OK' }
    } })
    firstRuntime.install(firstClient)
    secondRuntime.install(secondClient)

    await expect(firstClient.get('https://connectapi.garmin.com/first')).rejects.toThrow(
      'Garmin DI session could not be persisted',
    )
    await expect(secondClient.get('https://connectapi.garmin.com/second')).resolves.toEqual(
      expect.objectContaining({ status: 200 }),
    )

    expect(firstRefresh).toHaveBeenCalledTimes(1)
    expect(secondRefresh).not.toHaveBeenCalled()
    expect(secondWrite).toHaveBeenCalledWith(
      sharedPath,
      expect.objectContaining({
        tokens: expect.objectContaining({ accessToken: 'pending-shared-access' }),
      }),
    )
    expect(secondAuthorization).toBe('Bearer pending-shared-access')
  })
})
