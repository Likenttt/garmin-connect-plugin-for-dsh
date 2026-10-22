import { Context } from '@deepseek-ai/cordis'
import type { GarminClientLike } from '../client'
import { PERSONAL_TOOL_NAMES } from '../personal-capabilities'
import type { Config, GarminRegion } from '../config'
import { HEALTH_TOOLS } from '../health-tools'
import type { HealthMetricArgs } from '../health-tools'
import { PublicToolError, publicErrorMessage } from '../utils/errors'
import {
  GarminToolService,
  INTENSITY_GUIDANCE_PREFERENCES,
  PERFORMANCE_BASES,
  RUNNING_ADVICE_MODES,
  RUNNING_INTAKE_MIN_LENGTHS,
  TRAINING_LOAD_PREFERENCES,
  getDatesInRange,
  todayLocal,
} from '../tool-service'
import type {
  ActivityArgs,
  CreateWorkoutArgs,
  DateRangeArgs,
  DownloadActivityFitArgs,
  PaginationArgs,
  RunningAdviceArgs,
} from '../tool-service'
import { GARMIN_RESOURCE_ID_PATTERN } from '../workout-management'
import type {
  DeleteWorkoutArgs,
  ScheduledWorkoutsArgs,
  UnscheduleWorkoutArgs,
} from '../workout-management'

export { getDatesInRange, todayLocal } from '../tool-service'

export interface GarminToolAccount {
  accountId: string
  slot: number
  region: GarminRegion
  alias?: string
  configured: boolean
  client: GarminClientLike
  config: Config
}

interface AccountArgs {
  account?: string
}

const accountParameter = {
  type: 'string',
  pattern: '^[a-z][a-z0-9_-]{0,31}$',
  description: 'Stable Garmin account ID from the plugin settings. Required when multiple accounts are configured. cn/global legacy selectors work only when one account uses that region.',
}

/**
 * Register all Garmin-related tools with the DeepSeek Harness tool registry.
 *
 * Definitions follow the dsh tool registry contract:
 *   - `parameters` is a JSON Schema object (compiled form),
 *   - `output` declares a JSON Schema plus a `render` callback that turns the
 *     execution result into text content blocks for the UI / trajectory.
 */
