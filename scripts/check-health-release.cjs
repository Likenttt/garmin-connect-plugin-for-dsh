#!/usr/bin/env node
'use strict'

/**
 * Read-only release canary. The caller supplies a private account manifest.
 * Raw responses stay in memory; stdout and the report contain only metadata.
 * Example flags: --plugin-dir /absolute/plugin --accounts-file /private/accounts.json
 * --date 2026-10-15 --start-date 2026-10-09 --report /private/report.json
 */
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { isDeepStrictEqual } = require('node:util')

// Dependencies may log arbitrary error objects. Reserve both streams for our
// explicitly sanitized events before importing any plugin or SDK module.
const writeEvent = process.stdout.write.bind(process.stdout)
const discardWrite = (_chunk, encoding, callback) => {
  const done = typeof encoding === 'function' ? encoding : callback
  if (typeof done === 'function') done()
  return true
}
process.stdout.write = discardWrite
process.stderr.write = discardWrite
const emit = value => writeEvent(`${JSON.stringify(value)}\n`)

class ReleaseCheckError extends Error {
  constructor() { super(); this.name = 'ReleaseCheckError' }
}

const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AxiosError',
  'PublicToolError', 'GarminAuthenticationRequiredError', 'GarminDiSessionFileError',
  'GarminSessionTokenFileInvalidError', 'GarminSessionTokenFileMissingError',
  'ObsoleteGarminDiSessionError',
  'McpError', 'UrlElicitationRequiredError', 'AssertionError', 'ReleaseCheckError',
])

const ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN',
  'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK',
])

function httpStatusOf(value) {
  const candidate = value?.response?.status ?? value?.status ?? value?.statusCode
  return Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate : undefined
}

function errorCodeOf(error) {
  const candidate = error?.code ?? error?.cause?.code
  return ERROR_CODES.has(candidate) ? candidate : undefined
}

function failureReason(error) {
  // Inspect only exact product strings or a tightly bounded product pattern.
  // No part of the source message is copied to an event or the report.
  const message = typeof error?.message === 'string' ? error.message : ''
  if (error?.timedOut === true || ['ETIMEDOUT', 'ECONNABORTED'].includes(errorCodeOf(error))
    || /^Garmin request timed out after \d{1,8}ms$/.test(message)) return 'timeout'
  if (message === 'Garmin DI session could not be refreshed') return 'refresh_failed'
  if (message === 'Garmin DI session could not be persisted'
    || message === 'Garmin session token file could not be written') return 'persist_failed'
  if ([
    'Garmin DI session does not match the authenticated Garmin profile',
    'Garmin session token file does not match the configured account or region',
    'Garmin DI session file cannot be shared across account bindings',
  ].includes(message)) return 'profile_binding_mismatch'
  if ([
    'GarminSessionTokenFileMissingError', 'GarminSessionTokenFileInvalidError',
    'GarminDiSessionFileError', 'ObsoleteGarminDiSessionError',
  ].includes(error?.name) || [
    'Garmin session token file could not be read',
    'Garmin session token file does not exist',
    'Garmin session token file is invalid',
    'Garmin session token file permissions are unsafe; require owner-only access',
  ].includes(message)) return 'session_read_failed'
  if (error?.name === 'GarminAuthenticationRequiredError') return 'authentication_required'
  return 'request_failed'
}

function fail(label, error) {
  const name = ERROR_NAMES.has(error?.name) ? error.name : 'Error'
  const httpStatus = httpStatusOf(error)
  const errorCode = errorCodeOf(error)
  return {
    status: 'failed', label, reason: failureReason(error),
    error: { name, ...(httpStatus ? { httpStatus } : {}), ...(errorCode ? { errorCode } : {}) },
  }
}

function shape(value) {
  if (value === null) return { shape: 'null', count: 0 }
  if (Array.isArray(value)) return { shape: 'array', count: value.length }
  if (typeof value === 'object') return { shape: 'object', count: Object.keys(value).length }
  return { shape: typeof value }
}

