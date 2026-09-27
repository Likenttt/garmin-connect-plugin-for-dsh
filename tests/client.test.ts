import type { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminConnect } from 'garmin-connect'
import { GarminClient } from '../src/client'
import type { Config } from '../src/config'
import {
  bindDiSessionTokensToAccount,
  bindSessionTokensToAccount,
  GARMIN_DI_CLIENT_ID,
} from '../src/session-store'
import { MAX_ZIP_BYTES } from '../src/fit-export'
import {
  GarminAuthenticationRequiredError,
  PublicToolError,
} from '../src/utils/errors'

jest.mock('garmin-connect', () => ({
  GarminConnect: jest.fn().mockImplementation(() => {
    const interceptorManager = {
      clear: jest.fn(),
      use: jest.fn(),
    }
    return {
    client: {
      client: {
        defaults: {},
        interceptors: {
          request: { ...interceptorManager },
          response: { ...interceptorManager },
        },
        request: jest.fn(),
      },
    },
    login: jest.fn().mockResolvedValue(undefined),
    loadToken: jest.fn(),
    exportToken: jest.fn(),
    getActivities: jest.fn(),
    getSteps: jest.fn(),
    getSleepData: jest.fn(),
    getHeartRate: jest.fn(),
    getDailyWeightData: jest.fn(),
    getWorkouts: jest.fn(),
    downloadOriginalActivityData: jest.fn(),
    addWorkout: jest.fn(),
    getUserProfile: jest.fn(),
  }}),
}))

type MockGarmin = {
  client: {
    client: {
      defaults: { timeout?: number; maxContentLength?: number }
      interceptors: {
        request: { clear: jest.Mock; use: jest.Mock }
        response: { clear: jest.Mock; use: jest.Mock }
      }
      request: jest.Mock
    }
  }
  login: jest.Mock
  loadToken: jest.Mock
  exportToken: jest.Mock
  getActivities: jest.Mock
  getSteps: jest.Mock
  getSleepData: jest.Mock
  getHeartRate: jest.Mock
  getDailyWeightData: jest.Mock
  getWorkouts: jest.Mock
  downloadOriginalActivityData: jest.Mock
  addWorkout: jest.Mock
  getUserProfile: jest.Mock
}

const baseConfig: Config = {
  username: 'runner@example.test',
  password: 'password-value',
  sessionToken: '',
  sessionTokenFile: '',
  region: 'global',
  cacheTtl: 0,
  logLevel: 'info',
  activityDetail: 'compact',
  fitDownloadDir: '/tmp/garmin-fit-client-test-output',
}

function createContext() {
  return {
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as unknown as Context
}

function latestGarmin(): MockGarmin {
  const constructor = GarminConnect as unknown as jest.Mock
  return constructor.mock.results.at(-1)?.value as MockGarmin
}

const temporaryDirectories: string[] = []

async function createSessionFile(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'garmin-session-test-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'session.json')
  await writeFile(path, source, { encoding: 'utf8', mode: 0o600 })
  return path
}

async function createEmptySessionPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'garmin-session-test-'))
  temporaryDirectories.push(directory)
  return join(directory, 'session.json')
}

function createDiSession(
  username = 'runner@example.test',
  region: 'global' | 'cn' = 'global',
  profileId = 123456789,
) {
  return bindDiSessionTokensToAccount({
    clientId: GARMIN_DI_CLIENT_ID,
    accessToken: 'di-access-secret',
    refreshToken: 'di-refresh-secret',
    accessExpiresAtMs: Date.now() + 3_600_000,
    refreshExpiresAtMs: Date.now() + 86_400_000,
  }, username, region, profileId)
}

