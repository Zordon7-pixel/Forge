import assert from 'node:assert/strict'
import { Decoder, Stream } from '@garmin/fitsdk'
import { encodeWorkoutFit } from '../src/services/fit/encodeWorkoutFit.js'

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

try {
  assertWorkoutRoundTrip(runWorkout, {
    intensities: true,
    distanceStepIndex: 1,
    expectedMeters: 3 * 1609.344,
  })
  assertWorkoutRoundTrip(strengthWorkout, { intensities: true })
  console.log('PASS fitExport.smoke')
} catch (error) {
  console.error('FAIL fitExport.smoke')
  console.error(error?.stack || error)
  process.exit(1)
}
