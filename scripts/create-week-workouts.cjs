/**
 * Create this week's running workouts in Garmin Connect.
 *
 * Built against the exact workout JSON schema observed in the user's own
 * workout library (ExecutableStepDTO / RepeatGroupDTO / pace.zone targets
 * in m/s). Creates 4 workouts:
 *   周二 轻松跑 6km
 *   周四 门槛巡航 3×8分钟
 *   周五 轻松跑 5km
 *   周六 长距离 12km（末段 4km 马拉松配速）
 */
require('dotenv').config()
const { GarminConnect } = require('garmin-connect')

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- schema helpers ----
const sportType = () => ({ sportTypeId: 1, sportTypeKey: 'running' })

const intervalStep = (order, description, endCondition, targetType) => ({
  type: 'ExecutableStepDTO',
  stepId: null,
  stepOrder: order,
  stepType: { stepTypeId: 3, stepTypeKey: 'interval', displayOrder: 3 },
  childStepId: null,
  description,
  endCondition: {
    conditionTypeId: endCondition.conditionTypeId,
    conditionTypeKey: endCondition.conditionTypeKey,
    displayOrder: endCondition.conditionTypeId,
    displayable: true,
  },
  endConditionValue: endCondition.value,
  preferredEndConditionUnit: endCondition.unit ?? null,
  endConditionCompare: null,
  targetType: {
    workoutTargetTypeId: targetType.id,
    workoutTargetTypeKey: targetType.key,
    displayOrder: targetType.id,
  },
  targetValueOne: targetType.one ?? null,
  targetValueTwo: targetType.two ?? null,
  targetValueUnit: null,
  zoneNumber: null,
  secondaryTargetType: null,
  secondaryTargetValueOne: null,
  secondaryTargetValueTwo: null,
  secondaryTargetValueUnit: null,
  secondaryZoneNumber: null,
  endConditionZone: null,
  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
  category: null,
  exerciseName: null,
  workoutProvider: null,
  providerExerciseSourceId: null,
  weightValue: null,
  weightUnit: null,
})

const timeCond = seconds => ({ conditionTypeId: 2, conditionTypeKey: 'time', value: seconds })
const distCond = meters => ({ conditionTypeId: 3, conditionTypeKey: 'distance', value: meters, unit: { unitKey: 'kilometer' } })

const noTarget = () => ({ id: 1, key: 'no.target' })
const paceZone = (fastMps, slowMps) => ({ id: 6, key: 'pace.zone', one: fastMps, two: slowMps })

// pace conversion: mm:ss per km -> m/s
const p = (mm, ss) => Math.round((1000 / (mm * 60 + ss)) * 10000) / 10000

const repeatGroup = (order, iterations, steps) => ({
  type: 'RepeatGroupDTO',
  stepId: null,
  stepOrder: order,
  stepType: { stepTypeId: 6, stepTypeKey: 'repeat', displayOrder: 6 },
  childStepId: 1,
  numberOfIterations: iterations,
  workoutSteps: steps.map(s => ({ ...s, childStepId: 1 })),
  endConditionValue: iterations,
  preferredEndConditionUnit: null,
  endConditionCompare: null,
  endCondition: { conditionTypeId: 7, conditionTypeKey: 'iterations', displayOrder: 7, displayable: false },
  skipLastRestStep: null,
  smartRepeat: false,
})

const workout = (name, description, steps) => ({
  workoutName: name,
  description,
  sportType: sportType(),
  workoutSegments: [
    {
      segmentOrder: 1,
      sportType: sportType(),
      poolLengthUnit: null,
      poolLength: null,
      avgTrainingSpeed: null,
      estimatedDurationInSecs: null,
      estimatedDistanceInMeters: null,
      estimatedDistanceUnit: null,
      estimateType: null,
      description: null,
      workoutSteps: steps,
    },
  ],
})

// ---- the week's workouts ----

const tue = workout(
  '周二·轻松跑6km',
  '本周计划：轻松跑 6km，心率 125-140，配速 6:30-7:00，边跑边能聊天。跑完加 4×15 秒大步跑（手动）。',
  [
    intervalStep(1, '轻松跑 心率125-140', distCond(6000), noTarget()),
  ]
)

const thu = workout(
  '周四·门槛巡航3x8分钟',
  '本周计划：2km 热身 → 3×(8分钟门槛 + 2分钟慢跑恢复) → 1km 放松。门槛段配速 5:00-5:15/km，心率 165-172，体感"舒适地艰苦"。',
  [
    intervalStep(1, '热身 轻松跑', distCond(2000), noTarget()),
    repeatGroup(2, 3, [
      intervalStep(3, '门槛跑 配速5:00-5:15', timeCond(8 * 60), paceZone(p(5, 0), p(5, 15))),
      intervalStep(4, '慢跑恢复', timeCond(2 * 60), noTarget()),
    ]),
    intervalStep(5, '放松慢跑', distCond(1000), noTarget()),
  ]
)

const fri = workout(
  '周五·轻松跑5km',
  '本周计划：轻松跑 5km，心率 120-135，配速 6:40-7:10，排酸放松。跑完加 4×15 秒大步跑（手动）。',
  [
    intervalStep(1, '轻松跑 心率120-135', distCond(5000), noTarget()),
  ]
)

const sat = workout(
  '周六·长距离12km',
  '本周计划：前 8km 轻松跑(6:30-6:50) → 后 4km 提到马拉松配速 5:20-5:40，心率 150-165。',
  [
    intervalStep(1, '轻松跑 8km', distCond(8000), noTarget()),
    intervalStep(2, '马拉松配速 5:20-5:40', distCond(4000), paceZone(p(5, 20), p(5, 40))),
  ]
)

async function main() {
  const gc = new GarminConnect({ username: process.env.GARMIN_USERNAME, password: process.env.GARMIN_PASSWORD })
  await gc.login()
  console.log('Login OK')

  for (const w of [tue, thu, fri, sat]) {
    try {
      const res = await gc.addWorkout(w)
      console.log(`✅ 创建成功: ${w.workoutName}  (id=${res?.workoutId ?? '?'})`)
    } catch (e) {
      console.log(`❌ 创建失败: ${w.workoutName} -> ${e.message}`)
      if (e.response) console.log('   status:', e.response.status, JSON.stringify(e.response.data || {}).slice(0, 300))
    }
    await sleep(800)
  }

  // confirm by listing the workout library
  const list = await gc.getWorkouts(0, 50)
  console.log('\n当前训练库（前10条）:')
  for (const w of list.slice(0, 10)) {
    console.log(`- ${w.workoutName} (id=${w.workoutId}, 预估 ${w.estimatedDurationMins} 分钟)`)
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
