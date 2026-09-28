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
import type { GarminClient } from './client'
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
const ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
const ACCOUNT_REVISION_PATTERN = /^[0-9a-f]{32}$/
const MAX_CONFIGURED_ACCOUNTS = 5

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

/** One fixed-region account exposed by the Harness embedded sign-in route. */
export interface EmbeddedAuthAccountOption {
  accountId: string
  slot: number
  region: GarminRegion
  config: Config
  configured: boolean
  alias?: string
  revision?: string
  client: Pick<GarminClient,
    'getAuthenticatedAccount' | 'getAuthenticationRequirement' | 'replacePersistedSession'>
  /** The Host's background session restore, if one is in progress. */
  initialConnection?: Promise<unknown>
}

export interface EmbeddedAuthAccountsRegistrationOptions {
  /** Internal seam for testing the two independent controllers. */
  createController?: (
    config: Config,
    account: EmbeddedAuthAccountOption,
  ) => EmbeddedAuthRpcController
}

type MultiAccountResult =
  | { success: true; accounts: MultiAccountSummary[] }
  | {
    success: true
    accountId: string
    slot: number
    configured: false
    authenticated: false
    region: GarminRegion
  }
  | ({
    success: true
    accountId: string
    slot: number
    configured: true
    authenticated: false
    region: GarminRegion
    alias?: string
  } & ({ authenticationRequired?: false } | ({ authenticationRequired: true } &
    Pick<GarminAuthenticationRequirement, 'reason' | 'revision'>)))
  | {
    success: true
    accountId: string
    slot: number
    configured: true
    authenticated: true
    region: GarminRegion
    alias?: string
    email: string
  }

interface MultiAccountSummary {
  accountId: string
  slot: number
  region: GarminRegion
  alias?: string
  maskedEmail?: string
  configured: true
  authenticated: boolean
}

interface AccountRuntime {
  account: EmbeddedAuthAccountOption
  controller?: EmbeddedAuthRpcController
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

/**
 * Register one embedded sign-in transport for up to five independently named
 * accounts. Each configured account owns a distinct controller, bridge, and
 * session writer. Account IDs remain stable when region or alias changes.
 * Flow handles are routed only to the controller that issued them.
 */
export function registerEmbeddedAuthRpcAccounts(
  ctx: Context,
  accounts: readonly EmbeddedAuthAccountOption[],
  options: EmbeddedAuthAccountsRegistrationOptions = {},
): void {
  const accountById = new Map<string, EmbeddedAuthAccountOption>()
  let configuredCount = 0
  for (const account of accounts) {
    if (!account.configured && !account.accountId) continue
    if (!ACCOUNT_ID_PATTERN.test(account.accountId)
      || !Number.isInteger(account.slot)
      || account.slot < 1
      || account.slot > MAX_CONFIGURED_ACCOUNTS
      || (account.region !== 'cn' && account.region !== 'global')
      || (account.revision !== undefined
        && (typeof account.revision !== 'string'
          || !ACCOUNT_REVISION_PATTERN.test(account.revision)))
      || accountById.has(account.accountId)) {
      throw new Error('Garmin embedded auth account IDs must be valid and unique')
    }
    if (account.configured) configuredCount += 1
    accountById.set(account.accountId, account)
  }
  if (configuredCount > MAX_CONFIGURED_ACCOUNTS) {
    throw new Error('Garmin embedded auth supports at most five accounts')
  }

  ctx.inject(['connection'], (connectionCtx) => {
    const runtimes = new Map<string, AccountRuntime>()
    for (const account of accountById.values()) {
      const controller = account.configured
        ? (options.createController?.(account.config, account)
          ?? createEmbeddedAuthController({
            username: account.config.username,
            region: account.region,
            sessionTokenFile: account.config.sessionTokenFile ?? '',
          }, {
            replaceSession: writer => account.client.replacePersistedSession(writer),
          }))
        : undefined
      runtimes.set(account.accountId, { account, controller })
    }

    const connection = connectionCtx.connection as HostConnectionWithFetch
    const handler = createMultiAccountRpcHandler(runtimes)
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
          await Promise.allSettled(
            Array.from(runtimes.values(), runtime => runtime.controller?.close()),
          )
        }
      },
      RPC_EFFECT_LABEL,
    )
  })
}

