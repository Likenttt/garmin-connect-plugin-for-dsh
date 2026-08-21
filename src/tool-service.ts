import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GarminRegion } from './config'
import { exportFitFromZip, fitAccountOutputDirectory } from './fit-export'
import type { ActivityDetail } from './utils/format'
import {
  RUNNING_SKILLS,
  TRAINING_PHILOSOPHIES,
  findSkills,
  findTrainingPhilosophies,
  formatSkillCard,
  formatSkillSummary,
  formatTrainingPhilosophy,
} from './knowledge/running-skills'
import type {
  CoachingLanguage,
  TrainingPhilosophy,
} from './knowledge/running-skills'
import {
  buildGarminWorkout,
  validateWorkoutDef,
} from './knowledge/workout-schema'
import type { WorkoutDef } from './knowledge/workout-schema'
import { PublicToolError } from './utils/errors'
import { parseLocalDate } from './utils/date'
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
  accountRegion: GarminRegion
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

export const RUNNING_ADVICE_MODES = ['explain', 'personalized'] as const
export const PERFORMANCE_BASES = [
  'recent_race',
  'time_trial',
  'no_recent_benchmark',
] as const
export const TRAINING_LOAD_PREFERENCES = ['steady', 'hard_easy', 'mixed'] as const
export const INTENSITY_GUIDANCE_PREFERENCES = [
  'pace',
  'heart_rate',
  'rpe',
  'mixed',
] as const
export const RUNNING_INTAKE_MIN_LENGTHS = {
  goal: 4,
  currentPerformance: 4,
  trainingBackground: 8,
  availability: 4,
  healthConstraints: 2,
} as const

export interface RunningAdviceArgs {
  mode: typeof RUNNING_ADVICE_MODES[number]
  query?: string
  includeRecentActivities?: boolean
  language?: CoachingLanguage
  goal?: string
  currentPerformance?: string
  performanceBasis?: typeof PERFORMANCE_BASES[number]
  trainingBackground?: string
  availability?: string
  healthConstraints?: string
  hasWarningSymptoms?: boolean
  trainingPreference?: typeof TRAINING_LOAD_PREFERENCES[number]
  maxQualitySessionsPerWeek?: number
  intensityGuidancePreference?: typeof INTENSITY_GUIDANCE_PREFERENCES[number]
}

export const RUNNING_INTAKE_FIELDS = [
  'goal',
  'currentPerformance',
  'performanceBasis',
  'trainingBackground',
  'availability',
  'healthConstraints',
  'hasWarningSymptoms',
  'trainingPreference',
  'maxQualitySessionsPerWeek',
  'intensityGuidancePreference',
] as const

export type RunningIntakeField = typeof RUNNING_INTAKE_FIELDS[number]

export interface RunningIntakeResult {
  requiresUserInput: true
  missingFields: RunningIntakeField[]
  questions: Array<{ field: RunningIntakeField; question: string }>
  instruction: string
}

export interface RunningAdviceResult extends Record<string, unknown> {
  requiresUserInput: false
  mode: 'explain' | 'personalized'
  matchedSkills: Array<Record<string, unknown>>
  trainingPhilosophies: Array<Record<string, unknown>>
  totalSkillsInKB: number
  totalPhilosophiesInKB: number
  evidenceLegend: Record<string, string>
  athleteContext?: Record<string, string | number | boolean>
  planningInstructions?: string[]
  recentRunningActivities?: unknown
}

export interface RunningSafetyStopResult {
  requiresUserInput: false
  mode: 'personalized'
  safetyStop: true
  instruction: string
}

