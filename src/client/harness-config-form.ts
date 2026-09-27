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
  describe(): { load(): Promise<unknown> }
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}
