import type { ReactElement } from 'react'
import type {
  GarminAuthBeginResult,
  GarminAuthClientErrorCode,
  GarminAuthPublicStatus,
  GarminAuthenticatedAccount,
} from './protocol'
import { regionLoginSubtitle } from './presentation'
import {
  CLIENT_STYLES,
  backdropStyle,
  badgeWrapStyle,
  bodyStyle,
  brandMarkStyle,
  chinaButtonStyle,
  closeStyle,
  dialogStyle,
  disabledButtonStyle,
  errorIconStyle,
  frameDomainStyle,
  frameShellStyle,
  frameToolbarStyle,
  globalButtonStyle,
  headerActionsStyle,
  headerIdentityStyle,
  headerStyle,
  iframeStyle,
  officialBadgeStyle,
  officialDotStyle,
  regionBadgeStyle,
  regionButtonStyle,
  regionCopyStyle,
  regionDomainStyle,
  regionMarkStyle,
  regionNameStyle,
  retryButtonStyle,
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

const LOGIN_REGIONS = ['cn', 'global'] as const
const REGION_DETAILS: Record<GarminLoginRegion, {
  accountLabel: string
  domain: string
  label: string
}> = {
  cn: {
    accountLabel: '国内账号',
    domain: 'garmin.cn',
    label: '中国区',
  },
  global: {
    accountLabel: '国际账号',
    domain: 'garmin.com',
    label: '国际区',
  },
}

export interface GarminAuthViewProps {
  authenticatedAccount?: GarminAuthenticatedAccount
  begin?: GarminAuthBeginResult
  busy: boolean
  isLoopback: boolean
  onClose(): void
  onLogin(region: GarminLoginRegion): Promise<void>
  open: boolean
  selectedRegion?: GarminLoginRegion
  showFrame: boolean
  status?: GarminAuthPublicStatus
}

export function GarminAuthView({
  authenticatedAccount,
  begin,
  busy,
  isLoopback,
  onClose,
  onLogin,
  open,
  selectedRegion,
  showFrame,
  status,
}: GarminAuthViewProps): ReactElement {
  if (!isLoopback) {
    return (
      <div className="gca-launcher" style={badgeWrapStyle}>
        <style>{CLIENT_STYLES}</style>
        {LOGIN_REGIONS.map(region => renderRegionLoginButton(
          region,
          true,
        ))}
      </div>
    )
  }

  const selected = selectedRegion ? REGION_DETAILS[selectedRegion] : undefined

  return (
    <div className="gca-launcher" style={badgeWrapStyle}>
      <style>{CLIENT_STYLES}</style>
      {LOGIN_REGIONS.map(region => renderRegionLoginButton(
        region,
        false,
        value => void onLogin(value),
        authenticatedAccount,
      ))}
      {open && (
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
                  onRetry={() => onLogin(selectedRegion ?? 'global')}
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
                <Status text="Garmin 登录失败，请重新选择区域后再试。" variant="error" />
              )}
              {status === 'cancelled' && <Status text="登录已取消。" />}
              {status === 'expired' && (
                <Status text="登录页面已过期，请重新选择区域。" variant="error" />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function renderRegionLoginButton(
  region: GarminLoginRegion,
  disabled: boolean,
  onLogin?: (region: GarminLoginRegion) => void,
  authenticatedAccount?: GarminAuthenticatedAccount,
): ReactElement {
  const details = REGION_DETAILS[region]
  const isChina = region === 'cn'
  const accountMatches = authenticatedAccount?.region === region
  const subtitle = regionLoginSubtitle(
    region,
    details.domain,
    authenticatedAccount,
  )
  return (
    <button
      aria-label={`登录 Garmin ${details.label}`}
      className="gca-region-button"
      disabled={disabled}
      data-authenticated={accountMatches ? 'true' : undefined}
      key={region}
      onClick={onLogin ? () => onLogin(region) : undefined}
      style={{
        ...regionButtonStyle,
        ...(isChina ? chinaButtonStyle : globalButtonStyle),
        ...(disabled ? disabledButtonStyle : {}),
      }}
      title={disabled
        ? 'Garmin 登录仅支持本机 DSH'
        : accountMatches
          ? `已登录 Garmin ${details.label}账号：${authenticatedAccount.email}`
          : `登录 Garmin ${details.label}账号`}
    >
      {isChina ? <span style={regionMarkStyle}>CN</span> : <GlobeIcon />}
      <span className="gca-region-copy" style={regionCopyStyle}>
        <strong style={regionNameStyle}>{details.accountLabel}</strong>
        <small style={{
          ...regionDomainStyle,
          ...(!isChina ? { color: 'rgba(255,255,255,.72)' } : {}),
        }} title={accountMatches ? subtitle : undefined}>
          {subtitle}
        </small>
      </span>
    </button>
  )
}

function ErrorStatus({
  code,
  onRetry,
  selectedRegion,
}: {
  code: GarminAuthClientErrorCode
  onRetry(): Promise<void>
  selectedRegion?: GarminLoginRegion
}): ReactElement {
  const selectedLabel = selectedRegion
    ? REGION_DETAILS[selectedRegion].label
    : '区域'
  const message = code === 'not_local'
    ? '此功能只能在本机 DSH 页面使用。'
    : code === 'region_mismatch'
      ? `所选${selectedLabel}与当前插件配置的账号区域不一致。请先在插件中配置${selectedLabel}账号，然后重试。`
      : code === 'configuration'
        ? '请先在插件中配置 Garmin 账号邮箱和区域。'
        : code === 'busy'
          ? '已有一个 Garmin 登录正在进行。'
          : '暂时无法启动 Garmin 登录。'
  return (
    <div style={statusStyle}>
      <div aria-hidden="true" style={errorIconStyle}>!</div>
      <p>{message}</p>
      <button className="gca-retry" onClick={() => void onRetry()} style={retryButtonStyle}>
        重试
      </button>
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

function GlobeIcon(): ReactElement {
  return (
    <svg aria-hidden="true" height="20" viewBox="0 0 24 24" width="20">
      <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 12h17M12 3c2.2 2.45 3.3 5.45 3.3 9S14.2 18.55 12 21M12 3C9.8 5.45 8.7 8.45 8.7 12S9.8 18.55 12 21" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
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
