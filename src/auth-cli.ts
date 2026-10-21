#!/usr/bin/env node

import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { GarminAuthOptions, GarminAuthResult } from './auth'
import {
  assertAccountAlias,
  defaultAccountSessionPath,
} from './account-session'
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
import type { EmbeddedAuthRuntimeConfig } from './embedded-auth-runtime'
import {
  LocalAuthBroker,
  type LocalAuthBrokerController,
  type LocalAuthSuccessResult,
} from './local-auth-broker'
import {
  bindSessionTokensToAccount,
  prepareSessionTokenWriteDestination,
  writeSessionTokenFile,
  type GarminSessionFile,
} from './session-store'
import {
  GarminAuthenticationCancelledError,
  GarminAuthenticationRequiredError,
  PublicToolError,
  publicErrorMessage,
} from './utils/errors'

export interface AuthCliIO {
  prompt(label: string, secret: boolean, signal?: AbortSignal): Promise<string>
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
  signal?: AbortSignal
  dependencies?: AuthCliDependencies
  browserDependencies?: AuthServeCliDependencies
}

interface AuthSetupResultBase {
  account: string
  region: GarminRegion
  sessionTokenFile: string
}

export type AuthSetupResult = AuthSetupResultBase & (
  | { authenticationMode: 'terminal'; usedMfa: boolean }
  | {
      authenticationMode: 'browser'
      browserTrigger: 'blank_password' | 'mfa' | 'verification' | 'challenge'
    }
)

export interface AuthCanaryCliDependencies {
  canary(options: BrowserDiAuthCanaryOptions): Promise<BrowserDiAuthCanaryResult>
}

export interface BrowserAuthCliDependencies {
  setup(options: BrowserDiAuthSetupOptions): Promise<BrowserDiAuthSetupResult>
  prepareDestination(path: string): Promise<void>
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

export interface AuthServeCliDependencies {
  authenticate(options: EmbeddedAuthRuntimeConfig & {
    signal?: AbortSignal
  }): Promise<LocalAuthSuccessResult>
  prepareDestination(path: string): Promise<void>
}

export interface AuthServeInput {
  argv: string[]
  env: Record<string, string | undefined>
  io: AuthCliIO
  signal?: AbortSignal
  dependencies?: AuthServeCliDependencies
}

export interface AuthServeResult {
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
  prepareDestination: prepareSessionTokenWriteDestination,
}

const defaultServeDependencies: AuthServeCliDependencies = {
  authenticate: async (options) => {
    const runtime = require('./embedded-auth-runtime') as {
      createEmbeddedAuthController(
        config: EmbeddedAuthRuntimeConfig,
      ): LocalAuthBrokerController
    }
    const controller = runtime.createEmbeddedAuthController({
      username: options.username,
      region: options.region,
      sessionTokenFile: options.sessionTokenFile,
    })
    return new LocalAuthBroker({ controller }).authenticateInSystemBrowser(
      options.region,
      options.signal,
    )
  },
  prepareDestination: prepareSessionTokenWriteDestination,
}

const MAX_DISPLAYED_SESSION_PATH_BYTES = 1024

const AUTH_CLI_HELP = `Garmin Connect authentication

Usage:
  garmin-connect-auth login [options]
  garmin-connect-auth login --browser --region <global|cn> [options]
  garmin-connect-auth serve --account <alias> --region <global|cn> --open [options]
  garmin-connect-auth canary --region <global|cn>

Login options:
  --browser               Legacy Playwright diagnostic for Garmin's sign-in page
  --account <alias>       Account alias (default: default)
  --region <global|cn>    Region (default: global; required with --browser)
  --output <path>         OAuth session file path

Serve options:
  --open                  Open the loopback sign-in page in the system browser
  --account <alias>       Required; never inferred from environment
  --region <global|cn>    Required; never inferred from environment
  --output <path>         OAuth session file path

Canary options:
  --region <global|cn>    Required; never inferred from environment

General options:
  -h, --help              Show this help
  -V, --version           Show the installed version

Passwords are requested interactively with terminal echo disabled; leave the
password blank to use Garmin's browser page. MFA or CAPTCHA also continues in
that page. Never pass passwords or verification codes as command-line options
or model input.

The serve command keeps password, verification code, CAPTCHA, and MFA inside
Garmin's page. It writes only the resulting long-lived session to the selected
local account file. The canary remains a non-persisting diagnostic command.
`

const AUTH_CLI_VERSION = (require('../package.json') as { version: string }).version

/** Run the one-time foreground authentication flow without exposing secrets. */
export async function runAuthSetup(input: AuthSetupInput): Promise<AuthSetupResult> {
  const parsed = parseArgs(input.argv)
  const dependencies = input.dependencies ?? defaultDependencies
  const account = parsed.account ?? input.env.GARMIN_ACCOUNT?.trim() ?? 'default'
  assertAccountAlias(account)

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
    || (await promptAuthCli(
      input.io,
      'Garmin email: ',
      false,
      input.signal,
    )).trim()
  if (!username) throw new PublicToolError('Garmin username is required')

  // Authentication bootstrap always reads the password from the foreground
  // TTY. It deliberately ignores GARMIN_PASSWORD so MFA setup cannot silently
  // turn a long-lived environment secret into login input.
  let password = await promptAuthCli(
    input.io,
    'Garmin password: ',
    true,
    input.signal,
  )

  try {
    if (!password) {
      return continueAuthSetupInBrowser(
        input,
        { account, region, sessionTokenFile, username },
        'blank_password',
      )
    }
    const authenticated = await dependencies.authenticate({
      username,
      password,
      region,
      browserOnChallenge: true,
      signal: input.signal,
      promptMfa: async ({ method, signal }) => promptAuthCli(
        input.io,
        `Garmin MFA code (${safeMfaMethod(method)}): `,
        true,
        signal,
      ),
    })
    throwIfAuthCliCancelled(input.signal)
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
      authenticationMode: 'terminal',
      usedMfa: authenticated.usedMfa,
    }
  } catch (error) {
    if (
      !(error instanceof GarminAuthenticationRequiredError)
      || error.reason !== 'challenge'
    ) {
      throw error
    }
    return continueAuthSetupInBrowser(
      input,
      { account, region, sessionTokenFile, username },
      error.challengeKind ?? 'challenge',
    )
  } finally {
    // JavaScript strings cannot be reliably zeroized, but dropping the last
    // local reference promptly keeps the password out of subsequent logic.
    password = ''
  }
}

