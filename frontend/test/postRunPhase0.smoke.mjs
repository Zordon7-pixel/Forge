// Forged Hybrid Phase 0 client-durability smoke.
// Run: node frontend/test/postRunPhase0.smoke.mjs

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadActiveRunSession, saveActiveRunSession } from '../src/lib/activeRunSession.js'
import {
  POST_RUN_CHECKIN_DRAFT_KEY,
  clearPostRunCheckInDraft,
  loadPostRunCheckInDraft,
  savePostRunCheckInDraft,
} from '../src/lib/postRunCheckInDraft.js'
import { buildPlannedSessionSnapshot } from '../src/lib/runProvenance.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')

let passed = 0
let failed = 0
function check(condition, message) {
  if (condition) passed += 1
  else { failed += 1; console.error(`  FAIL: ${message}`) }
}

class MemoryStorage {
  constructor() { this.values = new Map() }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

console.log('\n== immutable planned target ==')
const snapshot = buildPlannedSessionSnapshot({
  planSessionId: 'calendar-run-1',
  date: '2026-07-14',
  scheduledRun: {
    title: 'Recovery run',
    rawType: 'recovery',
    distanceMiles: 3,
    pace: 'Conversational',
    targetZone: 'Zone 1-2',
    steps: ['25 min easy'],
    privateField: 'drop me',
  },
})
check(snapshot.sessionId === 'calendar-run-1' && snapshot.distanceMiles === 3, 'calendar id and target distance are retained')
check(snapshot.targetZone === 'Zone 1-2' && snapshot.steps[0] === '25 min easy', 'zone and workout structure are retained')
check(!Object.prototype.hasOwnProperty.call(snapshot, 'privateField'), 'unknown calendar fields are not persisted')

console.log('\n== check-in draft durability ==')
const storage = new MemoryStorage()
const now = Date.parse('2026-07-14T12:00:00Z')
savePostRunCheckInDraft({
  runId: 'run-1',
  runQueued: true,
  step: 2,
  effort: 7,
  pain: 'mild',
}, storage, now)
const draft = loadPostRunCheckInDraft('run-1', storage, now + 5000)
check(draft?.runQueued && draft?.step === 2 && draft?.effort === 7 && draft?.pain === 'mild', 'unfinished answers survive a relaunch')
check(loadPostRunCheckInDraft('another-run', storage, now + 5000) === null, 'a draft cannot attach to the wrong run')
clearPostRunCheckInDraft('run-1', storage)
check(storage.getItem(POST_RUN_CHECKIN_DRAFT_KEY) === null, 'draft clears only after durable save or queue')
savePostRunCheckInDraft({ runId: 'expired-run' }, storage, now)
check(loadPostRunCheckInDraft(null, storage, now + 25 * 60 * 60 * 1000) === null, 'stale drafts expire after 24 hours')

console.log('\n== GPS point timestamps ==')
const sessionStorage = new MemoryStorage()
saveActiveRunSession({
  phase: 'running',
  startedAt: now - 10_000,
  routeCoords: [[38.91, -76.95, 20, now - 5000]],
}, sessionStorage, now)
const restored = loadActiveRunSession(sessionStorage, now + 1000)
check(restored?.routeCoords?.[0]?.[3] === now - 5000, 'GPS sample timestamp survives session persistence')

console.log('\n== client ordering ==')
const activeRun = read('frontend/src/pages/ActiveRun.jsx')
const logRun = read('frontend/src/pages/LogRun.jsx')
const checkIn = read('frontend/src/components/PostRunCheckIn.jsx')
check(!activeRun.includes('/ai/session-feedback'), 'GPS run does not analyze before check-in')
check(!logRun.includes('/coach/feedback/'), 'manual run does not poll for analysis before check-in')
check(checkIn.includes("/check-in") && checkIn.includes('queueRequest'), 'check-in uses the durable endpoint and offline queue')
check(checkIn.includes('Your answers are still here'), 'failed check-in keeps the user answers visible')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
console.log('PHASE 0 CLIENT SMOKE OK')
