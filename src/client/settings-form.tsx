import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FormEvent, ReactElement } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  removeAccountMutations,
  saveAccountMutations,
  type ConfigForm,
  type ConfigFormSnapshot,
  type GarminStoredAccount,
} from './harness-config-form'
import { callGarminAuthRpc } from './flow-control'
import {
  parseGarminAuthAccountsRpcResult,
  type GarminAuthAccountSummary,
  type GarminAuthRegion,
} from './protocol'

type GarminSettingsValue = Record<string, unknown>
const ACCOUNT_REFRESH_MS = 15_000
const SIGN_IN_REFRESH_MS = 1_000
const MAX_ACCOUNTS = 5

const panelStyle: CSSProperties = { maxWidth: 860, margin: '24px 0' }
const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-default, #e2e8f0)',
  borderRadius: 16,
  padding: 20,
  background: 'var(--dsw-alias-surface-primary, #fff)',
}
const fieldStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  marginTop: 6,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-default, #cbd5e1)',
  borderRadius: 8,
  background: 'var(--dsw-alias-surface-primary, #fff)',
  color: 'var(--dsw-alias-label-primary, #111827)',
  font: 'inherit',
}
const buttonStyle: CSSProperties = {
  border: 0,
  borderRadius: 8,
  font: 'inherit',
  padding: '10px 16px',
}

