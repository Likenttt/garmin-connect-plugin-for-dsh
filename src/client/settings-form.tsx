import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FormEvent, ReactElement } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  accountRegionForProvider,
  removeAccountMutations,
  saveAccountMutations,
  type ConfigForm,
  type ConfigFormSnapshot,
  type GarminStoredAccount,
} from './harness-config-form'
import { callGarminAuthRpc, verifyGarminPersonalConnection } from './flow-control'
import {
  parseGarminAuthAccountsRpcResult,
  parseGarminAuthVerifyRpcResult,
  type GarminAuthAccountSummary,
  type GarminAuthRegion,
  type GarminAuthVerifyResult,
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
const fieldGroupStyle: CSSProperties = {
  display: 'grid',
  gridRow: 'span 3',
  gridTemplateRows: 'subgrid',
  paddingBottom: 14,
  fontWeight: 600,
}
const buttonStyle: CSSProperties = {
  border: 0,
  borderRadius: 8,
  font: 'inherit',
  padding: '10px 16px',
}

/** Secret email and API key values are never read from the configuration snapshot. */
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
        ...(summary.provider === 'personal' ? { provider: 'personal' as const } : {}),
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

  const save = async (entry: GarminStoredAccount, email: string, personalApiKey = ''): Promise<string | undefined> => {
    if (!rows || snapshot.status !== 'ready' || !snapshot.writable || pendingLoginRef.current) return undefined
    if (entry.provider === 'personal' && snapshot.value?.accountsConfigured !== true && !personalApiKey.trim()) {
      setListError('首次在设置页保存 Personal 账号时，请重新输入 API Key；全局密钥不会继承到账号槽。')
      return undefined
    }
    let revision: string
    try {
      do { revision = createAccountRevision() } while (revision === entry.revision)
    } catch {
      setListError('无法生成账号修订标识，请重试。')
      return undefined
    }
    const mutations = saveAccountMutations(rows, entry, email, revision, personalApiKey)
    if (!mutations) return undefined
    const accepted = await form.mutate(mutations, snapshot.revision)
    if (accepted) {
      setDraft(undefined)
      refreshAfterChange()
    }
    return accepted ? revision : undefined
  }

  const verify = async (entry: GarminStoredAccount, signal: AbortSignal): Promise<GarminAuthVerifyResult> => {
    if (!connection.isLoopback) return { success: false, code: 'configuration' }
    const result = entry.revision
      ? await verifyGarminPersonalConnection(connection.rpc, {
        accountId: entry.id, expectedRegion: entry.region, expectedRevision: entry.revision,
      }, signal)
      : parseGarminAuthVerifyRpcResult(await callGarminAuthRpc(connection.rpc, 'verify', { accountId: entry.id }, signal))
    if (result.success && result.accountId !== entry.id) return { success: false, code: 'unavailable' }
    await refreshAccounts()
    return result
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
        可添加最多 5 个账号。官方 Personal API 账号只需别名和 API Key，使用国际版只读接口；也可选择原有 Connect 网页会话。
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
            onVerify={verify}
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
            onVerify={verify}
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
        已保存的邮箱会显示脱敏形式；Personal API Key 不会回填，留空保存可保留原密钥。浏览器账号切换地区后需重新登录。账号 ID 可用于指定工具操作的目标账号。
      </p>
    </section>
  )
}

