import type { Context } from '@deepseek-ai/cordis'
import type { AccountSource, MutableAccountRegistry } from './account-registry'
import type { Config } from './config'
import { CoachPanelService } from './coach-panel'
import { registerEmbeddedAuthRpcAccounts } from './embedded-auth-rpc'
import { registerTools } from './tools'

export interface WorkspaceToolDefinition {
  name: string
  execute(args: any): Promise<unknown>
  [key: string]: unknown
}
export interface WorkspaceService {
  call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<any>
  auth(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<any>
  invokeTool(name: string, args: unknown): Promise<any>
  readonly tools: readonly WorkspaceToolDefinition[]
  configure?(config: unknown): Promise<{ success: boolean; code?: string }>
  close(): Promise<void>
}

/** One set of account clients, confirmation handles and login flows for all adapters. */
export function createWorkspaceService(
  accounts: AccountSource,
  options: { scopeId: string; dataDirectory: string; logger: Context['logger'] },
): WorkspaceService {
  const disposers: Array<() => unknown> = []
  const tools: WorkspaceToolDefinition[] = []
  let authHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<any>) | undefined
  const context: any = {
    logger: options.logger,
    tools: { register: (tool: WorkspaceToolDefinition) => tools.push(tool) },
    connection: { rpc: { handle: (_channel: string, handler: typeof authHandler) => {
      authHandler = handler
      return () => { authHandler = undefined }
    } } },
    effect(callback: () => () => unknown) { disposers.push(callback()) },
    inject(_dependencies: string[], callback: (ctx: Context) => void) { callback(context) },
  }
  registerTools(context, accounts)
  registerEmbeddedAuthRpcAccounts(context, accounts)
  const panel = new CoachPanelService(accounts, options)
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  let closed = false
  return {
    tools,
    async configure(config) {
      if (closed || !runtimeConfig(config)) return { success: false, code: 'invalid' }
      await accounts.ready()
      await (accounts as Partial<MutableAccountRegistry>).reconfigure?.(config)
      return { success: true }
    },
    call: (endpoint, payload, signal) => panel.handle(endpoint, payload, signal),
    async auth(endpoint, payload, signal) {
      if (closed || !authHandler) return { success: false, code: 'unavailable' }
      const result = await authHandler(endpoint, payload, signal ?? new AbortController().signal)
      return result?.ok === true ? result.value : { success: false, code: 'unavailable' }
    },
    async invokeTool(name, args) {
      if (closed) return { error: true, message: 'Garmin workspace is unavailable. Retry the request.' }
      const tool = byName.get(name)
      if (!tool) return { error: true, message: 'Unknown Garmin tool.' }
      return tool.execute(args)
    },
    async close() {
      if (closed) return
      closed = true
      panel.close()
      await Promise.allSettled(disposers.reverse().map(dispose => Promise.resolve().then(dispose)))
    },
  }
}

type RuntimeConfig = Pick<Config, 'cacheTtl' | 'requestTimeoutMs' | 'logLevel' | 'authVerbose' | 'activityDetail' | 'fitDownloadDir'>
function runtimeConfig(value: unknown): value is RuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  return Object.keys(data).every(key => ['cacheTtl', 'requestTimeoutMs', 'logLevel', 'authVerbose', 'activityDetail', 'fitDownloadDir'].includes(key))
    && typeof data.cacheTtl === 'number' && Number.isFinite(data.cacheTtl) && data.cacheTtl >= 0
    && typeof data.requestTimeoutMs === 'number' && Number.isFinite(data.requestTimeoutMs) && data.requestTimeoutMs >= 1
    && ['debug', 'info', 'warn', 'error'].includes(String(data.logLevel))
    && typeof data.authVerbose === 'boolean'
    && (data.activityDetail === 'compact' || data.activityDetail === 'full')
    && typeof data.fitDownloadDir === 'string' && data.fitDownloadDir.length <= 4096 && !/[\u0000-\u001f]/.test(data.fitDownloadDir)
}
