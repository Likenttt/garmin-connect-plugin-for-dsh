#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { config as loadEnv } from 'dotenv'
import { z } from 'zod'
import { GarminClient } from './client'
import type { Config } from './config'
import { GarminToolService } from './tool-service'
import type {
  ActivityArgs,
  CreateWorkoutArgs,
  DateRangeArgs,
  DownloadActivityFitArgs,
  PaginationArgs,
  RunningAdviceArgs,
} from './tool-service'
import {
  PublicToolError,
  publicErrorMessage,
  safeUpstreamLogLine,
} from './utils/errors'
import { resolveFitDownloadDir } from './utils/path'

type ToolService = Pick<
  GarminToolService,
  | 'getActivities'
  | 'getSleep'
  | 'getSteps'
  | 'getHeartRate'
  | 'getWeight'
  | 'getWorkouts'
  | 'getProfile'
  | 'getRunningAdvice'
  | 'createWorkout'
  | 'downloadActivityFit'
>

const dateRangeSchema = {
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Start date in YYYY-MM-DD format (default: today)'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Inclusive end date in YYYY-MM-DD format (maximum 30 days)'),
}

const simpleWorkoutStepSchema = z.object({
  type: z.enum(['warmup', 'interval', 'recovery', 'cooldown', 'rest']),
  description: z.string().min(1).max(20).optional(),
  endCondition: z.enum(['distance', 'time', 'lapButton']),
  endValue: z.number().finite().positive().max(1_000_000).optional(),
  target: z.enum(['open', 'pace', 'heartRate']).optional(),
  paceFrom: z.string().regex(/^\d+:[0-5]\d$/).optional(),
  paceTo: z.string().regex(/^\d+:[0-5]\d$/).optional(),
  hrFrom: z.number().int().min(30).max(250).optional(),
  hrTo: z.number().int().min(30).max(250).optional(),
}).strict()

const repeatWorkoutStepSchema = z.object({
  type: z.literal('repeat'),
  iterations: z.number().int().min(1).max(99),
  steps: z.array(simpleWorkoutStepSchema).min(1).max(100),
}).strict()

const workoutStepSchema: z.ZodTypeAny = z.union([
  simpleWorkoutStepSchema,
  repeatWorkoutStepSchema,
])

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}

/** Build an MCP adapter around the same service used by the DSH plugin. */
export function createMcpServer(service: ToolService): McpServer {
  const server = new McpServer({
    name: 'garmin-connect',
    version: '0.1.4',
  })

  // Casting at this boundary keeps the SDK's recursive Zod overloads from
  // dominating TypeScript build time; every handler remains explicitly typed.
  const register = (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny> | undefined,
    handler: (args: any) => Promise<ReturnType<typeof successResult>>,
    annotations: Record<string, boolean> = READ_ONLY_ANNOTATIONS,
    acceptOmittedArguments = true,
  ): void => {
    const inputSchema = schema === undefined
      ? undefined
      : acceptOmittedArguments
        ? objectSchemaAcceptingOmittedArguments(schema)
        : z.object(schema).strict()
    ;(server as any).registerTool(name, {
      description,
      inputSchema,
      annotations,
    }, handler)
  }

  register(
    'get_garmin_activities',
    'Fetch recent Garmin activities with compact or full detail.',
    {
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      detail: z.enum(['compact', 'full']).optional(),
    },
    (args: ActivityArgs) => invoke(() => service.getActivities(args)),
  )

  register(
    'get_garmin_sleep',
    'Get sleep data for one date or an inclusive date range.',
    dateRangeSchema,
    (args: DateRangeArgs) => invoke(() => service.getSleep(args)),
  )

  register(
    'get_garmin_steps',
    'Get step totals for one date or an inclusive date range; goal and distance may be unavailable.',
    dateRangeSchema,
    (args: DateRangeArgs) => invoke(() => service.getSteps(args)),
  )

  register(
    'get_garmin_heart_rate',
    'Get heart-rate data for one date or an inclusive date range.',
    dateRangeSchema,
    (args: DateRangeArgs) => invoke(() => service.getHeartRate(args)),
  )

  register(
    'get_garmin_weight',
    'Get body-composition data for one date or an inclusive date range.',
    dateRangeSchema,
    (args: DateRangeArgs) => invoke(() => service.getWeight(args)),
  )

  register(
    'get_garmin_workouts',
    'Get workouts from the Garmin workout library.',
    {
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    (args: PaginationArgs) => invoke(() => service.getWorkouts(args)),
  )

  register(
    'get_garmin_profile',
    'Get an allow-listed Garmin profile summary.',
    {},
    () => invoke(() => service.getProfile()),
  )

  register(
    'get_running_skill_advice',
    'Look up running advice and optionally include recent running activities.',
    {
      query: z.string().max(100).optional(),
      includeRecentActivities: z.boolean().optional(),
    },
    (args: RunningAdviceArgs) => invoke(() => service.getRunningAdvice(args)),
  )

  register(
    'create_garmin_workout',
    'Preview a workout first; create it only after explicit user confirmation.',
    {
      name: z.string().min(1).max(80),
      description: z.string().max(1024).optional(),
      sport: z.enum(['running', 'cycling', 'swimming', 'strength']).optional(),
      steps: z.array(workoutStepSchema).min(1).max(100),
      confirmed: z.boolean().optional().describe(
        'Set true only after the user explicitly approves the preview.',
      ),
      confirmationId: z.string().uuid().optional().describe(
        'One-time ID returned by the matching preview call.',
      ),
    },
    (args: CreateWorkoutArgs) => invoke(() => service.createWorkout(args)),
    WRITE_ANNOTATIONS,
    false,
  )

  register(
    'download_garmin_activity_fit',
    'Download one Garmin activity as a FIT file. GARMIN_FIT_DOWNLOAD_DIR must explicitly select a trusted local parent directory; files are isolated under GARMIN_FIT_<account-email>. Returns non-sensitive metadata without the local path or binary content.',
    {
      activityId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe(
        'Positive Garmin activity ID returned by get_garmin_activities.',
      ),
    },
    (args: DownloadActivityFitArgs) => invoke(() => service.downloadActivityFit(args)),
    // Existing FIT files are never overwritten. A repeated call returns
    // OUTPUT_EXISTS, so this intentionally shares the non-idempotent hint.
    WRITE_ANNOTATIONS,
    false,
  )

  return server
}

/**
 * MCP permits `arguments` to be omitted. Zod object schemas reject `undefined`,
 * while wrapping one in `default({})` makes SDK 1.30 advertise an empty schema.
 * Keep the object itself (and therefore its discoverable JSON Schema) intact,
 * and normalize only the validation entry point used by the SDK.
 */
function objectSchemaAcceptingOmittedArguments(
  shape: Record<string, z.ZodTypeAny>,
): z.ZodObject<any> {
  const schema = z.object(shape).strict()
  const safeParseAsync = schema.safeParseAsync.bind(schema)
  schema.safeParseAsync = ((value: unknown, params?: unknown) => (
    safeParseAsync(value === undefined ? {} : value, params as any)
  )) as typeof schema.safeParseAsync
  return schema
}

function successResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
}

