import { startWorkspaceServer, type WorkspaceServer } from '../src/workspace-server'
import type { WorkspaceService } from '../src/workspace-service'
import { request as httpRequest } from 'node:http'

const TOKEN = 'b'.repeat(48)
const REVISION = 'a'.repeat(32)
const FLOW = 'c'.repeat(64)
const servers: WorkspaceServer[] = []
function service(): WorkspaceService {
  return {
    tools: [],
    call: jest.fn(async (endpoint: string) => endpoint === 'members' ? { success: true, members: [
      { accountId: 'account-a', revision: REVISION, region: 'cn', provider: 'connect-web' },
      { accountId: 'account-b', revision: REVISION, region: 'global', provider: 'connect-web' },
    ] } : { success: true }),
    auth: jest.fn(async (endpoint: string) => endpoint === 'begin' || endpoint === 'begin-cdp'
      ? { success: true, flowId: FLOW, bridgeUrl: `http://127.0.0.1:8811/auth/${FLOW}`, expiresAt: Date.now() + 60_000 }
      : endpoint === 'status' ? { success: true, status: 'in_progress' } : { success: true }),
    invokeTool: jest.fn(async () => ({ success: true })),
    close: jest.fn(async () => undefined),
  }
}
async function setup(extra: Partial<Parameters<typeof startWorkspaceServer>[0]> = {}) {
  const runtime = service()
  const server = await startWorkspaceServer({ service: runtime, accessToken: TOKEN,
    instanceId: 'd'.repeat(48), ...extra })
  servers.push(server)
  return { runtime, server }
}
async function jsonPost(server: WorkspaceServer, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body) })
}
async function session(server: WorkspaceServer) {
  const ticket = new URL(server.openPage().url).hash.slice('#ticket='.length)
  const response = await jsonPost(server, '/api/workspace/session', { ticket }, { Origin: server.origin })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')!.split(';')[0]
  const value = await response.json() as { csrf: string }
  return { cookie, csrf: value.csrf, ticket, setCookie: response.headers.get('set-cookie')! }
}
function browserHeaders(server: WorkspaceServer, auth: { cookie: string; csrf: string }) {
  return { Origin: server.origin, Cookie: auth.cookie, 'X-Workspace-CSRF': auth.csrf }
}
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })

it('consumes one page ticket into a private cookie and never exposes the machine bearer', async () => {
  const { server } = await setup()
  const auth = await session(server)
  expect(auth.setCookie).toContain('HttpOnly; SameSite=Strict; Path=/')
  expect(auth.csrf).toMatch(/^[0-9a-f]{64}$/)
  expect(auth.setCookie).not.toContain(TOKEN)
  expect((await jsonPost(server, '/api/workspace/session', { ticket: auth.ticket }, { Origin: server.origin })).status).toBe(403)
  expect((await fetch(`${server.origin}/api/workspace/session`)).status).toBe(401)
  const response = await fetch(`${server.origin}/api/workspace/session`, { headers: { Cookie: auth.cookie } })
  expect(await response.json()).toEqual({ csrf: auth.csrf })
  expect(response.headers.get('cache-control')).toBe('no-store')
})

