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
  sport?: 'running' | 'cycling' | 'swimming' | 'strength' | 'other'
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
  swimming: { sportTypeId: 5, sportTypeKey: 'lap_swimming' },
  strength: { sportTypeId: 4, sportTypeKey: 'strength_training' },
  other:    { sportTypeId: 1, sportTypeKey: 'running' }, // fallback
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

// ---------------------------------------------------------------------------
// Conversion utilities
// ---------------------------------------------------------------------------

/**
 * Parse a pace string "mm:ss" to m/s.
 * e.g. "5:00" per km → 1000 / 300 = 3.3333 m/s
 */
export function paceToMps(pace: string): number {
  const parts = pace.split(':')
  const mm = parseInt(parts[0], 10)
  const ss = parseInt(parts[1] || '0', 10)
  const totalSeconds = mm * 60 + ss
  if (totalSeconds <= 0) return 0
  return Math.round((1000 / totalSeconds) * 10000) / 10000
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
function buildRepeatGroup(step: RepeatStepDef, order: number): Record<string, unknown> {
  const subSteps = step.steps.map((s, i) =>
    buildExecutableStep(s, i + 1, 1)
  )

  return {
    type: 'RepeatGroupDTO',
    stepId: null,
    stepOrder: order,
    stepType: STEP_TYPES.repeat,
    childStepId: 1,
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
  const sport = SPORT_TYPES[def.sport || 'running'] || SPORT_TYPES.running

  const workoutSteps = def.steps.map((step, i) => {
    if (step.type === 'repeat') {
      return buildRepeatGroup(step as RepeatStepDef, i + 1)
    }
    return buildExecutableStep(step as SimpleStepDef, i + 1)
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
  if (!def.name || typeof def.name !== 'string') {
    return 'Workout name is required'
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    return 'At least one step is required'
  }

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]
    const prefix = `Step ${i + 1}`

    if (step.type === 'repeat') {
      const r = step as RepeatStepDef
      if (!r.iterations || r.iterations < 1) {
        return `${prefix}: repeat iterations must be ≥ 1`
      }
      if (!Array.isArray(r.steps) || r.steps.length === 0) {
        return `${prefix}: repeat group must contain at least one sub-step`
      }
    } else {
      const s = step as SimpleStepDef
      if (!['warmup', 'interval', 'recovery', 'cooldown', 'rest'].includes(s.type)) {
        return `${prefix}: unknown step type "${s.type}"`
      }
      if (!s.endCondition) {
        return `${prefix}: endCondition is required`
      }
      if (s.endCondition !== 'lapButton' && (!s.endValue || s.endValue <= 0)) {
        return `${prefix}: endValue is required for ${s.endCondition} condition`
      }
      if (s.target === 'pace') {
        if (!s.paceFrom || !s.paceTo) {
          return `${prefix}: paceFrom and paceTo are required for pace target (format "mm:ss")`
        }
      }
      if (s.target === 'heartRate') {
        if (s.hrFrom == null || s.hrTo == null) {
          return `${prefix}: hrFrom and hrTo are required for heartRate target`
        }
      }
    }
  }

  return null
}
