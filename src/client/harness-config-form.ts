/**
 * The narrow config-form contract provided by Harness 0.1.7's settings client.
 * Kept local so older Harness peer packages can still install this plugin.
 */
export type ConfigMutation = {
  op: 'set'
  path: readonly string[]
  value: unknown
} | {
  op: 'unset'
  path: readonly string[]
}

export interface ConfigFormSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

export interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ConfigMutation[], expectedRevision?: number): Promise<boolean>
}

export interface ConfigForms {
  get<T>(entryId: string): ConfigForm<T>
  // Current Harness exposes a mirror refresh method at runtime. Keep it
  // optional because older settings clients do not publish this method.
  describe(): { load?(): Promise<void> }
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}

export interface GarminStoredAccount {
  id: string
  region: 'cn' | 'global'
  alias: string
  slot: number
  /** Public nonce identifying this saved account configuration. */
  revision?: string
}

/** Update public metadata atomically with an optional new secret email. */
export function saveAccountMutations(
  current: readonly GarminStoredAccount[],
  account: GarminStoredAccount,
  email: string,
  revision: string,
): ConfigMutation[] | undefined {
  const previous = current.find(value => value.id === account.id)
  const saved = { ...account, revision }
  const next = previous
    ? current.map(value => value.id === account.id ? saved : value)
    : [...current, saved]
  // A masked display hint must never replace the secret account email.
  if (!/^[0-9a-f]{32}$/.test(revision)
    || revision === previous?.revision
    || !validAccounts(next)
    || (!previous && !email)
    || email.includes('****@')) return undefined
  return [
    { op: 'set', path: ['accounts'], value: next },
    { op: 'set', path: ['accountsConfigured'], value: true },
    ...(email ? [
      { op: 'set' as const, path: [`account${account.slot}Username`], value: email },
      { op: 'set' as const, path: [`account${account.slot}UsernameId`], value: account.id },
    ] : []),
  ]
}

/** Explicit empty metadata prevents a removed legacy account from reappearing. */
export function removeAccountMutations(
  current: readonly GarminStoredAccount[],
  accountId: string,
): ConfigMutation[] | undefined {
  const removed = current.find(value => value.id === accountId)
  if (!removed || !validAccounts(current)) return undefined
  return [
    { op: 'set', path: ['accounts'], value: current.filter(value => value.id !== accountId) },
    { op: 'set', path: ['accountsConfigured'], value: true },
    { op: 'set', path: [`account${removed.slot}Username`], value: '' },
    { op: 'set', path: [`account${removed.slot}UsernameId`], value: '' },
  ]
}

function validAccounts(accounts: readonly GarminStoredAccount[]): boolean {
  if (accounts.length > 5) return false
  const ids = new Set<string>()
  const slots = new Set<number>()
  for (const account of accounts) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(account.id)
      || (account.region !== 'cn' && account.region !== 'global')
      || typeof account.alias !== 'string'
      || account.alias.length > 64
      || /[\u0000-\u001f\u007f-\u009f]/.test(account.alias)
      || !Number.isSafeInteger(account.slot)
      || account.slot < 1
      || account.slot > 5
      || (account.revision !== undefined && !/^[0-9a-f]{32}$/.test(account.revision))
      || ids.has(account.id)
      || slots.has(account.slot)) return false
    ids.add(account.id)
    slots.add(account.slot)
  }
  return true
}
