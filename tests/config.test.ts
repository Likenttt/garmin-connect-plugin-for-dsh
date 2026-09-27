import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Config environment defaults', () => {
  const originalCacheTtl = process.env.GARMIN_CACHE_TTL
  const originalRequestTimeout = process.env.GARMIN_REQUEST_TIMEOUT_MS
  const originalUsername = process.env.GARMIN_USERNAME
  const originalPassword = process.env.GARMIN_PASSWORD
  const originalSessionToken = process.env.GARMIN_SESSION_TOKEN
  const originalSessionTokenFile = process.env.GARMIN_SESSION_TOKEN_FILE
  const originalRegion = process.env.GARMIN_REGION
  const originalLogLevel = process.env.GARMIN_LOG_LEVEL
  const originalActivityDetail = process.env.GARMIN_ACTIVITY_DETAIL
  const originalFitDownloadDir = process.env.GARMIN_FIT_DOWNLOAD_DIR
  const originalAccount = process.env.GARMIN_ACCOUNT

  beforeEach(() => {
    jest.resetModules()
    jest.doMock('dotenv', () => ({ config: jest.fn() }))
    jest.doMock('@deepseek-ai/schemastery', () => {
      const scalar = () => {
        let fallback: unknown
        let minimum: number | undefined
        let maximum: number | undefined
        let volatile = false
        const schema = ((value?: unknown) => {
          const resolved = value ?? fallback
          if (typeof resolved === 'number' && minimum !== undefined && resolved < minimum) {
            throw new TypeError(`Expected a value greater than or equal to ${minimum}`)
          }
          if ((typeof resolved === 'number' || Array.isArray(resolved))
            && maximum !== undefined
            && (Array.isArray(resolved) ? resolved.length : resolved) > maximum) {
            throw new TypeError(`Expected a value no greater than ${maximum}`)
          }
          return volatile ? { get: () => resolved } : resolved
        }) as any
        schema.default = (value: unknown) => {
          fallback = value
          return schema
        }
        schema.description = () => schema
        schema.role = () => schema
        schema.volatile = () => {
          volatile = true
          return schema
        }
        schema.min = (value: number) => {
          minimum = value
          return schema
        }
        schema.max = (value: number) => {
          maximum = value
          return schema
        }
        return schema
      }
      const z = {
        string: scalar,
        boolean: scalar,
        number: scalar,
        array: scalar,
        union: scalar,
        object: (fields: Record<string, (value?: unknown) => unknown>) =>
          (input: Record<string, unknown> = {}) => Object.fromEntries(
            Object.entries(fields).map(([key, schema]) => [key, schema(input[key])]),
          ),
      }
      return { __esModule: true, default: z }
    })
    delete process.env.GARMIN_CACHE_TTL
    delete process.env.GARMIN_REQUEST_TIMEOUT_MS
    delete process.env.GARMIN_USERNAME
    delete process.env.GARMIN_PASSWORD
    delete process.env.GARMIN_SESSION_TOKEN
    delete process.env.GARMIN_SESSION_TOKEN_FILE
    delete process.env.GARMIN_REGION
    delete process.env.GARMIN_LOG_LEVEL
    delete process.env.GARMIN_ACTIVITY_DETAIL
    delete process.env.GARMIN_FIT_DOWNLOAD_DIR
    delete process.env.GARMIN_ACCOUNT
  })

  afterAll(() => {
    if (originalCacheTtl === undefined) delete process.env.GARMIN_CACHE_TTL
    else process.env.GARMIN_CACHE_TTL = originalCacheTtl
    if (originalRequestTimeout === undefined) delete process.env.GARMIN_REQUEST_TIMEOUT_MS
    else process.env.GARMIN_REQUEST_TIMEOUT_MS = originalRequestTimeout
    if (originalUsername === undefined) delete process.env.GARMIN_USERNAME
    else process.env.GARMIN_USERNAME = originalUsername
    if (originalPassword === undefined) delete process.env.GARMIN_PASSWORD
    else process.env.GARMIN_PASSWORD = originalPassword
    if (originalSessionToken === undefined) delete process.env.GARMIN_SESSION_TOKEN
    else process.env.GARMIN_SESSION_TOKEN = originalSessionToken
    if (originalSessionTokenFile === undefined) delete process.env.GARMIN_SESSION_TOKEN_FILE
    else process.env.GARMIN_SESSION_TOKEN_FILE = originalSessionTokenFile
    if (originalRegion === undefined) delete process.env.GARMIN_REGION
    else process.env.GARMIN_REGION = originalRegion
    if (originalLogLevel === undefined) delete process.env.GARMIN_LOG_LEVEL
    else process.env.GARMIN_LOG_LEVEL = originalLogLevel
    if (originalActivityDetail === undefined) delete process.env.GARMIN_ACTIVITY_DETAIL
    else process.env.GARMIN_ACTIVITY_DETAIL = originalActivityDetail
    if (originalFitDownloadDir === undefined) delete process.env.GARMIN_FIT_DOWNLOAD_DIR
    else process.env.GARMIN_FIT_DOWNLOAD_DIR = originalFitDownloadDir
    if (originalAccount === undefined) delete process.env.GARMIN_ACCOUNT
    else process.env.GARMIN_ACCOUNT = originalAccount
    jest.dontMock('dotenv')
    jest.dontMock('@deepseek-ai/schemastery')
  })

  it('allows GARMIN_CACHE_TTL=0 to disable caching', () => {
    process.env.GARMIN_CACHE_TTL = '0'
    const { Config } = require('../src/config') as typeof import('../src/config')

    expect(Config({}).cacheTtl).toBe(0)
  })

  it('reads a finite request timeout from GARMIN_REQUEST_TIMEOUT_MS', () => {
    process.env.GARMIN_REQUEST_TIMEOUT_MS = '4321'
    const { Config } = require('../src/config') as typeof import('../src/config')

    expect(Config({}).requestTimeoutMs).toBe(4321)
  })

  it('defaults activity detail to full and accepts explicit compact choices', () => {
    const { Config } = require('../src/config') as typeof import('../src/config')

    expect(Config({}).activityDetail).toBe('full')
    expect(Config({ activityDetail: 'compact' }).activityDetail).toBe('compact')
  })

  it('accepts GARMIN_ACTIVITY_DETAIL=compact as an environment default', () => {
    process.env.GARMIN_ACTIVITY_DETAIL = 'compact'
    const { Config } = require('../src/config') as typeof import('../src/config')

    expect(Config({}).activityDetail).toBe('compact')
  })

  it('falls back safely when enum environment values are invalid', () => {
    process.env.GARMIN_REGION = 'mars'
    process.env.GARMIN_LOG_LEVEL = 'verbose'
    process.env.GARMIN_ACTIVITY_DETAIL = 'everything'
    const { Config, resolveConfig } = require('../src/config') as typeof import('../src/config')

    expect(resolveConfig(Config({}))).toMatchObject({
      region: 'global',
      logLevel: 'info',
      activityDetail: 'full',
    })
  })

  it('keeps environment credentials out of schema defaults', () => {
    process.env.GARMIN_USERNAME = 'environment-user'
    process.env.GARMIN_PASSWORD = 'environment-password'
    process.env.GARMIN_SESSION_TOKEN = 'environment-session'
    process.env.GARMIN_SESSION_TOKEN_FILE = '/private/session-token.json'
    const { Config } = require('../src/config') as typeof import('../src/config')

    const parsed = Config({})
    expect(parsed.username.get()).toBe('')
    expect(parsed.region.get()).toBe('global')
    expect(parsed).toMatchObject({
      password: '',
      sessionToken: '',
      sessionTokenFile: '',
    })
  })

  it('resolves credentials at runtime with non-empty plugin values taking priority', () => {
    process.env.GARMIN_USERNAME = 'environment-user'
    process.env.GARMIN_PASSWORD = 'environment-password'
    process.env.GARMIN_SESSION_TOKEN = 'environment-session'
    process.env.GARMIN_SESSION_TOKEN_FILE = '/environment/session-token.json'
    const { Config, resolveConfig } = require('../src/config') as typeof import('../src/config')

    expect(resolveConfig(Config({ username: 'plugin-user' }))).toMatchObject({
      username: 'plugin-user',
      password: 'environment-password',
      sessionToken: 'environment-session',
      sessionTokenFile: '/environment/session-token.json',
    })
  })

  it('reads the latest account references while leaving install-time email optional', () => {
    const { Config, resolveConfig } = require('../src/config') as typeof import('../src/config')
    const parsed = Config({})
    expect(resolveConfig(parsed).username).toBe('')

    let email = 'first@example.test'
    let region: 'global' | 'cn' = 'global'
    const refs = {
      ...parsed,
      username: { get: () => email },
      region: { get: () => region },
    }
    expect(resolveConfig(refs)).toMatchObject({
      username: 'first@example.test',
      region: 'global',
    })
    email = 'second@example.test'
    region = 'cn'
    expect(resolveConfig(refs)).toMatchObject({
      username: 'second@example.test',
      region: 'cn',
    })
  })

  it('maps a legacy account to its original region and keeps the other slot isolated', () => {
    const { Config, resolveAccountConfigs } = require('../src/config') as typeof import('../src/config')
    const accounts = resolveAccountConfigs(Config({
      username: 'legacy@example.test',
      region: 'cn',
      password: 'legacy-password',
      sessionToken: 'legacy-token',
      sessionTokenFile: '/private/legacy.session.json',
    }))

    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      accountId: 'legacy-cn', slot: 1, region: 'cn', configured: true,
      config: {
        username: 'legacy@example.test', region: 'cn',
        password: 'legacy-password', sessionToken: 'legacy-token',
        sessionTokenFile: '/private/legacy.session.json',
      },
    })
  })

  it('keeps a legacy inline token available when a configured session file is damaged', () => {
    const { Config, resolveAccountConfigs } = require('../src/config') as typeof import('../src/config')
    const directory = mkdtempSync(join(tmpdir(), 'garmin-legacy-token-test-'))
    const sessionPath = join(directory, 'session.json')
    try {
      const parsed = Config({
        username: 'legacy@example.test', region: 'cn',
        sessionToken: 'legacy-inline-token', sessionTokenFile: sessionPath,
      })
      expect(resolveAccountConfigs(parsed)[0].config.sessionToken).toBe('legacy-inline-token')
      writeFileSync(sessionPath, '{}', { mode: 0o600 })
      expect(resolveAccountConfigs(parsed)[0].config.sessionToken).toBe('legacy-inline-token')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('lets explicit empty slots suppress legacy fallback and never shares credentials with another email', () => {
    const { Config, resolveAccountConfigs } = require('../src/config') as typeof import('../src/config')
    const accounts = resolveAccountConfigs(Config({
      username: 'old@example.test', region: 'cn', password: 'old-password',
      sessionTokenFile: '/private/old.session.json',
      cnConfigured: true, cnUsername: '',
      globalConfigured: true, globalUsername: 'new@example.test', globalAlias: 'Travel',
    }))

    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      accountId: 'legacy-global', slot: 2, configured: true, alias: 'Travel',
      config: { username: 'new@example.test', region: 'global', password: '', sessionToken: '' },
    })
    expect(accounts[0].config.sessionTokenFile).not.toBe('/private/old.session.json')
  })

  it('supports two separate accounts in one region with opaque IDs and independent sessions', () => {
    const { Config, resolveAccountConfigs } = require('../src/config') as typeof import('../src/config')
    const accounts = resolveAccountConfigs(Config({
      accountsConfigured: true,
      accounts: [
        { id: 'a11111111111111111111', region: 'cn', alias: 'Morning', slot: 1 },
        { id: 'a22222222222222222222', region: 'cn', alias: 'Evening', slot: 3 },
      ],
      account1UsernameId: 'a11111111111111111111',
      account1Username: 'morning@example.test',
      account3UsernameId: 'a22222222222222222222',
      account3Username: 'evening@example.test',
    }))

    expect(accounts.map(account => [account.accountId, account.region, account.slot]))
      .toEqual([
        ['a11111111111111111111', 'cn', 1],
        ['a22222222222222222222', 'cn', 3],
      ])
    expect(accounts.every(account => account.configured)).toBe(true)
    expect(accounts[0].config.sessionTokenFile).not.toBe(accounts[1].config.sessionTokenFile)
    expect(accounts[0].config.password).toBe('')
    expect(accounts[1].config.sessionToken).toBe('')
  })

  it('does not resurrect deleted legacy accounts or reuse a stale email after slot reuse', () => {
    const { Config, resolveAccountConfigs } = require('../src/config') as typeof import('../src/config')
    expect(resolveAccountConfigs(Config({
      username: 'legacy@example.test', region: 'cn',
      accountsConfigured: true, accounts: [],
    }))).toEqual([])

    const accounts = resolveAccountConfigs(Config({
      accountsConfigured: true,
      accounts: [{ id: 'anewid', region: 'cn', alias: '', slot: 1 }],
      account1UsernameId: 'adeletedid',
      account1Username: 'deleted@example.test',
    }))
    expect(accounts).toMatchObject([{
      accountId: 'anewid', configured: false, config: { username: '' },
    }])
  })

  it('preserves a migrated legacy email but isolates its session when the region changes', () => {
    const { Config, resolveAccountConfigs } = require('../src/config') as typeof import('../src/config')
    const [account] = resolveAccountConfigs(Config({
      username: 'legacy@example.test', region: 'cn',
      password: 'old-password', sessionTokenFile: '/private/legacy.session.json',
      accountsConfigured: true,
      accounts: [{ id: 'legacy-cn', region: 'global', alias: 'Travel', slot: 1 }],
    }))
    expect(account).toMatchObject({
      accountId: 'legacy-cn', region: 'global', configured: true,
      config: { username: 'legacy@example.test', region: 'global', password: '' },
    })
    expect(account.config.sessionTokenFile).not.toBe('/private/legacy.session.json')
  })

  it('uses a different session path when a dynamic account changes regions', () => {
    const { Config, resolveAccountConfigs } = require('../src/config') as typeof import('../src/config')
    const id = 'a33333333333333333333'
    const base = {
      accountsConfigured: true,
      account1UsernameId: id,
      account1Username: 'runner@example.test',
    }
    const [cn] = resolveAccountConfigs(Config({
      ...base,
      accounts: [{ id, region: 'cn', alias: '', slot: 1 }],
    }))
    const [global] = resolveAccountConfigs(Config({
      ...base,
      accounts: [{ id, region: 'global', alias: '', slot: 1 }],
    }))
    expect(cn.configured).toBe(true)
    expect(global.configured).toBe(true)
    expect(cn.config.sessionTokenFile).not.toBe(global.config.sessionTokenFile)
  })

  it('rejects more than five accounts and duplicate IDs or slots', () => {
    const { Config, resolveAccountConfigs } = require('../src/config') as typeof import('../src/config')
    const item = (id: string, slot: number) => ({ id, slot, region: 'cn' as const, alias: '' })
    expect(() => Config({
      accountsConfigured: true,
      accounts: [1, 2, 3, 4, 5, 6].map(number => item(`a${number}`, number)),
    })).toThrow()
    expect(() => resolveAccountConfigs(Config({
      accountsConfigured: true,
      accounts: [item('a1', 1), item('a1', 2)],
    }))).toThrow('invalid or duplicate')
    expect(() => resolveAccountConfigs(Config({
      accountsConfigured: true,
      accounts: [item('a1', 1), item('a2', 1)],
    }))).toThrow('invalid or duplicate')
  })

  it('prefers a non-empty plugin session-token file path over the environment', () => {
    process.env.GARMIN_SESSION_TOKEN_FILE = '/environment/session-token.json'
    const { Config, resolveConfig } = require('../src/config') as typeof import('../src/config')

    expect(resolveConfig(Config({
      username: 'plugin-user',
      sessionTokenFile: '/plugin/session-token.json',
    })).sessionTokenFile).toBe('/plugin/session-token.json')
  })

  it('leaves FIT downloads disabled until the user selects a directory', () => {
    const { resolveFitDownloadDir } = require('../src/config') as typeof import('../src/config')

    expect(resolveFitDownloadDir('', '/private/home')).toBe('')
    expect(resolveFitDownloadDir('~/private-fit', '/private/home'))
      .toBe('/private/home/private-fit')
  })

  it('lets GARMIN_FIT_DOWNLOAD_DIR supply an absolute runtime destination', () => {
    process.env.GARMIN_FIT_DOWNLOAD_DIR = '/private/garmin-fit'
    const { Config, resolveConfig } = require('../src/config') as typeof import('../src/config')

    expect(resolveConfig(Config({})).fitDownloadDir).toBe('/private/garmin-fit')
  })

  it('rejects negative cache TTLs and non-positive request timeouts from plugin config', () => {
    const { Config } = require('../src/config') as typeof import('../src/config')

    expect(() => Config({ cacheTtl: -1 })).toThrow()
    expect(() => Config({ requestTimeoutMs: 0 })).toThrow()
  })
})
