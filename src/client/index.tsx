import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConfigForms } from './harness-config-form'
import {
  parseGarminAuthAccountRpcResult,
  parseGarminAuthBeginRpcResult,
  parseGarminAuthStatusRpcResult,
  type GarminAuthenticatedAccount,
  type GarminAuthenticationRequirement,
  type GarminAuthBeginResult,
  type GarminAuthPublicStatus,
} from './protocol'
import { nextAutomaticGarminAuthentication } from './auto-auth'
import {
  callGarminAuthRpc,
  releaseGarminAuthFlow,
  retainUnreleasedGarminAuthFlowId,
} from './flow-control'
import {
  GarminAuthView,
  type GarminLoginRegion,
} from './view'
import { GarminSettingsForm } from './settings-form'

const AUTHENTICATED_ACCOUNT_REFRESH_MS = 15_000
const UNAUTHENTICATED_ACCOUNT_REFRESH_MS = 1_000
const STATUS_POLL_MS = 750

type GarminClientContext = ClientContext & {
  connection: ConnectionHandle
}

type GarminSettingsContext = GarminClientContext & { configForms: ConfigForms }
type SettingsInjector = {
  inject(
    dependencies: string[],
    callback: (ctx: GarminSettingsContext) => void,
  ): unknown
}

type ConfigSlotRegistry = {
  inject(key: 'plugins.bundle.config', callback: () => () => void): () => void
  register(
    options: { name: 'plugins.bundle.config'; key: string },
    render: () => ReactElement,
  ): () => void
}

export const inject = ['slots', 'connection']

export function apply(ctx: GarminClientContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'garmin-connect-auth',
    order: 90,
    registrant: 'dsh-plugin-garmin-connect',
  }, () => <GarminAuthOverlay ctx={ctx} />))

  // The settings service is optional on older Harness versions. Cordis runs
  // this child only once the protected config-form service is available.
  const settingsInjector = ctx as unknown as SettingsInjector
  if (typeof settingsInjector.inject === 'function') {
    settingsInjector.inject(['configForms'], settingsCtx => {
      const configSlots = settingsCtx.slots as unknown as ConfigSlotRegistry
      const refreshSettings = async () => {
        await settingsCtx.configForms.describe().load?.()
      }
      configSlots.inject('plugins.bundle.config', () => configSlots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-plugin-garmin-connect',
      }, () => <GarminSettingsForm
        form={settingsCtx.configForms.get('garmin-connect')}
        refresh={refreshSettings}
      />))
    })
  }
}

