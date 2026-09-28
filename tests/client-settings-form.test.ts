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
    ])
  })
})
