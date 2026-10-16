export {}

const { validateSdkDependency } = require('../scripts/check-sdk-dependency.cjs') as {
  validateSdkDependency(input?: {
    manifest?: unknown
    sdkPackage?: unknown
    GarminConnect?: unknown
    methods?: unknown
  }): {
    ok: boolean
    dependencySource: string
    methodCount: number
    missingMethodCount: number
    errors: string[]
  }
}

const ownGit = `git+https://github.com/Likenttt/garmin-connect.git#${'a'.repeat(40)}`
const methods = [
  'getHrvData', 'getHrvSummaries', 'getStressData', 'getStressSummaries',
  'getBodyBattery', 'getTrainingReadiness', 'getDailyTrainingStatus',
  'getTrainingStatus', 'getTrainingLoadBalance', 'getMaxMetrics',
  'getMaxMetricsRange', 'getRacePredictions', 'getRacePredictionsRange',
]

function fixture(dependency = ownGit) {
  class MaintainedSdk {}
  for (const method of methods) Object.defineProperty(MaintainedSdk.prototype, method, {
    value: jest.fn(), configurable: true,
  })
  return {
    manifest: { dependencies: { 'garmin-connect': dependency } },
    sdkPackage: {
      name: '@likenttt/garmin-connect', version: '1.7.0',
      repository: { type: 'git', url: 'git+https://github.com/Likenttt/garmin-connect.git' },
    },
    GarminConnect: MaintainedSdk,
    methods: [...methods],
  }
}

describe('maintained SDK release dependency gate', () => {
  it('accepts an immutable own-repository SHA and checks methods without invoking them', () => {
    const input = fixture()
    expect(validateSdkDependency(input)).toEqual({
      ok: true, dependencySource: 'maintained-git-sha', methodCount: 13,
      missingMethodCount: 0, errors: [],
    })
    for (const method of methods) {
      expect((input.GarminConnect.prototype as any)[method]).not.toHaveBeenCalled()
    }
  })

  it('accepts an exact scoped npm alias whose installed version matches', () => {
    expect(validateSdkDependency(fixture('npm:@likenttt/garmin-connect@1.7.0')))
      .toMatchObject({ ok: true, dependencySource: 'maintained-npm-exact' })
  })

  it.each([
    '1.6.2',
    'file:../garmin-connect',
    'npm:garmin-connect@1.6.2',
    'npm:@likenttt/garmin-connect@^1.7.0',
    'npm:@likenttt/garmin-connect@latest',
    'git+https://github.com/Likenttt/garmin-connect.git#codex/health-recovery-apis',
    'git+https://github.com/Likenttt/garmin-connect.git#abcdef0',
    `git+https://github.com/Pythe1337N/garmin-connect.git#${'a'.repeat(40)}`,
    `${ownGit}?unexpected=true`,
  ])('rejects upstream, temporary or floating dependency %s', dependency => {
    expect(validateSdkDependency(fixture(dependency))).toMatchObject({
      ok: false, errors: expect.arrayContaining([
        'DEPENDENCY_MUST_PIN_OWN_GIT_SHA_OR_EXACT_SCOPED_NPM_VERSION',
      ]),
    })
  })

  it('rejects an installed upstream package even when the dependency spec is correct', () => {
    const input = fixture()
    input.sdkPackage.name = 'garmin-connect'
    input.sdkPackage.version = '1.6.2'
    expect(validateSdkDependency(input)).toMatchObject({
      ok: false, errors: expect.arrayContaining(['SDK_PACKAGE_NAME_MISMATCH']),
    })
  })

  it.each([
    'git+https://github.com/Pythe1337N/garmin-connect.git',
    'https://github.com/Likenttt/garmin-connect-other',
    'https://github.com.evil.test/Likenttt/garmin-connect',
    'https://github.com/Likenttt/garmin-connect/tree/main',
  ])('rejects repository mismatches rather than substring matching %s', url => {
    const input = fixture()
    input.sdkPackage.repository.url = url
    expect(validateSdkDependency(input)).toMatchObject({
      ok: false, errors: expect.arrayContaining(['SDK_REPOSITORY_MISMATCH']),
    })
  })

  it('rejects an npm alias whose installed version differs from the pinned release', () => {
    const input = fixture('npm:@likenttt/garmin-connect@1.7.1')
    expect(validateSdkDependency(input)).toMatchObject({
      ok: false, errors: expect.arrayContaining(['SDK_ALIAS_VERSION_MISMATCH']),
    })
  })

  it('rejects missing SDK methods and counts non-functions as missing', () => {
    const input = fixture()
    delete (input.GarminConnect.prototype as any).getHrvData
    Object.defineProperty(input.GarminConnect.prototype, 'getStressData', { value: 'unsupported' })
    expect(validateSdkDependency(input)).toMatchObject({
      ok: false, missingMethodCount: 2,
      errors: expect.arrayContaining(['SDK_HEALTH_METHODS_MISSING']),
    })
  })

  it('rejects absent or duplicated catalogs instead of vacuously accepting zero methods', () => {
    expect(validateSdkDependency()).toMatchObject({ ok: false })
    for (const catalog of [[], Array(13).fill('getHrvData')]) {
      expect(validateSdkDependency({ ...fixture(), methods: catalog })).toMatchObject({
        ok: false, errors: expect.arrayContaining(['HEALTH_METHOD_CATALOG_INVALID']),
      })
    }
  })

  it('returns fixed reason codes without echoing untrusted dependency metadata', () => {
    const input = fixture('file:/private/secret-location')
    input.sdkPackage.name = 'private@example.test'
    input.sdkPackage.repository.url = 'https://secret-token@example.test/private-repo'
    const result = JSON.stringify(validateSdkDependency(input))
    for (const secret of ['secret-location', 'private@', 'secret-token', 'private-repo']) {
      expect(result).not.toContain(secret)
    }
  })
})
