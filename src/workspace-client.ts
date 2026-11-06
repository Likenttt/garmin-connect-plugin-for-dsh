import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PublicToolError } from './utils/errors'
import { defaultWorkspaceDirectory, listWorkspaces, normalizeWorkspace, readWorkspaceEndpoint,
  registerWorkspace, type WorkspaceDescriptor, type WorkspaceEndpoint } from './workspace-runtime'

export type { WorkspaceDescriptor } from './workspace-runtime'
export interface WorkspaceConnection {
  call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  auth(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  invokeTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>
  configure(config: unknown): Promise<unknown>
  openPage(): Promise<{ url: string }>
  close(): Promise<void>
}
export async function resolveWorkspace(options: { scopeId?: string; dataDirectory?: string } = {}): Promise<WorkspaceDescriptor> {
  const dataDirectory = options.dataDirectory ?? defaultWorkspaceDirectory()
  if (options.scopeId) return registerWorkspace({ scopeId: options.scopeId, dataDirectory })
  const workspaces = await listWorkspaces(dataDirectory)
  if (workspaces.length === 1) return workspaces[0]
  if (workspaces.length > 1) {
    throw new PublicToolError(`Multiple Garmin workspaces were found; specify --workspace <scopeId>. Available scopes: ${workspaces.map(value => value.scopeId).join(', ')}`)
  }
  // Older Harness builds created the catalog before discovery manifests
  // existed. Its filename hashes the already hashed scope, so guessing cannot
  // recover the original namespace. Never silently open an empty replacement.
  try {
    const names = await readdir(dataDirectory)
    if (names.some(name => /^accounts-[0-9a-f]{64}\.sqlite$/.test(name))) {
      throw new PublicToolError('An existing Harness account workspace was found. Open Harness once with this plugin version to register its shared workspace, then retry.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  return registerWorkspace({ scopeId: 'standalone', dataDirectory })
}
export interface WorkspaceConnectionOptions {
  /** Internal seam: a client never constructs a Garmin SDK instance. */
  start?: (descriptor: WorkspaceDescriptor) => Promise<void>
  fetch?: typeof fetch
  startupTimeoutMs?: number
}
/** Lazy adapter: connecting alone creates neither a child process nor a network request. */
export async function connectWorkspace(input: WorkspaceDescriptor, options: WorkspaceConnectionOptions = {}): Promise<WorkspaceConnection> {
  const descriptor = normalizeWorkspace(input)
  const fetchRequest = options.fetch ?? fetch
  let closed = false
  let pending: Promise<WorkspaceEndpoint> | undefined
  let desiredConfig: unknown
  let configuredInstance: string | undefined
  let configuring: { instanceId: string; promise: Promise<void> } | undefined
  const health = async (endpoint: WorkspaceEndpoint): Promise<boolean> => {
    try {
      const response = await fetchRequest(`${endpoint.origin}/internal/health`, {
        headers: { Authorization: `Bearer ${endpoint.accessToken}` },
        signal: AbortSignal.timeout(1500), redirect: 'error',
      })
      if (!response.ok) return false
      const value = await response.json() as Record<string, unknown>
      return value.success === true && value.instanceId === endpoint.instanceId
    } catch { return false }
  }
  const discover = async (): Promise<WorkspaceEndpoint> => {
    let endpoint = await readWorkspaceEndpoint(descriptor)
    if (endpoint && await health(endpoint)) return endpoint
    await (options.start ?? startWorkspaceDaemon)(descriptor)
    const until = Date.now() + (options.startupTimeoutMs ?? 20_000)
    while (!closed && Date.now() < until) {
      endpoint = await readWorkspaceEndpoint(descriptor)
      if (endpoint && await health(endpoint)) return endpoint
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new PublicToolError('The local Garmin workspace could not start. Use a Node.js version with node:sqlite support and retry.')
  }
  const endpoint = async () => {
    if (closed) throw new PublicToolError('The local Garmin workspace connection is closed')
    if (!pending) pending = discover().finally(() => { pending = undefined })
    return pending
  }
  const send = async (target: WorkspaceEndpoint, path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (closed || signal?.aborted) throw new PublicToolError('The local Garmin workspace request was cancelled')
    const response = await fetchRequest(`${target.origin}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${target.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}), signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000), redirect: 'error',
    }).catch(() => { throw new PublicToolError('The local Garmin workspace disconnected; retry the request after checking its result') })
    if (!response.ok) throw new PublicToolError('The local Garmin workspace rejected this request')
    return response.json()
  }
  const ensureConfiguration = async (target: WorkspaceEndpoint): Promise<void> => {
    if (desiredConfig === undefined || configuredInstance === target.instanceId) return
    if (configuring?.instanceId === target.instanceId) return configuring.promise
    const config = desiredConfig
    const current = { instanceId: target.instanceId, promise: Promise.resolve() }
    current.promise = send(target, '/internal/configure', config).then(value => {
      if (!isSuccess(value)) throw new PublicToolError('The local Garmin workspace could not apply its runtime settings')
      if (desiredConfig === config) configuredInstance = target.instanceId
    }).finally(() => { if (configuring === current) configuring = undefined })
    configuring = current
    return current.promise
  }
  const request = async (path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) throw signal.reason
    const target = await endpoint()
    await ensureConfiguration(target)
    return send(target, path, payload, signal)
  }
  const segment = (name: string) => {
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(name)) throw new PublicToolError('Invalid Garmin workspace operation')
    return name
  }
  return {
    call: (name, payload, signal) => request(`/internal/coach/${segment(name)}`, payload, signal),
    auth: (name, payload, signal) => request(`/internal/auth/${segment(name)}`, payload, signal),
    invokeTool: (name, payload, signal) => request(`/internal/tool/${segment(name)}`, payload, signal),
    async configure(config) {
      const target = await endpoint()
      const snapshot: unknown = JSON.parse(JSON.stringify(config))
      const result = await send(target, '/internal/configure', snapshot)
      if (isSuccess(result)) { desiredConfig = snapshot; configuredInstance = target.instanceId }
      return result
    },
    async openPage() {
      const value = await request('/internal/open', {}) as Record<string, unknown>
      const target = await endpoint()
      if (typeof value.url !== 'string') throw new PublicToolError('The local Garmin workspace page is unavailable')
      const url = new URL(value.url)
      if (url.origin !== target.origin || url.pathname !== '/' || !url.hash || url.username || url.password) {
        throw new PublicToolError('The local Garmin workspace page is unavailable')
      }
      return { url: value.url }
    },
    async close() { closed = true },
  }
}
function isSuccess(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).success === true
}
/** Spawn one shared owner; competing launches exit after failing the workspace lease. */
export function startWorkspaceDaemon(descriptor: WorkspaceDescriptor): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, 'workspace-cli.js'), 'serve', '--scope', descriptor.scopeId,
      '--data-directory', descriptor.dataDirectory], {
      detached: true, shell: false, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    })
    child.once('error', () => reject(new PublicToolError('The local Garmin workspace process could not start')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
