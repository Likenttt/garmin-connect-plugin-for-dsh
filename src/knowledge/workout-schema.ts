/**
 * Workout Schema Builder
 *
 * Converts a simplified, LLM-friendly workout definition into the exact
 * JSON structure that the Garmin Connect workout API expects
 * (ExecutableStepDTO / RepeatGroupDTO).
 *
 * The simplified format is designed for AI agents to generate easily,
 * while the output matches the schema observed in real Garmin Connect
 * workout libraries.
 */

// ---------------------------------------------------------------------------
// Public types — the AI-friendly workout definition
// ---------------------------------------------------------------------------

export interface WorkoutDef {
  /** Workout name, e.g. "周二·轻松跑6km" */
  name: string
  /** Coaching notes shown in Garmin Connect */
  description?: string
  /** Sport type (default: "running") */
  sport?: 'running' | 'cycling' | 'swimming' | 'strength'
  /** Ordered list of workout steps */
  steps: StepDef[]
}

export type StepDef = SimpleStepDef | RepeatStepDef

export interface SimpleStepDef {
  /** Step type */
  type: 'warmup' | 'interval' | 'recovery' | 'cooldown' | 'rest'
  /** Short description shown on the watch (keep ≤20 chars for best display) */
  description?: string
  /**
   * How the step ends:
   * - "distance": endValue is in meters
   * - "time": endValue is in seconds
   * - "lapButton": user presses lap to advance
   */
  endCondition: 'distance' | 'time' | 'lapButton'
  /** Meters (for distance) or seconds (for time). Ignored for lapButton. */
  endValue?: number
  /**
   * Target type:
   * - "open": no target, free run
   * - "pace": pace zone target (use paceFrom/paceTo)
   * - "heartRate": HR zone target (use hrFrom/hrTo)
   */
  target?: 'open' | 'pace' | 'heartRate'
  /** Faster pace limit in "mm:ss" per km, e.g. "5:00" */
  paceFrom?: string
  /** Slower pace limit in "mm:ss" per km, e.g. "5:15" */
  paceTo?: string
  /** Lower heart rate bound in bpm */
  hrFrom?: number
  /** Upper heart rate bound in bpm */
  hrTo?: number
}

export interface RepeatStepDef {
  type: 'repeat'
  /** Number of iterations */
  iterations: number
  /** Steps to repeat */
  steps: SimpleStepDef[]
}

// ---------------------------------------------------------------------------
// Garmin constants (from observed API payloads)
// ---------------------------------------------------------------------------

const SPORT_TYPES: Record<string, { sportTypeId: number; sportTypeKey: string }> = {
  running:  { sportTypeId: 1, sportTypeKey: 'running' },
  cycling:  { sportTypeId: 2, sportTypeKey: 'cycling' },
  swimming: { sportTypeId: 4, sportTypeKey: 'swimming' },
  strength: { sportTypeId: 5, sportTypeKey: 'strength_training' },
}

const STEP_TYPES: Record<string, { stepTypeId: number; stepTypeKey: string; displayOrder: number }> = {
  warmup:   { stepTypeId: 1, stepTypeKey: 'warmup',   displayOrder: 1 },
  cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown', displayOrder: 2 },
  interval: { stepTypeId: 3, stepTypeKey: 'interval', displayOrder: 3 },
  recovery: { stepTypeId: 4, stepTypeKey: 'recovery', displayOrder: 4 },
  rest:     { stepTypeId: 5, stepTypeKey: 'rest',     displayOrder: 5 },
  repeat:   { stepTypeId: 6, stepTypeKey: 'repeat',   displayOrder: 6 },
}

const END_CONDITIONS: Record<string, { conditionTypeId: number; conditionTypeKey: string }> = {
  lapButton: { conditionTypeId: 1, conditionTypeKey: 'lap.button' },
  time:      { conditionTypeId: 2, conditionTypeKey: 'time' },
  distance:  { conditionTypeId: 3, conditionTypeKey: 'distance' },
  iterations:{ conditionTypeId: 7, conditionTypeKey: 'iterations' },
}

