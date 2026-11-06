import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  WindowsAclCommandOptions,
  WindowsAclCommandRunner,
} from '../src/windows-private-acl'
import { createWindowsPrivateAcl } from '../src/windows-private-acl'

describe('Windows exact owner-only session ACLs', () => {
  const systemRoot = 'C:\\Windows'

  it('uses one absolute shell-free PowerShell and a static exact-DACL script', async () => {
    const calls: Array<{
      file: string
      args: readonly string[]
      options: WindowsAclCommandOptions
    }> = []
    const run: WindowsAclCommandRunner = async (file, args, options) => {
      calls.push({ file, args, options })
      return { stdout: '', stderr: '' }
    }
    const acl = await createWindowsPrivateAcl({ run, systemRoot })

    await acl.prepareDirectory('C:\\private\\account')
    await acl.secureFile('C:\\private\\account\\session.tmp')
    await acl.verifyFile('C:\\private\\account\\session.json')

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.file).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      )
      expect(call.args.slice(0, -1)).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
      ])
      expect(call.options).toEqual(expect.objectContaining({
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        shell: false,
        timeout: 60_000,
        windowsHide: true,
      }))
      expect(call.options.env).toEqual(expect.objectContaining({
        SystemRoot: systemRoot,
      }))
      expect(call.options.env.APPDATA).toBeUndefined()
      expect(call.options.env.LOCALAPPDATA).toBeUndefined()
      expect(call.options.env.USERPROFILE).toBeUndefined()
    }

    const encodedScripts = calls.map(call => call.args.at(-1))
    expect(new Set(encodedScripts).size).toBe(1)
    const script = Buffer.from(encodedScripts[0]!, 'base64').toString('utf16le')
    expect(script).toContain('DirectorySecurity')
    expect(script).toContain('FileSecurity')
    expect(script).toContain('SetAccessRuleProtection($true, $false)')
    expect(script).toContain('SetOwner($script:currentSid)')
    expect(script).toContain('GetAccessRules($true, $true')
    expect(script).toContain('ReparsePoint')
    expect(script).toContain('[System.Environment+SpecialFolder]::UserProfile')
    expect(script).toContain('[System.Environment+SpecialFolder]::ApplicationData')
    expect(script).toContain('[StringComparison]::OrdinalIgnoreCase')
    expect(script).toContain('Get-LongestTrustedUserRoot')
    expect(script).toContain('Assert-ExactPrivateDirectoryChain')
    expect(script).toContain('$components.Count -lt 1')
    expect(script).toContain('[IO.Directory]::CreateDirectory($current')
    expect(script).toContain('GetDirectoryName($fullPath)')
    expect(script).not.toContain('[IO.Directory]::CreateDirectory($fullPath')
    expect(script).not.toContain('C:\\private\\account')

    expect(calls.map(call => call.options.env.GARMIN_ACL_OPERATION)).toEqual([
      'prepare-directory',
      'secure-file',
      'verify-file',
    ])
    expect(calls.map(call => call.options.env.GARMIN_ACL_TARGET)).toEqual([
      'C:\\private\\account',
      'C:\\private\\account\\session.tmp',
      'C:\\private\\account\\session.json',
    ])
  })

  it.each([
    ['prepare-directory'],
    ['secure-file'],
    ['verify-file'],
  ] as const)('normalizes %s failures without exposing paths or output', async (operation) => {
    const run: WindowsAclCommandRunner = async () => {
      throw new Error('PRIVATE_SUBPROCESS_DETAIL C:\\private\\SECRET_ACCOUNT')
    }
    const acl = await createWindowsPrivateAcl({ run, systemRoot })

    let thrown: unknown
    try {
      if (operation === 'prepare-directory') {
        await acl.prepareDirectory('C:\\private\\SECRET_ACCOUNT')
      } else if (operation === 'secure-file') {
        await acl.secureFile('C:\\private\\SECRET_ACCOUNT')
      } else {
        await acl.verifyFile('C:\\private\\SECRET_ACCOUNT')
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be written',
    }))
    expect(String(thrown)).not.toContain('PRIVATE_SUBPROCESS_DETAIL')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
  })

  it('rejects oversized injected output even when the runner resolves', async () => {
    const marker = 'PRIVATE_SUBPROCESS_DETAIL'
    const run: WindowsAclCommandRunner = async () => ({
      stdout: marker.repeat(4096),
      stderr: '',
    })
    const acl = await createWindowsPrivateAcl({ run, systemRoot })

    let thrown: unknown
    try {
      await acl.prepareDirectory('C:\\private\\SECRET_ACCOUNT')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be written',
    }))
    expect(String(thrown)).not.toContain(marker)
  })

  it.each([
    ['', 'missing'],
    ['Windows', 'relative'],
    ['C:\\Windows\0SECRET', 'NUL'],
    ['C:\\Windows\\..\\SECRET', 'traversal'],
  ])('rejects an unsafe SystemRoot (%s) before running a command', async (root) => {
    const run = jest.fn<ReturnType<WindowsAclCommandRunner>, Parameters<WindowsAclCommandRunner>>()

    await expect(createWindowsPrivateAcl({ run, systemRoot: root }))
      .rejects.toThrow('Garmin session token file could not be written')
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    [Object.assign(new Error('missing executable SECRET'), { code: 'ENOENT' }), 'windows_powershell_unavailable'],
    [Object.assign(new Error('timeout SECRET'), { code: 'ETIMEDOUT', killed: true }), 'windows_acl_timeout'],
    [new Error('ACL stderr SECRET'), 'windows_acl_rejected'],
  ])('classifies a subprocess failure without retaining its text', async (failure, code) => {
    const acl = await createWindowsPrivateAcl({
      systemRoot,
      run: async () => { throw failure },
    })

    await expect(acl.prepareDirectory('C:\\private\\SECRET_ACCOUNT'))
      .rejects.toEqual(expect.objectContaining({
        authDiagnosticCode: code,
        message: 'Garmin session token file could not be written',
      }))
  })

  it('classifies invalid Windows roots and targets with fixed codes', async () => {
    await expect(createWindowsPrivateAcl({ systemRoot: 'relative', run: jest.fn() }))
      .rejects.toEqual(expect.objectContaining({
        authDiagnosticCode: 'windows_system_root_invalid',
      }))

    const acl = await createWindowsPrivateAcl({ systemRoot, run: jest.fn() })
    await expect(acl.prepareDirectory('relative\\SECRET_ACCOUNT'))
      .rejects.toEqual(expect.objectContaining({
        authDiagnosticCode: 'windows_target_invalid',
      }))
  })
})

