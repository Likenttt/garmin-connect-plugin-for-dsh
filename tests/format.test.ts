import { formatActivity, formatSleep, formatSteps, formatHeartRate, formatWeight, formatWorkout } from '../src/utils/format'

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

    it('should return every raw field with detail="full"', () => {
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
      // no field is filtered — raw keys survive alongside normalized ones
      expect(formatted.distance).toBe(5000.123)
      expect(formatted.averageHR).toBe(150)
      expect(formatted.activityName).toBe('Morning Run')
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

  describe('formatWeight', () => {
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
