import { RUNNING_SKILLS, findSkills, formatSkillCard } from '../src/knowledge/running-skills'

const REQUIRED_FIELDS = [
  'id',
  'nameCn',
  'nameEn',
  'taglineCn',
  'taglineEn',
  'hrZone',
  'whyCn',
  'whyEn',
  'howCn',
  'howEn',
  'pitfallsCn',
  'pitfallsEn',
  'keywords',
] as const

describe('Running Skills Knowledge Base', () => {
  it('should contain exactly 8 skills with unique ids', () => {
    expect(RUNNING_SKILLS).toHaveLength(8)
    const ids = RUNNING_SKILLS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z_]+$/)
    }
  })

  it('should have every required field populated', () => {
    for (const skill of RUNNING_SKILLS) {
      for (const field of REQUIRED_FIELDS) {
        const value = skill[field]
        if (typeof value === 'string') {
          expect(value.trim().length).toBeGreaterThan(0)
        } else {
          expect(Array.isArray(value) && value.length > 0).toBe(true)
        }
      }
    }
  })

  it('should match skills by Chinese, English, and keywords', () => {
    expect(findSkills('间歇').map(s => s.id)).toContain('intervals')
    expect(findSkills('threshold').map(s => s.id)).toContain('threshold')
    expect(findSkills('坡道').map(s => s.id)).toContain('hill_repeats')
  })

  it('should return all skills for empty query or "all"', () => {
    expect(findSkills()).toHaveLength(8)
    expect(findSkills('')).toHaveLength(8)
    expect(findSkills('all')).toHaveLength(8)
  })

  it('should fall back to all skills when nothing matches', () => {
    expect(findSkills('zzz-no-such-keyword')).toHaveLength(8)
  })

  it('should format a bilingual coaching card', () => {
    const card = formatSkillCard(RUNNING_SKILLS[0])
    expect(card).toMatchObject({
      id: expect.any(String),
      name: expect.stringContaining('/'),
      heartRateZone: expect.any(String),
      why: { zh: expect.any(String), en: expect.any(String) },
      howToPractice: { zh: expect.any(String), en: expect.any(String) },
      commonMistakes: { zh: expect.any(String), en: expect.any(String) },
    })
  })
})
