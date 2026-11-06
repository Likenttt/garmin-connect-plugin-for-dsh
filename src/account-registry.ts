import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { defaultAccountSessionPath } from './account-session'
import type { Config, GarminProvider, GarminRegion, ResolvedAccountConfig } from './config'
import type { GarminClientLike } from './client'
import { PublicToolError } from './utils/errors'
import { AccountCatalog, AccountRegistryError, type CatalogAccount, type CatalogCredentials } from './account-catalog'

export { AccountRegistryError } from './account-catalog'
export interface RuntimeAccount extends ResolvedAccountConfig {
  client: GarminClientLike
  initialConnection?: Promise<unknown>
}
export interface AccountSource {
  ready(): Promise<void>
  list(): readonly RuntimeAccount[]
  subscribe(listener: () => void): () => void
}
export interface RegistryAccountInput {
  accountId?: string
  alias: string
  region: GarminRegion
  provider: GarminProvider
  username?: string
  personalApiKey?: string
  expectedRevision?: string
}
export type AccountRuntimeConfig = Pick<Config,
  'cacheTtl' | 'requestTimeoutMs' | 'logLevel' | 'authVerbose' | 'activityDetail' | 'fitDownloadDir'>
export interface MutableAccountRegistry extends AccountSource {
  readonly managed: boolean
  upsert(input: RegistryAccountInput): Promise<{ accountId: string; revision: string }>
  remove(accountId: string, expectedRevision: string): Promise<void>
  reconfigure?(config: AccountRuntimeConfig): Promise<void>
  close(): void
}
export interface AccountRegistryOptions {
  legacySeeds: readonly ResolvedAccountConfig[]
  baseConfig: Config
  scopeId?: string
  dataDirectory?: string
  createClient(config: Config): GarminClientLike
  maxClients?: number
  maxConcurrent?: number
  idleMs?: number
}

interface Holder {
  account: RuntimeAccount
  enabled: boolean
  client?: GarminClientLike
  inFlight: number
  lastUsed: number
  requirement?: ReturnType<GarminClientLike['getAuthenticationRequirement']>
}

const ID = /^[a-z][a-z0-9_-]{0,31}$/
const REVISION = /^[0-9a-f]{32}$/
const LOCAL_READS = new Set(['getAuthenticatedAccount', 'getAuthenticationRequirement', 'personalApiConnected'])