function createMultiAccountRpcHandler(
  runtimes: ReadonlyMap<string, AccountRuntime>,
): ConnectionRpcHandler {
  const flowOwners = new Map<string, string>()
  const currentFlowByAccount = new Map<string, string>()
  const unavailable = () => ({
    ok: true as const,
    value: { success: false as const, code: 'unavailable' as const },
  })
  const invalid = () => ({
    ok: true as const,
    value: { success: false as const, code: 'invalid' as const },
  })

  return async (endpoint, payload, signal) => {
    try {
      if (signal.aborted) return unavailable()
      if (endpoint === 'account') {
        if (isExactEmptyObject(payload)) {
          const accounts = await Promise.all(Array.from(runtimes.values())
            .filter(runtime => runtime.account.configured)
            .map(async ({ account }): Promise<MultiAccountSummary> => {
              let authenticated = false
              try {
                await account.initialConnection
                const rawAccount = await account.client.getAuthenticatedAccount()
                authenticated = rawAccount !== undefined
                  && exactAuthenticatedAccount(rawAccount)?.region === account.region
              } catch {
                // A temporarily unavailable account must not hide other slots.
              }
              const alias = publicAlias(account.alias)
              const maskedEmail = maskedConfiguredEmail(account.config.username)
              return {
                accountId: account.accountId,
                slot: account.slot,
                region: account.region,
                ...(alias === undefined ? {} : { alias }),
                ...(maskedEmail === undefined ? {} : { maskedEmail }),
                configured: true,
                authenticated,
              }
            }))
          if (signal.aborted) return unavailable()
          return {
            ok: true,
            value: { success: true, accounts } satisfies MultiAccountResult,
          }
        }
        const accountId = exactAccountIdPayload(payload)
        if (!accountId) return unavailable()
        const runtime = runtimes.get(accountId)
        if (!runtime) {
          return { ok: true, value: { success: false, code: 'configuration' } }
        }
        const { account } = runtime
        const { region } = account
        if (!runtime?.account.configured) {
          return {
            ok: true,
            value: {
              success: true,
              accountId,
              slot: account.slot,
              configured: false,
              authenticated: false,
              region,
            } satisfies MultiAccountResult,
          }
        }

        await account.initialConnection
        if (signal.aborted) return unavailable()
        const alias = publicAlias(account.alias)
        const rawAccount = await account.client.getAuthenticatedAccount()
        if (rawAccount !== undefined) {
          const authenticated = exactAuthenticatedAccount(rawAccount)
          if (!authenticated || authenticated.region !== region) return unavailable()
          return {
            ok: true,
            value: {
              success: true,
              accountId,
              slot: account.slot,
              configured: true,
              authenticated: true,
              region,
              ...(alias === undefined ? {} : { alias }),
              email: authenticated.email,
            } satisfies MultiAccountResult,
          }
        }

        const rawRequirement = await account.client.getAuthenticationRequirement()
        if (rawRequirement !== undefined) {
          const requirement = exactAuthenticationRequirement(rawRequirement)
          if (!requirement || requirement.region !== region) return unavailable()
          return {
            ok: true,
            value: {
              success: true,
              accountId,
              slot: account.slot,
              configured: true,
              authenticated: false,
              region,
              ...(alias === undefined ? {} : { alias }),
              authenticationRequired: true,
              reason: requirement.reason,
              revision: requirement.revision,
            } satisfies MultiAccountResult,
          }
        }
        return {
          ok: true,
          value: {
            success: true,
            accountId,
            slot: account.slot,
            configured: true,
            authenticated: false,
            region,
            ...(alias === undefined ? {} : { alias }),
          } satisfies MultiAccountResult,
        }
      }
      if (endpoint === 'begin') {
        const request = exactMultiAccountBeginPayload(payload)
        if (!request) return unavailable()
        const { accountId } = request
        const runtime = runtimes.get(accountId)
        if (request.expectedRevision !== undefined
          && (!runtime?.account.configured
            || runtime.account.region !== request.expectedRegion
            || runtime.account.revision !== request.expectedRevision)) {
          return {
            ok: true,
            value: { success: false, code: 'stale_config' },
          }
        }
        const controller = runtime?.controller
        if (!controller) {
          return {
            ok: true,
            value: { success: false, code: 'configuration' },
          }
        }
        const result = await controller.begin(signal, runtime.account.region)
        if (signal.aborted) {
          if (result.success) cancelBestEffort(controller, result.flowId)
          return unavailable()
        }
        if (result.success) {
          const owner = flowOwners.get(result.flowId)
          if (owner && owner !== accountId) {
            cancelBestEffort(controller, result.flowId)
            return unavailable()
          }
          const previous = currentFlowByAccount.get(accountId)
          if (previous && previous !== result.flowId) flowOwners.delete(previous)
          currentFlowByAccount.set(accountId, result.flowId)
          flowOwners.set(result.flowId, accountId)
        }
        return { ok: true, value: result }
      }
      if (endpoint === 'status' || endpoint === 'cancel') {
        const flowId = exactFlowId(payload)
        if (!flowId) return invalid()
        const accountId = flowOwners.get(flowId)
        const controller = accountId && runtimes.get(accountId)?.controller
        if (!controller) return invalid()
        const releaseFlow = () => {
          flowOwners.delete(flowId)
          if (currentFlowByAccount.get(accountId) === flowId) {
            currentFlowByAccount.delete(accountId)
          }
        }
        if (endpoint === 'status') {
          const result = controller.status(payload)
          if (result.success && result.status !== 'in_progress') releaseFlow()
          return { ok: true, value: result }
        }
        const result = controller.cancel(payload)
        if (result.success) releaseFlow()
        return {
          ok: true,
          value: result,
        }
      }
      return unavailable()
    } catch {
      return unavailable()
    }
  }
}

