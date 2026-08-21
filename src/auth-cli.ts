#!/usr/bin/env node

import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { GarminAuthOptions, GarminAuthResult } from './auth'
import {
  BrowserCanaryControlError,
  isBrowserDiAuthCanaryStage,
  runBrowserDiAuthSetup,
  runBrowserDiAuthCanary,
  type BrowserDiAuthCanaryOptions,
  type BrowserDiAuthCanaryResult,
  type BrowserDiProfileIdentity,
  type BrowserDiAuthSetupOptions,
  type BrowserDiAuthSetupResult,
} from './browser-auth-canary'
import {
  createAxiosCanaryHttpAdapter,
  createPlaywrightBrowserAdapter,
} from './browser-auth-canary-runtime'
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

export interface AuthCanaryCliDependencies {
  canary(options: BrowserDiAuthCanaryOptions): Promise<BrowserDiAuthCanaryResult>
}

export interface BrowserAuthCliDependencies {
  setup(options: BrowserDiAuthSetupOptions): Promise<BrowserDiAuthSetupResult>
}

export interface BrowserAuthSetupInput {
  argv: string[]
  env: Record<string, string | undefined>
  io: AuthCliIO
  signal?: AbortSignal
  dependencies?: BrowserAuthCliDependencies
}

export interface BrowserAuthSetupResult {
  account: string
  region: GarminRegion
  sessionTokenFile: string
}

export interface AuthCanaryInput {
  argv: string[]
  io: AuthCliIO
  signal?: AbortSignal
  dependencies?: AuthCanaryCliDependencies
}

const defaultDependencies: AuthCliDependencies = {
  // Keep help/version and browser-only commands independent of the legacy
  // Garmin SDK graph. The SDK is loaded only if terminal login is selected.
  authenticate: options => (
    require('./auth') as typeof import('./auth')
  ).authenticateGarminSession(options),
  writeSession: writeSessionTokenFile,
}

const defaultCanaryDependencies: AuthCanaryCliDependencies = {
  canary: options => runBrowserDiAuthCanary(options, {
    browser: createPlaywrightBrowserAdapter(),
    http: createAxiosCanaryHttpAdapter(),
  }),
}

const defaultBrowserDependencies: BrowserAuthCliDependencies = {
  setup: options => runBrowserDiAuthSetup(options, {
    browser: createPlaywrightBrowserAdapter(),
    http: createAxiosCanaryHttpAdapter(),
    writeSession: writeSessionTokenFile,
  }),
}

const MAX_DISPLAYED_SESSION_PATH_BYTES = 1024

const AUTH_CLI_HELP = `Garmin Connect authentication

Usage:
  garmin-connect-auth login [options]
  garmin-connect-auth login --browser --region <global|cn> [options]
  garmin-connect-auth canary --region <global|cn>

Login options:
  --browser               Unfinished preview: use Garmin's page for credentials
  --account <alias>       Account alias (default: default)
  --region <global|cn>    Region (default: global; required with --browser)
  --output <path>         OAuth session file path

Canary options:
  --region <global|cn>    Required; never inferred from environment

General options:
  -h, --help              Show this help
  -V, --version           Show the installed version

Passwords and MFA codes are requested interactively with terminal echo disabled.
Never pass either secret as a command-line option, environment variable, or model input.

Two-step verification is an unfinished developer preview and is not supported
for the 0.1.5 release. The canary provides partial diagnostics only and saves no
session; a successful probe is not a supported authentication workflow.
`

const AUTH_CLI_VERSION = (require('../package.json') as { version: string }).version

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
    input.io.write(
      `Session saved securely to: ${sessionPathForTerminal(sessionTokenFile)}\n`,
    )
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