/** Secret email values are never read from the configuration snapshot. */
export function GarminSettingsForm({
  form,
  refresh,
  connection,
  onLogin,
}: {
  form: ConfigForm<GarminSettingsValue>
  refresh(): Promise<unknown>
  connection: ConnectionHandle
  onLogin(accountId: string, region: GarminAuthRegion): void
}): ReactElement {
  const subscribe = useCallback((notify: () => void) => form.subscribe(notify), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [summaries, setSummaries] = useState<GarminAuthAccountSummary[]>()
  const [draft, setDraft] = useState<GarminStoredAccount>()
  const [listError, setListError] = useState('')
  const refreshTimers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const requestInFlight = useRef(false)

  const refreshSettings = useCallback(async () => {
    try { await refresh() } catch { /* A later refresh can recover. */ }
  }, [refresh])

  const refreshAccounts = useCallback(async () => {
    if (!connection.isLoopback || requestInFlight.current) return
    requestInFlight.current = true
    try {
      const result = parseGarminAuthAccountsRpcResult(
        await callGarminAuthRpc(connection.rpc, 'account', {}),
      )
      if (result.success) {
        setSummaries(result.accounts)
        setListError('')
      } else {
        setListError('暂时无法读取账号状态，请稍后重试。')
      }
    } catch {
      setListError('暂时无法读取账号状态，请稍后重试。')
    } finally {
      requestInFlight.current = false
    }
  }, [connection])

  const explicit = snapshot.value?.accountsConfigured === true
  const rows = explicit
    ? parseStoredAccounts(snapshot.value?.accounts)
    : summaries?.map(summary => ({
        id: summary.accountId,
        region: summary.region,
        alias: summary.alias ?? '',
        slot: summary.slot,
      }))
  const awaitingSignIn = summaries?.some(account => !account.authenticated) ?? false

  useEffect(() => { void refreshSettings() }, [refreshSettings])
  useEffect(() => () => {
    for (const timer of refreshTimers.current) clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!connection.isLoopback) return
    void refreshAccounts()
    const timer = setInterval(
      () => { void refreshAccounts() },
      awaitingSignIn ? SIGN_IN_REFRESH_MS : ACCOUNT_REFRESH_MS,
    )
    const onFocus = () => { void refreshAccounts() }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [awaitingSignIn, connection.isLoopback, refreshAccounts])

  const refreshAfterChange = useCallback(() => {
    void refreshSettings()
    void refreshAccounts()
    for (const delay of [500, 2_000, 5_000]) {
      refreshTimers.current.push(setTimeout(() => {
        void refreshSettings()
        void refreshAccounts()
      }, delay))
    }
  }, [refreshAccounts, refreshSettings])

  const add = () => {
    if (snapshot.status !== 'ready' || !snapshot.writable || !rows || draft
      || rows.length >= MAX_ACCOUNTS) return
    const used = new Set(rows.map(account => account.slot))
    const slot = [1, 2, 3, 4, 5].find(value => !used.has(value))
    if (!slot) return
    let id: string
    try {
      id = createAccountId()
    } catch {
      setListError('无法生成账号 ID，请重试。')
      return
    }
    if (rows.some(account => account.id === id)) return
    setDraft({ id, slot, region: 'global', alias: '' })
  }

  const save = async (entry: GarminStoredAccount, email: string): Promise<boolean> => {
    if (!rows || snapshot.status !== 'ready' || !snapshot.writable) return false
    const mutations = saveAccountMutations(rows, entry, email)
    if (!mutations) return false
    const accepted = await form.mutate(mutations, snapshot.revision)
    if (accepted) {
      setDraft(undefined)
      refreshAfterChange()
    }
    return accepted
  }

  const remove = async (accountId: string): Promise<boolean> => {
    if (!rows || snapshot.status !== 'ready' || !snapshot.writable) return false
    const mutations = removeAccountMutations(rows, accountId)
    if (!mutations) return false
    const accepted = await form.mutate(mutations, snapshot.revision)
    if (accepted) refreshAfterChange()
    return accepted
  }

  const canAdd = snapshot.status === 'ready' && snapshot.writable
    && rows !== undefined && rows.length < MAX_ACCOUNTS && !draft

  return (
    <section aria-label="Garmin 账号配置" style={panelStyle}>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Garmin 账号</h2>
      <p style={{ color: 'var(--dsw-alias-label-secondary, #475569)', margin: '0 0 18px' }}>
        可添加最多 5 个账号，支持多个中国区或国际区账号。每个账号的登录都在 Harness 内的 Garmin 官方页面完成。
      </p>
      {snapshot.status === 'loading' && <p>正在读取配置…</p>}
      {snapshot.status === 'unavailable' && (
        <div role="status">
          <p>{snapshot.mode === 'memory'
            ? '只能在本机 Harness 中修改插件配置。'
            : '暂时无法读取插件配置，请刷新后重试。'}</p>
          {snapshot.mode === 'host' && (
            <button onClick={() => void refreshSettings()} type="button">刷新配置</button>
          )}
        </div>
      )}
      {listError && <p role="status" style={{ color: '#b42318' }}>{listError}</p>}
      {rows?.length === 0 && !draft && <p>尚未添加 Garmin 账号。</p>}
      <div style={{ display: 'grid', gap: 16 }}>
        {rows?.map(entry => (
          <AccountCard
            entry={entry}
            isDraft={false}
            isLoopback={connection.isLoopback}
            key={entry.id}
            onDelete={remove}
            onLogin={onLogin}
            onSave={save}
            summary={summaries?.find(value => value.accountId === entry.id)}
            writable={snapshot.status === 'ready' && snapshot.writable}
          />
        ))}
        {draft && (
          <AccountCard
            entry={draft}
            isDraft
            isLoopback={connection.isLoopback}
            key={draft.id}
            onCancelDraft={() => setDraft(undefined)}
            onLogin={onLogin}
            onSave={save}
            writable={snapshot.status === 'ready' && snapshot.writable}
          />
        )}
      </div>
      <button
        disabled={!canAdd}
        onClick={add}
        style={{ ...buttonStyle, background: canAdd ? '#087cc1' : '#e2e8f0', color: canAdd ? '#fff' : '#64748b', cursor: canAdd ? 'pointer' : 'not-allowed', marginTop: 16 }}
        type="button"
      >
        ＋ 添加账号
      </button>
      <p style={{ color: 'var(--dsw-alias-label-secondary, #475569)', fontSize: 13, marginTop: 16 }}>
        已保存的邮箱不会回填；留空保存只修改别名或地区。切换地区后需重新登录。账号 ID 可用于指定工具操作的目标账号。
      </p>
    </section>
  )
}

function AccountCard({
  entry, isDraft, isLoopback, onCancelDraft, onDelete, onLogin, onSave, summary, writable,
}: {
  entry: GarminStoredAccount
  isDraft: boolean
  isLoopback: boolean
  onCancelDraft?(): void
  onDelete?(accountId: string): Promise<boolean>
  onLogin(accountId: string, region: GarminAuthRegion): void
  onSave(entry: GarminStoredAccount, email: string): Promise<boolean>
  summary?: GarminAuthAccountSummary
  writable: boolean
}): ReactElement {
  const [region, setRegion] = useState<GarminAuthRegion>(entry.region)
  const [alias, setAlias] = useState(entry.alias)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setRegion(entry.region)
    setAlias(entry.alias)
  }, [entry.region, entry.alias])

  const changed = isDraft || region !== entry.region || alias.trim() !== entry.alias || email.trim() !== ''
  const loginReady = !isDraft && !changed && isLoopback && !busy
    && summary?.configured === true && summary.region === entry.region
  const canSave = writable && !busy && changed

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    const normalizedEmail = email.trim()
    const normalizedAlias = alias.trim()
    if ((isDraft && !normalizedEmail) || (normalizedEmail && !isEmail(normalizedEmail))) {
      setError('新账号需要有效的 Garmin 邮箱；已有账号留空邮箱可保留原值。')
      setMessage('')
      return
    }
    if (!isAlias(normalizedAlias)) {
      setError('别名最多 64 个字符，不能包含控制字符。')
      setMessage('')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const accepted = await onSave({ ...entry, region, alias: normalizedAlias }, normalizedEmail)
      if (!accepted) {
        setError('配置未保存，请刷新页面后重试。')
        return
      }
      setEmail('')
      setMessage(normalizedEmail
        ? '邮箱已提交保存。输入框会清空且不会回显已保存的邮箱；账号状态更新后即可登录。'
        : '账号已保存，原邮箱保持不变。')
    } catch {
      setError('配置暂时无法保存，请重试。')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (isDraft) { onCancelDraft?.(); return }
    if (!onDelete || !window.confirm(
      '停用此账号？插件配置会移除该账号，本机已保存的会话文件仍保留。',
    )) return
    setBusy(true)
    try {
      const accepted = await onDelete(entry.id)
      if (!accepted) setError('账号未停用，请刷新页面后重试。')
    } catch {
      setError('账号暂时无法停用，请重试。')
    } finally {
      setBusy(false)
    }
  }

  const status = isDraft ? '未保存'
    : summary?.authenticated ? '已登录'
      : summary ? '待登录' : '正在应用配置…'
  return (
    <section aria-label={`Garmin 账号 ${entry.id}`} style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <strong>{alias.trim() || (region === 'cn' ? '中国区账号' : '国际区账号')}</strong>
        <span style={{ color: 'var(--dsw-alias-label-secondary, #475569)' }}>{status}</span>
      </div>
      <p style={{ color: 'var(--dsw-alias-label-secondary, #475569)', fontSize: 12, margin: '8px 0 16px' }}>
        账号 ID：<code style={{ userSelect: 'text' }}>{entry.id}</code>
      </p>
      <form onSubmit={event => void save(event)}>
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))' }}>
          <label style={{ fontWeight: 600 }}>
            地区
            <select disabled={!writable || busy} onChange={event => setRegion(event.target.value as GarminAuthRegion)} style={fieldStyle} value={region}>
              <option value="cn">中国区（garmin.cn）</option>
              <option value="global">国际区（garmin.com）</option>
            </select>
          </label>
          <label style={{ fontWeight: 600 }}>
            别名（可选）
            <input disabled={!writable || busy} maxLength={64} onChange={event => setAlias(event.target.value)} style={fieldStyle} type="text" value={alias} />
          </label>
          <label style={{ fontWeight: 600 }}>
            {isDraft ? 'Garmin 账号邮箱' : '更换 Garmin 账号邮箱（留空保留）'}
            <input autoComplete="off" disabled={!writable || busy} maxLength={320} onChange={event => setEmail(event.target.value)} placeholder={!isDraft && summary?.configured ? '邮箱已保存，不会回显' : 'name@example.com'} style={fieldStyle} type="email" value={email} />
            {!isDraft && (
              <span style={{ color: 'var(--dsw-alias-label-secondary, #475569)', display: 'block', fontSize: 12, fontWeight: 400, marginTop: 6 }}>
                {summary?.configured === true
                  ? '邮箱已配置。输入新邮箱并保存可更换；留空保存会保留原邮箱。'
                  : summary?.configured === false
                    ? '尚未配置邮箱；请输入邮箱并保存，之后才能登录。'
                    : '正在确认邮箱配置。已保存的邮箱不会回显。'}
              </span>
            )}
          </label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
          <button disabled={!canSave} style={{ ...buttonStyle, background: canSave ? '#111827' : '#e2e8f0', color: canSave ? '#fff' : '#64748b', cursor: canSave ? 'pointer' : 'not-allowed' }} type="submit">
            {busy ? '正在保存…' : '保存账号'}
          </button>
          <button disabled={!loginReady} onClick={() => onLogin(entry.id, entry.region)} style={{ ...buttonStyle, background: loginReady ? '#087cc1' : '#e2e8f0', color: loginReady ? '#fff' : '#64748b', cursor: loginReady ? 'pointer' : 'not-allowed' }} type="button">
            在 Harness 内登录
          </button>
          <button disabled={!writable || busy} onClick={() => void remove()} style={{ ...buttonStyle, background: '#fff', color: '#b42318', border: '1px solid #efc4c0' }} type="button">
            {isDraft ? '取消添加' : '停用账号'}
          </button>
        </div>
        {changed && !isDraft && <p style={{ color: '#9a6700', fontSize: 13 }}>存在未保存修改，登录已暂停。请先保存或恢复原值。</p>}
        {!isDraft && region !== entry.region && <p style={{ color: '#9a6700', fontSize: 13 }}>切换地区后，原地区的登录会话不会沿用。</p>}
        {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
        {message && <p role="status" style={{ color: '#087443' }}>{message}</p>}
      </form>
    </section>
  )
}

