import type {
  GarminAuthenticationRequiredReason,
  GarminBrowserChallengeKind,
} from '../auth-requirement'

export type {
  GarminAuthenticationRequiredReason,
  GarminBrowserChallengeKind,
} from '../auth-requirement'

/** An error explicitly designed to be shown to an AI tool caller. */
export class PublicToolError extends Error {
  override name = 'PublicToolError'
}

/** Shared cancellation signal for terminal and browser authentication flows. */
export class GarminAuthenticationCancelledError extends PublicToolError {
  override name = 'GarminAuthenticationCancelledError'
  readonly code = 'CANCELLED' as const

  constructor() {
    super('Garmin authentication was cancelled')
  }
}

export const GARMIN_BROWSER_AUTH_COMMAND =
  'garmin-connect-auth serve --account <alias> --region <global|cn> --open'

/**
 * A credential state that may be recovered through an explicit Garmin
 * browser-authentication flow. Callers can branch on `reason` without parsing
 * human-facing error text.
 */
export class GarminAuthenticationRequiredError extends PublicToolError {
  override name = 'GarminAuthenticationRequiredError'

  constructor(
    readonly reason: GarminAuthenticationRequiredReason,
    message = defaultGarminAuthenticationRequiredMessage(reason),
    /** Internal only: Host RPC serializes `reason`, never this detail. */
    readonly challengeKind?: GarminBrowserChallengeKind,
  ) {
    super(message)
  }
}

function defaultGarminAuthenticationRequiredMessage(
  reason: GarminAuthenticationRequiredReason,
): string {
  const state = reason === 'missing'
    ? 'is required'
    : reason === 'expired'
      ? 'has expired'
      : reason === 'challenge'
        ? 'requires browser verification'
        : 'was rejected'
  return `Garmin authentication ${state}; run ${GARMIN_BROWSER_AUTH_COMMAND}`
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
    .replace(/\b(Bearer|Basic|ApiKey)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /(["']?(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|personal[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|oauth[_-]?token[_-]?secret|oauth[_-]?signature|oauth[_-]?token|client[_-]?secret|consumer[_-]?secret)["']?\s*[:=]\s*["']?)(?:(?:bearer|apikey)\s+)?[^\s,;&"'}]+/gi,
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
