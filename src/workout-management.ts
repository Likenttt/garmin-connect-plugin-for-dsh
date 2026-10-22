import { parseLocalDate } from './utils/date'
import { PublicToolError } from './utils/errors'

export type GarminResourceId = string | number
export const GARMIN_RESOURCE_ID_PATTERN = '^[1-9][0-9]{0,31}(?![\\s\\S])'

export interface ScheduledWorkoutsArgs {
  startDate?: string
  endDate?: string
}

export interface DeleteWorkoutArgs {
  workoutId: GarminResourceId
  confirmed?: boolean
  confirmationId?: string
}

export interface ScheduleWorkoutArgs {
  workoutId: GarminResourceId
  date: string
  confirmed?: boolean
  confirmationId?: string
}

export interface UnscheduleWorkoutArgs {
  scheduleId: GarminResourceId
  confirmed?: boolean
  confirmationId?: string
}

/** Uses the maintained SDK's authenticated transport for both resource types. */
export interface GarminWorkoutManagementClient {
  getWorkoutDetail(workoutId: GarminResourceId): Promise<unknown>
  getScheduledWorkouts(startDate: string, endDate: string): Promise<unknown>
  getScheduledWorkout(scheduleId: GarminResourceId): Promise<unknown>
  scheduleWorkout(workoutId: GarminResourceId, date: string): Promise<unknown>
  deleteWorkout(workoutId: GarminResourceId): Promise<void>
  unscheduleWorkout(scheduleId: GarminResourceId): Promise<void>
}

export function validateWorkoutScheduleDate(value: unknown, field = 'date'): asserts value is string {
  if (typeof value === 'string' && value.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]) return
  }
  throw new PublicToolError(`Invalid ${field}: expected a real date in YYYY-MM-DD format`)
}

export function canonicalGarminResourceId(value: unknown, field: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value)
  }
  if (typeof value === 'string' && new RegExp(GARMIN_RESOURCE_ID_PATTERN).test(value)) {
    return value
  }
  throw new PublicToolError(`Invalid ${field}: expected a positive safe integer or decimal ID string`)
}

export function resolveScheduledWorkoutRange(args: ScheduledWorkoutsArgs = {}): {
  startDate: string
  endDate: string
} {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const startDate = args.startDate === undefined ? today : args.startDate
  const endDate = args.endDate === undefined ? startDate : args.endDate
  for (const [field, value] of [['startDate', startDate], ['endDate', endDate]]) {
    try {
      if (typeof value !== 'string' || value.length !== 10) throw new Error()
      parseLocalDate(value)
    } catch {
      throw new PublicToolError(`Invalid ${field}: expected a real date in YYYY-MM-DD format`)
    }
  }
  if (startDate > endDate) throw new PublicToolError('startDate must not be after endDate')
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
  if (days > 30) throw new PublicToolError('Scheduled workout ranges cannot exceed 31 calendar days')
  return { startDate, endDate }
}
