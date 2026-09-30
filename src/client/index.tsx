import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConfigForms } from './harness-config-form'
import {
  parseGarminAuthBeginRpcResult,
  parseGarminAuthStatusRpcResult,
  type GarminAuthBeginResult,
  type GarminAuthPublicStatus,
} from './protocol'
import {
  callGarminAuthRpc,
  beginGarminAuthAfterConfigSave,
  releaseGarminAuthFlow,
  retainUnreleasedGarminAuthFlowId,
} from './flow-control'
import {
  GarminAuthView,
  type GarminLoginRegion,
} from './view'
import { GarminSettingsForm, type GarminLoginRequest } from './settings-form'

const STATUS_POLL_MS = 750

type OverlaySlotRegistry = {
  inject(key: 'shell.overlay', callback: () => () => void): () => void
  register(
    options: {
      name: 'shell.overlay'
      id: string
      order: number
      registrant: string
    },
    render: () => ReactElement,
  ): () => void
}

type GarminClientContext = ClientContext & {
  connection: ConnectionHandle
  slots: OverlaySlotRegistry
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

type LoginRequests = {
  subscribe(listener: (request: GarminLoginRequest) => void): () => void
  request(request: GarminLoginRequest): boolean
}

function createLoginRequests(): LoginRequests {
  const listeners = new Set<(request: GarminLoginRequest) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    request(request) {
      if (listeners.size === 0) return false
      for (const listener of listeners) listener(request)
      return true
    },
  }
}

export const inject = ['slots', 'connection']

export function apply(ctx: GarminClientContext): void {
  const loginRequests = createLoginRequests()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'garmin-connect-auth',
    order: 90,
    registrant: 'dsh-plugin-garmin-connect',
  }, () => <GarminAuthOverlay ctx={ctx} loginRequests={loginRequests} />))

  // The settings service is optional on older Harness versions. Cordis runs
  // this child only once the protected config-form service is available.
  const settingsInjector = ctx as unknown as SettingsInjector
  if (typeof settingsInjector.inject === 'function') {
    settingsInjector.inject(['configForms'], settingsCtx => {
      const configSlots = settingsCtx.slots as unknown as ConfigSlotRegistry
      const refreshSettings = async () => {
        await settingsCtx.configForms.describe().ensure()
      }
      configSlots.inject('plugins.bundle.config', () => configSlots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-plugin-garmin-connect',
      }, () => <GarminSettingsForm
        connection={settingsCtx.connection}
        form={settingsCtx.configForms.get('garmin-connect')}
        onLogin={request => loginRequests.request(request)}
        refresh={refreshSettings}
      />))
    })
  }
}

function GarminAuthOverlay({
  ctx,
  loginRequests,
}: {
  ctx: GarminClientContext
  loginRequests: LoginRequests
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [begin, setBegin] = useState<GarminAuthBeginResult>()
  const [status, setStatus] = useState<GarminAuthPublicStatus>()
  const [busy, setBusy] = useState(false)
  const [selectedRegion, setSelectedRegion] = useState<GarminLoginRegion>()
  const generation = useRef(0)
  const activeFlowId = useRef<string>()
  const beginRequest = useRef<AbortController>()

  const cancelFlow = useCallback((
    flowId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => releaseGarminAuthFlow(
    ctx.connection.rpc,
    flowId,
    signal,
  ), [ctx])

  const beginAuthentication = useCallback(async (request: GarminLoginRequest) => {
    if (!ctx.connection.isLoopback || busy || beginRequest.current) {
      request.onSettled?.(false)
      return
    }
    let ready = false
    const current = ++generation.current
    const previousFlowId = activeFlowId.current
    setSelectedRegion(request.region)
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
      if ((request.expectedRegion === undefined) !== (request.expectedRevision === undefined)) {
        setBegin({ success: false, code: 'unavailable' })
        return
      }
      const result = request.expectedRegion && request.expectedRevision
        ? await beginGarminAuthAfterConfigSave(
          ctx.connection.rpc,
          {
            accountId: request.accountId,
            expectedRegion: request.expectedRegion,
            expectedRevision: request.expectedRevision,
          },
          controller.signal,
        )
        : parseGarminAuthBeginRpcResult(
          await callGarminAuthRpc(
            ctx.connection.rpc,
            'begin',
            { accountId: request.accountId },
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
        ready = true
      }
    } catch {
      if (generation.current === current && !controller.signal.aborted) {
        setBegin({ success: false, code: 'unavailable' })
      }
    } finally {
      if (beginRequest.current === controller) beginRequest.current = undefined
      if (generation.current === current) setBusy(false)
      request.onSettled?.(ready)
    }
  }, [busy, cancelFlow, ctx])

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

  useEffect(() => loginRequests.subscribe(request => {
    void beginAuthentication(request)
  }), [beginAuthentication, loginRequests])

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
      begin={begin}
      busy={busy}
      isLoopback={ctx.connection.isLoopback}
      onClose={closeAuthentication}
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
