import path from 'node:path'
import {
  defaultAccountSessionPath,
  runAuthSetup,
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
})
