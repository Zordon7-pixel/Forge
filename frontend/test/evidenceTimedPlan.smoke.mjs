// Forged Hybrid H13 frontend smoke.
// Run from frontend/: node test/evidenceTimedPlan.smoke.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const frontendRoot = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({
  root: frontendRoot,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
const { default: WatchWorkoutService } = await vite.ssrLoadModule('/src/services/WatchWorkoutService.js')
const { default: WatchDeliveryService } = await vite.ssrLoadModule('/src/services/WatchDeliveryService.js')
const { trainingEvidenceKindLabel } = await vite.ssrLoadModule('/src/lib/trainingEvidence.js')

assert.equal(trainingEvidenceKindLabel('research'), 'Research')
assert.equal(trainingEvidenceKindLabel('coach_plan'), 'Coach plan')
assert.equal(trainingEvidenceKindLabel('athlete_practice'), 'Athlete practice')

const timed = WatchWorkoutService.buildRunWorkout({
  day: 'Tuesday, Jul 14',
  typeLabel: 'Recovery run',
  prescriptionBasis: 'time',
  durationMinutes: 27,
  durationLabel: '27 min',
  distanceLabel: '~2.0 mi estimated',
  zone: 'Zone 1-2',
  intensity: 'Recovery',
  steps: ['Keep breathing relaxed'],
})

assert.deepEqual(timed.goal, { type: 'time', value: 27, unit: 'minute' })
assert.equal(timed.display.duration, '27 min')
assert.match(WatchWorkoutService.formatWorkoutText(timed), /Duration: 27 min/)
assert.match(WatchDeliveryService.formatFallbackText(timed), /Goal: 27 minutes/)

const distance = WatchWorkoutService.buildRunWorkout({
  typeLabel: 'Race day',
  prescriptionBasis: 'distance',
  distanceLabel: '10.0 mi',
})
assert.deepEqual(distance.goal, { type: 'distance', value: 10, unit: 'mile' })
assert.equal(WatchDeliveryService.buildStructuredWorkout({ typeLabel: 'easy_run' }).title, 'Easy run')

const canonicalSession = {
  canonical_workout_schema_version: 1,
  session_id: 'watch-canonical-1',
  session_revision: 3,
  plan_id: 'watch-plan-1',
  plan_revision: 8,
  decision_id: 'watch-decision-1',
  role: 'PRIMARY_KEY',
  workout_family: 'interval_run',
  title: 'Watch intervals',
  scheduled_local_date: '2026-08-18',
  timezone: 'America/New_York',
  steps: [{
    step_id: 'watch-interval', type: 'interval', order: 1,
    target: { distance_m: 1000, pace_range_s_per_km: { minimum: 235, maximum: 245 } }, provenance: [],
  }],
  target_provenance: [],
  safety_scope: ['RUN'],
  executability: 'EXECUTABLE',
  capability: { classification: 'FULLY_STRUCTURED', manual_step_ids: [], unsupported_step_ids: [] },
  content_hash: 'a'.repeat(64),
}
const surfaceManifest = {
  schema_version: 'goal_backward_surface_manifest_v1',
  surface_revision: 5,
  feature_mode: 'on',
  v24_surface_enabled: true,
  status: 'accepted',
  identity: { decision_id: canonicalSession.decision_id, plan_id: canonicalSession.plan_id, plan_revision: canonicalSession.plan_revision },
  safety: { action: 'MONITOR', scope: ['RUN'], reason_codes: ['MONITOR_RECOVERY'] },
  sessions: [canonicalSession],
}
const canonicalRequest = { surfaceManifest, sessionId: canonicalSession.session_id, exportRevision: 2 }
const canonicalStructured = WatchDeliveryService.buildStructuredWorkout(canonicalRequest)
assert.deepEqual(canonicalStructured.identity, {
  session_id: canonicalSession.session_id,
  session_revision: 3,
  plan_id: canonicalSession.plan_id,
  plan_revision: 8,
  surface_revision: 5,
  export_revision: 2,
  content_hash: canonicalSession.content_hash,
})
assert.deepEqual(canonicalStructured.steps, canonicalSession.steps)

const inexactApple = WatchWorkoutService.buildCanonicalWorkoutPayload(canonicalStructured)
assert.notEqual(inexactApple.capability.classification, 'FULLY_STRUCTURED')
assert.deepEqual(inexactApple.identity, canonicalStructured.identity)
assert.deepEqual(inexactApple.canonical_steps, canonicalSession.steps)
assert.deepEqual(inexactApple.manual_components.map((component) => component.step_id), ['watch-interval'])
assert.deepEqual(inexactApple.step_capabilities, [{
  step_id: 'watch-interval', type: 'interval', classification: 'PARTIALLY_STRUCTURED',
}])

