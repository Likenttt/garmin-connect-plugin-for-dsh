/**
 * Running Skills Knowledge Base
 *
 * A structured, bilingual (Chinese + English) knowledge base covering the
 * Eight workout types plus four compact planning philosophies. Personalized
 * advice is gated by the coaching intake in GarminToolService.
 */

export interface RunningSkill {
  /** Unique skill identifier. */
  id: string
  /** Skill name (Chinese). */
  nameCn: string
  /** Skill name (English). */
  nameEn: string
  /** Short one-liner (Chinese). */
  taglineCn: string
  /** Short one-liner (English). */
  taglineEn: string
  /** Effort guidance using talk test, RPE, current performance, and HR caveats. */
  hrZone: string
  /** Plain-language explanation (Chinese). */
  whyCn: string
  /** Plain-language explanation (English). */
  whyEn: string
  /** How to practice (Chinese). */
  howCn: string
  /** How to practice (English). */
  howEn: string
  /** Common mistakes to avoid (Chinese). */
  pitfallsCn: string
  /** Common mistakes to avoid (English). */
  pitfallsEn: string
  /** Related keywords for fuzzy matching. */
  keywords: string[]
}

export type CoachingLanguage = 'zh-CN' | 'en'
export type TrainingLoadPattern = 'steady' | 'mixed' | 'hard_easy' | 'advanced_threshold'
export type EvidenceClassification =
  | 'system_principle'
  | 'research_evidence'
  | 'application_inference'

const WORKOUT_CARD_EVIDENCE = {
  why: 'application_inference',
  howToPractice: 'application_inference',
  commonMistakes: 'application_inference',
} as const satisfies Record<string, EvidenceClassification>

const WORKOUT_SUMMARY_EVIDENCE = {
  purpose: 'application_inference',
  intensity: 'application_inference',
  guardrail: 'application_inference',
} as const satisfies Record<string, EvidenceClassification>

/** A compact training-system card, deliberately separate from workout types. */
export interface TrainingPhilosophy {
  id: 'hansons' | 'daniels' | 'norwegian_threshold' | 'polarized'
  nameCn: string
  nameEn: string
  loadPattern: TrainingLoadPattern
  principleCn: string
  principleEn: string
  bestForCn: string
  bestForEn: string
  guardrailCn: string
  guardrailEn: string
  principleEvidence: Exclude<EvidenceClassification, 'application_inference'>
  bestForEvidence: Extract<EvidenceClassification, 'application_inference'>
  guardrailEvidence: Extract<EvidenceClassification, 'application_inference'>
  keywords: string[]
}

