import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createMcpServer } from './mcp'
import { PublicToolError, publicErrorMessage } from './utils/errors'

export interface WorkspaceMcpOptions {
  scopeId?: string
  dataDirectory?: string
}
interface WorkspaceDescriptor {
  scopeId: string
  dataDirectory: string
}
interface WorkspaceConnection {
  invokeTool(name: string, args: Record<string, unknown>): Promise<unknown>
  openPage(): Promise<{ url: string }>
  close(): Promise<void>
}
export interface WorkspaceMcpDependencies {
  resolveWorkspace(options: WorkspaceMcpOptions): Promise<WorkspaceDescriptor>
  connectWorkspace(descriptor: WorkspaceDescriptor): Promise<WorkspaceConnection>
}

export const WORKSPACE_MCP_HELP = `Garmin Connect MCP

Usage:
  garmin-connect-mcp                       Legacy single account from GARMIN_* environment variables
  garmin-connect-mcp --workspace [scopeId]  Shared local account workspace (starts on first tool call)
  garmin-connect-mcp --workspace [scopeId] --data-directory <directory>

When only one shared workspace exists, omit scopeId to select it automatically.
Use list_garmin_accounts to find an accountId, then pass accountId to data tools.
Use open_garmin_workspace to get a link to the account, timeline, and notes page.
It returns a short-lived, one-use local link; open that link in your browser.
Account passwords are entered only in Garmin's own login window.
`

export function parseWorkspaceMcpArguments(argv: readonly string[]): {
  workspace: boolean
  help: boolean
  options: WorkspaceMcpOptions
} {
  let workspace = false
  let help = false
  const options: WorkspaceMcpOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { help = true; continue }
    if (argument === '--workspace') {
      if (workspace) throw new PublicToolError('Specify --workspace only once')
      workspace = true
      if (argv[index + 1] && !argv[index + 1].startsWith('-')) options.scopeId = argv[++index]
      continue
    }
    if (argument.startsWith('--workspace=')) {
      if (workspace || !argument.slice('--workspace='.length)) throw new PublicToolError('Invalid --workspace option')
      workspace = true
      options.scopeId = argument.slice('--workspace='.length)
      continue
    }
    if (argument === '--data-directory') {
      const directory = argv[++index]
      if (!directory || directory.startsWith('-') || options.dataDirectory) {
        throw new PublicToolError('--data-directory requires one directory')
      }
      options.dataDirectory = directory
      continue
    }
    throw new PublicToolError(`Unknown MCP option: ${argument.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80)}`)
  }
  if (options.dataDirectory && !workspace && !help) {
    throw new PublicToolError('--data-directory requires --workspace')
  }
  return { workspace, help, options }
}

/** Thin stdio adapter: the workspace owns SDK clients, auth flows, and persistence. */
export function createWorkspaceMcpServer(
  options: WorkspaceMcpOptions = {},
  dependencies: WorkspaceMcpDependencies = {
    resolveWorkspace: input => (require('./workspace-client') as WorkspaceMcpDependencies).resolveWorkspace(input),
    connectWorkspace: descriptor => (require('./workspace-client') as WorkspaceMcpDependencies).connectWorkspace(descriptor),
  },
): McpServer {
  let connection: Promise<WorkspaceConnection> | undefined
  let closed = false
  async function owner(): Promise<WorkspaceConnection> {
    if (closed) throw new PublicToolError('The Garmin workspace adapter is closed')
    if (!connection) {
      connection = dependencies.resolveWorkspace(options)
        .then(descriptor => dependencies.connectWorkspace(descriptor))
        .then(async result => {
          if (closed) {
            await result.close()
            throw new PublicToolError('The Garmin workspace adapter is closed')
          }
          return result
        })
      void connection.catch(() => { connection = undefined })
    }
    return connection
  }
  async function invokeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await (await owner()).invokeTool(name, args)
    // The shared tool layer returns public errors as data. Keep those errors
    // visible to MCP clients and direct MFA back to the local account page.
    if (isToolError(result)) {
      return { ...result, message: authHelp(result.message) }
    }
    return result
  }
  const server = createMcpServer({} as Parameters<typeof createMcpServer>[0], {
    workspace: {
      invokeTool,
      async close() {
        if (closed) return
        closed = true
        const pending = connection
        if (pending) {
          // A connection that resolves after close disposes itself in owner().
          const result = await pending.catch(() => undefined)
          await result?.close()
        }
      },
    },
  })
  ;(server as any).registerTool('list_garmin_accounts', {
    description: 'List or search account IDs and account notes in the shared local workspace. Does not log in to Garmin or return account emails, passwords, API keys, or session tokens. Use the stable accountId in data tools.',
    inputSchema: optionalArguments({
      search: z.string().max(100).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args: Record<string, unknown>) => call(() => invokeTool('list_garmin_accounts', args ?? {})))
  ;(server as any).registerTool('open_garmin_workspace', {
    description: 'Return a short-lived, one-use link to the on-demand local Garmin account management page. The user can click the link to manage account connections, sign in using Garmin, view timelines, and edit or export notes. Shares the same data as Harness. Does not launch a browser automatically.',
    inputSchema: optionalArguments({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, () => call(async () => (await owner()).openPage()))
  return server
}

function isToolError(value: unknown): value is { error: true; message: string } {
  return value !== null && typeof value === 'object'
    && (value as { error?: unknown }).error === true
    && typeof (value as { message?: unknown }).message === 'string'
}
function optionalArguments(shape: Record<string, z.ZodTypeAny>): z.ZodObject<any> {
  const schema = z.object(shape).strict()
  const parse = schema.safeParseAsync.bind(schema)
  schema.safeParseAsync = ((value: unknown, params?: unknown) => parse(value === undefined ? {} : value, params as any)) as typeof schema.safeParseAsync
  return schema
}
function authHelp(message: string): string {
  const adapted = message.replace(/\bset account\b/gi, 'set accountId')
  return /auth|session|log.?in|MFA|two.factor|登录|验证/i.test(adapted)
    ? `${adapted} Call open_garmin_workspace and use the login button for this account, then retry.`
    : adapted
}
async function call(action: () => Promise<unknown>) {
  try {
    const value = await action()
    return { ...(isToolError(value) ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: publicErrorMessage(error, 'Garmin workspace request failed') }) }] }
  }
}