export type RunningAdviceResponse =
  | RunningIntakeResult
  | RunningAdviceResult
  | RunningSafetyStopResult

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
      this.options.accountRegion,
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

  async getRunningAdvice(args: RunningAdviceArgs): Promise<RunningAdviceResponse> {
    const mode = args?.mode
    if (!isOneOf(RUNNING_ADVICE_MODES, mode)) {
      throw new PublicToolError(
        'Invalid running advice request: mode must be explain or personalized',
      )
    }
    const language = args.language ?? 'en'
    if (mode === 'personalized') {
      if (args.hasWarningSymptoms === true) {
        return {
          requiresUserInput: false,
          mode: 'personalized',
          safetyStop: true,
          instruction: language === 'zh-CN'
            ? '用户报告了胸部不适、轻微活动异常气短、晕厥/眩晕、异常心悸等健康警示症状。不要生成高强度或逐日训练计划，也不要自行诊断；请建议用户先取得医疗专业人员许可。'
            : 'The athlete reported warning symptoms such as chest discomfort, unusual breathlessness with mild activity, fainting/dizziness, or abnormal palpitations. Do not generate hard training or a daily plan and do not diagnose; advise medical clearance first.',
        }
      }
      const missingFields = missingRunningIntakeFields(args)
      if (missingFields.length > 0) {
        return {
          requiresUserInput: true,
          missingFields,
          questions: missingFields.map(field => ({
            field,
            question: runningIntakeQuestion(field, language),
          })),
          instruction: language === 'zh-CN'
            ? '请只询问上述缺失信息；在用户回答前不要生成逐日或逐周计划，也不要猜测训练量或强度。'
            : 'Ask only for the missing information above. Do not generate a daily or weekly plan, or guess training volume or intensity, until the user answers.',
        }
      }
    }

    const skills = findSkills(args.query)
    const matchedSkills = mode === 'personalized'
      ? skills.map(skill => formatSkillSummary(skill, language))
      : skills.map(skill => formatSkillCard(skill, language))
    const philosophies = mode === 'personalized'
      ? orderTrainingPhilosophies(args.trainingPreference!)
      : findTrainingPhilosophies(args.query)
    const result: RunningAdviceResult = {
      requiresUserInput: false,
      mode,
      matchedSkills,
      trainingPhilosophies: philosophies.map(philosophy => (
        formatTrainingPhilosophy(philosophy, language)
      )),
      totalSkillsInKB: RUNNING_SKILLS.length,
      totalPhilosophiesInKB: TRAINING_PHILOSOPHIES.length,
      evidenceLegend: language === 'zh-CN'
        ? {
          system_principle: '体系理念：用于说明方法如何训练，不代表优于其他方法。',
          research_evidence: '研究证据：结论必须服从样本、项目、周期和结局指标限制。',
          application_inference: '应用推断：面向该用户的保守转化，不是原研究直接结论。',
        }
        : {
          system_principle: 'System principle: defines how a method trains, not proof that it is superior.',
          research_evidence: 'Research evidence: interpretation is limited by sample, sport, duration, and outcomes.',
          application_inference: 'Application inference: a conservative user-specific translation, not a direct study conclusion.',
        },
    }

    if (mode === 'personalized') {
      result.athleteContext = {
        goal: args.goal!.trim(),
        currentPerformance: args.currentPerformance!.trim(),
        performanceBasis: args.performanceBasis!,
        trainingBackground: args.trainingBackground!.trim(),
        availability: args.availability!.trim(),
        healthConstraints: args.healthConstraints!.trim(),
        hasWarningSymptoms: args.hasWarningSymptoms!,
        trainingPreference: args.trainingPreference!,
        maxQualitySessionsPerWeek: args.maxQualitySessionsPerWeek!,
        intensityGuidancePreference: args.intensityGuidancePreference!,
      }
      result.planningInstructions = language === 'zh-CN'
        ? [
          '训练强度必须锚定当前成绩，不能用目标成绩反推训练配速。',
          '计划开头必须说明采用哪一种强度分区体系或配速/RPE 锚点；同一计划不能混用不同体系的分区名称或编号。',
          '说明借用了哪些训练体系原则、为何适合该用户，以及哪些部分未采用。',
          '给出周总量或总时长范围；每节课写明目的、强度锚点、热身和冷身，并明确轻松日、恢复日和休息日。',
          '写明因疼痛、疾病、睡眠不足、异常疲劳、天气或比赛而降级或停止的规则。',
          '每个调整周期只改变有限变量，不同时明显增加跑量、跑频、长跑和高强度。',
          '默认不安排双阈值；质量课必须受控、可恢复，并写明降级与停止规则。',
          '若用户描述当前疼痛、疾病或心血管健康警示症状，不安排高强度训练；建议先取得医疗专业人员许可，但不要自行诊断。',
          '计划必须服从可训练时间、伤病健康和恢复约束；安排 2–4 周复评，并根据完成率、RPE、疼痛、睡眠以及必要的比赛或计时测试更新，不能自动按目标配速升级。',
        ]
        : [
          'Anchor training intensity to current performance, never by reverse-engineering goal pace.',
          'At the start, name the intensity-zone system or pace/RPE anchors used; do not mix zone names or numbers from different systems in one plan.',
          'Name the principles borrowed from each system, why they fit, and what was not adopted.',
          'Give a weekly volume or time range; state each session\'s purpose, intensity anchor, warm-up and cool-down, plus easy, recovery, and rest days.',
          'Write explicit downgrade or stop rules for pain, illness, sleep loss, unusual fatigue, weather, or racing.',
          'Change only a limited number of variables per adjustment cycle; do not simultaneously raise volume, frequency, long-run load, and intensity.',
          'Do not prescribe double threshold by default; quality work must be controlled and recoverable with downgrade and stop rules.',
          'If the athlete reports current pain, illness, or cardiovascular warning symptoms, do not prescribe hard training; advise medical clearance without diagnosing.',
          'Respect availability, injury, health, and recovery constraints; reassess in 2–4 weeks using completion rate, RPE, pain, sleep, and any needed race or time-trial update, never an automatic progression toward goal pace.',
        ]
      if (args.performanceBasis === 'no_recent_benchmark') {
        result.planningInstructions.unshift(language === 'zh-CN'
          ? '当前没有可信近期成绩：先采用轻松基础训练或低风险基准测试，不给出精确的门槛/间歇配速。'
          : 'There is no trustworthy recent benchmark: begin with easy base work or a low-risk benchmark, and do not prescribe exact threshold or interval paces.')
      }
    } else {
      result.tip =
        'Explain the requested concept without inventing a personalized schedule. ' +
        'Use personalized mode before planning for an athlete.'
    }

    if (mode === 'personalized' && args.includeRecentActivities) {
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

function missingRunningIntakeFields(args: RunningAdviceArgs): RunningIntakeField[] {
  const warningSymptomConflict = args.hasWarningSymptoms === false
    && containsWarningSymptomTerm(args.healthConstraints)
  return RUNNING_INTAKE_FIELDS.filter((field) => {
    const value = args[field]
    if (field === 'hasWarningSymptoms') {
      return typeof value !== 'boolean' || warningSymptomConflict
    }
    if (field === 'healthConstraints' && warningSymptomConflict) return true
    if (field === 'healthConstraints' && isExplicitNoHealthConstraint(value)) {
      return false
    }
    if (field === 'trainingPreference') {
      return !isOneOf(TRAINING_LOAD_PREFERENCES, value)
    }
    if (field === 'performanceBasis') {
      return !isOneOf(PERFORMANCE_BASES, value)
        || (value !== 'no_recent_benchmark'
          && !hasRecentPerformanceFacts(args.currentPerformance))
    }
    if (field === 'maxQualitySessionsPerWeek') {
      return typeof value !== 'number'
        || !Number.isInteger(value)
        || value < 0
        || value > 7
    }
    if (field === 'intensityGuidancePreference') {
      return !isOneOf(INTENSITY_GUIDANCE_PREFERENCES, value)
    }
    if (typeof value !== 'string'
      || Array.from(value.trim()).length < minimumIntakeLength(field)
      || isFactFreePlaceholder(value)
      || containsUnresolvedPlaceholder(value)) return true
    if (field === 'goal') return !hasConcreteGoal(value)
    if (field === 'currentPerformance'
      && args.performanceBasis !== 'no_recent_benchmark') {
      return !hasRecentPerformanceFacts(value)
    }
    if (field === 'trainingBackground') return !hasTrainingBackgroundDetails(value)
    if (field === 'availability') return !hasAvailabilityDetails(value)
    if (field === 'healthConstraints') return !hasHealthConstraintDetails(value)
    return false
  })
}

function containsQuantity(value: string): boolean {
  return /\d|\b(?:one|two|three|four|five|six|seven)\b|[一二两三四五六七八九十]/iu.test(value)
}

function validIsoDates(value: string): Date[] | null {
  const dates = value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
  const parsed: Date[] = []
  for (const date of dates) {
    try {
      parsed.push(parseLocalDate(date))
    } catch {
      return null
    }
  }
  return parsed
}

function localStartOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function earliestRecentPerformanceDate(): number {
  const now = new Date()
  return new Date(now.getFullYear() - 2, now.getMonth(), now.getDate()).getTime()
}

function hasRecentPerformanceFacts(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const performanceDates = validIsoDates(value)
  const today = localStartOfToday()
  const earliest = earliestRecentPerformanceDate()
  const dateMatches = [...value.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)]
  if (!performanceDates || performanceDates.length === 0
    || !performanceDates.every(date => date.getTime() <= today)
    || !dateMatches.some((dateMatch, index) => {
      const timestamp = performanceDates[index].getTime()
      if (timestamp < earliest || timestamp > today) return false
      const previousDate = dateMatches[index - 1]
      const nextDate = dateMatches[index + 1]
      const start = previousDate
        ? (previousDate.index ?? 0) + previousDate[0].length
        : 0
      const end = nextDate?.index ?? value.length
      const datedContext = value.slice(start, end)
      return hasDistanceOrEventFact(datedContext)
        && hasTimedResultFact(datedContext)
    })) return false
  return hasDistanceOrEventFact(value)
    && hasTimedResultFact(value)
    && hasPerformanceEffortContext(value)
    && hasPerformanceConditionsContext(value)
    && !isFactFreePlaceholder(value)
}

function hasConcreteGoal(value: string): boolean {
  const goalDates = validIsoDates(value)
  if (!goalDates || goalDates.length === 0
    || !goalDates.every(date => date.getTime() > localStartOfToday())
    || !hasDistanceOrEventFact(value)) return false
  const hasTimedOutcome = hasTimedResultFact(value)
  if (/(?:完赛|完成比赛|finish|complete|completion)/iu.test(value)
    && !hasTimedOutcome) {
    return true
  }
  const hasTimedGoal = /(?:目标|target|goal|跑进|低于|少于|under|\bsub[- ]?\d)/iu.test(value)
    || hasTimedOutcome
  return hasTimedGoal && hasTimedOutcome && hasLabeledTimedGoalOutcomes(value)
}

function hasLabeledTimedGoalOutcomes(value: string): boolean {
  const labelPattern = /(?:minimum acceptable|minimum|floor|最低|保底|ideal|aspirational|理想|冲击)/giu
  const labels = [...value.matchAll(labelPattern)]
  let hasIdeal = false
  let hasMinimum = false
  labels.forEach((label, index) => {
    const start = (label.index ?? 0) + label[0].length
    const end = labels[index + 1]?.index ?? value.length
    const outcome = value.slice(start, end)
    if (!hasTimedResultFact(outcome) || containsUnresolvedPlaceholder(outcome)) return
    if (/(?:ideal|aspirational|理想|冲击)/iu.test(label[0])) hasIdeal = true
    else hasMinimum = true
  })
  return hasIdeal && hasMinimum
}

function hasPerformanceEffortContext(value: string): boolean {
  return /(?:all[- ]?out|full effort|not all[- ]?out|controlled effort|\bRPE\s*\d|全力|非全力|尽力|体感\s*\d|努力程度[^,，。;；]*(?:高|中|低|全力))/iu.test(value)
}

function hasPerformanceConditionsContext(value: string): boolean {
  return /(?:no material effect|(?:hot|cold|cool|warm|humid|windy|rainy|mild|normal)\s+(?:weather|conditions?)|(?:weather|conditions?)\s+(?:was\s+)?(?:hot|cold|cool|warm|humid|windy|rainy|mild|normal)|(?:flat|rolling|hilly|trail|road|track)\s+(?:course|terrain)|(?:course|terrain)\s+(?:was\s+)?(?:flat|rolling|hilly|technical)|(?:altitude|elevation)\s*(?:was\s+)?(?:\d+\s*(?:m|ft)|high|low|sea level)|(?:calm|strong|head|tail|cross)\s*wind|天气(?:炎热|寒冷|凉爽|温暖|潮湿|正常|有雨)|(?:平坦|起伏|丘陵|越野|公路|田径场)(?:赛道|路线|地形)|(?:赛道|路线|地形)(?:平坦|起伏|丘陵|技术性强)|海拔\s*(?:\d+\s*米|较高|较低|正常|海平面)|(?:无风|大风|逆风|顺风|侧风)|无明显影响)/iu.test(value)
}

function hasTrainingBackgroundDetails(value: string): boolean {
  return containsQuantity(value)
    && hasRunningHistoryDuration(value)
    && hasPositiveLoadNearLabel(value, /(?:average|\bavg\b|平均)/giu)
    && hasPositiveLoadNearLabel(value, /(?:peak|highest|\bmax\b|最高)/giu)
    && hasWeeklyFrequencyFact(value)
    && hasPositiveLoadNearLabel(value, /(?:longest|long run|最长|长跑)/giu)
    && /(?:\b(?:one|two|three|four|five|six|seven|\d+)\b[^,，。;；]{0,20}(?:quality|threshold|interval|tempo|strides)|(?:quality|threshold|interval|tempo|strides)[^,，。;；]{0,20}\b(?:one|two|three|four|five|six|seven|\d+)\b|no quality|质量|门槛|间歇|节奏|加速跑|无质量)/iu.test(value)
    && /(?:interrupt|break|abrupt|load change|consistent|stable load|中断|突变|负荷变化|负荷稳定|无中断)/iu.test(value)
}

function hasAvailabilityDetails(value: string): boolean {
  return containsQuantity(value)
    && hasRunningSessionTimeFact(value)
    && hasWeeklyFrequencyFact(value)
    && /(?:rest day|day off|\boff\b|休息日|休息)/iu.test(value)
    && /(?:long[- ]?run day|long run|长跑日|长跑)/iu.test(value)
    && /(?:track|road|trail|treadmill|hill|facility|terrain|场地|道路|公路|越野|跑步机|坡)/iu.test(value)
    && hasStrengthAvailabilityFact(value)
    && /(?:double days?|two[- ]a[- ]days?|no doubles?|doubles? unavailable|双练)/iu.test(value)
}

function hasHealthConstraintDetails(value: string): boolean {
  return hasCurrentPainOrInjuryFact(value)
    && /(?:past year|previous year|last year|(?:past|last|previous) 12 months|过去一年|近一年|过去 12 个月|近 12 个月)/iu.test(value)
    && /(?:disease|condition|疾病|无相关疾病)/iu.test(value)
    && /(?:medication|medicine|meds?|用药|服药|无相关用药)/iu.test(value)
    && /(?:sleep|睡眠)/iu.test(value)
    && /(?:stress|压力)/iu.test(value)
    && /(?:recovery|恢复)/iu.test(value)
}

function hasWeeklyFrequencyFact(value: string): boolean {
  const numericPattern = /(?<![-\d.])([+-]?\d+)\s+(?:days?|runs?)\s+(?:a|per)\s+(?:week|wk)|(?<![-\d.])([+-]?\d+)\s*(?:x|times?)\s*(?:\/|per)\s*(?:week|wk)|每周\s*(?:可|能|有|安排)?\s*(?:跑步?|训练)?\s*(?<![-\d.])([+-]?\d+)\s*(?:天|次)/giu
  if (hasNumericMatchInRange(
    value,
    numericPattern,
    1,
    7,
    match => isRunningRelevantClause(value, match.index, match[0].length),
  )) return true

  const wordPatterns = [
    /\b(?:one|two|three|four|five|six|seven)\s+(?:days?|runs?)\s+(?:a|per)\s+(?:week|wk)\b/giu,
    /每周\s*(?:可|能|有|安排)?\s*(?:跑步?|训练)?\s*[一二两三四五六七]\s*(?:天|次)/giu,
  ]
  return wordPatterns.some(pattern => [...value.matchAll(pattern)].some(match => (
    isRunningRelevantClause(value, match.index ?? 0, match[0].length)
  )))
}

function hasRunningHistoryDuration(value: string): boolean {
  const durationPattern = /(?:running\s+for|have\s+run\s+for|runner\s+for|running\s+history\s*(?:of|[:：])|started\s+running\s+)(?:about\s+|approximately\s+)?\s*(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:years?|months?|weeks?)|(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:years?|months?|weeks?)\s+(?:of\s+running|as\s+a\s+runner)|(?:跑龄|跑步)[^,，。;；]{0,8}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:年|个?月|周)/giu
  if (hasPositiveNumericMatch(value, durationPattern)) return true
  if (/(?:running\s+for|have\s+run\s+for|runner\s+for|running\s+history\s*(?:of|[:：])|started\s+running\s+)(?:about\s+|approximately\s+)?\s*(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:years?|months?|weeks?)/iu.test(value)) {
    return true
  }
  if (/(?:跑龄|跑步)[^,，。;；]{0,8}[一二两三四五六七八九十]+\s*(?:年|个?月)/iu.test(value)) {
    return true
  }

  const currentYear = new Date().getFullYear()
  const sincePattern = /(?:running\s+since|started\s+running\s+in)\s*(\d{4})|(?:从\s*)?(\d{4})\s*年\s*(?:开始)?跑步/giu
  let match: RegExpExecArray | null
  while ((match = sincePattern.exec(value)) !== null) {
    const year = Number(match[1] ?? match[2])
    if (year >= 1900 && year <= currentYear) return true
  }
  return false
}

