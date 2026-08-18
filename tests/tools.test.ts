import { getDatesInRange, todayLocal } from '../src/tools/index'

describe('Tools Utils', () => {
  describe('getDatesInRange', () => {
    it('should generate dates correctly for valid range', () => {
      const dates = getDatesInRange('2023-10-01', '2023-10-03')
      expect(dates).toEqual(['2023-10-01', '2023-10-02', '2023-10-03'])
    })

    it('should fallback to start date if range is invalid', () => {
      const dates = getDatesInRange('2023-10-03', '2023-10-01')
      expect(dates).toEqual(['2023-10-03'])
    })

    it('should limit to 30 days maximum', () => {
      const dates = getDatesInRange('2023-01-01', '2023-03-01') // 2 months
      expect(dates.length).toBe(30)
      expect(dates[0]).toBe('2023-01-01')
      expect(dates[29]).toBe('2023-01-30')
    })
  })

  describe('todayLocal', () => {
    it('should return a string in YYYY-MM-DD format', () => {
      const today = todayLocal()
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })
})
