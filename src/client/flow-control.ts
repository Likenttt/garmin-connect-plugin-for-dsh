import {
  parseGarminAuthBeginRpcResult,
  parseGarminAuthCancelRpcResult,
  parseGarminAuthStatusRpcResult,
  type GarminAuthBeginResult,
  type GarminAuthRegion,
} from './protocol'

const API_CHANNEL = '/api'
const LEGACY_CHANNEL = '/garmin-auth'
const CONFIG_RETRY_MS = 500
const CONFIG_WAIT_MS = 10_000

type GarminAuthEndpoint = 'account' | 'begin' | 'status' | 'cancel'
type GarminAuthChannel = typeof API_CHANNEL | typeof LEGACY_CHANNEL

interface RpcCaller {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>
}

const preferredChannel = new WeakMap<RpcCaller, GarminAuthChannel>()

/**
 * Current Hosts expose exact Garmin routes under /api. Older Hosts expose the
 * dedicated /garmin-auth channel. A 404 means the selected route is absent;
 * other transport and business failures must not replay a stateful call.
 */
export async function callGarminAuthRpc(
  rpc: RpcCaller,
  endpoint: GarminAuthEndpoint,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const channel = preferredChannel.get(rpc) ?? API_CHANNEL
  try {
    const result = await callChannel(rpc, channel, endpoint, payload, signal)
    preferredChannel.set(rpc, channel)
    return result
  } catch (error) {
    if (signal?.aborted || !isMissingRoute(error, channel, endpoint)) throw error
    const fallback = channel === API_CHANNEL ? LEGACY_CHANNEL : API_CHANNEL
    const result = await callChannel(rpc, fallback, endpoint, payload, signal)
    preferredChannel.set(rpc, fallback)
    return result
  }
}

function callChannel(
  rpc: RpcCaller,
  channel: GarminAuthChannel,
  endpoint: GarminAuthEndpoint,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const method = channel === API_CHANNEL ? `garmin-auth/${endpoint}` : endpoint
  return rpc.call(channel, method, payload, signal)
}

function isMissingRoute(
  error: unknown,
  channel: GarminAuthChannel,
  endpoint: GarminAuthEndpoint,
): boolean {
  if (!(error instanceof Error)) return false
  const method = channel === API_CHANNEL ? `garmin-auth/${endpoint}` : endpoint
  return error.message === `transport failure for ${channel}/${method}: HTTP 404`
}

/** Wait for the Host's volatile restart before opening a flow for a newly saved account. */
export async function beginGarminAuthAfterConfigSave(
  rpc: RpcCaller,
  payload: { accountId: string; expectedRegion: GarminAuthRegion; expectedRevision: string },
  signal: AbortSignal,
): Promise<GarminAuthBeginResult> {
  const deadline = Date.now() + CONFIG_WAIT_MS
  for (;;) {
    let result: GarminAuthBeginResult
    try {
      result = parseGarminAuthBeginRpcResult(
        await callGarminAuthRpc(rpc, 'begin', payload, signal),
      )
    } catch (error) {
      // During a volatile restart both Host routes can briefly be absent.
      // Never retry another transport failure: the begin may have reached Host.
      if (signal.aborted || !isMissingBeginRoute(error)) throw error
      if (Date.now() >= deadline || !await waitForConfigRetry(signal)) {
        return { success: false, code: 'stale_config' }
      }
      continue
    }
    if (result.success || result.code !== 'stale_config' || Date.now() >= deadline) {
      return result
    }
    if (!await waitForConfigRetry(signal)) return result
  }
}

function isMissingBeginRoute(error: unknown): boolean {
  return isMissingRoute(error, API_CHANNEL, 'begin')
    || isMissingRoute(error, LEGACY_CHANNEL, 'begin')
}

function waitForConfigRetry(signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, CONFIG_RETRY_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/**
 * Release a flow handle only after the Host confirms cancellation or a
 * terminal status. An uncertain transport result deliberately keeps the
 * handle so a retry cannot accidentally start a second flow.
 */
export async function releaseGarminAuthFlow(
  rpc: RpcCaller,
  flowId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const cancelled = parseGarminAuthCancelRpcResult(
      await callGarminAuthRpc(rpc, 'cancel', { flowId }, signal),
    )
    if (cancelled.success) return true
  } catch {
    // Cancellation may have reached the Host. Confirm through coarse status.
  }

  try {
    const status = parseGarminAuthStatusRpcResult(
      await callGarminAuthRpc(rpc, 'status', { flowId }, signal),
    )
    return status.success && status.status !== 'in_progress'
  } catch {
    return false
  }
}

/** Preserve a late begin result unless its cleanup was positively confirmed. */
export function retainUnreleasedGarminAuthFlowId(
  currentFlowId: string | undefined,
  candidateFlowId: string,
  released: boolean,
): string | undefined {
  if (released) return currentFlowId
  return currentFlowId ?? candidateFlowId
}
