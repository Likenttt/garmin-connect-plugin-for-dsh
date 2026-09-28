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
export type GarminLoginRequest = {
  accountId: string
  region: GarminAuthRegion
  expectedRevision?: string
  expectedRegion?: GarminAuthRegion
  pendingMaskedEmail?: string
  onSettled?(ready: boolean): void
}
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
  onLogin(request: GarminLoginRequest): boolean
}): ReactElement {
  const subscribe = useCallback((notify: () => void) => form.subscribe(notify), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [summaries, setSummaries] = useState<GarminAuthAccountSummary[]>()
  const [draft, setDraft] = useState<GarminStoredAccount>()
  const [pendingLogin, setPendingLogin] = useState<{ accountId: string; requestId: number; maskedEmail?: string }>()
  const pendingLoginRef = useRef<{ accountId: string; requestId: number; maskedEmail?: string }>()
  const nextRequestId = useRef(0)
  const [listError, setListError] = useState('')
  const refreshTimers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const requestInFlight = useRef<Promise<void>>()

  const refreshSettings = useCallback(async () => {
    try { await refresh() } catch { /* A later refresh can recover. */ }
  }, [refresh])

  const refreshAccounts = useCallback(async () => {
    if (!connection.isLoopback) return
    if (requestInFlight.current) return requestInFlight.current
    const current = (async () => {
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
      }
    })()
    requestInFlight.current = current
    try { await current } finally {
      if (requestInFlight.current === current) requestInFlight.current = undefined
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
    if (snapshot.status !== 'ready' || !snapshot.writable || !rows || draft || pendingLoginRef.current
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

  const save = async (entry: GarminStoredAccount, email: string): Promise<string | undefined> => {
    if (!rows || snapshot.status !== 'ready' || !snapshot.writable || pendingLoginRef.current) return undefined
    let revision: string
    try {
      do { revision = createAccountRevision() } while (revision === entry.revision)
    } catch {
      setListError('无法生成账号修订标识，请重试。')
      return undefined
    }
    const mutations = saveAccountMutations(rows, entry, email, revision)
    if (!mutations) return undefined
    const accepted = await form.mutate(mutations, snapshot.revision)
    if (accepted) {
      setDraft(undefined)
      refreshAfterChange()
    }
    return accepted ? revision : undefined
  }

  const remove = async (accountId: string): Promise<boolean> => {
    if (!rows || snapshot.status !== 'ready' || !snapshot.writable || pendingLoginRef.current) return false
    const mutations = removeAccountMutations(rows, accountId)
    if (!mutations) return false
    const accepted = await form.mutate(mutations, snapshot.revision)
    if (accepted) refreshAfterChange()
    return accepted
  }

  const canAdd = snapshot.status === 'ready' && snapshot.writable
    && rows !== undefined && rows.length < MAX_ACCOUNTS && !draft && !pendingLogin

  const requestLogin = (request: GarminLoginRequest): boolean => {
    if (pendingLoginRef.current) return false
    if (!request.expectedRegion) {
      const accepted = onLogin(request)
      if (!accepted) setListError('登录入口暂不可用，请重新打开设置页后重试。')
      return accepted
    }
    const next = {
      accountId: request.accountId,
      requestId: ++nextRequestId.current,
      ...(request.pendingMaskedEmail ? { maskedEmail: request.pendingMaskedEmail } : {}),
    }
    pendingLoginRef.current = next
    setPendingLogin(next)
    const accepted = onLogin({
      ...request,
      onSettled: ready => {
        if (pendingLoginRef.current?.requestId !== next.requestId) return
        if (!ready) {
          pendingLoginRef.current = undefined
          setPendingLogin(undefined)
          void refreshAccounts()
          return
        }
        void (async () => {
          // The first await may observe a pre-restart request; the second is fresh.
          await refreshAccounts()
          await refreshAccounts()
          if (pendingLoginRef.current?.requestId !== next.requestId) return
          pendingLoginRef.current = undefined
          setPendingLogin(undefined)
        })()
      },
    })
    if (!accepted && pendingLoginRef.current?.requestId === next.requestId) {
      pendingLoginRef.current = undefined
      setPendingLogin(undefined)
      setListError('账号已保存，但登录入口暂不可用。请重新打开设置页后重试。')
    }
    return accepted
  }

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
            loginPending={Boolean(pendingLogin)}
            onDelete={remove}
            onLogin={requestLogin}
            onSave={save}
            pendingLogin={pendingLogin?.accountId === entry.id ? pendingLogin : undefined}
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
            loginPending={Boolean(pendingLogin)}
            onCancelDraft={() => setDraft(undefined)}
            onLogin={requestLogin}
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
        已保存的邮箱会显示脱敏形式；点击邮箱可更换，留空保存只修改别名或地区。切换地区后需重新登录。账号 ID 可用于指定工具操作的目标账号。
      </p>
    </section>
  )
}

function AccountCard({
  entry, isDraft, isLoopback, loginPending, onCancelDraft, onDelete, onLogin, onSave, pendingLogin, summary, writable,
}: {
  entry: GarminStoredAccount
  isDraft: boolean
  isLoopback: boolean
  loginPending: boolean
  onCancelDraft?(): void
  onDelete?(accountId: string): Promise<boolean>
  onLogin(request: GarminLoginRequest): boolean
  onSave(entry: GarminStoredAccount, email: string): Promise<string | undefined>
  pendingLogin?: { accountId: string; maskedEmail?: string }
  summary?: GarminAuthAccountSummary
  writable: boolean
}): ReactElement {
  const [region, setRegion] = useState<GarminAuthRegion>(entry.region)
  const [alias, setAlias] = useState(entry.alias)
  const [email, setEmail] = useState('')
  const [editingEmail, setEditingEmail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setRegion(entry.region)
    setAlias(entry.alias)
  }, [entry.region, entry.alias])

  const changed = isDraft || region !== entry.region || alias.trim() !== entry.alias || email.trim() !== ''
  const shouldLoginAfterSave = isDraft || region !== entry.region || email.trim() !== ''
  const displayedEmail = isDraft || editingEmail
    ? email
    : (pendingLogin?.maskedEmail ?? summary?.maskedEmail
      ?? (summary?.configured ? '邮箱已配置（地址已隐藏）' : ''))
  const loginReady = !isDraft && !changed && !loginPending && isLoopback && !busy
    && summary?.configured === true && summary.region === entry.region
  const canEdit = writable && !busy && !loginPending
  const canSave = canEdit && changed

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
      const savedRevision = await onSave({ ...entry, region, alias: normalizedAlias }, normalizedEmail)
      if (!savedRevision) {
        setError('配置未保存，请刷新页面后重试。')
        return
      }
      setEmail('')
      setEditingEmail(false)
      if (shouldLoginAfterSave) {
        const loginStarted = onLogin({
          accountId: entry.id,
          region,
          expectedRevision: savedRevision,
          expectedRegion: region,
          ...(normalizedEmail ? { pendingMaskedEmail: maskEmailForDisplay(normalizedEmail) } : {}),
        })
        if (!loginStarted) setError('账号已保存，但登录入口暂不可用。请重新打开设置页后重试。')
      } else {
        setMessage('账号已保存，原邮箱保持不变。')
      }
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

  const status = pendingLogin ? '正在应用配置…'
    : isDraft ? '未保存'
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
            <select disabled={!canEdit} onChange={event => setRegion(event.target.value as GarminAuthRegion)} style={fieldStyle} value={region}>
              <option value="cn">中国区（garmin.cn）</option>
              <option value="global">国际区（garmin.com）</option>
            </select>
          </label>
          <label style={{ fontWeight: 600 }}>
            别名（可选）
            <input disabled={!canEdit} maxLength={64} onChange={event => setAlias(event.target.value)} style={fieldStyle} type="text" value={alias} />
          </label>
          <label style={{ fontWeight: 600 }}>
            {isDraft ? 'Garmin 账号邮箱' : 'Garmin 账号邮箱（点击更换，留空保留）'}
            <input
              autoCapitalize="off"
              autoComplete="off"
              disabled={!canEdit}
              inputMode="email"
              maxLength={320}
              onBlur={() => { if (!email.trim()) setEditingEmail(false) }}
              onChange={event => { setEditingEmail(true); setEmail(event.target.value) }}
              onFocus={() => { if (!isDraft && !editingEmail) { setEditingEmail(true); setEmail('') } }}
              placeholder="name@example.com"
              spellCheck={false}
              style={fieldStyle}
              type="text"
              value={displayedEmail}
            />
            {!isDraft && (
              <span style={{ color: 'var(--dsw-alias-label-secondary, #475569)', display: 'block', fontSize: 12, fontWeight: 400, marginTop: 6 }}>
                {summary?.configured === true
                  ? pendingLogin
                    ? '正在应用新配置并准备登录。'
                    : summary.maskedEmail
                    ? '当前仅显示脱敏邮箱。点击后可输入新邮箱；留空保存会保留原邮箱。'
                    : '邮箱已配置。点击后可输入新邮箱；留空保存会保留原邮箱。'
                  : summary?.configured === false
                    ? '尚未配置邮箱；请输入邮箱并保存，之后才能登录。'
                    : '正在确认邮箱配置。'}
              </span>
            )}
          </label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
          <button disabled={!canSave} style={{ ...buttonStyle, background: canSave ? '#111827' : '#e2e8f0', color: canSave ? '#fff' : '#64748b', cursor: canSave ? 'pointer' : 'not-allowed' }} type="submit">
            {busy ? '正在保存…' : isDraft ? '保存并登录' : shouldLoginAfterSave ? '保存并重新登录' : '保存账号'}
          </button>
          <button disabled={!loginReady} onClick={() => { void onLogin({ accountId: entry.id, region: entry.region }) }} style={{ ...buttonStyle, background: loginReady ? '#087cc1' : '#e2e8f0', color: loginReady ? '#fff' : '#64748b', cursor: loginReady ? 'pointer' : 'not-allowed' }} type="button">
            在 Harness 内登录
          </button>
          <button disabled={!canEdit} onClick={() => void remove()} style={{ ...buttonStyle, background: '#fff', color: '#b42318', border: '1px solid #efc4c0' }} type="button">
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
    const expectedKeys = candidate.revision === undefined
      ? ['alias', 'id', 'region', 'slot']
      : ['alias', 'id', 'region', 'revision', 'slot']
    if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      || typeof candidate.id !== 'string'
      || !/^[a-z][a-z0-9_-]{0,31}$/.test(candidate.id)
      || (candidate.region !== 'cn' && candidate.region !== 'global')
      || typeof candidate.alias !== 'string'
      || !isAlias(candidate.alias)
      || !Number.isSafeInteger(candidate.slot)
      || (candidate.slot as number) < 1
      || (candidate.slot as number) > MAX_ACCOUNTS
      || (candidate.revision !== undefined
        && (typeof candidate.revision !== 'string'
          || !/^[0-9a-f]{32}$/.test(candidate.revision)))
      || ids.has(candidate.id)
      || slots.has(candidate.slot as number)) return undefined
    ids.add(candidate.id)
    slots.add(candidate.slot as number)
    result.push({
      id: candidate.id,
      region: candidate.region,
      alias: candidate.alias,
      slot: candidate.slot as number,
      ...(typeof candidate.revision === 'string' ? { revision: candidate.revision } : {}),
    })
  }
  return result
}

function createAccountId(): string {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  return `a${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`
}

function createAccountRevision(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function isAlias(value: string): boolean {
  return value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function isEmail(value: string): boolean {
  if (value.length === 0 || value.length > 320 || value.includes('*')
    || /[\u0000-\u001f\u007f-\u009f\s]/u.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2 || !parts[0]) return false
  const labels = parts[1].split('.')
  return labels.length >= 2 && labels.every(label => {
    const length = Array.from(label).length
    return length >= 1 && length <= 63
      && /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label)
  })
}

function maskEmailForDisplay(email: string): string {
  const at = email.lastIndexOf('@')
  const local = Array.from(email.slice(0, at))
  const visible = local.length >= 6 ? local.slice(0, 3).join('')
    : local.length >= 2 ? local[0]
      : ''
  return `${visible}****@${email.slice(at + 1)}`
}
