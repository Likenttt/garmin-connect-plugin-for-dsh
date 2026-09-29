import {
  isGarminAuthenticationRequiredReason,
  type GarminAuthenticationRequirement as GarminAuthenticationRequirementWire,
} from './auth-requirement'

export type { GarminAuthenticationRequiredReason } from './auth-requirement'

export const GARMIN_AUTH_PUBLIC_STATUSES = [
  'in_progress',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const

export type GarminAuthPublicStatus = typeof GARMIN_AUTH_PUBLIC_STATUSES[number]
export type GarminAuthClientErrorCode =
  | 'unavailable'
  | 'not_local'
  | 'configuration'
  | 'region_mismatch'
  | 'stale_config'
  | 'busy'

export type GarminAuthenticatedAccount = {
  email: string
  region: 'cn' | 'global'
}

export type GarminAuthRegion = GarminAuthenticatedAccount['region']

export type GarminAuthAccountSummary = {
  accountId: string
  slot: number
  region: GarminAuthRegion
  alias?: string
  maskedEmail?: string
  configured: true
  authenticated: boolean
}

export type GarminAuthAccountsResult = {
  success: true
  accounts: GarminAuthAccountSummary[]
} | {
  success: false
  code: GarminAuthClientErrorCode
}

export type GarminAuthenticationRequirement = {
  authenticationRequired: true
} & GarminAuthenticationRequirementWire

export type GarminAuthAccountResult = {
  success: true
  accountId: string
  slot: number
  configured: false
  authenticated: false
  region: GarminAuthRegion
} | {
  success: true
  accountId: string
  slot: number
  configured: true
  authenticated: false
  region: GarminAuthRegion
  alias?: string
} | ({
  success: true
  accountId: string
  slot: number
  configured: true
  authenticated: false
  alias?: string
} & GarminAuthenticationRequirement) | ({
  success: true
  accountId: string
  slot: number
  configured: true
  authenticated: true
  alias?: string
} & GarminAuthenticatedAccount) | {
  success: true
  configured: false
  authenticated: false
  region: GarminAuthRegion
} | {
  success: true
  configured: true
  authenticated: false
  region: GarminAuthRegion
  alias?: string
} | ({
  success: true
  configured: true
  authenticated: false
  alias?: string
} & GarminAuthenticationRequirement) | ({
  success: true
  configured: true
  authenticated: true
  alias?: string
} & GarminAuthenticatedAccount) | {
  success: true
  authenticated: false
} | ({
  success: true
  authenticated: false
} & GarminAuthenticationRequirement) | ({
  success: true
  authenticated: true
} & GarminAuthenticatedAccount) | {
  success: false
  code: GarminAuthClientErrorCode
}

export type GarminAuthBeginResult = {
  success: true
  flowId: string
  bridgeUrl: string
  expiresAt: number
} | {
  success: false
  code: GarminAuthClientErrorCode
}

export type GarminAuthStatusResult = {
  success: true
  status: GarminAuthPublicStatus
} | {
  success: false
  code: GarminAuthClientErrorCode
}

export type GarminAuthCancelResult = {
  success: true
} | {
  success: false
  code: GarminAuthClientErrorCode
}

/** The account picker receives public metadata and an optional masked email. */
export function parseGarminAuthAccountsRpcResult(value: unknown): GarminAuthAccountsResult {
  if (!isExactRecord(value, ['ok', 'value']) || value.ok !== true) {
    return unavailable()
  }
  const business = value.value
  if (isBusinessFailure(business)) return business
  if (!isExactRecord(business, ['success', 'accounts'])
    || business.success !== true
    || !Array.isArray(business.accounts)
    || business.accounts.length > 5) return unavailable()

  const seenIds = new Set<string>()
  const seenSlots = new Set<number>()
  const accounts: GarminAuthAccountSummary[] = []
  for (const raw of business.accounts) {
    if (!isAccountSummaryRecord(raw, [
      'accountId', 'slot', 'region', 'configured', 'authenticated',
    ])
      || !isAccountId(raw.accountId)
      || !isSlot(raw.slot)
      || !isRegion(raw.region)
      || raw.configured !== true
      || typeof raw.authenticated !== 'boolean'
      || seenIds.has(raw.accountId)
      || seenSlots.has(raw.slot)) return unavailable()
    seenIds.add(raw.accountId)
    seenSlots.add(raw.slot)
    accounts.push({
      accountId: raw.accountId,
      slot: raw.slot,
      region: raw.region,
      configured: true,
      authenticated: raw.authenticated,
      ...(typeof raw.alias === 'string' ? { alias: raw.alias } : {}),
      ...(typeof raw.maskedEmail === 'string' ? { maskedEmail: raw.maskedEmail } : {}),
    })
  }
  return { success: true, accounts }
}

export function parseGarminAuthAccountRpcResult(value: unknown): GarminAuthAccountResult {
  if (!isExactRecord(value, ['ok', 'value']) || value.ok !== true) {
    return unavailable()
  }
  const business = value.value
  if (isBusinessFailure(business)) return business
  if (
    isExactRecord(business, [
      'success', 'accountId', 'slot', 'configured', 'authenticated', 'region',
    ])
    && business.success === true
    && isAccountId(business.accountId)
    && isSlot(business.slot)
    && business.configured === false
    && business.authenticated === false
    && isRegion(business.region)
  ) {
    return {
      success: true,
      accountId: business.accountId,
      slot: business.slot,
      configured: false,
      authenticated: false,
      region: business.region,
    }
  }
  if (
    isCurrentAccountRecord(business, [
      'success', 'accountId', 'slot', 'configured', 'authenticated', 'region',
      'authenticationRequired', 'reason', 'revision',
    ])
    && business.success === true
    && isAccountId(business.accountId)
    && isSlot(business.slot)
    && business.configured === true
    && business.authenticated === false
    && business.authenticationRequired === true
    && isGarminAuthenticationRequiredReason(business.reason)
    && isRegion(business.region)
    && Number.isSafeInteger(business.revision)
    && (business.revision as number) >= 1
  ) {
    return {
      success: true,
      accountId: business.accountId,
      slot: business.slot,
      configured: true,
      authenticated: false,
      region: business.region,
      ...(typeof business.alias === 'string' ? { alias: business.alias } : {}),
      authenticationRequired: true,
      reason: business.reason,
      revision: business.revision as number,
    }
  }
  if (
    isCurrentAccountRecord(business, [
      'success', 'accountId', 'slot', 'configured', 'authenticated', 'region',
    ])
    && business.success === true
    && isAccountId(business.accountId)
    && isSlot(business.slot)
    && business.configured === true
    && business.authenticated === false
    && isRegion(business.region)
  ) {
    return {
      success: true,
      accountId: business.accountId,
      slot: business.slot,
      configured: true,
      authenticated: false,
      region: business.region,
      ...(typeof business.alias === 'string' ? { alias: business.alias } : {}),
    }
  }
  if (
    isCurrentAccountRecord(business, [
      'success', 'accountId', 'slot', 'configured', 'authenticated', 'region', 'email',
    ])
    && business.success === true
    && isAccountId(business.accountId)
    && isSlot(business.slot)
    && business.configured === true
    && business.authenticated === true
    && isRegion(business.region)
    && isSafeEmail(business.email)
  ) {
    return {
      success: true,
      accountId: business.accountId,
      slot: business.slot,
      configured: true,
      authenticated: true,
      region: business.region,
      email: business.email,
      ...(typeof business.alias === 'string' ? { alias: business.alias } : {}),
    }
  }
  if (
    isExactRecord(business, ['success', 'configured', 'authenticated', 'region'])
    && business.success === true
    && business.configured === false
    && business.authenticated === false
    && isRegion(business.region)
  ) {
    return {
      success: true,
      configured: false,
      authenticated: false,
      region: business.region,
    }
  }
  if (
    isCurrentAccountRecord(business, [
      'success', 'configured', 'authenticated', 'region',
      'authenticationRequired', 'reason', 'revision',
    ])
    && business.success === true
    && business.configured === true
    && business.authenticated === false
    && business.authenticationRequired === true
    && isGarminAuthenticationRequiredReason(business.reason)
    && isRegion(business.region)
    && Number.isSafeInteger(business.revision)
    && (business.revision as number) >= 1
  ) {
    return {
      success: true,
      configured: true,
      authenticated: false,
      region: business.region,
      ...(typeof business.alias === 'string' ? { alias: business.alias } : {}),
      authenticationRequired: true,
      reason: business.reason,
      revision: business.revision as number,
    }
  }
  if (
    isCurrentAccountRecord(business, [
      'success', 'configured', 'authenticated', 'region',
    ])
    && business.success === true
    && business.configured === true
    && business.authenticated === false
    && isRegion(business.region)
  ) {
    return {
      success: true,
      configured: true,
      authenticated: false,
      region: business.region,
      ...(typeof business.alias === 'string' ? { alias: business.alias } : {}),
    }
  }
  if (
    isCurrentAccountRecord(business, [
      'success', 'configured', 'authenticated', 'region', 'email',
    ])
    && business.success === true
    && business.configured === true
    && business.authenticated === true
    && isRegion(business.region)
    && isSafeEmail(business.email)
  ) {
    return {
      success: true,
      configured: true,
      authenticated: true,
      region: business.region,
      email: business.email,
      ...(typeof business.alias === 'string' ? { alias: business.alias } : {}),
    }
  }
  if (
    isExactRecord(business, [
      'success',
      'authenticated',
      'authenticationRequired',
      'reason',
      'region',
      'revision',
    ])
    && business.success === true
    && business.authenticated === false
    && business.authenticationRequired === true
    && isGarminAuthenticationRequiredReason(business.reason)
    && (business.region === 'cn' || business.region === 'global')
    && Number.isSafeInteger(business.revision)
    && (business.revision as number) >= 1
  ) {
    return {
      success: true,
      authenticated: false,
      authenticationRequired: true,
      reason: business.reason,
      region: business.region,
      revision: business.revision as number,
    }
  }
  if (
    isExactRecord(business, ['success', 'authenticated'])
    && business.success === true
    && business.authenticated === false
  ) {
    return { success: true, authenticated: false }
  }
  if (
    !isExactRecord(business, [
      'success',
      'authenticated',
      'email',
      'region',
    ])
    || business.success !== true
    || business.authenticated !== true
    || !isSafeEmail(business.email)
    || (business.region !== 'cn' && business.region !== 'global')
  ) {
    return unavailable()
  }
  return {
    success: true,
    authenticated: true,
    email: business.email,
    region: business.region,
  }
}

function isCurrentAccountRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isExactRecord(value, expectedKeys)
    && !isExactRecord(value, [...expectedKeys, 'alias'])) return false
  return !Object.hasOwn(value, 'alias') || isSafeAlias(value.alias)
}

function isAccountSummaryRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  const hasAlias = isExactRecord(value, [...expectedKeys, 'alias'])
    || isExactRecord(value, [...expectedKeys, 'alias', 'maskedEmail'])
  const hasMask = isExactRecord(value, [...expectedKeys, 'maskedEmail'])
    || isExactRecord(value, [...expectedKeys, 'alias', 'maskedEmail'])
  if (!isExactRecord(value, expectedKeys) && !hasAlias && !hasMask) return false
  return (!hasAlias || isSafeAlias(value.alias))
    && (!hasMask || isSafeMaskedEmail(value.maskedEmail))
}

/** A display-only hint, never an address accepted by a configuration write. */
function isSafeMaskedEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 324 || value !== value.trim()) return false
  const marker = '****@'
  const markerAt = value.indexOf(marker)
  if (markerAt < 0 || value.lastIndexOf(marker) !== markerAt) return false
  const prefix = value.slice(0, markerAt)
  const domain = value.slice(markerAt + marker.length)
  const prefixLength = Array.from(prefix).length
  return (prefixLength === 0 || prefixLength === 1 || prefixLength === 3)
    && !/[@*\s\u0000-\u001f\u007f-\u009f]/u.test(prefix)
    && domain.length > 0
    && domain.includes('.')
    && !/[@*\s\u0000-\u001f\u007f-\u009f]/u.test(domain)
}