const TARGET_TYPES = {
  open:      { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target',        displayOrder: 1 },
  heartRate: { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone',  displayOrder: 4 },
  pace:      { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone',        displayOrder: 6 },
}

const MAX_DISTANCE_METERS = 1_000_000
const MAX_DURATION_SECONDS = 86_400
const MAX_REPEAT_ITERATIONS = 99
const MAX_WORKOUT_STEPS = 100
const MAX_WORKOUT_NAME_LENGTH = 80
const MAX_WORKOUT_DESCRIPTION_LENGTH = 1024
const MAX_STEP_DESCRIPTION_LENGTH = 20

const WORKOUT_FIELDS = new Set(['name', 'description', 'sport', 'steps'])
const SIMPLE_STEP_FIELDS = new Set([
  'type',
  'description',
  'endCondition',
  'endValue',
  'target',
  'paceFrom',
  'paceTo',
  'hrFrom',
  'hrTo',
])
const REPEAT_STEP_FIELDS = new Set(['type', 'iterations', 'steps'])

// ---------------------------------------------------------------------------
// Conversion utilities
// ---------------------------------------------------------------------------

/**
 * Parse a pace string "mm:ss" to m/s.
 * e.g. "5:00" per km → 1000 / 300 = 3.3333 m/s
 */
export function paceToMps(pace: string): number {
  const match = /^(\d+):([0-5]\d)$/.exec(pace)
  if (!match) {
    throw new RangeError('Pace must use mm:ss format with seconds below 60')
  }

  const totalSeconds = Number(match[1]) * 60 + Number(match[2])
  if (!Number.isSafeInteger(totalSeconds) || totalSeconds <= 0) {
    throw new RangeError('Pace must use mm:ss format with a positive duration')
  }

  const metersPerSecond = Math.round((1000 / totalSeconds) * 10000) / 10000
  if (!Number.isFinite(metersPerSecond) || metersPerSecond <= 0) {
    throw new RangeError('Pace must produce a positive finite speed')
  }

  return metersPerSecond
}

/**
 * Build an ExecutableStepDTO from a simplified step definition.
 */
function buildExecutableStep(step: SimpleStepDef, order: number, childStepId: number | null = null): Record<string, unknown> {
  const stepType = STEP_TYPES[step.type] || STEP_TYPES.interval

  // End condition
  const endCond = step.endCondition === 'lapButton'
    ? END_CONDITIONS.lapButton
    : END_CONDITIONS[step.endCondition] || END_CONDITIONS.lapButton

  // Target
  const targetKey = step.target || 'open'
  const targetType = TARGET_TYPES[targetKey as keyof typeof TARGET_TYPES] || TARGET_TYPES.open
  let targetValueOne: number | null = null
  let targetValueTwo: number | null = null

  if (targetKey === 'pace' && step.paceFrom && step.paceTo) {
    // paceFrom = faster pace (lower mm:ss) → higher m/s → targetValueOne
    // paceTo = slower pace (higher mm:ss) → lower m/s → targetValueTwo
    targetValueOne = paceToMps(step.paceFrom)
    targetValueTwo = paceToMps(step.paceTo)
  } else if (targetKey === 'heartRate' && step.hrFrom != null && step.hrTo != null) {
    targetValueOne = step.hrFrom
    targetValueTwo = step.hrTo
  }

  // Distance unit hint
  const preferredEndConditionUnit = step.endCondition === 'distance'
    ? { unitKey: 'kilometer' }
    : null

  return {
    type: 'ExecutableStepDTO',
    stepId: null,
    stepOrder: order,
    stepType,
    childStepId,
    description: step.description || null,
    endCondition: {
      ...endCond,
      displayOrder: endCond.conditionTypeId,
      displayable: true,
    },
    endConditionValue: step.endCondition === 'lapButton' ? null : (step.endValue ?? null),
    preferredEndConditionUnit,
    endConditionCompare: null,
    targetType,
    targetValueOne,
    targetValueTwo,
    targetValueUnit: null,
    zoneNumber: null,
    secondaryTargetType: null,
    secondaryTargetValueOne: null,
    secondaryTargetValueTwo: null,
    secondaryTargetValueUnit: null,
    secondaryZoneNumber: null,
    endConditionZone: null,
    strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
    equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
    category: null,
    exerciseName: null,
    workoutProvider: null,
    providerExerciseSourceId: null,
    weightValue: null,
    weightUnit: null,
  }
}

/**
 * Build a RepeatGroupDTO from a repeat step definition.
 */
function buildRepeatGroup(
  step: RepeatStepDef,
  counters: { nextStepOrder: number; nextChildStepId: number },
): Record<string, unknown> {
  const order = counters.nextStepOrder++
  const childStepId = counters.nextChildStepId++
  const subSteps = step.steps.map((s) =>
    buildExecutableStep(s, counters.nextStepOrder++, childStepId)
  )

  return {
    type: 'RepeatGroupDTO',
    stepId: null,
    stepOrder: order,
    stepType: STEP_TYPES.repeat,
    childStepId,
    numberOfIterations: step.iterations,
    workoutSteps: subSteps,
    endConditionValue: step.iterations,
    preferredEndConditionUnit: null,
    endConditionCompare: null,
    endCondition: {
      ...END_CONDITIONS.iterations,
      displayOrder: 7,
      displayable: false,
    },
    skipLastRestStep: null,
    smartRepeat: false,
  }
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Convert a simplified WorkoutDef into the full Garmin Connect workout JSON.
 */
export function buildGarminWorkout(def: WorkoutDef): Record<string, unknown> {
  const validationError = validateWorkoutDef(def)
  if (validationError) {
    throw new TypeError(`Invalid workout definition: ${validationError}`)
  }

  const sport = SPORT_TYPES[def.sport || 'running'] || SPORT_TYPES.running

  // Garmin numbers the repeat group, its children, and following top-level
  // steps in one global sequence. childStepId links children to a repeat and
  // must be distinct when a workout contains more than one repeat group.
  const counters = { nextStepOrder: 1, nextChildStepId: 1 }
  const workoutSteps = def.steps.map((step) => {
    if (step.type === 'repeat') {
      return buildRepeatGroup(step as RepeatStepDef, counters)
    }
    return buildExecutableStep(step as SimpleStepDef, counters.nextStepOrder++)
  })

  return {
    workoutName: def.name,
    description: def.description || null,
    sportType: sport,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: sport,
        poolLengthUnit: null,
        poolLength: null,
        avgTrainingSpeed: null,
        estimatedDurationInSecs: null,
        estimatedDistanceInMeters: null,
        estimatedDistanceUnit: null,
        estimateType: null,
        description: null,
        workoutSteps,
      },
    ],
  }
}

/**
 * Validate a WorkoutDef, returning an error message or null if valid.
 */
export function validateWorkoutDef(def: WorkoutDef): string | null {
  if (!isRecord(def)) {
    return 'Workout definition must be an object'
  }
  const unknownField = findUnknownField(def, WORKOUT_FIELDS)
  if (unknownField) {
    return `Workout: unknown field "${unknownField}"`
  }
  if (!def.name || typeof def.name !== 'string') {
    return 'Workout name is required'
  }
  const nameLength = Array.from(def.name.trim()).length
  if (nameLength === 0 || nameLength > MAX_WORKOUT_NAME_LENGTH) {
    return `Workout name must contain between 1 and ${MAX_WORKOUT_NAME_LENGTH} characters`
  }
  if (def.description !== undefined && (
    typeof def.description !== 'string'
    || Array.from(def.description).length > MAX_WORKOUT_DESCRIPTION_LENGTH
  )) {
    return `Workout description must be a string no longer than ${MAX_WORKOUT_DESCRIPTION_LENGTH} characters`
  }
  if (def.sport !== undefined && !['running', 'cycling', 'swimming', 'strength'].includes(def.sport)) {
    return `Unknown sport "${def.sport}"`
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    return 'At least one step is required'
  }
  if (def.steps.length > MAX_WORKOUT_STEPS) {
    return `Workout must contain between 1 and ${MAX_WORKOUT_STEPS} top-level steps`
  }

  let totalStepCount = def.steps.length
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]
    const prefix = `Step ${i + 1}`

    if (!isRecord(step)) {
      return `${prefix}: step must be an object`
    }
    if (step.type === 'repeat') {
      const r = step as RepeatStepDef
      const unknownField = findUnknownField(r, REPEAT_STEP_FIELDS)
      if (unknownField) {
        return `${prefix}: unknown field "${unknownField}"`
      }
      if (!Number.isInteger(r.iterations) || r.iterations < 1 || r.iterations > MAX_REPEAT_ITERATIONS) {
        return `${prefix}: repeat iterations must be an integer between 1 and ${MAX_REPEAT_ITERATIONS}`
      }
      if (!Array.isArray(r.steps) || r.steps.length === 0) {
        return `${prefix}: repeat group must contain at least one sub-step`
      }
      if (r.steps.length > MAX_WORKOUT_STEPS) {
        return `${prefix}: repeat group must contain between 1 and ${MAX_WORKOUT_STEPS} sub-steps`
      }
      totalStepCount += r.steps.length
      if (totalStepCount > MAX_WORKOUT_STEPS) {
        return `Workout must contain at most ${MAX_WORKOUT_STEPS} total steps including repeat sub-steps`
      }
      for (let j = 0; j < r.steps.length; j++) {
        const error = validateSimpleStep(r.steps[j], `${prefix}, sub-step ${j + 1}`)
        if (error) return error
      }
    } else {
      const error = validateSimpleStep(step as SimpleStepDef, prefix)
      if (error) return error
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findUnknownField(value: object, allowedFields: ReadonlySet<string>): string | null {
  return Object.keys(value).find(field => !allowedFields.has(field)) ?? null
}

function validateSimpleStep(value: unknown, prefix: string): string | null {
  if (!isRecord(value)) {
    return `${prefix}: step must be an object`
  }
  const step = value as unknown as SimpleStepDef
  const unknownField = findUnknownField(step, SIMPLE_STEP_FIELDS)
  if (unknownField) {
    return `${prefix}: unknown field "${unknownField}"`
  }
  if (!['warmup', 'interval', 'recovery', 'cooldown', 'rest'].includes(step.type)) {
    return `${prefix}: unknown step type "${step.type}"`
  }
  if (step.description !== undefined && (
    typeof step.description !== 'string'
    || Array.from(step.description.trim()).length === 0
    || Array.from(step.description).length > MAX_STEP_DESCRIPTION_LENGTH
  )) {
    return `${prefix}: description must contain between 1 and ${MAX_STEP_DESCRIPTION_LENGTH} characters`
  }
  if (!step.endCondition) {
    return `${prefix}: endCondition is required`
  }
  if (!['distance', 'time', 'lapButton'].includes(step.endCondition)) {
    return `${prefix}: unknown endCondition "${step.endCondition}"`
  }
  if (step.endCondition === 'lapButton' && step.endValue !== undefined) {
    return `${prefix}: endValue is not allowed for lapButton condition`
  }
  if (step.endCondition === 'distance' && (
    typeof step.endValue !== 'number'
    || !Number.isFinite(step.endValue)
    || step.endValue <= 0
    || step.endValue > MAX_DISTANCE_METERS
  )) {
    return `${prefix}: distance endValue must be a finite number between 0 and ${MAX_DISTANCE_METERS} meters`
  }
  if (step.endCondition === 'time' && (
    typeof step.endValue !== 'number'
    || !Number.isFinite(step.endValue)
    || step.endValue <= 0
    || step.endValue > MAX_DURATION_SECONDS
  )) {
    return `${prefix}: time endValue must be a finite number between 0 and ${MAX_DURATION_SECONDS} seconds`
  }
  if (step.target !== undefined && !['open', 'pace', 'heartRate'].includes(step.target)) {
    return `${prefix}: unknown target "${step.target}"`
  }
  if (step.target === 'pace') {
    if (!step.paceFrom || !step.paceTo) {
      return `${prefix}: paceFrom and paceTo are required for pace target (format "mm:ss")`
    }
    for (const [field, value] of [['paceFrom', step.paceFrom], ['paceTo', step.paceTo]] as const) {
      try {
        paceToMps(value)
      } catch {
        return `${prefix}: ${field} must use mm:ss format with seconds below 60 and a positive duration`
      }
    }
    if (paceToMps(step.paceFrom) < paceToMps(step.paceTo)) {
      return `${prefix}: paceFrom must be faster than or equal to paceTo`
    }
  } else if (step.paceFrom !== undefined || step.paceTo !== undefined) {
    return `${prefix}: paceFrom and paceTo are only allowed for pace targets`
  }
  if (step.target === 'heartRate') {
    if (step.hrFrom == null || step.hrTo == null) {
      return `${prefix}: hrFrom and hrTo are required for heartRate target`
    }
    for (const [field, value] of [['hrFrom', step.hrFrom], ['hrTo', step.hrTo]] as const) {
      if (!Number.isInteger(value) || value < 30 || value > 250) {
        return `${prefix}: ${field} must be an integer between 30 and 250 bpm`
      }
    }
    if (step.hrFrom > step.hrTo) {
      return `${prefix}: hrFrom must be less than or equal to hrTo`
    }
  } else if (step.hrFrom !== undefined || step.hrTo !== undefined) {
    return `${prefix}: hrFrom and hrTo are only allowed for heartRate targets`
  }
  return null
}
