import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { createWindowsPrivateAcl } from './windows-private-acl'

export interface CoachNote {
  id: string
  accountId: string
  title: string
  body: string
  category: string
  createdAt: string
  updatedAt: string
  revision: number
}

export interface CoachNoteInput {
  id?: string
  title: string
  body: string
  category: string
  expectedRevision?: number
}

export interface CoachPersistence {
  notes(owner: string, accountId: string): Promise<CoachNote[]>
  save(owner: string, accountId: string, input: CoachNoteInput): Promise<CoachNote>
  remove(owner: string, accountId: string, id: string, revision: number): Promise<boolean>
  preferences(): Promise<{ selfAccountId: string | null }>
  setPreferences(selfAccountId: string | null): Promise<void>
  close(): void
}

export class CoachStorageError extends Error {
  constructor(readonly code: 'storage_unavailable' | 'conflict') {
    super(code)
  }
}

interface SqlStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[]
  get(...params: (string | number | null)[]): Record<string, unknown> | undefined
  run(...params: (string | number | null)[]): { changes: number | bigint }
}
interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

/** Optional SQLite feature: importing this module remains safe on Node 20. */
export class SqliteCoachStore implements CoachPersistence {
  private opening?: Promise<SqlDatabase>
  private database?: SqlDatabase
  private closed = false

  constructor(
    private readonly directory: string,
    private readonly scope: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private db(): Promise<SqlDatabase> {
    if (this.closed) return Promise.reject(new CoachStorageError('storage_unavailable'))
    if (!this.opening) {
      this.opening = this.open().catch(() => {
        this.opening = undefined
        throw new CoachStorageError('storage_unavailable')
      })
    }
    return this.opening
  }

  private async open(): Promise<SqlDatabase> {
    // Do not introduce a native-addon ABI dependency into the Harness plugin.
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => SqlDatabase
    }
    const windows = process.platform === 'win32' ? await createWindowsPrivateAcl() : undefined
    if (windows) await windows.prepareDirectory(this.directory)
    else {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const info = await lstat(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink()
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())
        || (info.mode & 0o077) !== 0) throw new Error('private directory required')
    }
    const path = join(this.directory, 'coach.sqlite')
    let created = false
    try {
      const file = await open(path, 'wx', 0o600)
      await file.close()
      created = true
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
    if (windows) {
      if (created) await windows.secureFile(path)
      else await windows.verifyFile(path)
    } else {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())
        || (info.mode & 0o077) !== 0) throw new Error('private file required')
    }
    if (this.closed) throw new Error('store closed')
    const database = new DatabaseSync(path)
    try {
      database.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (version > 1) throw new Error('newer schema')
      database.exec(`
        CREATE TABLE IF NOT EXISTS coach_notes (
          scope TEXT NOT NULL, owner TEXT NOT NULL, account_id TEXT NOT NULL,
          id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL,
          PRIMARY KEY (scope, owner, account_id, id)
        );
        CREATE INDEX IF NOT EXISTS coach_notes_updated
          ON coach_notes(scope, owner, account_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS coach_preferences (
          scope TEXT PRIMARY KEY, self_account_id TEXT
        );
        PRAGMA user_version = 1;
      `)
      this.database = database
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }

  async notes(owner: string, accountId: string): Promise<CoachNote[]> {
    const db = await this.db()
    return db.prepare(`SELECT id, account_id, title, body, category, created_at, updated_at, revision
      FROM coach_notes WHERE scope = ? AND owner = ? AND account_id = ?
      ORDER BY updated_at DESC, id`).all(this.scope, owner, accountId).map(noteFromRow)
  }

  async save(owner: string, accountId: string, input: CoachNoteInput): Promise<CoachNote> {
    const db = await this.db()
    const now = this.now().toISOString()
    const id = input.id ?? randomUUID()
    if (input.id) {
      const result = db.prepare(`UPDATE coach_notes
        SET title = ?, body = ?, category = ?, updated_at = ?, revision = revision + 1
        WHERE scope = ? AND owner = ? AND account_id = ? AND id = ? AND revision = ?`)
        .run(input.title, input.body, input.category, now, this.scope, owner, accountId, id,
          input.expectedRevision ?? -1)
      if (Number(result.changes) !== 1) throw new CoachStorageError('conflict')
    } else {
      db.prepare(`INSERT INTO coach_notes
        (scope, owner, account_id, id, title, body, category, created_at, updated_at, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(this.scope, owner, accountId, id, input.title, input.body, input.category, now, now)
    }
    const row = db.prepare(`SELECT id, account_id, title, body, category, created_at, updated_at, revision
      FROM coach_notes WHERE scope = ? AND owner = ? AND account_id = ? AND id = ?`)
      .get(this.scope, owner, accountId, id)
    if (!row) throw new CoachStorageError('conflict')
    return noteFromRow(row)
  }

  async remove(owner: string, accountId: string, id: string, revision: number): Promise<boolean> {
    const db = await this.db()
    const result = db.prepare(`DELETE FROM coach_notes
      WHERE scope = ? AND owner = ? AND account_id = ? AND id = ? AND revision = ?`)
      .run(this.scope, owner, accountId, id, revision)
    if (Number(result.changes) !== 1) throw new CoachStorageError('conflict')
    return true
  }

  async preferences(): Promise<{ selfAccountId: string | null }> {
    const db = await this.db()
    const row = db.prepare('SELECT self_account_id FROM coach_preferences WHERE scope = ?').get(this.scope)
    return { selfAccountId: typeof row?.self_account_id === 'string' ? row.self_account_id : null }
  }

  async setPreferences(selfAccountId: string | null): Promise<void> {
    const db = await this.db()
    db.prepare(`INSERT INTO coach_preferences(scope, self_account_id) VALUES (?, ?)
      ON CONFLICT(scope) DO UPDATE SET self_account_id = excluded.self_account_id`)
      .run(this.scope, selfAccountId)
  }

  close(): void {
    this.closed = true
    this.database?.close()
    this.database = undefined
  }
}

function noteFromRow(row: Record<string, unknown>): CoachNote {
  return {
    id: String(row.id), accountId: String(row.account_id), title: String(row.title),
    body: String(row.body), category: String(row.category), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), revision: Number(row.revision),
  }
}
