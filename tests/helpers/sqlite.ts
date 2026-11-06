/** Exercise SQLite success paths only on runtimes that provide the module. */
export const hasNodeSqlite = (() => {
  try { return typeof (require('node:sqlite') as { DatabaseSync?: unknown }).DatabaseSync === 'function' }
  catch { return false }
})()

export const itWithSqlite = hasNodeSqlite ? it : it.skip