export function registerTools(ctx: Context, accounts: readonly GarminToolAccount[]): void {
  const registry = (ctx as any).tools
  let registeredCount = 0
  const personalOnly = accounts.length > 0 && accounts.every(account => account.config.provider === 'personal')
  const tools = { register: (definition: { name: string; [key: string]: unknown }) => {
    if (!personalOnly || PERSONAL_TOOL_NAMES.has(definition.name)) {
      registry.register(definition)
      registeredCount += 1
    }
  } }
  const configuredAccounts = accounts.filter(account => account.configured)
  const services = new Map(accounts.map(({ accountId, alias, region, client, config }) => [
    accountId,
    new GarminToolService(client, {
      accountId,
      accountAlias: alias,
      provider: config.provider,
      activityDetail: config.activityDetail,
      fitDownloadDir: config.fitDownloadDir,
      accountUsername: config.provider === 'personal' ? `personal:${accountId}` : config.username,
      accountRegion: region,
    }),
  ] as const))
  const selectService = (accountId?: string): GarminToolService => {
    if (accountId !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(accountId)) {
      throw new PublicToolError('account must be a valid Garmin account ID')
    }
    if (accountId) {
      const exact = configuredAccounts.find(account => account.accountId === accountId)
      if (exact) return services.get(exact.accountId)!
      if (accountId === 'cn' || accountId === 'global') {
        const regional = configuredAccounts.filter(account => account.region === accountId)
        if (regional.length === 1) return services.get(regional[0].accountId)!
        if (regional.length > 1) {
          throw new PublicToolError(`Multiple Garmin ${accountId} accounts are configured. Select a specific account ID.`)
        }
        throw new PublicToolError(`No Garmin ${accountId} account is configured. Add it in the plugin settings.`)
      }
      if (accounts.some(account => account.accountId === accountId)) {
        const selected = accounts.find(account => account.accountId === accountId)
        throw new PublicToolError(selected?.config.provider === 'personal'
          ? `Garmin account ${accountId} has no Personal API Key configured. Add it in the plugin settings.`
          : `Garmin account ${accountId} has no email configured. Add it in the plugin settings.`)
      }
      throw new PublicToolError(`Garmin account ${accountId} is not configured. Select an account ID from the plugin settings.`)
    }
    if (configuredAccounts.length === 1) return services.get(configuredAccounts[0].accountId)!
    if (configuredAccounts.length === 0) {
      throw new PublicToolError('No Garmin account is configured. Add an account in the plugin settings.')
    }
    const ids = configuredAccounts.map(account => account.alias
      ? `${account.accountId} (${JSON.stringify(account.alias)})`
      : account.accountId).join(', ')
    throw new PublicToolError(`Multiple Garmin accounts are configured. Set account to an account ID: ${ids}.`)
  }
  // Running concepts and intake are local knowledge. Keep them usable before
  // login and without account selection; only activity enrichment reads Garmin.
  const knowledgeService = services.values().next().value as GarminToolService | undefined
    ?? new GarminToolService({} as GarminClientLike, {
      activityDetail: 'full',
      fitDownloadDir: '',
      accountUsername: '',
      accountRegion: 'cn',
    })

  // Native range endpoints return full reports in a single request.
  for (const definition of HEALTH_TOOLS) {
    const dateProperty = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Calendar date in YYYY-MM-DD format.' }
    const properties: Record<string, unknown> = { account: accountParameter }
    if (definition.kind === 'daily') properties.date = dateProperty
    if (definition.kind === 'range' || definition.kind === 'raceRange') {
      properties.startDate = { ...dateProperty, description: 'Inclusive start date (default: today).' }
      properties.endDate = { ...dateProperty, description: 'Inclusive end date (default: startDate).' }
    }
    if (definition.kind === 'raceRange') {
      properties.aggregation = { type: 'string', enum: ['daily', 'monthly'], description: 'History aggregation (default: daily).' }
    }
    tools.register({
      name: definition.name,
      description: `${definition.description} Returns the full service response; null or empty arrays can mean no data for this account/date.`,
      parameters: { type: 'object', additionalProperties: false, properties },
      output: flexibleOutput,
      execute: async (args: HealthMetricArgs & AccountArgs = {}) => {
        try {
          const { account, ...request } = args
          return await selectService(account).getHealthMetric(definition.method, request)
        } catch (error) {
          return toolError(error, 'Failed to fetch Garmin health data')
        }
      },
    })
  }

  // ------------------------------------------------------------------
  // 1. get_garmin_activities
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_activities',
    description:
      'Retrieve the user\'s recent Garmin fitness activities (runs, rides, swims, hikes, etc.). ' +
      'Returns available expanded activity fields by default, including split summaries when Garmin supplies them. ' +
      'Pass detail="compact" for a smaller response. Full can include precise route/location fields ' +
      'but filters credentials and account/social identifiers. ' +
      'Example user query: "Show me my last 5 runs"',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: accountParameter,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of activities to return (1–100).',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Pagination offset. 0 = most recent.',
        },
        detail: {
          type: 'string',
          enum: ['compact', 'full'],
          description: 'full (default) preserves available expanded activity fields, possibly including precise location/route data; compact returns curated fields. Credentials and account/social identifiers are filtered.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: ActivityArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).getActivities(request)
      } catch (error) {
        return toolError(error, 'Failed to fetch activities')
      }
    },
  })

  // ------------------------------------------------------------------
  // 2. get_garmin_sleep
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_sleep',
    description:
      'Get the user\'s sleep data for a specific date or date range, including sleep score, ' +
      'total duration, and breakdowns (deep, light, REM, awake). ' +
      'Example user query: "How did I sleep last night?" or "My sleep trend this week"',
    parameters: dateRangeParameters,
    output: flexibleOutput,
    execute: async (args: DateRangeArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).getSleep(request)
      } catch (error) {
        return toolError(error, 'Failed to fetch sleep data')
      }
    },
  })

  // ------------------------------------------------------------------
  // 3. get_garmin_steps
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_steps',
    description:
      'Get the user\'s step count for a specific date or range. Goal and walking distance are ' +
      'included only when the upstream Garmin response provides them. ' +
      'Example user query: "How many steps did I take today?"',
    parameters: dateRangeParameters,
    output: flexibleOutput,
    execute: async (args: DateRangeArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).getSteps(request)
      } catch (error) {
        return toolError(error, 'Failed to fetch steps')
      }
    },
  })

  // ------------------------------------------------------------------
  // 4. get_garmin_heart_rate
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_heart_rate',
    description:
      'Get the user\'s heart rate summary for a specific date or range, including ' +
      'resting, max, and min heart rate. ' +
      'Example user query: "What is my resting heart rate?"',
    parameters: dateRangeParameters,
    output: flexibleOutput,
    execute: async (args: DateRangeArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).getHeartRate(request)
      } catch (error) {
        return toolError(error, 'Failed to fetch heart rate')
      }
    },
  })

  // ------------------------------------------------------------------
  // 5. get_garmin_weight
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_weight',
    description:
      'Get the user\'s body composition data (weight, BMI, body fat, etc.) for a specific date or range. ' +
      'Example user query: "What was my weight today?"',
    parameters: dateRangeParameters,
    output: flexibleOutput,
    execute: async (args: DateRangeArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).getWeight(request)
      } catch (error) {
        return toolError(error, 'Failed to fetch weight data')
      }
    },
  })

  // ------------------------------------------------------------------
  // 6. get_garmin_workouts
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_workouts',
    description:
      'Get reusable workout templates from the user\'s Garmin workout library. ' +
      'Example user query: "What workouts are in my Garmin library?"',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: accountParameter,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of workouts to return (1–100).',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Pagination offset. 0 = most recent.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: PaginationArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).getWorkouts(request)
      } catch (error) {
        return toolError(error, 'Failed to fetch workouts')
      }
    },
  })

  // ------------------------------------------------------------------
  // 7. get_garmin_profile
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_scheduled_workouts',
    description:
      'Read Garmin calendar workout entries for an inclusive date range of at most 31 days ' +
      '(default: today). Returns the full service response, including scheduleId values needed ' +
      'to cancel a calendar entry. This is separate from get_garmin_workouts, which reads the workout library.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: accountParameter,
        startDate: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Inclusive start date (default: today).',
        },
        endDate: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Inclusive end date (default: startDate); at most 31 days.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: ScheduledWorkoutsArgs & AccountArgs = {}) => {
      try {
        const { account, ...request } = args
        return await selectService(account).getScheduledWorkouts(request)
      } catch (error) {
        return toolError(error, 'Failed to fetch scheduled workouts')
      }
    },
  })

  tools.register({
    name: 'delete_garmin_workout',
    description:
      'Delete one workout template from the selected Garmin account library; this does not cancel ' +
      'a single calendar occurrence. First call without confirmed=true for a preview. Show the ' +
      'preview account and workout to the user; only after explicit approval call again with the ' +
      'same account, workoutId, confirmed=true, and confirmationId. Never batch-delete or ' +
      'automatically retry. If the outcome is unknown, perform a read-only check before further action.',
    parameters: {
      type: 'object',
      required: ['workoutId'],
      additionalProperties: false,
      properties: {
        account: accountParameter,
        workoutId: {
          ...garminResourceIdParameter,
          description: 'Workout library ID from get_garmin_workouts. Use a decimal string for IDs larger than a safe integer.',
        },
        ...destructiveConfirmationParameters,
      },
    },
    output: flexibleOutput,
    execute: async (args: DeleteWorkoutArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).deleteWorkout(request)
      } catch (error) {
        return toolError(error, 'Failed to delete workout')
      }
    },
  })

  tools.register({
    name: 'unschedule_garmin_workout',
    description:
      'Cancel one calendar workout occurrence from the selected Garmin account while retaining ' +
      'its workout library template. Use scheduleId from get_garmin_scheduled_workouts, never a ' +
      'workoutId. First call without confirmed=true for a preview. Show the preview account and ' +
      'calendar entry to the user; only after explicit approval call again with the same account, ' +
      'scheduleId, confirmed=true, and confirmationId. Never batch-cancel or automatically retry. ' +
      'If the outcome is unknown, perform a read-only calendar check before further action.',
    parameters: {
      type: 'object',
      required: ['scheduleId'],
      additionalProperties: false,
      properties: {
        account: accountParameter,
        scheduleId: {
          ...garminResourceIdParameter,
          description: 'Calendar occurrence ID from get_garmin_scheduled_workouts, distinct from workoutId. Use a decimal string for large IDs.',
        },
        ...destructiveConfirmationParameters,
      },
    },
    output: flexibleOutput,
    execute: async (args: UnscheduleWorkoutArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).unscheduleWorkout(request)
      } catch (error) {
        return toolError(error, 'Failed to cancel scheduled workout')
      }
    },
  })

  tools.register({
    name: 'get_garmin_profile',
    description:
      'Get the user\'s Garmin profile summary (display name, profile image URL, etc.).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { account: accountParameter },
    },
    output: flexibleOutput,
    execute: async (args: AccountArgs = {}) => {
      try {
        return await selectService(args.account).getProfile()
      } catch (error) {
        return toolError(error, 'Failed to fetch profile')
      }
    },
  })

  // ------------------------------------------------------------------
  // 8. get_running_skill_advice
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_running_skill_advice',
    description:
      'Explain 8 running workout types plus the Hansons, Jack Daniels, Norwegian threshold, ' +
      'and polarized training philosophies. Use mode="explain" only for concepts. ' +
      'For any athlete-specific recommendation or plan, use mode="personalized" and ask for ' +
      'every missing intake field returned by the tool before planning: goal, current performance, ' +
      'training background, availability, health/recovery constraints, and preferred load pattern ' +
      '(steady, clearly separated hard/easy, or mixed), including quality-session and intensity-guidance preferences. ' +
      'If warning symptoms are reported, stop planning and follow the tool\'s medical-clearance guidance. Never guess missing answers. ' +
      'Recent Garmin running activities and recovery metrics can supplement but never replace the intake. ' +
      'Use only tools and schemas actually available: HRV trends via get_garmin_hrv_summaries, ' +
      'daily HRV details via get_garmin_hrv; readiness decisions combine get_garmin_training_readiness ' +
      'with sleep, recent activities, and subjective state, adding stress, Body Battery, or training status as needed. ' +
      'Fetch only relevant metrics, keep calls on one stable account ID, and never set intensity from one reading or score. ' +
      'Distinguish unavailable tools, empty data, and authentication failures. ' +
      'Concept explanations and intake questions do not require an account.',
    parameters: {
      type: 'object',
      required: ['mode'],
      additionalProperties: false,
      properties: {
        account: {
          ...accountParameter,
          description: 'Garmin account ID for recent activity enrichment. Required when multiple accounts are configured and personalized advice includes recent activities.',
        },
        mode: {
          type: 'string',
          enum: RUNNING_ADVICE_MODES,
          description:
            'explain = concepts only; personalized = athlete-specific recommendations or planning with mandatory intake.',
        },
        query: {
          type: 'string',
          maxLength: 100,
          description:
            'Optional workout type or philosophy keyword, such as "threshold", "Daniels", "挪威", or "polarized". Pass "all" or omit for the full compact set.',
        },
        includeRecentActivities: {
          type: 'boolean',
          description:
            'If true, also fetches the user\'s 5 most recent Garmin running activities ' +
            'after personalized intake is complete. Activity data does not replace the required answers.',
        },
        language: {
          type: 'string',
          enum: ['zh-CN', 'en'],
          description: 'Language for questions and compact personalized planning material.',
        },
        goal: {
          type: 'string',
          minLength: RUNNING_INTAKE_MIN_LENGTHS.goal,
          maxLength: 500,
          description: 'Target event/distance, future ISO YYYY-MM-DD date, and completion or ideal/minimum time goal.',
        },
        currentPerformance: {
          type: 'string',
          minLength: RUNNING_INTAKE_MIN_LENGTHS.currentPerformance,
          maxLength: 500,
          description: 'Representative race or time trial from the past two years, result, non-future ISO YYYY-MM-DD date, effort, and material conditions; explicitly state no benchmark when applicable.',
        },
        performanceBasis: {
          type: 'string',
          enum: PERFORMANCE_BASES,
          description: 'Whether current performance comes from a recent race, time trial, or no trustworthy recent benchmark.',
        },
        trainingBackground: {
          type: 'string',
          minLength: RUNNING_INTAKE_MIN_LENGTHS.trainingBackground,
          maxLength: 1000,
          description: 'Running history and recent 4–8 week volume, frequency, long run, quality work, and interruptions.',
        },
        availability: {
          type: 'string',
          minLength: RUNNING_INTAKE_MIN_LENGTHS.availability,
          maxLength: 750,
          description: 'Available days/time, fixed rest or long-run days, terrain/facility limits, strength-training time, and whether double days are possible.',
        },
        healthConstraints: {
          type: 'string',
          minLength: RUNNING_INTAKE_MIN_LENGTHS.healthConstraints,
          maxLength: 750,
          description: 'Current/past-year injury, pain, relevant disease or medication, sleep, stress, and recovery constraints; explicitly state none when applicable.',
        },
        hasWarningSymptoms: {
          type: 'boolean',
          description: 'True for current chest discomfort, abnormal breathlessness with mild activity, fainting/dizziness, or abnormal palpitations. True stops hard-training planning.',
        },
        trainingPreference: {
          type: 'string',
          enum: TRAINING_LOAD_PREFERENCES,
          description: 'Preferred load pattern: steady/even, distinct hard/easy days, or mixed/no preference.',
        },
        maxQualitySessionsPerWeek: {
          type: 'integer',
          minimum: 0,
          maximum: 7,
          description: 'User\'s maximum acceptable quality sessions per week; a ceiling, not a prescription.',
        },
        intensityGuidancePreference: {
          type: 'string',
          enum: INTENSITY_GUIDANCE_PREFERENCES,
          description: 'How the user prefers training intensity to be communicated and executed.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: RunningAdviceArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        const service = request.mode === 'personalized' && request.includeRecentActivities
          ? selectService(account)
          : account ? selectService(account) : knowledgeService
        return await service.getRunningAdvice(request)
      } catch (error) {
        return toolError(error, 'Failed to look up running skills')
      }
    },
  })

  // ------------------------------------------------------------------
  // 9. create_garmin_workout
  // ------------------------------------------------------------------
  tools.register({
    name: 'create_garmin_workout',
    description:
      'Preview or create a structured workout in the user\'s Garmin Connect workout library. ' +
      'Supports warmup, interval, recovery, cooldown, rest steps with pace/HR targets, and repeat groups. ' +
      'The first call returns a preview and confirmationId without writing. Only call again with ' +
      'confirmed=true and that confirmationId after the user explicitly approves the preview. ' +
      'Device sync behavior depends on Garmin Connect settings. ' +
      'This execution tool does not generate a training plan: it may encode a workout the user ' +
      'already specified, or one derived after completed coaching intake. ' +
      'IMPORTANT: for a personalized workout, first complete the mandatory intake through ' +
      'get_running_skill_advice with mode="personalized"; recent activities cannot replace it. ' +
      'Example: user says "帮我创建一个门槛跑训练" or "Create a 10K race-pace workout". ' +
      'Step format guide: ' +
      'type: warmup|interval|recovery|cooldown|rest|repeat. ' +
      'endCondition: distance (endValue in meters), time (endValue in seconds), or lapButton. ' +
      'target: open (free run), pace (set paceFrom/paceTo as "mm:ss" per km), heartRate (set hrFrom/hrTo in bpm). ' +
      'For repeat groups: set iterations and nest sub-steps in steps array.',
    parameters: {
      type: 'object',
      required: ['name', 'steps'],
      additionalProperties: false,
      properties: {
        account: accountParameter,
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          description: 'Workout name shown on the watch, e.g. "周二·轻松跑6km"',
        },
        description: {
          type: 'string',
          maxLength: 1024,
          description: 'Coaching notes (shown in Garmin Connect app)',
        },
        sport: {
          type: 'string',
          enum: ['running', 'cycling', 'swimming', 'strength'],
          description: 'Sport type (default: running)',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set true only after the user explicitly approves the returned preview.',
        },
        confirmationId: {
          type: 'string',
          format: 'uuid',
          description: 'One-time ID returned by the matching preview call.',
        },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description: 'Ordered workout steps',
          items: workoutStepParameters,
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: CreateWorkoutArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).createWorkout(request)
      } catch (error) {
        return toolError(error, 'Failed to create workout')
      }
    },
  })

  // ------------------------------------------------------------------
  // 10. download_garmin_activity_fit
  // ------------------------------------------------------------------
  tools.register({
    name: 'download_garmin_activity_fit',
    description:
      'Download one Garmin activity as a FIT file to the trusted local directory explicitly ' +
      'configured with GARMIN_FIT_DOWNLOAD_DIR. This variable selects a parent directory; ' +
      'files are isolated under GARMIN_FIT_<region>_<account-email>. Local configuration is required. ' +
      'Returns non-sensitive file metadata without the local path or FIT binary. ' +
      'Existing FIT files are never overwritten.',
    parameters: {
      type: 'object',
      required: ['activityId'],
      additionalProperties: false,
      properties: {
        account: accountParameter,
        activityId: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'Positive Garmin activity ID returned by get_garmin_activities.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: DownloadActivityFitArgs & AccountArgs) => {
      try {
        const { account, ...request } = args
        return await selectService(account).downloadActivityFit(request)
      } catch (error) {
        return toolError(error, 'Failed to download FIT activity file')
      }
    },
  })

  ctx.logger.info(`[garmin] Registered ${registeredCount} tools.`)
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const garminResourceIdParameter = {
  oneOf: [
    { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    { type: 'string', pattern: GARMIN_RESOURCE_ID_PATTERN },
  ],
}

const destructiveConfirmationParameters = {
  confirmed: {
    type: 'boolean',
    description: 'Set true only after the user explicitly approves the account and object in the matching preview.',
  },
  confirmationId: {
    type: 'string',
    format: 'uuid',
    description: 'One-time ID from the matching preview for this account, operation, and resource ID.',
  },
}

/** Date range parameters shared by sleep / steps / heart rate / weight tools. */
const dateRangeParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account: accountParameter,
    startDate: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'Start date in YYYY-MM-DD format. Defaults to today.',
    },
    endDate: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'End date in YYYY-MM-DD format. If omitted, queries only the startDate.',
    },
  },
}

