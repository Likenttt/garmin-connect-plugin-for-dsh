import {
  parseGarminAuthCancelRpcResult,
  parseGarminAuthStatusRpcResult,
} from './protocol'

const API_CHANNEL = '/api'
const LEGACY_CHANNEL = '/garmin-auth'

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
