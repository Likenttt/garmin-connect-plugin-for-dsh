/** An error explicitly designed to be shown to an AI tool caller. */
export class PublicToolError extends Error {
  override name = 'PublicToolError'
}

/**
 * Return only errors that are intentionally safe and actionable for an AI
 * tool caller. Unexpected SDK/network messages can contain URLs, response
 * bodies, account identifiers, or credentials, so they are replaced with the
 * operation-specific fallback instead of being copied into the trajectory.
 */
export function publicErrorMessage(error: unknown, fallback: string): string {
  return error instanceof PublicToolError
    ? redactSensitiveText(error).slice(0, 500)
    : fallback
}

/** Redact configured secrets from the small amount of text kept in local logs. */
export function redactSensitiveText(
  value: unknown,
  secrets: ReadonlyArray<string | undefined> = [],
): string {
  let message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : 'Unknown error'

  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[REDACTED]')
  }

  return message
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /(["']?(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|access[_-]?token|refresh[_-]?token|session[_-]?token|oauth[_-]?token[_-]?secret|oauth[_-]?signature|oauth[_-]?token|client[_-]?secret|consumer[_-]?secret)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s,;&"'}]+/gi,
      '$1[REDACTED]',
    )
    .slice(0, 1000)
}

/**
 * Convert third-party console output into one plain, redacted line. Structured
 * objects are intentionally omitted because Axios errors commonly store
 * Authorization headers and request bodies on enumerable properties.
 */
export function safeUpstreamLogLine(
  values: ReadonlyArray<unknown>,
  secrets: ReadonlyArray<string | undefined> = [],
): string {
  return values.map((value) => {
    if (typeof value === 'string' || value instanceof Error) {
      return redactSensitiveText(value, secrets)
    }
    if (value === null || value === undefined) return String(value)
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return '[structured value omitted]'
  }).join(' ')
}
