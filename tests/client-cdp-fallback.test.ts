import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('DSH explicit CDP fallback wiring', () => {
  const overlaySource = readFileSync(
    path.resolve(__dirname, '../src/client/index.tsx'),
    'utf8',
  )
  const viewSource = readFileSync(
    path.resolve(__dirname, '../src/client/view.tsx'),
    'utf8',
  )

  it('starts CDP only from the explicit retry handler', () => {
    expect(overlaySource.match(/beginAuthentication\(request, 'cdp', false\)/g))
      .toHaveLength(1)
    expect(overlaySource).toContain('const retryWithCdp = useCallback(() => {')
    expect(overlaySource).toContain(
      "transport === 'embedded' && canOfferCdpFallback(status)",
    )
    expect(viewSource).toContain('窗口打不开？改用兼容浏览器（CDP）')
  })

  it('cancels the active embedded flow before choosing the CDP endpoint', () => {
    const cancel = overlaySource.indexOf(
      'const released = await cancelFlow(previousFlowId, controller.signal)',
    )
    const chooseCdp = overlaySource.indexOf(
      "const endpoint = nextTransport === 'cdp' ? 'begin-cdp' : 'begin'",
    )

    expect(cancel).toBeGreaterThan(-1)
    expect(chooseCdp).toBeGreaterThan(cancel)
  })

  it('keeps the embedded iframe as the default and hides it during CDP', () => {
    expect(overlaySource).toContain(
      "useState<GarminAuthTransport>('embedded')",
    )
    expect(overlaySource).toContain(
      "showFrame={transport === 'embedded' && begin?.success === true",
    )
    expect(viewSource).toContain('临时隔离配置')
  })
})
