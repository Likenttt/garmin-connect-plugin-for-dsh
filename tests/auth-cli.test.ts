import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserCanaryControlError } from '../src/browser-auth-canary'
import {
  GarminAuthenticationCancelledError,
  GarminAuthenticationRequiredError,
} from '../src/utils/errors'
import {
  authCliExitCode,
  defaultAccountSessionPath,
  installAuthCliTermination,
  runAuthCanary,
  runBrowserAuthSetup,
  runAuthServe,
  runAuthSetup,
  type BrowserAuthCliDependencies,
  type AuthCanaryCliDependencies,
  type AuthCliDependencies,
  type AuthCliIO,
  type AuthCliSignalSource,
  type AuthServeCliDependencies,
} from '../src/auth-cli'

const TOKENS = {
  oauth1: { oauth_token: 'SECRET_ONE' },
  oauth2: { access_token: 'SECRET_TWO' },
}

function fixture(answers: string[]) {
  const prompt = jest.fn(async () => answers.shift() ?? '')
  const write = jest.fn()
  const io: AuthCliIO = { prompt, write }
  const authenticate = jest.fn(async (options: any) => {
    const code = await options.promptMfa({ method: 'email' })
    expect(code).toBe('123456')
    return { tokens: TOKENS, usedMfa: true }
  })
  const writeSession = jest.fn().mockResolvedValue(undefined)
  const dependencies: AuthCliDependencies = { authenticate, writeSession }
  return { io, prompt, write, authenticate, writeSession, dependencies }
}

function serveDependencies(authenticate: jest.Mock): AuthServeCliDependencies {
  return {
    authenticate,
    prepareDestination: jest.fn().mockResolvedValue(undefined),
  }
}

function browserDependencies(setup: jest.Mock): BrowserAuthCliDependencies {
  return {
    setup,
    prepareDestination: jest.fn().mockResolvedValue(undefined),
  }
}

