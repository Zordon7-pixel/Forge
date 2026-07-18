// Forged Hybrid H13 frontend smoke.
// Run from frontend/: node test/evidenceTimedPlan.smoke.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const frontendRoot = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({ root: frontendRoot, server: { middlewareMode: true }, appType: 'custom' })
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
