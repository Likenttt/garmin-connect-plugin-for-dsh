import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import type { GarminDataClient } from '../src/tool-service'
import { GarminToolService } from '../src/tool-service'

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rm: jest.fn(actual.rm) }
})

const actualRm = jest.requireActual<typeof import('node:fs/promises')>(
  'node:fs/promises',
).rm
const mockedRm = rm as jest.MockedFunction<typeof rm>
const COMPLETE_PERFORMANCE_EN = '5 km in 23:30 on 2026-08-01; all-out effort on a flat course in cool weather'
const COMPLETE_TRAINING_BACKGROUND_EN = 'Running for 2 years; over the last 8 weeks average 30 km and peak 36 km per week, four days per week, longest run 12 km, one threshold quality session, and no interruption or abrupt load change in the last three months'
const COMPLETE_AVAILABILITY_EN = 'Four days per week, 60 minutes each; Monday rest day and Sunday long-run day; roads available; 30 minutes of strength training; double days unavailable'
const COMPLETE_HEALTH_EN = 'No current pain or injury; no injury in the past year; no relevant disease or medication; sleep, stress, and recovery are stable'
const COMPLETE_PERFORMANCE_ZH = '2026-08-01 参加 5 公里计时跑，成绩 23:30；全力完成，天气凉爽且赛道平坦'
const COMPLETE_TRAINING_BACKGROUND_ZH = '跑龄 2 年；近 8 周平均每周 35 公里、最高 40 公里，每周跑 4 天，最长 14 公里，每周 1 次门槛质量课，近三个月无中断或负荷突变'
const COMPLETE_AVAILABILITY_ZH = '每周可跑 4 天、每次 60 分钟；周一休息日、周日长跑日；可用道路；每周力量训练 30 分钟；不安排双练'
const COMPLETE_HEALTH_ZH = '目前无疼痛或伤病，过去一年无主要跑伤，无相关疾病或用药；睡眠、压力和恢复稳定'

function clientWith(overrides: Partial<GarminDataClient> = {}): GarminDataClient {
  return {
    getActivities: jest.fn(),
    getSleep: jest.fn(),
    getSteps: jest.fn(),
    getHeartRate: jest.fn(),
    getWeight: jest.fn(),
    getWorkouts: jest.fn(),
    downloadOriginalActivityZip: jest.fn(),
    addWorkout: jest.fn(),
    getUserProfile: jest.fn(),
    ...overrides,
  }
}

