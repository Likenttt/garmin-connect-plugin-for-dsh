import {
  buildGarminWorkout,
  paceToMps,
  validateWorkoutDef,
  type WorkoutDef,
} from '../src/knowledge/workout-schema'

const VALID_INTERVAL_WORKOUT: WorkoutDef = {
  name: '门槛巡航 3×8 分钟',
  description: '热身后完成三组门槛跑，组间慢跑恢复。',
  sport: 'running',
  steps: [
    {
      type: 'warmup',
      description: '轻松热身',
      endCondition: 'time',
      endValue: 600,
    },
    {
      type: 'repeat',
      iterations: 3,
      steps: [
        {
          type: 'interval',
          description: '门槛跑',
          endCondition: 'time',
          endValue: 480,
          target: 'pace',
          paceFrom: '4:45',
          paceTo: '5:00',
        },
        {
          type: 'recovery',
          description: '慢跑恢复',
          endCondition: 'time',
          endValue: 120,
          target: 'heartRate',
          hrFrom: 120,
          hrTo: 145,
        },
      ],
    },
    {
      type: 'cooldown',
      description: '放松跑',
      endCondition: 'lapButton',
    },
  ],
}

describe('pace conversion', () => {
  it('converts a valid per-kilometer pace to meters per second', () => {
    expect(paceToMps('5:00')).toBe(3.3333)
  })

  it('rejects pace seconds outside the mm:ss range', () => {
    expect(() => paceToMps('5:60')).toThrow('Pace must use mm:ss format')
  })

  it('rejects a pace that cannot produce a positive finite speed', () => {
    expect(() => paceToMps('99999999:00')).toThrow(
      'Pace must produce a positive finite speed',
    )
  })

  it.each(['5:5', '5:000', '5', '5:30x', ' 5:30', '5.5:30', '-5:30', '00:00'])(
    'rejects malformed pace %p',
    (pace) => {
      expect(() => paceToMps(pace)).toThrow('Pace must use mm:ss format')
    },
  )
})

