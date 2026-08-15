import assert from 'node:assert/strict'
import { Decoder, Stream } from '@garmin/fitsdk'
import {
  buildFitWorkoutRepresentation,
  encodeWorkoutFit,
} from '../src/services/fit/encodeWorkoutFit.js'

function decodeFit(bytes) {
  const stream = Stream.fromByteArray(Array.from(bytes))
  if (typeof Decoder.decodeMessageStream === 'function') {
    const result = Decoder.decodeMessageStream(stream)
    return {
      messages: result.messages || result,
      errors: result.errors || [],
    }
  }
  const decoder = new Decoder(stream)
  assert.equal(decoder.isFIT(), true, 'encoded file should have a FIT header')
  assert.equal(decoder.checkIntegrity(), true, 'encoded file should pass FIT integrity checks')
  return decoder.read()
}

function firstMessage(messages, key) {
  const value = messages[key]
  return Array.isArray(value) ? value[0] : value
}

function messageList(messages, key) {
  const value = messages[key]
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

function distanceMeters(step) {
  if (Number.isFinite(Number(step.durationDistance))) return Number(step.durationDistance)
  if (Number.isFinite(Number(step.durationValue))) return Number(step.durationValue) / 100
  return NaN
}

function durationSeconds(step) {
  if (Number.isFinite(Number(step.durationTime))) return Number(step.durationTime)
  if (Number.isFinite(Number(step.durationValue))) return Number(step.durationValue) / 1000
  return NaN
}

function forgeMetadata(value, prefix) {
  assert.ok(String(value || '').startsWith(prefix), `metadata should begin with ${prefix}`)
  return JSON.parse(String(value).slice(prefix.length))
}

function assertWorkoutRoundTrip(workout, checks = {}) {
  const bytes = encodeWorkoutFit(workout)
  assert.ok(bytes instanceof Uint8Array, 'encoder should return Uint8Array')

  const { messages, errors } = decodeFit(bytes)
  assert.deepEqual(errors, [], 'decoder should report no errors')

  const fileId = firstMessage(messages, 'fileIdMesgs')
  const workoutMessage = firstMessage(messages, 'workoutMesgs')
  const steps = messageList(messages, 'workoutStepMesgs')

  assert.equal(fileId?.type, 'workout', 'file type should be workout')
  assert.equal(workoutMessage?.numValidSteps, workout.steps.length, 'workout step count should match input')
  assert.equal(steps.length, workout.steps.length, 'decoded step count should match input')

  if (checks.intensities) {
    assert.equal(steps[0]?.intensity, 'warmup', 'first step should be warmup')
    assert.equal(steps[steps.length - 1]?.intensity, 'cooldown', 'last step should be cooldown')
  }

  if (checks.distanceStepIndex !== undefined) {
    const meters = distanceMeters(steps[checks.distanceStepIndex])
    assert.ok(Math.abs(meters - checks.expectedMeters) < 2, `distance step should be about ${checks.expectedMeters}m`)
  }
}

const runWorkout = {
  schemaVersion: 1,
  source: 'forge',
  kind: 'run',
  title: 'Forge Zone 2 Run',
  activity: 'running',
  goal: { type: 'distance', value: 3, unit: 'mile' },
  targets: { paceSecondsPerMile: null, heartRateZone: 2, effort: null },
  steps: [
    { type: 'time', label: 'Warm up easy', durationSeconds: 300 },
    { type: 'distance', label: 'Main run', distanceMiles: 3, heartRateZone: 2 },
    { type: 'time', label: 'Cool down easy', durationSeconds: 300 },
  ],
  notes: '',
}

const strengthWorkout = {
  schemaVersion: 1,
  source: 'forge',
  kind: 'strength',
  title: 'Forge Strength',
  activity: 'functionalStrengthTraining',
  goal: { type: 'open' },
  targets: { paceSecondsPerMile: null, heartRateZone: null, effort: null },
  steps: [
    { type: 'instruction', label: 'Warm up mobility', durationSeconds: 300 },
    { type: 'instruction', label: 'Squat 3x5' },
    { type: 'instruction', label: 'Cool down breathing', durationSeconds: 300 },
  ],
  notes: '',
}

const canonicalHash = 'c'.repeat(64)
const canonicalSession = {
  canonical_workout_schema_version: 1,
  session_id: 'session-fit-exact-1',
  session_revision: 4,
  plan_id: 'plan-fit-1',
  plan_revision: 9,
  decision_id: 'decision-fit-1',
  role: 'PRIMARY_KEY',
  workout_family: 'interval_run',
  title: 'Metric repeats',
  scheduled_local_date: '2026-08-18',
  timezone: 'America/New_York',
  steps: [
    { step_id: 'warmup', type: 'warmup', order: 1, target: { duration_s: 301 }, provenance: [] },
    {
      step_id: 'repeat', type: 'repeat', order: 2, repeat_count: 3, target: {}, provenance: [],
      children: [
        { step_id: 'work', type: 'interval', order: 1, target: { distance_m: 1000, pace_range_s_per_km: { minimum: 235, maximum: 245 } }, provenance: [] },
        { step_id: 'recover', type: 'recovery', order: 2, target: { duration_s: 91 }, provenance: [] },
      ],
    },
    { step_id: 'cooldown', type: 'cooldown', order: 3, target: { duration_s: 299 }, provenance: [] },
  ],
  target_provenance: [],
  safety_scope: ['RUN', 'IMPACT'],
  executability: 'EXECUTABLE',
  capability: { classification: 'FULLY_STRUCTURED', manual_step_ids: [], unsupported_step_ids: [] },
  content_hash: canonicalHash,
}

function canonicalManifest(session = canonicalSession, overrides = {}) {
  return {
    schema_version: 'goal_backward_surface_manifest_v1',
    surface_revision: 6,
    feature_mode: 'on',
    v24_surface_enabled: true,
    status: 'accepted',
    identity: {
      decision_id: session.decision_id,
      plan_id: session.plan_id,
      plan_revision: session.plan_revision,
    },
    safety: { action: 'MONITOR', scope: session.safety_scope, reason_codes: ['MONITOR_RECOVERY'] },
    sessions: [session],
    ...overrides,
  }
}

try {
  assertWorkoutRoundTrip(runWorkout, {
    intensities: true,
    distanceStepIndex: 1,
    expectedMeters: 3 * 1609.344,
  })
  assertWorkoutRoundTrip(strengthWorkout, { intensities: true })

  const canonicalRequest = {
    surfaceManifest: canonicalManifest(),
    sessionId: canonicalSession.session_id,
    exportRevision: 2,
  }
  const representation = buildFitWorkoutRepresentation(canonicalRequest)
  assert.deepEqual(representation.identity, {
    session_id: canonicalSession.session_id,
    session_revision: 4,
    plan_id: canonicalSession.plan_id,
    plan_revision: 9,
    surface_revision: 6,
    export_revision: 2,
    content_hash: canonicalHash,
  })
  assert.equal(representation.capability.classification, 'FULLY_STRUCTURED')
  assert.deepEqual(representation.steps.map((step) => step.canonical_type), [
    'warmup', 'interval', 'recovery', 'repeat', 'cooldown',
  ])

  const { messages: canonicalMessages, errors: canonicalErrors } = decodeFit(encodeWorkoutFit(canonicalRequest))
  assert.deepEqual(canonicalErrors, [])
  const canonicalWorkoutMessage = firstMessage(canonicalMessages, 'workoutMesgs')
  const canonicalSteps = messageList(canonicalMessages, 'workoutStepMesgs')
  assert.equal(canonicalWorkoutMessage.numValidSteps, 5)
  assert.equal(canonicalSteps.length, 5)
  assert.deepEqual(
    forgeMetadata(canonicalWorkoutMessage.wktDescription, 'FORGE_META:'),
    {
      sid: representation.identity.session_id,
      sr: representation.identity.session_revision,
      pid: representation.identity.plan_id,
      pr: representation.identity.plan_revision,
      sfr: representation.identity.surface_revision,
      er: representation.identity.export_revision,
      hash: representation.identity.content_hash,
      cap: 'FULL',
    },
  )
  assert.ok(Math.abs(durationSeconds(canonicalSteps[0]) - 301) <= 1, 'duration must round-trip within ±1 s')
  assert.ok(Math.abs(distanceMeters(canonicalSteps[1]) - 1000) <= 2, 'distance must round-trip within ±2 m')
  assert.ok(Math.abs(Number(canonicalSteps[1].customTargetSpeedLow) - (1000 / 245)) <= 0.001, 'slow pace bound must round-trip in canonical metric units')
  assert.ok(Math.abs(Number(canonicalSteps[1].customTargetSpeedHigh) - (1000 / 235)) <= 0.001, 'fast pace bound must round-trip in canonical metric units')
  assert.equal(canonicalSteps[3].durationType, 'repeatUntilStepsCmplt')
  assert.equal(canonicalSteps[3].durationStep, 1)
  assert.equal(canonicalSteps[3].repeatSteps, 3)
  assert.deepEqual(canonicalSteps.map((step) => {
    const metadata = forgeMetadata(step.notes, 'FORGE_STEP:')
    return [metadata.step_id, metadata.type, metadata.order, metadata.repeat_count || null]
  }), [
    ['warmup', 'warmup', 1, null],
    ['work', 'interval', 1, null],
    ['recover', 'recovery', 2, null],
    ['repeat', 'repeat', 2, 3],
    ['cooldown', 'cooldown', 3, null],
  ])

  const station = {
    step_id: 'station-row', type: 'station', order: 2,
    target: { repetitions: 20, load_kg: 16 }, provenance: [],
  }
  const hybridSession = {
    ...canonicalSession,
    session_id: 'session-fit-hybrid-1',
    workout_family: 'hyrox_compromised',
    steps: [
      { step_id: 'hybrid-run', type: 'run', order: 1, target: { distance_m: 1000 }, provenance: [] },
      station,
    ],
    capability: { classification: 'PARTIALLY_STRUCTURED', manual_step_ids: ['station-row'], unsupported_step_ids: [] },
    content_hash: 'd'.repeat(64),
  }
  const hybridRequest = { surfaceManifest: canonicalManifest(hybridSession), sessionId: hybridSession.session_id }
  const hybrid = buildFitWorkoutRepresentation(hybridRequest)
  assert.equal(hybrid.capability.classification, 'PARTIALLY_STRUCTURED')
  assert.equal(hybrid.steps[1].capability.classification, 'MANUAL_COMPONENTS_REQUIRED')
  const { messages: hybridMessages } = decodeFit(encodeWorkoutFit(hybridRequest))
  const hybridSteps = messageList(hybridMessages, 'workoutStepMesgs')
  assert.equal(hybridSteps.length, 2, 'manual station marker must not be silently omitted')
  assert.match(hybridSteps[1].wktStepName, /^Manual:/)
  assert.equal(forgeMetadata(hybridSteps[1].notes, 'FORGE_STEP:').type, 'station')

  const blockedSession = { ...canonicalSession, executability: 'NOT_EXECUTABLE', content_hash: 'e'.repeat(64) }
  const blockedRequest = {
    surfaceManifest: canonicalManifest(blockedSession, {
      safety: { action: 'FULL_REST', scope: ['ALL'], reason_codes: ['FULL_REST'] },
    }),
    sessionId: blockedSession.session_id,
  }
  assert.throws(
    () => encodeWorkoutFit(blockedRequest),
    (error) => error?.code === 'WORKOUT_NOT_EXECUTABLE',
    'a safety-blocked canonical session must not export',
  )
  console.log('PASS fitExport.smoke')
} catch (error) {
  console.error('FAIL fitExport.smoke')
  console.error(error?.stack || error)
  process.exit(1)
}