function parseStoredAccounts(value: unknown): GarminStoredAccount[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) return undefined
  const ids = new Set<string>()
  const slots = new Set<number>()
  const result: GarminStoredAccount[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const candidate = item as Record<string, unknown>
    const keys = Object.keys(candidate).sort()
    if (keys.length !== 4
      || keys.some((key, index) => key !== ['alias', 'id', 'region', 'slot'][index])
      || typeof candidate.id !== 'string'
      || !/^[a-z][a-z0-9_-]{0,31}$/.test(candidate.id)
      || (candidate.region !== 'cn' && candidate.region !== 'global')
      || typeof candidate.alias !== 'string'
      || !isAlias(candidate.alias)
      || !Number.isSafeInteger(candidate.slot)
      || (candidate.slot as number) < 1
      || (candidate.slot as number) > MAX_ACCOUNTS
      || ids.has(candidate.id)
      || slots.has(candidate.slot as number)) return undefined
    ids.add(candidate.id)
    slots.add(candidate.slot as number)
    result.push({
      id: candidate.id,
      region: candidate.region,
      alias: candidate.alias,
      slot: candidate.slot as number,
    })
  }
  return result
}

function createAccountId(): string {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  return `a${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`
}

function isAlias(value: string): boolean {
  return value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function isEmail(value: string): boolean {
  return value.length > 0
    && value.length <= 320
    && !/[\u0000-\u001f\u007f-\u009f\s]/.test(value)
    && /^[^@]+@[^@]+\.[^@]+$/.test(value)
}
