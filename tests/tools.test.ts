import { getDatesInRange, registerTools, todayLocal } from '../src/tools/index'

describe('Tools Utils', () => {
  describe('getDatesInRange', () => {
    it('should generate dates correctly for valid range', () => {
      const dates = getDatesInRange('2023-10-01', '2023-10-03')
      expect(dates).toEqual(['2023-10-01', '2023-10-02', '2023-10-03'])
    })

    it('rejects a reversed range instead of returning misleading data', () => {
      expect(() => getDatesInRange('2023-10-03', '2023-10-01'))
        .toThrow('endDate must be on or after startDate')
    })

    it('rejects ranges over 30 days instead of silently truncating them', () => {
      expect(() => getDatesInRange('2023-01-01', '2023-03-01'))
        .toThrow('Date range cannot exceed 30 days')
    })

    it('rejects impossible calendar dates', () => {
      expect(() => getDatesInRange('2023-02-30', '2023-03-01'))
        .toThrow('expected a real date in YYYY-MM-DD format')
    })
  })

  describe('todayLocal', () => {
    it('should return a string in YYYY-MM-DD format', () => {
      const today = todayLocal()
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  it('registers the same nine non-secret Garmin tools for the DSH adapter', () => {
    const definitions: Array<{ name: string; parameters?: any }> = []
    const ctx = {
      tools: { register: (definition: { name: string }) => definitions.push(definition) },
      logger: { info: jest.fn() },
    }
    const client = {
      getActivities: jest.fn(),
      getSleep: jest.fn(),
      getSteps: jest.fn(),
      getHeartRate: jest.fn(),
      getWeight: jest.fn(),
      getWorkouts: jest.fn(),
      addWorkout: jest.fn(),
      getUserProfile: jest.fn(),
    }

    registerTools(ctx as any, client as any, {
      username: 'runner@example.com',
      password: 'not-used-by-this-test',
      region: 'global',
      cacheTtl: 300,
      logLevel: 'info',
      activityDetail: 'compact',
    })

    expect(definitions.map(definition => definition.name)).toEqual([
      'get_garmin_activities',
      'get_garmin_sleep',
      'get_garmin_steps',
      'get_garmin_heart_rate',
      'get_garmin_weight',
      'get_garmin_workouts',
      'get_garmin_profile',
      'get_running_skill_advice',
      'create_garmin_workout',
    ])

    const createWorkout = definitions.find(
      definition => definition.name === 'create_garmin_workout',
    )!
    const stepVariants = createWorkout.parameters.properties.steps.items.oneOf
    expect(stepVariants).toHaveLength(2)
    expect(stepVariants[0]).toMatchObject({
      required: expect.arrayContaining(['type', 'endCondition']),
      additionalProperties: false,
    })
    expect(stepVariants[1]).toMatchObject({
      required: expect.arrayContaining(['type', 'iterations', 'steps']),
      additionalProperties: false,
      properties: {
        steps: {
          items: expect.objectContaining({
            additionalProperties: false,
          }),
        },
      },
    })
  })

  it('returns a workout preview instead of mutating Garmin before confirmation', async () => {
    const definitions: Array<{ name: string; execute: (args: any) => Promise<any> }> = []
    const addWorkout = jest.fn()
    const ctx = {
      tools: { register: (definition: any) => definitions.push(definition) },
      logger: { info: jest.fn() },
    }
    const client = {
      getActivities: jest.fn(),
      getSleep: jest.fn(),
      getSteps: jest.fn(),
      getHeartRate: jest.fn(),
      getWeight: jest.fn(),
      getWorkouts: jest.fn(),
      addWorkout,
      getUserProfile: jest.fn(),
    }
    registerTools(ctx as any, client as any, {
      username: 'runner@example.com',
      password: 'not-used-by-this-test',
      region: 'global',
      cacheTtl: 300,
      logLevel: 'info',
      activityDetail: 'compact',
    })

    const createWorkout = definitions.find(definition => definition.name === 'create_garmin_workout')!
    const result = await createWorkout.execute({
      name: 'Easy Run',
      steps: [{ type: 'warmup', endCondition: 'time', endValue: 600 }],
    })

    expect(result).toEqual(expect.objectContaining({ requiresConfirmation: true }))
    expect(addWorkout).not.toHaveBeenCalled()
  })

  it('does not expose unexpected upstream error details in tool output', async () => {
    const definitions: Array<{ name: string; execute: (args: any) => Promise<any> }> = []
    const ctx = {
      tools: { register: (definition: any) => definitions.push(definition) },
      logger: { info: jest.fn() },
    }
    const client = {
      getActivities: jest.fn(),
      getSleep: jest.fn(),
      getSteps: jest.fn(),
      getHeartRate: jest.fn(),
      getWeight: jest.fn(),
      getWorkouts: jest.fn(),
      addWorkout: jest.fn(),
      getUserProfile: jest.fn().mockRejectedValue(new Error(
        'password=do-not-leak response contained private@example.test',
      )),
    }
    registerTools(ctx as any, client as any, {
      username: 'runner@example.com',
      password: 'not-used-by-this-test',
      region: 'global',
      cacheTtl: 300,
      logLevel: 'info',
      activityDetail: 'compact',
    })

    const profile = definitions.find(definition => definition.name === 'get_garmin_profile')!
    await expect(profile.execute({})).resolves.toEqual({
      error: true,
      message: 'Failed to fetch profile',
    })
  })
})
