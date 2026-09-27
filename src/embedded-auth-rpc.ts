import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionRpcHandler,
  HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'
import {
  ACCOUNT_ALIAS_PATTERN,
  defaultAccountSessionPath,
} from './account-session'
import type { Config, GarminRegion } from './config'
import {
  type EmbeddedAuthBeginResult,
  type EmbeddedAuthCancelResult,
  type EmbeddedAuthStatusResult,
} from './embedded-auth-controller'
import { createEmbeddedAuthController } from './embedded-auth-runtime'
import {
  isGarminAuthenticationRequiredReason,
  type GarminAuthenticationRequirement,
  type GarminAuthenticationRequiredReason,
} from './auth-requirement'

const RPC_CHANNEL = '/garmin-auth'
const FETCH_RPC_CHANNEL = '/api/garmin-auth'
const RPC_ENDPOINTS = ['account', 'begin', 'status', 'cancel'] as const
const RPC_EFFECT_LABEL = 'garmin-connect: embedded auth rpc'

type Environment = Readonly<Record<string, string | undefined>>

type EmbeddedAuthRpcResult =
  | EmbeddedAuthAccountResult
  | EmbeddedAuthBeginResult
  | EmbeddedAuthStatusResult
  | EmbeddedAuthCancelResult

interface HostFetchRpcRoute {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

interface HostConnectionWithFetch extends HostConnectionHandle {
  fetch?: {
    register(route: HostFetchRpcRoute): () => void | Promise<void>
  }
}

export type EmbeddedAuthAccountResult = {
  success: true
  authenticated: false
  authenticationRequired: true
  reason: GarminAuthenticationRequiredReason
  region: GarminRegion
  revision: number
} | {
  success: true
  authenticated: false
} | {
  success: true
  authenticated: true
  email: string
  region: GarminRegion
} | {
  success: false
  code: 'unavailable'
}

export interface EmbeddedAuthAuthenticatedAccount {
  email: string
  region: GarminRegion
}

export type EmbeddedAuthAuthenticationRequirement =
  GarminAuthenticationRequirement

export type EmbeddedAuthAuthenticatedAccountProvider = () =>
  | EmbeddedAuthAuthenticatedAccount
  | undefined
  | Promise<EmbeddedAuthAuthenticatedAccount | undefined>

export type EmbeddedAuthAuthenticationRequirementProvider = () =>
  | EmbeddedAuthAuthenticationRequirement
  | undefined
  | Promise<EmbeddedAuthAuthenticationRequirement | undefined>

export interface EmbeddedAuthRpcController {
  begin(
    signal?: AbortSignal,
    requestedRegion?: GarminRegion,
  ): Promise<EmbeddedAuthBeginResult>
  status(payload: unknown): EmbeddedAuthStatusResult
  cancel(payload: unknown): EmbeddedAuthCancelResult
  close(): Promise<void>
}

export type EmbeddedAuthRpcControllerFactory = (
  config: Config,
) => EmbeddedAuthRpcController

export interface EmbeddedAuthRpcRegistrationOptions {
  createController?: EmbeddedAuthRpcControllerFactory
  getAuthenticatedAccount?: EmbeddedAuthAuthenticatedAccountProvider
  getAuthenticationRequirement?: EmbeddedAuthAuthenticationRequirementProvider
  replaceSession?: (writeSession: () => Promise<void>) => Promise<void>
}

/** Resolve the one session path shared by the embedded Host and Garmin client. */
export function resolveEmbeddedAuthConfig(
  config: Config,
  env: Environment = process.env,
): Config {
  const configuredPath = config.sessionTokenFile?.trim()
  if (configuredPath) return { ...config, sessionTokenFile: configuredPath }

  const account = env.GARMIN_ACCOUNT?.trim() || 'default'
  return {
    ...config,
    sessionTokenFile: ACCOUNT_ALIAS_PATTERN.test(account)
      ? defaultAccountSessionPath(account, env)
      : '',
  }
}

/**
 * Register the private Host half of embedded Garmin authentication.
 *
 * Connection is intentionally optional: older DSH hosts can still load the
 * plugin. New Hosts mount authenticated Fetch routes; older Hosts use the
 * private loopback-only RPC channel. The Host admits Fetch requests before
 * invoking these route callbacks.
 */
export function registerEmbeddedAuthRpc(
  ctx: Context,
  config: Config,
  options: EmbeddedAuthRpcRegistrationOptions | EmbeddedAuthRpcControllerFactory = {},
): void {
  const registration = typeof options === 'function'
    ? { createController: options }
    : options
  const createController = registration.createController
    ?? ((value: Config) => createEmbeddedAuthController({
      username: value.username,
      region: value.region,
      sessionTokenFile: value.sessionTokenFile ?? '',
    }, {
      replaceSession: registration.replaceSession,
    }))
  ctx.inject(['connection'], (connectionCtx) => {
    const controller = createController(config)
    const connection = connectionCtx.connection as HostConnectionWithFetch
    const handler = createRpcHandler(
      controller,
      registration.getAuthenticatedAccount,
      registration.getAuthenticationRequirement,
    )
    const fetch = connection.fetch
    const disposeRoutes = fetch?.register
      ? RPC_ENDPOINTS.map(endpoint => fetch.register({
        path: `${FETCH_RPC_CHANNEL}/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handleFetchRpc(endpoint, request, handler),
      }))
      : [connection.rpc.handle(
        RPC_CHANNEL,
        handler,
        { authority: 'loopback' },
      )]

    connectionCtx.effect(
      () => async () => {
        try {
          for (const disposeRoute of disposeRoutes.reverse()) {
            await disposeRoute()
          }
        } finally {
          await controller.close()
        }
      },
      RPC_EFFECT_LABEL,
    )
  })
}

/** Adapt Connection's authenticated exact Fetch routes to its RPC envelope. */
async function handleFetchRpc(
  endpoint: typeof RPC_ENDPOINTS[number],
  request: Request,
  handler: ConnectionRpcHandler,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return new Response('invalid request', { status: 400 })
  }
  const envelope = body as Record<string, unknown>
  if (envelope.type !== 'client-request'
    || typeof envelope.rpcId !== 'string'
    || !envelope.rpcId
    || envelope.rpcId.length > 128
    || envelope.method !== `garmin-auth/${endpoint}`
    || !Object.hasOwn(envelope, 'payload')) {
    return new Response('invalid request', { status: 400 })
  }

  const result = await handler(endpoint, envelope.payload, request.signal)
  return Response.json({
    type: 'server-response',
    rpcId: envelope.rpcId,
    result,
  })
}

function createRpcHandler(
  controller: EmbeddedAuthRpcController,
  getAuthenticatedAccount?: EmbeddedAuthAuthenticatedAccountProvider,
  getAuthenticationRequirement?: EmbeddedAuthAuthenticationRequirementProvider,
): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    const unavailable = (): { ok: true; value: EmbeddedAuthRpcResult } => ({
      ok: true,
      value: { success: false, code: 'unavailable' },
    })

    try {
      if (signal.aborted) return unavailable()
      if (endpoint === 'account') {
        if (!isExactEmptyObject(payload)) return unavailable()
        const rawAccount = await getAuthenticatedAccount?.()
        if (rawAccount === undefined) {
          const rawRequirement = await getAuthenticationRequirement?.()
          if (rawRequirement !== undefined) {
            const requirement = exactAuthenticationRequirement(rawRequirement)
            if (!requirement) return unavailable()
            return {
              ok: true,
              value: {
                success: true,
                authenticated: false,
                authenticationRequired: true,
                ...requirement,
              },
            }
          }
          return {
            ok: true,
            value: { success: true, authenticated: false },
          }
        }
        const account = exactAuthenticatedAccount(rawAccount)
        if (!account) return unavailable()
        return {
          ok: true,
          value: {
            success: true,
            authenticated: true,
            email: account.email,
            region: account.region,
          },
        }
      }
      if (endpoint === 'begin') {
        const requestedRegion = exactBeginRegion(payload)
        if (!requestedRegion) return unavailable()
        const result = await controller.begin(signal, requestedRegion)
        if (signal.aborted) {
          if (result.success) {
            try {
              controller.cancel({ flowId: result.flowId })
            } catch {
              // Cancellation is best effort at this already-aborted boundary.
            }
          }
          return unavailable()
        }
        return { ok: true, value: result }
      }
      if (endpoint === 'status') {
        return { ok: true, value: controller.status(payload) }
      }
      if (endpoint === 'cancel') {
        return { ok: true, value: controller.cancel(payload) }
      }
      return unavailable()
    } catch {
      return unavailable()
    }
  }
}

function exactBeginRegion(value: unknown): GarminRegion | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== 'region') return undefined
    const region = (value as Record<string, unknown>).region
    return region === 'cn' || region === 'global' ? region : undefined
  } catch {
    return undefined
  }
}

function isExactEmptyObject(value: unknown): boolean {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false
    }
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null)
      && Object.keys(value).length === 0
  } catch {
    return false
  }
}

function exactAuthenticatedAccount(
  value: unknown,
): EmbeddedAuthAuthenticatedAccount | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Object.keys(value).sort()
    if (keys.length !== 2 || keys[0] !== 'email' || keys[1] !== 'region') {
      return undefined
    }
    const { email, region } = value as Record<string, unknown>
    if (
      typeof email !== 'string'
      || email.length === 0
      || email.length > 320
      || email !== email.trim()
      || /[\u0000-\u001f\u007f-\u009f]/.test(email)
      || (region !== 'cn' && region !== 'global')
    ) {
      return undefined
    }
    return { email, region }
  } catch {
    return undefined
  }
}

function exactAuthenticationRequirement(
  value: unknown,
): EmbeddedAuthAuthenticationRequirement | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Object.keys(value).sort()
    if (
      keys.length !== 3
      || keys[0] !== 'reason'
      || keys[1] !== 'region'
      || keys[2] !== 'revision'
    ) {
      return undefined
    }
    const { reason, region, revision } = value as Record<string, unknown>
    if (
      !isGarminAuthenticationRequiredReason(reason)
      || (region !== 'cn' && region !== 'global')
      || !Number.isSafeInteger(revision)
      || (revision as number) < 1
    ) {
      return undefined
    }
    return { reason, region, revision: revision as number }
  } catch {
    return undefined
  }
}
