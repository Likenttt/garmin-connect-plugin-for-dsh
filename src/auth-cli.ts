#!/usr/bin/env node

import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import {
  authenticateGarminSession,
  type GarminAuthOptions,
  type GarminAuthResult,
} from './auth'
import type { GarminRegion } from './config'
import {
  bindSessionTokensToAccount,
  writeSessionTokenFile,
  type GarminSessionFile,
} from './session-store'
import { PublicToolError, publicErrorMessage } from './utils/errors'

export interface AuthCliIO {
  prompt(label: string, secret: boolean): Promise<string>
  write(message: string): void
}

export interface AuthCliDependencies {
  authenticate(options: GarminAuthOptions): Promise<GarminAuthResult>
  writeSession(path: string, tokens: GarminSessionFile): Promise<void>
}

export interface AuthSetupInput {
  argv: string[]
  env: Record<string, string | undefined>
  io: AuthCliIO
  dependencies?: AuthCliDependencies
}

export interface AuthSetupResult {
  account: string
  region: GarminRegion
  sessionTokenFile: string
  usedMfa: boolean
}

const defaultDependencies: AuthCliDependencies = {
  authenticate: authenticateGarminSession,
  writeSession: writeSessionTokenFile,
}

/** Run the one-time foreground authentication flow without exposing secrets. */
export async function runAuthSetup(input: AuthSetupInput): Promise<AuthSetupResult> {
  const parsed = parseArgs(input.argv)
  const dependencies = input.dependencies ?? defaultDependencies
  const account = parsed.account ?? input.env.GARMIN_ACCOUNT?.trim() ?? 'default'
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(account)) {
    throw new PublicToolError(
      'Invalid account alias; use lowercase letters, numbers, underscores, or hyphens',
    )
  }

  const regionValue = parsed.region ?? input.env.GARMIN_REGION?.trim() ?? 'global'
  if (regionValue !== 'global' && regionValue !== 'cn') {
    throw new PublicToolError('Invalid region; expected global or cn')
  }
  const region: GarminRegion = regionValue

  const configuredPath = parsed.output ?? input.env.GARMIN_SESSION_TOKEN_FILE?.trim()
  const sessionTokenFile = configuredPath
    ? path.resolve(expandHome(configuredPath))
    : defaultAccountSessionPath(account, input.env)

  const username = input.env.GARMIN_USERNAME?.trim()
    || (await input.io.prompt('Garmin email: ', false)).trim()
  if (!username) throw new PublicToolError('Garmin username is required')

  // Authentication bootstrap always reads the password from the foreground
  // TTY. It deliberately ignores GARMIN_PASSWORD so MFA setup cannot silently
  // turn a long-lived environment secret into login input.
  let password = await input.io.prompt('Garmin password: ', true)
  if (!password) throw new PublicToolError('Garmin password is required')

  try {
    const authenticated = await dependencies.authenticate({
      username,
      password,
      region,
      promptMfa: async ({ method }) => input.io.prompt(
        `Garmin MFA code (${safeMfaMethod(method)}): `,
        true,
      ),
    })
    await dependencies.writeSession(
      sessionTokenFile,
      bindSessionTokensToAccount(authenticated.tokens, username, region),
    )

    input.io.write('Authentication succeeded.\n')
    input.io.write(`Session saved securely to: ${sessionTokenFile}\n`)
    input.io.write(
      'Configure GARMIN_USERNAME, GARMIN_REGION, and GARMIN_SESSION_TOKEN_FILE; ' +
      'the runtime no longer needs GARMIN_PASSWORD.\n',
    )

    return {
      account,
      region,
      sessionTokenFile,
      usedMfa: authenticated.usedMfa,
    }
  } finally {
    // JavaScript strings cannot be reliably zeroized, but dropping the last
    // local reference promptly keeps the password out of subsequent logic.
    password = ''
  }
}

export function defaultAccountSessionPath(
  account: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim()
    || env.APPDATA?.trim()
    || path.join(env.HOME?.trim() || homedir(), '.config')
  return path.resolve(
    configRoot,
    'dsh-plugin-garmin-connect',
    'accounts',
    `${account}.session.json`,
  )
}

interface ParsedArgs {
  account?: string
  region?: string
  output?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv]
  if (args[0] === 'login') args.shift()
  if (args.some(argument => (
    argument === '--password'
    || argument.startsWith('--password=')
    || argument === '--mfa-code'
    || argument.startsWith('--mfa-code=')
  ))) {
    throw new PublicToolError(
      'Passwords and MFA codes must be entered interactively, not passed on the command line',
    )
  }

  const parsed: ParsedArgs = {}
  while (args.length > 0) {
    const flag = args.shift()
    if (flag === '--account' || flag === '--region' || flag === '--output') {
      const value = args.shift()
      if (!value || value.startsWith('--')) {
        throw new PublicToolError(`Missing value for ${flag}`)
      }
      if (flag === '--account') parsed.account = value
      else if (flag === '--region') parsed.region = value
      else parsed.output = value
      continue
    }
    throw new PublicToolError('Unknown authentication option')
  }
  return parsed
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  return value.startsWith(`~${path.sep}`)
    ? path.join(homedir(), value.slice(2))
    : value
}

function safeMfaMethod(value: string): string {
  return /^[a-z0-9_-]{1,20}$/i.test(value) ? value : 'verification'
}

function terminalIO(): AuthCliIO {
  return {
    prompt: (label, secret) => secret
      ? promptHidden(process.stdin, process.stderr, label)
      : promptVisible(process.stdin, process.stderr, label),
    write: message => process.stderr.write(message),
  }
}

async function promptVisible(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  label: string,
): Promise<string> {
  requireTty(input)
  const rl = readline.createInterface({ input, output, terminal: true })
  try {
    return await rl.question(label)
  } finally {
    rl.close()
  }
}

function promptHidden(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  label: string,
): Promise<string> {
  requireTty(input)
  output.write(label)
  const wasRaw = input.isRaw === true
  input.setRawMode?.(true)
  input.resume()
  input.setEncoding('utf8')

  return new Promise<string>((resolve, reject) => {
    let value = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      input.off('data', onData)
      input.setRawMode?.(wasRaw)
      input.pause()
      output.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string | Buffer): void => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          finish(new PublicToolError('Authentication cancelled'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
        } else if (character >= ' ' && value.length < 1024) {
          value += character
        }
      }
    }
    input.on('data', onData)
  })
}

function requireTty(input: Readable & { isTTY?: boolean }): void {
  if (!input.isTTY) {
    throw new PublicToolError(
      'Interactive authentication requires a local terminal (TTY)',
    )
  }
}

async function main(): Promise<void> {
  try {
    await runAuthSetup({
      argv: process.argv.slice(2),
      env: process.env,
      io: terminalIO(),
    })
  } catch (error) {
    process.stderr.write(`${publicErrorMessage(error, 'Garmin authentication failed')}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) void main()
