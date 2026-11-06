import { runConnectionChecks } from '../src/client/check-connections'

const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
it('checks each account once with at most three requests and reports independent failures', async () => {
  const controller = new AbortController()
  const releases = new Map<number, () => void>()
  let active = 0
  let maximum = 0
  const outcomes: number[] = []
  const check = jest.fn(async (item: number) => {
    active += 1; maximum = Math.max(maximum, active)
    await new Promise<void>(resolve => { releases.set(item, resolve) })
    active -= 1
    if (item === 2) throw new Error('temporary network failure')
    return item
  })
  const result = runConnectionChecks({ items: [0, 1, 2, 3, 4, 5], signal: controller.signal, check,
    onResult(outcome) { outcomes.push(outcome.item) },
  })
  expect(check).toHaveBeenCalledTimes(3)
  for (let item = 0; item < 6; item++) { releases.get(item)!(); await flush() }
  expect(await result).toEqual({ total: 6, completed: 6, cancelled: false })
  expect(maximum).toBe(3)
  expect(outcomes).toEqual([0, 1, 2, 3, 4, 5])
  expect(check).toHaveBeenCalledTimes(6)
})

it('cancels queued work immediately without waiting for existing requests or emitting late results', async () => {
  const controller = new AbortController()
  const releases: Array<() => void> = []
  const signals: AbortSignal[] = []
  const check = jest.fn((_item: number, signal: AbortSignal) => {
    signals.push(signal)
    return new Promise<void>(resolve => releases.push(resolve))
  })
  const onResult = jest.fn()
  const pending = runConnectionChecks({ items: [1, 2, 3, 4, 5], signal: controller.signal, check, onResult })
  expect(check).toHaveBeenCalledTimes(3)
  controller.abort()
  expect(await pending).toEqual({ total: 5, completed: 0, cancelled: true })
  expect(signals.every(signal => signal.aborted)).toBe(true)
  for (const release of releases) release()
  await flush()
  expect(check).toHaveBeenCalledTimes(3)
  expect(onResult).not.toHaveBeenCalled()
})

it('does not start a cancelled queue or an empty list', async () => {
  const controller = new AbortController()
  controller.abort()
  const check = jest.fn()
  expect(await runConnectionChecks({ items: [1], signal: controller.signal, check })).toEqual({ total: 1, completed: 0, cancelled: true })
  expect(await runConnectionChecks({ items: [], signal: new AbortController().signal, check })).toEqual({ total: 0, completed: 0, cancelled: false })
  expect(check).not.toHaveBeenCalled()
})
