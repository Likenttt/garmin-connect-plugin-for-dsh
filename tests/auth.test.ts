import {
  authenticateGarminSession,
  type GarminAuthDependencies,
} from '../src/auth'

const OAUTH1 = {
  oauth_token: 'oauth-one',
  oauth_token_secret: 'oauth-secret',
}
const OAUTH2 = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
}

function fixture(loginHtml: string, mfaHtml?: string) {
  const get = jest.fn()
    .mockResolvedValueOnce({ data: '<html>embed</html>' })
    .mockResolvedValueOnce({
      data: '<input name="_csrf" value="signin-csrf">',
    })
    .mockResolvedValueOnce({
      data: { consumer_key: 'consumer-key', consumer_secret: 'consumer-secret' },
    })
  const post = jest.fn()
    .mockResolvedValueOnce({ data: loginHtml })
  if (mfaHtml !== undefined) post.mockResolvedValueOnce({ data: mfaHtml })

  const upstream = {
    client: { defaults: {} as Record<string, unknown> },
    OAUTH_CONSUMER: undefined as { key: string; secret: string } | undefined,
    getOauth1Token: jest.fn().mockResolvedValue({ token: OAUTH1, oauth: {} }),
    exchange: jest.fn().mockResolvedValue(undefined),
    oauth1Token: OAUTH1,
    oauth2Token: OAUTH2,
  }
  const garmin = {
    client: upstream,
    exportToken: jest.fn(() => ({ oauth1: OAUTH1, oauth2: OAUTH2 })),
    getUserProfile: jest.fn().mockResolvedValue({ displayName: 'runner' }),
  }
  const dependencies: GarminAuthDependencies = {
    createSsoClient: jest.fn(() => ({ get, post }) as any),
    createGarminClient: jest.fn(() => garmin as any),
    wait: jest.fn().mockResolvedValue(undefined),
    random: jest.fn(() => 0),
  }
  return { dependencies, get, post, upstream, garmin }
}

