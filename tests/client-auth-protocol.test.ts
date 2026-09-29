import {
  parseGarminAuthAccountRpcResult,
  parseGarminAuthAccountsRpcResult,
  parseGarminAuthBeginRpcResult,
  parseGarminAuthCancelRpcResult,
  parseGarminAuthStatusRpcResult,
} from '../src/client/protocol'

const flowId = 'a'.repeat(64)

describe('DSH Garmin authentication client protocol', () => {
  it('recognizes a pending Host configuration without exposing an email', () => {
    expect(parseGarminAuthBeginRpcResult({
      ok: true,
      value: { success: false, code: 'stale_config' },
    })).toEqual({ success: false, code: 'stale_config' })
  })

  it('accepts an exact public list with multiple accounts in one region', () => {
    expect(parseGarminAuthAccountsRpcResult({
      ok: true,
      value: {
        success: true,
        accounts: [
          { accountId: 'legacy-cn', slot: 1, region: 'cn', configured: true, authenticated: false },
          { accountId: 'a0123456789abcdefabcd', slot: 3, region: 'cn', alias: '第二个', configured: true, authenticated: true },
        ],
      },
    })).toEqual({
      success: true,
      accounts: [
        { accountId: 'legacy-cn', slot: 1, region: 'cn', configured: true, authenticated: false },
        { accountId: 'a0123456789abcdefabcd', slot: 3, region: 'cn', alias: '第二个', configured: true, authenticated: true },
      ],
    })
  })

  it('accepts only display-safe masked emails in account summaries', () => {
    const base = {
      accountId: 'a0123456789abcdefabcd', slot: 1, region: 'global',
      configured: true, authenticated: false,
    }
    for (const maskedEmail of ['chu****@88.com', 'c****@example.test', '****@example.test']) {
      expect(parseGarminAuthAccountsRpcResult({
        ok: true,
        value: { success: true, accounts: [{ ...base, maskedEmail }] },
      })).toEqual({ success: true, accounts: [{ ...base, maskedEmail }] })
    }
    for (const maskedEmail of [
      'runner@example.test', 'abcd****@example.test', 'ch****@example.test',
      'chu****@evil.test\nX-Token: ST-private', 'chu****@example.test****@other.test',
    ]) {
      expect(parseGarminAuthAccountsRpcResult({
        ok: true,
        value: { success: true, accounts: [{ ...base, maskedEmail }] },
      })).toEqual({ success: false, code: 'unavailable' })
    }
  })

  it('rejects private fields, duplicate IDs, and duplicate slots in the public list', () => {
    const base = { accountId: 'a0123456789abcdefabcd', slot: 1, region: 'global', configured: true, authenticated: false }
    for (const accounts of [
      [{ ...base, email: 'runner@example.test' }],
      [base, { ...base, slot: 2 }],
      [base, { ...base, accountId: 'another' }],
    ]) {
      expect(parseGarminAuthAccountsRpcResult({
        ok: true,
        value: { success: true, accounts },
      })).toEqual({ success: false, code: 'unavailable' })
    }
  })

  it('accepts exact selected-account detail without exposing an email before login', () => {
    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: {
        success: true,
        accountId: 'legacy-cn',
        slot: 1,
        region: 'cn',
        configured: false,
        authenticated: false,
      },
    })).toEqual({
      success: true,
      accountId: 'legacy-cn',
      slot: 1,
      region: 'cn',
      configured: false,
      authenticated: false,
    })

    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: {
        success: true,
        accountId: 'a0123456789abcdefabcd',
        slot: 3,
        region: 'cn',
        alias: '第二个',
        configured: true,
        authenticated: false,
      },
    })).toEqual({
      success: true,
      accountId: 'a0123456789abcdefabcd',
      slot: 3,
      region: 'cn',
      alias: '第二个',
      configured: true,
      authenticated: false,
    })
  })

  it('accepts exact regional account summaries without rehydrating a saved email', () => {
    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: { success: true, configured: false, authenticated: false, region: 'cn' },
    })).toEqual({ success: true, configured: false, authenticated: false, region: 'cn' })

    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: {
        success: true,
        configured: true,
        authenticated: false,
        region: 'global',
        alias: '训练账号',
      },
    })).toEqual({
      success: true,
      configured: true,
      authenticated: false,
      region: 'global',
      alias: '训练账号',
    })

    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: {
        success: true,
        configured: true,
        authenticated: false,
        region: 'cn',
        authenticationRequired: true,
        reason: 'expired',
        revision: 3,
      },
    })).toEqual({
      success: true,
      configured: true,
      authenticated: false,
      region: 'cn',
      authenticationRequired: true,
      reason: 'expired',
      revision: 3,
    })

    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: {
        success: true,
        configured: true,
        authenticated: true,
        region: 'cn',
        alias: '训练账号',
        email: 'runner@example.test',
      },
    })).toEqual({
      success: true,
      configured: true,
      authenticated: true,
      region: 'cn',
      alias: '训练账号',
      email: 'runner@example.test',
    })
  })

  it('rejects private or mismatched regional account fields', () => {
    for (const value of [
      { success: true, accountId: 'legacy-cn', slot: 1, configured: false, authenticated: false, region: 'cn', email: 'runner@example.test' },
      { success: true, configured: false, authenticated: false, region: 'cn', email: 'runner@example.test' },
      { success: true, configured: true, authenticated: false, region: 'cn', token: 'ST-secret' },
      { success: true, configured: true, authenticated: false, region: 'cn', alias: 'a\nprivate' },
      { success: true, configured: true, authenticated: true, region: 'cn', email: 'bad\r\nheader' },
    ]) {
      const result = parseGarminAuthAccountRpcResult({ ok: true, value })
      expect(result).toEqual({ success: false, code: 'unavailable' })
      expect(JSON.stringify(result)).not.toContain('ST-secret')
    }
  })

  it('accepts exact authenticated and unauthenticated account summaries', () => {
    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: { success: true, authenticated: false },
    })).toEqual({ success: true, authenticated: false })

    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: {
        success: true,
        authenticated: false,
        authenticationRequired: true,
        reason: 'challenge',
        region: 'global',
        revision: 7,
      },
    })).toEqual({
      success: true,
      authenticated: false,
      authenticationRequired: true,
      reason: 'challenge',
      region: 'global',
      revision: 7,
    })

    expect(parseGarminAuthAccountRpcResult({
      ok: true,
      value: {
        success: true,
        authenticated: true,
        email: 'runner@example.test',
        region: 'cn',
      },
    })).toEqual({
      success: true,
      authenticated: true,
      email: 'runner@example.test',
      region: 'cn',
    })
  })

  it.each([
    { success: true, authenticated: false, email: 'runner@example.test' },
    {
      success: true,
      authenticated: true,
      email: 'runner@example.test',
      region: 'eu',
    },
    {
      success: true,
      authenticated: true,
      email: `runner@${'x'.repeat(320)}.test`,
      region: 'global',
    },
    {
      success: true,
      authenticated: true,
      email: 'runner@example.test\r\nX-Token: ST-secret',
      region: 'global',
    },
    {
      success: true,
      authenticated: true,
      email: 'runner@example.test',
      region: 'global',
      token: 'ST-secret',
    },
    {
      success: true,
      authenticated: false,
      authenticationRequired: true,
      reason: 'private upstream error',
      region: 'global',
      revision: 1,
    },
    {
      success: true,
      authenticated: false,
      authenticationRequired: true,
      reason: 'missing',
      region: 'global',
      revision: 0,
    },
    {
      success: true,
      authenticated: false,
      authenticationRequired: true,
      reason: 'challenge',
      region: 'global',
      revision: 1,
      token: 'ST-secret',
    },
  ])('rejects an unsafe authenticated account summary: %#', (value) => {
    const parsed = parseGarminAuthAccountRpcResult({ ok: true, value })

    expect(parsed).toEqual({ success: false, code: 'unavailable' })
    expect(JSON.stringify(parsed)).not.toContain('ST-secret')
  })

  it('accepts a bounded loopback bridge begin result', () => {
    expect(parseGarminAuthBeginRpcResult({
      ok: true,
      value: {
        success: true,
        flowId,
        bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${flowId}`,
        expiresAt: 1_900_000_000_000,
      },
    })).toEqual({
      success: true,
      flowId,
      bridgeUrl: `http://127.0.0.1:43127/garmin-auth/bridge/${flowId}`,
      expiresAt: 1_900_000_000_000,
    })
  })

  it('preserves the explicit region mismatch without exposing private configuration', () => {
    expect(parseGarminAuthBeginRpcResult({
      ok: true,
      value: { success: false, code: 'region_mismatch' },
    })).toEqual({ success: false, code: 'region_mismatch' })

    expect(parseGarminAuthBeginRpcResult({
      ok: true,
      value: {
        success: false,
        code: 'region_mismatch',
        email: 'runner@example.test',
      },
    })).toEqual({ success: false, code: 'unavailable' })
  })

  it.each([
    `https://127.0.0.1:43127/garmin-auth/bridge/${flowId}`,
    `http://localhost:43127/garmin-auth/bridge/${flowId}`,
    `http://127.0.0.1:43127/garmin-auth/bridge/${'b'.repeat(64)}`,
    `http://127.0.0.1:43127/garmin-auth/bridge/${flowId}?ticket=ST-secret`,
    `http://127.0.0.1:43127/other/${flowId}`,
  ])('rejects an unsafe or mismatched bridge URL: %s', (bridgeUrl) => {
    expect(parseGarminAuthBeginRpcResult({
      ok: true,
      value: {
        success: true,
        flowId,
        bridgeUrl,
        expiresAt: 1_900_000_000_000,
      },
    })).toEqual({ success: false, code: 'unavailable' })
  })

  it('folds transport and untrusted server errors into a fixed client code', () => {
    const secret = 'ST-private-ticket runner@example.test /private/session.json'

    expect(parseGarminAuthBeginRpcResult({
      ok: false,
      error: { code: 'internal', message: secret, details: {} },
    })).toEqual({ success: false, code: 'unavailable' })
    expect(JSON.stringify(parseGarminAuthBeginRpcResult({
      ok: false,
      error: { message: secret },
    }))).not.toContain(secret)
  })

  it.each([
    'in_progress',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
  ] as const)('accepts the closed public status %s', (status) => {
    expect(parseGarminAuthStatusRpcResult({
      ok: true,
      value: { success: true, status },
    })).toEqual({ success: true, status })
  })

  it('rejects status payloads carrying extra fields or private data', () => {
    expect(parseGarminAuthStatusRpcResult({
      ok: true,
      value: {
        success: true,
        status: 'succeeded',
        ticket: 'ST-secret',
      },
    })).toEqual({ success: false, code: 'unavailable' })
  })

  it('accepts only an exact successful cancellation envelope', () => {
    expect(parseGarminAuthCancelRpcResult({
      ok: true,
      value: { success: true },
    })).toEqual({ success: true })
    expect(parseGarminAuthCancelRpcResult({
      ok: true,
      value: { success: true, ticket: 'ST-secret' },
    })).toEqual({ success: false, code: 'unavailable' })
  })
})