export const RUNNING_SKILLS: RunningSkill[] = [
  {
    id: 'easy_run',
    nameCn: '轻松跑（Easy Run）',
    nameEn: 'Easy Run',
    taglineCn: '用真正轻松的强度建立有氧基础',
    taglineEn: 'Build aerobic consistency at a genuinely easy effort',
    hrZone: 'Conversational; below the first threshold (about RPE 2–4/10)',
    whyCn:
      '轻松跑用较低的恢复成本积累有氧训练时间，并让肌肉、肌腱和骨骼逐步适应跑步负荷。' +
      '它也是大多数训练周的主体和质量课之间的恢复手段。',
    whyEn:
      'Easy running accumulates aerobic work at a low recovery cost while muscles, tendons, ' +
      'and bones adapt gradually. It should form the bulk of most weeks and support recovery between quality sessions.',
    howCn:
      '以完整句子交谈和 RPE 2–4/10 为主要锚点；天气、坡度或疲劳增加时主动放慢，必要时跑走结合。',
    howEn:
      'Use full-sentence conversation and RPE 2–4/10 as primary anchors. Slow down for heat, hills, or fatigue, and use run-walk if needed.',
    pitfallsCn:
      '不要把轻松日跑成持续中等偏累，也不要为了追心率数字强行改变自然步态；出现疼痛或异常疲劳时应缩短或休息。',
    pitfallsEn:
      'Do not let easy days drift into chronic moderate effort or force an unnatural stride to chase a heart-rate number. Shorten or rest for pain or unusual fatigue.',
    keywords: ['easy', 'recovery', 'aerobic', 'base', '轻松', '慢跑', '有氧', '恢复跑', 'jog'],
  },
  {
    id: 'marathon_pace',
    nameCn: '马拉松配速跑（Marathon Pace）',
    nameEn: 'Marathon Pace Run',
    taglineCn: '熟悉比赛节奏',
    taglineEn: 'Rehearse your race rhythm',
    hrZone: 'Controlled current marathon effort, adjusted for conditions (about RPE 4–6/10)',
    whyCn:
      '用当前能力可承担的马拉松专项强度练习节奏、动作和补给，' +
      '顺便测试肠胃能不能在这个配速下消化能量胶或饮料。',
    whyEn:
      'Use marathon-specific effort supported by current ability to rehearse rhythm and form, ' +
      'and test fueling strategies at realistic effort.',
    howCn:
      '基础与恢复稳定后，可在长跑中加入短而受控的专项段；配速应随天气、地形和当前状态调整，' +
      '完成后仍应有余力继续本周训练。',
    howEn:
      'Once base and recovery are stable, add short controlled segments within a long run. Adjust pace for weather, terrain, and current condition, and finish able to continue the training week.',
    pitfallsCn:
      '不能用理想目标成绩直接设配速，也不要把每次长跑都变成专项配速测试。',
    pitfallsEn:
      'Do not set pace directly from an aspirational goal time or turn every long run into a marathon-effort test.',
    keywords: ['marathon', 'pace', 'race', '马拉松', '配速', '比赛', 'MP', '全马'],
  },
  {
    id: 'threshold',
    nameCn: '乳酸门槛跑（Threshold Run）',
    nameEn: 'Lactate Threshold Run',
    taglineCn: '学会清理身体垃圾',
    taglineEn: 'Raise your lactate clearance ceiling',
    hrZone: 'Controlled comfortably hard; near current ~1-hour race effort (about RPE 6–7/10)',
    whyCn:
      '门槛训练在乳酸生成与清除仍可维持平衡的较高有氧强度附近进行，' +
      '用于提高可持续速度。体感应是受控的“舒适地艰苦”，不是计时赛。',
    whyEn:
      'Threshold work sits near a high aerobic intensity where lactate production and clearance remain balanced, ' +
      'improving sustainable speed. It should feel controlled and comfortably hard, not like a time trial.',
    howCn:
      '可采用连续节奏跑，或用短慢跑分隔的巡航间歇。以近期真实成绩、RPE、谈话能力和训练后恢复共同校正强度。',
    howEn:
      'Use a continuous tempo or cruise intervals separated by short easy jogs. Calibrate from a recent performance, RPE, speech, and post-session recovery.',
    pitfallsCn:
      '不要追固定心率、乳酸值或目标比赛配速；若后段明显掉速、动作失控或恢复异常，说明强度或总量过高。',
    pitfallsEn:
      'Do not chase a fixed heart rate, lactate value, or goal pace. Marked fading, form loss, or abnormal recovery means intensity or volume was too high.',
    keywords: ['threshold', 'tempo', 'lactate', '门槛', '乳酸', '节奏跑', 'LT', '巡航'],
  },
  {
    id: 'intervals',
    nameCn: '最大摄氧量间歇跑（VO₂max Intervals）',
    nameEn: 'VO₂max Intervals',
    taglineCn: '用受控间歇提高有氧功率',
    taglineEn: 'Raise the ceiling of your aerobic engine',
    hrZone: 'Current 3–5 km effort or RPE 8–9/10; HR lags and is not a rep target',
    whyCn:
      '较长间歇可提高高强度有氧能力和速度耐力。刺激来自多次质量稳定的重复，而不是单次跑到力竭。',
    whyEn:
      'Longer intervals develop high-end aerobic power and speed endurance. The stimulus comes from repeatable quality, not one exhaustive repetition.',
    howCn:
      '常用 2–5 分钟工作段，组间慢跑或步行到能稳定完成下一组；以当前成绩和体感定强度，前后安排充分热身冷身。',
    howEn:
      'Use repeatable 2–5 minute efforts with easy jog or walk recovery sufficient for the next quality rep. Set intensity from current performance and effort, with a full warm-up and cool-down.',
    pitfallsCn:
      '不要追最大心率或第一组跑最快；若配速持续下滑、动作失控、眩晕或异常不适，应停止训练。',
    pitfallsEn:
      'Do not chase maximum heart rate or win the first rep. Stop for persistent pace collapse, loss of form, dizziness, or unusual symptoms.',
    keywords: ['interval', 'VO2', 'VO2max', '间歇', '摄氧量', '心肺', '无氧', 'HIIT'],
  },
  {
    id: 'strides',
    nameCn: '冲刺与大步跑（Strides & Repetitions）',
    nameEn: 'Strides & Repetitions',
    taglineCn: '用放松快速的短跑改善协调与经济性',
    taglineEn: 'Wire your nervous system for efficient form',
    hrZone: 'Fast, relaxed, and technically controlled; never all-out',
    whyCn:
      '短而放松的加速跑用较小代价练习协调、步频和较快速度下的动作，为后续速度训练做准备。',
    whyEn:
      'Short relaxed accelerations practice coordination, cadence, and efficient form at faster speed with a low metabolic cost.',
    howCn:
      '轻松跑后做若干次 10–20 秒平稳加速，达到放松快速后减速；组间走或慢跑至呼吸和动作恢复。',
    howEn:
      'After an easy run, perform several smooth 10–20 second accelerations, reach fast-but-relaxed speed, then decelerate. Walk or jog until breathing and form reset.',
    pitfallsCn:
      '加速跑不是全力冲刺；在疼痛、明显疲劳、湿滑路面或动作无法控制时跳过。',
    pitfallsEn:
      'Strides are not all-out sprints. Skip them with pain, marked fatigue, slippery footing, or loss of technical control.',
    keywords: ['strides', 'sprint', 'repetition', 'speed', '冲刺', '大步跑', '步频', '速度', '爆发力'],
  },
  {
    id: 'fartlek',
    nameCn: '法特莱克跑（Fartlek）',
    nameEn: 'Fartlek',
    taglineCn: '用灵活的快慢变化练习节奏切换',
    taglineEn: 'The unstructured speed-play workout',
    hrZone: 'Mixed (varies by surge)',
    whyCn:
      '法特莱克用灵活的快慢变化练习节奏切换，可按地形、时间或路标组织，强度和结构比标准间歇更自由。',
    whyEn:
      'Fartlek uses flexible changes of pace to practice rhythm shifts. Surges can follow terrain, time, or landmarks with less rigid structure than track intervals.',
    howCn:
      '在轻松跑中加入 30 秒到 3 分钟的受控加速，再用足够轻松的慢跑或步行恢复；总量必须符合当前训练基础。',
    howEn:
      'Add controlled 30-second to 3-minute surges to an easy run, then recover with genuinely easy jogging or walking. Keep total work appropriate to current training history.',
    pitfallsCn:
      '“自由”不等于每段全力；应先确定本次目的和总工作量，避免在疲劳中不断加码。',
    pitfallsEn:
      'Unstructured does not mean all-out. Define the session purpose and total work first instead of adding surges indefinitely under fatigue.',
    keywords: ['fartlek', 'speed play', '法特莱克', '变速跑', '随机', 'surges'],
  },
  {
    id: 'hill_repeats',
    nameCn: '坡道跑（Hill Repeats）',
    nameEn: 'Hill Repeats',
    taglineCn: '用坡度发展力量、功率与动作控制',
    taglineEn: 'Strength training disguised as running',
    hrZone: 'Varies by hill length',
    whyCn:
      '上坡训练可发展专项力量、功率和动作控制，并自然限制绝对速度；负荷仍取决于坡度、速度、组数和下坡方式。',
    whyEn:
      'Uphill running can develop running-specific strength, power, and form control while limiting absolute speed. Load still depends on grade, pace, repetitions, and descent.',
    howCn:
      '可选择放松快速的短坡加速，或在缓坡做受控的较长重复；走或慢跑下坡，确保下一组动作稳定。',
    howEn:
      'Choose short fast-but-relaxed hill accelerations or longer controlled repeats on a moderate grade. Walk or jog down and begin the next rep only with stable form.',
    pitfallsCn:
      '不要用过陡坡度换取动作变形，也不要在疲劳时冲下坡；小腿或跟腱不适者应保守并及时停止。',
    pitfallsEn:
      'Do not use a grade so steep that form collapses or sprint downhill while fatigued. Be conservative and stop for calf or Achilles discomfort.',
    keywords: ['hill', 'uphill', 'incline', 'strength', '坡道', '爬坡', '上坡', '力量'],
  },
  {
    id: 'marathon_endurance',
    nameCn: '马拉松专项耐力',
    nameEn: 'Marathon-Specific Endurance',
    taglineCn: '在可恢复的前提下练习后程耐力',
    taglineEn: 'Build late-race durability without sacrificing recovery',
    hrZone: 'Mostly easy; race-specific segments only when appropriate',
    whyCn:
      '马拉松专项耐力来自长期稳定跑量、逐步延长的长跑，以及在合适阶段加入少量比赛配速练习。' +
      '目标是在疲劳时仍能保持动作、补给和配速纪律，而不是每次把自己跑空。',
    whyEn:
      'Marathon durability comes from consistent volume, progressively developed long runs, and ' +
      'small doses of race-specific work at the right stage. The aim is to preserve form, fueling, ' +
      'and pace discipline under fatigue—not to empty the tank every weekend.',
    howCn:
      '从近期稳定周跑量和最长跑出发逐步增加；多数长跑保持轻松。只有在基础、恢复和补给稳定时，' +
      '才加入受控的马拉松配速段，并在随后安排轻松日。',
    howEn:
      'Progress from recent stable weekly volume and long-run history; keep most long runs easy. ' +
      'Add controlled marathon-pace segments only when base, recovery, and fueling are stable, then follow with easy days.',
    pitfallsCn:
      '不要脱离个人周跑量照抄固定 26/32 公里，也不要频繁做力竭长跑；疼痛、异常疲劳或恢复变差时应降级。',
    pitfallsEn:
      'Do not copy fixed 26/32 km distances without regard to weekly volume, and avoid frequent exhaustive long runs. Downgrade when pain, unusual fatigue, or recovery worsens.',
    keywords: ['marathon', 'endurance', 'long run', 'wall', '耐力', '长距离', '撞墙'],
  },
]