function cancelBestEffort(controller: EmbeddedAuthRpcController, flowId: string): void {
  try {
    controller.cancel({ flowId })
  } catch {
    // The controller remains responsible for its private flow cleanup.
  }
}

function publicAlias(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const alias = value.trim()
  return alias.length > 0
    && alias.length <= 64
    && !/[\u0000-\u001f\u007f-\u009f]/.test(alias)
    ? alias
    : undefined
}

/** Return a display hint without putting the configured email on the wire. */
function maskedConfiguredEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 320) return undefined
  const separator = value.indexOf('@')
  if (separator < 1 || separator !== value.lastIndexOf('@')) return undefined

  const local = value.slice(0, separator)
  const domain = value.slice(separator + 1)
  if (domain.length > 255
    || /[@*\s\u0000-\u001f\u007f-\u009f]/u.test(local)) return undefined

  const labels = domain.split('.')
  if (labels.length < 2 || labels.some(label =>
    label.length > 63
      || !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label)
  )) return undefined

  const characters = Array.from(local)
  const visibleCount = characters.length >= 6 ? 3 : characters.length >= 2 ? 1 : 0
  return `${characters.slice(0, visibleCount).join('')}****@${domain}`
}

function exactFlowId(value: unknown): string | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== 'flowId') return undefined
    const flowId = (value as Record<string, unknown>).flowId
    return typeof flowId === 'string' && /^[a-f0-9]{64}$/.test(flowId)
      ? flowId
      : undefined
  } catch {
    return undefined
  }
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

type MultiAccountBeginRequest =
  | { accountId: string; expectedRevision?: undefined; expectedRegion?: undefined }
  | { accountId: string; expectedRevision: string; expectedRegion: GarminRegion }

/** The guard prevents a save from opening a bridge with the previous config. */
function exactMultiAccountBeginPayload(value: unknown): MultiAccountBeginRequest | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some(key => typeof key !== 'string')) return undefined
    const keys = (ownKeys as string[]).sort()
    const manual = keys.length === 1 && keys[0] === 'accountId'
    const revisionGuard = keys.length === 3
      && keys[0] === 'accountId' && keys[1] === 'expectedRegion'
      && keys[2] === 'expectedRevision'
    if (!manual && !revisionGuard) return undefined

    const request = value as Record<string, unknown>
    const accountId = request.accountId
    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
      return undefined
    }
    if (manual) return { accountId }
    const expectedRegion = request.expectedRegion
    if (expectedRegion !== 'cn' && expectedRegion !== 'global') return undefined
    const expectedRevision = request.expectedRevision
    if (typeof expectedRevision !== 'string'
      || !ACCOUNT_REVISION_PATTERN.test(expectedRevision)) return undefined
    return { accountId, expectedRegion, expectedRevision }
  } catch {
    return undefined
  }
}

function exactAccountIdPayload(value: unknown): string | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== 'accountId') return undefined
    const accountId = (value as Record<string, unknown>).accountId
    return typeof accountId === 'string' && ACCOUNT_ID_PATTERN.test(accountId)
      ? accountId
      : undefined
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