function GarminAuthOverlay({ ctx }: { ctx: GarminClientContext }): ReactElement {
  const [open, setOpen] = useState(false)
  const [begin, setBegin] = useState<GarminAuthBeginResult>()
  const [status, setStatus] = useState<GarminAuthPublicStatus>()
  const [busy, setBusy] = useState(false)
  const [selectedRegion, setSelectedRegion] = useState<GarminLoginRegion>()
  const [authenticatedAccount, setAuthenticatedAccount] =
    useState<GarminAuthenticatedAccount>()
  const [authenticationRequirement, setAuthenticationRequirement] =
    useState<GarminAuthenticationRequirement>()
  const generation = useRef(0)
  const activeFlowId = useRef<string>()
  const accountRequest = useRef<AbortController>()
  const beginRequest = useRef<AbortController>()
  const lastAutoHandledRevision = useRef<number>()

  const cancelFlow = useCallback((
    flowId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => releaseGarminAuthFlow(
    ctx.connection.rpc,
    flowId,
    signal,
  ), [ctx])

  const beginAuthentication = useCallback(async (region: GarminLoginRegion) => {
    if (!ctx.connection.isLoopback || busy || beginRequest.current) return
    if (authenticationRequirement?.region === region) {
      lastAutoHandledRevision.current = authenticationRequirement.revision
    }
    const current = ++generation.current
    const previousFlowId = activeFlowId.current
    setSelectedRegion(region)
    setOpen(true)
    setBusy(true)
    setBegin(undefined)
    setStatus(undefined)
    const controller = new AbortController()
    beginRequest.current = controller
    try {
      if (previousFlowId) {
        const released = await cancelFlow(previousFlowId, controller.signal)
        if (generation.current !== current || controller.signal.aborted) return
        if (!released) {
          setBegin({ success: false, code: 'unavailable' })
          return
        }
        if (activeFlowId.current === previousFlowId) {
          activeFlowId.current = undefined
        }
      }
      if (generation.current !== current || controller.signal.aborted) return
      const result = parseGarminAuthBeginRpcResult(
        await callGarminAuthRpc(
          ctx.connection.rpc,
          'begin',
          { region },
          controller.signal,
        ),
      )
      if (generation.current !== current || controller.signal.aborted) {
        if (result.success) {
          const released = await cancelFlow(result.flowId)
          activeFlowId.current = retainUnreleasedGarminAuthFlowId(
            activeFlowId.current,
            result.flowId,
            released,
          )
        }
        return
      }
      setBegin(result)
      if (result.success) {
        activeFlowId.current = result.flowId
        setStatus('in_progress')
      }
    } catch {
      if (generation.current === current && !controller.signal.aborted) {
        setBegin({ success: false, code: 'unavailable' })
      }
    } finally {
      if (beginRequest.current === controller) beginRequest.current = undefined
      if (generation.current === current) setBusy(false)
    }
  }, [authenticationRequirement, busy, cancelFlow, ctx])

  const closeAuthentication = useCallback(() => {
    generation.current += 1
    beginRequest.current?.abort()
    beginRequest.current = undefined
    const active = activeFlowId.current
    setOpen(false)
    setBegin(undefined)
    setStatus(undefined)
    setSelectedRegion(undefined)
    setBusy(false)
    if (active) {
      void cancelFlow(active).then(released => {
        if (released && activeFlowId.current === active) {
          activeFlowId.current = undefined
        }
      })
    }
  }, [cancelFlow])

  useEffect(() => () => {
    beginRequest.current?.abort()
    const active = activeFlowId.current
    if (active) void cancelFlow(active)
  }, [cancelFlow])

  const refreshAuthenticatedAccount = useCallback(async (): Promise<void> => {
    if (!ctx.connection.isLoopback) {
      setAuthenticatedAccount(undefined)
      return
    }
    // Account polling is deliberately serialized. A slow loopback request must
    // be allowed to finish; aborting it on the next timer tick can otherwise
    // keep the UI permanently unauthenticated.
    if (accountRequest.current) return
    const controller = new AbortController()
    accountRequest.current = controller
    try {
      const result = parseGarminAuthAccountRpcResult(
        await callGarminAuthRpc(
          ctx.connection.rpc,
          'account',
          {},
          controller.signal,
        ),
      )
      if (controller.signal.aborted) return
      if (result.success && result.authenticated) {
        setAuthenticatedAccount({ email: result.email, region: result.region })
        setAuthenticationRequirement(undefined)
      } else {
        setAuthenticatedAccount(undefined)
        setAuthenticationRequirement(
          result.success
            && !result.authenticated
            && 'authenticationRequired' in result
            ? {
                authenticationRequired: true,
                reason: result.reason,
                region: result.region,
                revision: result.revision,
              }
            : undefined,
        )
      }
    } catch {
      if (!controller.signal.aborted) {
        setAuthenticatedAccount(undefined)
        setAuthenticationRequirement(undefined)
      }
    } finally {
      if (accountRequest.current === controller) {
        accountRequest.current = undefined
      }
    }
  }, [ctx])

  useEffect(() => {
    if (!ctx.connection.isLoopback) return
    const refreshMs = authenticatedAccount
      ? AUTHENTICATED_ACCOUNT_REFRESH_MS
      : UNAUTHENTICATED_ACCOUNT_REFRESH_MS
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = async (): Promise<void> => {
      await refreshAuthenticatedAccount()
      if (!disposed) {
        timer = setTimeout(() => void scheduleRefresh(), refreshMs)
      }
    }
    const onFocus = (): void => { void refreshAuthenticatedAccount() }
    void scheduleRefresh()
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      accountRequest.current?.abort()
    }
  }, [Boolean(authenticatedAccount), ctx.connection.isLoopback, refreshAuthenticatedAccount])

  useEffect(() => {
    const decision = nextAutomaticGarminAuthentication(
      authenticationRequirement,
      {
        active: open || busy,
        isLoopback: ctx.connection.isLoopback,
        lastHandledRevision: lastAutoHandledRevision.current,
      },
    )
    if (!decision) return
    lastAutoHandledRevision.current = decision.revision
    void beginAuthentication(decision.region)
  }, [
    authenticationRequirement,
    beginAuthentication,
    busy,
    ctx.connection.isLoopback,
    open,
  ])

  useEffect(() => {
    if (status === 'succeeded') refreshAuthenticatedAccount()
  }, [refreshAuthenticatedAccount, status])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeAuthentication()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeAuthentication, open])

  useEffect(() => {
    if (!open || begin?.success !== true || isTerminal(status)) return
    const flowId = begin.flowId
    const current = generation.current
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      try {
        const result = parseGarminAuthStatusRpcResult(
          await callGarminAuthRpc(
            ctx.connection.rpc,
            'status',
            { flowId },
            controller.signal,
          ),
        )
        if (controller.signal.aborted || generation.current !== current) return
        if (!result.success) {
          setBegin(result)
          return
        }
        setStatus(result.status)
        if (isTerminal(result.status) && activeFlowId.current === flowId) {
          activeFlowId.current = undefined
        }
        if (!isTerminal(result.status)) {
          timer = setTimeout(() => void poll(), STATUS_POLL_MS)
        }
      } catch {
        if (!controller.signal.aborted && generation.current === current) {
          setBegin({ success: false, code: 'unavailable' })
        }
      }
    }

    timer = setTimeout(() => void poll(), STATUS_POLL_MS)
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [begin, ctx, open, status])

  return (
    <GarminAuthView
      authenticatedAccount={authenticatedAccount}
      begin={begin}
      busy={busy}
      isLoopback={ctx.connection.isLoopback}
      onClose={closeAuthentication}
      onLogin={beginAuthentication}
      open={open}
      selectedRegion={selectedRegion}
      showFrame={begin?.success === true && !isTerminal(status)}
      status={status}
    />
  )
}

function isTerminal(status: GarminAuthPublicStatus | undefined): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'expired'
}
