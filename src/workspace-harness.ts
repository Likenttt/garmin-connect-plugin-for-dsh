import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import type { Config, ResolvedAccountConfig } from './config'
import { createAccountRegistry, type AccountSource } from './account-registry'
import { createGarminClient } from './client-factory'
import { isCoachLoopback } from './coach-panel'
import { registerTools } from './tools'
import { connectWorkspace, type WorkspaceConnection } from './workspace-client'
import { acquireWorkspaceLease, defaultWorkspaceDirectory, registerWorkspace } from './workspace-runtime'
import { createWorkspaceService, type WorkspaceService, type WorkspaceToolDefinition } from './workspace-service'
import { startWorkspaceServer } from './workspace-server'

const ENDPOINTS = {
  'garmin-auth': ['account', 'begin', 'begin-cdp', 'status', 'cancel', 'verify'],
  'garmin-coach': ['members', 'check', 'timeline', 'notes', 'save-note', 'delete-note', 'preferences', 'save-preferences', 'save-account', 'remove-account'],
}
type Adapter = Pick<WorkspaceConnection, 'call' | 'auth' | 'invokeTool'>

/** Harness and stdio are adapters of the same live owner, whichever starts first. */
export function registerHarnessWorkspace(ctx: Context, options: {
  scopeId: string; legacySeeds: readonly ResolvedAccountConfig[]; baseConfig: Config
}): void {
  let disposed = false
  let cleanup: (() => Promise<void>) | undefined
  // The running Host owns one small listener; SDK clients remain demand-created.
  let owner: Promise<Adapter> | undefined
  const getOwner = (): Promise<Adapter> => {
    if (disposed) return Promise.reject(new Error('Garmin workspace is closed'))
    if (!owner) owner = initialize().catch(error => { owner = undefined; throw error })
    return owner
  }
  const descriptor = { scopeId: options.scopeId, dataDirectory: defaultWorkspaceDirectory() }
  // Publish discovery metadata on plugin load, so standalone MCP finds the exact
  // Host namespace even before its first data request. This does not start a process.
  let registration: ReturnType<typeof registerWorkspace> | undefined
  const register = (): ReturnType<typeof registerWorkspace> => {
    if (!registration) {
      const attempt = registerWorkspace(descriptor).catch(error => {
        // A transient storage failure must not poison every later UI retry.
        // Keep one in-flight registration; retain only a successful result.
        if (registration === attempt) registration = undefined
        throw error
      })
      registration = attempt
    }
    return registration
  }
  void register().catch(() => ctx.logger.error('[garmin] Could not register the local workspace'))
  async function initialize(): Promise<Adapter> {
    await register()
    if (disposed) throw new Error('Garmin workspace is closed')
    const lease = await acquireWorkspaceLease(descriptor)
    if (disposed) {
      await lease?.close()
      throw new Error('Garmin workspace is closed')
    }
    if (!lease) {
      const remote = await connectWorkspace(descriptor)
      const applied = await remote.configure({
        cacheTtl: options.baseConfig.cacheTtl, requestTimeoutMs: options.baseConfig.requestTimeoutMs ?? 15_000,
        logLevel: options.baseConfig.logLevel, authVerbose: options.baseConfig.authVerbose === true,
        activityDetail: options.baseConfig.activityDetail, fitDownloadDir: options.baseConfig.fitDownloadDir,
      }) as { success?: boolean }
      if (applied?.success !== true) { await remote.close(); throw new Error('Could not synchronize Garmin workspace settings') }
      cleanup = () => remote.close()
      if (disposed) { await cleanup(); throw new Error('Garmin workspace is closed') }
      return remote
    }
    const accounts = createAccountRegistry({ ...options, dataDirectory: descriptor.dataDirectory,
      createClient: config => createGarminClient(ctx, config, { allowUnconfigured: true }),
    })
    let service: WorkspaceService | undefined
    let server: Awaited<ReturnType<typeof startWorkspaceServer>> | undefined
    try {
      service = createWorkspaceService(accounts, { ...descriptor, logger: ctx.logger })
      await accounts.ready()
      const accessToken = randomBytes(24).toString('hex')
      server = await startWorkspaceServer({ service, accessToken, instanceId: lease.instanceId })
      await lease.publish({ origin: server.origin, accessToken })
      cleanup = async () => {
        try { await server!.close() }
        finally {
          try { await service!.close() }
          finally { accounts.close(); await lease.close() }
        }
      }
      if (disposed) { await cleanup(); throw new Error('Garmin workspace is closed') }
      return service
    } catch (error) {
      try { await server?.close() }
      finally {
        try { await service?.close() }
        finally { accounts.close(); await lease.close() }
      }
      throw error
    }
  }
  // Capture the existing definitions and renderers; only execution is forwarded.
  const empty: AccountSource = { ready: async () => undefined, list: () => [], subscribe: () => () => undefined }
  const toolContext = {
    logger: ctx.logger,
    effect: (callback: () => () => void, label?: string) => ctx.effect(callback, label),
    tools: { register: (definition: WorkspaceToolDefinition) => (ctx as any).tools.register({
      ...definition, execute: async (args: unknown) => {
        try { return await (await getOwner()).invokeTool(definition.name, args) }
        catch { return { error: true, message: 'The local Garmin workspace is unavailable. Retry the request.' } }
      },
    }) },
  }
  registerTools(toolContext as unknown as Context, empty)
  registerRoutes(ctx, getOwner)
  // Finish the one-time legacy import before a separate MCP adapter can create
  // an empty catalog. Opening a browser page still requires an explicit action.
  void getOwner().catch(() => ctx.logger.error('[garmin] Could not start the shared local workspace'))
  ctx.effect(() => async () => {
    disposed = true
    await owner?.catch(() => undefined)
    await cleanup?.()
  }, 'garmin-connect: shared workspace owner')
}

