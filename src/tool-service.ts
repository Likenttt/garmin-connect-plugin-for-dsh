import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportFitFromZip, fitAccountOutputDirectory } from './fit-export'
import type { ActivityDetail } from './utils/format'
import { findSkills, formatSkillCard } from './knowledge/running-skills'
import {
  buildGarminWorkout,
  validateWorkoutDef,
} from './knowledge/workout-schema'
import type { WorkoutDef } from './knowledge/workout-schema'
import { PublicToolError } from './utils/errors'
import {
  formatActivity,
  formatHeartRate,
  formatProfile,
  formatSleep,
  formatSteps,
  formatWeight,
  formatWorkout,
} from './utils/format'

export interface GarminDataClient {
  getActivities(start?: number, limit?: number): Promise<unknown[]>
  getSleep(date: string): Promise<unknown>
  getSteps(date: string): Promise<unknown>
  getHeartRate(date: string): Promise<unknown>
  getWeight(date: string): Promise<unknown>
  getWorkouts(start?: number, limit?: number): Promise<unknown[]>
  downloadOriginalActivityZip(activityId: number, destinationDir: string): Promise<string>
  addWorkout(workout: Record<string, unknown>): Promise<Record<string, unknown>>
  getUserProfile(): Promise<unknown>
}

export interface GarminToolServiceOptions {
  activityDetail: ActivityDetail
  fitDownloadDir: string
  accountUsername: string
}

export interface DateRangeArgs {
  startDate?: string
  endDate?: string
}

export interface ActivityArgs {
  limit?: number
  offset?: number
  detail?: ActivityDetail
}

export interface PaginationArgs {
  limit?: number
  offset?: number
}

export interface RunningAdviceArgs {
  query?: string
  includeRecentActivities?: boolean
}

export interface DownloadActivityFitArgs {
  activityId: number
}

export interface DownloadActivityFitResult {
  success: true
  activityId: number
  fileName: string
  sizeBytes: number
  sha256: string
}

export type CreateWorkoutArgs = WorkoutDef & {
  confirmed?: boolean
  confirmationId?: string
}

interface PendingWorkoutConfirmation {
  definitionHash: string
  expiresAt: number
}

const CONFIRMATION_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_CONFIRMATIONS = 20

export class GarminToolService {
  private readonly workoutConfirmations = new Map<string, PendingWorkoutConfirmation>()
  private readonly dateRequestLimiter = new AsyncSemaphore(4)

  constructor(
    private readonly client: GarminDataClient,
    private readonly options: GarminToolServiceOptions,
  ) {}