function AccountCard({
  entry, isDraft, isLoopback, loginPending, onCancelDraft, onDelete, onLogin, onSave, onVerify, pendingLogin, summary, writable,
}: {
  entry: GarminStoredAccount
  isDraft: boolean
  isLoopback: boolean
  loginPending: boolean
  onCancelDraft?(): void
  onDelete?(accountId: string): Promise<boolean>
  onLogin(request: GarminLoginRequest): boolean
  onSave(entry: GarminStoredAccount, email: string, personalApiKey?: string): Promise<string | undefined>
  onVerify(entry: GarminStoredAccount, signal: AbortSignal): Promise<GarminAuthVerifyResult>
  pendingLogin?: { accountId: string; maskedEmail?: string }
  summary?: GarminAuthAccountSummary
  writable: boolean
}): ReactElement {
  const [provider, setProvider] = useState<'connect-web' | 'personal'>(entry.provider ?? 'connect-web')
  const [personalApiKey, setPersonalApiKey] = useState('')
  const verification = useRef<AbortController>()
  useEffect(() => () => verification.current?.abort(), [])
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
    setProvider(entry.provider ?? 'connect-web')
  }, [entry.region, entry.alias, entry.provider])

  const personal = provider === 'personal'
  const accountRegion = accountRegionForProvider(entry, provider, region)
  const providerChanged = provider !== (entry.provider ?? 'connect-web')
  const changed = isDraft || providerChanged || accountRegion !== entry.region || alias.trim() !== entry.alias
    || email.trim() !== '' || personalApiKey.trim() !== ''
  const shouldLoginAfterSave = !personal && (isDraft || providerChanged || region !== entry.region || email.trim() !== '')
  const displayedEmail = isDraft || editingEmail
    ? email
    : (pendingLogin?.maskedEmail ?? summary?.maskedEmail
      ?? (summary?.configured ? '邮箱已配置（地址已隐藏）' : ''))
  const loginReady = !isDraft && !changed && !personal && !loginPending && isLoopback && !busy
    && summary?.configured === true && summary.region === entry.region
  const verifyReady = !isDraft && !changed && personal && !loginPending && isLoopback && !busy
    && summary?.configured === true && summary.provider === 'personal'
  const canEdit = writable && !busy && !loginPending
  const canSave = canEdit && changed && (!personal || alias.trim() !== '')

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    const normalizedEmail = email.trim()
    const normalizedAlias = alias.trim()
    if (personal && !normalizedAlias) {
      setError('请为此 Personal API 账号填写别名。')
      setMessage('')
      return
    }
    if (!personal && (((isDraft || providerChanged) && !normalizedEmail) || (normalizedEmail && !isEmail(normalizedEmail)))) {
      setError('新账号需要有效的 Garmin 邮箱；已有账号留空邮箱可保留原值。')
      setMessage('')
      return
    }
    if (personal && (isDraft || providerChanged) && !personalApiKey.trim()) {
      setError('请输入官方 Personal API Key。此接入方式不需要邮箱或密码。')
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
      const savedAccount = { ...entry, region: accountRegion, alias: normalizedAlias,
        ...(personal ? { provider: 'personal' as const } : {}) }
      if (!personal) delete savedAccount.provider
      const savedRevision = await onSave(savedAccount, personal ? '' : normalizedEmail, personalApiKey)
      if (!savedRevision) {
        setError('配置未保存，请刷新页面后重试。')
        return
      }
      setEmail('')
      setPersonalApiKey('')
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
        setMessage(personal ? '账号已保存。请点击“验证连接”检查官方 API 是否可用。' : '账号已保存，原邮箱保持不变。')
      }
    } catch {
      setError('配置暂时无法保存，请重试。')
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    if (!verifyReady) return
    const controller = new AbortController()
    verification.current = controller
    setBusy(true)
    setError('')
    setMessage('正在验证官方 Personal API…')
    try {
      const result = await onVerify(entry, controller.signal)
      if (controller.signal.aborted) return
      if (result.success) setMessage('官方 Personal API 连接验证成功。')
      else {
        setMessage('')
        setError(result.message ?? (result.code === 'stale_config'
          ? '配置仍在应用，请稍后再次验证。'
          : '连接验证失败，请检查密钥、有效期和账号可用性。'))
      }
    } catch {
      if (!controller.signal.aborted) { setMessage(''); setError('连接验证暂时无法完成，请重试。') }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
      if (verification.current === controller) verification.current = undefined
    }
  }

  const remove = async () => {
    if (isDraft) { onCancelDraft?.(); return }
    if (!onDelete || !window.confirm(
      personal ? '停用此账号？插件配置会移除该账号及已保存的 API Key。'
        : '停用此账号？插件配置会移除该账号，本机已保存的会话文件仍保留。',
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
    : summary?.authenticated ? personal ? '已连接' : '已登录'
      : summary ? personal ? '待验证' : '待登录' : '正在应用配置…'
  return (
    <section aria-label={`Garmin 账号 ${entry.id}`} style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <strong>{alias.trim() || (personal ? 'Personal API 账号' : accountRegion === 'cn' ? '中国区账号' : '国际区账号')}</strong>
        <span style={{ color: 'var(--dsw-alias-label-secondary, #475569)' }}>{status}</span>
      </div>
      <p style={{ color: 'var(--dsw-alias-label-secondary, #475569)', fontSize: 12, margin: '8px 0 16px' }}>
        账号 ID：<code style={{ userSelect: 'text' }}>{entry.id}</code>
      </p>
      <label style={{ display: 'block', fontWeight: 600, marginBottom: 18 }}>
        <span>接入方式</span>
        <select disabled={!canEdit} onChange={event => {
          setProvider(event.target.value as 'connect-web' | 'personal')
          setEmail(''); setPersonalApiKey(''); setError(''); setMessage('')
        }} style={fieldStyle} value={provider}>
          <option value="connect-web">Connect 网页会话（原有方式）</option>
          <option value="personal">{entry.provider === 'personal' && entry.region === 'cn'
            ? '官方 Personal API（大陆端点，只读）'
            : '官方 Personal API（国际版，只读）'}</option>
        </select>
      </label>
      {personal && <p role={accountRegion === 'cn' ? 'status' : undefined} style={{ color: accountRegion === 'cn' ? '#9a6700' : 'var(--dsw-alias-label-secondary, #475569)', fontSize: 13, margin: '0 0 16px' }}>
        {accountRegion === 'cn'
          ? '大陆端点 personal.connectapi.garmin.cn 暂时无法访问（实测 HTTP 526）。此账号仍保留大陆端点，请使用大陆 API Key；不会切换到国际端点。'
          : '国际端点 personal.connectapi.garmin.com · 只读。请填写国际版 Garmin Connect 生成的 API Key。'}
      </p>}
      <form onSubmit={event => void save(event)}>
        <div style={{ display: 'grid', columnGap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
          {!personal && <label style={fieldGroupStyle}>
            <span>地区</span>
            <select disabled={!canEdit} onChange={event => setRegion(event.target.value as GarminAuthRegion)} style={fieldStyle} value={region}>
              <option value="cn">中国区（garmin.cn）</option>
              <option value="global">国际区（garmin.com）</option>
            </select>
          </label>}
          <label style={fieldGroupStyle}>
            <span>{personal ? '账号别名（必填）' : '别名（可选）'}</span>
            <input disabled={!canEdit} maxLength={64} onChange={event => setAlias(event.target.value)} placeholder={personal ? '例如：我的佳明国际账号' : undefined} required={personal} style={fieldStyle} type="text" value={alias} />
            {personal && !alias.trim() && <span style={{ color: 'var(--dsw-alias-label-secondary, #475569)', fontSize: 12, fontWeight: 400, marginTop: 6 }}>请填写别名，便于 AI 选择正确账号。</span>}
          </label>
          {personal ? (
            <label style={fieldGroupStyle}>
              <span>Personal API Key</span>
              <input
                autoCapitalize="off" autoComplete="new-password" disabled={!canEdit}
                onChange={event => setPersonalApiKey(event.target.value)}
                placeholder={!isDraft && !providerChanged && summary?.provider === 'personal' && summary.configured ? '已设置（留空保留）' : '粘贴官方生成的 API Key'}
                required={isDraft || providerChanged} spellCheck={false} style={fieldStyle} type="password" value={personalApiKey}
              />
              <span style={{ color: 'var(--dsw-alias-label-secondary, #475569)', fontSize: 12, fontWeight: 400, marginTop: 6 }}>
                不需要邮箱或密码；密钥保存后不会回填。此方式仅提供官方已开放的读取功能。
              </span>
            </label>
          ) : <label style={fieldGroupStyle}>
            <span>Garmin 账号邮箱</span>
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
          </label>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
          <button disabled={!canSave} style={{ ...buttonStyle, background: canSave ? '#111827' : '#e2e8f0', color: canSave ? '#fff' : '#64748b', cursor: canSave ? 'pointer' : 'not-allowed' }} type="submit">
            {busy ? '处理中…' : personal ? '保存账号' : isDraft ? '保存并登录' : shouldLoginAfterSave ? '保存并重新登录' : '保存账号'}
          </button>
          {personal ? <button disabled={!verifyReady} onClick={() => void verify()} style={{ ...buttonStyle, background: verifyReady ? '#087cc1' : '#e2e8f0', color: verifyReady ? '#fff' : '#64748b', cursor: verifyReady ? 'pointer' : 'not-allowed' }} type="button">
            验证连接
          </button> : <button disabled={!loginReady} onClick={() => { void onLogin({ accountId: entry.id, region: entry.region }) }} style={{ ...buttonStyle, background: loginReady ? '#087cc1' : '#e2e8f0', color: loginReady ? '#fff' : '#64748b', cursor: loginReady ? 'pointer' : 'not-allowed' }} type="button">
            在 Harness 内登录
          </button>}
          <button disabled={!canEdit} onClick={() => void remove()} style={{ ...buttonStyle, background: '#fff', color: '#b42318', border: '1px solid #efc4c0' }} type="button">
            {isDraft ? '取消添加' : '停用账号'}
          </button>
        </div>
        {changed && !isDraft && <p style={{ color: '#9a6700', fontSize: 13 }}>存在未保存修改，请先保存或恢复原值。</p>}
        {!personal && !isDraft && region !== entry.region && <p style={{ color: '#9a6700', fontSize: 13 }}>切换地区后，原地区的登录会话不会沿用。</p>}
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
    const expectedKeys = ['alias', 'id', 'region', 'slot',
      ...(candidate.revision === undefined ? [] : ['revision']),
      ...(candidate.provider === undefined ? [] : ['provider']),
    ].sort()
    if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      || typeof candidate.id !== 'string'
      || !/^[a-z][a-z0-9_-]{0,31}$/.test(candidate.id)
      || (candidate.region !== 'cn' && candidate.region !== 'global')
      || (candidate.provider !== undefined && candidate.provider !== 'connect-web' && candidate.provider !== 'personal')
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
      ...(candidate.provider === 'personal' ? { provider: 'personal' as const } : {}),
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
