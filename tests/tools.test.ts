import { GarminToolService } from '../src/tool-service'
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

  it('registers the same ten non-secret Garmin tools for the DSH adapter', () => {
    const definitions: Array<{ name: string; description?: string; parameters?: any }> = []
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
      downloadOriginalActivityZip: jest.fn(),
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
      fitDownloadDir: '/tmp/garmin-fit-tools-test-output',
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
      'download_garmin_activity_fit',
    ])

    const downloadFit = definitions.find(
      definition => definition.name === 'download_garmin_activity_fit',
    )!
    expect(downloadFit.description).toContain('GARMIN_FIT_DOWNLOAD_DIR')
    expect(downloadFit.description).toContain('parent directory')
    expect(downloadFit.parameters).toMatchObject({
      type: 'object',
      required: ['activityId'],
      additionalProperties: false,
      properties: {
        activityId: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
    })

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
      downloadOriginalActivityZip: jest.fn(),
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
      fitDownloadDir: '/tmp/garmin-fit-tools-test-output',
    })

    const createWorkout = definitions.find(definition => definition.name === 'create_garmin_workout')!
    const result = await createWorkout.execute({
      name: 'Easy Run',
      steps: [{ type: 'warmup', endCondition: 'time', endValue: 600 }],
    })

    expect(result).toEqual(expect.objectContaining({ requiresConfirmation: true }))
    expect(addWorkout).not.toHaveBeenCalled()
  })

  it('returns only FIT file metadata from the DSH adapter', async () => {
    const definitions: Array<{ name: string; execute: (args: any) => Promise<any> }> = []
    const download = jest.spyOn(GarminToolService.prototype, 'downloadActivityFit')
      .mockResolvedValue({
        success: true,
        activityId: 42,
        fileName: '42.fit',
        sizeBytes: 14,
        sha256: 'a'.repeat(64),
      })
    const ctx = {
      tools: { register: (definition: any) => definitions.push(definition) },
      logger: { info: jest.fn() },
    }

    try {
      registerTools(ctx as any, {} as any, {
        username: 'runner@example.com',
        password: 'not-used-by-this-test',
        region: 'global',
        cacheTtl: 300,
        logLevel: 'info',
        activityDetail: 'compact',
        fitDownloadDir: '/private/downloads',
      })

      const tool = definitions.find(
        definition => definition.name === 'download_garmin_activity_fit',
      )!
      const result = await tool.execute({ activityId: 42 })
      expect(result).toEqual({
        success: true,
        activityId: 42,
        fileName: '42.fit',
        sizeBytes: 14,
        sha256: 'a'.repeat(64),
      })
      expect(JSON.stringify(result)).not.toContain('runner@example.com')
      expect(JSON.stringify(result)).not.toContain('/private/downloads')
      expect(download).toHaveBeenCalledWith({ activityId: 42 })
    } finally {
      download.mockRestore()
    }
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
      downloadOriginalActivityZip: jest.fn(),
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
      fitDownloadDir: '/tmp/garmin-fit-tools-test-output',
    })

    const profile = definitions.find(definition => definition.name === 'get_garmin_profile')!
    await expect(profile.execute({})).resolves.toEqual({
      error: true,
      message: 'Failed to fetch profile',
    })
  })
})
