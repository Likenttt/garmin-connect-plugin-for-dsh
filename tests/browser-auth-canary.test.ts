import {
  runCapturedServiceTicketDiCanary,
  runBrowserDiAuthSetup,
  runBrowserDiAuthCanary,
  type BrowserDiAuthCanaryDependencies,
  type BrowserDiAuthCanaryStage,
  type BrowserObservedResponse,
} from '../src/browser-auth-canary'

function jsonResponse(
  url: string,
  body: unknown,
  status = 200,
): BrowserObservedResponse {
  return {
    url,
    status,
    contentType: 'application/json; charset=utf-8',
    json: jest.fn().mockResolvedValue(body),
  }
}

function successfulFixture(region: 'global' | 'cn' = 'global') {
  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com'
  const browser = {
    openAndCapture: jest.fn(async (options: Parameters<
      BrowserDiAuthCanaryDependencies['browser']['openAndCapture']
    >[0]) => {
      options.onStage?.('browser_opened')
      options.onStage?.('portal_loaded')
      const captured = await options.onResponse(jsonResponse(
        `https://sso.${domain}/portal/api/login`,
        {
          responseStatus: { type: 'SUCCESSFUL' },
          serviceTicketId: 'ST-browser-ticket-sso',
        },
      ))
      expect(captured).toBe(true)
    }),
  }
  const http = {
    request: jest.fn()
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: {
          access_token: 'di-access-secret',
          refresh_token: 'di-refresh-secret',
          expires_in: 3_600,
          refresh_token_expires_in: 86_400,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: {
          displayName: 'Private Runner',
          profileId: 123456789,
        },
      }),
  }
  const dependencies: BrowserDiAuthCanaryDependencies = { browser, http }
  return { dependencies, browser, http, domain }
}