async function continueAuthSetupInBrowser(
  input: AuthSetupInput,
  details: {
    account: string
    region: GarminRegion
    sessionTokenFile: string
    username: string
  },
  browserTrigger: 'blank_password' | 'mfa' | 'verification' | 'challenge',
): Promise<AuthSetupResult> {
  await runAuthServe({
    argv: [
      'serve',
      '--open',
      '--account', details.account,
      '--region', details.region,
      '--output', details.sessionTokenFile,
    ],
    env: {
      ...input.env,
      GARMIN_USERNAME: details.username,
      GARMIN_PASSWORD: undefined,
    },
    io: input.io,
    signal: input.signal,
    dependencies: input.browserDependencies,
  })
  return {
    account: details.account,
    region: details.region,
    sessionTokenFile: details.sessionTokenFile,
    authenticationMode: 'browser',
    browserTrigger,
  }
}

/** Authenticate with Garmin's visible browser UI and persist a DI session. */
export async function runBrowserAuthSetup(
  input: BrowserAuthSetupInput,
): Promise<BrowserAuthSetupResult> {
  const parsed = parseBrowserLoginArgs(input.argv)
  const dependencies = input.dependencies ?? defaultBrowserDependencies
  const account = parsed.account ?? input.env.GARMIN_ACCOUNT?.trim() ?? 'default'
  assertAccountAlias(account)

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
  await dependencies.prepareDestination(sessionTokenFile)
  const username = input.env.GARMIN_USERNAME?.trim()
    || (await promptAuthCli(input.io, 'Garmin email: ', false, input.signal)).trim()
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
      (await promptAuthCli(
        input.io,
        browserIdentityConfirmationPrompt(identity, account, username),
        false,
        input.signal,
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

/** Serve the loopback bridge and open Garmin authentication in the OS browser. */
export async function runAuthServe(
  input: AuthServeInput,
): Promise<AuthServeResult> {
  const parsed = parseServeArgs(input.argv)
  const dependencies = input.dependencies ?? defaultServeDependencies
  const account = parsed.account
  if (!account) {
    throw new PublicToolError('Serve account is required; use --account <alias>')
  }
  assertAccountAlias(account)
  if (!parsed.open) {
    throw new PublicToolError('Serve authentication requires --open')
  }
  if (parsed.region !== 'global' && parsed.region !== 'cn') {
    throw new PublicToolError(
      parsed.region === undefined
        ? 'Serve region is required; use global or cn'
        : 'Invalid serve region; expected global or cn',
    )
  }
  const region: GarminRegion = parsed.region
  const configuredPath = parsed.output ?? input.env.GARMIN_SESSION_TOKEN_FILE?.trim()
  const sessionTokenFile = configuredPath
    ? path.resolve(expandHome(configuredPath))
    : defaultAccountSessionPath(account, input.env)
  await dependencies.prepareDestination(sessionTokenFile)
  const username = input.env.GARMIN_USERNAME?.trim()
    || (await promptAuthCli(input.io, 'Garmin email: ', false, input.signal)).trim()
  if (!username) throw new PublicToolError('Garmin username is required')

  input.io.write(
    'Opening Garmin authentication in your system browser. Enter password, ' +
    'verification code, CAPTCHA, or MFA only on Garmin\'s page.\n',
  )
  const result = await dependencies.authenticate({
    username,
    region,
    sessionTokenFile,
    signal: input.signal,
  })
  if (!result.success || result.region !== region) {
    throw new PublicToolError('Garmin browser authentication returned an invalid result')
  }

  input.io.write('authentication_status=passed\n')
  input.io.write(`region=${region}\n`)
  input.io.write('browser=system-default\n')
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

export { defaultAccountSessionPath } from './account-session'

interface ParsedArgs {
  account?: string
  region?: string
  output?: string
}

interface ParsedBrowserLoginArgs extends ParsedArgs {
  browser: true
}

interface ParsedServeArgs extends ParsedArgs {
  open: boolean
}

function parseBrowserLoginArgs(argv: string[]): ParsedBrowserLoginArgs {
  const result = parseAuthenticationOptions(argv, {
    command: 'login',
    booleanFlag: '--browser',
    unknownOptionMessage: 'Unknown browser authentication option',
  })
  if (!result.booleanEnabled) {
    throw new PublicToolError('Browser authentication requires --browser')
  }
  return { ...result.options, browser: true }
}

function parseArgs(argv: string[]): ParsedArgs {
  return parseAuthenticationOptions(argv, {
    command: 'login',
    unknownOptionMessage: 'Unknown authentication option',
  }).options
}

function parseServeArgs(argv: string[]): ParsedServeArgs {
  const result = parseAuthenticationOptions(argv, {
    command: 'serve',
    booleanFlag: '--open',
    unknownOptionMessage: 'Unknown serve authentication option',
  })
  return { ...result.options, open: result.booleanEnabled }
}

interface AuthenticationOptionParserConfig {
  command: 'login' | 'serve'
  booleanFlag?: '--browser' | '--open'
  unknownOptionMessage: string
}

function parseAuthenticationOptions(
  argv: string[],
  config: AuthenticationOptionParserConfig,
): { options: ParsedArgs; booleanEnabled: boolean } {
  const args = [...argv]
  if (args[0] === config.command) args.shift()
  rejectSensitiveArgs(args)
  let booleanEnabled = false
  const options: ParsedArgs = {}
  while (args.length > 0) {
    const flag = args.shift()
    if (flag === '--') {
      continue
    }
    if (flag === config.booleanFlag && !booleanEnabled) {
      booleanEnabled = true
      continue
    }
    if (flag === '--account' || flag === '--region' || flag === '--output') {
      const value = args.shift()
      if (!value || value.startsWith('--')) {
        throw new PublicToolError(`Missing value for ${flag}`)
      }
      if (flag === '--account') options.account = value
      else if (flag === '--region') options.region = value
      else options.output = value
      continue
    }
    throw new PublicToolError(config.unknownOptionMessage)
  }
  return { options, booleanEnabled }
}

function parseCanaryRegion(argv: string[]): GarminRegion {
  const args = [...argv]
  if (args[0] === 'canary') args.shift()
  let region: string | undefined
  while (args.length > 0) {
    const flag = args.shift()
    if (flag === '--') {
      continue
    }
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
    prompt: (label, secret, signal) => secret
      ? promptHidden(process.stdin, process.stderr, label, signal)
      : promptVisible(process.stdin, process.stderr, label, signal),
    write: message => process.stderr.write(message),
  }
}

function promptAuthCli(
  io: AuthCliIO,
  label: string,
  secret: boolean,
  signal?: AbortSignal,
): Promise<string> {
  return signal === undefined
    ? io.prompt(label, secret)
    : io.prompt(label, secret, signal)
}

function throwIfAuthCliCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GarminAuthenticationCancelledError()
}

async function promptVisible(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new GarminAuthenticationCancelledError()
  requireTty(input)
  const rl = readline.createInterface({ input, output, terminal: true })
  try {
    return await (signal === undefined
      ? rl.question(label)
      : rl.question(label, { signal }))
  } catch (error) {
    if (signal?.aborted) throw new GarminAuthenticationCancelledError()
    throw error
  } finally {
    rl.close()
  }
}

function promptHidden(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    return Promise.reject(new GarminAuthenticationCancelledError())
  }
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
      signal?.removeEventListener('abort', onAbort)
      input.setRawMode?.(wasRaw)
      input.pause()
      output.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string | Buffer): void => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          finish(new GarminAuthenticationCancelledError())
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
    const onAbort = (): void => {
      finish(new GarminAuthenticationCancelledError())
    }
    input.on('data', onData)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
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

const DEFAULT_AUTH_CLI_TERMINATION_GRACE_MS = 35_000
const MAX_AUTH_CLI_TERMINATION_GRACE_MS = 2 * 60 * 1000

export interface AuthCliSignalSource {
  on(signal: AuthCliTerminationSignal, listener: () => void): unknown
  off(signal: AuthCliTerminationSignal, listener: () => void): unknown
}

export interface AuthCliTerminationOptions {
  source?: AuthCliSignalSource
  forceExit?: (code: number) => void
  /** Internal test seam; production uses a 35-second graceful deadline. */
  graceMs?: number
}

export interface AuthCliTermination {
  signal: AbortSignal
  receivedSignal(): AuthCliTerminationSignal | undefined
  dispose(): void
}

/**
 * Give browser authentication one bounded graceful cancellation window.
 * A second signal is an explicit force-exit request; the deadline also keeps a
 * broken filesystem or browser dependency from trapping a terminated CLI.
 */
export function installAuthCliTermination(
  options: AuthCliTerminationOptions = {},
): AuthCliTermination {
  const source = options.source ?? (process as AuthCliSignalSource)
  const forceExit = options.forceExit ?? (code => process.exit(code))
  const graceMs = boundedAuthCliTerminationGrace(options.graceMs)
  const controller = new AbortController()
  let received: AuthCliTerminationSignal | undefined
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const handle = (signal: AuthCliTerminationSignal): void => {
    if (received) {
      forceExit(authCliSignalExitCode(signal))
      return
    }
    received = signal
    controller.abort()
    forceTimer = setTimeout(() => {
      forceExit(authCliSignalExitCode(signal))
    }, graceMs)
  }
  const handlers: Record<AuthCliTerminationSignal, () => void> = {
    SIGHUP: () => handle('SIGHUP'),
    SIGINT: () => handle('SIGINT'),
    SIGTERM: () => handle('SIGTERM'),
  }

  for (const signal of authCliTerminationSignals()) {
    source.on(signal, handlers[signal])
  }

  return {
    signal: controller.signal,
    receivedSignal: () => received,
    dispose() {
      if (disposed) return
      disposed = true
      if (forceTimer) clearTimeout(forceTimer)
      for (const signal of authCliTerminationSignals()) {
        source.off(signal, handlers[signal])
      }
    },
  }
}

export function authCliExitCode(
  error: unknown,
  signal?: AuthCliTerminationSignal,
): number {
  if (
    (
      error instanceof BrowserCanaryControlError
      || error instanceof GarminAuthenticationCancelledError
    )
    && error.code === 'CANCELLED'
  ) {
    return authCliSignalExitCode(signal ?? 'SIGINT')
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
      && (argv[0] === 'login' || argv[0] === 'canary' || argv[0] === 'serve')
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
      && (argv[0] === 'login' || argv[0] === 'canary' || argv[0] === 'serve')
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
    const serveRequested = argv[0] === 'serve'
    const termination = installAuthCliTermination()
    try {
      if (browserLoginRequested) {
        await runBrowserAuthSetup({
          argv,
          env: process.env,
          io: terminalIO(),
          signal: termination.signal,
        })
      } else if (serveRequested) {
        await runAuthServe({
          argv,
          env: process.env,
          io: terminalIO(),
          signal: termination.signal,
        })
      } else if (argv[0] === 'canary') {
        await runAuthCanary({
          argv,
          io: terminalIO(),
          signal: termination.signal,
        })
      } else {
        await runAuthSetup({
          argv,
          env: process.env,
          io: terminalIO(),
          signal: termination.signal,
        })
      }
    } finally {
      terminationSignal = termination.receivedSignal()
      termination.dispose()
    }
  } catch (error) {
    process.stderr.write(`${publicErrorMessage(error, 'Garmin authentication failed')}\n`)
    process.exitCode = authCliExitCode(error, terminationSignal)
  }
}

if (require.main === module) void main()

function authCliSignalExitCode(signal: AuthCliTerminationSignal): number {
  if (signal === 'SIGHUP') return 129
  return signal === 'SIGTERM' ? 143 : 130
}

function boundedAuthCliTerminationGrace(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_AUTH_CLI_TERMINATION_GRACE_MS
    ? value
    : DEFAULT_AUTH_CLI_TERMINATION_GRACE_MS
}

function authCliTerminationSignals(): readonly AuthCliTerminationSignal[] {
  return ['SIGHUP', 'SIGINT', 'SIGTERM']
}
