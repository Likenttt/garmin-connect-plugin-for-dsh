import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { COACH_PANEL_STYLES } from './coach-panel-styles'
import { runConnectionChecks } from './check-connections'
import type { GarminLoginRequest } from './settings-form'

type View = 'members' | 'timeline' | 'notes' | 'mine'
type ConnectionStatus = 'unknown' | 'checking' | 'valid' | 'auth_required' | 'unavailable'
interface Member {
  accountId: string
  alias: string
  region: 'cn' | 'global'
  provider: 'connect-web' | 'personal'
  configured: boolean
  status: ConnectionStatus
  lastCheckedAt?: string
  lastVerifiedAt?: string
  revision?: string
  maskedEmail?: string
  avatarUrl?: string
}
interface MembersResult { members: Member[]; managed?: boolean }
export interface GarminCoachPanelOptions {
  onLogin?(request: GarminLoginRequest): boolean
}
interface CoachNote {
  id: string
  accountId: string
  title: string
  body: string
  category: string
  createdAt: string
  updatedAt: string
  revision: number
}
interface Activity { id: string | number; name: string; type: string; date: string; durationSeconds: number; distanceMeters: number }
interface Plan { id: string | number; name: string; date: string }
interface Timeline {
  success: true
  accountId: string
  activities: Activity[]
  plans: Plan[]
  notes: CoachNote[]
  updatedAt: string
  partial: boolean
  avatarUrl?: string
  activityError?: 'auth_required' | 'unavailable'
  planError?: 'auth_required' | 'unavailable'
}
export interface WorkspaceRpcCaller {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}
interface TabInfo {
  tab: {
    id: string
    visible: boolean
    signal: AbortSignal
    navigation: { params?: Record<string, unknown>; revision: number }
    actions: { openTab(kind: string, options?: { params?: Record<string, unknown> }): void }
  }
}
export interface CoachPanelClientContext {
  connection: { rpc: WorkspaceRpcCaller; isLoopback: boolean }
  sidebarRightTabs: {
    register(definition: { id: string; kind: string; title(): string; keepMounted?: boolean; guide?: Array<{ id: string; order: number; title(): string; description?(): string }> }): () => void
  }
  sidebarRight: { openTab(kind: string, options?: { params?: Record<string, unknown> }): void }
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register(options: { name: string; key?: string; id?: string; order?: number; registrant?: string; inject?: (sessionId: string) => Record<string, unknown> }, component: (props: any) => ReactElement): () => void
  }
  effect(callback: () => (() => void), label?: string): unknown
}

interface Draft { id?: string; title: string; body: string; category: string; expectedRevision?: number; accountRevision?: string; baseline: string }
interface SessionState {
  selectedAccountId?: string
  days: 7 | 28
  search: string
  statusFilter: string
  drafts: Map<string, Draft>
  handledNavigations: Map<string, number>
  listeners: Set<() => void>
  revision: number
  dataRevision: number
  memberRevision: number
  memberPage: number
}
type StateRegistry = Map<string, SessionState>
const VIEWS: Array<{ view: View; title: string }> = [
  { view: 'members', title: '账号' }, { view: 'timeline', title: '时间线' },
  { view: 'notes', title: '备注' }, { view: 'mine', title: '我的训练' },
]
const kind = (view: View) => `garmin-coach-${view}`
const statusCopy: Record<ConnectionStatus, string> = {
  unknown: '未检查', checking: '检查中', valid: '最近验证可用',
  auth_required: '需要重新登录', unavailable: '暂无法检查',
}
const preferredChannel = new WeakMap<WorkspaceRpcCaller, '/api' | '/garmin-coach'>()