describe('experimental browser DI authentication canary', () => {
  it('persists a bounded account-bound DI session without returning secrets', async () => {
    const { dependencies } = successfulFixture('cn')
    const nowMs = 1_800_000_000_000
    const writeSession = jest.fn().mockResolvedValue(undefined)
    const confirmIdentity = jest.fn().mockResolvedValue(true)

    const result = await runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'runner@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity,
      },
      { ...dependencies, now: () => nowMs, writeSession },
    )

    expect(result).toEqual({
      ok: true,
      region: 'cn',
      persisted: true,
    })
    expect(JSON.stringify(result)).not.toMatch(/runner|access|refresh|profile/i)
    expect(confirmIdentity).toHaveBeenCalledWith({
      displayName: 'Private Runner',
    })
    expect(writeSession).toHaveBeenCalledWith('/private/account/session.json', {
      kind: 'di-oauth',
      schemaVersion: 2,
      clientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      tokens: {
        accessToken: 'di-access-secret',
        refreshToken: 'di-refresh-secret',
        accessExpiresAtMs: nowMs + 3_600_000,
        refreshExpiresAtMs: nowMs + 86_400_000,
      },
      account: {
        usernameHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        profileIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        region: 'cn',
      },
    })
  })

  it('persists a null refresh expiry when Garmin does not report one', async () => {
    const { dependencies, http } = successfulFixture('cn')
    http.request.mockReset()
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: {
          access_token: 'di-access-secret',
          refresh_token: 'di-refresh-secret',
          expires_in: 3_600,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: { displayName: 'Private Runner', profileId: 123456789 },
      })
    const writeSession = jest.fn().mockResolvedValue(undefined)

    await runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'runner@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity: jest.fn().mockResolvedValue(true),
      },
      { ...dependencies, now: () => 1_800_000_000_000, writeSession },
    )

    expect(writeSession.mock.calls[0][1].tokens.refreshExpiresAtMs).toBeNull()
  })

  it.each([
    { body: { profileId: 0 }, label: 'invalid profile identity' },
    { body: { displayName: 'runner' }, label: 'missing profile identity' },
    { body: { profileId: 123456789 }, label: 'missing recognizable profile label' },
  ])('does not write a session with $label', async ({ body }) => {
    const { dependencies, http } = successfulFixture('cn')
    http.request.mockReset().mockImplementationOnce(async () => ({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: 'di-access-secret',
        refresh_token: 'di-refresh-secret',
        expires_in: 3_600,
      },
    })).mockImplementationOnce(async () => ({
      status: 200,
      contentType: 'application/json',
      body,
    }))
    const writeSession = jest.fn()

    await expect(runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'runner@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity: jest.fn().mockResolvedValue(true),
      },
      { ...dependencies, writeSession },
    )).rejects.toThrow(
      'Garmin DI authentication did not return a persistable session',
    )

    expect(writeSession).not.toHaveBeenCalled()
  })

  it('does not write a session when the access expiry is absent', async () => {
    const { dependencies, http } = successfulFixture('cn')
    http.request.mockReset()
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: {
          access_token: 'di-access-secret',
          refresh_token: 'di-refresh-secret',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: { displayName: 'Private Runner', profileId: 123456789 },
      })
    const writeSession = jest.fn()

    await expect(runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'runner@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity: jest.fn().mockResolvedValue(true),
      },
      { ...dependencies, writeSession },
    )).rejects.toThrow(
      'Garmin DI authentication did not return a persistable session',
    )

    expect(writeSession).not.toHaveBeenCalled()
  })

  it('replaces session writer errors without disclosing paths or credentials', async () => {
    const { dependencies } = successfulFixture('cn')
    const writeSession = jest.fn().mockRejectedValue(
      new Error('/private/account/session.json di-access-secret runner@example.test'),
    )

    const promise = runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'runner@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity: jest.fn().mockResolvedValue(true),
      },
      { ...dependencies, writeSession },
    )

    await expect(promise).rejects.toThrow('Garmin DI session could not be persisted')
    await promise.catch((error: Error) => {
      expect(error.message).not.toMatch(/private|runner|access/i)
    })
    expect(writeSession).toHaveBeenCalledTimes(1)
  })

  it('honours cancellation before the atomic session writer starts', async () => {
    const { dependencies, http } = successfulFixture('cn')
    const controller = new AbortController()
    http.request.mockReset().mockImplementationOnce(async () => ({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: 'di-access-secret',
        refresh_token: 'di-refresh-secret',
        expires_in: 3_600,
      },
    })).mockImplementationOnce(async () => {
      controller.abort()
      return {
        status: 200,
        contentType: 'application/json',
        body: { displayName: 'Private Runner', profileId: 123456789 },
      }
    })
    const writeSession = jest.fn()

    await expect(runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'runner@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity: jest.fn().mockResolvedValue(true),
        signal: controller.signal,
      },
      { ...dependencies, writeSession },
    )).rejects.toThrow('Garmin browser authentication was cancelled')

    expect(writeSession).not.toHaveBeenCalled()
  })

  it('finishes the atomic commit when cancellation arrives during the write', async () => {
    const { dependencies } = successfulFixture('cn')
    const controller = new AbortController()
    const writeSession = jest.fn().mockImplementation(async () => {
      controller.abort()
    })

    await expect(runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'runner@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity: jest.fn().mockResolvedValue(true),
        signal: controller.signal,
      },
      { ...dependencies, writeSession },
    )).resolves.toEqual({ ok: true, region: 'cn', persisted: true })

    expect(writeSession).toHaveBeenCalledTimes(1)
  })

  it('requires explicit confirmation of the actual Garmin profile before writing', async () => {
    const { dependencies } = successfulFixture('cn')
    const writeSession = jest.fn()
    const confirmIdentity = jest.fn().mockResolvedValue(false)

    await expect(runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'expected@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity,
      },
      { ...dependencies, writeSession },
    )).rejects.toThrow('Garmin browser account confirmation was declined')

    expect(confirmIdentity).toHaveBeenCalledWith({ displayName: 'Private Runner' })
    expect(writeSession).not.toHaveBeenCalled()
  })

  it('records token expiry before the profile request instead of extending it', async () => {
    const { dependencies, http } = successfulFixture('cn')
    let profileRequested = false
    http.request.mockReset()
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: {
          access_token: 'di-access-secret',
          refresh_token: 'di-refresh-secret',
          expires_in: 3_600,
        },
      })
      .mockImplementationOnce(async () => {
        profileRequested = true
        return {
          status: 200,
          contentType: 'application/json',
          body: { displayName: 'Private Runner', profileId: 123456789 },
        }
      })
    const observedAtMs = 1_800_000_000_000
    const now = jest.fn(() => {
      expect(profileRequested).toBe(false)
      return observedAtMs
    })
    const writeSession = jest.fn().mockResolvedValue(undefined)

    await runBrowserDiAuthSetup(
      {
        region: 'cn',
        username: 'runner@example.test',
        sessionTokenFile: '/private/account/session.json',
        confirmIdentity: jest.fn().mockResolvedValue(true),
      },
      { ...dependencies, now, writeSession },
    )

    expect(now).toHaveBeenCalledTimes(1)
    expect(writeSession.mock.calls[0][1].tokens.accessExpiresAtMs)
      .toBe(observedAtMs + 3_600_000)
  })

  it('probes DI from an already captured ticket without exposing secrets', async () => {
    const { http } = successfulFixture('cn')
    const stages: BrowserDiAuthCanaryStage[] = []

    const result = await runCapturedServiceTicketDiCanary(
      {
        region: 'cn',
        serviceTicket: 'ST-ego-browser-ticket',
        onStage: stage => stages.push(stage),
      },
      { http },
    )

    expect(result).toEqual({ ok: true, region: 'cn', persisted: false })
    expect(JSON.stringify(result)).not.toMatch(/ego-browser|access|refresh|token/i)
    expect(stages).toEqual([
      'ticket_captured',
      'di_exchange_started',
      'di_exchange_succeeded',
      'profile_probe_started',
      'profile_probe_succeeded',
    ])
    expect(http.request).toHaveBeenCalledTimes(2)
    expect(http.request.mock.calls.filter(
      ([request]) => request.method === 'POST',
    )).toHaveLength(1)
    expect(http.request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'POST',
      url: 'https://diauth.garmin.cn/di-oauth2-service/oauth/token',
      body: expect.stringContaining('service_ticket=ST-ego-browser-ticket'),
      retry: false,
      followRedirects: false,
    }))
    expect(http.request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'GET',
      url: 'https://connectapi.garmin.cn/userprofile-service/socialProfile',
      retry: false,
      followRedirects: false,
    }))
  })

  it.each([
    undefined,
    '',
    'ticket-without-prefix',
    'ST-',
    'ST-ticket/with-forbidden-character',
    `ST-${'a'.repeat(2046)}`,
  ])('rejects an unusable captured ticket before any HTTP request', async (
    serviceTicket,
  ) => {
    const { http } = successfulFixture()

    await expect(runCapturedServiceTicketDiCanary(
      {
        region: 'global',
        serviceTicket,
      } as Parameters<typeof runCapturedServiceTicketDiCanary>[0],
      { http },
    )).rejects.toThrow(
      'Garmin browser authentication did not return a usable service ticket',
    )

    expect(http.request).not.toHaveBeenCalled()
  })

  it('rejects an invalid captured-ticket region before HTTP', async () => {
    const { http } = successfulFixture()

    await expect(runCapturedServiceTicketDiCanary(
      {
        region: 'staging' as 'global',
        serviceTicket: 'ST-valid-shape',
      },
      { http },
    )).rejects.toThrow('Garmin browser authentication region is invalid')

    expect(http.request).not.toHaveBeenCalled()
  })

  it('fails closed on a pre-aborted captured-ticket probe', async () => {
    const { http } = successfulFixture()
    const controller = new AbortController()
    const stages: BrowserDiAuthCanaryStage[] = []
    controller.abort(new Error('service_ticket=ST-secret abort reason'))

    await expect(runCapturedServiceTicketDiCanary(
      {
        region: 'global',
        serviceTicket: 'ST-one-time-ticket',
        signal: controller.signal,
        onStage: stage => stages.push(stage),
      },
      { http },
    )).rejects.toThrow('Garmin browser authentication was cancelled')

    expect(stages).toEqual([])
    expect(http.request).not.toHaveBeenCalled()
  })

  it('does not retry or fall back after a captured-ticket exchange failure', async () => {
    const { http } = successfulFixture()
    const stages: BrowserDiAuthCanaryStage[] = []
    http.request.mockReset().mockRejectedValueOnce(
      new Error('service_ticket=ST-one-time-ticket token=private'),
    )

    await expect(runCapturedServiceTicketDiCanary(
      {
        region: 'global',
        serviceTicket: 'ST-one-time-ticket',
        onStage: stage => stages.push(stage),
      },
      { http },
    )).rejects.toThrow('Garmin DI token exchange canary failed')

    expect(http.request).toHaveBeenCalledTimes(1)
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      retry: false,
    }))
    expect(stages).toEqual(['ticket_captured', 'di_exchange_started'])
  })

  it('reports a fixed successful stage sequence without carrying response data', async () => {
    const { dependencies } = successfulFixture('cn')
    const stages: BrowserDiAuthCanaryStage[] = []

    await runBrowserDiAuthCanary(
      { region: 'cn', onStage: stage => stages.push(stage) },
      dependencies,
    )

    expect(stages).toEqual([
      'browser_opened',
      'portal_loaded',
      'login_response_seen',
      'ticket_captured',
      'di_exchange_started',
      'di_exchange_succeeded',
      'profile_probe_started',
      'profile_probe_succeeded',
    ])
    expect(stages.join('\n')).not.toMatch(
      /https?:|runner|email|status|body|ST-|access|refresh|token|ticket=/i,
    )
  })

  it('distinguishes login and MFA responses using data-free stages', async () => {
    const { dependencies, browser } = successfulFixture('cn')
    const stages: BrowserDiAuthCanaryStage[] = []
    browser.openAndCapture.mockImplementationOnce(async (options) => {
      options.onStage?.('browser_opened')
      options.onStage?.('portal_loaded')
      await expect(options.onResponse(jsonResponse(
        'https://sso.garmin.cn/portal/api/login',
        { privateStatusDetail: 'MFA_REQUIRED runner@example.test' },
        401,
      ))).resolves.toBe(false)
      await expect(options.onResponse(jsonResponse(
        'https://sso.garmin.cn/portal/api/mfa/verifyCode',
        {
          responseStatus: { type: 'SUCCESSFUL' },
          serviceTicketId: 'ST-mfa-ticket-sso',
        },
      ))).resolves.toBe(true)
    })

    await runBrowserDiAuthCanary(
      { region: 'cn', onStage: stage => stages.push(stage) },
      dependencies,
    )

    expect(stages.slice(0, 5)).toEqual([
      'browser_opened',
      'portal_loaded',
      'login_response_seen',
      'mfa_response_seen',
      'ticket_captured',
    ])
    expect(stages.join('\n')).not.toMatch(/runner@example|MFA_REQUIRED|ST-mfa/i)
  })

  it('drops non-enumerated stages from an injected browser adapter', async () => {
    const { dependencies, browser } = successfulFixture('cn')
    const stages: string[] = []
    browser.openAndCapture.mockImplementationOnce(async (options) => {
      const injectedReporter = options.onStage as unknown as (stage: string) => void
      injectedReporter('ticket=ST-PRIVATE email=runner@example.test')
      injectedReporter('browser_opened')
      await options.onResponse(jsonResponse(
        'https://sso.garmin.cn/portal/api/login',
        {
          responseStatus: { type: 'SUCCESSFUL' },
          serviceTicketId: 'ST-enumerated-stage-test',
        },
      ))
    })

    await runBrowserDiAuthCanary(
      { region: 'cn', onStage: stage => stages.push(stage) },
      dependencies,
    )

    expect(stages).toContain('browser_opened')
    expect(stages.join('\n')).not.toMatch(/PRIVATE|runner@example|ticket=/i)
  })

  it('rejects an invalid runtime region before opening a browser', async () => {
    const { dependencies, browser, http } = successfulFixture()

    await expect(runBrowserDiAuthCanary(
      { region: 'staging' as 'global' },
      dependencies,
    )).rejects.toThrow('Garmin browser authentication region is invalid')

    expect(browser.openAndCapture).not.toHaveBeenCalled()
    expect(http.request).not.toHaveBeenCalled()
  })

  it('probes a global DI session without returning or persisting secrets', async () => {
    const { dependencies, browser, http } = successfulFixture()

    const result = await runBrowserDiAuthCanary(
      { region: 'global' },
      dependencies,
    )

    expect(result).toEqual({ ok: true, region: 'global', persisted: false })
    expect(JSON.stringify(result)).not.toMatch(
      /runner|Private|ST-browser|di-access|di-refresh/i,
    )
    expect(browser.openAndCapture).toHaveBeenCalledWith({
      portalUrl: 'https://sso.garmin.com/portal/sso/en-US/sign-in' +
        '?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp',
      serviceUrl: 'https://connect.garmin.com/app',
      allowedResponseUrls: [
        'https://sso.garmin.com/portal/api/login',
        'https://sso.garmin.com/portal/api/mfa/verifyCode',
      ],
      blockedTicketRedirect: {
        origin: 'https://connect.garmin.com',
        pathname: '/app',
        searchParameter: 'ticket',
      },
      maxObservedResponseBytes: 64 * 1024,
      onResponse: expect.any(Function),
    })
    expect(http.request).toHaveBeenCalledTimes(2)
    expect(http.request).toHaveBeenNthCalledWith(1, {
      method: 'POST',
      url: 'https://diauth.garmin.com/di-oauth2-service/oauth/token',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'en-US,en;q=0.9',
        Authorization:
          'Basic R0FSTUlOX0NPTk5FQ1RfTU9CSUxFX0FORFJPSURfRElfMjAyNVEyOg==',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'GCM-Android-5.23',
        'X-App-Ver': '10861',
        'X-Garmin-Client-Platform': 'Android',
        'X-Garmin-Paired-App-Version': '10861',
        'X-Garmin-User-Agent':
          'com.garmin.android.apps.connectmobile/5.23; ; ' +
          'Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
        'X-GCExperience': 'GC5',
        'X-Lang': 'en',
      },
      body: 'client_id=GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' +
        '&service_ticket=ST-browser-ticket-sso' +
        '&grant_type=https%3A%2F%2Fconnectapi.garmin.com%2F' +
        'di-oauth2-service%2Foauth%2Fgrant%2Fservice_ticket' +
        '&service_url=https%3A%2F%2Fconnect.garmin.com%2Fapp',
      followRedirects: false,
      maxResponseBytes: 64 * 1024,
      retry: false,
      timeoutMs: 30_000,
      useProxy: false,
    })
  })

  it('binds every browser, DI, and API endpoint to the CN region', async () => {
    const { dependencies, browser, http } = successfulFixture('cn')

    await expect(runBrowserDiAuthCanary(
      { region: 'cn' },
      dependencies,
    )).resolves.toEqual({ ok: true, region: 'cn', persisted: false })

    expect(browser.openAndCapture).toHaveBeenCalledWith(expect.objectContaining({
      portalUrl: 'https://sso.garmin.cn/portal/sso/en-US/sign-in' +
        '?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.cn%2Fapp',
      serviceUrl: 'https://connect.garmin.cn/app',
      allowedResponseUrls: [
        'https://sso.garmin.cn/portal/api/login',
        'https://sso.garmin.cn/portal/api/mfa/verifyCode',
      ],
      blockedTicketRedirect: {
        origin: 'https://connect.garmin.cn',
        pathname: '/app',
        searchParameter: 'ticket',
      },
    }))
    expect(http.request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      url: 'https://diauth.garmin.cn/di-oauth2-service/oauth/token',
      body: expect.stringContaining(
        'grant_type=https%3A%2F%2Fconnectapi.garmin.com%2F',
      ),
    }))
    expect(http.request.mock.calls[0][0].body).toContain(
      'service_url=https%3A%2F%2Fconnect.garmin.cn%2Fapp',
    )
    expect(http.request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'GET',
      url: 'https://connectapi.garmin.cn/userprofile-service/socialProfile',
      headers: expect.objectContaining({
        Authorization: 'Bearer di-access-secret',
      }),
      followRedirects: false,
      maxResponseBytes: 256 * 1024,
      retry: false,
      timeoutMs: 30_000,
      useProxy: false,
    }))
  })

  it('reads tickets only from the two exact regional response URLs', async () => {
    const { dependencies, browser, http } = successfulFixture()
    const hostile = jsonResponse(
      'https://attacker.example/portal/api/login',
      {
        responseStatus: { type: 'SUCCESSFUL' },
        serviceTicketId: 'ST-hostile-ticket-sso',
      },
    )
    const lookalike = jsonResponse(
      'https://sso.garmin.com/portal/api/login?forwarded=true',
      {
        responseStatus: { type: 'SUCCESSFUL' },
        serviceTicketId: 'ST-query-ticket-sso',
      },
    )
    const wrongService = jsonResponse(
      'https://sso.garmin.com/portal/api/login' +
        '?clientId=GarminConnect&locale=en-US' +
        '&service=https%3A%2F%2Fconnect.garmin.cn%2Fapp',
      {
        responseStatus: { type: 'SUCCESSFUL' },
        serviceTicketId: 'ST-wrong-region-ticket-sso',
      },
    )
    const duplicateClient = jsonResponse(
      'https://sso.garmin.com/portal/api/login' +
        '?clientId=GarminConnect&clientId=GarminConnect&locale=en-US' +
        '&service=https%3A%2F%2Fconnect.garmin.com%2Fapp',
      {
        responseStatus: { type: 'SUCCESSFUL' },
        serviceTicketId: 'ST-duplicate-query-ticket-sso',
      },
    )
    browser.openAndCapture.mockImplementationOnce(async (options) => {
      await expect(options.onResponse(hostile)).resolves.toBe(false)
      await expect(options.onResponse(lookalike)).resolves.toBe(false)
      await expect(options.onResponse(wrongService)).resolves.toBe(false)
      await expect(options.onResponse(duplicateClient)).resolves.toBe(false)
      await expect(options.onResponse(jsonResponse(
        'https://sso.garmin.com/portal/api/mfa/verifyCode',
        {
          responseStatus: { type: 'SUCCESSFUL' },
          serviceTicketId: 'ST-allowed-ticket-sso',
        },
      ))).resolves.toBe(true)
    })

    await runBrowserDiAuthCanary({ region: 'global' }, dependencies)

    expect(hostile.json).not.toHaveBeenCalled()
    expect(lookalike.json).not.toHaveBeenCalled()
    expect(wrongService.json).not.toHaveBeenCalled()
    expect(duplicateClient.json).not.toHaveBeenCalled()
    expect(http.request.mock.calls[0][0].body).toContain(
      'service_ticket=ST-allowed-ticket-sso',
    )
    expect(http.request.mock.calls[0][0].body).not.toMatch(/hostile|query/)
  })

  it('accepts the exact regional portal query used by Garmin login responses', async () => {
    const { dependencies, browser, http } = successfulFixture('cn')
    browser.openAndCapture.mockImplementationOnce(async (options) => {
      const responseUrl = new URL('https://sso.garmin.cn/portal/api/login')
      responseUrl.searchParams.set('clientId', 'GarminConnect')
      responseUrl.searchParams.set('locale', 'en-US')
      responseUrl.searchParams.set('service', 'https://connect.garmin.cn/app')

      await expect(options.onResponse(jsonResponse(
        responseUrl.toString(),
        {
          responseStatus: { type: 'SUCCESSFUL' },
          serviceTicketId: 'ST-query-ticket-sso',
        },
      ))).resolves.toBe(true)
    })

    await runBrowserDiAuthCanary({ region: 'cn' }, dependencies)

    expect(http.request.mock.calls[0][0].body).toContain(
      'service_ticket=ST-query-ticket-sso',
    )
  })

  it('replaces browser adapter errors with a fixed public message', async () => {
    const { dependencies, browser, http } = successfulFixture()
    browser.openAndCapture.mockRejectedValueOnce(
      new Error('runner@example.test cookie=private-browser-cookie'),
    )

    await expect(runBrowserDiAuthCanary(
      { region: 'global' },
      dependencies,
    )).rejects.toThrow('Garmin browser authentication canary failed')

    expect(http.request).not.toHaveBeenCalled()
  })

  it('sends a captured one-time ticket to DI only once when exchange fails', async () => {
    const { dependencies, http } = successfulFixture()
    http.request.mockReset().mockRejectedValueOnce(
      new Error('service_ticket=ST-browser-ticket-sso access_token=private'),
    )

    await expect(runBrowserDiAuthCanary(
      { region: 'global' },
      dependencies,
    )).rejects.toThrow('Garmin DI token exchange canary failed')

    expect(http.request).toHaveBeenCalledTimes(1)
  })

  it('replaces a malformed HTTP adapter response with the fixed DI error', async () => {
    const { dependencies, http } = successfulFixture()
    http.request.mockReset().mockResolvedValueOnce(undefined)

    await expect(runBrowserDiAuthCanary(
      { region: 'global' },
      dependencies,
    )).rejects.toThrow('Garmin DI token exchange canary failed')

    expect(http.request).toHaveBeenCalledTimes(1)
  })

  it('requires the profile probe to return 2xx JSON without disclosing it', async () => {
    const { dependencies, http } = successfulFixture()
    http.request.mockReset()
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: {
          access_token: 'di-access-secret',
          refresh_token: 'di-refresh-secret',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'text/html',
        body: '<p>runner@example.test session_token=private</p>',
      })

    await expect(runBrowserDiAuthCanary(
      { region: 'global' },
      dependencies,
    )).rejects.toThrow('Garmin DI profile probe failed')

    expect(http.request).toHaveBeenCalledTimes(2)
  })

  it('does not accept a non-application +json media type for the profile', async () => {
    const { dependencies, http } = successfulFixture()
    http.request.mockReset()
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'application/json',
        body: {
          access_token: 'di-access-secret',
          refresh_token: 'di-refresh-secret',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'text/not-really+json',
        body: { displayName: 'Private Runner' },
      })

    await expect(runBrowserDiAuthCanary(
      { region: 'global' },
      dependencies,
    )).rejects.toThrow('Garmin DI profile probe failed')
  })

  it('rejects oversized DI credentials before probing the profile', async () => {
    const { dependencies, http } = successfulFixture()
    http.request.mockReset().mockResolvedValueOnce({
      status: 200,
      contentType: 'application/json',
      body: {
        access_token: `access-${'a'.repeat(16 * 1024)}`,
        refresh_token: 'di-refresh-secret',
      },
    })

    await expect(runBrowserDiAuthCanary(
      { region: 'global' },
      dependencies,
    )).rejects.toThrow('Garmin DI token exchange canary failed')

    expect(http.request).toHaveBeenCalledTimes(1)
  })
})