describe('Windows exact-private session write ordering', () => {
  const temporaryDirectories: string[] = []
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    jest.resetModules()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      enumerable: true,
      value: 'win32',
    })
  })

  afterEach(async () => {
    jest.dontMock('../src/windows-private-acl')
    jest.resetModules()
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    await Promise.all(temporaryDirectories.splice(0).map(directory => (
      rm(directory, { recursive: true, force: true })
    )))
  })

  it('verifies/creates the parent and secures the empty temp file before secrets', async () => {
    const events: string[] = []
    const prepareDirectory = jest.fn(async (path: string) => {
      events.push(`directory:${basename(path)}`)
      await mkdir(path, { recursive: true })
    })
    const secureFile = jest.fn(async (path: string) => {
      events.push(`file:${basename(path)}`)
      expect(await readFile(path, 'utf8')).toBe('')
    })
    jest.doMock('../src/windows-private-acl', () => ({
      createWindowsPrivateAcl: async () => ({
        prepareDirectory,
        secureFile,
        verifyFile: jest.fn(),
      }),
    }))
    const { writeSessionTokenFile } = await import('../src/session-store')
    const root = await mkdtemp(join(tmpdir(), 'garmin-windows-session-test-'))
    temporaryDirectories.push(root)
    const parent = join(root, 'account')
    const path = join(parent, 'session.json')
    const tokens = {
      oauth1: { oauth_token: 'TOP_SECRET_OAUTH_ONE' },
      oauth2: { access_token: 'TOP_SECRET_OAUTH_TWO' },
    }

    await writeSessionTokenFile(path, tokens)

    expect(events[0]).toBe('directory:account')
    expect(events[1]).toMatch(/^file:\.session\.json\..+\.tmp$/)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(tokens)
    expect(await readdir(parent)).toEqual(['session.json'])
  })

  it('fails before creating a temp file when the existing parent is not exact-private', async () => {
    const prepareDirectory = jest.fn(async () => {
      throw new Error('forged marker or unrelated explicit ACE')
    })
    jest.doMock('../src/windows-private-acl', () => ({
      createWindowsPrivateAcl: async () => ({
        prepareDirectory,
        secureFile: jest.fn(),
        verifyFile: jest.fn(),
      }),
    }))
    const { writeSessionTokenFile } = await import('../src/session-store')
    const root = await mkdtemp(join(tmpdir(), 'garmin-windows-session-test-'))
    temporaryDirectories.push(root)

    await expect(writeSessionTokenFile(join(root, 'SECRET_ACCOUNT.json'), {
      oauth1: { oauth_token: 'TOP_SECRET_FRAGMENT' },
      oauth2: {},
    })).rejects.toThrow('Garmin session token file could not be written')

    expect(prepareDirectory).toHaveBeenCalledWith(root)
    expect(await readdir(root)).toEqual([])
  })

  it('exposes destination preparation for missing-token browser auth', async () => {
    const prepareDirectory = jest.fn(async () => undefined)
    jest.doMock('../src/windows-private-acl', () => ({
      createWindowsPrivateAcl: async () => ({
        prepareDirectory,
        secureFile: jest.fn(),
        verifyFile: jest.fn(),
      }),
    }))
    const { prepareSessionTokenWriteDestination } = await import('../src/session-store')
    const root = await mkdtemp(join(tmpdir(), 'garmin-windows-session-test-'))
    temporaryDirectories.push(root)
    const destination = join(root, 'account', 'session.json')

    await prepareSessionTokenWriteDestination(destination)

    expect(prepareDirectory).toHaveBeenCalledWith(join(root, 'account'))
  })

  it('preserves only a fixed destination diagnostic code across the public error boundary', async () => {
    jest.doMock('../src/windows-private-acl', () => ({
      createWindowsPrivateAcl: async () => ({
        prepareDirectory: async () => {
          throw Object.assign(
            new Error('C:\\Users\\runner\\SECRET_ACCOUNT'),
            { authDiagnosticCode: 'windows_acl_rejected' },
          )
        },
        secureFile: jest.fn(),
        verifyFile: jest.fn(),
      }),
    }))
    const { prepareSessionTokenWriteDestination } = await import('../src/session-store')

    await expect(prepareSessionTokenWriteDestination(
      'C:\\Users\\runner\\SECRET_ACCOUNT\\session.json',
    )).rejects.toEqual(expect.objectContaining({
      authDiagnosticCode: 'windows_acl_rejected',
      message: 'Garmin session token destination could not be prepared',
    }))
  })

  it('verifies the exact parent and file ACL before reading token bytes', async () => {
    const events: string[] = []
    const prepareDirectory = jest.fn(async () => {
      events.push('parent')
    })
    const verifyFile = jest.fn(async () => {
      events.push('file')
    })
    jest.doMock('../src/windows-private-acl', () => ({
      createWindowsPrivateAcl: async () => ({
        prepareDirectory,
        secureFile: jest.fn(),
        verifyFile,
      }),
    }))
    const { readSessionTokenFile } = await import('../src/session-store')
    const root = await mkdtemp(join(tmpdir(), 'garmin-windows-session-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'session.json')
    await writeFile(path, JSON.stringify({ oauth1: {}, oauth2: {} }))

    await expect(readSessionTokenFile(path)).resolves.toEqual({
      oauth1: {},
      oauth2: {},
    })
    expect(events).toEqual(['parent', 'file'])
  })

  it('normalizes Windows ACL read failures without exposing output or paths', async () => {
    jest.doMock('../src/windows-private-acl', () => ({
      createWindowsPrivateAcl: async () => ({
        prepareDirectory: async () => undefined,
        secureFile: jest.fn(),
        verifyFile: async () => {
          throw new Error('PRIVATE_SUBPROCESS_DETAIL SECRET_ACCOUNT')
        },
      }),
    }))
    const { readSessionTokenFile } = await import('../src/session-store')
    const root = await mkdtemp(join(tmpdir(), 'garmin-windows-session-test-'))
    temporaryDirectories.push(root)
    const path = join(root, 'SECRET_ACCOUNT.json')
    await writeFile(path, JSON.stringify({
      oauth1: { secret: 'TOP_SECRET_FRAGMENT' },
      oauth2: {},
    }))

    let thrown: unknown
    try {
      await readSessionTokenFile(path)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'PublicToolError',
      message: 'Garmin session token file could not be read',
    }))
    expect(String(thrown)).not.toContain('PRIVATE_SUBPROCESS_DETAIL')
    expect(String(thrown)).not.toContain('SECRET_ACCOUNT')
    expect(String(thrown)).not.toContain('TOP_SECRET_FRAGMENT')
  })
})

