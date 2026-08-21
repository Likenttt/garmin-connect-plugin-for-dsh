import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindDiSessionTokensToAccount,
  bindSessionTokensToAccount,
  readSessionTokenFile,
  sessionFileMatchesAccount,
} from '../src/session-store'

describe('session token file store', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => (
      rm(directory, { recursive: true, force: true })
    )))
  })

  async function sessionPath(source: string | Buffer, mode = 0o600): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'garmin-session-read-test-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'session.json')
    await writeFile(path, source, { mode })
    if (process.platform !== 'win32') await chmod(path, mode)
    return path
  }

  it('loads an exact oauth1/oauth2 token object from an owner-only regular file', async () => {
    const tokens = {
      oauth1: { oauth_token: 'oauth-one' },
      oauth2: { access_token: 'oauth-two' },
    }
    const path = await sessionPath(JSON.stringify(tokens))

    await expect(readSessionTokenFile(path)).resolves.toEqual(tokens)
  })

  it('binds new session files to a username hash and region without storing the email', () => {
    const session = bindSessionTokensToAccount(
      { oauth1: {}, oauth2: {} },
      'Runner@Example.COM',
      'cn',
    )

    expect(JSON.stringify(session)).not.toContain('Runner@Example.COM')
    expect(session.account).toEqual({
      usernameHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      region: 'cn',
    })
    expect(sessionFileMatchesAccount(session, 'runner@example.com', 'cn')).toBe(true)
    expect(sessionFileMatchesAccount(session, 'other@example.com', 'cn')).toBe(false)
    expect(sessionFileMatchesAccount(session, 'runner@example.com', 'global')).toBe(false)
  })

  it('loads a strictly shaped DI session bound to the browser account and region', async () => {
    const session = bindDiSessionTokensToAccount({
      accessToken: 'di-access-token',
      refreshToken: 'di-refresh-token',
      clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      accessExpiresAtMs: 1_800_000_000_000,
      refreshExpiresAtMs: 1_900_000_000_000,
    }, 'Runner@Example.COM', 'cn')
    const path = await sessionPath(JSON.stringify(session))

    await expect(readSessionTokenFile(path)).resolves.toEqual(session)
    expect(session).toEqual({
      kind: 'di-oauth',
      schemaVersion: 1,
      clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      tokens: {
        accessToken: 'di-access-token',
        refreshToken: 'di-refresh-token',
        accessExpiresAtMs: 1_800_000_000_000,
        refreshExpiresAtMs: 1_900_000_000_000,
      },
      account: {
        usernameHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        region: 'cn',
      },
    })
    expect(JSON.stringify(session)).not.toContain('Runner@Example.COM')
    expect(sessionFileMatchesAccount(session, 'runner@example.com', 'cn')).toBe(true)
    expect(sessionFileMatchesAccount(session, 'runner@example.com', 'global')).toBe(false)
  })

  it.each([
    ['wrong kind', { kind: 'legacy-oauth' }],
    ['wrong schema version', { schemaVersion: 2 }],
    ['unknown client', { clientId: 'UNTRUSTED_CLIENT' }],
    ['missing account binding', { account: undefined }],
    ['unexpected top-level field', { privateNote: 'TOP_SECRET_FRAGMENT' }],
    ['control characters in a token', {
      tokens: {
        accessToken: 'di-access-token\r\nInjected: value',
        refreshToken: 'di-refresh-token',
        accessExpiresAtMs: 1_800_000_000_000,
        refreshExpiresAtMs: null,
      },
    }],
    ['invalid access expiry', {
      tokens: {
        accessToken: 'di-access-token',
        refreshToken: 'di-refresh-token',
        accessExpiresAtMs: 0,
        refreshExpiresAtMs: null,
      },
    }],
  ])('rejects a DI session with %s', async (_case, override) => {
    const valid = bindDiSessionTokensToAccount({
      accessToken: 'di-access-token',
      refreshToken: 'di-refresh-token',
      clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      accessExpiresAtMs: 1_800_000_000_000,
      refreshExpiresAtMs: null,
    }, 'runner@example.com', 'global')
    const candidate = {
      ...valid,
      ...override,
    }
    const path = await sessionPath(JSON.stringify(candidate))

    await expect(readSessionTokenFile(path))
      .rejects.toThrow('Garmin session token file is invalid')
  })

  it.each([
    ['malformed JSON', '{"oauth1":{"secret":"TOP_SECRET_FRAGMENT"}'],
    ['missing token object', JSON.stringify({ oauth1: { secret: 'TOP_SECRET_FRAGMENT' } })],
    ['unexpected top-level data', JSON.stringify({
      oauth1: {},
      oauth2: {},
      privateNote: 'TOP_SECRET_FRAGMENT',
    })],
  ])('rejects %s with one fixed non-sensitive error', async (_case, source) => {
    const path = await sessionPath(source)

    let thrown: unknown
    try {
      await readSessionTokenFile(path)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file is invalid',
    }))
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
  })

  it('normalizes missing-file failures without exposing the path', async () => {
    const marker = 'SECRET_ACCOUNT'
    let thrown: unknown
    try {
      await readSessionTokenFile(`/private/${marker}/session.json`)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      message: 'Garmin session token file could not be read',
    }))
    expect(String(thrown)).not.toContain(marker)
  })

  it('rejects oversized files before reading their contents into memory', async () => {
    const path = await sessionPath(Buffer.alloc(1024 * 1024 + 1))

    await expect(readSessionTokenFile(path))
      .rejects.toThrow('Garmin session token file could not be read')
  })

  it('rejects group/world-readable token files', async () => {
    if (process.platform === 'win32') return
    const path = await sessionPath(JSON.stringify({ oauth1: {}, oauth2: {} }), 0o644)

    await expect(readSessionTokenFile(path))
      .rejects.toThrow('Garmin session token file permissions are unsafe')
  })

  it('does not follow a symlink token path', async () => {
    if (process.platform === 'win32') return
    const target = await sessionPath(JSON.stringify({ oauth1: {}, oauth2: {} }))
    const directory = await mkdtemp(join(tmpdir(), 'garmin-session-link-test-'))
    temporaryDirectories.push(directory)
    const linked = join(directory, 'session.json')
    await symlink(target, linked)

    await expect(readSessionTokenFile(linked))
      .rejects.toThrow('Garmin session token file could not be read')
  })

  it('rejects directories and other non-regular sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'garmin-session-directory-test-'))
    temporaryDirectories.push(directory)
    const nested = join(directory, 'not-a-file')
    await mkdir(nested)

    await expect(readSessionTokenFile(nested))
      .rejects.toThrow('Garmin session token file could not be read')
  })
})
