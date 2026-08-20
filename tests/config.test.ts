describe('Config environment defaults', () => {
  const originalCacheTtl = process.env.GARMIN_CACHE_TTL
  const originalRequestTimeout = process.env.GARMIN_REQUEST_TIMEOUT_MS
  const originalUsername = process.env.GARMIN_USERNAME
  const originalPassword = process.env.GARMIN_PASSWORD
  const originalSessionToken = process.env.GARMIN_SESSION_TOKEN
  const originalRegion = process.env.GARMIN_REGION
  const originalLogLevel = process.env.GARMIN_LOG_LEVEL
  const originalActivityDetail = process.env.GARMIN_ACTIVITY_DETAIL

  beforeEach(() => {
    jest.resetModules()
    jest.doMock('dotenv', () => ({ config: jest.fn() }))
    jest.doMock('@deepseek-ai/schemastery', () => {
      const scalar = () => {
        let fallback: unknown
        let minimum: number | undefined
        const schema = ((value?: unknown) => {
          const resolved = value ?? fallback
          if (typeof resolved === 'number' && minimum !== undefined && resolved < minimum) {
            throw new TypeError(`Expected a value greater than or equal to ${minimum}`)
          }
          return resolved
        }) as any
        schema.default = (value: unknown) => {
          fallback = value
          return schema
        }
        schema.description = () => schema
        schema.role = () => schema
        schema.min = (value: number) => {
          minimum = value
          return schema
        }
        return schema
      }
      const z = {
        string: scalar,
        number: scalar,
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
    delete process.env.GARMIN_REGION
    delete process.env.GARMIN_LOG_LEVEL
    delete process.env.GARMIN_ACTIVITY_DETAIL
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
    if (originalRegion === undefined) delete process.env.GARMIN_REGION
    else process.env.GARMIN_REGION = originalRegion
    if (originalLogLevel === undefined) delete process.env.GARMIN_LOG_LEVEL
    else process.env.GARMIN_LOG_LEVEL = originalLogLevel
    if (originalActivityDetail === undefined) delete process.env.GARMIN_ACTIVITY_DETAIL
    else process.env.GARMIN_ACTIVITY_DETAIL = originalActivityDetail
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

  it('falls back safely when enum environment values are invalid', () => {
    process.env.GARMIN_REGION = 'mars'
    process.env.GARMIN_LOG_LEVEL = 'verbose'
    process.env.GARMIN_ACTIVITY_DETAIL = 'everything'
    const { Config } = require('../src/config') as typeof import('../src/config')

    expect(Config({})).toMatchObject({
      region: 'global',
      logLevel: 'info',
      activityDetail: 'compact',
    })
  })

  it('keeps environment credentials out of schema defaults', () => {
    process.env.GARMIN_USERNAME = 'environment-user'
    process.env.GARMIN_PASSWORD = 'environment-password'
    process.env.GARMIN_SESSION_TOKEN = 'environment-session'
    const { Config } = require('../src/config') as typeof import('../src/config')

    expect(Config({})).toMatchObject({
      username: '',
      password: '',
      sessionToken: '',
    })
  })

  it('resolves credentials at runtime with non-empty plugin values taking priority', () => {
    process.env.GARMIN_USERNAME = 'environment-user'
    process.env.GARMIN_PASSWORD = 'environment-password'
    process.env.GARMIN_SESSION_TOKEN = 'environment-session'
    const { Config, resolveConfig } = require('../src/config') as typeof import('../src/config')

    expect(resolveConfig(Config({ username: 'plugin-user' }))).toMatchObject({
      username: 'plugin-user',
      password: 'environment-password',
      sessionToken: 'environment-session',
    })
  })

  it('rejects negative cache TTLs and non-positive request timeouts from plugin config', () => {
    const { Config } = require('../src/config') as typeof import('../src/config')

    expect(() => Config({ cacheTtl: -1 })).toThrow()
    expect(() => Config({ requestTimeoutMs: 0 })).toThrow()
  })
})
