/**
 * Running Skills Knowledge Base
 *
 * A structured, bilingual (Chinese + English) knowledge base covering the
 * 8 core running training skills drawn from modern sport science.  The agent
 * uses the `get_running_skill_advice` tool to look up one or more skills and
 * return actionable coaching advice to the user.
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
  /** Heart-rate zone guidance, e.g. "65%-79% of max HR". */
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

export const RUNNING_SKILLS: RunningSkill[] = [
  {
    id: 'easy_run',
    nameCn: '轻松跑（Easy Run）',
    nameEn: 'Easy Run',
    taglineCn: '打好地基，强化身体零件',
    taglineEn: 'Build your aerobic foundation and strengthen every body part',
    hrZone: '65%-79% max HR',
    whyCn:
      '别觉得跑得慢没用。轻松跑能把心脏容量"撑大"，在肌肉里建更多的毛细血管和能量工厂（线粒体），' +
      '同时让骨骼和肌腱变硬，以后跑快了才不容易受伤。顶级高手 70% 以上的跑量都在做轻松跑。',
    whyEn:
      'Easy runs enlarge stroke volume, grow capillaries and mitochondria in muscles, ' +
      'and harden bones & tendons so you can handle faster work without injury. ' +
      'Elite runners spend 70%+ of their volume here.',
    howCn:
      '保持最大心率的 65%-79%。体感上应该能边跑边轻松聊天，不会上气不接下气。',
    howEn:
      'Keep heart rate at 65%-79% of max. You should be able to hold a comfortable conversation.',
    pitfallsCn:
      '慢跑不等于"拖着脚走"。步伐要轻快有弹性，别因为跑得慢就让跑姿变形，否则反而容易伤膝盖。',
    pitfallsEn:
      'Slow does not mean sloppy. Keep a springy, quick cadence — don\'t let form degrade just because the pace is easy.',
    keywords: ['easy', 'recovery', 'aerobic', 'base', '轻松', '慢跑', '有氧', '恢复跑', 'jog'],
  },
  {
    id: 'marathon_pace',
    nameCn: '马拉松配速跑（Marathon Pace）',
    nameEn: 'Marathon Pace Run',
    taglineCn: '熟悉比赛节奏',
    taglineEn: 'Rehearse your race rhythm',
    hrZone: '80%-90% max HR',
    whyCn:
      '用你比赛时想用的速度去跑，让身体和大脑提前适应比赛的真实感觉，' +
      '顺便测试肠胃能不能在这个配速下消化能量胶或饮料。',
    whyEn:
      'Run at your target marathon pace to teach your body and mind the race-day feel, ' +
      'and test fueling strategies at realistic effort.',
    howCn:
      '比轻松跑稍快，大概在最大心率的 80%-90%。可以在周末长距离跑中用这个配速跑一段，' +
      '单次最长别超过 26 公里或 90 分钟，找"双腿发沉但还能坚持"的感觉。',
    howEn:
      'Slightly faster than easy pace, 80%-90% max HR. Embed segments into your weekend long run ' +
      '(cap at 26 km or 90 min). Target the "heavy legs but still manageable" sensation.',
    pitfallsCn:
      '不要每次长跑都全程用马拉松配速，容易过度训练。穿插在轻松跑中分段练习即可。',
    pitfallsEn:
      'Don\'t run entire long runs at marathon pace — overtraining risk. Embed segments within an easy long run.',
    keywords: ['marathon', 'pace', 'race', '马拉松', '配速', '比赛', 'MP', '全马'],
  },
  {
    id: 'threshold',
    nameCn: '乳酸门槛跑（Threshold Run）',
    nameEn: 'Lactate Threshold Run',
    taglineCn: '学会清理身体垃圾',
    taglineEn: 'Raise your lactate clearance ceiling',
    hrZone: '88%-92% max HR',
    whyCn:
      '跑得越快，肌肉产生的乳酸越多，腿就发酸。门槛跑卡在身体"清理垃圾"和"产生垃圾"速度相等的临界点上，' +
      '逼着身体提高清理乳酸的能力，变废为宝。体感叫做"舒适地艰苦"——你能感觉到累，但还能咬牙维持。',
    whyEn:
      'Threshold pace sits at the tipping point where lactate production equals clearance. ' +
      'Training here forces your body to improve its lactate recycling machinery. ' +
      'Perceived effort: "comfortably hard" — you feel the effort but can sustain it.',
    howCn:
      '心率控制在 88%-92%。两种玩法：\n' +
      '① 节奏跑：连续跑 20-60 分钟\n' +
      '② 巡航间歇：跑 10 分钟休息 2 分钟，重复 3-4 次（不那么痛苦）',
    howEn:
      'Heart rate 88%-92%. Two approaches:\n' +
      '① Tempo run: 20-60 min continuous\n' +
      '② Cruise intervals: 10 min on / 2 min jog, repeat 3-4×',
    pitfallsCn:
      '不要跑成间歇跑！门槛跑的目的是"持续维持"而非"冲刺恢复"。如果只能坚持几分钟，说明速度太快了。',
    pitfallsEn:
      'Don\'t turn it into intervals — the goal is sustained effort. If you can only hold a few minutes, you\'re going too fast.',
    keywords: ['threshold', 'tempo', 'lactate', '门槛', '乳酸', '节奏跑', 'LT', '巡航'],
  },
  {
    id: 'intervals',
    nameCn: '最大摄氧量间歇跑（VO₂max Intervals）',
    nameEn: 'VO₂max Intervals',
    taglineCn: '拔高心肺天花板',
    taglineEn: 'Raise the ceiling of your aerobic engine',
    hrZone: '98%-100% max HR',
    whyCn:
      '用来挑战心肺极限，直接把"引擎功率"拉满。极度痛苦，大口喘气，基本只能蹦出一两个字。',
    whyEn:
      'Push your cardiovascular system to its absolute limit. Extremely hard breathing, can barely speak.',
    howCn:
      '心率飙到 98%-100%。每次快跑 3-5 分钟（低于 3 分钟心脏还没达到极限，超过 5 分钟身体会因缺氧崩溃掉速）。' +
      '跑完慢跑恢复（时间跟快跑差不多长），千万别直接原地躺下。',
    howEn:
      'HR 98%-100%. Each hard effort 3-5 min (shorter = heart doesn\'t peak; longer = oxygen debt crashes pace). ' +
      'Jog recovery for equal time. Never stop dead — keep moving.',
    pitfallsCn:
      '每次间歇快跑时间必须卡在 3-5 分钟。恢复期要慢跑，不能站着不动，否则心率骤降不利于恢复。',
    pitfallsEn:
      'Stick to 3-5 min hard intervals. Recovery must be active jogging — standing still causes dangerous HR drops.',
    keywords: ['interval', 'VO2', 'VO2max', '间歇', '摄氧量', '心肺', '无氧', 'HIIT'],
  },
  {
    id: 'strides',
    nameCn: '冲刺与大步跑（Strides & Repetitions）',
    nameEn: 'Strides & Repetitions',
    taglineCn: '练就丝滑跑姿',
    taglineEn: 'Wire your nervous system for efficient form',
    hrZone: 'Max effort (short bursts)',
    whyCn:
      '通过极短距离的极速冲刺，唤醒中枢神经，让大脑学会以最高效、最省力的姿势跑步，就像给双腿装上弹簧。',
    whyEn:
      'Ultra-short sprints awaken the central nervous system and teach your brain the most efficient, ' +
      'energy-saving running form — like installing springs in your legs.',
    howCn:
      '全力冲刺但要感觉"完全掌控身体"。可以跑几组 200 米，或者在日常轻松跑结束前加上几组 10-15 秒的大步跑。' +
      '必须完全休息好再跑下一组（冲刺 30 秒 → 慢走/慢跑 1-2 分钟）。',
    howEn:
      'Sprint at full effort but stay in complete control. Do a few 200 m reps, or add 4-6 × 10-15 s ' +
      'strides at the end of an easy run. Fully recover between reps (30 s sprint → 1-2 min walk/jog).',
    pitfallsCn:
      '带着疲劳去冲刺只会让跑姿变形，大大增加拉伤风险。确保心率降下来、腿完全不酸了再冲下一组。',
    pitfallsEn:
      'Sprinting while fatigued wrecks your form and risks strains. Wait until HR drops and legs feel fresh before the next rep.',
    keywords: ['strides', 'sprint', 'repetition', 'speed', '冲刺', '大步跑', '步频', '速度', '爆发力'],
  },
  {
    id: 'fartlek',
    nameCn: '法特莱克跑（Fartlek）',
    nameEn: 'Fartlek',
    taglineCn: '野外的变速游戏',
    taglineEn: 'The unstructured speed-play workout',
    hrZone: 'Mixed (varies by surge)',
    whyCn:
      '嫌田径场绕圈太无聊？去野外玩"速度游戏"！真实比赛中难免遇到上坡、转弯或加速超车，' +
      '这个训练练你的实战应变能力和抗压心态。没有固定规则，全凭感觉：' +
      '看到前面一棵树就全速冲过去，冲到了换成慢跑喘口气，看到红绿灯再冲。快慢交替。',
    whyEn:
      'Unstructured speed play — sprint to a tree, jog to recover, sprint to the next landmark. ' +
      'Mimics real race surges (hills, passes, turns) and builds mental toughness.',
    howCn:
      '在跑步中随机加入短冲刺段，快跑 30 秒到 3 分钟，慢跑恢复 1-3 分钟，没有固定模式。' +
      '总训练时间 20-45 分钟即可。',
    howEn:
      'During a run, inject random surges of 30 s to 3 min, with 1-3 min jog recovery. ' +
      'No fixed pattern. Total session 20-45 min.',
    pitfallsCn:
      '冲刺完之后不允许停下脚步，必须用慢跑来恢复。这能逼着身体学会在极度疲劳和乳酸堆积时依然运转。',
    pitfallsEn:
      'Never stop walking after a surge — always jog. This forces your body to clear lactate under load.',
    keywords: ['fartlek', 'speed play', '法特莱克', '变速跑', '随机', 'surges'],
  },
  {
    id: 'hill_repeats',
    nameCn: '坡道跑（Hill Repeats）',
    nameEn: 'Hill Repeats',
    taglineCn: '跑步界的"撸铁"',
    taglineEn: 'Strength training disguised as running',
    hrZone: 'Varies by hill length',
    whyCn:
      '找个坡往上跑，对膝盖和骨骼的冲击力反而小，还能起到"力量训练"的效果。' +
      '它能专治跑姿问题（步子迈太大、脚后跟重重砸地），强制你前脚掌落地并加快步频。',
    whyEn:
      'Running uphill is lower impact than flat sprints yet doubles as strength work. ' +
      'It corrects over-striding and heel striking by forcing a forefoot landing.',
    howCn:
      '① 短坡冲刺：陡坡全力冲 8-10 秒 → 慢走下来休息 2 分钟以上。提升爆发力，唤醒快肌纤维。\n' +
      '② 长坡重复：缓坡跑 1-4 分钟 → 慢跑下来恢复。提高肌肉耐力和双腿抗酸能力。',
    howEn:
      '① Short hill sprints: steep hill, 8-10 s all-out → walk down, rest 2+ min. Builds power & fast-twitch fibers.\n' +
      '② Long hill repeats: moderate grade, 1-4 min → jog down. Builds muscular endurance & acid tolerance.',
    pitfallsCn:
      '下坡时要慢！下坡冲刺对膝盖冲击极大。把下坡当恢复阶段，慢慢走或慢跑下来。',
    pitfallsEn:
      'Go slow downhill! Sprinting down crushes your knees. Treat the descent as recovery — walk or jog gently.',
    keywords: ['hill', 'uphill', 'incline', 'strength', '坡道', '爬坡', '上坡', '力量'],
  },
  {
    id: 'marathon_endurance',
    nameCn: '马拉松专项耐力',
    nameEn: 'Marathon-Specific Endurance',
    taglineCn: '终极疲劳管理',
    taglineEn: 'Master the final wall',
    hrZone: 'Varies by method',
    whyCn:
      '跑马的人都知道最后 10 公里才是真正的地狱。这个技能教你如何在"腿像灌了铅"时依然维持住配速。' +
      '三大经典流派：\n\n' +
      '① 汉森法（带疲劳起跑）：最长不超过 26 公里，但平时跑得勤，带着前几天的累计疲劳去跑周末长距离，模拟马拉松最后十几公里的痛苦。\n\n' +
      '② Pfitzinger 法（暴力长跑）：老实跑 32 公里以上的超长距离，甚至在后半段强行提速，彻底榨干体力储备，逼身体燃烧脂肪。\n\n' +
      '③ 卡诺瓦法（贴近实战）：长距离跑中用非常接近比赛的速度跑很长时间，连"休息"段落也保持较快速度，不给身体彻底喘息的机会。',
    whyEn:
      'The last 10 km of a marathon is the real race. Three classic philosophies:\n\n' +
      '① Hanson (cumulative fatigue): Cap long runs at 26 km but run frequently, ' +
      'so you start every weekend long run already tired — simulating the marathon\'s final miles.\n\n' +
      '② Pfitzinger (brute distance): Run 32+ km long runs, even picking up pace in the second half ' +
      'to fully deplete glycogen stores and teach the body to burn fat.\n\n' +
      '③ Canova (race-specific): Run long at very close to race pace with only mild recovery segments, ' +
      'never letting the body fully catch its breath.',
    howCn:
      '根据你的目标和经验选择一种流派。关键原则：长距离训练的目的不是"跑完"，而是"在疲劳中维持配速"。' +
      '每 2-3 周安排一次最长距离训练，之后用 1 周减量恢复。',
    howEn:
      'Choose one philosophy based on your goal and experience. Key principle: the long run\'s purpose is not ' +
      '"finishing" but "holding pace under fatigue". Schedule your peak long run every 2-3 weeks, followed by a recovery week.',
    pitfallsCn:
      '长距离训练后必须充分恢复（至少 2-3 天轻松跑或休息）。频繁暴力长跑是受伤和过度训练的头号原因。',
    pitfallsEn:
      'Allow full recovery after long runs (2-3 days easy/rest). Frequent brutal long runs are the #1 cause of injury and overtraining.',
    keywords: ['marathon', 'endurance', 'long run', 'wall', '耐力', '长距离', '撞墙', '汉森', 'Pfitzinger', '卡诺瓦', 'Canova'],
  },
]

/**
 * Look up running skills by keyword. Returns all 8 skills if no query is given.
 */
export function findSkills(query?: string): RunningSkill[] {
  if (!query || query.trim() === '' || query === 'all') {
    return RUNNING_SKILLS
  }

  const q = query.toLowerCase()
  const matched = RUNNING_SKILLS.filter(skill => {
    // Match by id
    if (skill.id.includes(q)) return true
    // Match by name
    if (skill.nameCn.toLowerCase().includes(q)) return true
    if (skill.nameEn.toLowerCase().includes(q)) return true
    // Match by keywords
    return skill.keywords.some(kw => kw.toLowerCase().includes(q) || q.includes(kw.toLowerCase()))
  })

  return matched.length > 0 ? matched : RUNNING_SKILLS // fallback to all if no match
}

/**
 * Format a skill into a structured coaching card for the LLM to present.
 */
export function formatSkillCard(skill: RunningSkill): Record<string, unknown> {
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
  }
}
