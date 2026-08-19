import { Context } from '@deepseek-ai/cordis'
import type { GarminClient } from '../client'
import type { Config } from '../config'
import {
  formatActivity,
  formatSleep,
  formatSteps,
  formatHeartRate,
  formatWeight,
  formatWorkout,
} from '../utils/format'
import type { ActivityDetail } from '../utils/format'
import { findSkills, formatSkillCard } from '../knowledge/running-skills'
import { buildGarminWorkout, validateWorkoutDef } from '../knowledge/workout-schema'
import type { WorkoutDef } from '../knowledge/workout-schema'

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

  // ------------------------------------------------------------------
  // 1. get_garmin_activities
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_activities',
    description:
      'Retrieve the user\'s recent Garmin fitness activities (runs, rides, swims, hikes, etc.). ' +
      'Returns activities with distance, duration, pace, heart rate, and calories by default. ' +
      'Pass detail="full" when the user asks for complete data (all raw Garmin fields). ' +
      'Example user query: "Show me my last 5 runs"',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of activities to return (1–100).',
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset. 0 = most recent.',
        },
        detail: {
          type: 'string',
          enum: ['compact', 'full'],
          description: 'compact (default) returns curated fields to save context; full returns every raw Garmin field.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: { limit?: number; offset?: number; detail?: string }) => {
      try {
        const limit = Math.min(Math.max(args.limit ?? 5, 1), 100)
        const offset = Math.max(args.offset ?? 0, 0)
        const detail: ActivityDetail = (args.detail ?? config.activityDetail) === 'full' ? 'full' : 'compact'
        const raw = await client.getActivities(offset, limit)
        return (raw as Record<string, unknown>[]).map(a => formatActivity(a, detail))
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to fetch activities' }
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
    execute: async (args: { startDate?: string; endDate?: string }) => {
      try {
        const start = isValidDate(args.startDate) ? args.startDate! : todayLocal()
        const end = isValidDate(args.endDate) ? args.endDate! : start

        const dates = getDatesInRange(start, end)
        const results = await Promise.all(
          dates.map(async d => {
            const raw = await client.getSleep(d)
            return formatSleep(raw as Record<string, unknown>)
          })
        )
        return results.length === 1 ? results[0] : results
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to fetch sleep data' }
      }
    },
  })

  // ------------------------------------------------------------------
  // 3. get_garmin_steps
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_steps',
    description:
      'Get the user\'s step count, step goal, and walking distance for a specific date or range. ' +
      'Example user query: "How many steps did I take today?"',
    parameters: dateRangeParameters,
    output: flexibleOutput,
    execute: async (args: { startDate?: string; endDate?: string }) => {
      try {
        const start = isValidDate(args.startDate) ? args.startDate! : todayLocal()
        const end = isValidDate(args.endDate) ? args.endDate! : start

        const dates = getDatesInRange(start, end)
        const results = await Promise.all(
          dates.map(async d => {
            const raw = await client.getSteps(d)
            return formatSteps(raw as Record<string, unknown>)
          })
        )
        return results.length === 1 ? results[0] : results
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to fetch steps' }
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
    execute: async (args: { startDate?: string; endDate?: string }) => {
      try {
        const start = isValidDate(args.startDate) ? args.startDate! : todayLocal()
        const end = isValidDate(args.endDate) ? args.endDate! : start

        const dates = getDatesInRange(start, end)
        const results = await Promise.all(
          dates.map(async d => {
            const raw = await client.getHeartRate(d)
            return formatHeartRate(raw as Record<string, unknown>)
          })
        )
        return results.length === 1 ? results[0] : results
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to fetch heart rate' }
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
    execute: async (args: { startDate?: string; endDate?: string }) => {
      try {
        const start = isValidDate(args.startDate) ? args.startDate! : todayLocal()
        const end = isValidDate(args.endDate) ? args.endDate! : start

        const dates = getDatesInRange(start, end)
        const results = await Promise.all(
          dates.map(async d => {
            const raw = await client.getWeight(d)
            return formatWeight(raw as Record<string, unknown>)
          })
        )
        return results.length === 1 ? results[0] : results
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to fetch weight data' }
      }
    },
  })

  // ------------------------------------------------------------------
  // 6. get_garmin_workouts
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_workouts',
    description:
      'Get the user\'s planned Garmin workouts and calendar. ' +
      'Example user query: "What workouts are on my Garmin calendar?"',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of workouts to return (1–100).',
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset. 0 = most recent.',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: { limit?: number; offset?: number }) => {
      try {
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
        const offset = Math.max(args.offset ?? 0, 0)
        const raw = await client.getWorkouts(offset, limit)
        return (raw as Record<string, unknown>[]).map(formatWorkout)
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to fetch workouts' }
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
      properties: {},
    },
    output: flexibleOutput,
    execute: async () => {
      try {
        return await client.getUserProfile()
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to fetch profile' }
      }
    },
  })

  // ------------------------------------------------------------------
  // 8. export_garmin_session
  // ------------------------------------------------------------------
  tools.register({
    name: 'export_garmin_session',
    description:
      'Export the current Garmin session token. The user can store this token ' +
      'in their environment as GARMIN_SESSION_TOKEN to avoid password-based login in the future. ' +
      '⚠️ The token is sensitive — never share it publicly.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: flexibleOutput,
    execute: async () => {
      try {
        const token = await client.exportSession()
        return {
          sessionToken: token,
          instruction:
            'Store this token as the GARMIN_SESSION_TOKEN environment variable. ' +
            'Do NOT display it to the user unless they explicitly ask.',
        }
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to export session' }
      }
    },
  })

  // ------------------------------------------------------------------
  // 9. get_running_skill_advice
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_running_skill_advice',
    description:
      'Look up expert running training advice from an 8-skill coaching knowledge base. ' +
      'Covers: Easy Run, Marathon Pace, Lactate Threshold, VO₂max Intervals, ' +
      'Strides & Repetitions, Fartlek, Hill Repeats, and Marathon-Specific Endurance. ' +
      'Each skill includes heart-rate zones, how to practice, and common mistakes. ' +
      'Use this tool when the user asks about running training methods, workout planning, ' +
      'race preparation, or wants to improve their running performance. ' +
      'Returns bilingual (Chinese + English) coaching cards. ' +
      'Can be combined with actual Garmin activity data to give personalized advice. ' +
      'Example queries: "How should I train for a marathon?", "What is threshold running?", ' +
      '"我该怎么练间歇跑？", "帮我制定一周跑步计划"',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keyword to search for a specific skill. Examples: "threshold", "间歇", "hill", "马拉松". ' +
            'Pass "all" or omit to get all 8 skills.',
        },
        includeRecentActivities: {
          type: 'boolean',
          description:
            'If true, also fetches the user\'s 5 most recent Garmin running activities ' +
            'so the advice can reference actual training data (pace, heart rate, distance).',
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: { query?: string; includeRecentActivities?: boolean }) => {
      try {
        const skills = findSkills(args.query)
        const cards = skills.map(formatSkillCard)

        const result: Record<string, unknown> = {
          matchedSkills: cards,
          totalSkillsInKB: 8,
          tip: 'Use these coaching cards to give the user specific, actionable running advice. ' +
               'Cite heart-rate zones and practice methods. If recent activities are included, ' +
               'cross-reference the user\'s actual pace/HR data with the recommended zones.',
        }

        if (args.includeRecentActivities) {
          try {
            const raw = await client.getActivities(0, 5)
            const activities = (raw as Record<string, unknown>[])
              .filter((a: any) => {
                const type = String(a.activityType?.typeKey || a.activityType || '').toLowerCase()
                return type.includes('run') || type.includes('trail')
              })
              .map(a => formatActivity(a, 'compact'))
            result.recentRunningActivities = activities.length > 0 ? activities : 'No recent running activities found.'
          } catch {
            result.recentRunningActivities = 'Could not fetch activities (login may be required).'
          }
        }

        return result
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to look up running skills' }
      }
    },
  })

  // ------------------------------------------------------------------
  // 10. create_garmin_workout
  // ------------------------------------------------------------------
  tools.register({
    name: 'create_garmin_workout',
    description:
      'Create a structured workout in Garmin Connect that automatically syncs to the user\'s watch. ' +
      'Supports warmup, interval, recovery, cooldown, rest steps with pace/HR targets, and repeat groups. ' +
      'After creation, the workout appears in the user\'s Garmin Connect workout library and syncs ' +
      'to the watch via Bluetooth/Wi-Fi. ' +
      'IMPORTANT: Use this tool AFTER consulting get_running_skill_advice and/or recent activities ' +
      'to create a personalized, science-based training plan. ' +
      'Example: user says "帮我创建一个门槛跑训练" or "Create a 10K race-pace workout". ' +
      'Step format guide: ' +
      'type: warmup|interval|recovery|cooldown|rest|repeat. ' +
      'endCondition: distance (endValue in meters), time (endValue in seconds), or lapButton. ' +
      'target: open (free run), pace (set paceFrom/paceTo as "mm:ss" per km), heartRate (set hrFrom/hrTo in bpm). ' +
      'For repeat groups: set iterations and nest sub-steps in steps array.',
    parameters: {
      type: 'object',
      required: ['name', 'steps'],
      properties: {
        name: {
          type: 'string',
          description: 'Workout name shown on the watch, e.g. "周二·轻松跑6km"',
        },
        description: {
          type: 'string',
          description: 'Coaching notes (shown in Garmin Connect app)',
        },
        sport: {
          type: 'string',
          enum: ['running', 'cycling', 'swimming', 'strength', 'other'],
          description: 'Sport type (default: running)',
        },
        steps: {
          type: 'array',
          description: 'Ordered workout steps',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['warmup', 'interval', 'recovery', 'cooldown', 'rest', 'repeat'],
                description: 'Step type. Use "repeat" for interval groups.',
              },
              description: {
                type: 'string',
                description: 'Short label shown on the watch (≤20 chars)',
              },
              endCondition: {
                type: 'string',
                enum: ['distance', 'time', 'lapButton'],
                description: 'How this step ends',
              },
              endValue: {
                type: 'number',
                description: 'Meters for distance, seconds for time. Not needed for lapButton.',
              },
              target: {
                type: 'string',
                enum: ['open', 'pace', 'heartRate'],
                description: 'Target type (default: open)',
              },
              paceFrom: {
                type: 'string',
                description: 'Faster pace "mm:ss" per km, e.g. "5:00". Required when target=pace.',
              },
              paceTo: {
                type: 'string',
                description: 'Slower pace "mm:ss" per km, e.g. "5:15". Required when target=pace.',
              },
              hrFrom: {
                type: 'integer',
                description: 'Lower HR bound in bpm. Required when target=heartRate.',
              },
              hrTo: {
                type: 'integer',
                description: 'Upper HR bound in bpm. Required when target=heartRate.',
              },
              iterations: {
                type: 'integer',
                description: 'Number of repetitions (only for type=repeat)',
              },
              steps: {
                type: 'array',
                description: 'Sub-steps to repeat (only for type=repeat)',
                items: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    },
    output: flexibleOutput,
    execute: async (args: WorkoutDef) => {
      try {
        // Validate the workout definition
        const error = validateWorkoutDef(args)
        if (error) {
          return { error: true, message: `Invalid workout definition: ${error}` }
        }

        // Convert to Garmin format
        const garminWorkout = buildGarminWorkout(args)

        // Create via API
        const result = await client.addWorkout(garminWorkout)

        return {
          success: true,
          workoutId: (result as any)?.workoutId ?? null,
          workoutName: args.name,
          message:
            `Workout "${args.name}" created successfully in Garmin Connect. ` +
            'It will sync to the watch automatically via the Garmin Connect app (Bluetooth/Wi-Fi). ' +
            'The user can also find it in Garmin Connect → Training → Workouts.',
        }
      } catch (err: any) {
        return { error: true, message: err.message || 'Failed to create workout' }
      }
    },
  })

  ctx.logger.info(`[garmin] Registered ${10} tools.`)
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

/** Date range parameters shared by sleep / steps / heart rate / weight tools. */
const dateRangeParameters = {
  type: 'object',
  properties: {
    startDate: {
      type: 'string',
      description: 'Start date in YYYY-MM-DD format. Defaults to today.',
    },
    endDate: {
      type: 'string',
      description: 'End date in YYYY-MM-DD format. If omitted, queries only the startDate.',
    },
  },
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidDate(d?: string): boolean {
  if (!d) return false
  return !isNaN(new Date(d).getTime())
}

function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayLocal(): string {
  return localDateString(new Date())
}

/** Get up to 30 days of dates between start and end. */
export function getDatesInRange(startStr: string, endStr: string): string[] {
  const dates: string[] = []
  // Parse as local time to avoid UTC shift
  const curr = new Date(startStr + 'T00:00:00')
  const endDate = new Date(endStr + 'T00:00:00')

  if (isNaN(curr.getTime()) || isNaN(endDate.getTime()) || curr > endDate) {
    return [startStr] // fallback to startStr if invalid range
  }

  let count = 0
  while (curr <= endDate && count < 30) {
    dates.push(localDateString(curr))
    curr.setDate(curr.getDate() + 1)
    count++
  }
  return dates
}