describe('workout definition validation', () => {
  it('keeps a valid interval workout compatible', () => {
    expect(validateWorkoutDef(VALID_INTERVAL_WORKOUT)).toBeNull()
  })

  it('rejects an invalid sub-step inside a repeat group', () => {
    const workout = {
      name: 'Intervals',
      steps: [
        {
          type: 'repeat',
          iterations: 4,
          steps: [{}],
        },
      ],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1, sub-step 1: unknown step type "undefined"',
    )
  })

  it('rejects malformed pace targets', () => {
    const workout = {
      name: 'Bad pace',
      steps: [
        {
          type: 'interval',
          endCondition: 'time',
          endValue: 300,
          target: 'pace',
          paceFrom: '5:60',
          paceTo: '6:00',
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: paceFrom must use mm:ss format with seconds below 60 and a positive duration',
    )
  })

  it('requires paceFrom to be the faster pace bound', () => {
    const workout = {
      name: 'Reversed pace',
      steps: [
        {
          type: 'interval',
          endCondition: 'distance',
          endValue: 1000,
          target: 'pace',
          paceFrom: '5:30',
          paceTo: '5:00',
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: paceFrom must be faster than or equal to paceTo',
    )
  })

  it('requires heart-rate bounds in ascending order', () => {
    const workout = {
      name: 'Reversed heart rate',
      steps: [
        {
          type: 'interval',
          endCondition: 'time',
          endValue: 600,
          target: 'heartRate',
          hrFrom: 180,
          hrTo: 160,
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: hrFrom must be less than or equal to hrTo',
    )
  })

  it.each([NaN, Infinity, 29, 251, 150.5])(
    'rejects an out-of-range heart-rate bound: %p',
    (hrFrom) => {
      const workout = {
        name: 'Bad heart rate',
        steps: [
          {
            type: 'interval',
            endCondition: 'time',
            endValue: 600,
            target: 'heartRate',
            hrFrom,
            hrTo: 200,
          },
        ],
      } as WorkoutDef

      expect(validateWorkoutDef(workout)).toBe(
        'Step 1: hrFrom must be an integer between 30 and 250 bpm',
      )
    },
  )

  it('rejects a non-finite distance', () => {
    const workout = {
      name: 'Bad distance',
      steps: [
        {
          type: 'interval',
          endCondition: 'distance',
          endValue: NaN,
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: distance endValue must be a finite number between 0 and 1000000 meters',
    )
  })

  it('rejects an excessively long timed step', () => {
    const workout = {
      name: 'Bad duration',
      steps: [
        {
          type: 'recovery',
          endCondition: 'time',
          endValue: 86_401,
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: time endValue must be a finite number between 0 and 86400 seconds',
    )
  })

  it('rejects unknown end conditions', () => {
    const workout = {
      name: 'Unknown condition',
      steps: [
        {
          type: 'warmup',
          endCondition: 'calories',
          endValue: 100,
        },
      ],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: unknown endCondition "calories"',
    )
  })

  it('rejects unknown target types', () => {
    const workout = {
      name: 'Unknown target',
      steps: [
        {
          type: 'interval',
          endCondition: 'time',
          endValue: 60,
          target: 'power',
        },
      ],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: unknown target "power"',
    )
  })

  it.each([NaN, Infinity, 0, 1.5, 100])(
    'rejects an invalid repeat count: %p',
    (iterations) => {
      const workout = {
        name: 'Bad repeats',
        steps: [
          {
            type: 'repeat',
            iterations,
            steps: [
              {
                type: 'recovery',
                endCondition: 'time',
                endValue: 60,
              },
            ],
          },
        ],
      } as WorkoutDef

      expect(validateWorkoutDef(workout)).toBe(
        'Step 1: repeat iterations must be an integer between 1 and 99',
      )
    },
  )

  it('caps the number of top-level workout steps', () => {
    const workout = {
      name: 'Too many steps',
      steps: Array.from({ length: 101 }, () => ({
        type: 'interval',
        endCondition: 'time',
        endValue: 30,
      })),
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Workout must contain between 1 and 100 top-level steps',
    )
  })

  it('caps the number of steps in a repeat group', () => {
    const workout = {
      name: 'Too many sub-steps',
      steps: [
        {
          type: 'repeat',
          iterations: 2,
          steps: Array.from({ length: 101 }, () => ({
            type: 'interval',
            endCondition: 'time',
            endValue: 30,
          })),
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: repeat group must contain between 1 and 100 sub-steps',
    )
  })

  it('caps the total number of structural steps across repeat groups', () => {
    const workout = {
      name: 'Oversized payload',
      steps: [
        {
          type: 'repeat',
          iterations: 2,
          steps: Array.from({ length: 100 }, () => ({
            type: 'interval',
            endCondition: 'time',
            endValue: 30,
          })),
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Workout must contain at most 100 total steps including repeat sub-steps',
    )
  })

  it('caps workout names at 80 characters', () => {
    const workout = {
      name: 'x'.repeat(81),
      steps: [
        {
          type: 'cooldown',
          endCondition: 'lapButton',
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Workout name must contain between 1 and 80 characters',
    )
  })

  it('caps workout descriptions at 1024 characters', () => {
    const workout = {
      name: 'Long notes',
      description: 'x'.repeat(1025),
      steps: [
        {
          type: 'cooldown',
          endCondition: 'lapButton',
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Workout description must be a string no longer than 1024 characters',
    )
  })

  it('caps repeat sub-step descriptions at 20 characters', () => {
    const workout = {
      name: 'Watch labels',
      steps: [
        {
          type: 'repeat',
          iterations: 3,
          steps: [
            {
              type: 'interval',
              description: 'x'.repeat(21),
              endCondition: 'time',
              endValue: 60,
            },
          ],
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1, sub-step 1: description must contain between 1 and 20 characters',
    )
  })

  it('rejects unknown workout fields', () => {
    const workout = {
      name: 'Typo',
      workoutDescription: 'This field is misspelled',
      steps: [
        {
          type: 'cooldown',
          endCondition: 'lapButton',
        },
      ],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Workout: unknown field "workoutDescription"',
    )
  })

  it('rejects unknown fields in a simple step', () => {
    const workout = {
      name: 'Typo',
      steps: [
        {
          type: 'interval',
          endCondition: 'time',
          endValue: 60,
          pace: '5:00',
        },
      ],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: unknown field "pace"',
    )
  })

  it('rejects simple-step fields on a repeat group', () => {
    const workout = {
      name: 'Mixed semantics',
      steps: [
        {
          type: 'repeat',
          iterations: 3,
          endCondition: 'time',
          steps: [
            {
              type: 'interval',
              endCondition: 'time',
              endValue: 60,
            },
          ],
        },
      ],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: unknown field "endCondition"',
    )
  })

  it('rejects pace bounds on a non-pace target', () => {
    const workout = {
      name: 'Unused pace',
      steps: [
        {
          type: 'interval',
          endCondition: 'time',
          endValue: 60,
          target: 'open',
          paceFrom: '5:00',
          paceTo: '5:15',
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: paceFrom and paceTo are only allowed for pace targets',
    )
  })

  it('rejects heart-rate bounds on a non-heart-rate target', () => {
    const workout = {
      name: 'Unused heart rate',
      steps: [
        {
          type: 'recovery',
          endCondition: 'time',
          endValue: 60,
          hrFrom: 120,
          hrTo: 140,
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: hrFrom and hrTo are only allowed for heartRate targets',
    )
  })

  it('rejects endValue when the lap button ends a step', () => {
    const workout = {
      name: 'Unused end value',
      steps: [
        {
          type: 'warmup',
          endCondition: 'lapButton',
          endValue: 60,
        },
      ],
    } as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: endValue is not allowed for lapButton condition',
    )
  })

  it('rejects unknown sport types', () => {
    const workout = {
      name: 'Unknown sport',
      sport: 'rowing',
      steps: [
        {
          type: 'warmup',
          endCondition: 'lapButton',
        },
      ],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Unknown sport "rowing"',
    )
  })

  it('rejects the unsupported other sport instead of silently creating a run', () => {
    const workout = {
      name: 'Not secretly running',
      sport: 'other',
      steps: [{ type: 'warmup', endCondition: 'lapButton' }],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe('Unknown sport "other"')
  })

  it('rejects a non-object workout definition without throwing', () => {
    expect(validateWorkoutDef(null as unknown as WorkoutDef)).toBe(
      'Workout definition must be an object',
    )
  })

  it('rejects a non-object step without throwing', () => {
    const workout = {
      name: 'Bad step',
      steps: [null],
    } as unknown as WorkoutDef

    expect(validateWorkoutDef(workout)).toBe(
      'Step 1: step must be an object',
    )
  })
})

describe('Garmin workout building', () => {
  it.each([
    ['running', { sportTypeId: 1, sportTypeKey: 'running' }],
    ['cycling', { sportTypeId: 2, sportTypeKey: 'cycling' }],
    ['swimming', { sportTypeId: 4, sportTypeKey: 'swimming' }],
    ['strength', { sportTypeId: 5, sportTypeKey: 'strength_training' }],
  ] as const)('maps %s to the Garmin workout sport contract', (sport, expected) => {
    const workout: WorkoutDef = {
      name: `${sport} workout`,
      sport,
      steps: [{ type: 'warmup', endCondition: 'lapButton' }],
    }

    expect(buildGarminWorkout(workout)).toMatchObject({
      sportType: expected,
      workoutSegments: [{ sportType: expected }],
    })
  })

  it('builds repeat, pace, and heart-rate steps for a valid workout', () => {
    expect(buildGarminWorkout(VALID_INTERVAL_WORKOUT)).toMatchObject({
      workoutName: '门槛巡航 3×8 分钟',
      sportType: { sportTypeId: 1, sportTypeKey: 'running' },
      workoutSegments: [
        {
          workoutSteps: [
            {
              type: 'ExecutableStepDTO',
              stepOrder: 1,
              endConditionValue: 600,
            },
            {
              type: 'RepeatGroupDTO',
              stepOrder: 2,
              childStepId: 1,
              numberOfIterations: 3,
              workoutSteps: [
                {
                  type: 'ExecutableStepDTO',
                  stepOrder: 3,
                  childStepId: 1,
                  targetValueOne: 3.5088,
                  targetValueTwo: 3.3333,
                },
                {
                  type: 'ExecutableStepDTO',
                  stepOrder: 4,
                  childStepId: 1,
                  targetValueOne: 120,
                  targetValueTwo: 145,
                },
              ],
            },
            {
              type: 'ExecutableStepDTO',
              stepOrder: 5,
              childStepId: null,
              endConditionValue: null,
            },
          ],
        },
      ],
    })
  })

  it('uses global step order and a unique child id for each repeat group', () => {
    const workout: WorkoutDef = {
      name: 'Two repeat groups',
      steps: [
        {
          type: 'repeat',
          iterations: 2,
          steps: [{ type: 'interval', endCondition: 'time', endValue: 60 }],
        },
        {
          type: 'repeat',
          iterations: 3,
          steps: [{ type: 'recovery', endCondition: 'time', endValue: 30 }],
        },
      ],
    }

    const steps = (buildGarminWorkout(workout).workoutSegments as Array<{
      workoutSteps: Array<Record<string, unknown>>
    }>)[0].workoutSteps

    expect(steps).toMatchObject([
      {
        stepOrder: 1,
        childStepId: 1,
        workoutSteps: [{ stepOrder: 2, childStepId: 1 }],
      },
      {
        stepOrder: 3,
        childStepId: 2,
        workoutSteps: [{ stepOrder: 4, childStepId: 2 }],
      },
    ])
  })

  it('refuses to build an invalid workout payload', () => {
    const workout = {
      name: 'Unsafe payload',
      steps: [
        {
          type: 'interval',
          endCondition: 'distance',
          endValue: NaN,
        },
      ],
    } as WorkoutDef

    expect(() => buildGarminWorkout(workout)).toThrow(
      'Invalid workout definition: Step 1: distance endValue must be a finite number',
    )
  })
})
