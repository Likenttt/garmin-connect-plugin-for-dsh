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

describe('Garmin settings account writes', () => {
  it('adds another account in the same region with an ID-bound secret', () => {
    expect(saveAccountMutations([legacy], second, 'runner@example.test')).toEqual([
      { op: 'set', path: ['accounts'], value: [legacy, second] },
      { op: 'set', path: ['accountsConfigured'], value: true },
      { op: 'set', path: ['account3Username'], value: 'runner@example.test' },
      { op: 'set', path: ['account3UsernameId'], value: second.id },
    ])
  })

  it('preserves the saved email when changing only alias or region', () => {
    const changed = { ...second, alias: '新别名', region: 'global' as const }
    expect(saveAccountMutations([legacy, second], changed, '')).toEqual([
      { op: 'set', path: ['accounts'], value: [legacy, changed] },
      { op: 'set', path: ['accountsConfigured'], value: true },
    ])
  })

  it('does not create an account without an email or exceed five slots', () => {
    expect(saveAccountMutations([legacy], second, '')).toBeUndefined()
    const five = [1, 2, 3, 4, 5].map(slot => ({
      id: `a${slot}`,
      region: 'global' as const,
      alias: '',
      slot,
    }))
    expect(saveAccountMutations(five, { id: 'a6', region: 'cn', alias: '', slot: 1 }, 'runner@example.test'))
      .toBeUndefined()
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