function hasRunningSessionTimeFact(value: string): boolean {
  const durationPattern = /(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?)\s*(?:each\b|per\s+(?:run|running\s+day|training\s+day|session|day)\b)|(?:each(?:\s+(?:run|running\s+day|training\s+day|session|day))?|per\s+(?:run|running\s+day|training\s+day|session|day))[^,;]{0,12}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?)|(?:每次|每个(?:跑步|训练)日|每天)[^,，。;；]{0,12}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:分钟|小时)/giu
  let duration: RegExpExecArray | null
  while ((duration = durationPattern.exec(value)) !== null) {
    if (duration.slice(1).some(capture => capture !== undefined && Number(capture) > 0)
      && isRunningRelevantClause(value, duration.index, duration[0].length)) return true
  }
  const scheduledDurationPattern = /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|周[一二三四五六日天])[^,，。;；]{0,18}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?|分钟|小时)/giu
  let scheduled: RegExpExecArray | null
  while ((scheduled = scheduledDurationPattern.exec(value)) !== null) {
    if (scheduled.slice(1).some(capture => capture !== undefined && Number(capture) > 0)
      && isRunningRelevantClause(value, scheduled.index, scheduled[0].length)) return true
  }
  const wordDurationPattern = /(?:one|two|three|four|five|six)\s+(?:minutes?|hours?)\s+(?:each\b|per\s+(?:run|session|day)\b)/giu
  return [...value.matchAll(wordDurationPattern)].some(match => (
    isRunningRelevantClause(value, match.index ?? 0, match[0].length)
  ))
}

