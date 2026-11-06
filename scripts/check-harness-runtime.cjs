#!/usr/bin/env node
'use strict'

// Offline compatibility check against a real Cordis package, including one in
// Electron's app.asar. Only the Garmin client is replaced with synthetic data.
// Usage: node scripts/check-harness-runtime.cjs --cordis /absolute/cordis/package
// For app.asar, run the script with ELECTRON_RUN_AS_NODE=1 and the app executable.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire, Module } = require('node:module')

const write = process.stdout.write.bind(process.stdout)
const emit = value => write(`${JSON.stringify(value)}\n`)
// Imported libraries may log. The report contains only fixture check results.
const discard = (_chunk, encoding, callback) => {
  const done = typeof encoding === 'function' ? encoding : callback
  if (typeof done === 'function') done()
  return true
}
process.stdout.write = discard
process.stderr.write = discard
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GARMIN_')) delete process.env[key]
}

const project = path.resolve(__dirname, '..')
const projectRequire = createRequire(path.join(project, 'package.json'))
const args = process.argv.slice(2)
const cordisPath = args.length === 0
  ? path.dirname(projectRequire.resolve('@deepseek-ai/cordis/package.json'))
  : args.length === 2 && args[0] === '--cordis' && path.isAbsolute(args[1])
    ? args[1] : undefined
let phase = 'arguments'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function eventually(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await tick()
  }
  assert.ok(predicate(), 'runtime did not settle')
}