function isRegion(value: unknown): value is GarminAuthRegion {
  return value === 'cn' || value === 'global'
}

function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value)
}

function isSlot(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 5
}

function isSafeAlias(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

export function parseGarminAuthBeginRpcResult(value: unknown): GarminAuthBeginResult {
  if (!isExactRecord(value, ['ok', 'value']) || value.ok !== true) {
    return unavailable()
  }
  const business = value.value
  if (isBusinessFailure(business)) return business
  if (
    !isExactRecord(business, [
      'success',
      'flowId',
      'bridgeUrl',
      'expiresAt',
    ])
    || business.success !== true
    || !isFlowId(business.flowId)
    || !isBridgeUrl(business.bridgeUrl, business.flowId)
    || !Number.isSafeInteger(business.expiresAt)
    || (business.expiresAt as number) <= 0
  ) {
    return unavailable()
  }
  return {
    success: true,
    flowId: business.flowId as string,
    bridgeUrl: business.bridgeUrl as string,
    expiresAt: business.expiresAt as number,
  }
}

export function parseGarminAuthStatusRpcResult(value: unknown): GarminAuthStatusResult {
  if (!isExactRecord(value, ['ok', 'value']) || value.ok !== true) {
    return unavailable()
  }
  const business = value.value
  if (isBusinessFailure(business)) return business
  if (
    !isExactRecord(business, ['success', 'status'])
    || business.success !== true
    || !isPublicStatus(business.status)
  ) {
    return unavailable()
  }
  return { success: true, status: business.status }
}

export function parseGarminAuthCancelRpcResult(value: unknown): GarminAuthCancelResult {
  if (!isExactRecord(value, ['ok', 'value']) || value.ok !== true) {
    return unavailable()
  }
  const business = value.value
  if (isBusinessFailure(business)) return business
  if (
    !isExactRecord(business, ['success'])
    || business.success !== true
  ) {
    return unavailable()
  }
  return { success: true }
}

function isBusinessFailure(value: unknown): value is {
  success: false
  code: GarminAuthClientErrorCode
} {
  return isExactRecord(value, ['success', 'code'])
    && value.success === false
    && isClientErrorCode(value.code)
}

function isClientErrorCode(value: unknown): value is GarminAuthClientErrorCode {
  return value === 'unavailable'
    || value === 'not_local'
    || value === 'configuration'
    || value === 'region_mismatch'
    || value === 'stale_config'
    || value === 'busy'
}

function isPublicStatus(value: unknown): value is GarminAuthPublicStatus {
  return typeof value === 'string'
    && (GARMIN_AUTH_PUBLIC_STATUSES as readonly string[]).includes(value)
}

function isSafeEmail(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 320
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function isFlowId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isBridgeUrl(value: unknown, flowId: string): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'http:'
    && parsed.hostname === '127.0.0.1'
    && parsed.port !== ''
    && parsed.username === ''
    && parsed.password === ''
    && parsed.pathname === `/garmin-auth/bridge/${flowId}`
    && parsed.search === ''
    && parsed.hash === ''
    && parsed.toString() === value
}

function unavailable(): { success: false; code: 'unavailable' } {
  return { success: false, code: 'unavailable' }
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Object.keys(value).sort()
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === [...expectedKeys].sort()[index])
}