function registerRoutes(ctx: Context, owner: () => Promise<Adapter>): void {
  ctx.inject(['connection'], child => {
    const connection = child.connection as any
    const paths = Object.entries(ENDPOINTS).flatMap(([channel, endpoints]) => endpoints.map(endpoint => `/api/${channel}/${endpoint}`))
    const invoke = async (channel: string, endpoint: string, payload: unknown, signal: AbortSignal) => {
      try {
        const service = await owner()
        return { ok: true, value: await (channel === 'garmin-coach' ? service.call(endpoint, payload, signal) : service.auth(endpoint, payload, signal)) }
      } catch { return { ok: true, value: { success: false, code: 'unavailable' } } }
    }
    const disposers: Array<() => unknown> = []
    if (connection.fetch?.register) {
      child.on('connection/request', async (request, response, next) => {
        let protectedPath = false
        try { protectedPath = paths.includes(new URL(request.url ?? '', 'http://dsh.internal').pathname) } catch { /* unrelated */ }
        if (!protectedPath || isCoachLoopback(request.socket.remoteAddress)) { await next(); return }
        response.writeHead(403, { 'cache-control': 'no-store' }); response.end()
      })
      for (const [channel, endpoints] of Object.entries(ENDPOINTS)) for (const endpoint of endpoints) {
        disposers.push(connection.fetch.register({ path: `/api/${channel}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
          async fetch(request: Request) {
            const headers = { 'cache-control': 'no-store' }
            if (request.method !== 'POST') return new Response(null, { status: 405, headers })
            if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return new Response(null, { status: 415, headers })
            let body: any
            try {
              const text = await request.text()
              if (Buffer.byteLength(text) > 96 * 1024) return new Response(null, { status: 413, headers })
              body = JSON.parse(text)
            } catch { return new Response(null, { status: 400, headers }) }
            if (!body || body.type !== 'client-request' || typeof body.rpcId !== 'string' || !body.rpcId || body.rpcId.length > 128
              || body.method !== `${channel}/${endpoint}` || !Object.hasOwn(body, 'payload')) return new Response(null, { status: 400, headers })
            return Response.json({ type: 'server-response', rpcId: body.rpcId,
              result: await invoke(channel, endpoint, body.payload, request.signal),
            }, { headers })
          },
        }))
      }
    } else for (const channel of Object.keys(ENDPOINTS)) {
      disposers.push(connection.rpc.handle(`/${channel}`, (endpoint: string, payload: unknown, signal: AbortSignal) => invoke(channel, endpoint, payload, signal), { authority: 'loopback' }))
    }
    child.effect(() => async () => { await Promise.allSettled(disposers.reverse().map(dispose => Promise.resolve().then(dispose))) }, 'garmin-connect: workspace routes')
  })
}