describe('Windows exact-private session host integration', () => {
  it('uses the real Windows ACL API and verifies the published session', async () => {
    if (process.platform !== 'win32') return
    jest.resetModules()
    jest.unmock('../src/windows-private-acl')
    const {
      prepareSessionTokenWriteDestination,
      readSessionTokenFile,
      writeSessionTokenFile,
    } = await import('../src/session-store')
    const { createWindowsPrivateAcl } = await import('../src/windows-private-acl')
    const localAppData = process.env.LOCALAPPDATA?.trim()
    if (!localAppData) throw new Error('LOCALAPPDATA is required for Windows ACL smoke')
    // Start directly below a Windows-managed trusted root. A pre-created temp
    // subtree would correctly fail because its intermediate ACL is not exact.
    const parent = join(
      localAppData,
      `garmin-connect-acl-integration-${process.pid}-${randomUUID()}`,
    )
    const path = join(parent, 'session.json')
    const tokens = {
      oauth1: { oauth_token: 'windows-owner-only' },
      oauth2: { access_token: 'windows-owner-only' },
    }

    try {
      await prepareSessionTokenWriteDestination(path)
      await writeSessionTokenFile(path, tokens)
      const acl = await createWindowsPrivateAcl()
      await acl.prepareDirectory(parent)
      await acl.verifyFile(path)
      await expect(readSessionTokenFile(path)).resolves.toEqual(tokens)
      expect(await readdir(parent)).toEqual(['session.json'])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)
})