class CoachRpcError extends Error {
  constructor(readonly code: string) { super(code) }
}
function errorCopy(error: unknown): string {
  if (error instanceof Error && /^HTTP (401|403)$/.test(error.message)) return '页面授权已失效，请重新打开工作台。未保存的输入仍保留。'
  if (error instanceof CoachRpcError) {
    if (error.code === 'conflict') return '这份记录已被更新，请刷新后重新编辑。当前输入已保留。'
    if (error.code === 'storage_unavailable') return '本机工作区存储暂不可用，请稍后重试。'
    if (error.code === 'account_not_found') return '该账号已移除，请重新选择账号。'
    if (error.code === 'invalid') return '内容不完整或超过限制，请检查后重试。'
    if (error.code === 'stale_config') return '账号配置已变化，请刷新后重试。未保存的内容仍保留。'
  }
  return '暂时无法读取工作台，请重试。'
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
async function coachRpc<T>(rpc: WorkspaceRpcCaller, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const channel = preferredChannel.get(rpc) ?? '/api'
  const invoke = (selected: '/api' | '/garmin-coach') => rpc.call(
    selected, selected === '/api' ? `garmin-coach/${endpoint}` : endpoint, payload, signal,
  )
  let reply: unknown
  try { reply = await invoke(channel); preferredChannel.set(rpc, channel) }
  catch (error) {
    const method = channel === '/api' ? `garmin-coach/${endpoint}` : endpoint
    if (signal?.aborted || !(error instanceof Error)
      || error.message !== `transport failure for ${channel}/${method}: HTTP 404`) throw error
    const fallback = channel === '/api' ? '/garmin-coach' : '/api'
    reply = await invoke(fallback)
    preferredChannel.set(rpc, fallback)
  }
  if (!record(reply) || reply.ok !== true || !record(reply.value)) throw new CoachRpcError('unavailable')
  if (reply.value.success !== true) throw new CoachRpcError(typeof reply.value.code === 'string' ? reply.value.code : 'unavailable')
  return reply.value as T
}
/** Detect an authoritative catalog before allowing the old fixed-slot editor. */
export async function readCoachManagedState(rpc: WorkspaceRpcCaller, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await coachRpc<MembersResult>(rpc, 'members', {}, signal)
    return result.managed === true
  } catch (error) {
    if (error instanceof Error && /^transport failure for (\/api\/garmin-coach\/members|\/garmin-coach\/members): HTTP 404$/.test(error.message)) return false
    throw error
  }
}
function getSession(registry: StateRegistry, sessionId: string): SessionState {
  let state = registry.get(sessionId)
  if (!state) {
    state = { days: 7, search: '', statusFilter: 'all', drafts: new Map(), handledNavigations: new Map(), listeners: new Set(), revision: 0, dataRevision: 0, memberRevision: 0, memberPage: 1 }
    registry.set(sessionId, state)
  }
  return state
}
function notify(state: SessionState) { state.revision += 1; for (const listener of state.listeners) listener() }
function useSession(state: SessionState) {
  useSyncExternalStore(useCallback(listener => { state.listeners.add(listener); return () => { state.listeners.delete(listener) } }, [state]), () => state.revision)
  return state
}
function useData<T>(load: (signal: AbortSignal) => Promise<T>, key: string, visible: boolean) {
  const latest = useRef(load)
  latest.current = load
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: false })
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    setResult(previous => ({ key, data: previous.key === key ? previous.data : undefined, loading: true }))
    void latest.current(controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ key, data, loading: false })
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key, error: errorCopy(error), loading: false })
    })
    return () => controller.abort()
  }, [key, visible, refresh])
  return { ...(result.key === key ? result : { key, loading: visible }), reload: () => setRefresh(value => value + 1) }
}
function displayTime(value?: string) {
  if (!value) return '尚未验证'
  const date = new Date(value)
  return Number.isFinite(date.valueOf()) ? date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未验证'
}
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function offsetDay(date: string, offset: number) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}
function safeFilename(value: string) { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 70) || '账号' }
function exportNotes(member: Member, notes: CoachNote[], format: 'md' | 'json') {
  const exportedAt = new Date().toISOString()
  const body = format === 'json' ? JSON.stringify({ schemaVersion: 1, exportedAt, member: { accountId: member.accountId, alias: member.alias }, notes }, null, 2)
    : `# ${member.alias} · 备注\n\n导出时间：${exportedAt}\n\n${notes.map(note => `## ${note.title}\n\n- 分类：${note.category}\n- 创建：${note.createdAt}\n- 更新：${note.updatedAt}\n\n${note.body}\n`).join('\n---\n\n')}`
  const url = URL.createObjectURL(new Blob([body], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeFilename(member.alias)}-备注-${dayKey()}.${format}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export type WorkspaceIconName = 'garmin' | 'accounts' | 'timeline' | 'note' | 'chart' | 'connection' | 'login' | 'refresh' | 'plus' | 'edit' | 'remove' | 'download' | 'close'
const ICON_PATHS: Record<WorkspaceIconName, string> = {
  garmin: 'M12 3 22 21H2Z',
  accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  timeline: 'M5 3v18 M5 6h14 M5 12h10 M5 18h14',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
  chart: 'M3 3v18h18 M7 14l4-5 4 3 5-7',
  connection: 'M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  login: 'M10 17l5-5-5-5 M15 12H3 M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 11.5-1L20 9 M4 15l2.5 3A7 7 0 0 0 18 17',
  plus: 'M12 5v14 M5 12h14',
  edit: 'M16 3l5 5 M4 20l4-1L21 6a2.1 2.1 0 0 0-3-3L5 16z',
  remove: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 16v5h14v-5',
  close: 'M6 6l12 12 M18 6L6 18',
}
export function WorkspaceIcon({ name }: { name: WorkspaceIconName }): ReactElement {
  const brand = name === 'garmin'
  return <svg className={`gcp-icon${brand ? ' gcp-brand-icon' : ''}`} viewBox="0 0 24 24" fill={brand ? 'currentColor' : 'none'} stroke={brand ? 'none' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>
}

/** The same account, timeline and notebook views, without Harness services. */
export function StandaloneGarminWorkspace({ rpc, onLogin, refreshKey = 0 }: { rpc: WorkspaceRpcCaller; onLogin?: GarminCoachPanelOptions['onLogin']; refreshKey?: number }): ReactElement {
  const sessions = useRef<StateRegistry>(new Map())
  const [view, setView] = useState<View>('members')
  const [navigation, setNavigation] = useState<{ params?: Record<string, unknown>; revision: number }>({ revision: 0 })
  const [visible, setVisible] = useState(!document.hidden)
  const controller = useRef(new AbortController())
  const openTab = useCallback((tabKind: string, options?: { params?: Record<string, unknown> }) => {
    const next = VIEWS.find(entry => kind(entry.view) === tabKind)?.view
    if (!next) return
    setView(next)
    setNavigation(previous => ({ params: options?.params, revision: previous.revision + 1 }))
  }, [])
  const ctx = useMemo<CoachPanelClientContext>(() => ({
    connection: { rpc, isLoopback: true },
    sidebarRight: { openTab },
    sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: () => () => undefined, register: () => () => undefined },
    effect: () => undefined,
  }), [rpc, openTab])
  useEffect(() => {
    const visibility = () => setVisible(!document.hidden)
    const protect = (event: BeforeUnloadEvent) => {
      if (![...sessions.current.values()].some(state => [...state.drafts.values()].some(isDirty))) return
      event.preventDefault(); event.returnValue = ''
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('beforeunload', protect)
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('beforeunload', protect); controller.current.abort() }
  }, [])
  useEffect(() => { const state = getSession(sessions.current, 'standalone'); state.memberRevision += 1; state.dataRevision += 1; notify(state) }, [refreshKey])
  const icons: Record<View, WorkspaceIconName> = { members: 'accounts', timeline: 'timeline', notes: 'note', mine: 'chart' }
  return <main className="gcp-workspace"><style>{COACH_PANEL_STYLES}</style>
    <header className="gcp-workspace-header"><div className="gcp-workspace-brand"><WorkspaceIcon name="garmin" /><span>Garmin 工作台<small>本机工作区 · 账号、时间线与备注</small></span></div><span className="gcp-local-badge">本机连接</span></header>
    <nav className="gcp-workspace-nav" aria-label="Garmin 工作台标签">{VIEWS.map(entry => <button key={entry.view} type="button" aria-current={entry.view === view ? 'page' : undefined} onClick={() => openTab(kind(entry.view))}><WorkspaceIcon name={icons[entry.view]} />{entry.title}</button>)}</nav>
    <div className="gcp-workspace-content"><CoachPanel key={view} ctx={ctx} options={{ onLogin }} view={view} state={getSession(sessions.current, 'standalone')} useTabInfo={() => ({ tab: { id: view, visible, signal: controller.current.signal, navigation, actions: { openTab } } })} /></div>
    <footer className="gcp-workspace-footer">共用本机账号与备注 · 仅在查看时读取所选账号</footer>
  </main>
}

/** Register only inside a child with the native sidebar services available. */
export function registerGarminCoachPanel(ctx: CoachPanelClientContext, options: GarminCoachPanelOptions = {}): () => boolean {
  const sessions: StateRegistry = new Map()
  const openWorkspace = () => {
    if (!ctx.connection.isLoopback) return false
    try {
      for (const entry of VIEWS) ctx.sidebarRight.openTab(kind(entry.view))
      ctx.sidebarRight.openTab(kind('members'))
      return true
    } catch { return false }
  }
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const protectDrafts = (event: BeforeUnloadEvent) => {
      if (![...sessions.values()].some(state => [...state.drafts.values()].some(isDirty))) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protectDrafts)
    disposers.push(() => window.removeEventListener('beforeunload', protectDrafts))
    for (const entry of VIEWS) {
      const id = `dsh-plugin-garmin-connect/coach-${entry.view}`
      disposers.push(ctx.sidebarRightTabs.register({
        id, kind: kind(entry.view), title: () => entry.title, keepMounted: false,
        guide: entry.view === 'members' ? [{ id: 'members', order: 85, title: () => 'Garmin 工作台', description: () => '账号、训练时间线与备注' }] : undefined,
      }))
      disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: id, inject: sessionId => ({ sessionId }),
      }, props => <CoachPanel ctx={ctx} options={options} view={entry.view} state={getSession(sessions, props.sessionId)} useTabInfo={props.useTabInfo} />)))
    }
    disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'garmin-coach-launcher', order: 80, registrant: 'dsh-plugin-garmin-connect',
    }, () => <Launcher ctx={ctx} openWorkspace={openWorkspace} />)))
    return () => { for (const dispose of disposers.reverse()) dispose(); sessions.clear() }
  }, 'garmin-connect: native coach panel')
  return openWorkspace
}
function Launcher({ ctx, openWorkspace }: { ctx: CoachPanelClientContext; openWorkspace(): boolean }): ReactElement {
  const [error, setError] = useState('')
  return <><style>{COACH_PANEL_STYLES}</style><button type="button" className="gcp-launcher" onClick={() => {
    setError('')
    try {
      if (!ctx.connection.isLoopback) { setError('请在本机 Harness 中打开工作台。'); return }
      if (!openWorkspace()) setError('请先打开一个对话，再打开 Garmin 工作台。')
    } catch { setError('请先打开一个对话，再打开 Garmin 工作台。') }
  }}><WorkspaceIcon name="garmin" /> Garmin 工作台</button>{error && <div role="status" className="gcp-launcher-error">{error}<button type="button" onClick={() => setError('')} style={{ marginLeft: 8 }}>关闭</button></div>}</>
}

