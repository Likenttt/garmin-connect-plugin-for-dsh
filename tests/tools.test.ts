import { GarminToolService } from '../src/tool-service'
import type { Config } from '../src/config'
import { getDatesInRange, registerTools, todayLocal } from '../src/tools/index'

function registerSingle(ctx: any, client: any, config: Config): void {
  registerTools(ctx, [{
    accountId: 'athlete', slot: 1,
    region: config.region, client, config, configured: true,
  }])
}

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

    registerSingle(ctx, client, {
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
    for (const definition of definitions) {
      expect(definition.parameters.properties.account).toMatchObject({
        type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$',
      })
    }

    const downloadFit = definitions.find(
      definition => definition.name === 'download_garmin_activity_fit',
    )!
    expect(downloadFit.description).toContain('GARMIN_FIT_DOWNLOAD_DIR')
    expect(downloadFit.description).toContain('parent directory')
    expect(downloadFit.description).toContain('GARMIN_FIT_<region>_<account-email>')
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

    const runningAdvice = definitions.find(
      definition => definition.name === 'get_running_skill_advice',
    )!
    expect(runningAdvice.description).toContain('personalized')
    expect(runningAdvice.description).toContain('Hansons')
    expect(runningAdvice.description).toContain('Jack Daniels')
    expect(runningAdvice.description).toContain('Norwegian')
    expect(runningAdvice.description).toContain('polarized')
    expect(runningAdvice.parameters).toMatchObject({
      type: 'object',
      required: ['mode'],
      additionalProperties: false,
      properties: {
        mode: { enum: ['explain', 'personalized'] },
        language: { enum: ['zh-CN', 'en'] },
        goal: { type: 'string', minLength: 4, maxLength: 500 },
        currentPerformance: { type: 'string', minLength: 4, maxLength: 500 },
        performanceBasis: {
          enum: ['recent_race', 'time_trial', 'no_recent_benchmark'],
        },
        trainingBackground: { type: 'string', minLength: 8, maxLength: 1000 },
        availability: { type: 'string', minLength: 4, maxLength: 750 },
        healthConstraints: { type: 'string', minLength: 2, maxLength: 750 },
        hasWarningSymptoms: { type: 'boolean' },
        trainingPreference: { enum: ['steady', 'hard_easy', 'mixed'] },
        maxQualitySessionsPerWeek: {
          type: 'integer',
          minimum: 0,
          maximum: 7,
        },
        intensityGuidancePreference: {
          enum: ['pace', 'heart_rate', 'rpe', 'mixed'],
        },
      },
    })

    const createWorkout = definitions.find(
      definition => definition.name === 'create_garmin_workout',
    )!
    expect(createWorkout.description).toContain('does not generate a training plan')
    expect(createWorkout.description).toContain('mode="personalized"')
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
    registerSingle(ctx, client, {
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
      registerSingle(ctx, {}, {
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
    registerSingle(ctx, client, {
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

  it('requires an ID with two accounts and routes exact IDs or an unambiguous legacy region', async () => {
    const definitions: Array<{ name: string; execute: (args: any) => Promise<any> }> = []
    const ctx = {
      tools: { register: (definition: any) => definitions.push(definition) },
      logger: { info: jest.fn() },
    }
    const cnProfile = jest.fn().mockResolvedValue({ displayName: 'China athlete' })
    const globalProfile = jest.fn().mockResolvedValue({ displayName: 'Global athlete' })
    const base: Config = {
      username: 'china@example.test', region: 'cn', cacheTtl: 0,
      logLevel: 'info', activityDetail: 'full', fitDownloadDir: '',
    }
    registerTools(ctx as any, [
      {
        accountId: 'china', slot: 1, region: 'cn', configured: true,
        client: { getUserProfile: cnProfile } as any, config: base,
      },
      {
        accountId: 'travel', slot: 2, region: 'global', configured: true,
        client: { getUserProfile: globalProfile } as any,
        config: { ...base, username: 'global@example.test', region: 'global' },
      },
    ])
    const profile = definitions.find(definition => definition.name === 'get_garmin_profile')!

    await expect(profile.execute({})).resolves.toEqual({
      error: true,
      message: 'Multiple Garmin accounts are configured. Set account to an account ID: china, travel.',
    })
    expect(cnProfile).not.toHaveBeenCalled()
    expect(globalProfile).not.toHaveBeenCalled()
    await profile.execute({ account: 'cn' })
    expect(cnProfile).toHaveBeenCalledTimes(1)
    expect(globalProfile).not.toHaveBeenCalled()
    await profile.execute({ account: 'travel' })
    expect(globalProfile).toHaveBeenCalledTimes(1)
  })

  it('defaults to the only configured region and explains when another slot is empty', async () => {
    const definitions: Array<{ name: string; execute: (args: any) => Promise<any> }> = []
    const ctx = {
      tools: { register: (definition: any) => definitions.push(definition) },
      logger: { info: jest.fn() },
    }
    const cnProfile = jest.fn().mockResolvedValue({ displayName: 'China athlete' })
    const base: Config = {
      username: 'china@example.test', region: 'cn', cacheTtl: 0,
      logLevel: 'info', activityDetail: 'full', fitDownloadDir: '',
    }
    registerTools(ctx as any, [
      {
        accountId: 'china', slot: 1, region: 'cn', configured: true,
        client: { getUserProfile: cnProfile } as any, config: base,
      },
      {
        accountId: 'global-empty', slot: 2, region: 'global', configured: false, client: {} as any,
        config: { ...base, username: '', region: 'global' },
      },
    ])
    const profile = definitions.find(definition => definition.name === 'get_garmin_profile')!
    await profile.execute({})
    expect(cnProfile).toHaveBeenCalledTimes(1)
    await expect(profile.execute({ account: 'global' })).resolves.toEqual({
      error: true,
      message: 'No Garmin global account is configured. Add it in the plugin settings.',
    })
  })

  it('does not treat one region as one account when two accounts share it', async () => {
    const definitions: Array<{ name: string; execute: (args: any) => Promise<any> }> = []
    const ctx = {
      tools: { register: (definition: any) => definitions.push(definition) },
      logger: { info: jest.fn() },
    }
    const firstProfile = jest.fn().mockResolvedValue({ displayName: 'First' })
    const secondProfile = jest.fn().mockResolvedValue({ displayName: 'Second' })
    const base: Config = {
      username: 'first@example.test', region: 'cn', cacheTtl: 0,
      logLevel: 'info', activityDetail: 'full', fitDownloadDir: '',
    }
    registerTools(ctx as any, [
      {
        accountId: 'first', slot: 1, region: 'cn', configured: true,
        client: { getUserProfile: firstProfile } as any, config: base,
      },
      {
        accountId: 'second', slot: 2, region: 'cn', configured: true,
        client: { getUserProfile: secondProfile } as any,
        config: { ...base, username: 'second@example.test' },
      },
    ])
    const profile = definitions.find(definition => definition.name === 'get_garmin_profile')!
    await expect(profile.execute({ account: 'cn' })).resolves.toEqual({
      error: true,
      message: 'Multiple Garmin cn accounts are configured. Select a specific account ID.',
    })
    await profile.execute({ account: 'second' })
    expect(firstProfile).not.toHaveBeenCalled()
    expect(secondProfile).toHaveBeenCalledTimes(1)
  })

  it('explains running concepts without an account but selects one before recent activity enrichment', async () => {
    const base: Config = {
      username: '', region: 'cn', cacheTtl: 0,
      logLevel: 'info', activityDetail: 'full', fitDownloadDir: '',
    }
    for (const configuredCount of [0, 2]) {
      const definitions: Array<{ name: string; execute: (args: any) => Promise<any> }> = []
      registerTools({
        tools: { register: (definition: any) => definitions.push(definition) },
        logger: { info: jest.fn() },
      } as any, [
        {
          accountId: 'china', slot: 1,
          region: 'cn', configured: configuredCount > 0, client: {} as any, config: base,
        },
        {
          accountId: 'travel', slot: 2,
          region: 'global', configured: configuredCount > 0, client: {} as any,
          config: { ...base, region: 'global' },
        },
      ])
      const advice = definitions.find(definition => definition.name === 'get_running_skill_advice')!
      await expect(advice.execute({ mode: 'explain', query: 'threshold' }))
        .resolves.toMatchObject({ mode: 'explain', requiresUserInput: false })
      await expect(advice.execute({ mode: 'personalized', includeRecentActivities: true }))
        .resolves.toMatchObject({
          error: true,
          message: configuredCount === 0
            ? expect.stringContaining('No Garmin account is configured')
            : expect.stringContaining('Set account to an account ID'),
        })
    }
  })
})