describe('GarminToolService', () => {
  it('rejects an impossible calendar date before querying Garmin', async () => {
    const getSleep = jest.fn()
    const service = new GarminToolService(clientWith({ getSleep }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getSleep({ startDate: '2026-02-30' }))
      .rejects.toThrow('Invalid startDate: expected a real date in YYYY-MM-DD format')
    expect(getSleep).not.toHaveBeenCalled()
  })

  it('returns every requested day in an inclusive date range', async () => {
    const getSleep = jest.fn(async (date: string) => ({
      dailySleepDTO: { calendarDate: date, sleepTimeSeconds: 8 * 3600 },
    }))
    const service = new GarminToolService(clientWith({ getSleep }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getSleep({
      startDate: '2026-08-18',
      endDate: '2026-08-20',
    })).resolves.toEqual([
      expect.objectContaining({ date: '2026-08-18', sleepDurationHours: 8 }),
      expect.objectContaining({ date: '2026-08-19', sleepDurationHours: 8 }),
      expect.objectContaining({ date: '2026-08-20', sleepDurationHours: 8 }),
    ])
  })

  it('rejects ranges longer than 30 days instead of silently truncating them', async () => {
    const getSleep = jest.fn()
    const service = new GarminToolService(clientWith({ getSleep }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getSleep({
      startDate: '2026-01-01',
      endDate: '2026-02-01',
    })).rejects.toThrow('Date range cannot exceed 30 days')
    expect(getSleep).not.toHaveBeenCalled()
  })

  it('limits date-range requests to four concurrent Garmin calls', async () => {
    let active = 0
    let maxActive = 0
    const getSleep = jest.fn(async (date: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setImmediate(resolve))
      active -= 1
      return { dailySleepDTO: { calendarDate: date } }
    })
    const service = new GarminToolService(clientWith({ getSleep }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await service.getSleep({ startDate: '2026-08-01', endDate: '2026-08-10' })

    expect(maxActive).toBeLessThanOrEqual(4)
  })

  it('shares the four-request limit across concurrent range tools', async () => {
    let active = 0
    let maxActive = 0
    const fetchDate = jest.fn(async (date: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setImmediate(resolve))
      active -= 1
      return { calendarDate: date, totalSteps: 1 }
    })
    const service = new GarminToolService(clientWith({
      getSleep: fetchDate,
      getSteps: fetchDate,
    }), { activityDetail: 'compact', fitDownloadDir: '/tmp/garmin-fit-service-test-output', accountUsername: 'runner@example.com' })

    await Promise.all([
      service.getSleep({ startDate: '2026-08-01', endDate: '2026-08-10' }),
      service.getSteps({ startDate: '2026-08-01', endDate: '2026-08-10' }),
    ])

    expect(maxActive).toBeLessThanOrEqual(4)
  })

  it('stops scheduling dates after the first range failure', async () => {
    const getSleep = jest.fn(async (date: string) => {
      if (date === '2026-08-01') throw new Error('first date failed')
      await Promise.resolve()
      return { dailySleepDTO: { calendarDate: date } }
    })
    const service = new GarminToolService(clientWith({ getSleep }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getSleep({
      startDate: '2026-08-01',
      endDate: '2026-08-10',
    })).rejects.toThrow('first date failed')

    expect(getSleep.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('does not swallow a dependency that rejects without an Error value', async () => {
    const getSleep = jest.fn().mockRejectedValue(undefined)
    const service = new GarminToolService(clientWith({ getSleep }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getSleep({ startDate: '2026-08-01' }))
      .rejects.toBeUndefined()
  })

  it('normalizes activity pagination and applies the requested detail level', async () => {
    const getActivities = jest.fn(async () => [{
      activityId: 7,
      activityName: 'Run',
      activityType: { typeKey: 'running' },
      distance: 5000,
      duration: 1800,
      rawOnly: 'kept-in-full-mode',
    }])
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getActivities({ limit: 500, offset: -4, detail: 'full' })

    expect(getActivities).toHaveBeenCalledWith(0, 100)
    expect(result).toEqual([
      expect.objectContaining({ id: 7, rawOnly: 'kept-in-full-mode' }),
    ])
  })

  it('downloads, validates, and saves one FIT file without returning binary data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-fit-service-test-'))
    const fitDownloadDir = join(root, 'exports')
    let privateDownloadDir = ''
    const downloadOriginalActivityZip = jest.fn(async (
      activityId: number,
      destinationDir: string,
    ) => {
      privateDownloadDir = destinationDir
      const directoryInfo = await stat(destinationDir)
      if (process.platform !== 'win32') {
        expect(directoryInfo.mode & 0o777).toBe(0o700)
      }
      const fit = Buffer.from([
        0x0E, 0x10, 0xD9, 0x07, 0x00, 0x00, 0x00, 0x00,
        0x2E, 0x46, 0x49, 0x54, 0x91, 0x33, 0x00, 0x00,
      ])
      const zipPath = join(destinationDir, `${activityId}.zip`)
      await writeFile(zipPath, zipSync({ 'nested/activity.fit': fit }))
      return zipPath
    })
    const service = new GarminToolService(clientWith({
      downloadOriginalActivityZip,
    }), {
      activityDetail: 'compact',
      fitDownloadDir,
      accountUsername: 'runner@example.com',
    })

    try {
      const result = await service.downloadActivityFit({ activityId: 42 })

      expect(result).toEqual({
        success: true,
        activityId: 42,
        fileName: '42.fit',
        sizeBytes: 16,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(Object.keys(result).sort()).toEqual([
        'activityId',
        'fileName',
        'sha256',
        'sizeBytes',
        'success',
      ])
      await expect(stat(join(
        fitDownloadDir,
        'GARMIN_FIT_runner@example.com',
        '42.fit',
      ))).resolves.toMatchObject({ size: 16 })
      expect(JSON.stringify(result)).not.toContain('runner@example.com')
      expect(JSON.stringify(result)).not.toContain(fitDownloadDir)
      expect(downloadOriginalActivityZip).toHaveBeenCalledWith(42, privateDownloadDir)
      await expect(stat(privateDownloadDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates the same activity ID into separate per-account directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-fit-accounts-test-'))
    const downloadOriginalActivityZip = jest.fn(async (
      activityId: number,
      destinationDir: string,
    ) => {
      const fit = Buffer.from([
        0x0E, 0x10, 0xD9, 0x07, 0x00, 0x00, 0x00, 0x00,
        0x2E, 0x46, 0x49, 0x54, 0x91, 0x33, 0x00, 0x00,
      ])
      const zipPath = join(destinationDir, `${activityId}.zip`)
      await writeFile(zipPath, zipSync({ 'activity.fit': fit }))
      return zipPath
    })
    const makeService = (accountUsername: string) => new GarminToolService(clientWith({
      downloadOriginalActivityZip,
    }), {
      activityDetail: 'compact',
      fitDownloadDir: root,
      accountUsername,
    })

    try {
      const [personal, work] = await Promise.all([
        makeService('Personal@Example.com').downloadActivityFit({ activityId: 42 }),
        makeService('work@example.com').downloadActivityFit({ activityId: 42 }),
      ])

      await expect(stat(join(
        root,
        'GARMIN_FIT_personal@example.com',
        '42.fit',
      ))).resolves.toMatchObject({ size: 16 })
      await expect(stat(join(
        root,
        'GARMIN_FIT_work@example.com',
        '42.fit',
      ))).resolves.toMatchObject({ size: 16 })
      expect(JSON.stringify([personal, work])).not.toContain('example.com')
      expect(JSON.stringify([personal, work])).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a malicious account identifier inside the selected parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-fit-account-path-test-'))
    const downloadOriginalActivityZip = jest.fn(async (
      activityId: number,
      destinationDir: string,
    ) => {
      const fit = Buffer.from([
        0x0E, 0x10, 0xD9, 0x07, 0x00, 0x00, 0x00, 0x00,
        0x2E, 0x46, 0x49, 0x54, 0x91, 0x33, 0x00, 0x00,
      ])
      const zipPath = join(destinationDir, `${activityId}.zip`)
      await writeFile(zipPath, zipSync({ 'activity.fit': fit }))
      return zipPath
    })
    const service = new GarminToolService(clientWith({
      downloadOriginalActivityZip,
    }), {
      activityDetail: 'compact',
      fitDownloadDir: root,
      accountUsername: '../../outside\\runner@example.com',
    })

    try {
      const result = await service.downloadActivityFit({ activityId: 42 })
      const entries = await readdir(root, { withFileTypes: true })

      expect(entries).toHaveLength(1)
      expect(entries[0].isDirectory()).toBe(true)
      expect(entries[0].name).toMatch(/^GARMIN_FIT_/)
      expect(entries[0].name).not.toContain('/')
      expect(entries[0].name).not.toContain('\\')
      await expect(stat(join(root, entries[0].name, '42.fit')))
        .resolves.toMatchObject({ size: 16 })
      expect(JSON.stringify(result)).not.toContain('runner@example.com')
      expect(JSON.stringify(result)).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid FIT activity ID %s before downloading',
    async (activityId) => {
      const downloadOriginalActivityZip = jest.fn()
      const service = new GarminToolService(clientWith({
        downloadOriginalActivityZip,
      }), {
        activityDetail: 'compact',
        fitDownloadDir: '/tmp/garmin-fit-service-test-output',
        accountUsername: 'runner@example.com',
      })

      await expect(service.downloadActivityFit({ activityId })).rejects.toThrow(
        'Invalid activityId: expected a positive integer',
      )
      expect(downloadOriginalActivityZip).not.toHaveBeenCalled()
    },
  )

  it.each(['', '   ', undefined])(
    'requires an explicit FIT directory before making a Garmin request (%s)',
    async (fitDownloadDir) => {
      const downloadOriginalActivityZip = jest.fn()
      const service = new GarminToolService(clientWith({
        downloadOriginalActivityZip,
      }), {
        activityDetail: 'compact',
        fitDownloadDir,
        accountUsername: 'runner@example.com',
      } as any)

      await expect(service.downloadActivityFit({ activityId: 42 })).rejects.toThrow(
        'FIT download directory is not configured; set GARMIN_FIT_DOWNLOAD_DIR',
      )
      expect(downloadOriginalActivityZip).not.toHaveBeenCalled()
    },
  )

  it('removes the private ZIP directory when the Garmin download fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-fit-service-failure-test-'))
    let privateDownloadDir = ''
    const downloadOriginalActivityZip = jest.fn(async (
      _activityId: number,
      destinationDir: string,
    ): Promise<string> => {
      privateDownloadDir = destinationDir
      throw new Error('download failed')
    })
    const service = new GarminToolService(clientWith({
      downloadOriginalActivityZip,
    }), {
      activityDetail: 'compact',
      fitDownloadDir: join(root, 'exports'),
      accountUsername: 'runner@example.com',
    })

    try {
      await expect(service.downloadActivityFit({ activityId: 42 }))
        .rejects.toThrow('download failed')
      await expect(stat(privateDownloadDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not turn a completed FIT export into a failure when temp cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garmin-fit-cleanup-test-'))
    let privateDownloadDir = ''
    const downloadOriginalActivityZip = jest.fn(async (
      activityId: number,
      destinationDir: string,
    ) => {
      privateDownloadDir = destinationDir
      const fit = Buffer.from([
        0x0E, 0x10, 0xD9, 0x07, 0x00, 0x00, 0x00, 0x00,
        0x2E, 0x46, 0x49, 0x54, 0x91, 0x33, 0x00, 0x00,
      ])
      const zipPath = join(destinationDir, `${activityId}.zip`)
      await writeFile(zipPath, zipSync({ 'activity.fit': fit }))
      return zipPath
    })
    const service = new GarminToolService(clientWith({
      downloadOriginalActivityZip,
    }), {
      activityDetail: 'compact',
      fitDownloadDir: join(root, 'exports'),
      accountUsername: 'runner@example.com',
    })
    mockedRm.mockImplementation(async (
      path,
      options,
    ) => {
      if (path === privateDownloadDir) throw new Error('simulated cleanup failure')
      return actualRm(path, options)
    })

    try {
      await expect(service.downloadActivityFit({ activityId: 42 })).resolves.toEqual({
        success: true,
        activityId: 42,
        fileName: '42.fit',
        sizeBytes: 16,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      await expect(stat(join(
        root,
        'exports',
        'GARMIN_FIT_runner@example.com',
        '42.fit',
      ))).resolves.toMatchObject({ size: 16 })
    } finally {
      mockedRm.mockImplementation(actualRm)
      if (privateDownloadDir) {
        await rm(privateDownloadDir, { recursive: true, force: true })
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses defaults when an adapter omits all optional read arguments', async () => {
    const getActivities = jest.fn().mockResolvedValue([])
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect((service as any).getActivities()).resolves.toEqual([])
    expect(getActivities).toHaveBeenCalledWith(0, 5)
  })

  it('formats a single day of step data without wrapping it in an array', async () => {
    const getSteps = jest.fn(async (date: string) => ({
      calendarDate: date,
      totalSteps: 12345,
      stepGoal: 10000,
      totalDistance: 8123,
    }))
    const service = new GarminToolService(clientWith({ getSteps }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getSteps({ startDate: '2026-08-20' })).resolves.toEqual({
      date: '2026-08-20',
      totalSteps: 12345,
      goal: 10000,
      distanceMeters: 8123,
      highlyActiveSeconds: null,
    })
  })

  it('formats a heart-rate date range through the shared service boundary', async () => {
    const getHeartRate = jest.fn(async (date: string) => ({
      calendarDate: date,
      restingHeartRate: 48,
      maxHeartRate: 166,
      minHeartRate: 42,
    }))
    const service = new GarminToolService(clientWith({ getHeartRate }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getHeartRate({
      startDate: '2026-08-19',
      endDate: '2026-08-20',
    })).resolves.toEqual([
      { date: '2026-08-19', restingHR: 48, maxHR: 166, minHR: 42 },
      { date: '2026-08-20', restingHR: 48, maxHR: 166, minHR: 42 },
    ])
  })

  it('formats the real Garmin daily-weight response shape', async () => {
    const getWeight = jest.fn(async () => ({
      startDate: '2026-08-20',
      endDate: '2026-08-20',
      dateWeightList: [{
        calendarDate: '2026-08-20',
        date: 1787184000000,
        weight: 70100,
        bmi: 22.4,
        bodyFat: 15.1,
        muscleMass: 35000,
        bodyWater: 60.2,
        boneMass: 3000,
      }],
      totalAverage: { weight: 70100 },
    }))
    const service = new GarminToolService(clientWith({ getWeight }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getWeight({ startDate: '2026-08-20' })).resolves.toEqual(
      expect.objectContaining({
        date: '2026-08-20',
        weightKg: 70.1,
        bmi: 22.4,
        bodyFatPercentage: 15.1,
      }),
    )
  })

  it('returns the workout library with normalized pagination', async () => {
    const getWorkouts = jest.fn(async () => [{
      workoutId: 'w-1',
      workoutName: 'Threshold',
      sportType: { sportTypeKey: 'running' },
      createdDate: '2026-08-20T08:00:00Z',
    }])
    const service = new GarminToolService(clientWith({ getWorkouts }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getWorkouts({ limit: 0, offset: -3 })).resolves.toEqual([
      expect.objectContaining({ id: 'w-1', name: 'Threshold' }),
    ])
    expect(getWorkouts).toHaveBeenCalledWith(0, 1)
  })

  it('returns running advice without authenticating when recent activities are not requested', async () => {
    const getActivities = jest.fn()
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'explain',
      query: 'threshold',
      language: 'en',
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: false,
      matchedSkills: [expect.objectContaining({ id: 'threshold' })],
      trainingPhilosophies: [expect.objectContaining({ id: 'norwegian_threshold' })],
      totalSkillsInKB: 8,
    }))
    expect(getActivities).not.toHaveBeenCalled()
  })

  it('requires callers to explicitly choose explanation or personalized mode', async () => {
    const getActivities = jest.fn()
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getRunningAdvice({} as any)).rejects.toThrow(
      'mode must be explain or personalized',
    )
    expect(getActivities).not.toHaveBeenCalled()
  })

  it('asks for every required athlete input before personalized advice', async () => {
    const getActivities = jest.fn()
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      language: 'zh-CN',
      includeRecentActivities: true,
    })

    expect(result).toEqual({
      requiresUserInput: true,
      missingFields: [
        'goal',
        'currentPerformance',
        'performanceBasis',
        'trainingBackground',
        'availability',
        'healthConstraints',
        'hasWarningSymptoms',
        'trainingPreference',
        'maxQualitySessionsPerWeek',
        'intensityGuidancePreference',
      ],
      questions: expect.arrayContaining([
        expect.objectContaining({ field: 'goal', question: expect.stringContaining('目标') }),
        expect.objectContaining({
          field: 'currentPerformance',
          question: expect.stringContaining('近期'),
        }),
        expect.objectContaining({
          field: 'trainingPreference',
          question: expect.stringContaining('均匀稳定'),
        }),
        expect.objectContaining({
          field: 'hasWarningSymptoms',
          question: expect.stringContaining('胸部不适'),
        }),
        expect.objectContaining({
          field: 'availability',
          question: expect.stringContaining('力量训练'),
        }),
        expect.objectContaining({
          field: 'intensityGuidancePreference',
          question: expect.stringContaining('配速'),
        }),
      ]),
      instruction: expect.stringContaining('不要生成'),
    })
    expect(getActivities).not.toHaveBeenCalled()
  })

  it('asks only for personalized fields the user has not answered', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      language: 'en',
      goal: '10 km race on 2099-11-01, ideal target 45:00 and minimum acceptable 47:00',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      trainingPreference: 'hard_easy',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'performanceBasis',
      'trainingBackground',
      'availability',
      'healthConstraints',
      'hasWarningSymptoms',
      'maxQualitySessionsPerWeek',
      'intensityGuidancePreference',
    ])
    expect(result.questions).toHaveLength(7)
  })

  it('does not accept an unknown load preference as completed intake', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a half marathon on 2099-11-01',
      currentPerformance: '10 km in 48:00 on 2026-08-01; all-out effort on a flat course in cool weather',
      performanceBasis: 'recent_race',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'all-out-every-day' as any,
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual(['trainingPreference'])
  })

  it('does not treat one-character placeholder blobs as completed intake', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'x',
      currentPerformance: 'x',
      performanceBasis: 'recent_race',
      trainingBackground: 'x',
      availability: 'x',
      healthConstraints: 'x',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'goal',
      'currentPerformance',
      'performanceBasis',
      'trainingBackground',
      'availability',
      'healthConstraints',
    ])
  })

  it('rejects contradictory or fact-free intake placeholders', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: '10K?',
      currentPerformance: 'none',
      performanceBasis: 'recent_race',
      trainingBackground: 'unknown?',
      availability: 'TBD!',
      healthConstraints: 'ok',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'goal',
      'currentPerformance',
      'performanceBasis',
      'trainingBackground',
      'availability',
      'healthConstraints',
    ])
  })

  it('keeps each intake group open until its required details are answered', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Finish a 10 km race in 45:00 on 2099-11-01',
      currentPerformance: '5 km in 23:30 on 2026-08-01; full effort; weather',
      performanceBasis: 'time_trial',
      trainingBackground: 'Running for 2 years; average and peak vary, four days per week, longest run varies, quality work varies, stable load',
      availability: 'Four days per week, 45 minutes each; Monday rest, Sunday long run; road available; strength possible; no doubles',
      healthConstraints: 'No current pain; no injury last year; no relevant disease; sleep stable',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'goal',
      'currentPerformance',
      'performanceBasis',
      'trainingBackground',
      'availability',
      'healthConstraints',
    ])
  })

  it('does not accept unresolved placeholders inside otherwise detailed answers', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: '10 km race on 2099-11-01, ideal 45:00 and minimum TBD',
      currentPerformance: '5 km in 23:30 on 2026-08-01; effort unknown and conditions unknown',
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'goal',
      'currentPerformance',
      'performanceBasis',
    ])
  })

  it('requires a concrete goal and a timed or paced performance benchmark', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: '2099-11-01',
      currentPerformance: '5K on 2026-08-01',
      performanceBasis: 'recent_race',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'goal',
      'currentPerformance',
      'performanceBasis',
    ])
  })

  it('rejects impossible dates while accepting an explicit absence of health constraints', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10K race on 2026-99-99',
      currentPerformance: '5K in 23:30 on 2026-02-30',
      performanceBasis: 'recent_race',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: 'none',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'goal',
      'currentPerformance',
      'performanceBasis',
    ])
  })

  it('rejects a field when an invalid date is hidden beside a valid date', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-02-30; registration opens 2099-01-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual(['goal'])
  })

  it('rejects zero-distance goals and zero-time performance results', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Target 0:00 for a 0 km race on 2099-11-01',
      currentPerformance: '0 km in 0:00 on 2026-08-01',
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: 'none',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'goal',
      'currentPerformance',
      'performanceBasis',
    ])
  })

  it('rejects past goal dates, future benchmarks, and negative measurements', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: '10 km race on 2020-11-01, ideal -45:00 and minimum -47:00',
      currentPerformance: '-5 km in -23:30 on 2099-08-01; all-out effort on a flat course in cool weather',
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: 'none',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'goal',
      'currentPerformance',
      'performanceBasis',
    ])
  })

  it('accepts common concise equivalents for complete training constraints', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: 'Started running 2 years ago; last 8 weeks avg 30 km and max 36 km, 4x/week, longest run 12 km, one tempo session, stable load with no breaks',
      availability: '4x/week, 45 min each; Monday off, Sunday long run; road available; 30 min strength; no doubles',
      healthConstraints: 'No current pain; no injury in the last 12 months; no relevant condition or meds; sleep, stress, and recovery stable',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: false,
      mode: 'personalized',
    }))
  })

  it('does not let values from one intake subfield satisfy another', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: 'Running history; average 30 km and peak 36 km per week, four days per week, longest run 12 km, one tempo session, stable load with no breaks',
      availability: 'Four days per week; Monday rest, Sunday long run; road available; 30 minutes strength; no doubles',
      healthConstraints: 'Currently taking pain medication; no injury in the past year; no relevant disease or medication; sleep, stress, and recovery stable',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'trainingBackground',
      'availability',
      'healthConstraints',
    ])
  })

  it('rejects negative availability and a stale performance as current ability', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: '5 km in 23:30 on 2010-08-01; all-out effort on a flat course in cool weather',
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: '-4 days per week, -45 minutes each; Monday rest day and Sunday long-run day; roads available; no strength; no doubles',
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual([
      'currentPerformance',
      'performanceBasis',
      'availability',
    ])
  })

  it.each([
    'Running for 2 years; over the last 8 weeks average -30 km and peak 36 km per week, four days per week, longest run 12 km, one threshold session, and stable load with no breaks',
    'Running for 2 years; over the last 8 weeks average 30 km and peak -36 km per week, four days per week, longest run 12 km, one threshold session, and stable load with no breaks',
  ])('does not borrow an adjacent positive load for a negative labeled load', async (trainingBackground) => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual(['trainingBackground'])
  })

  it('rejects negative strength time instead of treating it as availability', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: 'Four days per week, 45 minutes each; Monday rest, Sunday long run; road available; -30 minutes strength; no doubles',
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual(['availability'])
  })

  it.each([
    'Strength training four days per week, 60 minutes each; Monday rest day and Sunday long-run day; roads available; no additional strength time; no doubles',
    'Cycling four days per week, 60 minutes each; Monday rest day and Sunday long-run day; roads available; no strength; no doubles',
    'Swimming four days per week, 60 minutes each; Monday rest day and Sunday long-run day; roads available; no strength; no doubles',
  ])('does not mistake other training frequency and duration for running availability', async (availability) => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual(['availability'])
  })

  it('accepts equivalent complete intake phrasing without borrowing facts', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: '5 km in 23:30 on 2026-08-01; all-out effort on a flat course in cool weather; an older PB was on 2010-08-01',
      performanceBasis: 'time_trial',
      trainingBackground: 'Running history: 2 years; average 30 km and peak 36 km per week, four runs a week, longest run 12 km, one tempo session, stable load with no breaks',
      availability: 'Four runs a week; Monday 45 min, Wednesday 60 min, Friday 45 min, Sunday 120 min; Tuesday rest day and Sunday long-run day; road available; 30 minutes strength; no doubles',
      healthConstraints: 'No current injuries; no injury in the past year; no relevant disease or medication; sleep, stress, and recovery stable',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: false,
      mode: 'personalized',
    }))
  })

  it('does not use an unrelated recent date to freshen an old result', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: '5 km in 23:30 on 2010-08-01, resumed easy running on 2026-08-01, all-out effort on a flat course in cool weather',
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    if (!result.requiresUserInput) throw new Error('expected an intake response')
    expect(result.missingFields).toEqual(['currentPerformance', 'performanceBasis'])
  })

  it('accepts current pain or injury status with natural reversed word order', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: 'No pain currently; no injury in the past year; no relevant disease or medication; sleep, stress, and recovery stable',
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: false,
      mode: 'personalized',
    }))
  })

  it('returns compact philosophies only after personalized intake is complete', async () => {
    const getActivities = jest.fn().mockResolvedValue([])
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      language: 'zh-CN',
      goal: '2099-11-01 参加 10 公里比赛，理想目标 45 分，最低可接受目标 47 分',
      currentPerformance: COMPLETE_PERFORMANCE_ZH,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_ZH,
      availability: COMPLETE_AVAILABILITY_ZH,
      healthConstraints: COMPLETE_HEALTH_ZH,
      hasWarningSymptoms: false,
      trainingPreference: 'hard_easy',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
      includeRecentActivities: true,
    })

    if (result.requiresUserInput || 'safetyStop' in result) {
      throw new Error('expected personalized advice material')
    }
    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: false,
      athleteContext: expect.objectContaining({
        goal: expect.stringContaining('10 公里'),
        currentPerformance: expect.stringContaining('23:30'),
        trainingPreference: 'hard_easy',
        maxQualitySessionsPerWeek: 1,
        intensityGuidancePreference: 'mixed',
      }),
      trainingPhilosophies: expect.arrayContaining([
        expect.objectContaining({ id: 'polarized' }),
        expect.objectContaining({ id: 'daniels' }),
      ]),
      planningInstructions: expect.arrayContaining([
        expect.stringContaining('当前成绩'),
        expect.stringContaining('双阈值'),
        expect.stringContaining('健康警示症状'),
        expect.stringContaining('周总量或总时长范围'),
        expect.stringContaining('热身和冷身'),
        expect.stringContaining('疼痛、疾病、睡眠不足、异常疲劳、天气或比赛'),
        expect.stringContaining('有限变量'),
        expect.stringContaining('完成率、RPE、疼痛、睡眠'),
        expect.stringContaining('比赛或计时测试'),
        expect.stringContaining('分区体系'),
        expect.stringContaining('不能混用'),
      ]),
      evidenceLegend: expect.objectContaining({
        system_principle: expect.any(String),
        research_evidence: expect.any(String),
        application_inference: expect.any(String),
      }),
    }))
    expect(result.trainingPhilosophies[0]).toEqual(expect.objectContaining({
      id: 'polarized',
    }))
    expect(getActivities).toHaveBeenCalledWith(0, 5)
  })

  it('adds only recent running activities when personalized advice is requested', async () => {
    const getActivities = jest.fn(async () => [
      {
        activityId: 1,
        activityName: 'Ride',
        activityType: { typeKey: 'cycling' },
      },
      {
        activityId: 2,
        activityName: 'Trail Run',
        activityType: { typeKey: 'trail_running' },
        distance: 10000,
        duration: 3600,
      },
    ])
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Finish a half marathon on 2099-11-01',
      currentPerformance: '10 km in 50:00 on 2026-08-01; all-out effort on a rolling course in warm weather',
      performanceBasis: 'recent_race',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'pace',
      includeRecentActivities: true,
    })

    if (result.requiresUserInput || 'safetyStop' in result) {
      throw new Error('expected personalized advice material')
    }
    expect(result.recentRunningActivities).toEqual([
      expect.objectContaining({ id: 2, type: 'trail_running' }),
    ])
  })

  it('never fetches Garmin activities in explanation mode', async () => {
    const getActivities = jest.fn()
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'explain',
      query: 'polarized',
      includeRecentActivities: true,
    })

    expect(result.requiresUserInput).toBe(false)
    expect(getActivities).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('recentRunningActivities')
  })

  it('keeps running knowledge available when optional recent activities fail', async () => {
    const getActivities = jest.fn().mockRejectedValue(new Error(
      'Authorization: Bearer secret-token private@example.test',
    ))
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getRunningAdvice({
      mode: 'personalized',
      query: 'threshold',
      goal: 'Finish a half marathon on 2099-11-01',
      currentPerformance: '10 km in 50:00 on 2026-08-01; all-out effort on a rolling course in warm weather',
      performanceBasis: 'recent_race',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'mixed',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
      includeRecentActivities: true,
    })).resolves.toEqual(expect.objectContaining({
      matchedSkills: expect.any(Array),
      recentRunningActivities: 'Recent Garmin activities are temporarily unavailable.',
    }))
  })

  it('returns a safety stop without workout material for warning symptoms', async () => {
    const getActivities = jest.fn()
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      language: 'zh-CN',
      goal: '2099-11-01 参加 10 公里比赛',
      currentPerformance: '2026-08-01 参加 5 公里计时跑，成绩 23:30',
      performanceBasis: 'time_trial',
      trainingBackground: '近 8 周每周 35 公里，每周跑 4 天',
      availability: '每周可跑 4 天，周日长跑',
      healthConstraints: '跑步时出现胸部不适和眩晕',
      hasWarningSymptoms: true,
      trainingPreference: 'hard_easy',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
      includeRecentActivities: true,
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: false,
      mode: 'personalized',
      safetyStop: true,
      instruction: expect.stringContaining('医疗专业人员'),
    }))
    expect(result).not.toHaveProperty('matchedSkills')
    expect(result).not.toHaveProperty('trainingPhilosophies')
    expect(getActivities).not.toHaveBeenCalled()
  })

  it('requires clarification when warning-symptom text contradicts a false flag', async () => {
    const getActivities = jest.fn()
    const service = new GarminToolService(clientWith({ getActivities }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      language: 'en',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: 'I currently have chest discomfort while running',
      hasWarningSymptoms: false,
      trainingPreference: 'hard_easy',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'mixed',
      includeRecentActivities: true,
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: true,
      missingFields: ['healthConstraints', 'hasWarningSymptoms'],
      questions: expect.arrayContaining([
        expect.objectContaining({ field: 'healthConstraints' }),
        expect.objectContaining({
          field: 'hasWarningSymptoms',
          question: expect.stringContaining('conflict'),
        }),
      ]),
    }))
    expect(result).not.toHaveProperty('matchedSkills')
    expect(getActivities).not.toHaveBeenCalled()
  })

  it('asks to disambiguate a negated warning-symptom list instead of diagnosing it', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      language: 'en',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: 'No current chest discomfort, unusual breathlessness, fainting, dizziness, or palpitations; no injury in the past year; no relevant disease or medication; sleep, stress, and recovery are stable',
      hasWarningSymptoms: false,
      trainingPreference: 'steady',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: true,
      missingFields: ['healthConstraints', 'hasWarningSymptoms'],
    }))
    expect(result).not.toHaveProperty('safetyStop')
  })

  it('does not allow cross-sentence warning text to reach planning material', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      language: 'en',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints: 'No chest pain. Currently dizzy.',
      hasWarningSymptoms: false,
      trainingPreference: 'steady',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: true,
      missingFields: ['healthConstraints', 'hasWarningSymptoms'],
    }))
    expect(result).not.toHaveProperty('matchedSkills')
  })

  it.each([
    'I feel lightheaded during easy running',
    'I passed out after the last session',
    'I lost consciousness after an easy run',
    'I had a loss of consciousness after an easy run',
    'My heart races during easy runs',
    'I feel pressure in my chest during easy runs',
    '轻松跑时曾经晕倒',
    '跑步时曾经昏倒',
    '跑步时曾经昏厥',
    '跑步时曾经失去意识',
    '轻松跑时胸口有压迫感',
    '轻松跑时胸口疼',
    '跑步时会心慌',
  ])('recognizes common warning-symptom wording: %s', async (healthConstraints) => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: COMPLETE_PERFORMANCE_EN,
      performanceBasis: 'time_trial',
      trainingBackground: COMPLETE_TRAINING_BACKGROUND_EN,
      availability: COMPLETE_AVAILABILITY_EN,
      healthConstraints,
      hasWarningSymptoms: false,
      trainingPreference: 'steady',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    expect(result).toEqual(expect.objectContaining({
      requiresUserInput: true,
      missingFields: ['healthConstraints', 'hasWarningSymptoms'],
    }))
    expect(result).not.toHaveProperty('matchedSkills')
  })

  it('does not invent exact quality paces without a recent benchmark', async () => {
    const service = new GarminToolService(clientWith(), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const result = await service.getRunningAdvice({
      mode: 'personalized',
      language: 'en',
      goal: 'Complete a 10 km race on 2099-11-01',
      currentPerformance: 'No trustworthy recent benchmark is available',
      performanceBasis: 'no_recent_benchmark',
      trainingBackground: 'Running for 1 year; over the last 8 weeks average 15 km and peak 18 km per week, three days per week, longest run 7 km, no quality sessions, after one recent break without an abrupt load change',
      availability: 'Three days per week, 45 minutes each; Monday rest day and Sunday long-run day; roads available; 20 minutes of strength training; double days unavailable',
      healthConstraints: COMPLETE_HEALTH_EN,
      hasWarningSymptoms: false,
      trainingPreference: 'steady',
      maxQualitySessionsPerWeek: 1,
      intensityGuidancePreference: 'rpe',
    })

    if (result.requiresUserInput || 'safetyStop' in result) {
      throw new Error('expected personalized advice material')
    }
    expect(result.planningInstructions?.[0]).toContain('no trustworthy recent benchmark')
    expect(result.planningInstructions?.[0]).toContain('do not prescribe exact')
  })

  it('returns an allowlisted profile summary without location or privacy settings', async () => {
    const getUserProfile = jest.fn(async () => ({
      displayName: 'runner42',
      fullName: 'Runner',
      profileImageUrlMedium: 'https://example.com/avatar.png',
      primaryActivity: 'running',
      location: 'Private Home',
      profileVisibility: 'private',
      garminGUID: 'secret-guid',
    }))
    const service = new GarminToolService(clientWith({ getUserProfile }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.getProfile()).resolves.toEqual({
      displayName: 'runner42',
      fullName: 'Runner',
      profileImageUrl: 'https://example.com/avatar.png',
      primaryActivity: 'running',
    })
  })

  it('previews a valid workout without writing until explicitly confirmed', async () => {
    const addWorkout = jest.fn()
    const service = new GarminToolService(clientWith({ addWorkout }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.createWorkout({
      name: 'Easy Run',
      steps: [{
        type: 'warmup',
        endCondition: 'time',
        endValue: 600,
      }],
    })).resolves.toEqual(expect.objectContaining({
      requiresConfirmation: true,
      workoutName: 'Easy Run',
      stepCount: 1,
    }))
    expect(addWorkout).not.toHaveBeenCalled()
  })

  it('creates a workout only when the same call is explicitly confirmed', async () => {
    const addWorkout = jest.fn(async () => ({ workoutId: 'new-42' }))
    const service = new GarminToolService(clientWith({ addWorkout }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    const definition = {
      name: 'Easy Run',
      steps: [{
        type: 'warmup' as const,
        endCondition: 'time' as const,
        endValue: 600,
      }],
    }
    const preview = await service.createWorkout(definition)

    await expect(service.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: preview.confirmationId as string,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      workoutId: 'new-42',
    }))
    expect(addWorkout).toHaveBeenCalledTimes(1)
  })

  it('rejects confirmed=true unless the same service issued a matching preview', async () => {
    const addWorkout = jest.fn()
    const service = new GarminToolService(clientWith({ addWorkout }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })

    await expect(service.createWorkout({
      name: 'Bypass attempt',
      confirmed: true,
      confirmationId: 'not-issued-by-preview',
      steps: [{
        type: 'warmup',
        endCondition: 'time',
        endValue: 600,
      }],
    })).rejects.toThrow('Invalid workout confirmation')
    expect(addWorkout).not.toHaveBeenCalled()
  })

  it('never treats truthy non-boolean confirmation values as approval', async () => {
    const addWorkout = jest.fn()
    const service = new GarminToolService(clientWith({ addWorkout }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })
    const definition = {
      name: 'Type-confusion attempt',
      steps: [{ type: 'warmup' as const, endCondition: 'time' as const, endValue: 600 }],
    }
    const preview = await service.createWorkout(definition)

    await expect(service.createWorkout({
      ...definition,
      confirmed: 'false' as unknown as boolean,
      confirmationId: preview.confirmationId as string,
    })).resolves.toEqual(expect.objectContaining({ requiresConfirmation: true }))
    expect(addWorkout).not.toHaveBeenCalled()
  })

  it('binds a preview confirmation to the exact workout definition', async () => {
    const addWorkout = jest.fn()
    const service = new GarminToolService(clientWith({ addWorkout }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })
    const preview = await service.createWorkout({
      name: 'Easy Run',
      steps: [{ type: 'warmup', endCondition: 'time', endValue: 600 }],
    })

    await expect(service.createWorkout({
      name: 'Harder Run',
      confirmed: true,
      confirmationId: preview.confirmationId as string,
      steps: [{ type: 'warmup', endCondition: 'time', endValue: 1200 }],
    })).rejects.toThrow('Invalid workout confirmation')
    expect(addWorkout).not.toHaveBeenCalled()
  })

  it('expires workout confirmations after ten minutes', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const addWorkout = jest.fn()
    const service = new GarminToolService(clientWith({ addWorkout }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })
    const definition = {
      name: 'Expiring preview',
      steps: [{ type: 'warmup' as const, endCondition: 'time' as const, endValue: 600 }],
    }
    const preview = await service.createWorkout(definition)
    now.mockReturnValue(601_001)

    await expect(service.createWorkout({
      ...definition,
      confirmed: true,
      confirmationId: preview.confirmationId as string,
    })).rejects.toThrow('Invalid workout confirmation')
    expect(addWorkout).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('does not allow a successful confirmation to be replayed', async () => {
    const addWorkout = jest.fn().mockResolvedValue({ workoutId: 'one-write' })
    const service = new GarminToolService(clientWith({ addWorkout }), {
      activityDetail: 'compact',
      fitDownloadDir: '/tmp/garmin-fit-service-test-output',
      accountUsername: 'runner@example.com',
    })
    const definition = {
      name: 'One-time preview',
      steps: [{ type: 'warmup' as const, endCondition: 'time' as const, endValue: 600 }],
    }
    const preview = await service.createWorkout(definition)
    const confirmed = {
      ...definition,
      confirmed: true,
      confirmationId: preview.confirmationId as string,
    }

    await expect(service.createWorkout(confirmed)).resolves.toEqual(
      expect.objectContaining({ success: true }),
    )
    await expect(service.createWorkout(confirmed)).rejects.toThrow(
      'Invalid workout confirmation',
    )
    expect(addWorkout).toHaveBeenCalledTimes(1)
  })
})
