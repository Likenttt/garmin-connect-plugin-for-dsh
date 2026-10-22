import {
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
    const personal = { ...second, provider: 'personal' as const }
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

})
