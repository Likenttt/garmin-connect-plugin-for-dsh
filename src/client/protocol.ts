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
  | 'busy'

export type GarminAuthenticatedAccount = {
  email: string
  region: 'cn' | 'global'
}

export type GarminAuthenticationRequirement = {
  authenticationRequired: true
} & GarminAuthenticationRequirementWire

export type GarminAuthAccountResult = {
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

export function parseGarminAuthAccountRpcResult(value: unknown): GarminAuthAccountResult {
  if (!isExactRecord(value, ['ok', 'value']) || value.ok !== true) {
    return unavailable()
  }
  const business = value.value
  if (isBusinessFailure(business)) return business
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
