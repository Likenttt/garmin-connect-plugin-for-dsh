import {
  RUNNING_SKILLS,
  TRAINING_PHILOSOPHIES,
  findSkills,
  findTrainingPhilosophies,
  formatSkillCard,
  formatSkillSummary,
  formatTrainingPhilosophy,
} from '../src/knowledge/running-skills'

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

  it('uses controlled effort guidance instead of maximal or goal-derived prescriptions', () => {
    const byId = Object.fromEntries(RUNNING_SKILLS.map(skill => [skill.id, skill]))
    expect(byId.easy_run.hrZone).toContain('Conversational')
    expect(byId.threshold.hrZone).toContain('RPE')
    expect(byId.intervals.hrZone).toContain('HR lags')
    expect(byId.strides.hrZone).toContain('never all-out')
    expect(byId.marathon_pace.whyEn).toContain('current ability')

    const text = JSON.stringify(RUNNING_SKILLS)
    expect(text).not.toContain('98%-100%')
    expect(text).not.toContain('dangerous HR drops')
    expect(text).not.toContain('forces a forefoot landing')
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

  it('returns no cards for an unknown query instead of flooding context', () => {
    expect(findSkills('zzz-no-such-keyword')).toEqual([])
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
      evidenceClassification: {
        why: 'application_inference',
        howToPractice: 'application_inference',
        commonMistakes: 'application_inference',
      },
    })
  })

  it('formats one-language explanation cards to keep tool context compact', () => {
    const card = formatSkillCard(RUNNING_SKILLS[0], 'zh-CN')
    expect(card).toEqual({
      id: 'easy_run',
      name: RUNNING_SKILLS[0].nameCn,
      tagline: RUNNING_SKILLS[0].taglineCn,
      heartRateZone: RUNNING_SKILLS[0].hrZone,
      why: RUNNING_SKILLS[0].whyCn,
      howToPractice: RUNNING_SKILLS[0].howCn,
      commonMistakes: RUNNING_SKILLS[0].pitfallsCn,
      evidenceClassification: {
        why: 'application_inference',
        howToPractice: 'application_inference',
        commonMistakes: 'application_inference',
      },
    })
    expect(JSON.stringify(card)).not.toContain(RUNNING_SKILLS[0].whyEn)
  })

  it('classifies evidence on compact workout summaries used for planning', () => {
    expect(formatSkillSummary(RUNNING_SKILLS[0], 'en')).toEqual(expect.objectContaining({
      evidenceClassification: {
        purpose: 'application_inference',
        intensity: 'application_inference',
        guardrail: 'application_inference',
      },
    }))
  })

  it('keeps four concise training philosophies separate from workout types', () => {
    expect(TRAINING_PHILOSOPHIES.map(philosophy => philosophy.id)).toEqual([
      'hansons',
      'daniels',
      'norwegian_threshold',
      'polarized',
    ])
    for (const philosophy of TRAINING_PHILOSOPHIES) {
      expect(philosophy.principleCn.length).toBeGreaterThan(0)
      expect(philosophy.principleEn.length).toBeGreaterThan(0)
      expect(philosophy.guardrailCn.length).toBeGreaterThan(0)
      expect(philosophy.guardrailEn.length).toBeGreaterThan(0)
      expect(['system_principle', 'research_evidence'])
        .toContain(philosophy.principleEvidence)
      expect(philosophy.bestForEvidence).toBe('application_inference')
      expect(philosophy.guardrailEvidence).toBe('application_inference')
      expect(philosophy.keywords.length).toBeGreaterThan(0)
    }
  })

  it.each([
    ['汉森', 'hansons'],
    ['Daniels', 'daniels'],
    ['双阈值', 'norwegian_threshold'],
    ['Norwegian', 'norwegian_threshold'],
    ['极化', 'polarized'],
    ['polarized', 'polarized'],
  ])('matches philosophy query %s', (query, expectedId) => {
    expect(findTrainingPhilosophies(query).map(item => item.id)).toContain(expectedId)
  })

  it('formats only the requested language for compact model context', () => {
    const philosophy = TRAINING_PHILOSOPHIES[0]
    const card = formatTrainingPhilosophy(philosophy, 'zh-CN')

    expect(card).toEqual({
      id: 'hansons',
      name: philosophy.nameCn,
      loadPattern: 'steady',
      principle: philosophy.principleCn,
      bestFor: philosophy.bestForCn,
      guardrail: philosophy.guardrailCn,
      evidenceClassification: {
        principle: philosophy.principleEvidence,
        bestFor: 'application_inference',
        guardrail: 'application_inference',
      },
    })
    expect(JSON.stringify(card)).not.toContain(philosophy.principleEn)
  })
})