/** Authenticate with Garmin's visible browser UI and persist a DI session. */
export async function runBrowserAuthSetup(
  input: BrowserAuthSetupInput,
): Promise<BrowserAuthSetupResult> {
  const parsed = parseBrowserLoginArgs(input.argv)
  const dependencies = input.dependencies ?? defaultBrowserDependencies
  const account = parsed.account ?? input.env.GARMIN_ACCOUNT?.trim() ?? 'default'
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(account)) {
    throw new PublicToolError(
      'Invalid account alias; use lowercase letters, numbers, underscores, or hyphens',
    )
  }

  if (parsed.region !== 'global' && parsed.region !== 'cn') {
    throw new PublicToolError(
      parsed.region === undefined
        ? 'Browser login region is required; use global or cn'
        : 'Invalid browser login region; expected global or cn',
    )
  }
  const region: GarminRegion = parsed.region
  const configuredPath = parsed.output ?? input.env.GARMIN_SESSION_TOKEN_FILE?.trim()
  const sessionTokenFile = configuredPath
    ? path.resolve(expandHome(configuredPath))
    : defaultAccountSessionPath(account, input.env)
  const username = input.env.GARMIN_USERNAME?.trim()
    || (await input.io.prompt('Garmin email: ', false)).trim()
  if (!username) throw new PublicToolError('Garmin username is required')

  input.io.write(
    'Opening an isolated Garmin page. Enter password, MFA, or CAPTCHA only ' +
    'on Garmin\'s page; this CLI reads only the username.\n',
  )
  const result = await dependencies.setup({
    username,
    region,
    sessionTokenFile,
    signal: input.signal,
    confirmIdentity: async identity => (
      (await input.io.prompt(
        browserIdentityConfirmationPrompt(identity, account, username),
        false,
      )).trim().toLowerCase() === 'yes'
    ),
    onStage: (stage) => {
      if (isBrowserDiAuthCanaryStage(stage)) {
        input.io.write(`auth_stage=${stage}\n`)
      }
    },
  })
  if (!result.ok || result.region !== region || result.persisted !== true) {
    throw new PublicToolError('Garmin browser authentication returned an invalid result')
  }

  input.io.write('authentication_status=passed\n')
  input.io.write(`region=${region}\n`)
  input.io.write('browser=system-chrome\n')
  input.io.write('di_auth=passed\n')
  input.io.write('session_persisted=yes\n')
  input.io.write(
    `Session saved securely to: ${sessionPathForTerminal(sessionTokenFile)}\n`,
  )
  input.io.write('credentials_collected_by_cli=username-only\n')
  return { account, region, sessionTokenFile }
}