function assert(condition) {
  if (!condition) throw new ReleaseCheckError()
}

function calendarDate(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000-'))
  const parsed = new Date(`${value}T00:00:00Z`)
  assert(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value)
  return value
}

function cliOptions() {
  const allowed = new Set(['--plugin-dir', '--accounts-file', '--date', '--start-date', '--report'])
  const options = {}
  const args = process.argv.slice(2)
  assert(args.length === allowed.size * 2)
  for (let i = 0; i < args.length; i += 2) {
    assert(allowed.has(args[i]) && !Object.hasOwn(options, args[i]) && args[i + 1])
    options[args[i]] = args[i + 1]
  }
  for (const name of ['--plugin-dir', '--accounts-file', '--report']) {
    assert(path.isAbsolute(options[name]))
  }
  calendarDate(options['--date'])
  calendarDate(options['--start-date'])
  assert(options['--start-date'] <= options['--date'])
  return options
}

function readAccounts(filename) {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let accounts
  try {
    const stat = fs.fstatSync(descriptor)
    assert(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size <= 64 * 1024)
    if (typeof process.getuid === 'function') assert(stat.uid === process.getuid())
    accounts = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
  } finally {
    fs.closeSync(descriptor)
  }
  assert(Array.isArray(accounts) && accounts.length > 0 && accounts.length <= 5)
  const ids = new Set()
  for (const account of accounts) {
    assert(account && typeof account === 'object' && !Array.isArray(account))
    assert(typeof account.accountId === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(account.accountId))
    assert(!ids.has(account.accountId))
    ids.add(account.accountId)
    assert(typeof account.username === 'string' && account.username.trim())
    assert(account.region === 'cn' || account.region === 'global')
    assert(typeof account.sessionTokenFile === 'string' && path.isAbsolute(account.sessionTokenFile))
  }
  return accounts
}

function requestArgs(definition, date, startDate) {
  if (definition.kind === 'daily') return { date }
  if (definition.kind === 'latest') return {}
  return {
    startDate, endDate: date,
    ...(definition.kind === 'raceRange' ? { aggregation: 'daily' } : {}),
  }
}

function successfulValue(value) {
  assert(!(value && typeof value === 'object' && value.error === true))
  assert(value !== undefined)
  return value
}

function mcpMatches(result, expected) {
  assert(result && result.isError !== true)
  if (Object.hasOwn(result, 'structuredContent') && isDeepStrictEqual(result.structuredContent, expected)) return
  const text = Array.isArray(result.content)
    ? result.content.filter(block => block.type === 'text' && typeof block.text === 'string') : []
  assert(text.length === 1 && isDeepStrictEqual(JSON.parse(text[0].text), expected))
}

function observeHttp(client) {
  const counts = new Map()
  const axios = client.gc?.client?.client
  assert(axios?.interceptors?.response)
  const count = status => {
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      counts.set(status, (counts.get(status) ?? 0) + 1)
    }
  }
  const interceptor = axios.interceptors.response.use(
    response => { count(response.status); return response },
    error => { count(error?.response?.status); return Promise.reject(error) },
  )
  return {
    total: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
    snapshot: () => Object.fromEntries([...counts.entries()].sort(([a], [b]) => a - b)),
    close: () => axios.interceptors.response.eject(interceptor),
  }
}