function hasCurrentPainOrInjuryFact(value: string): boolean {
  const painOrInjury = /(?:pain[- ]?free|injury[- ]?free|pain(?![- ]?(?:medication|medicine|meds?|killers?))|injur(?:y|ies|ed))/iu
  const englishCurrent = /\b(?:current(?:ly)?|presently|now)\b/giu
  for (const current of value.matchAll(englishCurrent)) {
    const index = current.index ?? 0
    const before = value.slice(0, index)
    const after = value.slice(index + current[0].length)
    const clauseStart = Math.max(
      before.lastIndexOf(','),
      before.lastIndexOf(';'),
      before.lastIndexOf('.'),
    ) + 1
    const boundaryOffsets = [',', ';', '.']
      .map(boundary => after.indexOf(boundary))
      .filter(offset => offset >= 0)
    const clauseEnd = boundaryOffsets.length > 0
      ? index + current[0].length + Math.min(...boundaryOffsets)
      : value.length
    const clause = value.slice(clauseStart, clauseEnd)
    if (painOrInjury.test(clause)) return true
  }
  return /(?:目前|当前|现在)[^,，。;；]{0,24}(?:疼痛|痛|伤病|受伤|无伤)/iu.test(value)
}

function hasNumericMatchInRange(
  value: string,
  pattern: RegExp,
  minimum: number,
  maximum: number,
  acceptMatch: (match: RegExpExecArray) => boolean = () => true,
): boolean {
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    if (match.slice(1).some((capture) => {
      if (capture === undefined) return false
      const number = Number(capture)
      return Number.isInteger(number) && number >= minimum && number <= maximum
    }) && acceptMatch(match)) return true
  }
  return false
}

