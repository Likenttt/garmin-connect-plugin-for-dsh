import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { StandaloneGarminWorkspace, WorkspaceIcon, type WorkspaceRpcCaller } from './coach-panel'
import { COACH_PANEL_STYLES } from './coach-panel-styles'
import type { GarminLoginRequest } from './settings-form'

type LoginStatus = 'in_progress' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
interface LoginFlow { flowId: string; bridgeUrl: string; expiresAt: number }
interface ActiveLogin {
  request: GarminLoginRequest
  mode: 'browser' | 'cdp'
  flow?: LoginFlow
  status: LoginStatus
  busy: boolean
  error?: string
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function failureCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'stale_config' || code === 'conflict') return '账号配置已变化，请关闭登录窗口并刷新账号后重试。'
  if (code === 'unauthorized' || code === 'HTTP 401' || code === 'HTTP 403') return '页面授权已过期，请重新从 MCP 打开工作台。'
  if (code === 'busy') return '该账号已有登录流程，请完成或取消后重试。'
  return '暂时无法完成操作，请重试。'
}
function safeBridge(value: unknown, flowId: string): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === `/garmin-auth/bridge/${flowId}`
  } catch { return false }
}
async function parseResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
async function authorizeWorkspace(): Promise<string> {
  const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket')
  // The one-time launch ticket must leave the visible URL before any iframe loads.
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`)
  const response = await fetch('/api/workspace/session', {
    method: ticket ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(ticket ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) } : {}),
  })
  const result = await parseResponse(response)
  if (!record(result) || typeof result.csrf !== 'string' || result.csrf.length < 16) throw new Error('unauthorized')
  return result.csrf
}
function WorkspaceApplication({ csrf }: { csrf: string }): ReactElement {
  const [login, setLogin] = useState<ActiveLogin>()
  const [refresh, setRefresh] = useState(0)
  const [sessionError, setSessionError] = useState('')
  const active = useRef<ActiveLogin>()
  const generation = useRef(0)
  const csrfRef = useRef(csrf)
  const setActive = useCallback((value: ActiveLogin | undefined) => { active.current = value; setLogin(value) }, [])
  const post = useCallback(async (path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'X-Workspace-CSRF': csrfRef.current }, body: JSON.stringify(payload),
    })
    return parseResponse(response)
  }, [csrf])
  const rpc = useRef<WorkspaceRpcCaller>({
    call: (_channel, endpoint, payload, signal) => post(`/api/${endpoint}`, payload, signal),
  }).current
  useEffect(() => {
    let stopped = false
    let checking = false
    const heartbeat = async () => {
      if (document.hidden || stopped || checking) return
      checking = true
      try {
        const response = await fetch('/api/workspace/session', { credentials: 'same-origin', cache: 'no-store' })
        const result = await parseResponse(response)
        if (!record(result) || typeof result.csrf !== 'string' || result.csrf.length < 16) throw new Error('unauthorized')
        if (!stopped) { csrfRef.current = result.csrf; setSessionError('') }
      } catch (error) { if (!stopped) setSessionError(failureCopy(error)) }
      finally { checking = false }
    }
    const onVisibility = () => { if (!document.hidden) void heartbeat() }
    const timer = setInterval(() => void heartbeat(), 30_000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [csrf])
  const auth = useCallback(async (action: string, payload: unknown): Promise<Record<string, unknown>> => {
    let result = await post(`/api/workspace/login${action ? `/${action}` : ''}`, payload)
    if (record(result) && result.ok === true) result = result.value
    if (!record(result) || result.success !== true) throw new Error(record(result) && typeof result.code === 'string' ? result.code : 'unavailable')
    return result
  }, [post])
  const payloadFor = (value: ActiveLogin) => ({ accountId: value.request.accountId, expectedRevision: value.request.expectedRevision, ...(value.flow ? { flowId: value.flow.flowId } : {}) })
  const begin = useCallback(async (request: GarminLoginRequest, mode: 'browser' | 'cdp') => {
    const version = ++generation.current
    const next: ActiveLogin = { request, mode, busy: true, status: 'in_progress' }
    setActive(next)
    try {
      const result = await auth('', { accountId: request.accountId, expectedRevision: request.expectedRevision, mode })
      if (typeof result.flowId !== 'string' || !/^[a-f0-9]{64}$/.test(result.flowId)
        || !safeBridge(result.bridgeUrl, result.flowId) || typeof result.expiresAt !== 'number') throw new Error('unavailable')
      const flow: LoginFlow = { flowId: result.flowId, bridgeUrl: result.bridgeUrl, expiresAt: result.expiresAt }
      if (version !== generation.current) {
        await auth('cancel', { accountId: request.accountId, expectedRevision: request.expectedRevision, flowId: flow.flowId }).catch(() => undefined)
        return
      }
      setActive({ ...next, busy: false, flow })
      request.onSettled?.(true)
    } catch (error) {
      if (version !== generation.current) return
      setActive({ ...next, busy: false, status: 'failed', error: failureCopy(error) })
      request.onSettled?.(false)
    }
  }, [auth, setActive])
  const onLogin = useCallback((request: GarminLoginRequest): boolean => {
    if (active.current) return false
    void begin(request, 'browser')
    return true
  }, [begin])
  async function close() {
    const value = active.current
    if (!value) return
    generation.current += 1
    setActive(undefined)
    setRefresh(value => value + 1)
    if (value.busy && !value.flow) value.request.onSettled?.(false)
    // Closing the local dialog must also work after an account edit or expired
    // page session. A late begin response is cancelled by its generation guard.
    if (value.flow && value.status === 'in_progress') {
      await auth('cancel', payloadFor(value)).catch(() => undefined)
    }
  }
  async function retryCdp() {
    const value = active.current
    if (!value || value.busy) return
    generation.current += 1
    setActive({ ...value, busy: true, error: undefined })
    try {
      if (value.flow && value.status === 'in_progress') await auth('cancel', payloadFor(value))
      await begin(value.request, 'cdp')
    } catch (error) { setActive({ ...value, busy: false, error: failureCopy(error) }) }
  }
  useEffect(() => {
    if (!login?.flow || login.status !== 'in_progress') return
    const version = generation.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (stopped || version !== generation.current) return
      if (!document.hidden) {
        try {
          const result = await auth('status', payloadFor(login))
          if (stopped || version !== generation.current) return
          const status = result.status
          if (status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired') {
            setActive({ ...login, busy: false, status, error: undefined })
            setRefresh(value => value + 1)
            if (status === 'succeeded') {
              void auth('verify', { accountId: login.request.accountId, expectedRevision: login.request.expectedRevision }).then(() => {
                if (version === generation.current) setRefresh(value => value + 1)
              }).catch(() => {
                if (version === generation.current && active.current?.status === 'succeeded') setActive({ ...active.current, error: '登录已保存，暂时无法检查连接。返回工作台后可重试。' })
              })
            }
            return
          }
          if (active.current?.error) setActive({ ...active.current, error: undefined })
        } catch (error) {
          if (!stopped && version === generation.current && active.current) setActive({ ...active.current, error: failureCopy(error) })
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [login?.flow?.flowId, login?.status, auth, setActive])
  const statusText: Record<LoginStatus, string> = {
    in_progress: login?.mode === 'cdp' ? '请在独立的佳明窗口中完成登录与两步验证。' : '请在下方佳明官方页面完成登录与两步验证。',
    succeeded: '登录已完成，返回账号列表后可检查连接。', failed: '本次登录未完成，可以重试或使用独立浏览器。',
    cancelled: '本次登录已取消。', expired: '本次登录已过期，请重新打开登录窗口。',
  }
  return <>{sessionError && <div className="gcp-workspace gcp"><p className="gcp-hint error" role="alert">{sessionError}</p></div>}<StandaloneGarminWorkspace rpc={rpc} onLogin={onLogin} refreshKey={refresh} />{login && <div className="gcp gcp-modal-shade"><section className="gcp-modal gcp-login-dialog" role="dialog" aria-modal="true" aria-label="佳明账号登录"><div className="gcp-heading"><h2>佳明账号登录 · {login.request.region === 'cn' ? '中国区' : '国际区'}</h2><button type="button" className="gcp-btn small" onClick={() => void close()} title="关闭登录" aria-label="关闭登录"><WorkspaceIcon name="close" /></button></div>
    <div role="status" className={`gcp-login-state${login.status === 'succeeded' ? ' success' : ''}`}>{login.busy ? '正在打开佳明登录…' : statusText[login.status]}</div>
    {login.error && <div role="alert" className="gcp-login-state error">{login.error}</div>}
    {login.flow && login.mode === 'browser' && login.status === 'in_progress' && <iframe className="gcp-login-frame" title="佳明官方登录" src={login.flow.bridgeUrl} referrerPolicy="no-referrer" />}
    <div className="gcp-actions">{login.status !== 'succeeded' && <button type="button" className="gcp-btn" disabled={login.busy} onClick={() => void retryCdp()}><WorkspaceIcon name="login" />使用独立浏览器登录</button>}<button type="button" className={`gcp-btn${login.status === 'succeeded' ? ' primary' : ''}`} onClick={() => void close()}>{login.status === 'in_progress' ? '取消登录' : '返回工作台'}</button></div>
  </section></div>}</>
}
function Bootstrap(): ReactElement {
  const [csrf, setCsrf] = useState<string>()
  const [error, setError] = useState('')
  useEffect(() => { void authorizeWorkspace().then(setCsrf).catch(error => setError(failureCopy(error))) }, [])
  return csrf ? <WorkspaceApplication csrf={csrf} /> : <main className="gcp-workspace"><style>{COACH_PANEL_STYLES}</style><section className="gcp"><h1 className="gcp-row"><WorkspaceIcon name="garmin" />Garmin 工作台</h1><p role={error ? 'alert' : 'status'} className={`gcp-hint${error ? ' error' : ''}`}>{error || '正在连接本机工作区…'}</p></section></main>
}
const root = document.getElementById('root')
if (root) createRoot(root).render(<Bootstrap />)
