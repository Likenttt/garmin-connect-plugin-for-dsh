/**
 * Data formatting utilities.
 *
 * Garmin API responses are deeply nested and contain many fields the LLM
 * doesn't need.  These helpers extract only the meaningful metrics so we
 * conserve context-window tokens and keep tool outputs readable.
 */

// ---- Activity ----

/**
 * Formatted activity. The required fields exist in both modes; the optional
 * normalized fields below are present only in `full` detail mode.
 */
export interface FormattedActivity extends Record<string, unknown> {
  id: number | string
  name: string
  type: string
  startTime: string
  distanceMeters: number
  durationSeconds: number
  averagePaceMinPerKm: number | null
  averageHeartRate: number | null
  maxHeartRate: number | null
  calories: number | null
  elevationGainMeters: number | null
  averageCadence: number | null
  /** Present only in `full` detail mode. */
  eventType?: string | null
  elapsedDurationSeconds?: number | null
  movingDurationSeconds?: number | null
  averageSpeedMps?: number | null
  maxSpeedMps?: number | null
  maxPaceMinPerKm?: number | null
  elevationLossMeters?: number | null
}

export type ActivityDetail = 'compact' | 'full'

/**
 * Format an activity.
 *
 * `compact` (default) returns a curated subset of the most useful metrics to
 * save context tokens. `full` returns expanded fitness/location fields with
 * normalized conveniences, while filtering credentials and unrelated
 * account/social identifiers. Request it explicitly because routes can reveal
 * precise locations.
 */
export function formatActivity(
  raw: Record<string, unknown>,
  detail: ActivityDetail = 'compact',
): FormattedActivity {
  return detail === 'full' ? fullActivity(raw) : compactActivity(raw)
}

/** Curated subset — keeps tool output small and readable. */
function compactActivity(raw: Record<string, unknown>): FormattedActivity {
  const distance = Number(raw.distance) || 0
  const duration = Number(raw.duration) || 0

  return {
    id: (raw.activityId as number | string) ?? '',
    name: (raw.activityName as string) ?? 'Unnamed',
    type: (raw.activityType as Record<string, unknown>)?.typeKey as string ?? 'unknown',
    startTime: (raw.startTimeLocal as string) ?? '',
    distanceMeters: Math.round(distance * 100) / 100,
    durationSeconds: Math.round(duration),
    averageHeartRate: numOrNull(raw.averageHR),
    maxHeartRate: numOrNull(raw.maxHR),
    averagePaceMinPerKm: distance > 0
      ? round2((duration / 60) / (distance / 1000))
      : null,
    calories: numOrNull(raw.calories),
    elevationGainMeters: numOrNull(raw.elevationGain),
    averageCadence: numOrNull(raw.averageRunningCadenceInStepsPerMinute),
  }
}

/** Expanded detail with credential/account/social fields removed recursively. */
function fullActivity(raw: Record<string, unknown>): FormattedActivity {
  const distance = Number(raw.distance) || 0
  const duration = Number(raw.duration) || 0
  const maxSpeed = Number(raw.maxSpeed) || 0
  const safeRaw = sanitizeActivityValue(raw) as Record<string, unknown>

  return {
    // Preserve expanded fitness/location data, but never pass credentials or
    // unrelated account/social identifiers into the model trajectory.
    ...safeRaw,
    id: (raw.activityId as number | string) ?? '',
    name: (raw.activityName as string) ?? 'Unnamed',
    type: (raw.activityType as Record<string, unknown>)?.typeKey as string ?? 'unknown',
    eventType: (raw.eventType as Record<string, unknown>)?.typeKey as string ?? null,
    startTime: (raw.startTimeLocal as string) ?? '',
    distanceMeters: Math.round(distance * 100) / 100,
    durationSeconds: Math.round(duration),
    elapsedDurationSeconds: numOrNull(raw.elapsedDuration),
    movingDurationSeconds: numOrNull(raw.movingDuration),
    averageSpeedMps: numOrNull(raw.averageSpeed),
    maxSpeedMps: numOrNull(raw.maxSpeed),
    averagePaceMinPerKm: distance > 0
      ? round2((duration / 60) / (distance / 1000))
      : null,
    // min/km pace derived from max speed (m/s): 1000m / (m/s * 60s)
    maxPaceMinPerKm: maxSpeed > 0 ? round2(1000 / (maxSpeed * 60)) : null,
    averageHeartRate: numOrNull(raw.averageHR),
    maxHeartRate: numOrNull(raw.maxHR),
    calories: numOrNull(raw.calories),
    elevationGainMeters: numOrNull(raw.elevationGain),
    elevationLossMeters: numOrNull(raw.elevationLoss),
    averageCadence:
      numOrNull(raw.averageRunningCadenceInStepsPerMinute) ??
      numOrNull(raw.averageBikingCadenceInRevPerMinute) ??
      numOrNull(raw.averageSwimCadenceInStrokesPerMinute) ??
      numOrNull(raw.avgDoubleCadence),
  }
}