async function main() {
  const runtimeDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'garmin-runtime-canary-'))
  process.env.XDG_CONFIG_HOME = runtimeDirectory
  assert.ok(cordisPath, 'expected --cordis /absolute/package')
  const version = JSON.parse(fs.readFileSync(path.join(cordisPath, 'package.json'), 'utf8')).version
  const { Context } = require(cordisPath)
  const definitions = new Map()
  const routes = new Map()
  const clients = []
  let registrationCount = 0
  let routeDisposals = 0
  let context
  let fiber
  let report
  let clientDisposals = 0
  const fixtureProfile = { displayName: 'canary', fullName: 'Synthetic runner' }
  const factory = {
    createGarminClient(_ctx, config) {
      const client = {
        connect: async () => undefined,
        getUserProfile: async () => fixtureProfile,
        getAuthenticatedAccount: () => ({ email: 'canary@example.test', region: config.region }),
        getAuthenticationRequirement: () => undefined,
        replacePersistedSession: async () => { throw new Error('session writes are forbidden') },
        deactivate: () => { clientDisposals += 1 },
      }
      clients.push(client)
      return client
    },
  }
  // Load the compiled entry unchanged except for the client factory. The real
  // config, account resolver, tool definitions, RPC handlers and lifecycle run.
  const entry = path.join(project, 'lib/index.js')
  const entryRequire = createRequire(entry)
  const module = { exports: {} }
  // The shared owner imports the factory from its own module, so replace the
  // resolved module too. The compiled workspace/runtime graph stays unchanged.
  const factoryPath = entryRequire.resolve('./client-factory')
  const previousFactory = require.cache[factoryPath]
  const fixtureFactory = new Module(factoryPath)
  fixtureFactory.filename = factoryPath
  fixtureFactory.loaded = true
  fixtureFactory.exports = factory
  require.cache[factoryPath] = fixtureFactory
  const load = specifier => specifier === './client-factory' ? factory : entryRequire(specifier)
  const compile = vm.runInThisContext(
    `(function(exports, require, module, __filename, __dirname) {\n${fs.readFileSync(entry, 'utf8')}\n})`,
    { filename: entry },
  )
  try { compile(module.exports, load, module, entry, path.dirname(entry)) }
  finally {
    if (previousFactory) require.cache[factoryPath] = previousFactory
    else delete require.cache[factoryPath]
  }
  const plugin = module.exports

  phase = 'configuration'
  const raw = {
    username: 'canary@example.test', region: 'global', password: '', sessionToken: '',
    sessionTokenFile: path.join(project, 'unused-runtime-canary.session.json'),
    authVerbose: false,
  }
  const parsed = plugin.Config(raw)
  assert.equal(typeof parsed.username.get, 'function')
  assert.equal(typeof parsed.authVerbose.get, 'function')
  assert.equal(plugin.resolveConfig(parsed).username, raw.username)
  assert.equal(plugin.resolveConfig(parsed).authVerbose, false)
  assert.equal(plugin.resolveConfig({ ...parsed, authVerbose: { get: () => true } }).authVerbose, true)

  try {
    phase = 'host-activation'
    context = new Context()
    context.provide('loader', { config: { baseUrl: 'file:///synthetic-dsh-profile/config.yml' } })
    context.provide('tools', {
      register(definition) {
        registrationCount += 1
        definitions.set(definition.name, definition)
      },
    })
    context.provide('connection', {
      fetch: {
        register(route) {
          assert.equal(route.requestBody, 'buffered')
          assert.deepEqual(route.methods, ['POST'])
          routes.set(route.path, route)
          return () => {
            routeDisposals += 1
            if (routes.get(route.path) === route) routes.delete(route.path)
          }
        },
      },
      rpc: { handle() { throw new Error('unexpected legacy RPC path') } },
    })
    fiber = await context.plugin(plugin, raw)
    await eventually(() => routes.size === 16)
    const rpc = async (channel, endpoint, payload = {}) => {
      const response = await routes.get(`/api/${channel}/${endpoint}`).fetch(new Request(
        `http://127.0.0.1/api/${channel}/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'runtime-canary', method: `${channel}/${endpoint}`, payload }),
        },
      ))
      assert.equal(response.status, 200)
      const reply = await response.json()
      assert.equal(reply.result.ok, true)
      return reply.result.value
    }
    // Import, lease publication and listener startup are asynchronous. A real
    // metadata request waits for readiness without creating an SDK client.
    phase = 'workspace-readiness'
    const members = await rpc('garmin-coach', 'members')
    assert.equal(members.success, true)
    assert.equal(members.managed, true)
    assert.equal(members.members.length, 1)
    assert.equal(fiber.state, 2)
    assert.equal(definitions.size, 30)
    assert.equal(clients.length, 0)

    phase = 'tool-execution'
    const profile = definitions.get('get_garmin_profile')
    const result = await profile.execute({ account: 'legacy-global' })
    assert.equal(result.fullName, fixtureProfile.fullName)
    assert.equal(result.displayName, fixtureProfile.displayName)
    assert.equal(clients.length, 1)
    const rendered = profile.output.render({ account: 'legacy-global' }, result)
    assert.ok(Array.isArray(rendered) && rendered.some(block => block.type === 'text'))

    phase = 'account-rpc'
    const account = await rpc('garmin-auth', 'account')
    assert.equal(account.accounts.length, 1)
    assert.equal(account.accounts[0].authenticated, true)

    phase = 'volatile-restart'
    fiber.ctx.emit('loader/volatile-update', [['authVerbose']])
    await eventually(() => clientDisposals === 1 && routes.size === 16)
    assert.equal((await rpc('garmin-coach', 'members')).success, true)
    assert.equal(clients.length, 1)
    await definitions.get('get_garmin_profile').execute({ account: 'legacy-global' })
    assert.equal(clients.length, 2)
    assert.equal(fiber.state, 2)
    assert.equal(clientDisposals, 1)
    assert.equal(routeDisposals, 16)
    assert.equal(registrationCount, 60)

    phase = 'cleanup'
    await fiber.dispose()
    fiber = undefined
    assert.equal(clientDisposals, 2)
    assert.equal(routeDisposals, 32)
    assert.equal(routes.size, 0)
    report = {
      status: 'passed', cordis: version, configurationReferences: true,
      toolDefinitions: definitions.size, syntheticProfileExecution: true,
      syntheticAccountRpc: true, fetchRoutes: 16, volatileRestart: true,
      sharedOwnerReadiness: true, sdkClientsAtStartup: 0,
      clientDisposals, routeDisposals,
    }
  } finally {
    await fiber?.dispose()
    await context?.fiber.dispose()
    fs.rmSync(runtimeDirectory, { recursive: true, force: true })
  }
  emit(report)
}

main().catch(error => {
  emit({ status: 'failed', phase, error: error instanceof assert.AssertionError ? 'assertion' : 'runtime' })
  process.exitCode = 1
})
