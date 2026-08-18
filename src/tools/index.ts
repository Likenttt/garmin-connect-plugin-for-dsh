import { Context, Schema } from 'cordis'
import type { GarminClient } from '../client'
import {
  formatActivity,
  formatSleep,
  formatSteps,
  formatHeartRate,
} from '../utils/format'

/**
 * Register all Garmin-related tools with the DeepSeek Harness tool registry.
 *
 * Each tool is described with a natural-language `description` so the LLM
 * can decide when to invoke it based on the user's conversational intent.
 */
export function registerTools(ctx: Context, client: GarminClient): void {
  const tools = (ctx as any).dshTools

  // ------------------------------------------------------------------
  // 1. get_garmin_activities
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_activities',
    description:
      'Retrieve the user\'s recent Garmin fitness activities (runs, rides, swims, hikes, etc.). ' +
      'Returns a list of activities with distance, duration, pace, heart rate, and calories.',
    parameters: Schema.object({
      limit: Schema.number()
        .default(5)
        .description('Maximum number of activities to return (1–100).'),
      offset: Schema.number()
        .default(0)
        .description('Pagination offset. 0 = most recent.'),
    }),
    execute: async (args: { limit?: number; offset?: number }) => {
      const raw = await client.getActivities(args.offset ?? 0, args.limit ?? 5)
      return (raw as Record<string, unknown>[]).map(formatActivity)
    },
  })

  // ------------------------------------------------------------------
  // 2. get_garmin_sleep
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_sleep',
    description:
      'Get the user\'s sleep data for a specific date, including sleep score, ' +
      'total duration, and breakdowns (deep, light, REM, awake).',
    parameters: Schema.object({
      date: Schema.string()
        .description('Date in YYYY-MM-DD format. Defaults to today.'),
    }),
    execute: async (args: { date?: string }) => {
      const date = args.date ?? todayISO()
      const raw = await client.getSleep(date)
      return formatSleep(raw as Record<string, unknown>)
    },
  })

  // ------------------------------------------------------------------
  // 3. get_garmin_steps
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_steps',
    description:
      'Get the user\'s step count, step goal, and walking distance for a specific date.',
    parameters: Schema.object({
      date: Schema.string()
        .description('Date in YYYY-MM-DD format. Defaults to today.'),
    }),
    execute: async (args: { date?: string }) => {
      const date = args.date ?? todayISO()
      const raw = await client.getSteps(date)
      return formatSteps(raw as Record<string, unknown>)
    },
  })

  // ------------------------------------------------------------------
  // 4. get_garmin_heart_rate
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_heart_rate',
    description:
      'Get the user\'s heart rate summary for a specific date, including ' +
      'resting, max, and min heart rate.',
    parameters: Schema.object({
      date: Schema.string()
        .description('Date in YYYY-MM-DD format. Defaults to today.'),
    }),
    execute: async (args: { date?: string }) => {
      const date = args.date ?? todayISO()
      const raw = await client.getHeartRate(date)
      return formatHeartRate(raw as Record<string, unknown>)
    },
  })

  // ------------------------------------------------------------------
  // 5. get_garmin_profile
  // ------------------------------------------------------------------
  tools.register({
    name: 'get_garmin_profile',
    description:
      'Get the user\'s Garmin profile summary (display name, profile image URL, etc.).',
    parameters: Schema.object({}),
    execute: async () => {
      return client.getUserProfile()
    },
  })

  // ------------------------------------------------------------------
  // 6. export_garmin_session
  // ------------------------------------------------------------------
  tools.register({
    name: 'export_garmin_session',
    description:
      'Export the current Garmin session token. The user can store this token ' +
      'in their environment as GARMIN_SESSION_TOKEN to avoid password-based login in the future. ' +
      '⚠️ The token is sensitive — never share it publicly.',
    parameters: Schema.object({}),
    execute: async () => {
      const token = await client.exportSession()
      return {
        sessionToken: token,
        instruction:
          'Store this token as the GARMIN_SESSION_TOKEN environment variable. ' +
          'Do NOT display it to the user unless they explicitly ask.',
      }
    },
  })

  ctx.logger.info(`[garmin] Registered ${6} tools.`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayISO(): string {
  return new Date().toISOString().split('T')[0]
}
