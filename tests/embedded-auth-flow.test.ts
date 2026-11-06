import type { GarminRegion } from '../src/config'
import {
  EmbeddedAuthFlowManager,
  GARMIN_EMBEDDED_AUTH_FLOW_REJECTED,
  type EmbeddedAuthAuthenticateInput,
} from '../src/embedded-auth-flow'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function deterministicRandom(...values: number[]) {
  const queue = [...values]
  return jest.fn((size: number) => {
    const value = queue.shift()
    if (value === undefined) throw new Error('test random queue exhausted')
    return Buffer.alloc(size, value)
  })
}

const BRIDGE_ORIGIN = 'http://127.0.0.1:43123'
const FRAME_SERVICE_URL = 'https://sso.garmin.cn/sso/embed'

function ticket(serviceTicket: string, serviceUrl = FRAME_SERVICE_URL) {
  return { serviceTicket, serviceUrl }
}

const startInput = {
  region: 'cn' as GarminRegion,
  username: 'runner@example.com',
  sessionTokenFile: '/private/account/session.json',
  bridgeOrigin: BRIDGE_ORIGIN,
}

describe('EmbeddedAuthFlowManager', () => {
  it('creates independent opaque flow and CSRF tokens with a short expiry', () => {
    const randomBytes = deterministicRandom(1, 2)
    const manager = new EmbeddedAuthFlowManager({
      authenticate: jest.fn(),
      now: () => 1_000,
      randomBytes,
      ttlMs: 5_000,
    })

    const started = manager.start(startInput)

    expect(started).toEqual({
      flowId: Buffer.alloc(32, 1).toString('hex'),
      expiresAt: 6_000,
    })
    const bootstrap = manager.bridgeBootstrap(started.flowId)
    expect(bootstrap).toEqual({
      csrf: Buffer.alloc(32, 2).toString('hex'),
      frameUrl: expect.stringContaining('https://sso.garmin.cn/sso/signin?'),
      ssoOrigin: 'https://sso.garmin.cn',
      serviceUrl: 'https://sso.garmin.cn/sso/embed',
    })
    expect(bootstrap.frameUrl).toContain(
      'source=http%3A%2F%2F127.0.0.1%3A43123',
    )
    expect(started.flowId).not.toBe(bootstrap.csrf)
    expect(randomBytes).toHaveBeenCalledTimes(2)
    expect(randomBytes).toHaveBeenNthCalledWith(1, 32)
    expect(randomBytes).toHaveBeenNthCalledWith(2, 32)
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'in_progress' })
    expect(manager.bridgeStatus(started.flowId, bootstrap.csrf)).toEqual({
      state: 'awaiting_garmin',
    })
    expect(JSON.stringify(manager.publicStatus(started.flowId))).not.toMatch(
      /runner|session|private/i,
    )
  })

  it('uses an exact 10-minute default authentication window', () => {
    jest.useFakeTimers()
    try {
      jest.setSystemTime(1_000)
      const manager = new EmbeddedAuthFlowManager({
        authenticate: jest.fn(),
        randomBytes: deterministicRandom(41, 42),
      })

      const started = manager.start(startInput)

      expect(started.expiresAt).toBe(601_000)
      jest.advanceTimersByTime(599_999)
      expect(manager.publicStatus(started.flowId)).toEqual({ state: 'in_progress' })
      jest.advanceTimersByTime(1)
      expect(manager.publicStatus(started.flowId)).toEqual({ state: 'expired' })
    } finally {
      jest.useRealTimers()
    }
  })

  it('atomically accepts one service ticket and passes secrets only to authenticate', async () => {
    const gate = deferred()
    let captured: EmbeddedAuthAuthenticateInput | undefined
    const authenticate = jest.fn(async (input: EmbeddedAuthAuthenticateInput) => {
      captured = input
      await gate.promise
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      randomBytes: deterministicRandom(3, 4),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)

    manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-ticket-secret'),
    )

    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({
      state: 'exchanging',
    })
    expect(() => manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-second-ticket'),
    )).toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(captured).toEqual(expect.objectContaining({
      region: 'cn',
      username: 'runner@example.com',
      sessionTokenFile: '/private/account/session.json',
      ticket: {
        serviceTicket: 'ST-ticket-secret',
        serviceUrl: FRAME_SERVICE_URL,
      },
      loopbackOrigin: BRIDGE_ORIGIN,
      signal: expect.any(AbortSignal),
      confirmIdentity: expect.any(Function),
    }))
    expect(JSON.stringify(manager.publicStatus(started.flowId))).not.toMatch(
      /ticket|runner|session|private/i,
    )

    gate.resolve()
    await settle()
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'failed' })
  })

  it('passes the exact loopback service URL and origin to authenticate', () => {
    let captured: EmbeddedAuthAuthenticateInput | undefined
    const manager = new EmbeddedAuthFlowManager({
      authenticate: input => { captured = input },
      randomBytes: deterministicRandom(43, 44),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)

    manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-loopback-service', BRIDGE_ORIGIN),
    )

    expect(captured).toEqual(expect.objectContaining({
      ticket: {
        serviceTicket: 'ST-loopback-service',
        serviceUrl: BRIDGE_ORIGIN,
      },
      loopbackOrigin: BRIDGE_ORIGIN,
    }))
  })

  it.each([
    ['another Garmin service', 'https://sso.garmin.com/sso/embed'],
    ['a Garmin service query', `${FRAME_SERVICE_URL}?ticket=secret`],
    ['another loopback origin', 'http://127.0.0.1:43124'],
    ['a loopback path', `${BRIDGE_ORIGIN}/garmin-auth/bridge`],
    ['a loopback query', `${BRIDGE_ORIGIN}?ticket=secret`],
    ['a loopback fragment', `${BRIDGE_ORIGIN}#secret`],
    ['loopback credentials', 'http://user:pass@127.0.0.1:43123'],
    ['a trailing slash', `${BRIDGE_ORIGIN}/`],
  ])('rejects %s as the ticket service URL', (_label, serviceUrl) => {
    const authenticate = jest.fn()
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      randomBytes: deterministicRandom(45, 46),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)

    expect(() => manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-forged-service', serviceUrl),
    )).toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
    expect(authenticate).not.toHaveBeenCalled()
    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({
      state: 'awaiting_garmin',
    })
  })

  it('rejects a re-entrant ticket submission before authenticate can continue', async () => {
    let flowId = ''
    let csrf = ''
    let reentrantError: unknown
    let manager!: EmbeddedAuthFlowManager
    const authenticate = jest.fn(() => {
      try {
        manager.submitTicket(
          flowId,
          csrf,
          ticket('ST-reentrant'),
        )
      } catch (error) {
        reentrantError = error
      }
    })
    manager = new EmbeddedAuthFlowManager({
      authenticate,
      randomBytes: deterministicRandom(23, 24),
    })
    const started = manager.start(startInput)
    flowId = started.flowId
    csrf = manager.bridgeBootstrap(flowId).csrf

    manager.submitTicket(flowId, csrf, ticket('ST-first'))
    await settle()

    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(reentrantError).toEqual(expect.objectContaining({
      message: GARMIN_EMBEDDED_AUTH_FLOW_REJECTED,
    }))
    expect(manager.publicStatus(flowId)).toEqual({ state: 'failed' })
  })

  it('sanitizes and bounds identity, then waits for confirmation before saving', async () => {
    const saveGate = deferred()
    const decisions: boolean[] = []
    const authenticate = jest.fn(async (input: EmbeddedAuthAuthenticateInput) => {
      decisions.push(await input.confirmIdentity({
        displayName: '  Runner\r\n<script> alert(1)  ',
        userName: `athlete-${'x'.repeat(300)}`,
      }))
      await saveGate.promise
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      randomBytes: deterministicRandom(5, 6),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)

    manager.submitTicket(started.flowId, csrf, ticket('ST-confirm'))
    await settle()

    const confirmation = manager.bridgeStatus(started.flowId, csrf)
    expect(confirmation.state).toBe('waiting_confirmation')
    expect(confirmation.identity).toEqual({
      displayName: 'Runner <script> alert(1)',
      userName: expect.stringMatching(/^athlete-x+$/),
    })
    expect(Array.from(confirmation.identity?.userName ?? '')).toHaveLength(120)
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'in_progress' })
    expect(JSON.stringify(manager.publicStatus(started.flowId))).not.toContain('Runner')

    manager.confirm(started.flowId, csrf, true)
    expect(manager.bridgeStatus(started.flowId, csrf).state).toBe('saving')
    await settle()
    expect(decisions).toEqual([true])

    saveGate.resolve()
    await settle()
    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({
      state: 'succeeded',
    })
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'succeeded' })
  })

  it('reports fixed confirmation and persistence stages without identity data', async () => {
    const saveGate = deferred()
    const diagnostics = jest.fn()
    const manager = new EmbeddedAuthFlowManager({
      authenticate: async (input) => {
        await input.confirmIdentity({
          displayName: 'runner@example.com SECRET_PROFILE',
        })
        await saveGate.promise
      },
      diagnostics,
      randomBytes: deterministicRandom(47, 48),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)

    manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-secret-ticket'),
    )
    await settle()
    manager.confirm(started.flowId, csrf, true)
    await settle()
    saveGate.resolve()
    await settle()

    expect(diagnostics.mock.calls).toEqual([
      ['ticket_captured', undefined],
      ['identity_confirmation_started', undefined],
      ['identity_confirmation_accepted', undefined],
      ['session_persist_started', undefined],
      ['session_persist_succeeded', undefined],
      ['auth_flow_succeeded', undefined],
    ])
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(
      /runner|example|secret_profile|st-secret|private|session\.json/i,
    )
  })

  it('treats saving as an irrevocable commit point', async () => {
    let now = 40_000
    const saveGate = deferred()
    const manager = new EmbeddedAuthFlowManager({
      authenticate: async (input) => {
        await input.confirmIdentity({ userName: 'runner' })
        await saveGate.promise
      },
      now: () => now,
      randomBytes: deterministicRandom(31, 32),
      ttlMs: 1_000,
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)
    manager.submitTicket(started.flowId, csrf, ticket('ST-saving'))
    await settle()
    manager.confirm(started.flowId, csrf, true)
    now = 50_000

    const terminal = manager.waitForTerminal(started.flowId)

    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({
      state: 'saving',
      identity: { userName: 'runner' },
    })
    expect(() => manager.cancel(started.flowId, csrf))
      .toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)

    saveGate.resolve()
    await expect(terminal).resolves.toEqual({ state: 'succeeded' })
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'succeeded' })
  })

  it('returns terminal state immediately and rejects waiting without an operation', async () => {
    const manager = new EmbeddedAuthFlowManager({
      authenticate: jest.fn(),
      randomBytes: deterministicRandom(37, 38, 39, 40),
    })
    const cancelled = manager.start(startInput)
    const cancelledCsrf = manager.bridgeBootstrap(cancelled.flowId).csrf
    manager.cancel(cancelled.flowId, cancelledCsrf)

    await expect(manager.waitForTerminal(cancelled.flowId)).resolves.toEqual({
      state: 'cancelled',
    })

    const awaiting = manager.start(startInput)
    await expect(manager.waitForTerminal(awaiting.flowId))
      .rejects.toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
  })

  it('prunes terminal records before starting another flow', () => {
    const manager = new EmbeddedAuthFlowManager({
      authenticate: jest.fn(),
      randomBytes: deterministicRandom(33, 34, 35, 36),
    })
    const first = manager.start(startInput)
    const firstCsrf = manager.bridgeBootstrap(first.flowId).csrf
    manager.cancel(first.flowId, firstCsrf)

    manager.start(startInput)

    expect(() => manager.publicStatus(first.flowId))
      .toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
  })

  it('treats rejected identity as cancellation and aborts authentication', async () => {
    let signal: AbortSignal | undefined
    let accepted: boolean | undefined
    const authenticate = jest.fn(async (input: EmbeddedAuthAuthenticateInput) => {
      signal = input.signal
      accepted = await input.confirmIdentity({ userName: 'runner' })
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      randomBytes: deterministicRandom(7, 8),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)
    manager.submitTicket(started.flowId, csrf, ticket('ST-reject'))
    await settle()

    manager.confirm(started.flowId, csrf, false)
    await settle()

    expect(accepted).toBe(false)
    expect(signal?.aborted).toBe(true)
    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({
      state: 'cancelled',
    })
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'cancelled' })
  })

  it('cancels an in-flight exchange without exposing callback failures', async () => {
    const gate = deferred()
    let signal: AbortSignal | undefined
    const authenticate = jest.fn(async (input: EmbeddedAuthAuthenticateInput) => {
      signal = input.signal
      await gate.promise
      throw new Error('ST-secret https://private.example account@example.com')
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      randomBytes: deterministicRandom(9, 10),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)
    manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-cancel-secret'),
    )

    manager.cancel(started.flowId, csrf)

    expect(signal?.aborted).toBe(true)
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'cancelled' })
    gate.resolve()
    await settle()
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'cancelled' })
    expect(JSON.stringify(manager.bridgeStatus(started.flowId, csrf)))
      .not.toMatch(/secret|example|private/i)
  })

  it('collapses authentication failures to a fixed failed state', async () => {
    const authenticate = jest.fn(async () => {
      throw new Error('access_token=TOP_SECRET username=runner@example.com')
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      randomBytes: deterministicRandom(11, 12),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)

    manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-failure-secret'),
    )
    await settle()

    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({
      state: 'failed',
    })
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'failed' })
  })

  it('expires fail-closed, aborting pending work and rejecting all later mutations', async () => {
    let now = 10_000
    let signal: AbortSignal | undefined
    const gate = deferred()
    const authenticate = jest.fn(async (input: EmbeddedAuthAuthenticateInput) => {
      signal = input.signal
      await gate.promise
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      now: () => now,
      randomBytes: deterministicRandom(13, 14),
      ttlMs: 1_000,
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)
    manager.submitTicket(started.flowId, csrf, ticket('ST-expiring'))
    now = 11_000

    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'expired' })
    expect(signal?.aborted).toBe(true)
    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({
      state: 'expired',
    })
    expect(() => manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-too-late'),
    )).toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
    expect(() => manager.confirm(started.flowId, csrf, true))
      .toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
    expect(() => manager.cancel(started.flowId, csrf))
      .toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)

    gate.resolve()
    await settle()
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'expired' })
  })

  it('keeps a scrubbed terminal result until the next flow prunes it', async () => {
    let now = 20_000
    const authenticate = jest.fn(async (input: EmbeddedAuthAuthenticateInput) => {
      await input.confirmIdentity({ displayName: 'Visible Runner' })
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      now: () => now,
      randomBytes: deterministicRandom(25, 26),
      ttlMs: 1_000,
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)
    manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-terminal-expiry'),
    )
    await settle()
    manager.confirm(started.flowId, csrf, true)
    await settle()
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'succeeded' })

    now = 21_000

    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'succeeded' })
    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({ state: 'succeeded' })
    expect(manager.bridgeBootstrap(started.flowId)).toEqual(expect.objectContaining({
      csrf,
    }))
  })

  it('resolves a pending identity decision as false when the flow expires', async () => {
    let now = 30_000
    let accepted: boolean | undefined
    const authenticate = jest.fn(async (input: EmbeddedAuthAuthenticateInput) => {
      accepted = await input.confirmIdentity({ userName: 'runner' })
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      now: () => now,
      randomBytes: deterministicRandom(27, 28),
      ttlMs: 1_000,
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)
    manager.submitTicket(
      started.flowId,
      csrf,
      ticket('ST-pending-expiry'),
    )
    await settle()

    now = 31_000
    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({ state: 'expired' })
    await settle()
    expect(accepted).toBe(false)
    expect(manager.publicStatus(started.flowId)).toEqual({ state: 'expired' })
  })

  it('does not let invalid CSRF attempts mutate or discover a live flow', () => {
    const manager = new EmbeddedAuthFlowManager({
      authenticate: jest.fn(),
      randomBytes: deterministicRandom(15, 16),
    })
    const started = manager.start(startInput)
    const { csrf } = manager.bridgeBootstrap(started.flowId)

    for (const operation of [
      () => manager.bridgeStatus(started.flowId, 'wrong-csrf'),
      () => manager.submitTicket(
        started.flowId,
        'wrong-csrf',
        ticket('ST-ticket'),
      ),
      () => manager.confirm(started.flowId, 'wrong-csrf', true),
      () => manager.cancel(started.flowId, 'wrong-csrf'),
      () => manager.publicStatus('unknown-flow'),
    ]) {
      expect(operation).toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
    }

    expect(manager.bridgeStatus(started.flowId, csrf)).toEqual({
      state: 'awaiting_garmin',
    })
  })

  it.each([
    ['invalid region', { ...startInput, region: 'mars' }],
    ['empty username', { ...startInput, username: '   ' }],
    ['empty session path', { ...startInput, sessionTokenFile: '' }],
    ['non-loopback bridge origin', {
      ...startInput,
      bridgeOrigin: 'https://example.com',
    }],
  ])('rejects %s with the same public error', (_label, input) => {
    const manager = new EmbeddedAuthFlowManager({
      authenticate: jest.fn(),
      randomBytes: deterministicRandom(17, 18),
    })

    expect(() => manager.start(input as typeof startInput))
      .toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
  })

  it('rejects malformed tickets and identities without echoing their values', async () => {
    const authenticate = jest.fn(async (input: EmbeddedAuthAuthenticateInput) => {
      await input.confirmIdentity({ displayName: '\u0000\r\n' })
    })
    const manager = new EmbeddedAuthFlowManager({
      authenticate,
      randomBytes: deterministicRandom(19, 20, 21, 22),
    })
    const malformedTicketFlow = manager.start(startInput)
    const malformedBootstrap = manager.bridgeBootstrap(malformedTicketFlow.flowId)

    expect(() => manager.submitTicket(
      malformedTicketFlow.flowId,
      malformedBootstrap.csrf,
      ticket('not-a-service-ticket TOP_SECRET'),
    )).toThrow(GARMIN_EMBEDDED_AUTH_FLOW_REJECTED)
    expect(manager.bridgeStatus(
      malformedTicketFlow.flowId,
      malformedBootstrap.csrf,
    )).toEqual({ state: 'awaiting_garmin' })

    const invalidIdentityFlow = manager.start(startInput)
    const invalidIdentityBootstrap = manager.bridgeBootstrap(invalidIdentityFlow.flowId)
    manager.submitTicket(
      invalidIdentityFlow.flowId,
      invalidIdentityBootstrap.csrf,
      ticket('ST-valid'),
    )
    await settle()
    expect(manager.bridgeStatus(
      invalidIdentityFlow.flowId,
      invalidIdentityBootstrap.csrf,
    )).toEqual({ state: 'failed' })
  })
})
