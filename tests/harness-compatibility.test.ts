export {}

const { peerDependencies, devDependencies } = require('../package.json') as {
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}
const satisfies = require('semver').satisfies as (
  version: string, range: string, options?: { includePrerelease: boolean },
) => boolean

const acceptedVersions = [
  '0.1.0-rc.6',
  '0.1.1-rc.1',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
  '0.2.1-rc.5',
  '0.2.1-rc.99',
  '0.2.1',
  '0.2.2-rc.1',
  '0.2.2-rc.99',
  '0.2.2',
  '0.2.2-0',
  '0.2.2-alpha.3',
  '0.2.2-rc.0',
  '0.2.3-rc.1',
  '0.2.3',
  '0.3.0-rc.1',
  '0.3.0',
  '0.9.0-beta.1',
  '0.99.0',
]
const rejectedVersions = [
  '0.0.9',
  '0.2.1-rc.0',
  '1.0.0-0',
  '1.0.0-alpha.1',
  '1.0.0-rc.1',
  '1.0.0',
  '2.0.0',
]

describe.each([
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-layout',
])('%s compatibility', sdk => {
  it('accepts the pinned development SDK with npm default prerelease rules', () => {
    expect(satisfies(devDependencies[sdk], peerDependencies[sdk])).toBe(true)
  })

  it('preserves existing releases and permits future 0.x versions including prereleases', () => {
    expect(acceptedVersions.map(version => ({
      version,
      supported: satisfies(version, peerDependencies[sdk], { includePrerelease: true }),
    }))).toEqual(acceptedVersions.map(version => ({ version, supported: true })))
  })

  it('keeps the minimum-version and next-major boundaries', () => {
    expect(rejectedVersions.map(version => ({
      version,
      supported: satisfies(version, peerDependencies[sdk], { includePrerelease: true }),
    }))).toEqual(rejectedVersions.map(version => ({ version, supported: false })))
  })
})

it('retains the core runtime major-version boundaries', () => {
  expect(satisfies('4.1.0', peerDependencies['@deepseek-ai/cordis'], { includePrerelease: true })).toBe(true)
  expect(satisfies('5.0.0', peerDependencies['@deepseek-ai/cordis'], { includePrerelease: true })).toBe(false)
  expect(satisfies('19.0.0', peerDependencies.react, { includePrerelease: true })).toBe(false)
})