/** Run the non-persisting browser/DI probe without reading CLI credentials. */
export async function runAuthCanary(
  input: AuthCanaryInput,
): Promise<BrowserDiAuthCanaryResult> {
  rejectSensitiveArgs(input.argv)
  const region = parseCanaryRegion(input.argv)
  const dependencies = input.dependencies ?? defaultCanaryDependencies

  input.io.write(
    'Opening an isolated Garmin page. Enter email, password, MFA, or CAPTCHA ' +
    'only in that page; this CLI does not read those values or save a session.\n',
  )
  const result = await dependencies.canary({
    region,
    signal: input.signal,
    onStage: (stage) => {
      if (isBrowserDiAuthCanaryStage(stage)) {
        input.io.write(`canary_stage=${stage}\n`)
      }
    },
  })
  if (!result.ok || result.region !== region || result.persisted !== false) {
    throw new PublicToolError('Garmin browser authentication canary returned an invalid result')
  }

  input.io.write('canary_status=passed\n')
  input.io.write(`region=${region}\n`)
  input.io.write('browser=system-chrome\n')
  input.io.write('di_auth=passed\n')
  input.io.write('session_persisted=no\n')
  input.io.write('credentials_collected_by_cli=no\n')
  return { ok: true, region, persisted: false }
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

interface ParsedBrowserLoginArgs extends ParsedArgs {
  browser: true
}

function parseBrowserLoginArgs(argv: string[]): ParsedBrowserLoginArgs {
  const args = [...argv]
  if (args[0] === 'login') args.shift()
  rejectSensitiveArgs(args)
  let browser = false
  const parsed: ParsedArgs = {}
  while (args.length > 0) {
    const flag = args.shift()
    if (flag === '--browser' && !browser) {
      browser = true
      continue
    }
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
    throw new PublicToolError('Unknown browser authentication option')
  }
  if (!browser) throw new PublicToolError('Browser authentication requires --browser')
  return { ...parsed, browser: true }
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv]
  if (args[0] === 'login') args.shift()
  rejectSensitiveArgs(args)

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

function parseCanaryRegion(argv: string[]): GarminRegion {
  const args = [...argv]
  if (args[0] === 'canary') args.shift()
  let region: string | undefined
  while (args.length > 0) {
    const flag = args.shift()
    if (flag !== '--region' || region !== undefined) {
      throw new PublicToolError('Unknown canary option')
    }
    const value = args.shift()
    if (!value || value.startsWith('--')) {
      throw new PublicToolError('Missing value for --region')
    }
    region = value
  }
  if (!region) throw new PublicToolError('Canary region is required; use global or cn')
  if (region !== 'global' && region !== 'cn') {
    throw new PublicToolError('Invalid canary region; expected global or cn')
  }
  return region
}

function rejectSensitiveArgs(argv: readonly string[]): void {
  if (argv.some(argument => (
    argument === '--password'
    || argument.startsWith('--password=')
    || argument === '--mfa-code'
    || argument.startsWith('--mfa-code=')
  ))) {
    throw new PublicToolError(
      'Passwords and MFA codes must be entered interactively, not passed on the command line',
    )
  }
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  return value.startsWith(`~${path.sep}`)
    ? path.join(homedir(), value.slice(2))
    : value
}

function sessionPathForTerminal(value: string): string {
  return terminalQuotedValue(
    value,
    MAX_DISPLAYED_SESSION_PATH_BYTES,
    '[configured path omitted: exceeds display limit]',
  )
}

function browserIdentityConfirmationPrompt(
  identity: BrowserDiProfileIdentity,
  account: string,
  username: string,
): string {
  const labels = [
    identity.displayName
      ? `displayName=${terminalQuotedValue(identity.displayName, 512, '[omitted]')}`
      : undefined,
    identity.userName
      ? `userName=${terminalQuotedValue(identity.userName, 512, '[omitted]')}`
      : undefined,
  ].filter((value): value is string => value !== undefined).join(', ')
  return (
    `Authenticated Garmin profile (${labels || 'label unavailable'}). ` +
    `Bind it to local account ${terminalQuotedValue(account, 128, '[omitted]')} ` +
    `for username ${terminalQuotedValue(username, 512, '[omitted]')}? ` +
    'Type yes to save session: '
  )
}

function terminalQuotedValue(
  value: string,
  maxBytes: number,
  omitted: string,
): string {
  const encoded = JSON.stringify(value).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  )
  return Buffer.byteLength(encoded, 'utf8') <= maxBytes ? encoded : omitted
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

export type AuthCliTerminationSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM'

export function authCliExitCode(
  error: unknown,
  signal?: AuthCliTerminationSignal,
): number {
  if (
    error instanceof BrowserCanaryControlError
    && error.code === 'CANCELLED'
  ) {
    if (signal === 'SIGHUP') return 129
    return signal === 'SIGTERM' ? 143 : 130
  }
  return 1
}

async function main(): Promise<void> {
  let terminationSignal: AuthCliTerminationSignal | undefined
  try {
    const argv = process.argv.slice(2)
    const helpRequested = (
      argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')
    ) || (
      argv.length === 2
      && (argv[0] === 'login' || argv[0] === 'canary')
      && (argv[1] === '--help' || argv[1] === '-h')
    ) || (
      argv.length === 3
      && argv[0] === 'login'
      && argv[1] === '--browser'
      && (argv[2] === '--help' || argv[2] === '-h')
    )
    if (helpRequested) {
      process.stdout.write(AUTH_CLI_HELP)
      return
    }
    const versionRequested = (
      argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')
    ) || (
      argv.length === 2
      && (argv[0] === 'login' || argv[0] === 'canary')
      && (argv[1] === '--version' || argv[1] === '-V')
    ) || (
      argv.length === 3
      && argv[0] === 'login'
      && argv[1] === '--browser'
      && (argv[2] === '--version' || argv[2] === '-V')
    )
    if (versionRequested) {
      process.stdout.write(`${AUTH_CLI_VERSION}\n`)
      return
    }
    const browserLoginRequested = argv[0] === 'login' && argv.includes('--browser')
    if (argv[0] === 'canary' || browserLoginRequested) {
      const controller = new AbortController()
      const cancelFromSigint = (): void => {
        terminationSignal ??= 'SIGINT'
        controller.abort()
      }
      const cancelFromSigterm = (): void => {
        terminationSignal ??= 'SIGTERM'
        controller.abort()
      }
      const cancelFromSighup = (): void => {
        terminationSignal ??= 'SIGHUP'
        controller.abort()
      }
      process.once('SIGHUP', cancelFromSighup)
      process.once('SIGINT', cancelFromSigint)
      process.once('SIGTERM', cancelFromSigterm)
      try {
        if (browserLoginRequested) {
          await runBrowserAuthSetup({
            argv,
            env: process.env,
            io: terminalIO(),
            signal: controller.signal,
          })
        } else {
          await runAuthCanary({
            argv,
            io: terminalIO(),
            signal: controller.signal,
          })
        }
      } finally {
        process.off('SIGHUP', cancelFromSighup)
        process.off('SIGINT', cancelFromSigint)
        process.off('SIGTERM', cancelFromSigterm)
      }
      return
    }
    await runAuthSetup({ argv, env: process.env, io: terminalIO() })
  } catch (error) {
    process.stderr.write(`${publicErrorMessage(error, 'Garmin authentication failed')}\n`)
    process.exitCode = authCliExitCode(error, terminationSignal)
  }
}

if (require.main === module) void main()