describe('interactive Garmin authentication', () => {
  it('exchanges a normal SSO ticket for the existing OAuth1/OAuth2 token format', async () => {
    const { dependencies, get, post, upstream, garmin } = fixture(
      '<title>Success</title><a href="embed?ticket=ST-NORMAL">continue</a>',
    )
    const promptMfa = jest.fn()

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa,
    }, dependencies)).resolves.toEqual({
      tokens: { oauth1: OAUTH1, oauth2: OAUTH2 },
      displayName: 'runner',
      usedMfa: false,
    })

    expect(promptMfa).not.toHaveBeenCalled()
    expect(get).toHaveBeenNthCalledWith(
      1,
      'https://sso.garmin.com/sso/embed',
      expect.objectContaining({
        params: expect.objectContaining({
          clientId: 'GarminConnect',
          locale: 'en',
          service: 'https://connect.garmin.com/modern',
        }),
      }),
    )
    expect(get).toHaveBeenNthCalledWith(
      2,
      'https://sso.garmin.com/sso/signin',
      expect.objectContaining({
        params: expect.objectContaining({
          id: 'gauth-widget',
          locale: 'en',
          gauthHost: 'https://sso.garmin.com/sso/embed',
        }),
      }),
    )
    expect(post).toHaveBeenCalledTimes(1)
    expect(upstream.getOauth1Token).toHaveBeenCalledWith('ST-NORMAL')
    expect(upstream.OAUTH_CONSUMER).toEqual({
      key: 'consumer-key',
      secret: 'consumer-secret',
    })
    expect(upstream.client.defaults).toMatchObject({
      timeout: 30_000,
      maxContentLength: 5 * 1024 * 1024,
    })
    expect(upstream.exchange).toHaveBeenCalledWith({ token: OAUTH1, oauth: {} })
    expect(garmin.exportToken).toHaveBeenCalledTimes(1)
  })

  it('accepts a returned ticket before considering stale MFA page markers', async () => {
    const { dependencies, post, upstream } = fixture([
      '<title>Enter MFA code for login</title>',
      '<input name="_csrf" value="stale-csrf">',
      '<script>var mfaMethod = "email"; var codeSentTo = "***";</script>',
      '<a href="embed?ticket=ST-ALREADY-AUTHENTICATED">continue</a>',
    ].join(''))
    const promptMfa = jest.fn().mockResolvedValue('123456')

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa,
    }, dependencies)).resolves.toMatchObject({ usedMfa: false })

    expect(promptMfa).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
    expect(upstream.getOauth1Token).toHaveBeenCalledWith('ST-ALREADY-AUTHENTICATED')
  })

  it('requests an email code when Garmin has not sent one, then submits manual input', async () => {
    const mfaPage = [
      '<title>GARMIN Authentication Application</title>',
      '<input name="_csrf" value="mfa-csrf">',
      '<script>',
      'var customerGuid = "guid-1";',
      'var mfaMethod = "email";',
      'var locale = "en";',
      'var clientId = "GarminConnect";',
      'var codeSentTo = "";',
      '</script>',
    ].join('')
    const { dependencies, post, upstream } = fixture(
      mfaPage,
      '<title>Success</title><a href="embed?ticket=ST-MFA">continue</a>',
    )
    // The explicit delivery request sits between sign-in and verification.
    post.mockReset()
      .mockResolvedValueOnce({ data: mfaPage })
      .mockResolvedValueOnce({ data: { sent: true } })
      .mockResolvedValueOnce({
        data: '<title>Success</title><a href="embed?ticket=ST-MFA">continue</a>',
      })
    const promptMfa = jest.fn().mockResolvedValue(' 123456 ')

    const result = await authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa,
    }, dependencies)

    expect(result.usedMfa).toBe(true)
    expect(promptMfa).toHaveBeenCalledWith({ method: 'email' })
    expect(post).toHaveBeenNthCalledWith(
      2,
      'https://sso.garmin.com/sso/verifyMFA/mfaCode',
      expect.objectContaining({
        customerGuid: 'guid-1',
        mfaMethod: 'email',
        locale: 'en',
      }),
      expect.objectContaining({ params: { clientId: 'GarminConnect' } }),
    )
    const verificationBody = String(post.mock.calls[2][1])
    expect(verificationBody).toContain('mfa-code=123456')
    expect(verificationBody).not.toContain('password-secret')
    expect(upstream.getOauth1Token).toHaveBeenCalledWith('ST-MFA')
  })

  it('does not request another code when Garmin reports an existing delivery target', async () => {
    const mfaPage = [
      '<title>Enter MFA code for login</title>',
      '<input name="_csrf" value="mfa-csrf">',
      '<script>',
      'var mfaMethod = "sms";',
      'var codeSentTo = "***1234";',
      '</script>',
    ].join('')
    const { dependencies, post } = fixture(
      mfaPage,
      '<title>Success</title><a href="?ticket=ST-SMS">continue</a>',
    )

    await authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'cn',
      promptMfa: async () => '654321',
    }, dependencies)

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1][0]).toBe(
      'https://sso.garmin.cn/sso/verifyMFA/loginEnterMfaCode',
    )
  })

  it('does not mistake the generic Garmin authentication page for an MFA challenge', async () => {
    const { dependencies, post } = fixture([
      '<title>GARMIN Authentication Application</title>',
      '<form action="/sso/signin">',
      '<input name="username">',
      '<input name="password">',
      '</form>',
    ].join(''))
    const promptMfa = jest.fn().mockResolvedValue('123456')

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'cn',
      promptMfa,
    }, dependencies)).rejects.toThrow('Garmin authentication failed')

    expect(promptMfa).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('reports browser verification without prompting for an MFA code', async () => {
    const { dependencies, post } = fixture([
      '<title>GARMIN Authentication Application</title>',
      '<div class="g-recaptcha" data-sitekey="public-site-key"></div>',
    ].join(''))
    const promptMfa = jest.fn().mockResolvedValue('123456')

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'cn',
      promptMfa,
    }, dependencies)).rejects.toThrow(
      'Open Garmin Connect in a browser and complete the verification, then retry; automatic browser authentication is not yet supported',
    )

    expect(promptMfa).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('does not infer a browser challenge from an unused CAPTCHA variable', async () => {
    const { dependencies } = fixture([
      '<title>GARMIN Authentication Application</title>',
      '<script>const captchaToken = "";</script>',
    ].join(''))

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa: async () => '123456',
    }, dependencies)).rejects.toThrow('Garmin authentication failed')
  })

  it('does not trust an MFA-looking title without challenge fields', async () => {
    const { dependencies, post, upstream } = fixture(
      '<title>MFA service unavailable</title><p>Please try again later.</p>',
    )
    const promptMfa = jest.fn().mockResolvedValue('123456')

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa,
    }, dependencies)).rejects.toThrow('Garmin authentication failed')

    expect(promptMfa).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
    expect(upstream.getOauth1Token).not.toHaveBeenCalled()
  })

  it('recognizes MFA metadata declared with modern JavaScript syntax', async () => {
    const mfaPage = [
      '<title>GARMIN Authentication Application</title>',
      '<input name="_csrf" value="mfa-csrf">',
      '<script>const mfaMethod = "totp"</script>',
    ].join('')
    const { dependencies, post } = fixture(
      mfaPage,
      '<title>Success</title><a href="?ticket=ST-MODERN-MFA">continue</a>',
    )
    const promptMfa = jest.fn().mockResolvedValue('123456')

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa,
    }, dependencies)).resolves.toMatchObject({ usedMfa: true })

    expect(promptMfa).toHaveBeenCalledWith({ method: 'totp' })
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('does not request an email code with incomplete delivery metadata', async () => {
    const mfaPage = [
      '<title>GARMIN Authentication Application</title>',
      '<input name="_csrf" value="mfa-csrf">',
      '<script>var mfaMethod = "email"; var codeSentTo = "";</script>',
    ].join('')
    const { dependencies, post, upstream } = fixture(mfaPage)
    const promptMfa = jest.fn().mockResolvedValue('123456')

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa,
    }, dependencies)).rejects.toThrow('Garmin authentication failed')

    expect(promptMfa).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
    expect(upstream.getOauth1Token).not.toHaveBeenCalled()
  })

  it('rejects empty MFA input without sending it', async () => {
    const mfaPage = [
      '<title>Enter MFA code for login</title>',
      '<input name="_csrf" value="mfa-csrf">',
      '<script>var mfaMethod = "totp";</script>',
    ].join('')
    const { dependencies, post } = fixture(mfaPage)

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa: async () => '   ',
    }, dependencies)).rejects.toThrow('MFA code is required')

    expect(post).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected MFA code without exposing the returned page', async () => {
    const marker = 'PRIVATE_MFA_RESPONSE'
    const mfaPage = [
      '<title>Enter MFA code for login</title>',
      '<input name="_csrf" value="mfa-csrf">',
      '<input name="mfa-code">',
      `<p>${marker}</p>`,
    ].join('')
    const { dependencies, upstream } = fixture(mfaPage, mfaPage)

    const promise = authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa: async () => '123456',
    }, dependencies)

    await expect(promise).rejects.toThrow(
      'Garmin did not accept the MFA code; request a new code and try again',
    )
    await expect(promise).rejects.not.toThrow(marker)
    expect(upstream.getOauth1Token).not.toHaveBeenCalled()
  })

  it('reports a rejected MFA code when Garmin returns a generic sign-in page', async () => {
    const mfaPage = [
      '<title>Enter MFA code for login</title>',
      '<input name="_csrf" value="mfa-csrf">',
      '<input name="mfa-code">',
    ].join('')
    const genericPage = [
      '<title>GARMIN Authentication Application</title>',
      '<form action="/sso/signin"><input name="username"></form>',
    ].join('')
    const { dependencies, upstream } = fixture(mfaPage, genericPage)

    await expect(authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa: async () => '123456',
    }, dependencies)).rejects.toThrow(
      'Garmin did not accept the MFA code; request a new code and try again',
    )

    expect(upstream.getOauth1Token).not.toHaveBeenCalled()
  })

  it('reports a rejected MFA code when Garmin rejects the verification request', async () => {
    const mfaPage = [
      '<title>Enter MFA code for login</title>',
      '<input name="_csrf" value="mfa-csrf">',
      '<input name="mfa-code">',
    ].join('')
    const { dependencies, post, upstream } = fixture(mfaPage)
    post.mockReset()
      .mockResolvedValueOnce({ data: mfaPage })
      .mockRejectedValueOnce({
        response: { status: 401, data: 'PRIVATE_REJECTION_RESPONSE' },
        config: { data: 'mfa-code=123456' },
      })

    const promise = authenticateGarminSession({
      username: 'runner@example.test',
      password: 'password-secret',
      region: 'global',
      promptMfa: async () => '123456',
    }, dependencies)

    await expect(promise).rejects.toThrow(
      'Garmin did not accept the MFA code; request a new code and try again',
    )
    await expect(promise).rejects.not.toThrow('PRIVATE_REJECTION_RESPONSE')
    await expect(promise).rejects.not.toThrow('123456')
    expect(upstream.getOauth1Token).not.toHaveBeenCalled()
  })

  it('returns a fixed public failure without echoing credentials or Garmin HTML', async () => {
    const marker = 'VERY_SECRET_PASSWORD'
    const { dependencies } = fixture(
      `<title>Unexpected ${marker}</title><body>private health response</body>`,
    )

    const promise = authenticateGarminSession({
      username: 'private@example.test',
      password: marker,
      region: 'global',
      promptMfa: async () => '123456',
    }, dependencies)

    await expect(promise).rejects.toThrow('Garmin authentication failed')
    await expect(promise).rejects.not.toThrow(marker)
    await expect(promise).rejects.not.toThrow('private health response')
  })
})