const exactDistanceSession = {
  ...canonicalSession,
  session_id: 'watch-distance-1',
  workout_family: 'easy_run',
  steps: [{ step_id: 'watch-run', type: 'run', order: 1, target: { distance_m: 6437 }, provenance: [] }],
  content_hash: 'b'.repeat(64),
}
const exactDistanceRequest = {
  surfaceManifest: { ...surfaceManifest, sessions: [exactDistanceSession] },
  sessionId: exactDistanceSession.session_id,
}
const exactApple = WatchWorkoutService.buildCanonicalWorkoutPayload(
  WatchDeliveryService.buildStructuredWorkout(exactDistanceRequest),
)
assert.equal(exactApple.capability.classification, 'FULLY_STRUCTURED')
assert.ok(Math.abs((exactApple.goal.value * 1609.344) - 6437) < 0.001)
assert.deepEqual(exactApple.identity.content_hash, exactDistanceSession.content_hash)
assert.deepEqual(exactApple.step_capabilities, [{
  step_id: 'watch-run', type: 'run', classification: 'FULLY_STRUCTURED',
}])

const blockedSession = { ...exactDistanceSession, executability: 'NOT_EXECUTABLE', content_hash: 'f'.repeat(64) }
const blockedRequest = {
  surfaceManifest: {
    ...surfaceManifest,
    safety: { action: 'FULL_REST', scope: ['ALL'], reason_codes: ['FULL_REST'] },
    sessions: [blockedSession],
  },
  sessionId: blockedSession.session_id,
}
await assert.rejects(
  () => WatchDeliveryService.send(blockedRequest),
  (error) => error?.code === 'WORKOUT_NOT_EXECUTABLE',
)
assert.throws(
  () => WatchDeliveryService.buildStructuredWorkout({
    ...canonicalRequest,
    surfaceManifest: { ...surfaceManifest, status: 'preview' },
  }),
  (error) => error?.code === 'CANONICAL_MANIFEST_NOT_ACCEPTED',
)

const buttonSource = fs.readFileSync(new URL('../src/components/WatchWorkoutSendButton.jsx', import.meta.url), 'utf8')
const settingsSource = fs.readFileSync(new URL('../src/pages/Settings.jsx', import.meta.url), 'utf8')
assert.doesNotMatch(buttonSource, /\{error \|\| availability\.reason\}/)
assert.doesNotMatch(buttonSource, /requires TestFlight build/)
assert.match(buttonSource, /console\.error\('\[watch-delivery\] unavailable:'/)
assert.doesNotMatch(buttonSource, /Apple Watch coming soon/)
assert.match(buttonSource, /Checking Apple Watch\.\.\./)
assert.match(buttonSource, /Export watch workout/)
assert.match(buttonSource, /Garmin-compatible manual transfer/)
assert.match(buttonSource, /Garmin\/NewFiles/)
assert.match(buttonSource, /does not pair to Garmin watches over Bluetooth/)
assert.match(buttonSource, /Manual components required/)
assert.match(buttonSource, /Partially structured/)
assert.match(buttonSource, /Not exportable/)
assert.match(buttonSource, /manual_components/)
assert.match(buttonSource, /WORKOUT_NOT_EXECUTABLE/)
assert.doesNotMatch(buttonSource, /Send to watch \(\.FIT\)/)
assert.match(buttonSource, /ref=\{fitDialogRef\}/)
assert.match(buttonSource, /tabIndex=\{-1\}/)
assert.match(buttonSource, /event\.key !== 'Tab'/)
assert.match(buttonSource, /error && !fitExportOpen/)
assert.doesNotMatch(buttonSource, /!compact && availability\.checked && !availability\.available/)
assert.equal(settingsSource.includes('>{watchDelivery.reason}</p>'), false)
assert.match(settingsSource, /athleteWatchAvailabilityMessage\(watchDelivery\.reason\)/)

const cssSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const checkinSource = fs.readFileSync(new URL('../src/pages/DailyCheckIn.jsx', import.meta.url), 'utf8')
assert.match(cssSource, /\.forged-branded-screen::after[\s\S]*url\('\/icon-192\.png'\)/)
assert.ok((checkinSource.match(/className="forged-branded-screen"/g) || []).length >= 3)

await vite.close()
console.log('EVIDENCE TIMED PLAN FRONTEND SMOKE OK')