/**
 * Four planning philosophies in a deliberately compact form. They are
 * selection lenses, not complete branded plans or claims of superiority.
 */
export const TRAINING_PHILOSOPHIES: TrainingPhilosophy[] = [
  {
    id: 'hansons',
    nameCn: '汉森马拉松法',
    nameEn: 'Hansons Marathon Method',
    loadPattern: 'steady',
    principleCn: '把周跑量较均匀地分散到多天，以配速纪律、连续性和累积疲劳建立马拉松专项耐力，而不是押注一节超长跑。',
    principleEn: 'Spread weekly volume across frequent runs and use pace discipline, consistency, and cumulative fatigue instead of relying on one huge long run.',
    bestForCn: '已有稳定跑量、可高频训练并偏好周内负荷较均匀的马拉松跑者。',
    bestForEn: 'Marathon runners with a stable base, frequent training availability, and a preference for evenly distributed weekly load.',
    guardrailCn: '16 英里不是可孤立照抄的规则；跑量基础不足、恢复不稳或有伤痛时只能保守借鉴理念。',
    guardrailEn: 'The 16-mile long run is not a standalone rule; low-volume, poorly recovered, or injured runners should borrow principles conservatively.',
    principleEvidence: 'system_principle',
    bestForEvidence: 'application_inference',
    guardrailEvidence: 'application_inference',
    keywords: ['hansons', 'hanson', '汉森', 'cumulative fatigue', '累积疲劳', 'marathon'],
  },
  {
    id: 'daniels',
    nameCn: '丹尼尔斯跑步方程式',
    nameEn: 'Jack Daniels Running Formula',
    loadPattern: 'mixed',
    principleCn: '用近期真实成绩估计当前 VDOT，再按 E/M/T/I/R 的不同适应目的安排最低必要刺激。',
    principleEn: 'Estimate current VDOT from a recent performance, then use E/M/T/I/R intensities for distinct adaptations with no more stress than needed.',
    bestForCn: '有可信近期成绩、希望获得清晰强度语言并按比赛距离组合课型的跑者。',
    bestForEn: 'Runners with a trustworthy recent result who want clear intensity language and distance-specific session selection.',
    guardrailCn: '训练配速必须基于当前能力，绝不能用目标成绩或手表预测成绩拔高 VDOT。',
    guardrailEn: 'Training pace must reflect current ability; never inflate VDOT from a goal time or watch prediction.',
    principleEvidence: 'system_principle',
    bestForEvidence: 'application_inference',
    guardrailEvidence: 'application_inference',
    keywords: ['daniels', 'jack daniels', '丹尼尔斯', 'vdot', 'E/M/T/I/R', 'running formula'],
  },
  {
    id: 'norwegian_threshold',
    nameCn: '挪威乳酸控制阈值 / 双阈值',
    nameEn: 'Norwegian Lactate-Controlled Threshold / Double Threshold',
    loadPattern: 'advanced_threshold',
    principleCn: '以大量低强度为基础，用内在负荷严格控制、非力竭的阈值间歇；精英运动员有时同日分两次完成。',
    principleEn: 'Build on high low-intensity volume and tightly controlled, non-exhaustive threshold intervals; elites sometimes split them into two sessions in one day.',
    bestForCn: '其“受控阈值、困难日与轻松日分开”原则可广泛借鉴；双阈值仅适合高训练龄、高跑量且恢复和监控可靠者讨论。',
    bestForEn: 'Controlled threshold and hard/easy separation are broadly useful; double threshold is only discussable for highly trained, high-volume athletes with reliable recovery and monitoring.',
    guardrailCn: '默认不安排双阈值，不照搬精英周量或固定乳酸值；普通跑者先从单次受控质量日开始。',
    guardrailEn: 'Do not prescribe double threshold by default, copy elite volume, or chase a fixed lactate value; start ordinary runners with one controlled quality day.',
    principleEvidence: 'research_evidence',
    bestForEvidence: 'application_inference',
    guardrailEvidence: 'application_inference',
    keywords: ['norwegian', 'double threshold', 'norwegian threshold', '挪威', '双阈值', '乳酸控制'],
  },
  {
    id: 'polarized',
    nameCn: '极化训练',
    nameEn: 'Polarized Training',
    loadPattern: 'hard_easy',
    principleCn: '让大部分训练真正轻松，只保留少量明确高强度，并减少长期卡在中等偏累的灰区。',
    principleEn: 'Keep most training genuinely easy, reserve a small amount for clearly hard work, and minimize chronic moderately-hard gray-zone training.',
    bestForCn: '喜欢艰苦日与轻松日反差明显，并能把轻松日真正跑轻松的跑者。',
    bestForEn: 'Runners who prefer distinct hard and easy days and can keep easy days genuinely easy.',
    guardrailCn: '80/20 是方向而非精确处方；训练天数少时不要为了凑比例增加高强度课。',
    guardrailEn: '80/20 is a direction, not an exact prescription; low-frequency runners must not add hard sessions merely to hit a ratio.',
    principleEvidence: 'research_evidence',
    bestForEvidence: 'application_inference',
    guardrailEvidence: 'application_inference',
    keywords: ['polarized', 'polarised', 'polarization', '极化', '80/20', 'hard easy'],
  },
]

