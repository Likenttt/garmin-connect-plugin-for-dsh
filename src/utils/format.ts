/**
 * Data formatting utilities.
 *
 * Garmin API responses are deeply nested and contain many fields the LLM
 * doesn't need.  These helpers extract only the meaningful metrics so we
 * conserve context-window tokens and keep tool outputs readable.
 */

// ---- Activity ----

export interface FormattedActivity {
  id: number | string
  name: string
  type: string
  startTime: string
  distanceMeters: number
  durationSeconds: number
  averageHeartRate: number | null
  maxHeartRate: number | null
  averagePaceMinPerKm: number | null
  calories: number | null
}

export function formatActivity(raw: Record<string, unknown>): FormattedActivity {
  const distance = Number(raw.distance) || 0
  const duration = Number(raw.duration) || 0

  return {
    id: (raw.activityId as number | string) ?? '',
    name: (raw.activityName as string) ?? 'Unnamed',
    type: (raw.activityType as Record<string, unknown>)?.typeKey as string ?? 'unknown',
    startTime: (raw.startTimeLocal as string) ?? '',
    distanceMeters: Math.round(distance * 100) / 100,
    durationSeconds: Math.round(duration),
    averageHeartRate: (raw.averageHR as number) ?? null,
    maxHeartRate: (raw.maxHR as number) ?? null,
    averagePaceMinPerKm: distance > 0
      ? Math.round((duration / 60) / (distance / 1000) * 100) / 100
      : null,
    calories: (raw.calories as number) ?? null,
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
}

export function formatSteps(raw: Record<string, unknown>): FormattedSteps {
  return {
    date: (raw.calendarDate as string) ?? '',
    totalSteps: (raw.totalSteps as number) ?? 0,
    goal: (raw.stepGoal as number) ?? 0,
    distanceMeters: (raw.totalDistance as number) ?? 0,
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
