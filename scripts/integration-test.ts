/**
 * Integration test — validates real Garmin API connectivity.
 *
 * Prerequisites:
 *   1. Copy `.env.example` to `.env` and set GARMIN_USERNAME plus either
 *      GARMIN_PASSWORD or GARMIN_SESSION_TOKEN
 *   2. Run: npm run test:integration
 *
 * This script authenticates with Garmin Connect, exercises read-only APIs used by
 * the plugin, and prints the results. It deliberately does NOT exercise write
 * operations such as workout creation, update, or deletion.
 */

import 'dotenv/config'
import { GarminConnect } from 'garmin-connect'
import { hardenGarminHttpClient } from '../src/client'
import { safeUpstreamLogLine } from '../src/utils/errors'
import {
  formatActivity,
  formatSleep,
  formatSteps,
  formatHeartRate,
  formatWeight,
  formatWorkout,
  formatProfile,
} from '../src/utils/format'

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const verbose = process.env.GARMIN_INTEGRATION_VERBOSE?.toLowerCase() === 'true'
let logSecrets: ReadonlyArray<string | undefined> = []

const ok = (label: string) => {
  passed += 1
  console.log(`  ✅ ${label}`)
}
const fail = (label: string, err: unknown) => {
  failed += 1
  console.error(`  ❌ ${label}`)
  if (verbose) {
    console.error('     Detail:', safeUpstreamLogLine([err], logSecrets))
  }
}
const json = (obj: unknown) => JSON.stringify(obj, null, 2)
const printDetails = (obj: unknown) => {
  if (verbose) console.log(json(obj))
}

const today = new Date()

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const username = process.env.GARMIN_USERNAME
  const password = process.env.GARMIN_PASSWORD
  const sessionToken = process.env.GARMIN_SESSION_TOKEN
  logSecrets = [username, password, sessionToken]

  if (!username || (!password && !sessionToken)) {
    console.error('❌ Set GARMIN_USERNAME and either GARMIN_PASSWORD or GARMIN_SESSION_TOKEN in .env')
    process.exitCode = 1
    return
  }

  const domain = process.env.GARMIN_REGION === 'cn' ? 'garmin.cn' : 'garmin.com'

  console.log(`\n🔌 Garmin Connect Integration Test`)
  console.log(`   Domain : ${domain}`)
  console.log('   User   : configured (identifier hidden)')
  console.log(`   Date   : ${localDateString(today)}`)
  console.log('   Scope  : read-only (workout creation/update/deletion is not tested)\n')

  // ── 1. Authentication ──────────────────────────────────────────────────────

  console.log('── 1. Authentication ──')
  const gc = new GarminConnect({ username, password: password ?? '' }, domain)
  hardenGarminHttpClient(gc.client as any)
  gc.client.client.defaults.timeout = 15_000
  try {
    if (sessionToken) {
      let tokens: unknown
      try {
        tokens = JSON.parse(sessionToken)
      } catch {
        throw new Error('GARMIN_SESSION_TOKEN is not valid JSON')
      }
      if (!isRecord(tokens) || !isRecord(tokens.oauth1) || !isRecord(tokens.oauth2)) {
        throw new Error('GARMIN_SESSION_TOKEN must contain oauth1 and oauth2 token objects')
      }
      gc.loadToken(tokens.oauth1 as any, tokens.oauth2 as any)
      ok('Session token loaded')
    } else {
      await gc.login()
      ok('Password login successful')
    }
  } catch (err) {
    fail('Authentication failed — cannot continue', err)
    process.exitCode = 1
    return
  }

  // ── 2. Activities ──────────────────────────────────────────────────────────

  console.log('\n── 2. Activities ──')
  try {
    const raw = await gc.getActivities(0, 3)
    const formatted = raw.map((a: any) => formatActivity(a))
    ok(`Got ${formatted.length} activities`)
    if (formatted.length > 0) printDetails(formatted[0])
  } catch (err) {
    fail('getActivities', err)
  }

  // ── 3. Sleep ───────────────────────────────────────────────────────────────

  console.log('\n── 3. Sleep ──')
  try {
    const raw = await gc.getSleepData(today)
    const formatted = formatSleep(raw as any)
    ok('Sleep data loaded')
    printDetails(formatted)
  } catch (err) {
    fail('getSleepData', err)
  }

  // ── 4. Steps ───────────────────────────────────────────────────────────────

  console.log('\n── 4. Steps ──')
  try {
    const raw = await gc.getSteps(today)
    const formatted = formatSteps(raw as any, localDateString(today))
    ok('Step data loaded')
    printDetails(formatted)
  } catch (err) {
    fail('getSteps', err)
  }

  // ── 5. Heart Rate ──────────────────────────────────────────────────────────

  console.log('\n── 5. Heart Rate ──')
  try {
    const raw = await gc.getHeartRate(today)
    const formatted = formatHeartRate(raw as any)
    ok('Heart-rate data loaded')
    printDetails(formatted)
  } catch (err) {
    fail('getHeartRate', err)
  }

  // ── 6. Weight / Body Composition ───────────────────────────────────────────

  console.log('\n── 6. Weight / Body Composition ──')
  try {
    const raw = await gc.getDailyWeightData(today)
    const formatted = formatWeight(raw as any)
    ok('Body-composition data loaded')
    printDetails(formatted)
  } catch (err) {
    fail('getDailyWeightData', err)
  }

  // ── 7. Workout Library ──────────────────────────────────────────────────────

  console.log('\n── 7. Workout Library ──')
  try {
    const raw = await gc.getWorkouts(0, 5)
    const formatted = raw.map((w: any) => formatWorkout(w))
    ok(`Got ${formatted.length} workout templates`)
    if (formatted.length > 0) printDetails(formatted[0])
  } catch (err) {
    fail('getWorkouts', err)
  }

  // ── 8. User Profile ────────────────────────────────────────────────────────

  console.log('\n── 8. User Profile ──')
  try {
    const profile = await gc.getUserProfile()
    ok('Profile loaded')
    printDetails(formatProfile(profile as any))
  } catch (err) {
    fail('getUserProfile', err)
  }

  console.log(`\n🏁 Integration test complete: ${passed} passed, ${failed} failed.`)
  console.log('   Write operations were intentionally not tested.\n')
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('💥 Unexpected integration-test error')
  if (verbose) console.error(safeUpstreamLogLine([err], logSecrets))
  process.exitCode = 1
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