/**
 * Look up running skills by keyword. Returns all 8 skills if no query is given.
 */
export function findSkills(query?: string): RunningSkill[] {
  if (!query || query.trim() === '' || query === 'all') {
    return RUNNING_SKILLS
  }

  const q = query.trim().toLowerCase()
  const matched = RUNNING_SKILLS.filter(skill => matchesKnowledgeEntry(
    q,
    skill.id,
    [skill.nameCn, skill.nameEn],
    skill.keywords,
  ))

  return matched
}

/** Find compact planning philosophies without flooding an unknown query. */
export function findTrainingPhilosophies(query?: string): TrainingPhilosophy[] {
  if (!query || query.trim() === '' || query.toLowerCase() === 'all') {
    return TRAINING_PHILOSOPHIES
  }

  const normalized = query.trim().toLowerCase()
  return TRAINING_PHILOSOPHIES.filter(philosophy => matchesKnowledgeEntry(
    normalized,
    philosophy.id,
    [philosophy.nameCn, philosophy.nameEn],
    philosophy.keywords,
  ))
}

function matchesKnowledgeEntry(
  normalizedQuery: string,
  id: string,
  names: readonly string[],
  keywords: readonly string[],
): boolean {
  if (id.includes(normalizedQuery)) return true
  if (names.some(name => name.toLowerCase().includes(normalizedQuery))) return true
  return keywords.some((keyword) => {
    const normalizedKeyword = keyword.toLowerCase()
    return normalizedKeyword.includes(normalizedQuery)
      || normalizedQuery.includes(normalizedKeyword)
  })
}