async function invoke(action: () => Promise<unknown>): Promise<ReturnType<typeof successResult>> {
  try {
    return successResult(await action())
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: publicErrorMessage(error, 'Garmin request failed'),
        }),
      }],
    } as ReturnType<typeof successResult>
  }
}

export function standaloneConfig(): Config {
  const username = process.env.GARMIN_USERNAME?.trim() ?? ''
  const password = process.env.GARMIN_PASSWORD
  const sessionToken = process.env.GARMIN_SESSION_TOKEN
  const sessionTokenFile = process.env.GARMIN_SESSION_TOKEN_FILE
  if (!username) throw new PublicToolError('GARMIN_USERNAME is required')
  if (!password?.trim() && !sessionToken?.trim() && !sessionTokenFile?.trim()) {
    throw new PublicToolError(
      'GARMIN_PASSWORD, GARMIN_SESSION_TOKEN, or GARMIN_SESSION_TOKEN_FILE is required',
    )
  }

  const region = process.env.GARMIN_REGION === 'cn' ? 'cn' : 'global'
  const activityDetail = process.env.GARMIN_ACTIVITY_DETAIL === 'full' ? 'full' : 'compact'
  return {
    username,
    password,
    sessionToken,
    sessionTokenFile,
    region,
    activityDetail,
    fitDownloadDir: resolveFitDownloadDir(process.env.GARMIN_FIT_DOWNLOAD_DIR),
    cacheTtl: envNumber('GARMIN_CACHE_TTL', 300, true),
    requestTimeoutMs: envNumber('GARMIN_REQUEST_TIMEOUT_MS', 15_000, false),
    logLevel: envChoice(
      process.env.GARMIN_LOG_LEVEL,
      ['debug', 'info', 'warn', 'error'] as const,
      'info',
    ),
  }
}

function envNumber(name: string, fallback: number, allowZero: boolean): number {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) return fallback
  return parsed
}

function envChoice<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  return value !== undefined && allowed.includes(value)
    ? value as T[number]
    : fallback
}

function stderrContext(): any {
  const write = (level: string) => (message: unknown) => {
    console.error(`[${level}] ${String(message)}`)
  }
  return {
    logger: {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
    },
  }
}

async function main(): Promise<void> {
  // Install the stdio guard before dotenv or any other third-party startup
  // work; stdout is reserved exclusively for JSON-RPC from the first byte.
  const writeStderr = console.error.bind(console)
  let logSecrets: ReadonlyArray<string | undefined> = [
    process.env.GARMIN_SESSION_TOKEN_FILE,
    process.env.DOTENV_KEY,
  ]
  console.log = (...args: unknown[]) => {
    writeStderr('[garmin-connect upstream]', safeUpstreamLogLine(args, logSecrets))
  }
  console.error = (...args: unknown[]) => {
    writeStderr('[garmin-connect stderr]', safeUpstreamLogLine(args, logSecrets))
  }

  loadEnv()

  const config = standaloneConfig()
  // MCP stdio reserves stdout for JSON-RPC. The upstream Garmin library uses
  // console.log in a few auth paths and may pass AxiosError objects containing
  // request headers, so retain only redacted scalar text on stderr.
  logSecrets = [
    config.username,
    config.password,
    config.sessionToken,
    config.sessionTokenFile,
    process.env.DOTENV_KEY,
  ]
  const client = new GarminClient(stderrContext(), config)
  const service = new GarminToolService(client, {
    activityDetail: config.activityDetail,
    fitDownloadDir: config.fitDownloadDir,
    accountUsername: config.username,
  })
  const server = createMcpServer(service)
  await server.connect(new StdioServerTransport())
  console.error('[garmin-connect-mcp] Server started (stdio transport)')
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      '[garmin-connect-mcp] Fatal error:',
      publicErrorMessage(error, 'MCP server failed to start'),
    )
    process.exitCode = 1
  })
}
