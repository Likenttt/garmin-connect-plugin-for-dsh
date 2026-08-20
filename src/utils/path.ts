import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Resolve a configured FIT parent without depending on the server CWD. */
export function resolveFitDownloadDir(
  value: string | undefined,
  homeDirectory = homedir(),
): string {
  const configured = value?.trim()
  if (!configured) return ''

  const expanded = configured === '~'
    ? homeDirectory
    : /^~[\\/]/.test(configured)
      ? join(homeDirectory, configured.slice(2))
      : configured
  return resolve(expanded)
}
