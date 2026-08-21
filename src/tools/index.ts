import { Context } from '@deepseek-ai/cordis'
import type { GarminClient } from '../client'
import type { Config } from '../config'
import { publicErrorMessage } from '../utils/errors'
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

export { getDatesInRange, todayLocal } from '../tool-service'

/**
 * Register all Garmin-related tools with the DeepSeek Harness tool registry.
 *
 * Definitions follow the dsh tool registry contract:
 *   - `parameters` is a JSON Schema object (compiled form),
 *   - `output` declares a JSON Schema plus a `render` callback that turns the
 *     execution result into text content blocks for the UI / trajectory.
 */
export function registerTools(ctx: Context, client: GarminClient, config: Config): void {
  const tools = (ctx as any).tools
  const service = new GarminToolService(client, {
    activityDetail: config.activityDetail,
    fitDownloadDir: config.fitDownloadDir,
    accountUsername: config.username,
    accountRegion: config.region,
  })

  // ------------------------------------------------------------------
  // 1. get_garmin_activities
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_activities',
    description:
      'Retrieve the user\'s recent Garmin fitness activities (runs, rides, swims, hikes, etc.). ' +
      'Returns activities with distance, duration, pace, heart rate, and calories by default. ' +
      'Pass detail="full" only when the user asks for expanded data; it can include ' +
      'precise route/location fields but filters credentials and account/social identifiers. ' +
      'Example user query: "Show me my last 5 runs"',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
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
          description: 'compact (default) returns curated fields; full adds expanded fitness and precise location/route fields while filtering credentials and account/social identifiers.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: ActivityArgs) => {
      try {
        return await service.getActivities(args)
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
    execute: async (args: DateRangeArgs) => {
      try {
        return await service.getSleep(args)
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
    execute: async (args: DateRangeArgs) => {
      try {
        return await service.getSteps(args)
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
    execute: async (args: DateRangeArgs) => {
      try {
        return await service.getHeartRate(args)
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
    execute: async (args: DateRangeArgs) => {
      try {
        return await service.getWeight(args)
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
    execute: async (args: PaginationArgs) => {
      try {
        return await service.getWorkouts(args)
      } catch (error) {
        return toolError(error, 'Failed to fetch workouts')
      }
    },
  })

  // ------------------------------------------------------------------
  // 7. get_garmin_profile
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_profile',
    description:
      'Get the user\'s Garmin profile summary (display name, profile image URL, etc.).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: flexibleOutput,
    execute: async () => {
      try {
        return await service.getProfile()
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
      'Recent Garmin running activities can supplement but never replace the intake.',
    parameters: {
      type: 'object',
      required: ['mode'],
      additionalProperties: false,
      properties: {
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
    execute: async (args: RunningAdviceArgs) => {
      try {
        return await service.getRunningAdvice(args)
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
    execute: async (args: CreateWorkoutArgs) => {
      try {
        return await service.createWorkout(args)
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
        activityId: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'Positive Garmin activity ID returned by get_garmin_activities.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: DownloadActivityFitArgs) => {
      try {
        return await service.downloadActivityFit(args)
      } catch (error) {
        return toolError(error, 'Failed to download FIT activity file')
      }
    },
  })

  ctx.logger.info('[garmin] Registered 10 tools.')
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

/** Date range parameters shared by sleep / steps / heart rate / weight tools. */
const dateRangeParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
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