describe('Garmin interactive auth CLI', () => {
  it('gracefully aborts once and force-exits on a second signal', () => {
    const source = new EventEmitter()
    const forceExit = jest.fn()
    const termination = installAuthCliTermination({
      source: source as unknown as AuthCliSignalSource,
      forceExit,
      graceMs: 100,
    })

    source.emit('SIGTERM')

    expect(termination.signal.aborted).toBe(true)
    expect(termination.receivedSignal()).toBe('SIGTERM')
    expect(forceExit).not.toHaveBeenCalled()

    source.emit('SIGINT')
    expect(forceExit).toHaveBeenCalledWith(130)

    termination.dispose()
  })

  it('force-exits after the graceful signal deadline', async () => {
    jest.useFakeTimers()
    const source = new EventEmitter()
    const forceExit = jest.fn()
    const termination = installAuthCliTermination({
      source: source as unknown as AuthCliSignalSource,
      forceExit,
      graceMs: 100,
    })

    try {
      source.emit('SIGHUP')
      await jest.advanceTimersByTimeAsync(99)
      expect(forceExit).not.toHaveBeenCalled()

      await jest.advanceTimersByTimeAsync(1)
      expect(forceExit).toHaveBeenCalledWith(129)
    } finally {
      termination.dispose()
      jest.useRealTimers()
    }
  })

  it('publishes the stable garmin-connect-auth executable name', () => {
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as { bin?: Record<string, string> }

    expect(manifest.bin?.['garmin-connect-auth']).toBe('lib/auth-cli.js')
  })

  it('keeps the browser driver optional for users who only run the plugin', () => {
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }

    expect(manifest.optionalDependencies?.['playwright-core']).toBe('1.62.1')
    expect(manifest.dependencies?.['playwright-core']).toBeUndefined()
  })

  it('shows command help without starting an interactive login', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const result = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, '--help'],
      { encoding: 'utf8', timeout: 15_000 },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('garmin-connect-auth login [options]')
    expect(result.stdout).toContain(
      'garmin-connect-auth serve --account <alias> --region <global|cn> --open [options]',
    )
    expect(result.stdout).toContain('garmin-connect-auth canary --region <global|cn>')
    expect(result.stdout).toContain('--account <alias>')
    expect(result.stdout).toContain('--region <global|cn>')
    expect(result.stdout).toContain('--output <path>')
    expect(result.stdout).toContain('password blank to use Garmin\'s browser page')
    expect(result.stderr).toBe('')
  })

  it('shows the same help for the login subcommand', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const result = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'login', '--help'],
      { encoding: 'utf8', timeout: 15_000 },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('garmin-connect-auth login [options]')
    expect(result.stderr).toBe('')
  })

  it('shows browser-login help without loading the optional browser driver', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const result = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'login', '--browser', '--help'],
      { encoding: 'utf8', timeout: 15_000 },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'garmin-connect-auth login --browser --region <global|cn> [options]',
    )
    expect(result.stdout).toContain(
      '--browser               Legacy Playwright diagnostic',
    )
    expect(result.stdout).not.toContain('Unfinished preview')
    expect(result.stdout).toContain(
      'The serve command keeps password, verification code, CAPTCHA, and MFA inside',
    )
    expect(result.stderr).toBe('')
  })

  it('routes login --browser through browser validation before any terminal secret prompt', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const result = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'login', '--browser'],
      {
        encoding: 'utf8',
        env: { ...process.env, GARMIN_REGION: 'cn', GARMIN_PASSWORD: 'PASSWORD_MARKER' },
        timeout: 15_000,
      },
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Browser login region is required; use global or cn\n')
    expect(result.stderr).not.toContain('PASSWORD_MARKER')
  })

  it('shows the package version without starting an interactive login', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as { version: string }
    const result = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, '--version'],
      { encoding: 'utf8', timeout: 15_000 },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${manifest.version}\n`)
    expect(result.stderr).toBe('')
  })

  it('shows the same version for the login subcommand', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as { version: string }
    const result = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'login', '--version'],
      { encoding: 'utf8', timeout: 15_000 },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${manifest.version}\n`)
    expect(result.stderr).toBe('')
  })

  it('shows browser-login version without loading the optional browser driver', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as { version: string }
    const result = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'login', '--browser', '--version'],
      { encoding: 'utf8', timeout: 15_000 },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${manifest.version}\n`)
    expect(result.stderr).toBe('')
  })

  it('shows canary help and version without loading a browser', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as { version: string }
    const help = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'canary', '--help'],
      { encoding: 'utf8', timeout: 15_000 },
    )
    const version = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'canary', '--version'],
      { encoding: 'utf8', timeout: 15_000 },
    )

    expect(help.status).toBe(0)
    expect(help.stdout).toContain('garmin-connect-auth canary --region <global|cn>')
    expect(help.stderr).toBe('')
    expect(version.status).toBe(0)
    expect(version.stdout).toBe(`${manifest.version}\n`)
    expect(version.stderr).toBe('')
  })

  it('shows serve help and version without loading an optional browser driver', () => {
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as { version: string }
    const help = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'serve', '--help'],
      { encoding: 'utf8', timeout: 15_000 },
    )
    const version = spawnSync(
      process.execPath,
      ['--import', require.resolve('tsx'), entrypoint, 'serve', '--version'],
      { encoding: 'utf8', timeout: 15_000 },
    )

    expect(help.status).toBe(0)
    expect(help.stdout).toContain(
      'garmin-connect-auth serve --account <alias> --region <global|cn> --open [options]',
    )
    expect(help.stdout).toContain('--open')
    expect(help.stderr).toBe('')
    expect(version.status).toBe(0)
    expect(version.stdout).toBe(`${manifest.version}\n`)
    expect(version.stderr).toBe('')
  })

  it('prompts locally for password and MFA, then persists only the session tokens', async () => {
    const { io, prompt, write, authenticate, writeSession, dependencies } = fixture([
      'runner@example.test',
      'PASSWORD_MARKER',
      '123456',
    ])

    const result = await runAuthSetup({
      argv: ['login', '--account', 'personal', '--region', 'cn', '--output', '/safe/personal.json'],
      env: {},
      io,
      dependencies,
    })

    expect(result).toEqual({
      account: 'personal',
      region: 'cn',
      sessionTokenFile: path.resolve('/safe/personal.json'),
      authenticationMode: 'terminal',
      usedMfa: true,
    })
    expect(prompt).toHaveBeenNthCalledWith(1, 'Garmin email: ', false)
    expect(prompt).toHaveBeenNthCalledWith(2, 'Garmin password: ', true)
    expect(prompt).toHaveBeenNthCalledWith(3, 'Garmin MFA code (email): ', true)
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      username: 'runner@example.test',
      password: 'PASSWORD_MARKER',
      region: 'cn',
    }))
    expect(writeSession).toHaveBeenCalledWith('/safe/personal.json', {
      ...TOKENS,
      account: {
        usernameHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        region: 'cn',
      },
    })

    const rendered = write.mock.calls.flat().join('\n')
    expect(rendered).toContain('Authentication succeeded')
    expect(rendered).toContain('/safe/personal.json')
    expect(rendered).not.toContain('runner@example.test')
    expect(rendered).not.toContain('PASSWORD_MARKER')
    expect(rendered).not.toContain('123456')
    expect(rendered).not.toContain('SECRET_ONE')
    expect(rendered).not.toContain('SECRET_TWO')
  })

  it('escapes terminal-control characters in the legacy session path output', async () => {
    const { io, write, dependencies } = fixture([
      'runner@example.test',
      'PASSWORD_MARKER',
      '123456',
    ])
    const injectedPath = '/safe/legacy\nINJECTED\u001b[31m\u202e.json'

    await runAuthSetup({
      argv: ['login', '--region', 'cn', '--output', injectedPath],
      env: {},
      io,
      dependencies,
    })

    const output = write.mock.calls.flat().join('')
    expect(output).toContain('legacy\\nINJECTED\\u001b[31m\\u202e.json')
    expect(output).not.toContain('\nINJECTED')
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('\u202e')
  })

  it('may reuse the username but always prompts locally for password and MFA', async () => {
    const { io, prompt, authenticate, dependencies } = fixture([
      'TTY_PASSWORD',
      '123456',
    ])

    await runAuthSetup({
      argv: ['login', '--output', './tokens.json'],
      env: {
        GARMIN_USERNAME: 'runner@example.test',
        GARMIN_PASSWORD: 'PASSWORD_MARKER',
      },
      io,
      dependencies,
    })

    expect(prompt).toHaveBeenNthCalledWith(1, 'Garmin password: ', true)
    expect(prompt).toHaveBeenNthCalledWith(2, 'Garmin MFA code (email): ', true)
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      password: 'TTY_PASSWORD',
    }))
  })

  it('switches an explicit password MFA challenge to the shared browser flow', async () => {
    const answers = [
      'runner@example.test',
      'PASSWORD_MARKER',
    ]
    const prompt = jest.fn(async () => answers.shift() ?? '')
    const write = jest.fn()
    const io: AuthCliIO = { prompt, write }
    const authenticate = jest.fn().mockRejectedValue(
      new GarminAuthenticationRequiredError('challenge', undefined, 'mfa'),
    )
    const writeSession = jest.fn().mockResolvedValue(undefined)
    const browserAuthenticate = jest.fn().mockResolvedValue({
      success: true,
      account: 'personal',
      region: 'cn',
      sessionTokenFile: '/safe/personal.json',
    })

    await expect(runAuthSetup({
      argv: [
        'login',
        '--account', 'personal',
        '--region', 'cn',
        '--output', '/safe/personal.json',
      ],
      env: {},
      io,
      dependencies: { authenticate, writeSession },
      browserDependencies: serveDependencies(browserAuthenticate),
    })).resolves.toEqual({
      account: 'personal',
      region: 'cn',
      sessionTokenFile: path.resolve('/safe/personal.json'),
      authenticationMode: 'browser',
      browserTrigger: 'mfa',
    })

    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      browserOnChallenge: true,
      password: 'PASSWORD_MARKER',
    }))
    expect(browserAuthenticate).toHaveBeenCalledWith(expect.objectContaining({
      username: 'runner@example.test',
      region: 'cn',
      sessionTokenFile: path.resolve('/safe/personal.json'),
    }))
    expect(browserAuthenticate.mock.calls[0][0]).not.toHaveProperty('password')
    expect(writeSession).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(write.mock.calls.flat().join('')).not.toContain('PASSWORD_MARKER')
  })

  it('does not report a CAPTCHA browser recovery as MFA use', async () => {
    const answers = ['runner@example.test', 'PASSWORD_MARKER']
    const prompt = jest.fn(async () => answers.shift() ?? '')
    const io: AuthCliIO = { prompt, write: jest.fn() }
    const authenticate = jest.fn().mockRejectedValue(
      new GarminAuthenticationRequiredError(
        'challenge',
        undefined,
        'verification',
      ),
    )
    const browserAuthenticate = jest.fn().mockResolvedValue({
      success: true,
      account: 'default',
      region: 'global',
      sessionTokenFile: '/safe/default.json',
    })

    await expect(runAuthSetup({
      argv: ['login', '--output', '/safe/default.json'],
      env: {},
      io,
      dependencies: {
        authenticate,
        writeSession: jest.fn(),
      },
      browserDependencies: serveDependencies(browserAuthenticate),
    })).resolves.toMatchObject({
      authenticationMode: 'browser',
      browserTrigger: 'verification',
    })
  })

  it('uses the shared browser flow when no terminal password is supplied', async () => {
    const answers = ['runner@example.test', '']
    const prompt = jest.fn(async () => answers.shift() ?? '')
    const io: AuthCliIO = { prompt, write: jest.fn() }
    const authenticate = jest.fn()
    const writeSession = jest.fn()
    const browserAuthenticate = jest.fn().mockResolvedValue({
      success: true,
      account: 'default',
      region: 'global',
      sessionTokenFile: '/safe/default.json',
    })
    const signal = new AbortController().signal

    await expect(runAuthSetup({
      argv: ['login', '--output', '/safe/default.json'],
      env: {},
      io,
      signal,
      dependencies: { authenticate, writeSession },
      browserDependencies: serveDependencies(browserAuthenticate),
    })).resolves.toEqual({
      account: 'default',
      region: 'global',
      sessionTokenFile: path.resolve('/safe/default.json'),
      authenticationMode: 'browser',
      browserTrigger: 'blank_password',
    })

    expect(authenticate).not.toHaveBeenCalled()
    expect(writeSession).not.toHaveBeenCalled()
    expect(browserAuthenticate).toHaveBeenCalledTimes(1)
    expect(browserAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ signal }))
  })

  it('does not persist a terminal session after password authentication is cancelled', async () => {
    const controller = new AbortController()
    const io: AuthCliIO = {
      prompt: jest.fn().mockResolvedValue('PASSWORD_MARKER'),
      write: jest.fn(),
    }
    const authenticate = jest.fn(async (options: any) => {
      expect(options.signal).toBe(controller.signal)
      controller.abort()
      return { tokens: TOKENS, usedMfa: false }
    })
    const writeSession = jest.fn()

    await expect(runAuthSetup({
      argv: ['login', '--output', '/safe/default.json'],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      signal: controller.signal,
      dependencies: { authenticate, writeSession },
    })).rejects.toMatchObject({ code: 'CANCELLED' })

    expect(writeSession).not.toHaveBeenCalled()
    expect(io.write).not.toHaveBeenCalled()
  })

  it.each([
    ['--password', 'secret'],
    ['--mfa-code', '123456'],
    ['--password=secret'],
    ['--mfa-code=123456'],
  ])('rejects sensitive command-line flag %s', async (...argv) => {
    const { io, authenticate, dependencies } = fixture([])

    await expect(runAuthSetup({ argv, env: {}, io, dependencies }))
      .rejects.toThrow('Passwords and MFA codes must be entered interactively')
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('does not echo an unknown option value in its public error', async () => {
    const { io, dependencies } = fixture([])
    const marker = 'TOP_SECRET_MARKER'
    const request = runAuthSetup({
      argv: [`--unknown=${marker}`],
      env: {},
      io,
      dependencies,
    })

    await expect(request).rejects.toThrow('Unknown authentication option')
    await expect(request).rejects.not.toThrow(marker)
  })

  it('rejects account aliases that could affect paths', async () => {
    const { io, dependencies } = fixture([])
    await expect(runAuthSetup({
      argv: ['login', '--account', '../other-user'],
      env: {},
      io,
      dependencies,
    })).rejects.toThrow('Invalid account alias')
  })

  it('uses an account-isolated default path', () => {
    expect(defaultAccountSessionPath('work', {
      XDG_CONFIG_HOME: '/private/config',
    })).toBe('/private/config/dsh-plugin-garmin-connect/accounts/work.session.json')
  })

  it('prefers local Windows app data over redirected roaming app data', () => {
    expect(defaultAccountSessionPath('work', {
      LOCALAPPDATA: '/local/appdata',
      APPDATA: '//server/redirected/roaming',
    })).toBe(
      '/local/appdata/dsh-plugin-garmin-connect/accounts/work.session.json',
    )
  })

  it('serves browser authentication in the system browser for an explicit region', async () => {
    const prompt = jest.fn()
    const write = jest.fn()
    const io: AuthCliIO = { prompt, write }
    const authenticate = jest.fn().mockResolvedValue({
      success: true,
      region: 'cn',
    })
    const dependencies = serveDependencies(authenticate)
    const signal = new AbortController().signal

    await expect(runAuthServe({
      argv: [
        'serve',
        '--open',
        '--account',
        'personal-cn',
        '--region',
        'cn',
        '--output',
        '/safe/personal-cn.json',
      ],
      env: {
        GARMIN_USERNAME: 'runner@example.test',
        GARMIN_PASSWORD: 'PASSWORD_MARKER',
      },
      io,
      signal,
      dependencies,
    })).resolves.toEqual({
      account: 'personal-cn',
      region: 'cn',
      sessionTokenFile: path.resolve('/safe/personal-cn.json'),
    })

    expect(prompt).not.toHaveBeenCalled()
    expect(authenticate).toHaveBeenCalledWith({
      username: 'runner@example.test',
      region: 'cn',
      sessionTokenFile: path.resolve('/safe/personal-cn.json'),
      signal,
    })
    const output = write.mock.calls.flat().join('')
    expect(output).toContain('Opening Garmin authentication in your system browser')
    expect(output).toContain('authentication_status=passed')
    expect(output).toContain('region=cn')
    expect(output).toContain('session_persisted=yes')
    expect(output).toContain('Session saved securely to: "/safe/personal-cn.json"')
    expect(output).not.toMatch(
      /runner@example|PASSWORD_MARKER|serviceTicket|access_token|bridge\//,
    )
  })

  it('prepares the session destination before opening serve authentication', async () => {
    const authenticate = jest.fn()
    const prepareDestination = jest.fn().mockRejectedValue(
      new Error('destination rejected'),
    )
    const io: AuthCliIO = { prompt: jest.fn(), write: jest.fn() }

    await expect(runAuthServe({
      argv: [
        'serve',
        '--open',
        '--account',
        'personal',
        '--region',
        'global',
      ],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      dependencies: { authenticate, prepareDestination },
    })).rejects.toThrow('destination rejected')

    expect(prepareDestination).toHaveBeenCalledTimes(1)
    expect(authenticate).not.toHaveBeenCalled()
    expect(io.prompt).not.toHaveBeenCalled()
  })

  it('prompts only for a missing username and uses an account-isolated serve path', async () => {
    const prompt = jest.fn().mockResolvedValue('runner@example.test')
    const io: AuthCliIO = { prompt, write: jest.fn() }
    const authenticate = jest.fn().mockResolvedValue({
      success: true,
      region: 'global',
    })

    await expect(runAuthServe({
      argv: ['serve', '--open', '--account', 'work', '--region', 'global'],
      env: {
        XDG_CONFIG_HOME: '/private/config',
        GARMIN_PASSWORD: 'PASSWORD_MARKER',
      },
      io,
      dependencies: serveDependencies(authenticate),
    })).resolves.toEqual({
      account: 'work',
      region: 'global',
      sessionTokenFile:
        '/private/config/dsh-plugin-garmin-connect/accounts/work.session.json',
    })

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('Garmin email: ', false)
    expect(JSON.stringify(authenticate.mock.calls)).not.toContain('PASSWORD_MARKER')
  })

  it('forwards cancellation to the pending serve username prompt', async () => {
    const controller = new AbortController()
    let markPromptStarted!: () => void
    const promptStarted = new Promise<void>(resolve => { markPromptStarted = resolve })
    const prompt = jest.fn((_label: string, _secret: boolean, signal?: AbortSignal) => (
      new Promise<string>((_resolve, reject) => {
        expect(signal).toBe(controller.signal)
        signal?.addEventListener('abort', () => {
          reject(new BrowserCanaryControlError('CANCELLED'))
        }, { once: true })
        markPromptStarted()
      })
    ))
    const authenticate = jest.fn()
    const operation = runAuthServe({
      argv: ['serve', '--open', '--account', 'work', '--region', 'global'],
      env: { XDG_CONFIG_HOME: '/private/config' },
      io: { prompt, write: jest.fn() },
      signal: controller.signal,
      dependencies: serveDependencies(authenticate),
    })
    await promptStarted

    controller.abort()

    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('requires an explicit serve account, region, and system-browser opening', async () => {
    const io: AuthCliIO = { prompt: jest.fn(), write: jest.fn() }
    const authenticate = jest.fn()

    await expect(runAuthServe({
      argv: ['serve', '--open'],
      env: {
        GARMIN_ACCOUNT: 'must-not-be-inferred',
        GARMIN_REGION: 'cn',
        GARMIN_USERNAME: 'runner@example.test',
      },
      io,
      dependencies: serveDependencies(authenticate),
    })).rejects.toThrow('Serve account is required; use --account <alias>')
    await expect(runAuthServe({
      argv: ['serve', '--open', '--account', 'personal-cn'],
      env: { GARMIN_REGION: 'cn', GARMIN_USERNAME: 'runner@example.test' },
      io,
      dependencies: serveDependencies(authenticate),
    })).rejects.toThrow('Serve region is required; use global or cn')
    await expect(runAuthServe({
      argv: ['serve', '--account', 'personal-cn', '--region', 'cn'],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      dependencies: serveDependencies(authenticate),
    })).rejects.toThrow('Serve authentication requires --open')

    expect(authenticate).not.toHaveBeenCalled()
  })

  it('accepts npm/pnpm double dash delimiter without failing', async () => {
    const io: AuthCliIO = { prompt: jest.fn(), write: jest.fn() }
    const authenticate = jest.fn().mockResolvedValue({
      success: true,
      region: 'cn',
    })

    await runAuthServe({
      argv: ['serve', '--open', '--', '--account', 'default', '--region', 'cn'],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      dependencies: serveDependencies(authenticate),
    })

    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'cn', username: 'runner@example.test' }),
    )
  })

  it.each([
    ['--password', 'secret'],
    ['--mfa-code', '123456'],
    ['--password=secret'],
    ['--mfa-code=123456'],
  ])('rejects serve sensitive flag %s before opening the browser', async (...flag) => {
    const io: AuthCliIO = { prompt: jest.fn(), write: jest.fn() }
    const authenticate = jest.fn()

    await expect(runAuthServe({
      argv: ['serve', '--open', '--region', 'cn', ...flag],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      dependencies: serveDependencies(authenticate),
    })).rejects.toThrow('Passwords and MFA codes must be entered interactively')

    expect(authenticate).not.toHaveBeenCalled()
  })

  it('opens browser login for an explicit region and persists through the DI setup seam', async () => {
    const prompt = jest.fn().mockResolvedValue(' YES ')
    const write = jest.fn()
    const io: AuthCliIO = { prompt, write }
    const setup = jest.fn(async (options: any) => {
      options.onStage('browser_opened')
      options.onStage('ticket=ST-MUST_NOT_BE_RENDERED')
      options.onStage('profile_probe_succeeded')
      expect(await options.confirmIdentity({
        displayName: 'Private Runner',
        userName: 'private-runner',
      })).toBe(true)
      return {
        ok: true as const,
        region: 'cn' as const,
        persisted: true as const,
        access_token: 'MUST_NOT_BE_RENDERED',
        email: 'private@example.test',
        profileId: 123456789,
      }
    })
    const dependencies = browserDependencies(setup)
    const signal = new AbortController().signal

    await expect(runBrowserAuthSetup({
      argv: [
        'login',
        '--browser',
        '--account',
        'personal',
        '--region',
        'cn',
        '--output',
        '/safe/personal.json',
      ],
      env: {
        GARMIN_USERNAME: 'runner@example.test',
        GARMIN_PASSWORD: 'PASSWORD_MARKER',
      },
      io,
      signal,
      dependencies,
    })).resolves.toEqual({
      account: 'personal',
      region: 'cn',
      sessionTokenFile: path.resolve('/safe/personal.json'),
    })

    expect(setup).toHaveBeenCalledWith({
      username: 'runner@example.test',
      region: 'cn',
      sessionTokenFile: path.resolve('/safe/personal.json'),
      signal,
      onStage: expect.any(Function),
      confirmIdentity: expect.any(Function),
    })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith(expect.stringMatching(
      /Private Runner.*private-runner.*personal.*runner@example\.test.*type yes/i,
    ), false, signal)
    const output = write.mock.calls.flat().join('')
    expect(output).toContain('authentication_status=passed')
    expect(output).toContain('region=cn')
    expect(output).toContain('session_persisted=yes')
    expect(output).toContain('Session saved securely to: "/safe/personal.json"')
    expect(output).toContain('auth_stage=browser_opened')
    expect(output).toContain('auth_stage=profile_probe_succeeded')
    expect(output).not.toMatch(
      /MUST_NOT|runner@example|private@example|PASSWORD_MARKER|access_token|profileId|123456789/,
    )
    expect(output).not.toContain('Private Runner')
    expect(output).not.toContain('private-runner')
    expect(output).not.toContain('auth_stage=ticket=')
  })

  it('declines an unconfirmed browser identity before persistence', async () => {
    const prompt = jest.fn().mockResolvedValue('no')
    const write = jest.fn()
    const io: AuthCliIO = { prompt, write }
    let persistenceStarted = false
    const setup = jest.fn(async (options: any) => {
      const confirmed = await options.confirmIdentity({ displayName: 'Other Runner' })
      if (!confirmed) {
        throw new Error('Garmin browser account confirmation was declined')
      }
      persistenceStarted = true
      return { ok: true as const, region: 'cn' as const, persisted: true as const }
    })

    await expect(runBrowserAuthSetup({
      argv: ['login', '--browser', '--region', 'cn', '--account', 'personal'],
      env: { GARMIN_USERNAME: 'expected@example.test' },
      io,
      dependencies: browserDependencies(setup),
    })).rejects.toThrow('Garmin browser account confirmation was declined')

    expect(prompt).toHaveBeenCalledWith(expect.stringMatching(
      /Other Runner.*personal.*expected@example\.test/i,
    ), false)
    expect(persistenceStarted).toBe(false)
    expect(write.mock.calls.flat().join('')).not.toContain('authentication_status=passed')
    expect(write.mock.calls.flat().join('')).not.toContain('session_persisted=yes')
  })

  it('does not infer browser-login region from GARMIN_REGION', async () => {
    const prompt = jest.fn()
    const io: AuthCliIO = { prompt, write: jest.fn() }
    const setup = jest.fn()

    await expect(runBrowserAuthSetup({
      argv: ['login', '--browser'],
      env: {
        GARMIN_REGION: 'cn',
        GARMIN_USERNAME: 'runner@example.test',
      },
      io,
      dependencies: browserDependencies(setup),
    })).rejects.toThrow('Browser login region is required; use global or cn')

    expect(prompt).not.toHaveBeenCalled()
    expect(setup).not.toHaveBeenCalled()
  })

  it('prompts visibly only for a missing username and keeps password/MFA in the browser', async () => {
    const prompt = jest.fn().mockResolvedValue('runner@example.test')
    const write = jest.fn()
    const io: AuthCliIO = { prompt, write }
    const setup = jest.fn().mockResolvedValue({
      ok: true,
      region: 'global',
      persisted: true,
    })

    await expect(runBrowserAuthSetup({
      argv: ['login', '--browser', '--region', 'global', '--account', 'work'],
      env: {
        XDG_CONFIG_HOME: '/private/config',
        GARMIN_PASSWORD: 'PASSWORD_MARKER',
      },
      io,
      dependencies: browserDependencies(setup),
    })).resolves.toEqual({
      account: 'work',
      region: 'global',
      sessionTokenFile:
        '/private/config/dsh-plugin-garmin-connect/accounts/work.session.json',
    })

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('Garmin email: ', false)
    expect(setup).toHaveBeenCalledWith({
      username: 'runner@example.test',
      region: 'global',
      sessionTokenFile:
        '/private/config/dsh-plugin-garmin-connect/accounts/work.session.json',
      signal: undefined,
      confirmIdentity: expect.any(Function),
      onStage: expect.any(Function),
    })
    expect(JSON.stringify(setup.mock.calls)).not.toContain('PASSWORD_MARKER')
  })

  it.each([
    ['--password', 'secret'],
    ['--mfa-code', '123456'],
    ['--password=secret'],
    ['--mfa-code=123456'],
  ])('rejects browser-login sensitive flag %s before opening Chrome', async (...flag) => {
    const io: AuthCliIO = { prompt: jest.fn(), write: jest.fn() }
    const setup = jest.fn()

    await expect(runBrowserAuthSetup({
      argv: ['login', '--browser', '--region', 'cn', ...flag],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      dependencies: browserDependencies(setup),
    })).rejects.toThrow('Passwords and MFA codes must be entered interactively')

    expect(setup).not.toHaveBeenCalled()
  })

  it('keeps the optional-browser-driver error fixed and data-free', async () => {
    const marker = 'PRIVATE_BROWSER_PATH runner@example.test'
    const io: AuthCliIO = { prompt: jest.fn(), write: jest.fn() }
    const setup = jest.fn().mockRejectedValue(
      new BrowserCanaryControlError('DRIVER_UNAVAILABLE'),
    )

    const operation = runBrowserAuthSetup({
      argv: ['login', '--browser', '--region', 'cn'],
      env: { GARMIN_USERNAME: marker },
      io,
      dependencies: browserDependencies(setup),
    })

    await expect(operation).rejects.toThrow(
      'Garmin browser authentication requires the optional playwright-core driver',
    )
    await expect(operation).rejects.not.toThrow(marker)
  })

  it('reports persistence success when cancellation arrives after the atomic commit starts', async () => {
    const controller = new AbortController()
    const write = jest.fn()
    const io: AuthCliIO = { prompt: jest.fn(), write }
    const setup = jest.fn().mockImplementation(async () => {
      controller.abort()
      return { ok: true, region: 'cn', persisted: true }
    })

    await expect(runBrowserAuthSetup({
      argv: ['login', '--browser', '--region', 'cn'],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      signal: controller.signal,
      dependencies: browserDependencies(setup),
    })).resolves.toEqual({
      account: 'default',
      region: 'cn',
      sessionTokenFile: expect.stringMatching(/default\.session\.json$/),
    })

    expect(write.mock.calls.flat().join('')).toContain('session_persisted=yes')
  })

  it('escapes terminal-control characters in the displayed session path', async () => {
    const write = jest.fn()
    const io: AuthCliIO = { prompt: jest.fn(), write }
    const injectedPath = '/safe/session\nINJECTED\u001b[31m\u202e.json'
    const setup = jest.fn().mockResolvedValue({
      ok: true,
      region: 'cn',
      persisted: true,
    })

    await runBrowserAuthSetup({
      argv: ['login', '--browser', '--region', 'cn', '--output', injectedPath],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      dependencies: browserDependencies(setup),
    })

    expect(setup).toHaveBeenCalledWith(expect.objectContaining({
      sessionTokenFile: path.resolve(injectedPath),
    }))
    const output = write.mock.calls.flat().join('')
    expect(output).toContain('session\\nINJECTED\\u001b[31m\\u202e.json')
    expect(output).not.toContain('\nINJECTED')
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('\u202e')
  })

  it('bounds the displayed session path without changing the write target', async () => {
    const write = jest.fn()
    const io: AuthCliIO = { prompt: jest.fn(), write }
    const longPath = `/safe/${'A'.repeat(2_000)}.json`
    const setup = jest.fn().mockResolvedValue({
      ok: true,
      region: 'cn',
      persisted: true,
    })

    await runBrowserAuthSetup({
      argv: ['login', '--browser', '--region', 'cn', '--output', longPath],
      env: { GARMIN_USERNAME: 'runner@example.test' },
      io,
      dependencies: browserDependencies(setup),
    })

    expect(setup).toHaveBeenCalledWith(expect.objectContaining({
      sessionTokenFile: path.resolve(longPath),
    }))
    const output = write.mock.calls.flat().join('')
    expect(output).toContain(
      'Session saved securely to: [configured path omitted: exceeds display limit]',
    )
    expect(output).not.toContain('A'.repeat(1_000))
  })

  it('runs the browser canary without prompting or persisting a session', async () => {
    const prompt = jest.fn()
    const write = jest.fn()
    const io: AuthCliIO = { prompt, write }
    const canary = jest.fn(async (options: any) => {
      options.onStage('browser_opened')
      options.onStage('ticket=ST-MUST_NOT_BE_RENDERED')
      options.onStage('ticket_captured')
      return {
        ok: true as const,
        region: 'cn' as const,
        persisted: false as const,
        access_token: 'MUST_NOT_BE_RENDERED',
        email: 'private@example.test',
      }
    })
    const dependencies: AuthCanaryCliDependencies = { canary }

    await expect(runAuthCanary({
      argv: ['canary', '--region', 'cn'],
      io,
      dependencies,
    })).resolves.toEqual({ ok: true, region: 'cn', persisted: false })

    expect(canary).toHaveBeenCalledWith({
      region: 'cn',
      signal: undefined,
      onStage: expect.any(Function),
    })
    expect(prompt).not.toHaveBeenCalled()
    const output = write.mock.calls.flat().join('')
    expect(output).toContain('canary_status=passed')
    expect(output).toContain('region=cn')
    expect(output).toContain('session_persisted=no')
    expect(output).toContain('credentials_collected_by_cli=no')
    expect(output).toContain('canary_stage=browser_opened')
    expect(output).toContain('canary_stage=ticket_captured')
    expect(output).not.toMatch(/MUST_NOT|private@example|access_token/)
    expect(output).not.toContain('canary_stage=ticket=')
  })

  it('requires an explicit canary region and rejects login-only options', async () => {
    const io: AuthCliIO = { prompt: jest.fn(), write: jest.fn() }
    const canary = jest.fn()
    const dependencies: AuthCanaryCliDependencies = { canary }

    await expect(runAuthCanary({
      argv: ['canary'],
      io,
      dependencies,
    })).rejects.toThrow('Canary region is required')
    await expect(runAuthCanary({
      argv: ['canary', '--region', 'cn', '--account', 'personal'],
      io,
      dependencies,
    })).rejects.toThrow('Unknown canary option')
    await expect(runAuthCanary({
      argv: ['canary', '--region', 'cn', '--mfa-code=123456'],
      io,
      dependencies,
    })).rejects.toThrow('Passwords and MFA codes must be entered interactively')

    expect(canary).not.toHaveBeenCalled()
  })

  it('preserves signal-specific exit codes after browser cleanup', () => {
    const cancelled = new BrowserCanaryControlError('CANCELLED')
    const timedOut = new BrowserCanaryControlError('TIMED_OUT')

    expect(authCliExitCode(cancelled, 'SIGINT')).toBe(130)
    expect(authCliExitCode(cancelled, 'SIGTERM')).toBe(143)
    expect(authCliExitCode(cancelled, 'SIGHUP')).toBe(129)
    expect(authCliExitCode(
      new GarminAuthenticationCancelledError(),
      'SIGTERM',
    )).toBe(143)
    expect(authCliExitCode(timedOut)).toBe(1)
    expect(authCliExitCode(new Error('unexpected'))).toBe(1)
  })

  it('exits on SIGTERM while a normal login username prompt is pending', async () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(path.join(tmpdir(), 'garmin-auth-signal-test-'))
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const fakeTtyModule = `data:text/javascript,${encodeURIComponent(
      'Object.defineProperty(process.stdin,"isTTY",{value:true})',
    )}`
    const child = spawn(process.execPath, [
      '--import',
      fakeTtyModule,
      '--import',
      require.resolve('tsx'),
      entrypoint,
      'login',
      '--account',
      'signal-test',
      '--region',
      'global',
      '--output',
      path.join(directory, 'session.json'),
    ], {
      env: {
        ...process.env,
        GARMIN_USERNAME: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    let signalSent = false

    try {
      const result = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`auth CLI did not exit after SIGTERM: ${stderr}`))
        }, 10_000)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
          if (!signalSent && stderr.includes('Garmin email:')) {
            signalSent = true
            child.kill('SIGTERM')
          }
        })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      })

      expect(signalSent).toBe(true)
      expect(result).toEqual({ code: 143, signal: null })
      expect(stderr).toContain('Garmin email:')
      expect(stderr).not.toContain('authentication_status=passed')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it('exits with SIGINT status when Ctrl-C is entered in the hidden password prompt', async () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(path.join(tmpdir(), 'garmin-auth-ctrl-c-test-'))
    const entrypoint = path.resolve(__dirname, '../src/auth-cli.ts')
    const fakeTtyModule = `data:text/javascript,${encodeURIComponent(
      'Object.defineProperty(process.stdin,"isTTY",{value:true})',
    )}`
    const child = spawn(process.execPath, [
      '--import',
      fakeTtyModule,
      '--import',
      require.resolve('tsx'),
      entrypoint,
      'login',
      '--output',
      path.join(directory, 'session.json'),
    ], {
      env: {
        ...process.env,
        GARMIN_USERNAME: 'runner@example.test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    let controlSent = false

    try {
      const result = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`auth CLI did not exit after Ctrl-C: ${stderr}`))
        }, 10_000)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
          if (!controlSent && stderr.includes('Garmin password:')) {
            controlSent = true
            child.stdin.end('\u0003')
          }
        })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      })

      expect(controlSent).toBe(true)
      expect(result).toEqual({ code: 130, signal: null })
      expect(stderr).toContain('Garmin authentication was cancelled')
      expect(stderr).not.toContain('Authentication succeeded')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
