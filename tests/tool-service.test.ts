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

    const result = await service.getRunningAdvice({ query: 'threshold' })

    expect(result).toEqual(expect.objectContaining({
      matchedSkills: [expect.objectContaining({ id: 'threshold' })],
      totalSkillsInKB: 8,
    }))
    expect(getActivities).not.toHaveBeenCalled()
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

    const result = await service.getRunningAdvice({ includeRecentActivities: true })

    expect(result.recentRunningActivities).toEqual([
      expect.objectContaining({ id: 2, type: 'trail_running' }),
    ])
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
      query: 'threshold',
      includeRecentActivities: true,
    })).resolves.toEqual(expect.objectContaining({
      matchedSkills: expect.any(Array),
      recentRunningActivities: 'Recent Garmin activities are temporarily unavailable.',
    }))
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