/** A live source with bounded, lazy SDK instances; account records themselves are unbounded. */
class LiveAccountRegistry implements MutableAccountRegistry {
  private accounts = new Map<string, RuntimeAccount>()
  private holders = new Map<string, Holder>()
  private listeners = new Set<() => void>()
  private readonly catalog?: AccountCatalog
  private records = new Map<string, CatalogAccount>()
  private initialized?: Promise<void>
  private durable = false
  private closed = false
  private mutation: Promise<unknown> = Promise.resolve()
  private running = 0
  private waiters: Array<() => void> = []
  private readonly maxClients: number
  private readonly maxConcurrent: number
  private readonly idleMs: number
  private readonly idleTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: AccountRegistryOptions) {
    this.maxClients = positiveInteger(options.maxClients, 8)
    this.maxConcurrent = Math.min(this.maxClients, positiveInteger(options.maxConcurrent, 4))
    this.idleMs = positiveInteger(options.idleMs, 5 * 60_000)
    if (options.scopeId) {
      this.catalog = new AccountCatalog(options.dataDirectory
        ?? join(dirname(dirname(defaultAccountSessionPath('default'))), 'coach-workspace'), options.scopeId)
    }
    for (const seed of options.legacySeeds) {
      const record = seedRecord(seed)
      this.records.set(seed.accountId, record)
      this.addRuntime(record)
    }
    this.idleTimer = setInterval(() => this.evictIdle(), Math.min(this.idleMs, 60_000))
    this.idleTimer.unref?.()
  }

  get managed(): boolean { return this.durable }
  list(): readonly RuntimeAccount[] { return [...this.accounts.values()] }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new AccountRegistryError('closed'))
    if (!this.initialized) this.initialized = this.initialize()
    return this.initialized
  }

  private async initialize(): Promise<void> {
    if (!this.catalog) return
    const existed = await this.catalog.exists()
    try {
      await this.catalog.initialize([...this.records.values()])
      const records = await this.catalog.list()
      if (this.closed) throw new AccountRegistryError('closed')
      for (const holder of this.holders.values()) this.retire(holder)
      this.holders.clear(); this.accounts.clear(); this.records.clear()
      for (const record of records) { this.records.set(record.accountId, record); this.addRuntime(record) }
      this.durable = true
      this.publish()
    } catch {
      this.catalog.close()
      if (this.closed) throw new AccountRegistryError('closed')
      if (existed) throw new AccountRegistryError('storage_unavailable')
      // A fresh old-Node installation keeps its original configuration usable.
      this.durable = false
    }
  }

  async upsert(input: RegistryAccountInput): Promise<{ accountId: string; revision: string }> {
    return this.serialize(async () => {
      await this.ready()
      this.assertMutable()
      validateInput(input)
      const previous = input.accountId ? this.records.get(input.accountId) : undefined
      if (input.accountId && !previous) throw new AccountRegistryError('account_not_found')
      if (previous && previous.revision !== input.expectedRevision) throw new AccountRegistryError('conflict')
      const accountId = previous?.accountId ?? `a${randomBytes(15).toString('hex')}`
      const changedIdentity = previous && (previous.region !== input.region || previous.provider !== input.provider)
      let credentials: CatalogCredentials
      if (input.provider === 'personal') {
        const key = input.personalApiKey?.trim()
        if ((!previous || changedIdentity) && !key) throw new AccountRegistryError('invalid')
        credentials = { username: '', sessionTokenFile: '',
          personalApiKey: key || previous?.credentials.personalApiKey || '',
          personalApiKeyFile: key ? '' : previous?.credentials.personalApiKeyFile || '' }
        if (!credentials.personalApiKey && !credentials.personalApiKeyFile) throw new AccountRegistryError('invalid')
      } else {
        const username = input.username?.trim() || (previous?.provider === 'connect-web' ? previous.credentials.username : '')
        if (!username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) throw new AccountRegistryError('invalid')
        const same = previous?.provider === 'connect-web' && previous.region === input.region
          && previous.credentials.username.toLowerCase() === username.toLowerCase()
        credentials = { username, personalApiKey: '', personalApiKeyFile: '',
          sessionTokenFile: same ? previous.credentials.sessionTokenFile : this.newSessionPath(accountId, input.region) }
      }
      const record: CatalogAccount = {
        accountId, slot: previous?.slot ?? this.catalog!.nextOrdinal(), alias: input.alias.trim(),
        provider: input.provider, region: input.region, revision: randomBytes(16).toString('hex'), credentials,
      }
      try { await this.catalog!.save(record, previous?.revision) }
      catch (error) { throw asRegistryError(error) }
      if (this.closed) throw new AccountRegistryError('closed')
      const old = this.holders.get(accountId)
      if (old) this.retire(old)
      this.records.set(accountId, record)
      this.addRuntime(record)
      this.publish()
      return { accountId, revision: record.revision }
    })
  }

  async remove(accountId: string, expectedRevision: string): Promise<void> {
    return this.serialize(async () => {
      await this.ready(); this.assertMutable()
      if (!ID.test(accountId) || !REVISION.test(expectedRevision)) throw new AccountRegistryError('invalid')
      const existing = this.records.get(accountId)
      if (!existing) throw new AccountRegistryError('account_not_found')
      if (existing.revision !== expectedRevision) throw new AccountRegistryError('conflict')
      try { await this.catalog!.remove(accountId, expectedRevision) }
      catch (error) { throw asRegistryError(error) }
      const holder = this.holders.get(accountId)
      if (holder) this.retire(holder)
      this.accounts.delete(accountId); this.holders.delete(accountId); this.records.delete(accountId)
      this.publish()
    })
  }

  async reconfigure(config: AccountRuntimeConfig): Promise<void> {
    return this.serialize(async () => {
      await this.ready()
      if (this.closed) throw new AccountRegistryError('closed')
      const keys = ['cacheTtl', 'requestTimeoutMs', 'logLevel', 'authVerbose', 'activityDetail', 'fitDownloadDir'] as const
      if (!config || typeof config !== 'object' || Array.isArray(config)
        || Object.keys(config).some(key => !(keys as readonly string[]).includes(key))
        || !Number.isFinite(config.cacheTtl) || config.cacheTtl < 0
        || (config.requestTimeoutMs !== undefined && (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 1))
        || !['debug', 'info', 'warn', 'error'].includes(config.logLevel)
        || (config.authVerbose !== undefined && typeof config.authVerbose !== 'boolean')
        || (config.activityDetail !== 'compact' && config.activityDetail !== 'full')
        || typeof config.fitDownloadDir !== 'string' || config.fitDownloadDir.length > 4096
        || /[\u0000-\u001f\u007f]/.test(config.fitDownloadDir)) throw new AccountRegistryError('invalid')
      if (keys.every(key => this.options.baseConfig[key] === config[key])) return
      // Rebuild lazy proxies, leaving durable account identities and secret
      // snapshots untouched. Subscribers invalidate old caches and auth flows.
      // In-flight clients are retired, so their late results cannot cross into
      // the newly configured runtime.
      this.options.baseConfig = { ...this.options.baseConfig,
        cacheTtl: config.cacheTtl, requestTimeoutMs: config.requestTimeoutMs,
        logLevel: config.logLevel, authVerbose: config.authVerbose,
        activityDetail: config.activityDetail, fitDownloadDir: config.fitDownloadDir }
      for (const holder of this.holders.values()) this.retire(holder)
      this.holders.clear(); this.accounts.clear()
      for (const record of this.records.values()) this.addRuntime(record)
      this.publish()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.idleTimer)
    for (const holder of this.holders.values()) this.retire(holder)
    this.catalog?.close()
    for (const resume of this.waiters.splice(0)) resume()
    this.listeners.clear()
  }

  private assertMutable(): void {
    if (this.closed) throw new AccountRegistryError('closed')
    if (!this.durable || !this.catalog) throw new AccountRegistryError('storage_unavailable')
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.mutation.then(action, action)
    this.mutation = pending.catch(() => undefined)
    return pending
  }
  private publish(): void { for (const listener of this.listeners) { try { listener() } catch { /* isolate consumers */ } } }

  private addRuntime(record: CatalogAccount): void {
    const legacy = this.options.legacySeeds.find(seed => sameIdentity(seed, record))
    const config: Config = {
      ...this.options.baseConfig, provider: record.provider, region: record.region,
      accountAlias: record.alias, username: record.credentials.username,
      personalApiKey: record.credentials.personalApiKey, personalApiKeyFile: record.credentials.personalApiKeyFile,
      sessionTokenFile: record.credentials.sessionTokenFile,
      password: legacy?.config.password ?? '', sessionToken: legacy?.config.sessionToken ?? '',
    }
    const runtime = { accountId: record.accountId, slot: record.slot, alias: record.alias,
      region: record.region, revision: record.revision,
      configured: record.provider === 'personal'
        ? Boolean(config.personalApiKey || config.personalApiKeyFile) : Boolean(config.username),
      config, initialConnection: Promise.resolve(), client: undefined as unknown as GarminClientLike }
    const holder: Holder = { account: runtime, enabled: true, inFlight: 0, lastUsed: 0 }
    runtime.client = new Proxy({} as GarminClientLike, {
      get: (_target, key) => {
        if (typeof key !== 'string' || key === 'then') return undefined
        if (key === 'deactivate') return () => this.retire(holder)
        if (LOCAL_READS.has(key)) return () => {
          if (this.closed || !holder.enabled) return key === 'personalApiConnected' ? false : undefined
          if (key === 'getAuthenticationRequirement') return holder.client?.getAuthenticationRequirement() ?? holder.requirement
          if (key === 'getAuthenticatedAccount') return holder.client?.getAuthenticatedAccount()
          return holder.client?.personalApiConnected?.() ?? false
        }
        return (...args: unknown[]) => this.invoke(holder, key, args)
      },
    })
    this.accounts.set(record.accountId, runtime)
    this.holders.set(record.accountId, holder)
  }

  private async invoke(holder: Holder, key: string, args: unknown[]): Promise<unknown> {
    if (this.closed || !holder.enabled) throw changedAccountError()
    await this.acquire()
    try {
      if (this.closed || !holder.enabled) throw changedAccountError()
      const client = holder.client ?? this.createPooledClient(holder)
      holder.inFlight += 1
      holder.lastUsed = Date.now()
      try {
        const method = (client as unknown as Record<string, unknown>)[key]
        if (typeof method !== 'function') throw new PublicToolError('This Garmin operation is not available for the selected account')
        const result = await method.apply(client, args)
        if (this.closed || !holder.enabled) throw changedAccountError()
        return result
      } finally {
        holder.requirement = client.getAuthenticationRequirement()
        holder.inFlight -= 1
        holder.lastUsed = Date.now()
      }
    } finally { this.release() }
  }

  private createPooledClient(holder: Holder): GarminClientLike {
    const pooled = [...this.holders.values()].filter(value => value.client)
    if (pooled.length >= this.maxClients) {
      const oldest = pooled.filter(value => value.inFlight === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!oldest) throw new PublicToolError('Garmin connections are busy; retry shortly')
      this.evict(oldest)
    }
    holder.client = this.options.createClient(holder.account.config)
    return holder.client
  }
  private evict(holder: Holder): void {
    const client = holder.client
    if (!client) return
    holder.requirement = client.getAuthenticationRequirement()
    client.deactivate()
    holder.client = undefined
  }
  private evictIdle(): void {
    const threshold = Date.now() - this.idleMs
    for (const holder of this.holders.values()) {
      if (holder.client && holder.inFlight === 0 && holder.lastUsed <= threshold) this.evict(holder)
    }
  }
  private retire(holder: Holder): void {
    holder.enabled = false
    holder.client?.deactivate()
    holder.client = undefined
  }
  private async acquire(): Promise<void> {
    if (this.closed) throw changedAccountError()
    if (this.running < this.maxConcurrent) { this.running += 1; return }
    // A release transfers its existing permit directly, so a new caller cannot
    // steal the slot before the queued promise resumes.
    await new Promise<void>(resolve => this.waiters.push(resolve))
    if (this.closed) throw changedAccountError()
  }
  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.running -= 1
  }
  private newSessionPath(accountId: string, region: GarminRegion): string {
    const hash = createHash('sha256').update(`${this.options.scopeId}:${accountId}:${region}`).digest('hex').slice(0, 24)
    return defaultAccountSessionPath(`acct-${hash}`)
  }
}