function isRunningRelevantClause(value: string, index: number, length: number): boolean {
  const before = value.slice(0, index)
  const after = value.slice(index + length)
  const clauseStart = Math.max(
    before.lastIndexOf(','),
    before.lastIndexOf('，'),
    before.lastIndexOf(';'),
    before.lastIndexOf('；'),
    before.lastIndexOf('.'),
    before.lastIndexOf('。'),
  ) + 1
  const boundaryOffsets = [',', '，', ';', '；', '.', '。']
    .map(boundary => after.indexOf(boundary))
    .filter(offset => offset >= 0)
  const clauseEnd = boundaryOffsets.length > 0
    ? index + length + Math.min(...boundaryOffsets)
    : value.length
  const clause = value.slice(clauseStart, clauseEnd)
  const mentionsOtherTraining = /(?:strength|resistance|cycling|biking|bike|swimming|rowing|elliptical|力量|抗阻|骑行|骑车|游泳|划船|椭圆机)/iu.test(clause)
  const mentionsRunning = /(?:\bruns?\b|\brunning\b|跑步|跑训)/iu.test(clause)
  return !mentionsOtherTraining || mentionsRunning
}

function hasPositiveLoadNearLabel(value: string, labelPattern: RegExp): boolean {
  const labels = [...value.matchAll(labelPattern)]
  return labels.some((label) => {
    const start = (label.index ?? 0) + label[0].length
    const following = value.slice(start, start + 48)
    const nextField = following.search(/[,，。;；]|\band\s+(?=(?:average|avg|peak|highest|max|longest|long run)\b)|(?=(?:平均|最高|最长))/iu)
    const fieldValue = nextField >= 0 ? following.slice(0, nextField) : following
    const loadPattern = /(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:k(?:m)?|kilomet(?:er|re)s?|mi(?:le)?s?|minutes?|mins?|hours?|hrs?|公里|千米|英里|分钟|小时)/giu
    return hasPositiveNumericMatch(fieldValue, loadPattern)
  })
}

