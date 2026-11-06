import {
  AUTH_DIAGNOSTIC_PREFIX,
  createAuthDiagnosticReporter,
  reportAuthDiagnostic,
  resolveAuthDiagnosticPathSource,
  type AuthDiagnosticEvent,
} from '../src/auth-diagnostics'

describe('redacted authentication diagnostics', () => {
  it('emits only allowlisted structured fields', () => {
    const lines: string[] = []
    const reporter = createAuthDiagnosticReporter(
      line => lines.push(line),
      {
        source: 'dsh',
        region: 'cn',
        accountSlot: 2,
        sessionPathSource: 'local_appdata',
      },
    )

    reportAuthDiagnostic(
      reporter,
      'session_destination_prepare_failed',
      'windows_acl_rejected',
    )

    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith(`${AUTH_DIAGNOSTIC_PREFIX} `)).toBe(true)
    const record = JSON.parse(lines[0].slice(AUTH_DIAGNOSTIC_PREFIX.length + 1))
    expect(record).toMatchObject({
      event: 'session_destination_prepare_failed',
      code: 'windows_acl_rejected',
      source: 'dsh',
      region: 'cn',
      account_slot: 2,
      session_path_source: 'local_appdata',
    })
    expect(record.platform).toMatch(/^(win32|darwin|linux|other)$/)
    expect(record.node_major).toEqual(expect.any(Number))
    expect(record.plugin_version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('drops unknown events and never serializes arbitrary diagnostic codes', () => {
    const lines: string[] = []
    const reporter = createAuthDiagnosticReporter(
      line => lines.push(line),
      { source: 'cli_serve', region: 'global' },
    )

    reportAuthDiagnostic(
      reporter,
      'runner@example.com C:\\Users\\runner\\session.json SECRET_TICKET' as AuthDiagnosticEvent,
    )
    reportAuthDiagnostic(
      reporter,
      'auth_flow_failed',
      'runner@example.com C:\\Users\\runner\\session.json SECRET_TOKEN' as never,
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"event":"auth_flow_failed"')
    expect(lines[0]).not.toMatch(/runner|users|session|secret|token/i)
    expect(lines[0]).not.toContain('"code"')
  })

  it('keeps a broken output sink from changing the authentication flow', () => {
    const reporter = createAuthDiagnosticReporter(
      () => { throw new Error('logger failed with SECRET_TOKEN') },
      { source: 'cli_login', region: 'global' },
    )

    expect(() => reportAuthDiagnostic(reporter, 'diagnostics_started')).not.toThrow()
  })

  it('reports only the configured path source category', () => {
    expect(resolveAuthDiagnosticPathSource(true, {})).toBe('explicit')
    expect(resolveAuthDiagnosticPathSource(false, {
      XDG_CONFIG_HOME: ' C:\\secret ',
      LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local',
    })).toBe('xdg')
    expect(resolveAuthDiagnosticPathSource(false, {
      LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local',
    })).toBe('local_appdata')
    expect(resolveAuthDiagnosticPathSource(false, {
      APPDATA: 'C:\\Users\\runner\\AppData\\Roaming',
    })).toBe('appdata')
    expect(resolveAuthDiagnosticPathSource(false, {})).toBe('home')
  })
})