export function createAccountRegistry(options: AccountRegistryOptions): MutableAccountRegistry {
  return new LiveAccountRegistry(options)
}

function seedRecord(seed: ResolvedAccountConfig): CatalogAccount {
  if (!ID.test(seed.accountId)) throw new AccountRegistryError('invalid')
  return { accountId: seed.accountId, slot: seed.slot, region: seed.region,
    provider: seed.config.provider === 'personal' ? 'personal' : 'connect-web', alias: seed.alias,
    revision: seed.revision && REVISION.test(seed.revision) ? seed.revision : randomBytes(16).toString('hex'),
    credentials: { username: seed.config.username, personalApiKey: seed.config.personalApiKey ?? '',
      personalApiKeyFile: seed.config.personalApiKeyFile ?? '', sessionTokenFile: seed.config.sessionTokenFile ?? '' } }
}
function sameIdentity(seed: ResolvedAccountConfig, record: CatalogAccount): boolean {
  return seed.accountId === record.accountId && seed.region === record.region
    && (seed.config.provider ?? 'connect-web') === record.provider
    && (record.provider === 'personal'
      || seed.config.username.trim().toLowerCase() === record.credentials.username.trim().toLowerCase())
}
function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
}
function validateInput(input: RegistryAccountInput): void {
  if (!input || typeof input !== 'object' || (input.accountId !== undefined && !ID.test(input.accountId))
    || typeof input.alias !== 'string' || !input.alias.trim() || input.alias.length > 64
    || /[\u0000-\u001f\u007f-\u009f]/.test(input.alias)
    || (input.region !== 'cn' && input.region !== 'global')
    || (input.provider !== 'connect-web' && input.provider !== 'personal')
    || (input.username !== undefined && (typeof input.username !== 'string' || input.username.length > 320
      || /[\u0000-\u001f\u007f-\u009f]/.test(input.username)))
    || (input.personalApiKey !== undefined && (typeof input.personalApiKey !== 'string' || input.personalApiKey.length > 8192
      || /[\u0000-\u001f\u007f-\u009f]/.test(input.personalApiKey)))
    || (input.accountId !== undefined && (!input.expectedRevision || !REVISION.test(input.expectedRevision)))
    || (input.accountId === undefined && input.expectedRevision !== undefined)) throw new AccountRegistryError('invalid')
}
function asRegistryError(error: unknown): AccountRegistryError {
  return error instanceof AccountRegistryError ? error : new AccountRegistryError('storage_unavailable')
}
function changedAccountError(): PublicToolError {
  return new PublicToolError('Garmin account configuration changed; retry with the current account')
}