function hasStrengthAvailabilityFact(value: string): boolean {
  if (/(?:no|without|unavailable)[^,，。;；]{0,16}(?:strength|resistance)|(?:strength|resistance)[^,，。;；]{0,16}(?:unavailable|none)|(?:无|不安排)[^,，。;；]{0,12}(?:力量|抗阻)/iu.test(value)) {
    return true
  }
  const durationPattern = /(?:strength|resistance|力量|抗阻)[^,，。;；]{0,24}(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?|分钟|小时)|(?<![-\d.])([+-]?\d+(?:\.\d+)?)\s*(?:minutes?|mins?|hours?|hrs?|分钟|小时)[^,，。;；]{0,24}(?:strength|resistance|力量|抗阻)/giu
  return hasPositiveNumericMatch(value, durationPattern)
}

function hasDistanceOrEventFact(value: string): boolean {
  if (/(?:\b(?:half[- ]?marathon|marathon|mile)\b|全程马拉松|半程马拉松|全马|半马|马拉松)/iu.test(value)) {
    return true
  }
  const distancePattern = /(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:k(?:m)?|m|kilomet(?:er|re)s?|mi(?:le)?s?)\b|(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:公里|千米|英里)/giu
  return hasPositiveNumericMatch(value, distancePattern)
}