/**
 * Format a skill into a structured coaching card for the LLM to present.
 */
export function formatSkillCard(
  skill: RunningSkill,
  language?: CoachingLanguage,
): Record<string, unknown> {
  if (language) {
    return {
      id: skill.id,
      name: localized(language, skill.nameCn, skill.nameEn),
      tagline: localized(language, skill.taglineCn, skill.taglineEn),
      heartRateZone: skill.hrZone,
      why: localized(language, skill.whyCn, skill.whyEn),
      howToPractice: localized(language, skill.howCn, skill.howEn),
      commonMistakes: localized(language, skill.pitfallsCn, skill.pitfallsEn),
      evidenceClassification: WORKOUT_CARD_EVIDENCE,
    }
  }

  return {
    id: skill.id,
    name: `${skill.nameCn} / ${skill.nameEn}`,
    tagline: `${skill.taglineCn} / ${skill.taglineEn}`,
    heartRateZone: skill.hrZone,
    why: {
      zh: skill.whyCn,
      en: skill.whyEn,
    },
    howToPractice: {
      zh: skill.howCn,
      en: skill.howEn,
    },
    commonMistakes: {
      zh: skill.pitfallsCn,
      en: skill.pitfallsEn,
    },
    evidenceClassification: WORKOUT_CARD_EVIDENCE,
  }
}

