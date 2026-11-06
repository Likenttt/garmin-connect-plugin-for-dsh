import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isCoachLoopback } from './coach-panel'
import type { WorkspaceService } from './workspace-service'

const TOKEN = /^[a-f0-9]{64}$/
const BODY_LIMIT = 96 * 1024
const SESSION_TTL = 8 * 60 * 60_000
const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#007cc3" d="M12 3 22 21H2Z"/></svg>')}`
const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Garmin 工作台</title><link rel="icon" type="image/svg+xml" href="${FAVICON}"></head><body><div id="root"></div><script src="/workspace.js" defer></script></body></html>`

export interface WorkspaceServerOptions {
  service: WorkspaceService
  accessToken: string
  instanceId: string
  assetsDirectory?: string
  idleMs?: number
  onIdle?(): void
}
export interface WorkspaceServer {
  origin: string
  openPage(): { url: string }
  close(): Promise<void>
}

/** Private machine API and a separately authenticated, same-origin browser UI. */
export async function startWorkspaceServer(options: WorkspaceServerOptions): Promise<WorkspaceServer> {
  if (!/^[a-f0-9]{48}$/.test(options.accessToken)) throw new Error('Invalid workspace authentication configuration')
  let origin = ''
  let lastActivity = Date.now()
  let active = 0
  let closed = false
  const tickets = new Map<string, number>()
  const sessions = new Map<string, { csrf: string; expires: number }>()
  const flows = new Map<string, { session: string; accountId: string; revision: string; expires: number }>()
  const cookieName = `garmin-workspace-${options.instanceId.slice(0, 12)}`
  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  const denied = (res: ServerResponse, status = 403) => json(res, { success: false, code: 'unavailable' }, status)
  const openPage = () => {
    prune()
    if (tickets.size >= 32) tickets.delete(tickets.keys().next().value!)
    const ticket = randomBytes(32).toString('hex')
    tickets.set(ticket, Date.now() + 60_000)
    lastActivity = Date.now()
    return { url: `${origin}/#ticket=${ticket}` }
  }
  function prune() {
    const now = Date.now()
    for (const [token, expires] of tickets) if (expires <= now) tickets.delete(token)
    for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token)
    for (const [id, flow] of flows) if (flow.expires <= now) flows.delete(id)
  }
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src http://127.0.0.1:* http://localhost:*; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
    if (!isCoachLoopback(req.socket.remoteAddress) || req.headers.host !== new URL(origin).host) return denied(res)
    let path: string
    try { path = new URL(req.url ?? '/', origin).pathname } catch { return denied(res, 400) }
    active += 1
    try {
      // Never accept browser cookies or browser-origin requests on the machine API.
      if (path.startsWith('/internal/')) {
        if (req.headers.origin || !equal(req.headers.authorization, `Bearer ${options.accessToken}`)) return denied(res)
        lastActivity = Date.now()
        if (path === '/internal/health' && req.method === 'GET') {
          return json(res, { success: true, instanceId: options.instanceId })
        }
        if (req.method !== 'POST') return denied(res, 405)
        const payload = await readJson(req)
        if (path === '/internal/open') return json(res, openPage())
        if (path === '/internal/configure') return json(res, await options.service.configure?.(payload) ?? { success: false, code: 'unavailable' })
        const match = /^\/internal\/(coach|auth|tool)\/([a-z0-9_-]+)$/.exec(path)
        if (!match) return denied(res, 404)
        const signal = requestSignal(req, res)
        const result = match[1] === 'coach' ? await options.service.call(match[2], payload, signal)
          : match[1] === 'auth' ? await options.service.auth(match[2], payload, signal)
            : await options.service.invokeTool(match[2], payload)
        return json(res, result)
      }
      if ((path === '/' || path === '/workspace.js') && req.method === 'GET') {
        const content = path === '/' ? HTML : await readFile(join(options.assetsDirectory ?? __dirname, 'workspace.js'))
        res.writeHead(200, { 'content-type': path === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8' })
        return res.end(content)
      }
      prune()
      const cookie = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
      let session = cookie && TOKEN.test(cookie) ? sessions.get(cookie) : undefined
      if (path === '/api/workspace/session') {
        if (req.method === 'POST') {
          if (req.headers.origin !== origin) return denied(res)
          const payload = await readJson(req)
          if (!isRecord(payload) || Object.keys(payload).length !== 1 || typeof payload.ticket !== 'string'
            || !TOKEN.test(payload.ticket) || !tickets.has(payload.ticket)) return denied(res)
          tickets.delete(payload.ticket)
          // A second browser tab must not invalidate the first tab's CSRF or drafts.
          if (!session) {
            if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!)
            const sessionId = randomBytes(32).toString('hex')
            session = { csrf: randomBytes(32).toString('hex'), expires: Date.now() + SESSION_TTL }
            sessions.set(sessionId, session)
            res.setHeader('set-cookie', `${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`)
          }
        } else if (req.method !== 'GET') return denied(res, 405)
        if (req.headers.origin && req.headers.origin !== origin) return denied(res)
        if (!session) return denied(res, 401)
        lastActivity = Date.now()
        return json(res, { csrf: session.csrf })
      }
      if (!session || req.method !== 'POST' || req.headers.origin !== origin
        || !equal(req.headers['x-workspace-csrf'], session.csrf)) return denied(res)
      lastActivity = Date.now()
      const payload = await readJson(req)
      const signal = requestSignal(req, res)
      const coach = /^\/api\/garmin-coach\/([a-z-]+)$/.exec(path)
      if (coach) return json(res, { ok: true, value: await options.service.call(coach[1], payload, signal) })
      const login = /^\/api\/workspace\/login(?:\/(status|cancel|verify))?$/.exec(path)
      if (!login || !isRecord(payload) || typeof payload.accountId !== 'string' || typeof payload.expectedRevision !== 'string') return denied(res, 400)
      const members = await options.service.call('members', {}, signal)
      const member = members.success && members.members.find((value: any) => value.accountId === payload.accountId && value.revision === payload.expectedRevision)
      if (!member) return json(res, { success: false, code: 'stale_config' })
      if (login[1] === 'status' || login[1] === 'cancel') {
        const flow = typeof payload.flowId === 'string' && flows.get(payload.flowId)
        if (!flow || flow.session !== cookie || flow.accountId !== member.accountId || flow.revision !== member.revision) return denied(res)
        const result = await options.service.auth(login[1], { flowId: payload.flowId }, signal)
        if (login[1] === 'cancel' || (result.success && result.status !== 'in_progress')
          || (!result.success && (result.code === 'invalid' || result.code === 'stale_config'))) flows.delete(payload.flowId as string)
        return json(res, result)
      }
      if (login[1] === 'verify') return json(res, await options.service.call('check', { accountId: member.accountId }, signal))
      if (payload.mode !== 'browser' && payload.mode !== 'cdp') return denied(res, 400)
      const result = await options.service.auth(payload.mode === 'cdp' ? 'begin-cdp' : 'begin', {
        accountId: member.accountId, expectedRevision: member.revision, expectedRegion: member.region,
      }, signal)
      if (result.success && typeof result.flowId === 'string') {
        flows.set(result.flowId, { session: cookie!, accountId: member.accountId, revision: member.revision, expires: result.expiresAt })
      }
      return json(res, result)
    } catch (error) {
      if (!res.headersSent) denied(res, error instanceof RequestError ? error.status : 500)
      else res.end()
    } finally { active -= 1 }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Workspace listener unavailable')
  origin = `http://127.0.0.1:${address.port}`
  const idleTimer = options.onIdle ? setInterval(() => {
    prune()
    if (!closed && !active && !flows.size && Date.now() - lastActivity >= (options.idleMs ?? 5 * 60_000)) options.onIdle?.()
  }, Math.min(options.idleMs ?? 60_000, 60_000)) : undefined
  idleTimer?.unref()
  return {
    origin, openPage,
    async close() {
      if (closed) return
      closed = true
      if (idleTimer) clearInterval(idleTimer)
      tickets.clear(); sessions.clear(); flows.clear()
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections() })
    },
  }
}

class RequestError extends Error { constructor(readonly status: number) { super('Invalid local request') } }
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new RequestError(415)
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > BODY_LIMIT) throw new RequestError(413)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RequestError(400) }
}
function equal(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false
  const a = Buffer.from(value), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function requestSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  res.once('close', () => { if (!res.writableEnded) controller.abort() })
  return controller.signal
}
