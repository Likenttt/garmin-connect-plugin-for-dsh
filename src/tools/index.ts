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

  ctx.logger.info(`[garmin] Registered ${8} tools.`)
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