function CoachPanel({ ctx, options, view, state: rawState, useTabInfo }: {
  ctx: CoachPanelClientContext; options: GarminCoachPanelOptions; view: View; state: SessionState; useTabInfo(): TabInfo
}): ReactElement {
  const info = useTabInfo()
  const state = useSession(rawState)
  const [timelineAvatar, setTimelineAvatar] = useState<{ accountId: string; revision?: string; url: string }>()
  const visible = info.tab.visible && ctx.connection.isLoopback
  const members = useData<MembersResult>(signal => coachRpc(ctx.connection.rpc, 'members', {}, signal), `members:${state.memberRevision}`, visible)
  useEffect(() => {
    if (!members.data?.members.length) return
    const requested = info.tab.navigation.params?.accountId
    const navigationKey = `${view}:${info.tab.id}`
    const newNavigation = info.tab.navigation.revision > 0
      && state.handledNavigations.get(navigationKey) !== info.tab.navigation.revision
    if (newNavigation && typeof requested === 'string' && members.data.members.some(member => member.accountId === requested)) {
      state.handledNavigations.set(navigationKey, info.tab.navigation.revision)
      if (state.selectedAccountId !== requested) { state.selectedAccountId = requested; notify(state) }
    } else if (!members.data.members.some(member => member.accountId === state.selectedAccountId)) {
      state.selectedAccountId = members.data.members[0].accountId
      notify(state)
    }
  }, [members.data, info.tab.id, info.tab.navigation.revision, state, view])
  const selectMember = (accountId: string, nextView: View = view) => {
    state.selectedAccountId = accountId
    notify(state)
    info.tab.actions.openTab(kind(nextView), { params: { accountId } })
  }
  const all = members.data?.members ?? []
  const selected = all.find(value => value.accountId === state.selectedAccountId)
  const member = selected && timelineAvatar?.accountId === selected.accountId && timelineAvatar.revision === selected.revision
    ? { ...selected, avatarUrl: timelineAvatar.url } : selected
  return <section className="gcp" aria-label={`Garmin ${VIEWS.find(value => value.view === view)?.title}`}>
    <style>{COACH_PANEL_STYLES}</style>
    {!ctx.connection.isLoopback ? <Hint>工作台仅支持本机连接。</Hint> : <>
      {members.error && <Hint error>{members.error} <button type="button" className="gcp-link" onClick={members.reload}>重试</button></Hint>}
      {members.loading && !members.data && <Hint>正在读取账号…</Hint>}
      {view === 'members' ? <Members ctx={ctx} options={options} managed={members.data?.managed === true} members={all} visible={visible} state={state} reload={members.reload} onSelect={id => selectMember(id, 'timeline')} />
        : view === 'mine' ? <MyTraining ctx={ctx} members={all} state={state} visible={visible} />
          : member ? <>
            <MemberHeader member={member} members={all} onSelect={selectMember} />
            {view === 'timeline' ? <TimelineView key={member.accountId} ctx={ctx} member={member} state={state} visible={visible} onAvatar={url => setTimelineAvatar({ accountId: member.accountId, revision: member.revision, url })} onNote={() => info.tab.actions.openTab(kind('notes'), { params: { accountId: member.accountId } })} />
              : <NotesView key={member.accountId} ctx={ctx} member={member} state={state} visible={visible} />}
          </> : !members.loading && <Empty>尚无账号。请在“账号”标签中添加。</Empty>}
    </>}
  </section>
}
function Hint({ children, error = false }: { children: React.ReactNode; error?: boolean }) { return <div className={`gcp-hint${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div> }
function Empty({ children }: { children: React.ReactNode }) { return <p className="gcp-empty">{children}</p> }
function Status({ member }: { member: Member }) {
  return <><span className={`gcp-status ${member.status}`}>{!member.configured ? '未关联' : statusCopy[member.status] ?? '未检查'}</span>
    <span className="gcp-time">{member.lastVerifiedAt ? `上次可用 ${displayTime(member.lastVerifiedAt)}` : member.lastCheckedAt ? `检查于 ${displayTime(member.lastCheckedAt)}` : '尚未验证'}</span></>
}
function MemberAvatar({ member }: { member: Member }) {
  const [failedUrl, setFailedUrl] = useState<string>()
  const url = member.avatarUrl
  return <span className="gcp-avatar" aria-hidden="true">{url && failedUrl !== url
    ? <img src={url} alt="" width={34} height={34} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
    : Array.from(member.alias.trim())[0] ?? 'G'}</span>
}
function MemberHeader({ member, members, onSelect }: { member: Member; members: Member[]; onSelect(id: string): void }) {
  return <header className="gcp-person"><div className="gcp-row"><MemberAvatar member={member} />
    <MemberPicker members={members} value={member.accountId} label="当前账号" onChange={onSelect} />
  </div><p>{member.region === 'cn' ? '中国区' : '国际区'} · {member.provider === 'personal' ? 'Personal API' : '佳明会话'} · <span>{statusCopy[member.status]}</span></p></header>
}
function MemberPicker({ members, value, label, onChange, emptyLabel, disabled }: {
  members: Member[]; value: string; label: string; onChange(value: string): void; emptyLabel?: string; disabled?: boolean
}) {
  const [search, setSearch] = useState('')
  const matches = members.filter(member => !search || member.alias.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const selected = members.find(member => member.accountId === value)
  const candidates = matches.slice(0, 50)
  if (selected && !candidates.some(member => member.accountId === selected.accountId)) candidates.unshift(selected)
  return <div className="gcp-member-picker">{members.length > 20 && <input className="gcp-input" type="search" aria-label={`搜索${label}`} placeholder="输入备注筛选账号" value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} />}
    <select className="gcp-select" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{emptyLabel && <option value="">{emptyLabel}</option>}{candidates.map(member => <option key={member.accountId} value={member.accountId}>{member.alias}</option>)}</select>
    {matches.length > 50 && <small>匹配 {matches.length} 个账号，输入备注缩小范围。</small>}
  </div>
}
function Members({ ctx, options, managed, members, visible, state, reload, onSelect }: {
  ctx: CoachPanelClientContext; options: GarminCoachPanelOptions; managed: boolean; members: Member[]; visible: boolean
  state: SessionState; reload(): void; onSelect(id: string): void
}) {
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const singleCheck = useRef<AbortController>()
  const bulkCheck = useRef<AbortController>()
  const alive = useRef(true)
  const [checkedMembers, setCheckedMembers] = useState<Map<string, Member>>(new Map())
  useEffect(() => { setCheckedMembers(new Map()) }, [members])
  const [bulk, setBulk] = useState<{ total: number; completed: number; valid: number; authRequired: number; unavailable: number; skipped: number; running: boolean; cancelled: boolean }>()
  useEffect(() => { alive.current = true; return () => { alive.current = false; singleCheck.current?.abort(); bulkCheck.current?.abort() } }, [])
  useEffect(() => {
    if (visible) return
    singleCheck.current?.abort(); bulkCheck.current?.abort()
  }, [visible])
  const displayMembers = members.map(member => {
    const checked = checkedMembers.get(member.accountId)
    return checked && checked.revision === member.revision ? checked : member
  })
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState<Member | 'new'>()
  const [removing, setRemoving] = useState<Member>()
  const [removingBusy, setRemovingBusy] = useState(false)
  const [loginBusy, setLoginBusy] = useState<string>()
  const filtered = displayMembers.filter(member => (!state.search || `${member.alias} ${member.maskedEmail ?? ''}`.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()))
    && (state.statusFilter === 'all' || member.status === state.statusFilter))
  const pageSize = 20
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(state.memberPage, totalPages)
  const visibleMembers = filtered.slice((page - 1) * pageSize, page * pageSize)
  function rememberCheck(member: Member) {
    setCheckedMembers(previous => new Map(previous).set(member.accountId, member))
  }
  async function check(member: Member) {
    if (singleCheck.current || bulkCheck.current) return
    const controller = new AbortController()
    singleCheck.current = controller
    setChecking(new Set([member.accountId])); setError('')
    try {
      const result = await coachRpc<{ member: Member }>(ctx.connection.rpc, 'check', { accountId: member.accountId }, controller.signal)
      if (!controller.signal.aborted && alive.current) { rememberCheck(result.member); reload() }
    } catch (failure) { if (!controller.signal.aborted && alive.current) setError(errorCopy(failure)) }
    finally {
      if (singleCheck.current === controller) singleCheck.current = undefined
      if (alive.current) setChecking(new Set())
    }
  }
  async function checkAll() {
    if (singleCheck.current || bulkCheck.current) return
    const targets = members.filter(member => member.configured)
    const skipped = members.length - targets.length
    const controller = new AbortController()
    bulkCheck.current = controller
    setError(''); setMessage(''); setChecking(new Set())
    setBulk({ total: targets.length, completed: 0, valid: 0, authRequired: 0, unavailable: 0, skipped, running: true, cancelled: false })
    await runConnectionChecks({
      items: targets, signal: controller.signal,
      check: (member, signal) => coachRpc<{ member: Member }>(ctx.connection.rpc, 'check', { accountId: member.accountId }, signal),
      onStart(member) { if (alive.current) setChecking(previous => new Set(previous).add(member.accountId)) },
      onResult(outcome, completed) {
        if (!alive.current) return
        setChecking(previous => { const next = new Set(previous); next.delete(outcome.item.accountId); return next })
        const checked = outcome.result?.member
        if (checked) rememberCheck(checked)
        setBulk(previous => previous ? { ...previous, completed,
          valid: previous.valid + Number(checked?.status === 'valid'),
          authRequired: previous.authRequired + Number(checked?.status === 'auth_required'),
          unavailable: previous.unavailable + Number(checked?.status !== 'valid' && checked?.status !== 'auth_required'),
        } : previous)
      },
    }).then(summary => {
      if (!alive.current) return
      setBulk(previous => previous ? { ...previous, completed: summary.completed, running: false, cancelled: summary.cancelled } : previous)
      setChecking(new Set())
      if (visible) reload()
    }).finally(() => { if (bulkCheck.current === controller) bulkCheck.current = undefined })
  }
  function cancelChecks() {
    bulkCheck.current?.abort()
    if (alive.current) { setChecking(new Set()); setBulk(previous => previous ? { ...previous, running: false, cancelled: true } : previous) }
  }
  function login(member: Pick<Member, 'accountId' | 'region' | 'revision' | 'provider'>) {
    if (!options.onLogin || member.provider !== 'connect-web' || loginBusy) return
    setError(''); setMessage(''); setLoginBusy(member.accountId)
    const accepted = options.onLogin({
      accountId: member.accountId, region: member.region,
      ...(member.revision ? { expectedRegion: member.region, expectedRevision: member.revision } : {}),
      onSettled: ready => {
        setLoginBusy(undefined)
        if (ready) setMessage('请在佳明窗口完成登录和两步验证，完成后可检查连接。')
        else setError('登录窗口暂时无法打开，请重试。')
        reload()
      },
    })
    if (!accepted) { setLoginBusy(undefined); setError('登录入口暂不可用，请稍后重试。') }
  }
  async function remove(member: Member) {
    if (!member.revision || removingBusy) return
    setRemovingBusy(true); setError('')
    try {
      await coachRpc(ctx.connection.rpc, 'remove-account', { accountId: member.accountId, expectedRevision: member.revision })
      if (state.selectedAccountId === member.accountId) state.selectedAccountId = undefined
      state.memberRevision += 1; state.memberPage = 1; notify(state)
      setRemoving(undefined); setMessage('已移除连接，本地备注与会话文件保留。')
    } catch (failure) { setError(errorCopy(failure)) }
    finally { setRemovingBusy(false) }
  }
  return <><div className="gcp-eyebrow">GARMIN CONNECT</div><div className="gcp-heading"><h1>账号</h1><div className="gcp-row"><button type="button" className="gcp-btn small" disabled={Boolean(bulk?.running) || checking.size > 0 || !members.length} onClick={() => void checkAll()} title="检查所有已配置账号，不受当前筛选影响"><WorkspaceIcon name="connection" />检查全部连接</button><button type="button" className="gcp-btn small" onClick={reload} title="刷新账号状态"><WorkspaceIcon name="refresh" />刷新</button>{managed && <button type="button" className="gcp-btn primary small" onClick={() => { setError(''); setEditing('new') }}><WorkspaceIcon name="plus" />添加账号</button>}</div></div>
    <p className="gcp-subtitle">管理账号连接，用时间线与备注保存长期记录。</p>
    {managed && <small>账号保存在本机工作区，不设固定数量上限。</small>}
    <div className="gcp-statgrid"><div className="gcp-stat"><strong>{members.length}</strong><small>全部账号</small></div><div className="gcp-stat"><strong>{displayMembers.filter(member => member.status === 'valid').length}</strong><small>最近验证可用</small></div><div className="gcp-stat"><strong>{displayMembers.filter(member => !member.configured || member.status === 'auth_required' || member.status === 'unavailable').length}</strong><small>连接待处理</small></div></div>
    <input className="gcp-input gcp-search" type="search" aria-label="搜索账号" placeholder="搜索账号备注或脱敏邮箱" value={state.search} onChange={event => { state.search = event.target.value; state.memberPage = 1; notify(state) }} />
    <select className="gcp-select" aria-label="连接状态筛选" value={state.statusFilter} onChange={event => { state.statusFilter = event.target.value; state.memberPage = 1; notify(state) }}><option value="all">全部状态</option>{Object.entries(statusCopy).map(([status, copy]) => <option key={status} value={status}>{copy}</option>)}</select>
    {error && <Hint error>{error}</Hint>}
    {message && <Hint>{message}</Hint>}
    {bulk && <div className="gcp-bulk-status" role="status" aria-live="polite" aria-atomic="true"><div className="gcp-row"><strong>{bulk.running ? '正在检查全部连接' : bulk.cancelled ? '已停止检查' : '检查完成'} · {bulk.completed} / {bulk.total}</strong>{bulk.running && <button type="button" className="gcp-link" onClick={cancelChecks}><WorkspaceIcon name="close" />取消检查</button>}</div><small>可用 {bulk.valid} · 需登录 {bulk.authRequired} · 暂不可用 {bulk.unavailable}{bulk.skipped ? ` · 跳过 ${bulk.skipped} 个未配置账号` : ''}{bulk.cancelled && bulk.total > bulk.completed ? ` · 未完成 ${bulk.total - bulk.completed}` : ''}</small></div>}
    <div className="gcp-list">{visibleMembers.map(member => <article key={member.accountId} className="gcp-member"><div className="gcp-member-content"><button type="button" className="gcp-member-main" onClick={() => onSelect(member.accountId)} aria-label={`查看 ${member.alias} 的时间线`}><MemberAvatar member={member} /><span><span className="gcp-name">{member.alias}</span><br /><small>{member.region === 'cn' ? '中国区' : '国际区'} · {member.provider === 'personal' ? 'API Key' : 'Session'}</small>{member.maskedEmail && <small className="gcp-email-hint">{member.maskedEmail}</small>}</span></button>{managed && <div className="gcp-member-tools"><button type="button" className="gcp-link" aria-label={`编辑 ${member.alias} 的账号`} onClick={() => { setError(''); setEditing(member) }} title={`编辑 ${member.alias} 的账号`}><WorkspaceIcon name="edit" /></button><button type="button" className="gcp-link" aria-label={`移除 ${member.alias} 的连接`} onClick={() => { setError(''); setRemoving(member) }} title={`移除 ${member.alias} 的连接`}><WorkspaceIcon name="remove" /></button></div>}</div>
      <div className="gcp-member-side">{checking.has(member.accountId) ? <span className="gcp-status">检查中…</span> : <Status member={member} />}<button type="button" className="gcp-link" disabled={Boolean(bulk?.running) || checking.size > 0 || !member.configured} onClick={() => void check(member)} title={`检查 ${member.alias} 的连接`} aria-label={`检查 ${member.alias} 的连接`}><WorkspaceIcon name="connection" />检查连接</button>{member.provider === 'connect-web' && options.onLogin && <button type="button" className="gcp-link gcp-login" disabled={Boolean(loginBusy) || Boolean(bulk?.running)} onClick={() => login(member)} title={`登录 ${member.alias} 的佳明账号`}><WorkspaceIcon name="login" />{loginBusy === member.accountId ? '正在打开…' : member.status === 'auth_required' || member.status === 'unknown' ? '登录' : '重新登录'}</button>}</div></article>)}</div>
    {!filtered.length && <Empty>{members.length ? '没有匹配的账号。' : managed ? '尚无账号，点击“添加账号”建立第一个账号。' : '请在插件设置中添加佳明账号。'}</Empty>}
    {filtered.length > pageSize && <nav className="gcp-pagination" aria-label="账号分页"><button type="button" className="gcp-btn small" disabled={page <= 1} onClick={() => { state.memberPage = page - 1; notify(state) }}>上一页</button><span>第 {page} / {totalPages} 页 · {filtered.length} 个账号</span><button type="button" className="gcp-btn small" disabled={page >= totalPages} onClick={() => { state.memberPage = page + 1; notify(state) }}>下一页</button></nav>}
    <Hint>打开列表不会同时登录全部账号。状态记录最近检查结果；网络异常不等于授权失效。</Hint>
    {editing && <AccountEditor key={editing === 'new' ? 'new' : `${editing.accountId}:${editing.revision}`} ctx={ctx} member={editing === 'new' ? undefined : editing} canLogin={Boolean(options.onLogin)} onClose={() => setEditing(undefined)} onSaved={(saved, loginAfter, region, provider) => {
      const added = editing === 'new'
      setEditing(undefined); setError(''); setMessage('账号已保存。')
      state.memberRevision += 1
      if (added) { state.search = ''; state.statusFilter = 'all'; state.memberPage = 1 }
      notify(state)
      if (loginAfter) login({ ...saved, region, provider })
    }} />}
    {removing && <Modal title={`移除 ${removing.alias} 的连接？`} onClose={() => { if (!removingBusy) setRemoving(undefined) }}><p>将此账号从账号列表移除，保留本地备注与会话文件。不会删除佳明账号或训练数据。</p>{error && <Hint error>{error}</Hint>}<div className="gcp-actions"><button type="button" className="gcp-btn" disabled={removingBusy} onClick={() => setRemoving(undefined)}>取消</button><button type="button" className="gcp-btn danger" disabled={removingBusy || !removing.revision} onClick={() => void remove(removing)}>移除连接</button></div></Modal>}
  </>
}

function AccountEditor({ ctx, member, canLogin, onClose, onSaved }: {
  ctx: CoachPanelClientContext; member?: Member; canLogin: boolean; onClose(): void
  onSaved(saved: { accountId: string; revision: string }, login: boolean, region: Member['region'], provider: Member['provider']): void
}) {
  const [alias, setAlias] = useState(member?.alias ?? '')
  const [region, setRegion] = useState<Member['region']>(member?.region ?? 'cn')
  const [provider, setProvider] = useState<Member['provider']>(member?.provider ?? 'connect-web')
  const [username, setUsername] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discarding, setDiscarding] = useState(false)
  const dirty = alias !== (member?.alias ?? '') || region !== (member?.region ?? 'cn')
    || provider !== (member?.provider ?? 'connect-web') || Boolean(username || key)
  const requestClose = () => { if (busy) return; if (dirty) setDiscarding(true); else onClose() }
  useEffect(() => {
    if (!dirty) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])
  async function save(loginAfter: boolean) {
    if (busy) return
    if (!alias.trim()) { setError('请填写账号备注，方便区分。'); return }
    if (provider === 'connect-web' && (!member || member.provider !== 'connect-web') && !username.trim()) {
      setError('请填写佳明账号邮箱。'); return
    }
    if (username.includes('****@')) { setError('请填写完整的佳明邮箱，不能保存脱敏提示。'); return }
    if (provider === 'personal' && (!member || member.provider !== 'personal' || region !== member.region) && !key.trim()) {
      setError('新增 Personal 账号或切换地区时，请输入对应区域的 API Key。'); return
    }
    setBusy(true); setError('')
    try {
      const saved = await coachRpc<{ accountId: string; revision: string }>(ctx.connection.rpc, 'save-account', {
        ...(member ? { accountId: member.accountId, expectedRevision: member.revision } : {}),
        alias: alias.trim(), region, provider,
        ...(provider === 'connect-web' && username.trim() ? { username: username.trim() } : {}),
        ...(provider === 'personal' && key.trim() ? { personalApiKey: key.trim() } : {}),
      })
      setUsername(''); setKey('')
      onSaved(saved, loginAfter, region, provider)
    } catch (failure) { setError(errorCopy(failure)) }
    finally { setBusy(false) }
  }
  return <Modal title={member ? `编辑 ${member.alias}` : '添加佳明账号'} onClose={requestClose}>
    {discarding ? <><p>账号修改尚未保存，确定放弃本次输入？</p><div className="gcp-actions"><button className="gcp-btn" onClick={() => setDiscarding(false)}>继续编辑</button><button className="gcp-btn danger" onClick={() => { setUsername(''); setKey(''); onClose() }}>放弃修改</button></div></> : <form className="gcp-account-form" onSubmit={event => { event.preventDefault(); void save(false) }}>
      <label>账号备注<input className="gcp-input" aria-label="账号备注" placeholder="例如：自己、家人或其他备注" value={alias} maxLength={64} autoComplete="off" disabled={busy} onChange={event => setAlias(event.target.value)} /></label>
      <label>接入方式<select className="gcp-select" aria-label="账号接入方式" value={provider} disabled={busy} onChange={event => { setProvider(event.target.value as Member['provider']); setUsername(''); setKey('') }}><option value="connect-web">Connect 网页会话</option><option value="personal">官方 Personal API</option></select></label>
      <label>区域<select className="gcp-select" aria-label="账号区域" value={region} disabled={busy} onChange={event => { setRegion(event.target.value as Member['region']); setKey('') }}><option value="cn">中国区</option><option value="global">国际区</option></select></label>
      {provider === 'connect-web' ? <><label>佳明账号邮箱<input className="gcp-input" type="email" aria-label="佳明账号邮箱" autoComplete="off" value={username} disabled={busy} maxLength={320} placeholder={member?.provider === 'connect-web' ? '留空保留当前邮箱' : '请输入这个账号的邮箱'} onChange={event => setUsername(event.target.value)} /></label>{member?.maskedEmail && <small>当前邮箱：{member.maskedEmail}</small>}<p>保存后可打开佳明官方登录窗口完成密码与两步验证。切换账号身份或区域后需重新登录。</p></> : <><label>Personal API Key<input className="gcp-input" type="password" aria-label="Personal API Key" autoComplete="new-password" value={key} disabled={busy} maxLength={4096} placeholder={member?.provider === 'personal' && region === member.region ? '留空保留当前 Key' : '输入对应区域的 API Key'} onChange={event => setKey(event.target.value)} /></label><p>中国区与国际区密钥不能混用；切换地区时需要输入新 Key。</p></>}
      {error && <Hint error>{error}</Hint>}
      <div className="gcp-actions"><button type="button" className="gcp-btn" disabled={busy} onClick={requestClose}>取消</button><button type="submit" className={`gcp-btn${provider === 'personal' || !canLogin ? ' primary' : ''}`} disabled={busy || Boolean(member && !member.revision)}>{busy ? '保存中…' : '保存账号'}</button>{provider === 'connect-web' && canLogin && <button type="button" className="gcp-btn primary" disabled={busy || Boolean(member && !member.revision)} onClick={() => void save(true)}><WorkspaceIcon name="login" />保存并登录</button>}</div>
    </form>}
  </Modal>
}
function Range({ state }: { state: SessionState }) { return <div className="gcp-row" aria-label="统计范围">{([7, 28] as const).map(days => <button key={days} type="button" className={`gcp-btn small${days === state.days ? ' primary' : ''}`} onClick={() => { state.days = days; notify(state) }}>{days} 天</button>)}</div> }
function ActivityStats({ activities }: { activities: Activity[] }) {
  const minutes = activities.reduce((sum, value) => sum + Math.max(0, Number(value.durationSeconds) || 0) / 60, 0)
  const running = activities.filter(activity => /run|running/i.test(activity.type)).reduce((sum, value) => sum + Math.max(0, Number(value.distanceMeters) || 0), 0) / 1000
  return <div className="gcp-statgrid"><div className="gcp-stat"><small>跑步距离</small><strong>{running.toFixed(1)}<small> km</small></strong></div><div className="gcp-stat"><small>训练时长</small><strong>{(minutes / 60).toFixed(1)}<small> 小时</small></strong></div><div className="gcp-stat"><small>活动记录</small><strong>{activities.length}<small> 次</small></strong></div></div>
}
function TrainingChart({ activities, days }: { activities: Activity[]; days: number }) {
  const today = dayKey()
  const values = Array.from({ length: days }, (_, index) => {
    const date = offsetDay(today, index + 1 - days)
    return { date, minutes: activities.filter(activity => activity.date.slice(0, 10) === date).reduce((sum, value) => sum + Number(value.durationSeconds || 0) / 60, 0) }
  })
  const max = Math.max(1, ...values.map(value => value.minutes))
  const step = 360 / days
  return <svg className="gcp-chart" viewBox="0 0 380 110" role="img" aria-label={`最近 ${days} 天训练时长，单位分钟`}>{values.map((value, index) => <g key={value.date}><title>{value.date}：{Math.round(value.minutes)} 分钟</title><rect x={10 + index * step + step * .13} y={82 - value.minutes / max * 65} width={Math.max(3, step * .65)} height={Math.max(1, value.minutes / max * 65)} rx={2} fill="#789cd2" />{(days === 7 || index % 5 === 0) && <text x={10 + index * step + step * .45} y={103} textAnchor="middle" fontSize="9" fill="currentColor" opacity=".55">{value.date.slice(5)}</text>}</g>)}</svg>
}
function TimelineView({ ctx, member, state, visible, onNote, onAvatar }: { ctx: CoachPanelClientContext; member: Member; state: SessionState; visible: boolean; onNote(): void; onAvatar(url: string): void }) {
  const result = useData<Timeline>(signal => coachRpc(ctx.connection.rpc, 'timeline', { accountId: member.accountId, days: state.days }, signal), `${member.accountId}:${state.days}:${state.dataRevision}`, visible)
  useEffect(() => {
    if (!result.data?.avatarUrl || result.data.avatarUrl === member.avatarUrl) return
    onAvatar(result.data.avatarUrl)
  }, [result.data?.avatarUrl, member.avatarUrl, onAvatar])
  const [filter, setFilter] = useState('all')
  const data = result.data
  const events = data ? [
    ...data.activities.map(activity => ({ id: `activity-${activity.id}`, date: activity.date, title: activity.name, type: 'activity', label: '实际训练', text: `${sportName(activity.type)} · ${(activity.distanceMeters / 1000).toFixed(1)} km · ${Math.round(activity.durationSeconds / 60)} 分钟` })),
    ...data.plans.map(plan => ({ id: `plan-${plan.id}`, date: plan.date, title: plan.name, type: 'plan', label: '佳明排期', text: '' })),
    ...data.notes.map(note => ({ id: `note-${note.id}`, date: note.updatedAt, title: note.title, type: 'note', label: '备注', text: note.body })),
  ].filter(event => filter === 'all' || event.type === filter).sort((a, b) => b.date.localeCompare(a.date)) : []
  return <><div className="gcp-heading"><h2>近期训练</h2><Range state={state} /></div>
    {result.error && <Hint error>{result.error} <button className="gcp-link" onClick={result.reload}>重试</button></Hint>}{result.loading && <Hint>正在读取该账号的训练记录…</Hint>}
    {data && <>{data.activityError ? <Hint error>{data.activityError === 'auth_required' ? '佳明授权需要更新，仍可查看本地备注。' : '暂时无法更新活动，请稍后重试。'}</Hint> : <><ActivityStats activities={data.activities} /><TrainingChart activities={data.activities} days={state.days} /></>}
      <small>更新于 {displayTime(data.updatedAt)}{data.partial ? ' · 数据不完整，统计仅覆盖已返回记录' : ''}</small>
      <div className="gcp-heading gcp-section"><h2>时间线</h2><button className="gcp-btn small" onClick={onNote}><WorkspaceIcon name="note" />写备注</button></div>
      <div className="gcp-row">{[['all', '全部'], ['activity', '运动'], ['plan', '计划'], ['note', '备注']].map(([value, copy]) => <button key={value} type="button" className={`gcp-btn small${filter === value ? ' primary' : ''}`} onClick={() => setFilter(value)}>{copy}</button>)}</div>
      {data.planError && <Hint>{member.provider === 'personal' ? 'Personal API 暂不提供佳明课表排期。' : '课表排期暂不可读，活动与备注仍可查看。'}</Hint>}
      {!events.length && <Empty>该范围暂无可展示的记录。</Empty>}
      <div style={{ marginTop: 13 }}>{events.map(event => <article key={event.id} className={`gcp-event ${event.type}`}><div className="gcp-event-date">{event.date.slice(0, 10)}</div><div className="gcp-row"><h3>{event.title || '未命名训练'}</h3><span className="gcp-badge">{event.label}</span></div>{event.text && <p>{event.text}</p>}</article>)}</div>
    </>}
  </>
}

function draftValue(draft: Pick<Draft, 'title' | 'body' | 'category'>) { return JSON.stringify([draft.title, draft.body, draft.category]) }
function isDirty(draft?: Draft) { return draft !== undefined && draftValue(draft) !== draft.baseline }
function NotesView({ ctx, member, state, visible }: { ctx: CoachPanelClientContext; member: Member; state: SessionState; visible: boolean }) {
  const result = useData<{ notes: CoachNote[] }>(signal => coachRpc(ctx.connection.rpc, 'notes', { accountId: member.accountId }, signal), `${member.accountId}:${state.dataRevision}`, visible)
  const draft = state.drafts.get(member.accountId)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [exporting, setExporting] = useState<'md' | 'json'>()
  const [pendingDelete, setPendingDelete] = useState<CoachNote>()
  const [search, setSearch] = useState('')
  const [replaceDraft, setReplaceDraft] = useState<CoachNote | 'new' | 'close'>()
  const notes = (result.data?.notes ?? []).filter(note => !search || `${note.title} ${note.body}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  useEffect(() => {
    if (!isDirty(draft)) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [draft?.title, draft?.body, draft?.category])
  function start(note?: CoachNote) {
    const next: Draft = note ? { id: note.id, title: note.title, body: note.body, category: note.category, expectedRevision: note.revision, accountRevision: member.revision, baseline: '' } : { title: '', body: '', category: '一般备忘', accountRevision: member.revision, baseline: '' }
    next.baseline = draftValue(next)
    state.drafts.set(member.accountId, next); setError(''); setMessage(''); notify(state)
  }
  function requestStart(note?: CoachNote) { if (isDirty(draft)) setReplaceDraft(note ?? 'new'); else start(note) }
  function continueEditing(next: CoachNote | 'new' | 'close') {
    if (next === 'close') { state.drafts.delete(member.accountId); notify(state) }
    else start(next === 'new' ? undefined : next)
  }
  function patch(next: Partial<Draft>) { if (!draft) return; state.drafts.set(member.accountId, { ...draft, ...next }); notify(state) }
  async function save() {
    if (!draft || busy) return false
    if (!draft.title.trim() || !draft.body.trim()) { setError('请填写备注标题和正文。'); return false }
    const accountId = member.accountId
    setBusy(true); setError(''); setMessage('')
    try {
      const saved = await coachRpc<{ note: CoachNote }>(ctx.connection.rpc, 'save-note', { accountId, ...(draft.id ? { id: draft.id, expectedRevision: draft.expectedRevision } : {}), ...(draft.accountRevision ? { expectedAccountRevision: draft.accountRevision } : {}), title: draft.title.trim(), body: draft.body, category: draft.category })
      const next: Draft = { id: saved.note.id, title: saved.note.title, body: saved.note.body, category: saved.note.category, expectedRevision: saved.note.revision, accountRevision: draft.accountRevision, baseline: '' }
      next.baseline = draftValue(next)
      state.drafts.set(accountId, next); state.dataRevision += 1; notify(state); setMessage('已保存'); return true
    } catch (failure) { setError(errorCopy(failure)); return false }
    finally { setBusy(false) }
  }
  async function remove(note: CoachNote) {
    setBusy(true); setError('')
    try {
      await coachRpc(ctx.connection.rpc, 'delete-note', { accountId: member.accountId, id: note.id, expectedRevision: note.revision, ...(member.revision ? { expectedAccountRevision: member.revision } : {}) })
      if (draft?.id === note.id) state.drafts.delete(member.accountId)
      state.dataRevision += 1; notify(state); setPendingDelete(undefined); setMessage('备注已删除')
    } catch (failure) { setError(errorCopy(failure)) }
    finally { setBusy(false) }
  }
  return <><p className="gcp-subtitle">属于 {member.alias} 的小本子。切换标签保留草稿，保存后写入本机工作区。</p>
    <div className="gcp-actions"><button className="gcp-btn primary" onClick={() => requestStart()}><WorkspaceIcon name="plus" />新建备注</button><button className="gcp-btn" disabled={!notes.length} onClick={() => setExporting('md')}><WorkspaceIcon name="download" />导出 Markdown</button><button className="gcp-btn" disabled={!notes.length} onClick={() => setExporting('json')} title="导出 JSON"><WorkspaceIcon name="download" />JSON</button></div>
    <input className="gcp-input" type="search" aria-label="搜索备注" placeholder="搜索当前账号的备注" value={search} onChange={event => setSearch(event.target.value)} />
    {(error || result.error) && <Hint error>{error || result.error}</Hint>}{message && <Hint>{message}</Hint>}{result.loading && <Hint>正在读取已保存备注…</Hint>}
    {draft && <div className="gcp-editor"><div className="gcp-heading"><h2>{draft.id ? '编辑备注' : '新建备注'}</h2><small>{isDirty(draft) ? '未保存 · 草稿已保留' : '无未保存修改'}</small></div>
      <label>标题<input className="gcp-input" aria-label="备注标题" maxLength={160} value={draft.title} onChange={event => patch({ title: event.target.value })} /></label>
      <label>分类<select className="gcp-select" aria-label="备注分类" value={draft.category} onChange={event => patch({ category: event.target.value })}>{['一般备忘', '训练反馈', '长期偏好', '训练安排', '阶段目标', '待跟进', ...(!['一般备忘', '训练反馈', '长期偏好', '训练安排', '阶段目标', '待跟进'].includes(draft.category) ? [draft.category] : [])].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>正文<textarea className="gcp-textarea" aria-label="备注正文" maxLength={20000} value={draft.body} onChange={event => patch({ body: event.target.value })} /></label>
      <div className="gcp-actions"><button className="gcp-btn primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存备注'}</button><button className="gcp-btn" onClick={() => { if (!isDirty(draft)) { state.drafts.delete(member.accountId); notify(state) } else setReplaceDraft('close') }}>结束编辑</button></div>
    </div>}
    <div className="gcp-heading gcp-section"><h2>已保存备注</h2><small>{notes.length} 条</small></div>
    {notes.map(note => <article className="gcp-note" key={note.id}><div className="gcp-row" style={{ justifyContent: 'space-between' }}><h3>{note.title}</h3><small>{note.category}</small></div><p>{note.body}</p><small>{displayTime(note.updatedAt)} · 本地记录</small><div className="gcp-actions"><button className="gcp-link" onClick={() => requestStart(note)}>编辑</button><button className="gcp-link" onClick={() => setPendingDelete(note)}>删除</button></div></article>)}
    {!notes.length && !result.loading && !result.error && <Empty>暂无匹配的备注。登录状态不影响本地记录。</Empty>}
    {exporting && <Modal title={`导出 ${member.alias} 的备注`} onClose={() => setExporting(undefined)}><p>当前账号 · {search ? '当前搜索范围' : '全部已保存备注'} · 共 {notes.length} 条。</p><p>不包含其他账号、未保存草稿、账号密码或登录会话。</p><button className="gcp-btn primary" onClick={() => { exportNotes(member, notes, exporting); setExporting(undefined); setMessage('备注文件已导出') }}>导出 {exporting === 'md' ? 'Markdown' : 'JSON'}</button></Modal>}
    {pendingDelete && <Modal title="删除这条备注？" onClose={() => setPendingDelete(undefined)}><p>{pendingDelete.title} · {member.alias}</p><button className="gcp-btn danger" disabled={busy} onClick={() => void remove(pendingDelete)}>确认删除</button></Modal>}
    {replaceDraft && <Modal title="这份草稿还未保存" onClose={() => setReplaceDraft(undefined)}><p>当前草稿属于 {member.alias}。请选择保存或放弃后再继续。</p><div className="gcp-actions"><button className="gcp-btn" onClick={() => { const next = replaceDraft; setReplaceDraft(undefined); continueEditing(next) }}>放弃修改</button><button className="gcp-btn primary" disabled={busy} onClick={() => { void save().then(ok => { if (!ok) return; const next = replaceDraft; setReplaceDraft(undefined); continueEditing(next) }) }}>保存并继续</button></div></Modal>}
  </>
}
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }) {
  const titleId = useRef(`gcp-dialog-${Math.random().toString(36).slice(2)}`)
  return <div className="gcp-modal-shade"><section className="gcp-modal" role="dialog" aria-modal="true" aria-labelledby={titleId.current}><div className="gcp-heading"><h2 id={titleId.current}>{title}</h2><button className="gcp-btn small" onClick={onClose} title="关闭" aria-label="关闭"><WorkspaceIcon name="close" /></button></div>{children}</section></div>
}
function sportName(type: string) {
  if (/run/i.test(type)) return '跑步'
  if (/cycl|bik/i.test(type)) return '骑行'
  if (/strength|weight/i.test(type)) return '力量'
  if (/swim/i.test(type)) return '游泳'
  if (/walk|hik/i.test(type)) return '步行'
  return '其他'
}
function MyTraining({ ctx, members, state, visible }: { ctx: CoachPanelClientContext; members: Member[]; state: SessionState; visible: boolean }) {
  const preferences = useData<{ selfAccountId: string | null }>(signal => coachRpc(ctx.connection.rpc, 'preferences', {}, signal), 'preferences', visible)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pinning, setPinning] = useState(false)
  useEffect(() => { if (preferences.data) setSelected(preferences.data.selfAccountId) }, [preferences.data])
  const member = members.find(value => value.accountId === selected)
  const result = useData<Timeline>(signal => selected ? coachRpc(ctx.connection.rpc, 'timeline', { accountId: selected, days: state.days }, signal) : Promise.resolve({ success: true, accountId: '', activities: [], plans: [], notes: [], updatedAt: '', partial: false }), `${selected}:${state.days}:${state.dataRevision}`, visible && Boolean(member))
  async function pin(accountId: string) {
    if (pinning) return
    setPinning(true)
    setError('')
    try { await coachRpc(ctx.connection.rpc, 'save-preferences', { selfAccountId: accountId || null }); setSelected(accountId || null) }
    catch (failure) { setError(errorCopy(failure)) }
    finally { setPinning(false) }
  }
  const activities = result.data?.activities ?? []
  const sports = new Map<string, number>()
  for (const activity of activities) sports.set(sportName(activity.type), (sports.get(sportName(activity.type)) ?? 0) + Math.max(0, Number(activity.durationSeconds) || 0))
  const total = [...sports.values()].reduce((sum, value) => sum + value, 0)
  const colors = ['#789bd1', '#6eac9c', '#a993be', '#c7aa71', '#90a4b3', '#bf8e94']
  let prior = 0
  const stops = [...sports].map(([name, seconds], index) => { const start = prior; prior += total ? seconds / total * 100 : 0; return { name, seconds, color: colors[index % colors.length], start, end: prior } })
  return <><div className="gcp-eyebrow">PERSONAL OVERVIEW</div><div className="gcp-heading"><h1>我的训练</h1><Range state={state} /></div><p className="gcp-subtitle">固定展示自己的训练，不随当前查看的账号切换。</p>
    <label>本人账号 <MemberPicker members={members} value={selected ?? ''} label="固定本人账号" emptyLabel="选择我的账号" disabled={pinning} onChange={value => void pin(value)} /></label>
    {(error || preferences.error) && <Hint error>{error || preferences.error}</Hint>}
    {!member && <Empty>请选择“我”对应的账号，以便固定展示自己的训练。</Empty>}
    {result.loading && <Hint>正在读取本人的近期训练…</Hint>}{result.error && member && <Hint error>{result.error}</Hint>}
    {member && result.data && <>{result.data.activityError ? <Hint error>暂时无法更新训练数据，请检查该账号连接。</Hint> : <><ActivityStats activities={activities} /><div className="gcp-heading gcp-section"><h2>运动类型占比</h2><small>按活动时长</small></div>
      {total > 0 ? <div className="gcp-sports"><div className="gcp-donut" role="img" aria-label={stops.map(value => `${value.name} ${(value.seconds / total * 100).toFixed(1)}%`).join('，')} style={{ background: `conic-gradient(${stops.map(value => `${value.color} ${value.start}% ${value.end}%`).join(',')})` }}><div className="gcp-donut-text"><strong>{(total / 3600).toFixed(1)}</strong><small>小时</small></div></div><div className="gcp-sports-list">{stops.map(value => <div className="gcp-legend" key={value.name} style={{ '--color': value.color } as CSSProperties}><i /><span>{value.name}<br /><small>{Math.round(value.seconds / 60)} 分钟</small></span><strong>{(value.seconds / total * 100).toFixed(1)}%</strong></div>)}</div></div> : <Empty>该范围暂无活动时长记录。</Empty>}
      <h2 className="gcp-section">训练时长趋势</h2><TrainingChart activities={activities} days={state.days} /><small>更新于 {displayTime(result.data.updatedAt)}{result.data.partial ? ' · 数据不完整，仅统计已返回记录' : ''}</small></>}
    </>}
  </>
}
