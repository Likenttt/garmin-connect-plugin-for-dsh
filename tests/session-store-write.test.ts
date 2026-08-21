import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindDiSessionTokensToAccount,
  readSessionTokenFile,
  writeSessionTokenFile,
} from '../src/session-store'

describe('session token file writer', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => (
      rm(directory, { recursive: true, force: true })
    )))
  })

  it('atomically creates a private parent directory and 0600 token file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    const path = join(parent, 'session.json')
    const tokens = {
      oauth1: { oauth_token: 'oauth-one' },
      oauth2: { access_token: 'oauth-two' },
    }

    await writeSessionTokenFile(path, tokens)

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(tokens)
    expect((await stat(parent)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(parent)).toEqual(['session.json'])
  })

  it('atomically round-trips a private DI session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'account', 'browser.session.json')
    const session = bindDiSessionTokensToAccount({
      accessToken: 'di-access-token',
      refreshToken: 'di-refresh-token',
      clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      accessExpiresAtMs: 1_800_000_000_000,
      refreshExpiresAtMs: null,
    }, 'runner@example.com', 'global')

    await writeSessionTokenFile(path, session)

    await expect(readSessionTokenFile(path)).resolves.toEqual(session)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('refuses to change or write through an existing broadly-readable directory', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    await mkdir(parent, { mode: 0o755 })
    await chmod(parent, 0o755)

    await expect(writeSessionTokenFile(join(parent, 'session.json'), {
      oauth1: {},
      oauth2: {},
    })).rejects.toThrow('Garmin session token file could not be written')

    expect((await stat(parent)).mode & 0o777).toBe(0o755)
    expect(await readdir(parent)).toEqual([])
  })

  it('refuses a symlink as the final account directory', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const actual = join(root, 'actual')
    const linked = join(root, 'linked')
    await mkdir(actual)
    await symlink(actual, linked, 'dir')

    await expect(writeSessionTokenFile(join(linked, 'session.json'), {
      oauth1: {},
      oauth2: {},
    })).rejects.toThrow('Garmin session token file could not be written')
    expect(await readdir(actual)).toEqual([])
  })

  it('refuses a session that is too large to read back before creating a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'session.json')

    await expect(writeSessionTokenFile(path, {
      oauth1: { oauth_token: 'x'.repeat(1024 * 1024) },
      oauth2: {},
    })).rejects.toThrow('Garmin session token file is too large')

    expect(await readdir(root)).toEqual([])
  })

  it.each([
    ['missing oauth2', { oauth1: { secret: 'TOP_SECRET_FRAGMENT' } }],
    ['non-object oauth token', { oauth1: [], oauth2: {} }],
    ['unexpected top-level data', {
      oauth1: {},
      oauth2: {},
      privateNote: 'TOP_SECRET_FRAGMENT',
    }],
  ])('rejects %s before creating a file', async (_case, tokens) => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'SECRET_ACCOUNT.json')

    let thrown: unknown
    try {
      await writeSessionTokenFile(path, tokens)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file is invalid',
    }))
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect(await readdir(root)).toEqual([])
  })

  it('removes the temporary file and returns a fixed error when rename fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-session-write-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'SECRET_ACCOUNT')
    await mkdir(path)

    let thrown: unknown
    try {
      await writeSessionTokenFile(path, {
        oauth1: { secret: 'TOP_SECRET_FRAGMENT' },
        oauth2: {},
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be written',
    }))
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect(await readdir(root)).toEqual(['SECRET_ACCOUNT'])
  })
})
