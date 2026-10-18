// Execute the actual page handlers without a browser or provider calls.
// This base uses start -> set -> end, not the completed-log import endpoint.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const logLift = fs.readFileSync(new URL('../src/pages/LogLift.jsx', import.meta.url), 'utf8').split('export default function LogLift() {')[1]
const activeWorkout = fs.readFileSync(new URL('../src/pages/ActiveWorkout.jsx', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function handler(source, name, context) {
  const body = source.match(new RegExp(`  const ${name} = async \\(\\) => \\{[\\s\\S]*?\\n  \\}`))?.[0]
  assert.ok(body, `actual ${name} handler exists`)
  return vm.runInNewContext(`${body}; ${name}`, context)
}

let checks = 0
for (const name of ['begin', 'beginAI', 'beginScheduled', 'acceptManualAiWorkout']) {
  const requests = [], navigation = [], queued = []
  const plan = { target: 'chest', main: [{ name: 'Bench press', sets: 2, reps: 8 }], workoutName: 'Upper', warmup: ['Warm up'] }
  const context = {
    navigator: { onLine: true }, selected: ['chest'], selectedMuscleGroup: 'chest',
    selectedExercise: { name: 'Bench press' }, aiRecommendation: plan,
    scheduledLiftPlan: plan, manualAiPlan: plan, planSessionId: 'planned-lift', planCurrentWeek: 2,
    muscleGroupsFromTarget: () => ['chest'],
    setLoading() {}, setError(value) { assert.equal(value, '') }, setFeedback() {}, track() {},
    api: { post: async (url, payload) => {
      requests.push([url, plain(payload)])
      return { data: { session: { id: 'saved-lift', started_at: '2026-09-20T13:00:00Z' } } }
    } },
    navigate: (...args) => navigation.push(plain(args)),
    queueRequest: async (...args) => queued.push(plain(args)),
  }
  const begin = handler(logLift, name, context)
  await begin()
  assert.equal(requests.length, 1)
  assert.equal(requests[0][0], '/workouts/start')
  assert.deepEqual(requests[0][1].muscle_groups, ['chest'])
  assert.equal(navigation[0][0], '/workout/active/saved-lift')
  if (name === 'beginScheduled') {
    assert.equal(navigation[0][1].state.planSessionId, 'planned-lift')
    assert.equal(navigation[0][1].state.currentWeek, 2)
  }
  context.navigator.onLine = false
  await begin()
  assert.equal(requests.length, 1, 'offline start does not make an online request')
  assert.equal(navigation.length, 1, 'offline start does not invent a saved session')
  assert.deepEqual(queued, [['/api/workouts/start', 'POST', requests[0][1]]])
  checks++
}

const effects = [], errors = []
let rejectSave = false
const context = {
  sets: [{ id: 'saved-set', reps: 8, weight_lbs: 100 }], id: 'saved-lift',
  planSessionId: 'planned-lift', planCurrentWeek: 2, workoutStartGate: { access: {} },
  workoutTimerRef: { current: null }, endErrorRef: {},
  authorizeWorkoutStart: async () => ({ allowed: true, access: {} }),
  setWorkoutStartGate() {}, workoutStartErrorMessage: () => 'blocked',
  setFormErrors: value => errors.push(typeof value === 'function' ? value({}) : value),
  scrollToFirstError() {}, setEnding() {}, clearInterval() {},
  api: { put: async (url, payload) => {
    effects.push(['end', url, plain(payload)])
    if (rejectSave) throw new Error('Synthetic save failure')
    return { data: { ok: true, total_seconds: 2730 } }
  } },
  markSessionComplete: async (id, week) => effects.push(['complete', id, week]),
  navigate: (...args) => effects.push(['navigate', ...plain(args)]),
  console: { error: (...args) => effects.push(['reported', ...args]) },
}
const end = handler(activeWorkout, 'endWorkout', context)
await end()
assert.deepEqual(effects, [
  ['end', '/workouts/saved-lift/end', {}],
  ['complete', 'planned-lift', 2],
  ['navigate', '/workout/summary/saved-lift', { state: { planProgressNotice: '' } }],
])
assert.deepEqual(errors, [])
effects.length = 0
rejectSave = true
await end()
assert.deepEqual(effects.map(effect => effect[0]), ['end', 'reported'])
assert.equal(errors[0].workout, 'Could not finish this workout. Try again.')
console.log(`LOGLIFT SAVE FLOW OK: ${checks} online/offline start paths; successful end/plan/summary; failed save stays retryable`)
