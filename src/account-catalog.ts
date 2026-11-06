import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createWindowsPrivateAcl, type WindowsPrivateAcl } from './windows-private-acl'

export type AccountRegistryErrorCode = 'invalid' | 'conflict' | 'storage_unavailable' | 'account_not_found' | 'closed'
export class AccountRegistryError extends Error {
  constructor(readonly code: AccountRegistryErrorCode) { super(code) }
}

export interface CatalogCredentials {
  username: string
  personalApiKey: string
  personalApiKeyFile: string
  sessionTokenFile: string
}
export interface CatalogAccount {
  accountId: string
  slot: number
  region: 'cn' | 'global'
  provider: 'connect-web' | 'personal'
  alias: string
  revision: string
  credentials: CatalogCredentials
}
interface Statement {
  all(...params: (string | number | null)[]): Record<string, unknown>[]
  get(...params: (string | number | null)[]): Record<string, unknown> | undefined
  run(...params: (string | number | null)[]): { changes: number | bigint }
}
interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

/** Private, scoped catalog. Credentials are separate owner-only files, never SQL columns. */
export class AccountCatalog {
  private database?: Database
  private closed = false
  private windows?: WindowsPrivateAcl
  private readonly digest: string
  private readonly credentialsDirectory: string
  readonly path: string

  constructor(private readonly directory: string, scopeId: string) {
    this.digest = createHash('sha256').update(scopeId).digest('hex')
    this.path = join(directory, `accounts-${this.digest}.sqlite`)
    this.credentialsDirectory = join(directory, `credentials-${this.digest}`)
  }

