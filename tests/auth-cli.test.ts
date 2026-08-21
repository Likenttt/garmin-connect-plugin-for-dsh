import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BrowserCanaryControlError } from '../src/browser-auth-canary'
import {
  authCliExitCode,
  defaultAccountSessionPath,
  runAuthCanary,
  runBrowserAuthSetup,
  runAuthSetup,
  type BrowserAuthCliDependencies,
  type AuthCanaryCliDependencies,
  type AuthCliDependencies,
  type AuthCliIO,
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

describe('Garmin interactive auth CLI', () => {
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
    expect(result.stdout).toContain('garmin-connect-auth canary --region <global|cn>')
    expect(result.stdout).toContain('--account <alias>')
    expect(result.stdout).toContain('--region <global|cn>')
    expect(result.stdout).toContain('--output <path>')
    expect(result.stdout).toContain('Passwords and MFA codes are requested interactively')
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
    expect(result.stdout).toContain('--browser')
    expect(result.stdout).toContain(
      'Two-step verification is an unfinished developer preview',
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
    const dependencies: BrowserAuthCliDependencies = { setup }
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
    ), false)
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
      dependencies: { setup },
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
      dependencies: { setup },
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
      dependencies: { setup },
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
      dependencies: { setup },
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
      dependencies: { setup },
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
      dependencies: { setup },
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
      dependencies: { setup },
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
      dependencies: { setup },
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
    expect(authCliExitCode(timedOut)).toBe(1)
    expect(authCliExitCode(new Error('unexpected'))).toBe(1)
  })
})
