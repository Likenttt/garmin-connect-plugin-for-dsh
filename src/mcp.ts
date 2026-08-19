#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) server for Garmin Connect.
 *
 * This standalone server exposes the same Garmin tools as the dsh plugin,
 * but via the MCP protocol so that Claude Desktop, Codex CLI, Cursor,
 * Windsurf, and any other MCP-compatible client can use them.
 *
 * Usage:
 *   GARMIN_USERNAME=xxx GARMIN_PASSWORD=xxx node lib/mcp.js
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "garmin-connect": {
 *         "command": "npx",
 *         "args": ["-y", "dsh-plugin-garmin-connect-mcp"],
 *         "env": {
 *           "GARMIN_USERNAME": "your@email.com",
 *           "GARMIN_PASSWORD": "yourpassword",
 *           "GARMIN_REGION": "global"
 *         }
 *       }
 *     }
 *   }
 */

// @ts-ignore
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
// @ts-ignore
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { GarminConnect } from 'garmin-connect'
import { config as loadEnv } from 'dotenv'
import { findSkills, formatSkillCard } from './knowledge/running-skills.js'
import {
  buildGarminWorkout,
  validateWorkoutDef,
} from './knowledge/workout-schema.js'
import type { WorkoutDef } from './knowledge/workout-schema.js'
import {
  formatActivity,
  formatSleep,
  formatSteps,
  formatHeartRate,
  formatWeight,
  formatWorkout,
} from './utils/format.js'

// Load .env
loadEnv()

// ---------------------------------------------------------------------------
// Garmin client (standalone, no Cordis)
// ---------------------------------------------------------------------------

let gc: GarminConnect
let connected = false

async function ensureConnected(): Promise<void> {
  if (connected) return
  const username = process.env.GARMIN_USERNAME
  const password = process.env.GARMIN_PASSWORD
  const sessionToken = process.env.GARMIN_SESSION_TOKEN
  if (!username) throw new Error('GARMIN_USERNAME is required')

  gc = new GarminConnect({ username, password: password || '' })

  if (sessionToken) {
    const tokens = JSON.parse(sessionToken)
    gc.loadToken(tokens.oauth1, tokens.oauth2)
  } else {
    await gc.login()
  }
  connected = true
}

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'garmin-connect',
  version: '0.1.0',
})

// 1. get_garmin_activities
// @ts-ignore
server.tool(
  'get_garmin_activities',
  'Fetch recent Garmin activities (runs, rides, swims…) with pace, HR, calories',
  {
    limit: z.number().optional().describe('Max activities to return (1-100, default 5)'),
    offset: z.number().optional().describe('Pagination offset (default 0)'),
  },
  async ({ limit, offset }) => {
    await ensureConnected()
    const l = Math.min(Math.max(limit ?? 5, 1), 100)
    const o = Math.max(offset ?? 0, 0)
    const raw = await gc.getActivities(o, l)
    const data = (raw as any[]).map(a => formatActivity(a, 'compact'))
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 2. get_garmin_sleep
// @ts-ignore
server.tool(
  'get_garmin_sleep',
  'Get sleep data (score, duration, stage breakdown) for a date',
  {
    date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
  },
  async ({ date }) => {
    await ensureConnected()
    const d = date || todayLocal()
    const raw = await gc.getSleepData(new Date(d))
    const data = formatSleep(raw as any)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 3. get_garmin_steps
// @ts-ignore
server.tool(
  'get_garmin_steps',
  'Get step count, goal, and walking distance for a date',
  {
    date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
  },
  async ({ date }) => {
    await ensureConnected()
    const d = date || todayLocal()
    const raw = await gc.getSteps(new Date(d))
    const data = formatSteps(raw as any)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 4. get_garmin_heart_rate
// @ts-ignore
server.tool(
  'get_garmin_heart_rate',
  'Get heart rate summary (resting, max, min) for a date',
  {
    date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
  },
  async ({ date }) => {
    await ensureConnected()
    const d = date || todayLocal()
    const raw = await gc.getHeartRate(new Date(d))
    const data = formatHeartRate(raw as any)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 5. get_garmin_weight
// @ts-ignore
server.tool(
  'get_garmin_weight',
  'Get body composition (weight, BMI, body fat) for a date',
  {
    date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
  },
  async ({ date }) => {
    await ensureConnected()
    const d = date || todayLocal()
    const raw = await gc.getDailyWeightData(new Date(d))
    const data = formatWeight(raw as any)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 6. get_garmin_workouts
// @ts-ignore
server.tool(
  'get_garmin_workouts',
  'Get planned workouts from Garmin calendar',
  {
    limit: z.number().optional().describe('Max workouts to return (default 10)'),
  },
  async ({ limit }) => {
    await ensureConnected()
    const l = Math.min(Math.max(limit ?? 10, 1), 100)
    const raw = await gc.getWorkouts(0, l)
    const data = (raw as any[]).map(formatWorkout)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7. get_garmin_profile
// @ts-ignore
server.tool(
  'get_garmin_profile',
  'Get Garmin user profile summary',
  {},
  async () => {
    await ensureConnected()
    const data = await gc.getUserProfile()
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 8. get_running_skill_advice
// @ts-ignore
server.tool(
  'get_running_skill_advice',
  'Look up expert running training advice from an 8-skill coaching knowledge base',
  {
    query: z.string().optional().describe('Keyword to search, e.g. "threshold", "间歇", "hill". Omit for all 8 skills.'),
  },
  async ({ query }) => {
    const skills = findSkills(query)
    const cards = skills.map(formatSkillCard)
    return { content: [{ type: 'text', text: JSON.stringify(cards, null, 2) }] }
  }
)

// 9. create_garmin_workout
// @ts-ignore
server.tool(
  'create_garmin_workout',
  'Create a structured workout in Garmin Connect (syncs to watch). ' +
  'Steps: warmup|interval|recovery|cooldown|rest|repeat. ' +
  'endCondition: distance (meters), time (seconds), lapButton. ' +
  'target: open, pace (paceFrom/paceTo "mm:ss"/km), heartRate (hrFrom/hrTo bpm).',
  {
    name: z.string().describe('Workout name'),
    description: z.string().optional().describe('Coaching notes'),
    sport: z.enum(['running', 'cycling', 'swimming', 'strength', 'other']).optional(),
    steps: z.array(z.any()).describe('Workout steps array'),
  },
  async (args) => {
    await ensureConnected()
    const def = args as unknown as WorkoutDef
    const validationError = validateWorkoutDef(def)
    if (validationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: true, message: validationError }) }] }
    }

    const garminWorkout = buildGarminWorkout(def)
    const result = await (gc as any).addWorkout(garminWorkout)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          workoutId: result?.workoutId ?? null,
          workoutName: args.name,
          message: `Workout "${args.name}" created. It will sync to the watch via Garmin Connect app.`,
        }, null, 2),
      }],
    }
  }
)

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[garmin-connect-mcp] Server started (stdio transport)')
}

main().catch(err => {
  console.error('[garmin-connect-mcp] Fatal error:', err)
  process.exit(1)
})
