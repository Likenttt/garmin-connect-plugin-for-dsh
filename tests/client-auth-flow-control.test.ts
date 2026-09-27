import {
  callGarminAuthRpc,
  releaseGarminAuthFlow,
  retainUnreleasedGarminAuthFlowId,
} from '../src/client/flow-control'

const flowId = 'a'.repeat(64)

describe('DSH Garmin authentication transport', () => {
  it.each([
    ['account', {}],
    ['begin', { region: 'global' }],
    ['status', { flowId }],
    ['cancel', { flowId }],
  ] as const)('uses the current Host route for %s', async (endpoint, payload) => {
    const response = { ok: true, value: { success: true } }
    const call = jest.fn().mockResolvedValue(response)

    await expect(callGarminAuthRpc({ call }, endpoint, payload)).resolves.toBe(response)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(
      '/api', `garmin-auth/${endpoint}`, payload, undefined,
    )
  })

  it('falls back to the legacy Host only for an absent route and remembers it', async () => {
    const response = { ok: true, value: { success: true } }
    const call = jest.fn()
      .mockRejectedValueOnce(new Error(
        'transport failure for /api/garmin-auth/begin: HTTP 404',
      ))
      .mockResolvedValue(response)
    const rpc = { call }

    await expect(callGarminAuthRpc(rpc, 'begin', { region: 'global' }))
      .resolves.toBe(response)
    await expect(callGarminAuthRpc(rpc, 'status', { flowId }))
      .resolves.toBe(response)
    expect(call.mock.calls).toEqual([
      ['/api', 'garmin-auth/begin', { region: 'global' }, undefined],
      ['/garmin-auth', 'begin', { region: 'global' }, undefined],
      ['/garmin-auth', 'status', { flowId }, undefined],
    ])
  })

  it('does not replay a business failure or a failed begin request', async () => {
    const businessFailure = { ok: true, value: { success: false, code: 'busy' } }
    const rpcFailure = {
      ok: false,
      error: { code: 'internal', message: 'Host failed', details: {} },
    }
    const call = jest.fn().mockResolvedValueOnce(businessFailure)
      .mockResolvedValueOnce(rpcFailure)
      .mockRejectedValueOnce(new Error(
        'transport failure for /api/garmin-auth/begin: HTTP 500',
      ))
    const rpc = { call }

    await expect(callGarminAuthRpc(rpc, 'begin', { region: 'global' }))
      .resolves.toBe(businessFailure)
    await expect(callGarminAuthRpc(rpc, 'begin', { region: 'global' }))
      .resolves.toBe(rpcFailure)
    await expect(callGarminAuthRpc(rpc, 'begin', { region: 'global' }))
      .rejects.toThrow('HTTP 500')
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('does not retry an aborted request after an absent-route response', async () => {
    const controller = new AbortController()
    const call = jest.fn().mockImplementation(async () => {
      controller.abort()
      throw new Error('transport failure for /api/garmin-auth/begin: HTTP 404')
    })

    await expect(callGarminAuthRpc(
      { call }, 'begin', { region: 'global' }, controller.signal,
    )).rejects.toThrow('HTTP 404')
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('DSH Garmin authentication flow control', () => {
  it('releases a previous handle only after cancellation is confirmed', async () => {
    const call = jest.fn().mockResolvedValue({
      ok: true,
      value: { success: true },
    })

    await expect(releaseGarminAuthFlow({ call }, flowId)).resolves.toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(
      '/api',
      'garmin-auth/cancel',
      { flowId },
      undefined,
    )
  })

  it('keeps the handle when cancellation and status are uncertain', async () => {
    const call = jest.fn()
      .mockRejectedValueOnce(new Error('transport failed with ST-secret'))
      .mockResolvedValueOnce({
        ok: true,
        value: { success: true, status: 'in_progress' },
      })

    await expect(releaseGarminAuthFlow({ call }, flowId)).resolves.toBe(false)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it.each(['succeeded', 'failed', 'cancelled', 'expired'] as const)(
    'releases a terminal flow after cancellation returns an ambiguous result: %s',
    async (status) => {
      const call = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          value: { success: false, code: 'unavailable' },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: { success: true, status },
        })

      await expect(releaseGarminAuthFlow({ call }, flowId)).resolves.toBe(true)
      expect(call).toHaveBeenCalledTimes(2)
    },
  )

  it('retains a late begin handle only when its release is uncertain', () => {
    const existingFlowId = 'b'.repeat(64)

    expect(retainUnreleasedGarminAuthFlowId(undefined, flowId, false)).toBe(flowId)
    expect(retainUnreleasedGarminAuthFlowId(existingFlowId, flowId, false))
      .toBe(existingFlowId)
    expect(retainUnreleasedGarminAuthFlowId(undefined, flowId, true)).toBeUndefined()
  })
})