function hasTimedResultFact(value: string): boolean {
  const clockPattern = /(?<![\d.])(-?\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/gu
  let clock: RegExpExecArray | null
  while ((clock = clockPattern.exec(value)) !== null) {
    if (clock[1].startsWith('-')) continue
    const parts = clock.slice(1).filter(part => part !== undefined).map(Number)
    if (parts.some(part => part > 0)) return true
  }
  const durationPattern = /(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b|(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:小时|分钟|分|秒)/giu
  if (hasPositiveNumericMatch(value, durationPattern)) return true
  const apostrophePacePattern = /(?<![\d.])(-?\d{1,2})\s*['′]\s*([0-5]\d)\s*["″]?/gu
  let pace: RegExpExecArray | null
  while ((pace = apostrophePacePattern.exec(value)) !== null) {
    if (pace[1].startsWith('-')) continue
    if (Number(pace[1]) > 0 || Number(pace[2]) > 0) return true
  }
  return false
}

function hasPositiveNumericMatch(value: string, pattern: RegExp): boolean {
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    if (match.slice(1).some(capture => capture !== undefined && Number(capture) > 0)) {
      return true
    }
  }
  return false
}

function isExplicitNoHealthConstraint(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.normalize('NFKC').trim().toLowerCase()
    .replace(/[\s?!.。,，!！?？_\-/]/gu, '')
  return new Set([
    'none',
    'noconstraints',
    'nohealthconstraints',
    '无',
    '没有',
    '无约束',
    '无健康约束',
  ]).has(normalized)
}

function containsWarningSymptomTerm(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /(?:chest\s+(?:discomfort|pain|pressure|tightness|heaviness|aches?)|(?:pressure|pain|tightness|heaviness|aches?)\s+(?:in|across)\s+(?:my\s+|the\s+)?chest|unusual\s+breathlessness|shortness\s+of\s+breath|breathless(?:ness)?|dyspn(?:ea|oea)|cannot\s+breathe|faint(?:ing|ed)?|syncope|(?:lost|loss\s+of)\s+consciousness|dizz(?:y|iness)|light[- ]?headed(?:ness)?|pass(?:ed)?\s+out|black(?:ed)?\s+out|palpitations?|heart\s+(?:races?|racing|flutters?|fluttering|pounds?|pounding)|irregular\s+heartbeat|胸部不适|胸痛|胸闷|胸(?:口|部)(?:有|感到)?(?:压迫(?:感)?|痛|疼)|异常气短|气短|喘不过气|呼吸困难|晕厥|晕倒|昏倒|昏厥|失去意识|眼前发黑|眩晕|头晕|心悸|心慌|心跳异常|心跳过快)/iu.test(value)
}

function containsUnresolvedPlaceholder(value: string): boolean {
  return /(?:\b(?:TBD|unknown|n\/?a)\b|待定|未知|不知道)/iu.test(value)
}

function isFactFreePlaceholder(value: string): boolean {
  const normalized = value.normalize('NFKC').trim().toLowerCase()
    .replace(/[\s?!.。,，!！?？_\-/]/gu, '')
  return new Set([
    'x',
    'xx',
    'xxx',
    'none',
    'unknown',
    'tbd',
    'ok',
    'na',
    'n/a',
    '不知道',
    '未知',
    '待定',
  ]).has(normalized)
}

function minimumIntakeLength(field: RunningIntakeField): number {
  switch (field) {
    case 'goal':
    case 'currentPerformance':
    case 'trainingBackground':
    case 'availability':
    case 'healthConstraints':
      return RUNNING_INTAKE_MIN_LENGTHS[field]
    default:
      return 1
  }
}

function isOneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function runningIntakeQuestion(
  field: RunningIntakeField,
  language: CoachingLanguage,
): string {
  const questions: Record<RunningIntakeField, { 'zh-CN': string; en: string }> = {
    goal: {
      'zh-CN': '你的训练目标是什么？请说明距离或赛事、未来的 ISO YYYY-MM-DD 日期，以及目标是完赛还是目标成绩；若有成绩目标，请区分理想目标和最低可接受目标。',
      en: 'What is your goal? Include the distance or event, a future ISO YYYY-MM-DD date, and whether the aim is completion or a target time; for a time goal, distinguish the ideal from the minimum acceptable outcome.',
    },
    currentPerformance: {
      'zh-CN': '你目前的成绩水平如何？请提供近期（过去两年内）代表性的比赛或计时测试距离、成绩和不晚于今天的 ISO YYYY-MM-DD 日期，并说明是否全力以及天气、赛道或海拔是否明显影响；若没有基准也请明确说明。',
      en: 'What is your current performance level? Give a representative race or time trial from the past two years, including distance, result, a non-future ISO YYYY-MM-DD date, whether it was all-out, and any major weather, course, or altitude effect; explicitly say if no benchmark exists.',
    },
    performanceBasis: {
      'zh-CN': '当前水平依据是什么：近期比赛（recent_race）、计时测试（time_trial），还是暂无近期基准（no_recent_benchmark）？',
      en: 'What is the performance basis: a recent race (recent_race), time trial (time_trial), or no recent benchmark (no_recent_benchmark)?',
    },
    trainingBackground: {
      'zh-CN': '请说明跑龄、最近 4–8 周平均和最高周跑量或时长、每周跑步天数、最长跑、质量课，以及近三个月中断或负荷突变。',
      en: 'Describe your running history, average and peak weekly volume or time over the last 4–8 weeks, days per week, longest run, quality sessions, and interruptions or abrupt load changes in the last three months.',
    },
    availability: {
      'zh-CN': '你每周可跑几天、各天可用多久、固定休息日和长跑日是什么？有哪些场地或器材限制，能安排多少力量训练时间？双练默认不安排；若你有双练条件也请明确说明。',
      en: 'How many days and how much time can you train each week? State fixed rest and long-run days, facility or terrain limits, and available strength-training time. Double days default to unavailable; explicitly say if they are possible.',
    },
    healthConstraints: {
      'zh-CN': '请说明当前疼痛/伤病、过去一年主要跑伤、已知心血管/代谢/肾脏疾病、影响心率的用药，以及睡眠、压力和恢复；没有也请明确回答。',
      en: 'Describe current pain/injury, major running injuries in the past year, known cardiovascular/metabolic/kidney disease, medication affecting heart rate, and sleep, stress, and recovery; explicitly say none if applicable.',
    },
    hasWarningSymptoms: {
      'zh-CN': '目前是否有胸部不适、轻微活动异常气短、晕厥/眩晕或异常心悸等健康警示症状？请明确回答 true 或 false；若健康描述出现这些词但你填写 false，请澄清矛盾：存在就改为 true，确实不存在就把健康描述改写成不含歧义症状词的明确“无”。',
      en: 'Do you currently have warning symptoms such as chest discomfort, unusual breathlessness with mild activity, fainting/dizziness, or abnormal palpitations? Answer true or false explicitly; if the health text mentions these terms while the flag is false, resolve the conflict: set true when present, or restate the health answer as clearly absent without ambiguous symptom wording.',
    },
    trainingPreference: {
      'zh-CN': '你偏好哪种负荷模式：均匀稳定、艰苦日与轻松日反差明显，还是混合/无偏好？',
      en: 'Which load pattern do you prefer: steady and even, clearly separated hard/easy days, or mixed/no preference?',
    },
    maxQualitySessionsPerWeek: {
      'zh-CN': '你每周最多愿意且有条件完成几次质量课？请给出 0–7 的整数；这只是个人上限，不代表计划一定会安排这么多。',
      en: 'What is the maximum number of quality sessions you are willing and able to complete per week (integer 0–7)? This is a personal ceiling, not a prescription.',
    },
    intensityGuidancePreference: {
      'zh-CN': '你更喜欢用配速（pace）、心率（heart_rate）、RPE/体感（rpe）还是混合方式（mixed）执行强度？',
      en: 'How do you prefer intensity guidance: pace, heart rate (heart_rate), perceived effort (rpe), or mixed?',
    },
  }
  return questions[field][language]
}

function orderTrainingPhilosophies(
  preference: NonNullable<RunningAdviceArgs['trainingPreference']>,
): TrainingPhilosophy[] {
  const preferredId = preference === 'steady'
    ? 'hansons'
    : preference === 'hard_easy'
      ? 'polarized'
      : 'daniels'
  return [...TRAINING_PHILOSOPHIES].sort((left, right) => (
    Number(right.id === preferredId) - Number(left.id === preferredId)
  ))
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