// ---- Sleep ----

export interface FormattedSleep {
  date: string
  sleepScore: number | null
  sleepDurationHours: number | null
  deepSleepHours: number | null
  lightSleepHours: number | null
  remSleepHours: number | null
  awakeDurationHours: number | null
}

export function formatSleep(raw: Record<string, unknown>): FormattedSleep {
  const dto = (raw.dailySleepDTO ?? raw) as Record<string, unknown>
  const scores = dto.sleepScores as Record<string, Record<string, number>> | undefined
  const toHours = (s: unknown) => typeof s === 'number' ? Math.round(s / 3600 * 100) / 100 : null

  return {
    date: (dto.calendarDate as string) ?? '',
    sleepScore: scores?.overall?.value ?? null,
    sleepDurationHours: toHours(dto.sleepTimeSeconds),
    deepSleepHours: toHours(dto.deepSleepSeconds),
    lightSleepHours: toHours(dto.lightSleepSeconds),
    remSleepHours: toHours(dto.remSleepSeconds),
    awakeDurationHours: toHours(dto.awakeSleepSeconds),
  }
}

// ---- Steps ----

export interface FormattedSteps {
  date: string
  totalSteps: number
  goal: number | null
  distanceMeters: number | null
  highlyActiveSeconds: number | null
}

export function formatSteps(
  raw: number | Record<string, unknown>,
  date = '',
): FormattedSteps {
  if (typeof raw === 'number') {
    return {
      date,
      totalSteps: Number.isFinite(raw) ? raw : 0,
      goal: null,
      distanceMeters: null,
      highlyActiveSeconds: null,
    }
  }

  return {
    date: (raw.calendarDate as string) ?? '',
    totalSteps: (raw.totalSteps as number) ?? 0,
    goal: numOrNull(raw.stepGoal),
    distanceMeters: numOrNull(raw.totalDistance),
    highlyActiveSeconds: (raw.highlyActiveSeconds as number) ?? null,
  }
}

// ---- Heart Rate ----

export interface FormattedHeartRate {
  date: string
  restingHR: number | null
  maxHR: number | null
  minHR: number | null
}

export function formatHeartRate(raw: Record<string, unknown>): FormattedHeartRate {
  return {
    date: (raw.calendarDate as string) ?? '',
    restingHR: (raw.restingHeartRate as number) ?? null,
    maxHR: (raw.maxHeartRate as number) ?? null,
    minHR: (raw.minHeartRate as number) ?? null,
  }
}

// ---- Weight ----

export interface FormattedWeight {
  date: string
  weightKg: number | null
  bmi: number | null
  bodyFatPercentage: number | null
  muscleMassKg: number | null
  waterPercentage: number | null
  boneMassKg: number | null
}

