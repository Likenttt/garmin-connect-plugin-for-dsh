import type { ReactElement } from 'react'
import type {
  GarminAuthBeginResult,
  GarminAuthClientErrorCode,
  GarminAuthPublicStatus,
} from './protocol'
import {
  CLIENT_STYLES,
  backdropStyle,
  bodyStyle,
  brandMarkStyle,
  closeStyle,
  dialogStyle,
  errorIconStyle,
  frameDomainStyle,
  frameShellStyle,
  frameToolbarStyle,
  headerActionsStyle,
  headerIdentityStyle,
  headerStyle,
  iframeStyle,
  officialBadgeStyle,
  officialDotStyle,
  regionBadgeStyle,
  securityBadgeStyle,
  spinnerStyle,
  statusHintStyle,
  statusIconStyle,
  statusStyle,
  statusTextStyle,
  subtitleStyle,
  titleRowStyle,
  titleStyle,
} from './styles'

export type GarminLoginRegion = 'cn' | 'global'

const REGION_DETAILS: Record<GarminLoginRegion, {
  domain: string
  label: string
}> = {
  cn: {
    domain: 'garmin.cn',
    label: '中国区',
  },
  global: {
    domain: 'garmin.com',
    label: '国际区',
  },
}

export interface GarminAuthViewProps {
  begin?: GarminAuthBeginResult
  busy: boolean
  isLoopback: boolean
  onClose(): void
  open: boolean
  selectedRegion?: GarminLoginRegion
  showFrame: boolean
  status?: GarminAuthPublicStatus
}

export function GarminAuthView({
  begin,
  busy,
  isLoopback,
  onClose,
  open,
  selectedRegion,
  showFrame,
  status,
}: GarminAuthViewProps): ReactElement {
  const selected = selectedRegion ? REGION_DETAILS[selectedRegion] : undefined

  return (
    <div className="gca-launcher">
      <style>{CLIENT_STYLES}</style>
      {isLoopback && open && (
        <div className="gca-backdrop" role="presentation" style={backdropStyle} onMouseDown={event => {
          if (event.currentTarget === event.target) onClose()
        }}>
          <section
            aria-label={`Garmin Connect ${selected?.label ?? ''}登录`}
            aria-modal="true"
            className="gca-dialog"
            role="dialog"
            style={dialogStyle}
          >
            <header style={headerStyle}>
              <div style={headerIdentityStyle}>
                <div aria-hidden="true" style={brandMarkStyle}>
                  <GarminMark />
                </div>
                <div>
                  <div style={titleRowStyle}>
                    <strong style={titleStyle}>Garmin Connect</strong>
                    {selected && <span style={regionBadgeStyle}>{selected.label}</span>}
                  </div>
                  <div style={subtitleStyle}>
                    在 Garmin 官方页面完成登录与两步验证
                  </div>
                </div>
              </div>
              <div style={headerActionsStyle}>
                <span className="gca-security-badge" style={securityBadgeStyle}>
                  <LockIcon /> 凭据不会进入对话
                </span>
                <button
                  aria-label="关闭"
                  className="gca-close"
                  onClick={onClose}
                  style={closeStyle}
                  title="关闭登录"
                >
                  <CloseIcon />
                </button>
              </div>
            </header>
            <div style={bodyStyle}>
              {busy && (
                <Status
                  text={`正在连接 Garmin ${selected?.label ?? ''}…`}
                  variant="busy"
                />
              )}
              {begin?.success === false && (
                <ErrorStatus
                  code={begin.code}
                  selectedRegion={selectedRegion}
                />
              )}
              {showFrame && begin?.success === true && (
                <div style={frameShellStyle}>
                  <div style={frameToolbarStyle}>
                    <span style={officialDotStyle} />
                    <span style={frameDomainStyle}>{selected?.domain}</span>
                    <span style={officialBadgeStyle}>Garmin 官方页面</span>
                  </div>
                  <iframe
                    referrerPolicy="no-referrer"
                    sandbox="allow-forms allow-same-origin allow-scripts allow-storage-access-by-user-activation"
                    src={begin.bridgeUrl}
                    style={iframeStyle}
                    title={`Garmin ${selected?.label ?? ''}安全登录`}
                  />
                </div>
              )}
              {status === 'succeeded' && (
                <Status text="登录成功，会话已安全保存到本机。" variant="success" />
              )}
              {status === 'failed' && (
                <Status text="Garmin 登录失败，请在账号卡片中重试。" variant="error" />
              )}
              {status === 'cancelled' && <Status text="登录已取消。" />}
              {status === 'expired' && (
                <Status text="登录页面已过期，请在账号卡片中重试。" variant="error" />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function ErrorStatus({
  code,
  selectedRegion,
}: {
  code: GarminAuthClientErrorCode
  selectedRegion?: GarminLoginRegion
}): ReactElement {
  const selectedLabel = selectedRegion
    ? REGION_DETAILS[selectedRegion].label
    : '区域'
  const message = code === 'not_local'
    ? '此功能只能在本机 DSH 页面使用。'
    : code === 'region_mismatch'
      ? `请先在设置页的${selectedLabel}账号卡片中保存账号，然后重试。`
      : code === 'stale_config'
        ? '账号配置尚未生效。请关闭此页面，等待几秒后在账号卡片中重试。'
      : code === 'configuration'
        ? `请先在设置页的${selectedLabel}账号卡片中保存 Garmin 账号邮箱。`
        : code === 'busy'
          ? '已有一个 Garmin 登录正在进行。'
          : '暂时无法启动 Garmin 登录。'
  return (
    <div style={statusStyle}>
      <div aria-hidden="true" style={errorIconStyle}>!</div>
      <p>{message}</p>
      <p>关闭后可在对应账号卡片中重试。</p>
    </div>
  )
}

function Status({
  text,
  variant = 'info',
}: {
  text: string
  variant?: 'busy' | 'error' | 'info' | 'success'
}): ReactElement {
  const color = variant === 'success'
    ? 'var(--dsw-alias-state-success-primary, #087443)'
    : variant === 'error'
      ? 'var(--dsw-alias-state-error-primary, #b42318)'
      : 'var(--dsw-alias-label-primary, #334155)'
  return (
    <div style={{ ...statusStyle, color }}>
      {variant === 'busy'
        ? <span aria-hidden="true" className="gca-spinner" style={spinnerStyle} />
        : (
          <div
            aria-hidden="true"
            style={{
              ...statusIconStyle,
              background: variant === 'success'
                ? '#e8f8f0'
                : variant === 'error'
                  ? '#fef0ef'
                  : '#eef4fb',
              color,
            }}
          >
            {variant === 'success' ? '✓' : variant === 'error' ? '!' : 'i'}
          </div>
        )}
      <strong style={statusTextStyle}>{text}</strong>
      <span style={statusHintStyle}>你可以随时关闭此窗口，凭据不会保存到 DSH 页面。</span>
    </div>
  )
}

function GarminMark(): ReactElement {
  return (
    <svg aria-hidden="true" height="24" viewBox="0 0 32 24" width="32">
      <path d="M16 3 29 20H3L16 3Z" fill="currentColor" />
    </svg>
  )
}

function LockIcon(): ReactElement {
  return (
    <svg aria-hidden="true" height="13" viewBox="0 0 24 24" width="13">
      <path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  )
}

function CloseIcon(): ReactElement {
  return (
    <svg aria-hidden="true" height="20" viewBox="0 0 24 24" width="20">
      <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  )
}