describe('GarminClient', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => (
      rm(directory, { recursive: true, force: true })
    )))
  })

  it('still fails fast without a username outside embedded-auth mode', () => {
    expect(() => new GarminClient(createContext(), {
      ...baseConfig,
      username: '',
    })).toThrow('Garmin username is required')
  })

  it('still fails fast without credentials outside embedded-auth mode', () => {
    expect(() => new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile: '',
    })).toThrow('Garmin password, session token, or session token file is required')
  })

  it('loads without a username so the local auth UI can report configuration', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      username: '',
    }, { allowUnconfigured: true })

    await expect(client.connect()).rejects.toThrow('Garmin username is required')
  })

  it('loads without credentials so embedded authentication can initialize', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile: '',
    }, { allowUnconfigured: true })

    const operation = client.connect()
    await expect(operation).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'missing',
    })
    await expect(operation).rejects.toThrow(
      'garmin-connect-auth serve --account <alias> --region <global|cn> --open',
    )
    expect(client.getAuthenticationRequirement()).toEqual({
      reason: 'missing',
      region: 'global',
      revision: 1,
    })

    await expect(client.connect()).rejects.toMatchObject({ reason: 'missing' })
    expect(client.getAuthenticationRequirement()).toEqual({
      reason: 'missing',
      region: 'global',
      revision: 1,
    })
  })

  it('turns explicit upstream MFA evidence into browser-recoverable authentication', async () => {
    const sessionTokenFile = await createEmptySessionPath()
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionTokenFile,
    }, { allowUnconfigured: true })
    latestGarmin().login.mockImplementation(async () => {
      ;(latestGarmin().client as any).handleMFA(
        '<form action="/sso/verifyMFA/loginEnterMfaCode"></form>',
      )
    })

    const operation = client.connect()
    await expect(operation).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'challenge',
    })
    await expect(operation).rejects.toThrow('garmin-connect-auth serve')
    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    expect(client.getAuthenticationRequirement()).toEqual({
      reason: 'challenge',
      region: 'global',
      revision: 1,
    })
  })

  it('turns a Cloudflare managed challenge into browser-recoverable authentication', async () => {
    const sessionTokenFile = await createEmptySessionPath()
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionTokenFile,
    }, { allowUnconfigured: true })
    latestGarmin().login.mockImplementation(async () => {
      ;(latestGarmin().client as any).handleMFA(
        '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>',
      )
    })

    await expect(client.connect()).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'challenge',
    })
    expect(client.getAuthenticationRequirement()).toEqual({
      reason: 'challenge',
      region: 'global',
      revision: 1,
    })
  })

  it.each([
    [
      'the pinned SDK no-ticket error',
      new Error('login failed (Ticket not found or MFA), please check username and password'),
    ],
    [
      'an HTTP 401 password response',
      Object.assign(new Error('private upstream response'), { status: 401 }),
    ],
    ['a network error', new Error('private network detail')],
  ])('does not infer browser authentication from %s', async (_label, failure) => {
    const sessionTokenFile = await createEmptySessionPath()
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionTokenFile,
    }, { allowUnconfigured: true })
    latestGarmin().login.mockRejectedValue(failure)

    const operation = client.connect()
    await expect(operation).rejects.toBeInstanceOf(PublicToolError)
    await expect(operation).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    await expect(operation).rejects.toThrow(
      'Garmin password sign-in did not complete; check email, region, and password',
    )
    expect(client.getAuthenticationRequirement()).toBeUndefined()
  })

  it('publishes the configured account only after password authentication succeeds', async () => {
    const client = new GarminClient(createContext(), baseConfig)

    expect(client.getAuthenticatedAccount()).toBeUndefined()
    await client.connect()
    expect(client.getAuthenticatedAccount()).toEqual({
      email: 'runner@example.test',
      region: 'global',
    })
  })

  it('rejects an in-flight response after the client is deactivated', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    await client.connect()
    let finishRequest!: (value: unknown[]) => void
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    latestGarmin().getActivities.mockImplementation(() => {
      requestStarted()
      return new Promise<unknown[]>(resolve => { finishRequest = resolve })
    })

    const pending = client.getActivities()
    await started
    client.deactivate()
    finishRequest([{ account: 'old-account' }])

    await expect(pending).rejects.toThrow(
      'Garmin authentication changed while the request was in flight',
    )
    expect(client.getAuthenticatedAccount()).toBeUndefined()
    expect(client.getAuthenticationRequirement()).toBeUndefined()
    await expect(client.getActivities()).rejects.toThrow(
      'Garmin authentication changed while the request was in flight',
    )
  })

  it('cannot publish a successful login after deactivation', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    let finishLogin!: () => void
    let loginStarted!: () => void
    const started = new Promise<void>(resolve => { loginStarted = resolve })
    latestGarmin().login.mockImplementation(() => {
      loginStarted()
      return new Promise<void>(resolve => { finishLogin = resolve })
    })

    const pending = client.connect()
    await started
    client.deactivate()
    finishLogin()

    await expect(pending).rejects.toThrow(
      'Garmin authentication changed while the request was in flight',
    )
    expect(client.getAuthenticatedAccount()).toBeUndefined()
  })

  it('accepts a newly persisted DI session after an earlier missing-file failure', async () => {
    const sessionTokenFile = await createEmptySessionPath()
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })

    const missing = client.connect()
    await expect(missing).rejects.toBeInstanceOf(GarminAuthenticationRequiredError)
    await expect(missing).rejects.toMatchObject({ reason: 'missing' })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })

    await client.replacePersistedSession(() => writeFile(
      sessionTokenFile,
      JSON.stringify(createDiSession()),
      { encoding: 'utf8', mode: 0o600 },
    ))
    expect(client.getAuthenticatedAccount()).toEqual({
      email: 'runner@example.test',
      region: 'global',
    })
    expect(client.getAuthenticationRequirement()).toBeUndefined()
    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)
  })

  it('hot-loads a DI session written by a separate auth process after a missing-file failure', async () => {
    const sessionTokenFile = await createEmptySessionPath()
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })

    await expect(client.connect()).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'missing',
    })
    await writeFile(sessionTokenFile, JSON.stringify(createDiSession()), {
      encoding: 'utf8',
      mode: 0o600,
    })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)
    expect(client.getAuthenticatedAccount()).toEqual({
      email: 'runner@example.test',
      region: 'global',
    })
  })

  it('hot-loads an atomically replaced DI session after the previous file is rejected', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ profileId: 123456789 })

    await expect(client.connect()).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'rejected',
    })
    const replacementPath = `${sessionTokenFile}.replacement`
    await writeFile(replacementPath, JSON.stringify(createDiSession()), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(replacementPath, sessionTokenFile)

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(2)
  })

  it('loads the changed session snapshot even if the file is replaced again before restore', async () => {
    const rejectedSession = createDiSession(
      'runner@example.test',
      'global',
      111111111,
    )
    const replacementSession = createDiSession(
      'runner@example.test',
      'global',
      222222222,
    )
    const sessionTokenFile = await createSessionFile(JSON.stringify(rejectedSession))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ profileId: 222222222 })

    await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })
    await writeFile(sessionTokenFile, JSON.stringify(replacementSession), {
      encoding: 'utf8',
      mode: 0o600,
    })
    const internals = client as unknown as {
      acceptChangedSessionFile: () => Promise<void>
    }
    const acceptChangedSessionFile = internals.acceptChangedSessionFile.bind(client)
    internals.acceptChangedSessionFile = async () => {
      await acceptChangedSessionFile()
      await writeFile(sessionTokenFile, JSON.stringify(rejectedSession), {
        encoding: 'utf8',
        mode: 0o600,
      })
    }

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(2)
  })

  it('hot-loads an externally replaced file after a live DI session expires', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile
      .mockResolvedValueOnce({ profileId: 123456789 })
      .mockResolvedValueOnce({ profileId: 987654321 })
    latestGarmin().getActivities
      .mockRejectedValueOnce(new GarminAuthenticationRequiredError('expired'))
      .mockResolvedValueOnce([{ activityId: 42 }])

    await expect(client.getActivities()).rejects.toMatchObject({ reason: 'expired' })
    await writeFile(sessionTokenFile, JSON.stringify(createDiSession(
      'runner@example.test',
      'global',
      987654321,
    )), {
      encoding: 'utf8',
      mode: 0o600,
    })

    await expect(client.getActivities()).resolves.toEqual([{ activityId: 42 }])
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(2)
  })

  it('does not retry an unchanged rejected DI session file', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile.mockRejectedValue(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    )

    await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })
    await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'malformed'] as const)(
    'preserves the old rejection across an interim %s session file',
    async interimState => {
      const rejectedSession = createDiSession()
      const sessionTokenFile = await createSessionFile(JSON.stringify(rejectedSession))
      const client = new GarminClient(createContext(), {
        ...baseConfig,
        password: '',
        sessionToken: '',
        sessionTokenFile,
      })
      latestGarmin().getUserProfile.mockRejectedValue(
        Object.assign(new Error('unauthorized'), { status: 401 }),
      )

      await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })
      if (interimState === 'missing') await rm(sessionTokenFile)
      else await writeFile(sessionTokenFile, '{"broken":true}', { encoding: 'utf8' })

      await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })
      await writeFile(sessionTokenFile, JSON.stringify(rejectedSession), {
        encoding: 'utf8',
        mode: 0o600,
      })
      await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })
      expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    {
      label: 'another account',
      session: createDiSession('other@example.test'),
    },
    {
      label: 'an expired refresh token',
      session: {
        ...createDiSession(),
        tokens: {
          ...createDiSession().tokens,
          refreshExpiresAtMs: Date.now() - 1,
        },
      },
    },
  ])('preserves the old rejection across a locally unusable $label session', async ({
    session,
  }) => {
    const rejectedSession = createDiSession()
    const sessionTokenFile = await createSessionFile(JSON.stringify(rejectedSession))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValue({ profileId: 123456789 })

    await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })
    await writeFile(sessionTokenFile, JSON.stringify(session), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })

    await writeFile(sessionTokenFile, JSON.stringify(rejectedSession), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await expect(client.connect()).rejects.toMatchObject({ reason: 'rejected' })
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)
  })

  it('hot-loads a newly written session file after an inline token is rejected', async () => {
    const sessionTokenFile = await createEmptySessionPath()
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
      sessionTokenFile,
    })
    latestGarmin().getSleepData.mockRejectedValueOnce(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    )

    await expect(client.getSleep('2026-08-20')).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'rejected',
    })
    await writeFile(sessionTokenFile, JSON.stringify({
      oauth1: { other: 'unbound-account' },
      oauth2: {},
    }), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await expect(client.connect()).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'rejected',
    })
    expect(latestGarmin().loadToken).toHaveBeenCalledTimes(1)
    expect(latestGarmin().getUserProfile).not.toHaveBeenCalled()

    await writeFile(sessionTokenFile, JSON.stringify(createDiSession()), {
      encoding: 'utf8',
      mode: 0o600,
    })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().loadToken).toHaveBeenCalledTimes(1)
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)
    expect(client.getAuthenticatedAccount()).toEqual({
      email: 'runner@example.test',
      region: 'global',
    })
  })

  it('rejects an unsafe missing-session destination before requesting browser auth', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(join(tmpdir(), 'garmin-session-test-'))
    temporaryDirectories.push(parent)
    await chmod(parent, 0o755)
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile: join(parent, 'session.json'),
    })

    const operation = client.connect()
    await expect(operation).rejects.toBeInstanceOf(PublicToolError)
    await expect(operation).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    await expect(operation).rejects.toThrow(
      'Garmin session token destination could not be prepared',
    )
    expect(latestGarmin().getUserProfile).not.toHaveBeenCalled()
    expect(latestGarmin().login).not.toHaveBeenCalled()
  })

  it('blocks new Garmin work until a replacement session commit finishes', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })
    await client.connect()

    let finishWrite!: () => void
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve })
    const replacement = client.replacePersistedSession(async () => {
      markWriteStarted()
      await new Promise<void>(resolve => { finishWrite = resolve })
      await writeFile(sessionTokenFile, JSON.stringify(createDiSession()), {
        encoding: 'utf8',
        mode: 0o600,
      })
    })
    await writeStarted

    const profile = client.getUserProfile()
    await Promise.resolve()
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)

    finishWrite()
    await expect(replacement).resolves.toBeUndefined()
    await expect(profile).resolves.toEqual({ profileId: 123456789 })
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(3)
  })

  it('releases the replacement barrier and reloads the old file after write failure', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })
    await client.connect()

    await expect(client.replacePersistedSession(async () => {
      throw new Error('replacement write failed')
    })).rejects.toThrow('replacement write failed')

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(2)
  })

  it('loads a session token file when no inline token or password is configured', async () => {
    const tokens = {
      oauth1: { oauth_token: 'oauth-one' },
      oauth2: { access_token: 'oauth-two' },
    }
    const sessionTokenFile = await createSessionFile(JSON.stringify(tokens))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionTokenFile,
    })

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().loadToken).toHaveBeenCalledWith(tokens.oauth1, tokens.oauth2)
    expect(latestGarmin().login).not.toHaveBeenCalled()
    expect(client.getAuthenticatedAccount()).toBeUndefined()
  })

  it('loads a profile-bound DI session without password or legacy OAuth', async () => {
    const diSession = createDiSession()
    const sessionTokenFile = await createSessionFile(JSON.stringify(diSession))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })

    await expect(client.connect()).resolves.toBeUndefined()
    expect(client.getAuthenticatedAccount()).toEqual({
      email: 'runner@example.test',
      region: 'global',
    })
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
    expect(latestGarmin().login).not.toHaveBeenCalled()
  })

  it('rejects a DI session with an expired refresh token before probing the profile', async () => {
    const current = createDiSession()
    const expiredRefreshSession = {
      ...current,
      tokens: {
        ...current.tokens,
        accessExpiresAtMs: Date.now() + 3_600_000,
        refreshExpiresAtMs: Date.now() - 1,
      },
    }
    const sessionTokenFile = await createSessionFile(JSON.stringify(expiredRefreshSession))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })

    await expect(client.connect()).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'expired',
    })
    expect(latestGarmin().getUserProfile).not.toHaveBeenCalled()
    expect(latestGarmin().login).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTP 500', Object.assign(new Error('private server response'), { status: 500 })],
    ['a network failure', new Error('private network detail')],
  ])('does not reject a valid DI session after %s during its profile probe', async (
    _case,
    transientError,
  ) => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ profileId: 123456789 })

    const first = client.connect()
    await expect(first).rejects.toBe(transientError)
    await expect(first).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(2)
    expect(latestGarmin().login).not.toHaveBeenCalled()
  })

  it('does not apply one outer timeout across the DI refresh and profile chain', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionTokenFile,
      requestTimeoutMs: 10,
    })
    latestGarmin().getUserProfile.mockImplementation(() => new Promise(resolveProfile => {
      setTimeout(() => resolveProfile({ profileId: 123456789 }), 30)
    }))

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(1)
  })

  it('never falls back to password after a DI GET remains unauthorized', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: 'must-not-be-used-for-di',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })
    latestGarmin().getActivities.mockRejectedValue(
      Object.assign(new Error('raw response secret'), { status: 401 }),
    )

    await expect(client.getActivities()).rejects.toThrow(
      'Garmin DI session was rejected; run ' +
        'garmin-connect-auth serve --account <alias> --region <global|cn> --open',
    )
    expect(client.getAuthenticatedAccount()).toBeUndefined()
    expect(latestGarmin().login).not.toHaveBeenCalled()
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
  })

  it('never falls back to password for an obsolete DI session file', async () => {
    const obsoleteSession = {
      ...createDiSession(),
      schemaVersion: 1,
    }
    const sessionTokenFile = await createSessionFile(JSON.stringify(obsoleteSession))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: 'must-not-be-used-for-obsolete-di',
      sessionTokenFile,
    })

    const operation = client.connect()
    await expect(operation).rejects.toBeInstanceOf(PublicToolError)
    await expect(operation).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    await expect(operation).rejects.toThrow(
      'Garmin DI session format is obsolete; run ' +
        'garmin-connect-auth serve --account <alias> --region <global|cn> --open',
    )
    expect(latestGarmin().login).not.toHaveBeenCalled()
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
  })

  it('never falls back to password for a malformed current DI session file', async () => {
    const malformedSession = {
      ...createDiSession(),
      tokens: {
        ...createDiSession().tokens,
        refreshToken: '',
      },
    }
    const sessionTokenFile = await createSessionFile(JSON.stringify(malformedSession))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: 'must-not-be-used-for-malformed-di',
      sessionTokenFile,
    })

    const operation = client.connect()
    await expect(operation).rejects.toBeInstanceOf(PublicToolError)
    await expect(operation).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    await expect(operation).rejects.toThrow('Garmin session token file is invalid')
    expect(latestGarmin().login).not.toHaveBeenCalled()
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
  })

  it('keeps a malformed legacy file as a local configuration error', async () => {
    const sessionTokenFile = await createSessionFile('{"oauth1":{},"broken":"marker"}')
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionTokenFile,
    })

    const operation = client.connect()
    await expect(operation).rejects.toBeInstanceOf(PublicToolError)
    await expect(operation).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    await expect(operation).rejects.toThrow('Garmin session token file is invalid')
    const retry = client.connect()
    await expect(retry).rejects.toBeInstanceOf(PublicToolError)
    await expect(retry).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    expect(latestGarmin().login).not.toHaveBeenCalled()
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
  })

  it('keeps a malformed inline session as a local configuration error', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '{"oauth1":{},"broken":"marker"}',
      sessionTokenFile: '',
    })

    const operation = client.connect()
    await expect(operation).rejects.toBeInstanceOf(PublicToolError)
    await expect(operation).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    await expect(operation).rejects.toThrow('Garmin inline session token is invalid')
    expect(latestGarmin().login).not.toHaveBeenCalled()
  })

  it('does not refresh, reject, or password-fallback a DI session after HTTP 403', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: 'must-not-be-used-for-di',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile.mockResolvedValue({ profileId: 123456789 })
    latestGarmin().getActivities
      .mockRejectedValueOnce(Object.assign(new Error('forbidden body'), { status: 403 }))
      .mockResolvedValueOnce([{ activityId: 42 }])

    await expect(client.getActivities()).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    )
    await expect(client.getActivities()).resolves.toEqual([{ activityId: 42 }])
    expect(latestGarmin().login).not.toHaveBeenCalled()
  })

  it('rejects a session file bound to another account before loading its tokens', async () => {
    const session = bindSessionTokensToAccount(
      { oauth1: { oauth_token: 'other' }, oauth2: { access_token: 'other' } },
      'other@example.test',
      'global',
    )
    const sessionTokenFile = await createSessionFile(JSON.stringify(session))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionTokenFile,
    })

    const operation = client.connect()
    await expect(operation).rejects.toThrow(
      'Garmin session token file does not match the configured account or region',
    )
    await expect(operation).rejects.toBeInstanceOf(PublicToolError)
    await expect(operation).rejects.not.toBeInstanceOf(
      GarminAuthenticationRequiredError,
    )
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
  })

  it('prefers an explicit session token over the configured token file', async () => {
    const inlineTokens = {
      oauth1: { oauth_token: 'inline-oauth-one' },
      oauth2: { access_token: 'inline-oauth-two' },
    }
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: JSON.stringify(inlineTokens),
      sessionTokenFile: '/private/SHOULD_NOT_BE_READ/session.json',
    })

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().loadToken).toHaveBeenCalledWith(
      inlineTokens.oauth1,
      inlineTokens.oauth2,
    )
  })

  it('falls back to password without logging malformed token-file content or its path', async () => {
    const context = createContext()
    const sessionTokenFile = await createSessionFile(
      '{"oauth1":{"secret":"TOP_SECRET_FILE_FRAGMENT"}',
    )
    const client = new GarminClient(context, {
      ...baseConfig,
      sessionTokenFile,
    })

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    const logged = Object.values(context.logger)
      .flatMap(logger => (logger as unknown as jest.Mock).mock.calls)
      .flat().map(String).join(' ')
    expect(logged).not.toContain('TOP_SECRET_FILE_FRAGMENT')
    expect(logged).not.toContain(sessionTokenFile)
  })

  it('suppresses info logs when the configured threshold is error', async () => {
    const context = createContext()
    const client = new GarminClient(context, { ...baseConfig, logLevel: 'error' })

    await client.connect()

    expect(context.logger.info).not.toHaveBeenCalled()
  })

  it('keeps an in-flight login single-flight when a stale refresh is discarded', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    let finishLogin!: () => void
    latestGarmin().login.mockImplementation(() => new Promise<void>(resolve => {
      finishLogin = resolve
    }))

    const first = client.connect()
    await Promise.resolve()
    ;(client as any).discardStaleRefresh()
    const second = client.connect()

    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    finishLogin()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it('normalizes numeric step totals with the requested calendar date', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().getSteps.mockResolvedValue(12_345)

    await expect(client.getSteps('2026-08-20')).resolves.toEqual({
      calendarDate: '2026-08-20',
      totalSteps: 12_345,
    })
  })

  it('passes YYYY-MM-DD inputs to Garmin as local-midnight dates', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().getSleepData.mockResolvedValue({})

    await client.getSleep('2026-08-20')

    const requestedDate = latestGarmin().getSleepData.mock.calls[0][0] as Date
    expect([
      requestedDate.getFullYear(),
      requestedDate.getMonth() + 1,
      requestedDate.getDate(),
      requestedDate.getHours(),
    ]).toEqual([2026, 8, 20, 0])
  })

  it('maps the China region to the garmin.cn SDK domain', () => {
    new GarminClient(createContext(), { ...baseConfig, region: 'cn' })

    expect(GarminConnect).toHaveBeenCalledWith({
      username: 'runner@example.test',
      password: 'password-value',
    }, 'garmin.cn')
  })

  it('caps buffered Garmin responses before an oversized ZIP can fill memory', () => {
    new GarminClient(createContext(), baseConfig)

    expect(latestGarmin().client.client.defaults.maxContentLength).toBe(MAX_ZIP_BYTES)
  })

  it('reconnects when the SDK preserves HTTP 401 only in a wrapped message', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().getSleepData
      .mockRejectedValueOnce(new Error(
        'Error in getSleepData: ERROR: (401), Unauthorized, {"message":"expired"}',
      ))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: '2026-08-20' } })

    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: '2026-08-20' },
    })
  })

  it('backs off and retries idempotent reads when the SDK reports HTTP 429', async () => {
    jest.useFakeTimers()
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().getSleepData
      .mockRejectedValueOnce(new Error('ERROR: (429), Too Many Requests, {}'))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: '2026-08-20' } })

    const request = client.getSleep('2026-08-20')
    await jest.runAllTimersAsync()

    await expect(request).resolves.toEqual({
      dailySleepDTO: { calendarDate: '2026-08-20' },
    })
    expect(latestGarmin().getSleepData).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it('downloads an original activity ZIP through the authenticated read boundary', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().downloadOriginalActivityData.mockResolvedValue(undefined)

    await expect(client.downloadOriginalActivityZip(42, '/private/tmp/garmin-fit-download'))
      .resolves.toBe('/private/tmp/garmin-fit-download/42.zip')

    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    expect(latestGarmin().downloadOriginalActivityData).toHaveBeenCalledWith(
      { activityId: 42 },
      '/private/tmp/garmin-fit-download',
      'zip',
    )
  })

  it('retries a rate-limited original activity ZIP download because it is a GET', async () => {
    jest.useFakeTimers()
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().downloadOriginalActivityData
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockResolvedValueOnce(undefined)

    const request = client.downloadOriginalActivityZip(42, '/private/tmp/garmin-fit-download')
    await jest.runAllTimersAsync()

    await expect(request).resolves.toBe('/private/tmp/garmin-fit-download/42.zip')
    expect(latestGarmin().downloadOriginalActivityData).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it('applies the configured request timeout to original activity ZIP downloads', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      requestTimeoutMs: 10,
    })
    latestGarmin().downloadOriginalActivityData.mockReturnValue(new Promise(() => {}))

    await expect(client.downloadOriginalActivityZip(
      42,
      '/private/tmp/garmin-fit-download',
    )).rejects.toThrow('Garmin activity download timed out after 10ms')
    expect(latestGarmin().downloadOriginalActivityData).toHaveBeenCalledTimes(1)
  })

  it('falls back to password login after a restored session token is rejected', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    latestGarmin().getSleepData
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: '2026-08-20' } })

    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: '2026-08-20' },
    })
    expect(latestGarmin().loadToken).toHaveBeenCalledTimes(1)
    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
  })

  it('falls back to password without logging malformed session-token fragments', async () => {
    const context = createContext()
    const malformedToken = 'SUPERSECRET_TOKEN_NOT_JSON'
    const client = new GarminClient(context, {
      ...baseConfig,
      sessionToken: malformedToken,
    })

    await expect(client.connect()).resolves.toBeUndefined()
    expect(latestGarmin().loadToken).not.toHaveBeenCalled()
    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    const logged = (context.logger.warn as unknown as jest.Mock).mock.calls
      .flat().map(String).join(' ')
    expect(logged).not.toContain(malformedToken)
    expect(logged).not.toContain('SUPERSECRE')
  })

  it('clears cached health data when token auth falls back to password auth', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      cacheTtl: 300,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    latestGarmin().getSleepData
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'account-a' } })
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'account-b-new-day' } })
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'account-b-original-day' } })

    await expect(client.getSleep('2026-08-19')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'account-a' },
    })
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'account-b-new-day' },
    })
    await expect(client.getSleep('2026-08-19')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'account-b-original-day' },
    })
    expect(latestGarmin().getSleepData).toHaveBeenCalledTimes(4)
  })

  it('does not return an old-token response after another request switches identity', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    let resolveOld!: (value: unknown) => void
    let markOldStarted!: () => void
    const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve })
    latestGarmin().getSleepData
      .mockImplementationOnce(() => {
        markOldStarted()
        return new Promise(resolve => { resolveOld = resolve })
      })
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'password-new-day' } })
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'password-original-day' } })

    const oldRequest = client.getSleep('2026-08-19')
    await oldStarted
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'password-new-day' },
    })
    resolveOld({ dailySleepDTO: { calendarDate: 'token-account' } })

    await expect(oldRequest).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'password-original-day' },
    })
  })

  it('does not publish a stale auth challenge after another request switches identity', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    let rejectOld!: (error: unknown) => void
    let markOldStarted!: () => void
    const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve })
    latestGarmin().getSleepData
      .mockImplementationOnce(() => {
        markOldStarted()
        return new Promise((_resolve, reject) => { rejectOld = reject })
      })
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'password-new-day' } })
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'password-original-day' } })

    const oldRequest = client.getSleep('2026-08-19')
    await oldStarted
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'password-new-day' },
    })
    rejectOld(new GarminAuthenticationRequiredError('expired'))

    await expect(oldRequest).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'password-original-day' },
    })
    expect(client.getAuthenticationRequirement()).toBeUndefined()
  })

  it('fails once with an actionable error when a token-only session is rejected', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    latestGarmin().getSleepData.mockRejectedValue(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    )

    const operation = client.getSleep('2026-08-20')
    await expect(operation).rejects.toMatchObject({
      name: 'GarminAuthenticationRequiredError',
      reason: 'rejected',
    })
    await expect(operation).rejects.toThrow(
      'garmin-connect-auth serve --account <alias> --region <global|cn> --open',
    )
    expect(latestGarmin().getSleepData).toHaveBeenCalledTimes(1)
    expect(latestGarmin().login).not.toHaveBeenCalled()
  })

  it('rejects a Garmin request that exceeds the configured timeout', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      requestTimeoutMs: 10,
    })
    await client.connect()
    latestGarmin().getActivities.mockReturnValue(new Promise(() => {}))

    const request = client.getActivities()
    const guard = new Promise<string>(resolve => {
      setTimeout(() => resolve('request did not time out'), 50)
    })

    await expect(Promise.race([request, guard])).rejects.toThrow(
      'Garmin request timed out after 10ms',
    )
  })

  it('detaches a timed-out cached read so a later request can recover', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      cacheTtl: 300,
      requestTimeoutMs: 10,
    })
    latestGarmin().getSleepData
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'recovered' } })

    await expect(client.getSleep('2026-08-20')).rejects.toThrow(
      'Garmin request timed out after 10ms',
    )
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'recovered' },
    })
    expect(latestGarmin().getSleepData).toHaveBeenCalledTimes(2)
  })

  it('logs a sanitized login failure without credentials or authorization data', async () => {
    const context = createContext()
    const client = new GarminClient(context, baseConfig)
    latestGarmin().login.mockRejectedValue(new Error(
      'Login failed for runner@example.test password=password-value Authorization: Bearer token-value',
    ))

    await expect(client.connect()).rejects.toThrow(
      'Garmin password sign-in did not complete; check email, region, and password',
    )

    const errorLogger = context.logger.error as unknown as jest.Mock
    const logged = errorLogger.mock.calls.flat().map(String).join(' ')
    expect(logged).not.toContain('runner@example.test')
    expect(logged).not.toContain('password-value')
    expect(logged).not.toContain('token-value')
  })

  it('replaces the SDK HTTP error logger with a normalized non-sensitive error', () => {
    new GarminClient(createContext(), baseConfig)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const response = {
      status: 500,
      statusText: 'Server Error',
      data: {
        email: 'private@example.test',
        access_token: 'secret-token',
      },
    }

    let thrown: unknown
    try {
      ;(latestGarmin().client as any).handleHttpError(response)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      message: 'Garmin request failed (HTTP 500)',
      status: 500,
    }))
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('reconnects when an expired cache refresh receives HTTP 401', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const client = new GarminClient(createContext(), { ...baseConfig, cacheTtl: 1 })
    latestGarmin().getSleepData
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'old' } })
      .mockRejectedValueOnce(new Error('ERROR: (401), Unauthorized, {}'))
      .mockResolvedValueOnce({ dailySleepDTO: { calendarDate: 'fresh' } })

    await client.getSleep('2026-08-20')
    now.mockReturnValue(2_001)
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'fresh' },
    })
    now.mockRestore()
  })

  it('does not retry a workout creation rejected with HTTP 429', async () => {
    jest.useFakeTimers()
    const client = new GarminClient(createContext(), baseConfig)
    const rateLimitError = Object.assign(new Error('rate limited'), { status: 429 })
    latestGarmin().addWorkout.mockRejectedValue(rateLimitError)

    const request = client.addWorkout({ workoutName: 'Single write' })
    const rejection = expect(request).rejects.toBe(rateLimitError)
    await jest.runAllTimersAsync()

    await rejection
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it('marks a rejected session token after a workout write receives HTTP 401', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      sessionToken: JSON.stringify({ oauth1: {}, oauth2: {} }),
    })
    latestGarmin().addWorkout.mockRejectedValueOnce(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    )
    latestGarmin().getSleepData.mockResolvedValueOnce({
      dailySleepDTO: { calendarDate: 'password-account' },
    })

    await expect(client.addWorkout({ workoutName: 'Auth boundary' })).rejects.toThrow()
    await expect(client.getSleep('2026-08-20')).resolves.toEqual({
      dailySleepDTO: { calendarDate: 'password-account' },
    })

    expect(latestGarmin().loadToken).toHaveBeenCalledTimes(1)
    expect(latestGarmin().login).toHaveBeenCalledTimes(1)
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit workout retry after hot-loading an externally replaced DI session', async () => {
    const sessionTokenFile = await createSessionFile(JSON.stringify(createDiSession()))
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      password: '',
      sessionToken: '',
      sessionTokenFile,
    })
    latestGarmin().getUserProfile
      .mockResolvedValueOnce({ profileId: 123456789 })
      .mockResolvedValueOnce({ profileId: 987654321 })
    latestGarmin().addWorkout
      .mockRejectedValueOnce(new GarminAuthenticationRequiredError('expired'))
      .mockResolvedValueOnce({ workoutId: 42 })

    await expect(client.addWorkout({ workoutName: 'Explicit retry' }))
      .rejects.toMatchObject({ reason: 'expired' })
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
    await writeFile(sessionTokenFile, JSON.stringify(createDiSession(
      'runner@example.test',
      'global',
      987654321,
    )), {
      encoding: 'utf8',
      mode: 0o600,
    })

    await expect(client.addWorkout({ workoutName: 'Explicit retry' }))
      .resolves.toEqual({ workoutId: 42 })
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(2)
    expect(latestGarmin().getUserProfile).toHaveBeenCalledTimes(2)
  })

  it('does not retry a workout creation that times out', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      requestTimeoutMs: 10,
    })
    latestGarmin().addWorkout.mockReturnValue(new Promise(() => {}))

    await expect(client.addWorkout({ workoutName: 'Timed write' })).rejects.toThrow(
      'outcome is unknown; check the Garmin workout library before retrying',
    )
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
  })

  it('keeps the unknown-outcome warning for an Axios-level write timeout', async () => {
    const client = new GarminClient(createContext(), baseConfig)
    latestGarmin().addWorkout.mockRejectedValue(
      Object.assign(new Error('Garmin request failed'), { timedOut: true }),
    )

    await expect(client.addWorkout({ workoutName: 'Axios timeout' })).rejects.toThrow(
      'outcome is unknown; check the Garmin workout library before retrying',
    )
    expect(latestGarmin().addWorkout).toHaveBeenCalledTimes(1)
  })

  it('invalidates the workout-list cache before a write with an unknown outcome', async () => {
    const client = new GarminClient(createContext(), {
      ...baseConfig,
      cacheTtl: 300,
      requestTimeoutMs: 10,
    })
    latestGarmin().getWorkouts
      .mockResolvedValueOnce([{ workoutName: 'before-write' }])
      .mockResolvedValueOnce([{ workoutName: 'after-unknown-write' }])
    latestGarmin().addWorkout.mockReturnValue(new Promise(() => {}))

    await expect(client.getWorkouts()).resolves.toEqual([{ workoutName: 'before-write' }])
    await expect(client.addWorkout({ workoutName: 'May exist' })).rejects.toThrow(
      'outcome is unknown',
    )
    await expect(client.getWorkouts()).resolves.toEqual([
      { workoutName: 'after-unknown-write' },
    ])
    expect(latestGarmin().getWorkouts).toHaveBeenCalledTimes(2)
  })
})
