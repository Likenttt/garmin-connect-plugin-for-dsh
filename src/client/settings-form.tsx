import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactElement } from 'react'
import type { ConfigForm } from './harness-config-form'

type GarminRegion = 'cn' | 'global'
type GarminSettingsValue = Record<string, unknown>

const panelStyle = {
  border: '1px solid var(--dsw-alias-border-default, #e2e8f0)',
  borderRadius: 16,
  maxWidth: 640,
  padding: 20,
  margin: '24px 0',
} as const

const fieldStyle = {
  boxSizing: 'border-box',
  width: '100%',
  marginTop: 6,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-default, #cbd5e1)',
  borderRadius: 8,
  background: 'var(--dsw-alias-surface-primary, #fff)',
  color: 'var(--dsw-alias-label-primary, #111827)',
  font: 'inherit',
} as const

/** A local-only editor for the single account the Garmin tools currently use. */
export function GarminSettingsForm({
  form,
}: {
  form: ConfigForm<GarminSettingsValue>
}): ReactElement {
  const subscribe = useCallback((notify: () => void) => form.subscribe(notify), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const currentRegion = isRegion(snapshot.value?.region)
    ? snapshot.value.region
    : 'global'
  const [region, setRegion] = useState<GarminRegion>(currentRegion)
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => setRegion(currentRegion), [currentRegion])

  const save = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving || !snapshot.writable || snapshot.status !== 'ready') return

    const normalizedEmail = email.trim()
    if (!isEmail(normalizedEmail)) {
      setError('请输入有效的 Garmin 账号邮箱。')
      setMessage('')
      return
    }

    setSaving(true)
    setError('')
    setMessage('')
    try {
      const accepted = await form.mutate([
        { op: 'set', path: ['username'], value: normalizedEmail },
        { op: 'set', path: ['region'], value: region },
      ], snapshot.revision)
      if (!accepted) {
        setError('配置未保存，请刷新页面后重试。')
        return
      }
      setEmail('')
      setMessage('配置已保存，插件正在重新加载。随后点击对应区域的登录按钮。')
    } catch {
      setError('配置暂时无法保存，请重试。')
    } finally {
      setSaving(false)
    }
  }, [email, form, region, saving, snapshot.revision, snapshot.status, snapshot.writable])

  return (
    <section aria-label="Garmin 账号配置" style={panelStyle}>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Garmin 账号配置</h2>
      <p style={{ color: 'var(--dsw-alias-label-secondary, #475569)', margin: '0 0 18px' }}>
        插件安装时可以不填邮箱。在这里选择账号区域并保存邮箱后，再点击对应区域登录。
        当前工具一次使用一个区域的账号；切换区域时，请重新填写该区域的邮箱。
      </p>
      {snapshot.status === 'loading' && <p>正在读取配置…</p>}
      {snapshot.status === 'unavailable' && (
        <p role="status">只能在本机 Harness 中修改插件配置。</p>
      )}
      {snapshot.status === 'ready' && (
        <form onSubmit={event => void save(event)}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 14 }}>
            账号区域
            <select
              value={region}
              onChange={event => {
                setRegion(event.target.value as GarminRegion)
                setMessage('')
              }}
              style={fieldStyle}
            >
              <option value="cn">中国区（garmin.cn）</option>
              <option value="global">国际区（garmin.com）</option>
            </select>
          </label>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 16 }}>
            Garmin 账号邮箱
            <input
              autoComplete="email"
              maxLength={320}
              onChange={event => {
                setEmail(event.target.value)
                setMessage('')
              }}
              placeholder="name@example.com"
              required
              style={fieldStyle}
              type="email"
              value={email}
            />
          </label>
          <p style={{ color: 'var(--dsw-alias-label-secondary, #475569)', fontSize: 13, margin: '0 0 16px' }}>
            已保存的邮箱不会回填到输入框。密码和验证码仍只在 Garmin 官方登录页面输入。
          </p>
          <button
            disabled={!snapshot.writable || saving}
            style={{
              background: '#111827',
              border: 0,
              borderRadius: 8,
              color: '#fff',
              cursor: saving ? 'wait' : 'pointer',
              font: 'inherit',
              padding: '10px 18px',
            }}
            type="submit"
          >
            {saving ? '正在保存…' : '保存账号配置'}
          </button>
          {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
          {message && <p role="status" style={{ color: '#087443' }}>{message}</p>}
        </form>
      )}
    </section>
  )
}

function isRegion(value: unknown): value is GarminRegion {
  return value === 'cn' || value === 'global'
}

function isEmail(value: string): boolean {
  return value.length > 0
    && value.length <= 320
    && !/[\u0000-\u001f\u007f-\u009f\s]/.test(value)
    && /^[^@]+@[^@]+\.[^@]+$/.test(value)
}