const simpleWorkoutStepParameters = {
  type: 'object',
  required: ['type', 'endCondition'],
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: ['warmup', 'interval', 'recovery', 'cooldown', 'rest'],
      description: 'Simple step type.',
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 20,
      description: 'Short label shown on the watch (≤20 chars)',
    },
    endCondition: {
      type: 'string',
      enum: ['distance', 'time', 'lapButton'],
      description: 'How this step ends',
    },
    endValue: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1_000_000,
      description: 'Meters for distance, seconds for time. Omit for lapButton.',
    },
    target: {
      type: 'string',
      enum: ['open', 'pace', 'heartRate'],
      description: 'Target type (default: open)',
    },
    paceFrom: {
      type: 'string',
      pattern: '^\\d+:[0-5]\\d$',
      description: 'Faster pace "mm:ss" per km, e.g. "5:00". Required when target=pace.',
    },
    paceTo: {
      type: 'string',
      pattern: '^\\d+:[0-5]\\d$',
      description: 'Slower pace "mm:ss" per km, e.g. "5:15". Required when target=pace.',
    },
    hrFrom: {
      type: 'integer',
      minimum: 30,
      maximum: 250,
      description: 'Lower HR bound in bpm. Required when target=heartRate.',
    },
    hrTo: {
      type: 'integer',
      minimum: 30,
      maximum: 250,
      description: 'Upper HR bound in bpm. Required when target=heartRate.',
    },
  },
}

const repeatWorkoutStepParameters = {
  type: 'object',
  required: ['type', 'iterations', 'steps'],
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: ['repeat'],
      description: 'Repeat a group of simple steps.',
    },
    iterations: {
      type: 'integer',
      minimum: 1,
      maximum: 99,
      description: 'Number of repetitions.',
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description: 'Simple sub-steps to repeat; nested repeat groups are not allowed.',
      items: simpleWorkoutStepParameters,
    },
  },
}

const workoutStepParameters = {
  oneOf: [simpleWorkoutStepParameters, repeatWorkoutStepParameters],
}

/**
 * Permissive output schema + renderer: Garmin formatters return either a
 * single object, an array of objects, or an `{ error, message }` object, so
 * the schema accepts both shapes and the renderer pretty-prints JSON.
 */
const flexibleOutput = {
  schema: {
    oneOf: [
      { type: 'null' },
      {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
        },
      },
      {
        type: 'object',
        additionalProperties: true,
      },
    ],
  },
  render: (_args: unknown, value: unknown) => [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ],
}

function toolError(error: unknown, fallback: string): { error: true; message: string } {
  return {
    error: true,
    message: publicErrorMessage(error, fallback),
  }
}
