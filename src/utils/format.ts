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
 * save context tokens. `full` returns every raw Garmin field with the
 * normalized convenience fields layered on top — request it explicitly when
 * the user needs the complete dataset.
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

/** Full detail — no filtering; every raw field plus normalized conveniences. */
function fullActivity(raw: Record<string, unknown>): FormattedActivity {
  const distance = Number(raw.distance) || 0
  const duration = Number(raw.duration) || 0
  const maxSpeed = Number(raw.maxSpeed) || 0

  return {
    // Keep every raw field — no filtering.
    ...raw,
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
  goal: number
  distanceMeters: number
  highlyActiveSeconds: number | null
}

export function formatSteps(raw: Record<string, unknown>): FormattedSteps {
  return {
    date: (raw.calendarDate as string) ?? '',
    totalSteps: (raw.totalSteps as number) ?? 0,
    goal: (raw.stepGoal as number) ?? 0,
    distanceMeters: (raw.totalDistance as number) ?? 0,
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
  // raw.date contains the timestamp in ms, raw.weight contains the weight in grams
  const kg = (raw.weight as number) ? (raw.weight as number) / 1000 : null
  const muscleMassKg = (raw.muscleMass as number) ? (raw.muscleMass as number) / 1000 : null
  const boneMassKg = (raw.boneMass as number) ? (raw.boneMass as number) / 1000 : null

  // Garmin usually provides date as timestamp or calendarDate
  const d = new Date(raw.date as number)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')

  return {
    date: `${y}-${m}-${day}`,
    weightKg: kg ? Math.round(kg * 100) / 100 : null,
    bmi: (raw.bmi as number) ?? null,
    bodyFatPercentage: (raw.bodyFat as number) ?? null,
    muscleMassKg: muscleMassKg ? Math.round(muscleMassKg * 100) / 100 : null,
    waterPercentage: (raw.bodyWater as number) ?? null,
    boneMassKg: boneMassKg ? Math.round(boneMassKg * 100) / 100 : null,
  }
}

// ---- Workouts (Calendar) ----

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