it('requires cookie, exact origin, CSRF and physical Host for browser mutations', async () => {
  const { server, runtime } = await setup()
  const auth = await session(server)
  const path = '/api/garmin-coach/save-note'
  const payload = { accountId: 'account-a', title: '本地备注', body: '记录' }
  const rejectedHeaders: Array<Record<string, string>> = [
    { Origin: server.origin, 'X-Workspace-CSRF': auth.csrf },
    { Cookie: auth.cookie, 'X-Workspace-CSRF': auth.csrf },
    { Origin: 'https://example.test', Cookie: auth.cookie, 'X-Workspace-CSRF': auth.csrf },
    { Origin: server.origin, Cookie: auth.cookie, 'X-Workspace-CSRF': 'wrong' },
  ]
  for (const headers of rejectedHeaders) expect((await jsonPost(server, path, payload, headers)).status).toBe(403)
  // Fetch implementations may normalize the forbidden Host header. Use the
  // actual HTTP transport to exercise DNS-rebinding protection explicitly.
  const badHost = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${server.origin}${path}`, { method: 'POST', headers: {
      ...browserHeaders(server, auth), Host: 'example.test', 'Content-Type': 'application/json',
    } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)) })
    request.once('error', reject)
    request.end(JSON.stringify(payload))
  })
  expect(badHost).toBe(403)
  expect(runtime.call).not.toHaveBeenCalled()
  const response = await jsonPost(server, path, payload, browserHeaders(server, auth))
  expect(await response.json()).toEqual({ ok: true, value: { success: true } })
  expect(runtime.call).toHaveBeenCalledWith('save-note', payload, expect.any(AbortSignal))
})

it('keeps the internal API bearer-only and rejects browser-origin requests even with the correct token', async () => {
  const { server, runtime } = await setup()
  expect((await fetch(`${server.origin}/internal/health`)).status).toBe(403)
  expect((await fetch(`${server.origin}/internal/health`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(403)
  expect((await fetch(`${server.origin}/internal/health`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: server.origin } })).status).toBe(403)
  const response = await fetch(`${server.origin}/internal/health`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  expect(await response.json()).toEqual({ success: true, instanceId: 'd'.repeat(48) })
  const toolResponse = await jsonPost(server, '/internal/tool/get_garmin_profile', { accountId: 'account-a' }, { Authorization: `Bearer ${TOKEN}` })
  expect(await toolResponse.json()).toEqual({ success: true })
  expect(runtime.invokeTool).toHaveBeenCalledWith('get_garmin_profile', { accountId: 'account-a' })
})

it('binds every browser login flow to its initiating session, account and current revision', async () => {
  const { server, runtime } = await setup()
  const first = await session(server)
  const other = await session(server)
  const login = { accountId: 'account-a', expectedRevision: REVISION, mode: 'browser' }
  const begin = await jsonPost(server, '/api/workspace/login', login, browserHeaders(server, first))
  expect((await begin.json() as { flowId: string }).flowId).toBe(FLOW)
  expect(runtime.auth).toHaveBeenCalledWith('begin', { accountId: 'account-a', expectedRevision: REVISION,
    expectedRegion: 'cn' }, expect.any(AbortSignal))
  const status = { accountId: 'account-a', expectedRevision: REVISION, flowId: FLOW }
  expect((await jsonPost(server, '/api/workspace/login/status', status, browserHeaders(server, other))).status).toBe(403)
  expect((await jsonPost(server, '/api/workspace/login/status', { ...status, accountId: 'account-b' }, browserHeaders(server, first))).status).toBe(403)
  const stale = await jsonPost(server, '/api/workspace/login/status', { ...status, expectedRevision: 'e'.repeat(32) }, browserHeaders(server, first))
  expect(await stale.json()).toEqual({ success: false, code: 'stale_config' })
  const success = await jsonPost(server, '/api/workspace/login/status', status, browserHeaders(server, first))
  expect(await success.json()).toEqual({ success: true, status: 'in_progress' })
  expect(runtime.auth).toHaveBeenLastCalledWith('status', { flowId: FLOW }, expect.any(AbortSignal))
  expect((await jsonPost(server, '/api/workspace/login/cancel', status, browserHeaders(server, first))).status).toBe(200)
  expect((await jsonPost(server, '/api/workspace/login/status', status, browserHeaders(server, first))).status).toBe(403)
})

it('checks content type and bounds JSON before invoking a business operation', async () => {
  const { server, runtime } = await setup()
  const auth = await session(server)
  const headers = browserHeaders(server, auth)
  expect((await fetch(`${server.origin}/api/garmin-coach/save-note`, { method: 'POST', headers,
    body: JSON.stringify({ title: '备注' }) })).status).toBe(415)
  expect((await jsonPost(server, '/api/garmin-coach/save-note', { body: 'x'.repeat(97 * 1024) }, headers)).status).toBe(413)
  expect(runtime.call).not.toHaveBeenCalled()
})

it('exits idle mode after active work finishes and close is idempotent', async () => {
  let finish!: () => void
  const completed = new Promise<void>(resolve => { finish = resolve })
  let server!: WorkspaceServer
  let notifications = 0
  const result = await setup({ idleMs: 25, onIdle: () => {
    notifications += 1
    void server.close().then(finish)
  } })
  server = result.server
  const timeout = setTimeout(() => finish(), 2000)
  await completed
  clearTimeout(timeout)
  expect(notifications).toBe(1)
  await server.close()
  await expect(fetch(`${server.origin}/`)).rejects.toThrow()
})