/** Compact workout-type material for plan synthesis; use the full card only for explanations. */
export function formatSkillSummary(
  skill: RunningSkill,
  language: CoachingLanguage,
): Record<string, unknown> {
  return {
    id: skill.id,
    name: localized(language, skill.nameCn, skill.nameEn),
    purpose: localized(language, skill.taglineCn, skill.taglineEn),
    intensity: skill.hrZone,
    guardrail: localized(language, skill.pitfallsCn, skill.pitfallsEn),
    evidenceClassification: WORKOUT_SUMMARY_EVIDENCE,
  }
}

/** Return one language only so planning context stays compact. */
export function formatTrainingPhilosophy(
  philosophy: TrainingPhilosophy,
  language: CoachingLanguage,
): Record<string, unknown> {
  return {
    id: philosophy.id,
    name: localized(language, philosophy.nameCn, philosophy.nameEn),
    loadPattern: philosophy.loadPattern,
    principle: localized(language, philosophy.principleCn, philosophy.principleEn),
    bestFor: localized(language, philosophy.bestForCn, philosophy.bestForEn),
    guardrail: localized(language, philosophy.guardrailCn, philosophy.guardrailEn),
    evidenceClassification: {
      principle: philosophy.principleEvidence,
      bestFor: philosophy.bestForEvidence,
      guardrail: philosophy.guardrailEvidence,
    },
  }
}

function localized(
  language: CoachingLanguage,
  chinese: string,
  english: string,
): string {
  return language === 'zh-CN' ? chinese : english
}
