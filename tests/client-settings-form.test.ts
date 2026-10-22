import {
  accountRegionForProvider,
  removeAccountMutations,
  saveAccountMutations,
  type GarminStoredAccount,
} from '../src/client/harness-config-form'

const legacy: GarminStoredAccount = {
  id: 'legacy-cn', region: 'cn', alias: '', slot: 1,
}
const second: GarminStoredAccount = {
  id: 'a0123456789abcdefabcd', region: 'cn', alias: '第二个国内账号', slot: 3,
}
const revision = 'a'.repeat(32)

describe('Garmin settings account writes', () => {
  it('adds another account in the same region with an ID-bound secret', () => {
    expect(saveAccountMutations([legacy], second, 'runner@example.test', revision)).toEqual([
      { op: 'set', path: ['accounts'], value: [legacy, { ...second, revision }] },
      { op: 'set', path: ['accountsConfigured'], value: true },
      { op: 'set', path: ['account3Username'], value: 'runner@example.test' },
      { op: 'set', path: ['account3UsernameId'], value: second.id },
    ])
  })

  it('preserves the saved email when changing only alias or region', () => {
    const changed = { ...second, alias: '新别名', region: 'global' as const }
    expect(saveAccountMutations([legacy, second], changed, '', revision)).toEqual([
      { op: 'set', path: ['accounts'], value: [legacy, { ...changed, revision }] },
      { op: 'set', path: ['accountsConfigured'], value: true },
    ])
  })

  it('does not create an account without an email or exceed five slots', () => {
    expect(saveAccountMutations([legacy], second, '', revision)).toBeUndefined()
    const five = [1, 2, 3, 4, 5].map(slot => ({
      id: `a${slot}`,
      region: 'global' as const,
      alias: '',
      slot,
    }))
    expect(saveAccountMutations(five, { id: 'a6', region: 'cn', alias: '', slot: 1 }, 'runner@example.test', revision))
      .toBeUndefined()
  })

  it('never writes a masked email hint as an account secret', () => {
    expect(saveAccountMutations([legacy, second], second, 'chu****@88.com', revision)).toBeUndefined()
  })

  it('requires a fresh random revision for each saved account update', () => {
    expect(saveAccountMutations([legacy], second, 'runner@example.test', 'not-a-revision'))
      .toBeUndefined()
    const current = { ...second, revision }
    expect(saveAccountMutations([legacy, current], current, '', revision)).toBeUndefined()
  })

  it('stops legacy fallback and clears the removed slot binding', () => {
    expect(removeAccountMutations([legacy], legacy.id)).toEqual([
      { op: 'set', path: ['accounts'], value: [] },
      { op: 'set', path: ['accountsConfigured'], value: true },
      { op: 'set', path: ['account1Username'], value: '' },
      { op: 'set', path: ['account1UsernameId'], value: '' },
      { op: 'set', path: ['account1PersonalApiKey'], value: '' },
      { op: 'set', path: ['account1PersonalApiKeyId'], value: '' },
    ])
  })

  it('saves a Personal API account with an ID-bound private key and no email', () => {
    const personal = { ...second, region: 'global' as const, provider: 'personal' as const }
    const mutations = saveAccountMutations([legacy], personal, '', revision, 'test-private-key')!
    expect(mutations).toContainEqual({ op: 'set', path: ['account3PersonalApiKey'], value: 'test-private-key' })
    expect(mutations).toContainEqual({ op: 'set', path: ['account3PersonalApiKeyId'], value: personal.id })
    const publicAccounts = mutations.find(operation => operation.path[0] === 'accounts')
    expect(JSON.stringify(publicAccounts)).not.toContain('test-private-key')
    expect(mutations).toContainEqual({ op: 'set', path: ['account3Username'], value: '' })
    expect(saveAccountMutations([legacy], personal, '', revision)).toBeUndefined()
  })

  it('preserves a Personal API key on an alias-only edit and requires a new key when switching provider', () => {
    const personal = { ...second, provider: 'personal' as const }
    const writes = saveAccountMutations([personal], { ...personal, alias: 'My watch' }, '', revision)!
    expect(writes.some(operation => operation.path[0] === 'account3PersonalApiKey')).toBe(false)
    expect(saveAccountMutations([second], personal, '', revision)).toBeUndefined()
    expect(saveAccountMutations([personal], second, '', revision)).toBeUndefined()
    expect(saveAccountMutations([personal], second, 'web@example.test', revision)).toContainEqual({
      op: 'set', path: ['account3PersonalApiKey'], value: '',
    })
  })

  it('requires a nonempty alias on Personal account creation and edits', () => {
    const personal = { ...second, region: 'global' as const, provider: 'personal' as const }
    expect(saveAccountMutations([legacy], { ...personal, alias: '  ' }, '', revision, 'new-key'))
      .toBeUndefined()
    expect(saveAccountMutations([personal], { ...personal, alias: '' }, '', revision))
      .toBeUndefined()
    const normalized = saveAccountMutations([personal], { ...personal, alias: '  Main watch  ' }, '', revision)!
    expect(normalized).toContainEqual({
      op: 'set', path: ['accounts'], value: [{ ...personal, alias: 'Main watch', revision }],
    })
  })

  it('lets a legacy Personal account with no alias be repaired or removed', () => {
    const oldPersonal = { ...second, alias: '', provider: 'personal' as const }
    expect(saveAccountMutations([oldPersonal], oldPersonal, '', revision, 'replacement-key'))
      .toBeUndefined()
    expect(saveAccountMutations([oldPersonal], { ...oldPersonal, alias: '大陆测试' }, '', revision))
      .toBeDefined()
    expect(removeAccountMutations([oldPersonal], oldPersonal.id)).toBeDefined()
    expect(saveAccountMutations([oldPersonal], { ...second, id: 'a-new', slot: 4 }, 'web@example.test', revision))
      .toBeDefined()
  })

  it('locks saved Personal keys to their original endpoint even when a new key is supplied', () => {
    for (const region of ['cn', 'global'] as const) {
      const personal = { ...second, region, provider: 'personal' as const }
      const wrongRegion = region === 'cn' ? 'global' : 'cn'
      expect(saveAccountMutations([personal], { ...personal, region: wrongRegion }, '', revision))
        .toBeUndefined()
      expect(saveAccountMutations([personal], { ...personal, region: wrongRegion }, '', revision, 'replacement-key'))
        .toBeUndefined()
      expect(saveAccountMutations([personal], { ...personal, alias: 'Renamed' }, '', revision, 'replacement-key'))
        .toContainEqual({ op: 'set', path: ['accounts'], value: [{ ...personal, alias: 'Renamed', revision }] })
    }
  })

  it('creates new Personal accounts only on global with a new key', () => {
    const personal = { ...second, provider: 'personal' as const }
    expect(saveAccountMutations([], personal, '', revision, 'cn-key')).toBeUndefined()
    expect(saveAccountMutations([second], personal, '', revision, 'cn-key')).toBeUndefined()
    const globalPersonal = { ...personal, region: 'global' as const }
    expect(saveAccountMutations([second], globalPersonal, '', revision)).toBeUndefined()
    expect(saveAccountMutations([second], globalPersonal, '', revision, 'global-key'))
      .toContainEqual({ op: 'set', path: ['accounts'], value: [{ ...globalPersonal, revision }] })
  })

  it('derives Personal endpoint from saved metadata rather than draft web region', () => {
    const savedCnPersonal = { ...second, provider: 'personal' as const }
    expect(accountRegionForProvider(savedCnPersonal, 'personal', 'global')).toBe('cn')
    expect(accountRegionForProvider(savedCnPersonal, 'connect-web', 'global')).toBe('global')
    expect(accountRegionForProvider(savedCnPersonal, 'personal', 'global')).toBe('cn')
    expect(accountRegionForProvider(second, 'personal', 'cn')).toBe('global')
    expect(accountRegionForProvider({ ...second, region: 'global', provider: 'personal' }, 'personal', 'cn'))
      .toBe('global')
  })

})
