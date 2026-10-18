export {}

const { peerDependencies } = require('../package.json') as {
  peerDependencies: Record<string, string>
}
const satisfies = require('semver').satisfies as (
  version: string, range: string, options: { includePrerelease: boolean },
) => boolean

const supportedVersions = [
  '0.1.0-rc.6',
  '0.1.1-rc.1',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
  '0.2.1-rc.99',
  '0.2.1',
]
const unsupportedVersions = [
  '0.2.1-rc.0',
  '0.2.2-rc.1',
  '0.2.2',
  '0.3.0-rc.1',
  '0.3.0',
  '1.0.0',
]

describe.each([
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-layout',
])('%s compatibility', sdk => {
  it('accepts supported SDK releases and later 0.2.1 release candidates', () => {
    expect(supportedVersions.map(version => ({
      version,
      supported: satisfies(version, peerDependencies[sdk], { includePrerelease: true }),
    }))).toEqual(supportedVersions.map(version => ({ version, supported: true })))
  })

  it('rejects SDK versions outside the verified release line', () => {
    expect(unsupportedVersions.map(version => ({
      version,
      supported: satisfies(version, peerDependencies[sdk], { includePrerelease: true }),
    }))).toEqual(unsupportedVersions.map(version => ({ version, supported: false })))
  })
})