export function formatWeight(raw: Record<string, unknown>): FormattedWeight {
  const measurements = Array.isArray(raw.dateWeightList)
    ? raw.dateWeightList as Record<string, unknown>[]
    : []
  const average = isRecord(raw.totalAverage) ? raw.totalAverage : undefined
  const measurement = measurements[0]
  const metric = (key: string): unknown =>
    measurement?.[key] ?? average?.[key] ?? raw[key]
  const kg = gramsToKg(metric('weight'))
  const muscleMassKg = gramsToKg(metric('muscleMass'))
  const boneMassKg = gramsToKg(metric('boneMass'))

  return {
    date: weightDate(raw, measurements[0]),
    weightKg: kg === null ? null : round2(kg),
    bmi: numOrNull(metric('bmi')),
    bodyFatPercentage: numOrNull(metric('bodyFat')),
    muscleMassKg: muscleMassKg === null ? null : round2(muscleMassKg),
    waterPercentage: numOrNull(metric('bodyWater')),
    boneMassKg: boneMassKg === null ? null : round2(boneMassKg),
  }
}

// ---- Profile ----

export interface FormattedProfile {
  displayName: string
  fullName: string
  profileImageUrl: string | null
  primaryActivity: string | null
}

/** Return the small, non-sensitive profile subset suitable for AI tool output. */
export function formatProfile(raw: Record<string, unknown>): FormattedProfile {
  return {
    displayName: stringOrNull(raw.displayName) ?? '',
    fullName: stringOrNull(raw.fullName) ?? stringOrNull(raw.userProfileFullName) ?? '',
    profileImageUrl:
      stringOrNull(raw.profileImageUrlMedium) ??
      stringOrNull(raw.profileImageUrlSmall) ??
      stringOrNull(raw.profileImageUrlLarge),
    primaryActivity: stringOrNull(raw.primaryActivity),
  }
}

// ---- Workout library templates ----

export interface FormattedWorkout {
  id: number | string
  name: string
  description: string
  sportType: string
  createdDate: string
  estimatedDurationMins: number | null
  estimatedDistanceMeters: number | null
}

export function formatWorkout(raw: Record<string, unknown>): FormattedWorkout {
  const sport = raw.sportType as Record<string, string>
  return {
    id: (raw.workoutId as number | string) ?? '',
    name: (raw.workoutName as string) ?? 'Unnamed',
    description: (raw.description as string) ?? '',
    sportType: sport?.sportTypeKey ?? 'unknown',
    createdDate: (raw.createdDate as string) ?? '',
    estimatedDurationMins: raw.estimatedDurationInSecs
      ? Math.round((raw.estimatedDurationInSecs as number) / 60)
      : null,
    estimatedDistanceMeters: (raw.estimatedDistanceInMeters as number) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a raw value to a finite number, or null when missing/invalid. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Round to two decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function gramsToKg(value: unknown): number | null {
  const grams = numOrNull(value)
  return grams === null ? null : grams / 1000
}

function weightDate(
  envelope: Record<string, unknown>,
  firstMeasurement?: Record<string, unknown>,
): string {
  const calendarDate = firstMeasurement?.calendarDate ?? envelope.calendarDate ?? envelope.startDate
  if (typeof calendarDate === 'string') return calendarDate

  const timestamp = numOrNull(firstMeasurement?.date ?? envelope.date)
  if (timestamp === null) return ''

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const PRIVATE_ACTIVITY_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'oauthtoken',
  'oauthtokensecret',
  'oauthsignature',
  'oauth1',
  'oauth2',
  'csrftoken',
  'clientsecret',
  'consumersecret',
  'ownerid',
  'ownerdisplayname',
  'ownerfullname',
  'conversationuuid',
  'conversationpk',
  'activitylikedisplaynames',
  'activitylikefullnames',
  'activitylikeprofileimageurls',
  'activitylikeauthors',
  'requestorrelationship',
  'userroles',
  'deviceid',
  'calendareventid',
  'calendareventuuid',
  'privacy',
])

function sanitizeActivityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeActivityValue)
  if (!isRecord(value)) return value

  const sanitized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (
      PRIVATE_ACTIVITY_KEYS.has(normalizedKey)
      || normalizedKey.startsWith('ownerprofileimageurl')
    ) {
      continue
    }
    sanitized[key] = sanitizeActivityValue(child)
  }
  return sanitized
}
