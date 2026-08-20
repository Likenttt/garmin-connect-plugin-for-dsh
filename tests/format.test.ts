import { formatActivity, formatSleep, formatSteps, formatHeartRate, formatWeight, formatWorkout, formatProfile } from '../src/utils/format'

describe('Format Utils', () => {
  describe('formatActivity', () => {
    it('should return a compact curated subset by default', () => {
      const raw = {
        activityId: 123,
        activityName: 'Morning Run',
        activityType: { typeKey: 'running' },
        eventType: { typeKey: 'race' },
        startTimeLocal: '2023-10-01T07:00:00',
        distance: 5000.123,
        duration: 1800,
        averageHR: 150,
        maxHR: 180,
        calories: 300,
        elevationGain: 50.5,
        averageRunningCadenceInStepsPerMinute: 165,
        steps: 4321
      }

      const formatted = formatActivity(raw)
      expect(formatted).toEqual({
        id: 123,
        name: 'Morning Run',
        type: 'running',
        startTime: '2023-10-01T07:00:00',
        distanceMeters: 5000.12,
        durationSeconds: 1800,
        averageHeartRate: 150,
        maxHeartRate: 180,
        averagePaceMinPerKm: 6,
        calories: 300,
        elevationGainMeters: 50.5,
        averageCadence: 165
      })
      // compact mode filters out raw passthrough fields
      expect(formatted.steps).toBeUndefined()
      expect(formatted.eventType).toBeUndefined()
    })

    it('should return expanded raw fitness fields with detail="full"', () => {
      const raw = {
        activityId: 123,
        activityName: 'Morning Run',
        activityType: { typeKey: 'running' },
        eventType: { typeKey: 'race' },
        startTimeLocal: '2023-10-01T07:00:00',
        startTimeGMT: '2023-10-01T07:00:00Z',
        distance: 5000.123,
        duration: 1800,
        elapsedDuration: 1900,
        movingDuration: 1780,
        averageSpeed: 2.78,
        maxSpeed: 5.5,
        averageHR: 150,
        maxHR: 180,
        calories: 300,
        elevationGain: 50.5,
        elevationLoss: 12.3,
        averageRunningCadenceInStepsPerMinute: 165,
        steps: 4321,
        locationName: 'Riverside'
      }

      const formatted = formatActivity(raw, 'full')
      expect(formatted).toMatchObject({
        id: 123,
        name: 'Morning Run',
        type: 'running',
        eventType: 'race',
        startTime: '2023-10-01T07:00:00',
        distanceMeters: 5000.12,
        durationSeconds: 1800,
        elapsedDurationSeconds: 1900,
        movingDurationSeconds: 1780,
        averageSpeedMps: 2.78,
        maxSpeedMps: 5.5,
        averageHeartRate: 150,
        maxHeartRate: 180,
        calories: 300,
        elevationGainMeters: 50.5,
        elevationLossMeters: 12.3,
        averageCadence: 165,
        steps: 4321,
        locationName: 'Riverside'
      })
      // Non-sensitive raw keys survive alongside normalized ones.
      expect(formatted.distance).toBe(5000.123)
      expect(formatted.averageHR).toBe(150)
      expect(formatted.activityName).toBe('Morning Run')
    })

    it('removes credential and social-account fields from full activity output', () => {
      const formatted = formatActivity({
        activityId: 123,
        startLatitude: 31.23,
        locationName: 'Riverside',
        ownerId: 42,
        ownerFullName: 'Private Runner',
        activityLikeAuthors: [{ displayName: 'Friend' }],
        nested: {
          access_token: 'SECRET',
          trainingMetric: 7,
        },
      }, 'full')

      expect(formatted.startLatitude).toBe(31.23)
      expect(formatted.locationName).toBe('Riverside')
      expect(formatted.ownerId).toBeUndefined()
      expect(formatted.ownerFullName).toBeUndefined()
      expect(formatted.activityLikeAuthors).toBeUndefined()
      expect(formatted.nested).toEqual({ trainingMetric: 7 })
      expect(JSON.stringify(formatted)).not.toContain('SECRET')
    })

    it('should handle null/missing data', () => {
      const raw = {}
      const formatted = formatActivity(raw)
      expect(formatted).toMatchObject({
        id: '',
        name: 'Unnamed',
        type: 'unknown',
        distanceMeters: 0,
        durationSeconds: 0,
        averagePaceMinPerKm: null,
      })
    })
  })

  describe('formatSleep', () => {
    it('should extract sleep score and hours', () => {
      const raw = {
        dailySleepDTO: {
          calendarDate: '2023-10-01',
          sleepTimeSeconds: 28800, // 8 hours
          deepSleepSeconds: 7200,  // 2 hours
          sleepScores: {
            overall: { value: 85 }
          }
        }
      }
      const formatted = formatSleep(raw)
      expect(formatted.sleepScore).toBe(85)
      expect(formatted.sleepDurationHours).toBe(8)
      expect(formatted.deepSleepHours).toBe(2)
      expect(formatted.remSleepHours).toBe(null) // missing
    })
  })

  describe('formatSteps', () => {
    it('normalizes the numeric total returned by garmin-connect 1.6.x', () => {
      expect(formatSteps(12_345, '2026-08-20')).toEqual({
        date: '2026-08-20',
        totalSteps: 12_345,
        goal: null,
        distanceMeters: null,
        highlyActiveSeconds: null,
      })
    })
  })

  describe('formatWeight', () => {
    it('formats the daily envelope returned by garmin-connect 1.6.x', () => {
      const formatted = formatWeight({
        startDate: '2026-08-20',
        endDate: '2026-08-20',
        dateWeightList: [
          {
            calendarDate: '2026-08-20',
            weight: 70_500,
            bmi: 22.7,
            bodyFat: 15.5,
            muscleMass: 35_200,
            bodyWater: 60.1,
            boneMass: 3_100,
          },
        ],
        totalAverage: {
          weight: 70_250,
        },
      })

      expect(formatted).toEqual({
        date: '2026-08-20',
        weightKg: 70.5,
        bmi: 22.7,
        bodyFatPercentage: 15.5,
        muscleMassKg: 35.2,
        waterPercentage: 60.1,
        boneMassKg: 3.1,
      })
    })

    it('should format weight data correctly', () => {
      const raw = {
        date: 1696118400000, // 2023-10-01 (approx)
        weight: 70000,       // 70kg in grams
        bmi: 22.5,
        bodyFat: 15.2,
        muscleMass: 35000,   // 35kg
        bodyWater: 60.5,
        boneMass: 3000       // 3kg
      }
      const formatted = formatWeight(raw)
      expect(formatted.weightKg).toBe(70)
      expect(formatted.bmi).toBe(22.5)
      expect(formatted.bodyFatPercentage).toBe(15.2)
      expect(formatted.muscleMassKg).toBe(35)
      expect(formatted.waterPercentage).toBe(60.5)
      expect(formatted.boneMassKg).toBe(3)
      expect(formatted.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  describe('formatProfile', () => {
    it('returns only the profile fields safe for tool output', () => {
      expect(formatProfile({
        displayName: 'runner42',
        fullName: 'Ada Runner',
        profileImageUrlMedium: 'https://example.test/avatar-medium.png',
        profileImageUrlLarge: 'https://example.test/avatar-large.png',
        primaryActivity: 'running',
        location: 'Private Home',
        facebookUrl: 'https://social.example/private',
        profileVisibility: 'private',
        garminGUID: 'secret-guid',
      })).toEqual({
        displayName: 'runner42',
        fullName: 'Ada Runner',
        profileImageUrl: 'https://example.test/avatar-medium.png',
        primaryActivity: 'running',
      })
    })
  })

  describe('formatWorkout', () => {
    it('should format workout calendar correctly', () => {
      const raw = {
        workoutId: 'w-123',
        workoutName: 'Evening Run',
        description: 'Recovery run',
        sportType: { sportTypeKey: 'running' },
        createdDate: '2023-10-01T08:00:00Z',
        estimatedDurationInSecs: 1800,
        estimatedDistanceInMeters: 5000
      }
      const formatted = formatWorkout(raw)
      expect(formatted.id).toBe('w-123')
      expect(formatted.name).toBe('Evening Run')
      expect(formatted.sportType).toBe('running')
      expect(formatted.estimatedDurationMins).toBe(30)
      expect(formatted.estimatedDistanceMeters).toBe(5000)
    })
  })
})