  async exists(): Promise<boolean> {
    try { await lstat(this.path); return true }
    catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false
      return true // An unreadable managed catalog must never revive legacy accounts.
    }
  }

  async initialize(seeds: readonly CatalogAccount[]): Promise<void> {
    if (this.closed) throw new AccountRegistryError('closed')
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => Database }
    this.windows = process.platform === 'win32' ? await createWindowsPrivateAcl() : undefined
    await this.privateDirectory(this.directory)
    await this.privateDirectory(this.credentialsDirectory)
    await this.prepareFile(this.path)
    if (this.closed) throw new AccountRegistryError('closed')
    const db = new DatabaseSync(this.path)
    try {
      db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (version > 1) throw new AccountRegistryError('storage_unavailable')
      db.exec(`
        CREATE TABLE IF NOT EXISTS account_catalog (
          id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, region TEXT NOT NULL,
          provider TEXT NOT NULL, alias TEXT NOT NULL, revision TEXT NOT NULL,
          credential_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS account_catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
      `)
      this.database = db
      if (!db.prepare("SELECT value FROM account_catalog_meta WHERE key = 'imported'").get()) {
        // Write all credentials durably first; only then atomically publish import + marker.
        const imports: Array<{ account: CatalogAccount; name: string }> = []
        for (const account of seeds) imports.push({ account, name: await this.writeCredentials(account.credentials) })
        db.exec('BEGIN IMMEDIATE')
        try {
          // Another Host process may have completed its import while files were written.
          if (!db.prepare("SELECT value FROM account_catalog_meta WHERE key = 'imported'").get()) {
            const insert = db.prepare(`INSERT OR IGNORE INTO account_catalog
              (id, ordinal, region, provider, alias, revision, credential_name, active)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
            for (const { account: a, name } of imports) {
              insert.run(a.accountId, a.slot, a.region, a.provider, a.alias, a.revision, name)
            }
            db.prepare("INSERT INTO account_catalog_meta(key, value) VALUES ('imported', '1')").run()
          }
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      }
      if (this.closed) throw new AccountRegistryError('closed')
    } catch (error) {
      this.database = undefined
      db.close()
      throw error
    }
  }

  async list(): Promise<CatalogAccount[]> {
    const rows = this.db().prepare(`SELECT id, ordinal, region, provider, alias, revision, credential_name
      FROM account_catalog WHERE active = 1 ORDER BY ordinal, id`).all()
    const result: CatalogAccount[] = []
    for (const row of rows) {
      const accountId = String(row.id)
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(accountId)
        || (row.region !== 'cn' && row.region !== 'global')
        || (row.provider !== 'personal' && row.provider !== 'connect-web')
        || !/^[0-9a-f]{32}$/.test(String(row.revision))) throw new AccountRegistryError('storage_unavailable')
      const credentials = await this.readCredentials(String(row.credential_name))
      result.push({ accountId, slot: Number(row.ordinal), region: row.region,
        provider: row.provider, alias: String(row.alias), revision: String(row.revision), credentials })
    }
    return result
  }

  async save(account: CatalogAccount, expectedRevision?: string): Promise<void> {
    const db = this.db()
    const name = await this.writeCredentials(account.credentials)
    let committed = false
    try {
      if (expectedRevision === undefined) {
        const result = db.prepare(`INSERT OR IGNORE INTO account_catalog
          (id, ordinal, region, provider, alias, revision, credential_name, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
          .run(account.accountId, account.slot, account.region, account.provider, account.alias, account.revision, name)
        if (Number(result.changes) !== 1) throw new AccountRegistryError('conflict')
      } else {
        const result = db.prepare(`UPDATE account_catalog SET region = ?, provider = ?, alias = ?,
          revision = ?, credential_name = ? WHERE id = ? AND revision = ? AND active = 1`)
          .run(account.region, account.provider, account.alias, account.revision, name,
            account.accountId, expectedRevision)
        if (Number(result.changes) !== 1) throw new AccountRegistryError('conflict')
      }
      committed = true
    } finally {
      if (!committed) await unlink(join(this.credentialsDirectory, name)).catch(() => undefined)
    }
  }

  async remove(accountId: string, revision: string): Promise<void> {
    const result = this.db().prepare('UPDATE account_catalog SET active = 0 WHERE id = ? AND revision = ? AND active = 1')
      .run(accountId, revision)
    if (Number(result.changes) !== 1) throw new AccountRegistryError('conflict')
  }

  nextOrdinal(): number {
    const value = Number(this.db().prepare('SELECT MAX(ordinal) AS ordinal FROM account_catalog').get()?.ordinal ?? 0) + 1
    if (!Number.isSafeInteger(value) || value < 1) throw new AccountRegistryError('storage_unavailable')
    return value
  }

  close(): void {
    this.closed = true
    this.database?.close()
    this.database = undefined
  }

  private db(): Database {
    if (this.closed) throw new AccountRegistryError('closed')
    if (!this.database) throw new AccountRegistryError('storage_unavailable')
    return this.database
  }

  private async privateDirectory(path: string): Promise<void> {
    if (this.windows) { await this.windows.prepareDirectory(path); return }
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || (info.mode & 0o077) !== 0) throw new AccountRegistryError('storage_unavailable')
  }

  private async prepareFile(path: string): Promise<void> {
    let created = false
    try { const file = await open(path, 'wx', 0o600); await file.close(); created = true }
    catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error }
    if (this.windows) {
      if (created) await this.windows.secureFile(path)
      else await this.windows.verifyFile(path)
    } else await this.verifyPrivateFile(path)
  }

  private async verifyPrivateFile(path: string): Promise<void> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || (info.mode & 0o077) !== 0) throw new AccountRegistryError('storage_unavailable')
  }

  private async writeCredentials(value: CatalogCredentials): Promise<string> {
    if (this.closed) throw new AccountRegistryError('closed')
    const name = `${randomBytes(24).toString('hex')}.json`
    const path = join(this.credentialsDirectory, name)
    const handle = await open(path, 'wx', 0o600)
    try {
      if (this.windows) await this.windows.secureFile(path)
      await handle.writeFile(JSON.stringify({ version: 1, ...value }), 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    if (process.platform !== 'win32') {
      const directory = await open(this.credentialsDirectory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    return name
  }

  private async readCredentials(name: string): Promise<CatalogCredentials> {
    if (!/^[0-9a-f]{48}\.json$/.test(name)) throw new AccountRegistryError('storage_unavailable')
    const path = join(this.credentialsDirectory, name)
    if (this.windows) await this.windows.verifyFile(path)
    else await this.verifyPrivateFile(path)
    const info = await lstat(path)
    if (info.size > 64 * 1024) throw new AccountRegistryError('storage_unavailable')
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (!parsed || parsed.version !== 1) throw new AccountRegistryError('storage_unavailable')
    const result = { username: '', personalApiKey: '', personalApiKeyFile: '', sessionTokenFile: '' }
    for (const key of Object.keys(result) as (keyof CatalogCredentials)[]) {
      if (typeof parsed[key] !== 'string') throw new AccountRegistryError('storage_unavailable')
      result[key] = parsed[key]
    }
    return result
  }
}