  async getActivities(args: ActivityArgs = {}): Promise<unknown[]> {
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 5), 1), 100)
    const offset = Math.max(Math.trunc(args.offset ?? 0), 0)
    const detail = args.detail ?? this.options.activityDetail
    const activities = await this.client.getActivities(offset, limit)
    return (activities as Record<string, unknown>[])
      .map(activity => formatActivity(activity, detail))
  }

  async downloadActivityFit(
    args: DownloadActivityFitArgs,
  ): Promise<DownloadActivityFitResult> {
    if (!Number.isSafeInteger(args.activityId) || args.activityId <= 0) {
      throw new PublicToolError('Invalid activityId: expected a positive integer')
    }
    if (
      typeof this.options.fitDownloadDir !== 'string'
      || !this.options.fitDownloadDir.trim()
    ) {
      throw new PublicToolError(
        'FIT download directory is not configured; set GARMIN_FIT_DOWNLOAD_DIR',
      )
    }
    const accountOutputDirectory = fitAccountOutputDirectory(
      this.options.fitDownloadDir,
      this.options.accountUsername,
    )

    let temporaryDirectory: string | undefined
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'garmin-connect-fit-'))
      if (process.platform !== 'win32') await chmod(temporaryDirectory, 0o700)

      await this.client.downloadOriginalActivityZip(
        args.activityId,
        temporaryDirectory,
      )
      const metadata = await exportFitFromZip({
        activityId: args.activityId,
        outputDir: accountOutputDirectory,
        // Never trust an upstream-returned path; the SDK contract writes this
        // fixed file name inside the private directory we just created.
        zipPath: join(temporaryDirectory, `${args.activityId}.zip`),
      })

      return {
        success: true,
        activityId: args.activityId,
        fileName: metadata.fileName,
        sizeBytes: metadata.sizeBytes,
        sha256: metadata.sha256,
      }
    } finally {
      if (temporaryDirectory) {
        // The FIT file is already committed with exclusive-create semantics.
        // A rare best-effort temp cleanup failure must not turn that success
        // into an error that encourages an unsafe duplicate retry.
        await rm(temporaryDirectory, { recursive: true, force: true })
          .catch(() => undefined)
      }
    }
  }

  async getSleep(args: DateRangeArgs = {}): Promise<unknown> {
    const start = validateDate('startDate', args.startDate ?? todayLocal())
    const end = validateDate('endDate', args.endDate ?? start)
    const dates = getDatesInRange(start, end)
    const results = await mapConcurrent(dates, 4, async (date) => {
      const raw = await this.dateRequestLimiter.run(() => this.client.getSleep(date))
      return formatSleep(raw as Record<string, unknown>)
    })
    return results.length === 1 ? results[0] : results
  }

  async getSteps(args: DateRangeArgs = {}): Promise<unknown> {
    const start = validateDate('startDate', args.startDate ?? todayLocal())
    const end = validateDate('endDate', args.endDate ?? start)
    const dates = getDatesInRange(start, end)
    const results = await mapConcurrent(dates, 4, async (date) => {
      const raw = await this.dateRequestLimiter.run(() => this.client.getSteps(date))
      return formatSteps(raw as Record<string, unknown>)
    })
    return results.length === 1 ? results[0] : results
  }

  async getHeartRate(args: DateRangeArgs = {}): Promise<unknown> {
    const start = validateDate('startDate', args.startDate ?? todayLocal())
    const end = validateDate('endDate', args.endDate ?? start)
    const dates = getDatesInRange(start, end)
    const results = await mapConcurrent(dates, 4, async (date) => {
      const raw = await this.dateRequestLimiter.run(() => this.client.getHeartRate(date))
      return formatHeartRate(raw as Record<string, unknown>)
    })
    return results.length === 1 ? results[0] : results
  }

  async getWeight(args: DateRangeArgs = {}): Promise<unknown> {
    const start = validateDate('startDate', args.startDate ?? todayLocal())
    const end = validateDate('endDate', args.endDate ?? start)
    const dates = getDatesInRange(start, end)
    const results = await mapConcurrent(dates, 4, async (date) => {
      const raw = await this.dateRequestLimiter.run(() => this.client.getWeight(date))
      return formatWeight(raw as Record<string, unknown>)
    })
    return results.length === 1 ? results[0] : results
  }

  async getWorkouts(args: PaginationArgs = {}): Promise<unknown[]> {
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 10), 1), 100)
    const offset = Math.max(Math.trunc(args.offset ?? 0), 0)
    const workouts = await this.client.getWorkouts(offset, limit)
    return (workouts as Record<string, unknown>[]).map(formatWorkout)
  }

  async getRunningAdvice(args: RunningAdviceArgs = {}): Promise<Record<string, unknown>> {
    const matchedSkills = findSkills(args.query).map(formatSkillCard)
    const result: Record<string, unknown> = {
      matchedSkills,
      totalSkillsInKB: 8,
      tip:
        'Use these coaching cards to give specific, actionable running advice. ' +
        'Cross-reference recent pace and heart-rate data when it is included.',
    }

    if (args.includeRecentActivities) {
      try {
        const activities = await this.client.getActivities(0, 5)
        result.recentRunningActivities = (activities as Record<string, unknown>[])
          .filter((activity) => {
            const activityType = activity.activityType
            const key = typeof activityType === 'object' && activityType !== null
              ? (activityType as Record<string, unknown>).typeKey
              : activityType
            const normalized = String(key ?? '').toLowerCase()
            return normalized.includes('run') || normalized.includes('trail')
          })
          .map(activity => formatActivity(activity, 'compact'))
      } catch {
        result.recentRunningActivities =
          'Recent Garmin activities are temporarily unavailable.'
      }
    }

    return result
  }

  async getProfile(): Promise<unknown> {
    const profile = await this.client.getUserProfile()
    return formatProfile(profile as Record<string, unknown>)
  }

  async createWorkout(args: CreateWorkoutArgs): Promise<Record<string, unknown>> {
    const { confirmed, confirmationId, ...definition } = args
    const validationError = validateWorkoutDef(definition)
    if (validationError) {
      throw new PublicToolError(`Invalid workout definition: ${validationError}`)
    }

    if (confirmed !== true) {
      const issuedConfirmationId = this.issueWorkoutConfirmation(definition)
      return {
        requiresConfirmation: true,
        confirmationId: issuedConfirmationId,
        workoutName: definition.name,
        sport: definition.sport ?? 'running',
        stepCount: definition.steps.length,
        preview: definition,
        message:
          'Review this workout with the user, then call create_garmin_workout again ' +
          'with the same definition, confirmed=true, and this confirmationId.',
      }
    }

    this.consumeWorkoutConfirmation(confirmationId, definition)

    const result = await this.client.addWorkout(buildGarminWorkout(definition))
    return {
      success: true,
      workoutId: result.workoutId ?? null,
      workoutName: definition.name,
      message: `Workout "${definition.name}" was created in the Garmin workout library.`,
    }
  }

  private issueWorkoutConfirmation(definition: WorkoutDef): string {
    this.pruneWorkoutConfirmations()
    while (this.workoutConfirmations.size >= MAX_PENDING_CONFIRMATIONS) {
      const oldest = this.workoutConfirmations.keys().next().value
      if (oldest === undefined) break
      this.workoutConfirmations.delete(oldest)
    }

    const confirmationId = randomUUID()
    this.workoutConfirmations.set(confirmationId, {
      definitionHash: workoutDefinitionHash(definition),
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    })
    return confirmationId
  }

  private consumeWorkoutConfirmation(
    confirmationId: string | undefined,
    definition: WorkoutDef,
  ): void {
    this.pruneWorkoutConfirmations()
    if (!confirmationId) {
      throw new PublicToolError(
        'Invalid workout confirmation: request a preview and provide its confirmationId',
      )
    }

    const pending = this.workoutConfirmations.get(confirmationId)
    this.workoutConfirmations.delete(confirmationId)
    if (!pending || pending.definitionHash !== workoutDefinitionHash(definition)) {
      throw new PublicToolError(
        'Invalid workout confirmation: the preview is missing, expired, already used, or changed',
      )
    }
  }

  private pruneWorkoutConfirmations(): void {
    const now = Date.now()
    for (const [id, confirmation] of this.workoutConfirmations) {
      if (confirmation.expiresAt <= now) this.workoutConfirmations.delete(id)
    }
  }
}

class AsyncSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    this.active += 1
    try {
      return await action()
    } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

function workoutDefinitionHash(definition: WorkoutDef): string {
  return createHash('sha256')
    .update(canonicalJson(definition))
    .digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function validateDate(name: string, value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw invalidDate(name)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw invalidDate(name)
  }

  return value
}

function invalidDate(name: string): Error {
  return new PublicToolError(`Invalid ${name}: expected a real date in YYYY-MM-DD format`)
}

export function getDatesInRange(start: string, end: string): string[] {
  const current = localDate(validateDate('startDate', start))
  const last = localDate(validateDate('endDate', end))
  if (current > last) {
    throw new PublicToolError('Invalid date range: endDate must be on or after startDate')
  }

  const dates: string[] = []
  while (current <= last) {
    if (dates.length === 30) throw new PublicToolError('Date range cannot exceed 30 days')
    dates.push(localDateString(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

function localDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  let failed = false
  let firstFailure: unknown

  async function worker(): Promise<void> {
    while (nextIndex < values.length && !failed) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await mapper(values[index])
      } catch (error) {
        if (!failed) {
          failed = true
          firstFailure = error
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  )
  if (failed) throw firstFailure
  return results
}

export function todayLocal(): string {
  return localDateString(new Date())
}
