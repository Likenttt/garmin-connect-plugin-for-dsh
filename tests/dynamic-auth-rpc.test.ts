import type { Context } from '@deepseek-ai/cordis'
import type { AccountSource, RuntimeAccount } from '../src/account-registry'
import {
  registerEmbeddedAuthRpcAccounts,
  type EmbeddedAuthAccountOption,
  type EmbeddedAuthRpcController,
} from '../src/embedded-auth-rpc'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())) })

function account(ordinal: number, revision = ordinal.toString(16).padStart(32, '0')): RuntimeAccount {
  return {
    accountId: `acct-${ordinal}`, slot: ordinal, region: 'cn', revision,
    alias: `Member ${ordinal}`, configured: true,
    config: {
      provider: 'connect-web', username: `member-${ordinal}@example.test`, region: 'cn',
      sessionTokenFile: `/synthetic/member-${ordinal}.session.json`,
    },
    client: {
      getAuthenticatedAccount: jest.fn(() => undefined),
      getAuthenticationRequirement: jest.fn(() => undefined),
      replacePersistedSession: jest.fn(async (write: () => Promise<void>) => write()),
    },
    initialConnection: Promise.resolve(),
  } as unknown as RuntimeAccount
}

function controller(flowId: string): jest.Mocked<EmbeddedAuthRpcController> {
  const result = {
    success: true as const, flowId,
    bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${flowId}`,
    expiresAt: 1_900_000_000_000,
  }
  return {
    begin: jest.fn().mockResolvedValue(result),
    beginCdp: jest.fn().mockResolvedValue(result),
    status: jest.fn().mockReturnValue({ success: true, status: 'in_progress' }),
    cancel: jest.fn().mockReturnValue({ success: true }),
    close: jest.fn().mockResolvedValue(undefined),
  }
}

function fixture(initial: RuntimeAccount[], ready: () => Promise<void> = async () => undefined) {
  let accounts = initial
  const listeners = new Set<() => void>()
  const source: AccountSource = {
    ready: jest.fn(ready), list: () => accounts,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  let sequence = 0
  const controllers: jest.Mocked<EmbeddedAuthRpcController>[] = []
  const createController = jest.fn((_config, _account: EmbeddedAuthAccountOption) => {
    const value = controller((++sequence).toString(16).padStart(64, '0'))
    controllers.push(value)
    return value
  })
  const handle = jest.fn().mockReturnValue(jest.fn(async () => undefined))
  let cleanup: (() => Promise<void>) | undefined
  const child = {
    connection: { rpc: { handle } }, on: jest.fn(),
    effect: jest.fn((effect: () => () => Promise<void>) => { cleanup = effect() }),
  }
  const ctx = {
    logger: { info: jest.fn() },
    inject: (_dependencies: string[], callback: (value: typeof child) => void) => callback(child),
  }
  registerEmbeddedAuthRpcAccounts(ctx as unknown as Context, source, { createController })
  disposals.push(async () => { await cleanup?.() })
  const handler = handle.mock.calls[0][1] as (
    endpoint: string, payload: unknown, signal: AbortSignal,
  ) => Promise<{ ok: true; value: Record<string, unknown> }>
  const signal = new AbortController().signal
  return {
    source, createController, controllers,
    call: (endpoint: string, payload: unknown) => handler(endpoint, payload, signal),
    publish(next: RuntimeAccount[]) { accounts = next; for (const listener of listeners) listener() },
  }
}

it('lists more than five accounts without creating controllers and starts only the selected sixth account', async () => {
  const accounts = Array.from({ length: 8 }, (_, index) => account(index + 1))
  const subject = fixture(accounts)
  expect(subject.createController).not.toHaveBeenCalled()
  const listing = await subject.call('account', {})
  expect(listing.value.accounts).toHaveLength(8)
  expect(subject.createController).not.toHaveBeenCalled()

  expect(await subject.call('begin', {
    accountId: 'acct-6', expectedRegion: 'cn', expectedRevision: accounts[5].revision,
  })).toMatchObject({ value: { success: true } })
  expect(subject.createController).toHaveBeenCalledTimes(1)
  expect(subject.createController).toHaveBeenCalledWith(accounts[5].config, accounts[5])
  expect(subject.controllers[0].begin).toHaveBeenCalledTimes(1)
})

it('waits for catalog readiness before selecting a newly loaded account', async () => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const subject = fixture([account(1)], () => ready)
  let settled = false
  const pending = subject.call('begin', { accountId: 'acct-6' }).then(value => {
    settled = true
    return value
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(subject.createController).not.toHaveBeenCalled()

  subject.publish([account(1), account(6)])
  release()
  expect(await pending).toMatchObject({ value: { success: true } })
  expect(subject.createController.mock.calls[0][1].accountId).toBe('acct-6')
})

it('closes a replaced or removed controller and never routes an old flow into the replacement', async () => {
  const original = account(6)
  const subject = fixture([original])
  const started = await subject.call('begin', { accountId: original.accountId })
  const oldFlow = started.value.flowId
  const oldController = subject.controllers[0]
  const replacement = account(6, 'b'.repeat(32))
  subject.publish([replacement])

  expect(oldController.close).toHaveBeenCalledTimes(1)
  expect(await subject.call('status', { flowId: oldFlow })).toMatchObject({ value: { success: false } })
  expect(oldController.status).not.toHaveBeenCalled()
  expect(await subject.call('begin', {
    accountId: original.accountId, expectedRegion: 'cn', expectedRevision: original.revision,
  })).toMatchObject({ value: { success: false, code: 'stale_config' } })
  expect(subject.createController).toHaveBeenCalledTimes(1)

  const current = await subject.call('begin', {
    accountId: replacement.accountId, expectedRegion: 'cn', expectedRevision: replacement.revision,
  })
  expect(current).toMatchObject({ value: { success: true } })
  const nextController = subject.controllers[1]
  expect(nextController.status).not.toHaveBeenCalled()
  subject.publish([])
  expect(nextController.close).toHaveBeenCalledTimes(1)
  expect(await subject.call('status', { flowId: current.value.flowId })).toMatchObject({ value: { success: false } })
  expect(nextController.status).not.toHaveBeenCalled()
  expect(await subject.call('begin', { accountId: replacement.accountId }))
    .toMatchObject({ value: { success: false, code: 'configuration' } })
})

it('rejects a late successful begin after its account revision changed', async () => {
  const original = account(6)
  const subject = fixture([original])
  const oldController = controller('c'.repeat(64))
  let finish!: (value: Awaited<ReturnType<EmbeddedAuthRpcController['begin']>>) => void
  oldController.begin.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  subject.createController.mockReturnValueOnce(oldController)
  const pending = subject.call('begin', {
    accountId: original.accountId, expectedRegion: 'cn', expectedRevision: original.revision,
  })
  // The ready hook and handler are asynchronous, but no network or timers are involved.
  for (let attempt = 0; attempt < 8 && !oldController.begin.mock.calls.length; attempt++) await Promise.resolve()
  expect(oldController.begin).toHaveBeenCalledTimes(1)
  subject.publish([account(6, 'd'.repeat(32))])
  finish({
    success: true, flowId: 'c'.repeat(64),
    bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${'c'.repeat(64)}`,
    expiresAt: 1_900_000_000_000,
  })
  expect(await pending).toMatchObject({ value: { success: false, code: 'stale_config' } })
  expect(oldController.cancel).toHaveBeenCalledWith({ flowId: 'c'.repeat(64) })
  expect(await subject.call('status', { flowId: 'c'.repeat(64) }))
    .toMatchObject({ value: { success: false } })
})
