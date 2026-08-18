/**
 * Integration test — validates real Garmin API connectivity.
 *
 * Prerequisites:
 *   1. Copy `.env.example` to `.env` and fill in GARMIN_USERNAME + GARMIN_PASSWORD
 *   2. Run: npm run test:integration
 *
 * This script logs in to Garmin Connect, exercises every API used by the plugin,
 * and prints the results. It does NOT modify any data on your Garmin account.
 */

import 'dotenv/config'
import GarminConnect from 'garmin-connect'
import {
  formatActivity,
  formatSleep,
  formatSteps,
  formatHeartRate,
  formatWeight,
  formatWorkout,
} from '../src/utils/format'

// ── Helpers ──────────────────────────────────────────────────────────────────

const ok = (label: string) => console.log(`  ✅ ${label}`)
const fail = (label: string, err: unknown) =>
  console.error(`  ❌ ${label}:`, err instanceof Error ? err.message : err)
const json = (obj: unknown) => JSON.stringify(obj, null, 2)

const today = new Date()

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const username = process.env.GARMIN_USERNAME
  const password = process.env.GARMIN_PASSWORD

  if (!username || !password) {
    console.error('❌ GARMIN_USERNAME and GARMIN_PASSWORD must be set in .env')
    process.exit(1)
  }

  const domain = process.env.GARMIN_REGION === 'cn' ? 'garmin.cn' : 'garmin.com'

  console.log(`\n🔌 Garmin Connect Integration Test`)
  console.log(`   Domain : ${domain}`)
  console.log(`   User   : ${username}`)
  console.log(`   Date   : ${today.toISOString().slice(0, 10)}\n`)

  // ── 1. Login ───────────────────────────────────────────────────────────────

  console.log('── 1. Login ──')
  const gc = new GarminConnect({ username, password }, domain)
  try {
    await gc.login()
    ok('Login successful')
  } catch (err) {
    fail('Login failed — cannot continue', err)
    process.exit(1)
  }

  // ── 2. Activities ──────────────────────────────────────────────────────────

  console.log('\n── 2. Activities ──')
  try {
    const raw = await gc.getActivities(0, 3)
    const formatted = raw.map((a: any) => formatActivity(a))
    ok(`Got ${formatted.length} activities`)
    if (formatted.length > 0) console.log(json(formatted[0]))
  } catch (err) {
    fail('getActivities', err)
  }

  // ── 3. Sleep ───────────────────────────────────────────────────────────────

  console.log('\n── 3. Sleep ──')
  try {
    const raw = await gc.getSleepData(today)
    const formatted = formatSleep(raw as any)
    ok(`Sleep score: ${formatted.sleepScore ?? 'N/A'}, duration: ${formatted.sleepDurationHours ?? '?'}h`)
  } catch (err) {
    fail('getSleepData', err)
  }

  // ── 4. Steps ───────────────────────────────────────────────────────────────

  console.log('\n── 4. Steps ──')
  try {
    const raw = await gc.getSteps(today)
    const formatted = formatSteps(raw as any)
    ok(`Steps: ${json(formatted)}`)
  } catch (err) {
    fail('getSteps', err)
  }

  // ── 5. Heart Rate ──────────────────────────────────────────────────────────

  console.log('\n── 5. Heart Rate ──')
  try {
    const raw = await gc.getHeartRate(today)
    const formatted = formatHeartRate(raw as any)
    ok(`Resting HR: ${formatted.restingHR ?? 'N/A'}, Max: ${formatted.maxHR ?? 'N/A'}`)
  } catch (err) {
    fail('getHeartRate', err)
  }

  // ── 6. Weight / Body Composition ───────────────────────────────────────────

  console.log('\n── 6. Weight / Body Composition ──')
  try {
    const raw = await gc.getDailyWeightData(today)
    const formatted = formatWeight(raw as any)
    ok(`Weight: ${formatted.weightKg ?? 'N/A'} kg, BMI: ${formatted.bmi ?? 'N/A'}, Body Fat: ${formatted.bodyFatPercentage ?? 'N/A'}%`)
  } catch (err) {
    fail('getDailyWeightData', err)
  }

  // ── 7. Workouts / Calendar ─────────────────────────────────────────────────

  console.log('\n── 7. Workouts / Calendar ──')
  try {
    const raw = await gc.getWorkouts(0, 5)
    const formatted = raw.map((w: any) => formatWorkout(w))
    ok(`Got ${formatted.length} planned workouts`)
    if (formatted.length > 0) console.log(json(formatted[0]))
  } catch (err) {
    fail('getWorkouts', err)
  }

  // ── 8. User Profile ────────────────────────────────────────────────────────

  console.log('\n── 8. User Profile ──')
  try {
    const profile = await gc.getUserProfile()
    ok(`Profile: ${(profile as any).displayName ?? (profile as any).fullName ?? 'loaded'}`)
  } catch (err) {
    fail('getUserProfile', err)
  }

  // ── 9. Export Session Token ────────────────────────────────────────────────

  console.log('\n── 9. Export Session Token ──')
  try {
    const tokens = gc.exportToken()
    ok(`Token exported (oauth1 key: ${tokens.oauth1.oauth_token.slice(0, 8)}…)`)
    console.log('   💡 To use token-based auth, save the full JSON to GARMIN_SESSION_TOKEN in .env')
  } catch (err) {
    fail('exportToken', err)
  }

  console.log('\n🏁 Integration test complete.\n')
}

main().catch((err) => {
  console.error('💥 Unexpected error:', err)
  process.exit(1)
})