async function main() {
  const options = cliOptions()
  const accountSpecs = readAccounts(options['--accounts-file'])
  const pluginDir = options['--plugin-dir']
  const pluginRequire = createRequire(path.join(pluginDir, 'package.json'))
  const fromLib = name => pluginRequire(path.join(pluginDir, 'lib', name))
  const diSession = fromLib('di-session.js')
  const originalDiDependencies = diSession.createGarminDiSessionRuntimeDependencies
  let authCapture
  diSession.createGarminDiSessionRuntimeDependencies = (...factoryArgs) => {
    const dependencies = Reflect.apply(originalDiDependencies, diSession, factoryArgs)
    const capture = authCapture
    if (!capture) return dependencies
    const wrapped = { ...dependencies }
    for (const stage of ['refresh', 'probeProfile', 'writeSession']) {
      const action = dependencies[stage]
      wrapped[stage] = async (...args) => {
        try {
          const response = await Reflect.apply(action, dependencies, args)
          const httpStatus = httpStatusOf(response)
          const event = {
            region: capture.region, stage,
            status: stage === 'writeSession' || (httpStatus >= 200 && httpStatus < 300)
              ? 'passed' : 'failed',
            ...(httpStatus ? { httpStatus } : {}),
          }
          capture.stages.push(event)
          emit({ label: 'authentication-stage', ...event })
          return response
        } catch (error) {
          const httpStatus = httpStatusOf(error)
          const errorCode = errorCodeOf(error)
          const event = {
            region: capture.region, stage, status: 'failed',
            ...(httpStatus ? { httpStatus } : {}),
            ...(errorCode ? { errorCode } : {}),
          }
          capture.stages.push(event)
          emit({ label: 'authentication-stage', ...event })
          throw error
        }
      }
    }
    return wrapped
  }
  const { GarminClient } = fromLib('client.js')
  const { GarminToolService } = fromLib('tool-service.js')
  const { registerTools } = fromLib('tools/index.js')
  const { HEALTH_TOOLS } = fromLib('health-tools.js')
  const { createMcpServer } = fromLib('mcp.js')
  const { Client } = pluginRequire('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = pluginRequire('@modelcontextprotocol/sdk/inMemory.js')
  const sdkPackagePath = pluginRequire.resolve('garmin-connect/package.json')
  const sdkPackage = pluginRequire(sdkPackagePath)
  const { GarminConnect } = pluginRequire('garmin-connect')
  const report = {
    nodeVersion: process.version,
    sdk: { name: sdkPackage.name, version: sdkPackage.version, resolvePath: sdkPackagePath },
    date: options['--date'], startDate: options['--start-date'],
    scope: 'read-only-existing-sessions-no-password-or-browser',
    methods: {}, registration: {}, accounts: [], summary: { passed: 0, failed: 0 },
  }
  const record = (target, label, result) => {
    target[label] = result
    report.summary[result.status === 'passed' ? 'passed' : 'failed'] += 1
    emit({ label, ...result })
    return result
  }
  assert(HEALTH_TOOLS.length === 13)
  for (const definition of HEALTH_TOOLS) {
    record(report.methods, definition.method,
      typeof GarminConnect.prototype[definition.method] === 'function'
        ? { status: 'passed' } : fail('sdk-method-missing'))
  }
  const noop = () => undefined
  const context = { logger: { debug: noop, info: noop, warn: noop, error: noop } }
  const accounts = []
  try {
    for (const [slot, account] of accountSpecs.entries()) {
      const config = {
        username: account.username, password: '', sessionTokenFile: account.sessionTokenFile,
        region: account.region, cacheTtl: 300, requestTimeoutMs: 15_000,
        logLevel: 'error', activityDetail: 'full', fitDownloadDir: '',
      }
      const client = new GarminClient(context, config)
      // A missing or malformed legacy file can select the production fallback.
      // Fence its SDK login entry point so this session-only canary cannot send
      // a password request, including one with the deliberately empty password.
      client.gc.login = async () => { throw new ReleaseCheckError() }
      accounts.push({ ...account, slot: slot + 1, configured: true, config, client })
    }
    const definitions = []
    registerTools({ ...context, tools: { register: definition => definitions.push(definition) } }, accounts)
    const byName = new Map(definitions.map(definition => [definition.name, definition]))
    const registrationValid = definitions.length === 23 && byName.size === 23
      && HEALTH_TOOLS.every(definition => byName.has(definition.name))
    record(report.registration, 'dsh-tools', registrationValid
      ? { status: 'passed', count: definitions.length } : fail('dsh-registration'))
    assert(registrationValid)

    for (const account of accounts) {
      const result = { accountId: account.accountId, region: account.region, authStages: [], connection: {}, methods: {}, mcp: {}, baseline: {} }
      report.accounts.push(result)
      authCapture = { region: account.region, stages: result.authStages }
      let observer
      let mcpClient
      let mcpServer
      try {
        await account.client.connect()
        successfulValue(await account.client.getUserProfile())
        record(result.connection, 'session-profile', { status: 'passed' })
        observer = observeHttp(account.client)
        const rawResults = new Map()
        for (const definition of HEALTH_TOOLS) {
          try {
            const before = observer.total()
            const raw = successfulValue(await byName.get(definition.name).execute({
              ...requestArgs(definition, report.date, report.startDate), account: account.accountId,
            }))
            rawResults.set(definition.name, raw)
            record(result.methods, definition.method, {
              status: 'passed', ...shape(raw), httpResponses: observer.total() - before,
            })
          } catch (error) {
            record(result.methods, definition.method, fail('dsh-execution', error))
          }
        }
        const service = new GarminToolService(account.client, {
          activityDetail: 'full', fitDownloadDir: '', accountUsername: account.username,
          accountRegion: account.region,
        })
        mcpServer = createMcpServer(service)
        mcpClient = new Client({ name: 'health-release-canary', version: '1.0.0' })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)])
        const listed = await mcpClient.listTools()
        assert(listed.tools.length === 23 && HEALTH_TOOLS.every(definition => listed.tools.some(tool => tool.name === definition.name)))
        record(result.mcp, 'tool-registration', { status: 'passed', count: listed.tools.length })
        for (const definition of HEALTH_TOOLS) {
          try {
            assert(rawResults.has(definition.name))
            const before = observer.total()
            const response = await mcpClient.callTool({
              name: definition.name, arguments: requestArgs(definition, report.date, report.startDate),
            })
            mcpMatches(response, rawResults.get(definition.name))
            const networkResponses = observer.total() - before
            assert(networkResponses === 0)
            record(result.mcp, definition.method, { status: 'passed', parity: true, httpResponses: networkResponses })
          } catch (error) {
            record(result.mcp, definition.method, fail('mcp-parity-or-cache', error))
          }
        }
        for (const baseline of [
          { name: 'get_garmin_profile', args: {} },
          { name: 'get_garmin_activities', args: { limit: 1 } },
          { name: 'get_garmin_sleep', args: { startDate: report.date, endDate: report.date } },
        ]) {
          try {
            const value = successfulValue(await byName.get(baseline.name).execute({ ...baseline.args, account: account.accountId }))
            record(result.baseline, baseline.name, { status: 'passed', ...shape(value) })
          } catch (error) {
            record(result.baseline, baseline.name, fail('baseline-execution', error))
          }
        }
      } catch (error) {
        record(result.connection, 'account-check', fail('account-check', error))
      } finally {
        result.httpStatuses = observer?.snapshot() ?? {}
        for (const close of [
          () => mcpClient?.close(), () => mcpServer?.close(),
          () => observer?.close(), () => account.client.deactivate(),
        ]) {
          try { await close() } catch (error) {
            record(result.connection, 'cleanup', fail('cleanup', error))
          }
        }
        authCapture = undefined
      }
    }
  } finally {
    for (const account of accounts) account.client.deactivate()
    diSession.createGarminDiSessionRuntimeDependencies = originalDiDependencies
  }
  report.summary.status = report.summary.failed === 0 ? 'passed' : 'failed'
  const descriptor = fs.openSync(options['--report'], 'wx', 0o600)
  try { fs.writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n', 'utf8') }
  finally { fs.closeSync(descriptor) }
  emit({ label: 'summary', ...report.summary })
  if (report.summary.failed > 0) process.exitCode = 1
}

main().catch(error => {
  emit(fail('release-check-fatal', error))
  process.exitCode = 1
})
