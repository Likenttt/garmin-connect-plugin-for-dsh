#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createAccountRegistry } from './account-registry'
import { createGarminClient } from './client-factory'
import type { Config } from './config'
import { connectWorkspace, resolveWorkspace } from './workspace-client'
import { acquireWorkspaceLease } from './workspace-runtime'
import { createWorkspaceService } from './workspace-service'
import { startWorkspaceServer } from './workspace-server'
import { publicErrorMessage } from './utils/errors'
import { resolveFitDownloadDir } from './utils/path'

const HELP = `Garmin 本机工作台

  garmin-connect-workspace open [--scope <scopeId>] [--data-directory <path>]
  garmin-connect-workspace open --no-open

账号、时间线和备注与同一工作区的 Harness/MCP 共用。
打开时按需启动一个共享进程；独立进程无活动五分钟后退出。
密码和两步验证只在佳明官方窗口中输入。
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return }
  const command = args.shift() ?? 'open'
  if (command !== 'open' && command !== 'serve') throw new Error('Expected open or serve')
  let scopeId: string | undefined
  let dataDirectory: string | undefined
  let noOpen = false
  while (args.length) {
    const argument = args.shift()
    if (argument === '--no-open' && !noOpen) { noOpen = true; continue }
    if (argument === '--scope' && !scopeId) scopeId = optionValue(args)
    else if (argument === '--data-directory' && !dataDirectory) dataDirectory = optionValue(args)
    else throw new Error('Invalid workspace option; use --help')
    if (!args.length && ((argument === '--scope' && !scopeId) || (argument === '--data-directory' && !dataDirectory))) throw new Error('Missing workspace option value')
  }
  const descriptor = await resolveWorkspace({ scopeId, dataDirectory })
  if (command === 'open') {
    const connection = await connectWorkspace(descriptor)
    try {
      const { url } = await connection.openPage()
      if (!noOpen) await openBrowser(url)
      process.stdout.write(`${url}\n`)
    } finally { await connection.close() }
    return
  }
  const lease = await acquireWorkspaceLease(descriptor)
  if (!lease) return // Another process won ownership; its endpoint will be published.
  const logger: any = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level,
    (line: unknown) => console.error(`[garmin-workspace:${level}] ${String(line)}`),
  ]))
  const baseConfig: Config = {
    username: '', region: 'cn', password: '', sessionToken: '', sessionTokenFile: '',
    cacheTtl: 300, requestTimeoutMs: 15_000, logLevel: 'info', activityDetail: 'full',
    fitDownloadDir: resolveFitDownloadDir(process.env.GARMIN_FIT_DOWNLOAD_DIR),
  }
  const accounts = createAccountRegistry({ ...descriptor, legacySeeds: [], baseConfig,
    createClient: config => createGarminClient({ logger } as any, config, { allowUnconfigured: true }),
  })
  let service: ReturnType<typeof createWorkspaceService> | undefined
  let server: Awaited<ReturnType<typeof startWorkspaceServer>> | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    try { await server?.close() }
    finally {
      try { await service?.close() }
      finally { accounts.close(); await lease.close() }
    }
  })()
  try {
    // Fail clearly on an unsupported SQLite runtime instead of advertising an
    // empty, non-persistent account editor.
    await accounts.ready()
    if (!accounts.managed) throw new Error('Workspace requires Node.js with node:sqlite support')
    service = createWorkspaceService(accounts, { ...descriptor, logger })
    const accessToken = randomBytes(24).toString('hex')
    server = await startWorkspaceServer({ service, accessToken, instanceId: lease.instanceId,
      onIdle: () => { void close() },
    })
    await lease.publish({ origin: server.origin, accessToken })
    process.once('SIGTERM', () => { void close() })
    process.once('SIGINT', () => { void close() })
  } catch (error) { await close(); throw error }
}

function optionValue(args: string[]): string {
  const value = args.shift()
  if (!value?.trim() || value.startsWith('-')) throw new Error('Missing workspace option value')
  return value
}

function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return Promise.reject(new Error('Invalid local page'))
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  return new Promise((resolve, reject) => execFile(command, [url], { windowsHide: true, timeout: 10_000 }, error => error ? reject(new Error('Could not open the browser; use --no-open')) : resolve()))
}

if (require.main === module) void main().catch(error => {
  console.error('[garmin-workspace]', publicErrorMessage(error, 'Could not open the local Garmin workspace; use --help'))
  process.exitCode = 1
})
