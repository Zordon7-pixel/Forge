import assert from 'node:assert/strict'
import { canonicalTargetValue, canonicalRunStructure, sessionIntensity } from '../src/lib/weeklyRunBrief.js'
import { canonicalPrescribedDurationSeconds, canonicalWorkoutLabel } from '../src/lib/planCalendar.js'
assert.equal(canonicalTargetValue({ rpe_range: { minimum: 2, maximum: 4 } }), 'RPE: 2–4')
assert.equal(canonicalTargetValue({ rpe_range: { minimum: 3, maximum: 3 } }), 'RPE: 3')
assert.equal(canonicalTargetValue({ duration_s: 1200, rest_s: 90 }), '20 min · Rest: 1 min 30 sec')
assert.equal(canonicalTargetValue({ future_target: { unknown: true } }), '')
assert.ok(!canonicalTargetValue({ rpe_range: { minimum: 2, maximum: 4 }, nested: { a: {} } }).includes('[object Object]'))
const steps = [{ step_id: 'private-step-id', type: 'run', order: 1, provenance: [{ decision_id: 'private-decision-hash' }],
  target: { duration_s: 1200, rpe_range: { minimum: 2, maximum: 4 }, unexpected_internal_field: 'private-internal' } }]
assert.deepEqual(canonicalRunStructure(steps), ['Run · 20 min · RPE: 2–4'])
assert.deepEqual(canonicalRunStructure([{ type: 'repeat', repeat_count: 3, children: steps }]), ['Repeat × 3', 'Run · 20 min · RPE: 2–4'])
assert.ok(!canonicalRunStructure(steps).join(' ').includes('private'))
assert.equal(canonicalPrescribedDurationSeconds(steps), 1200)
assert.equal(canonicalPrescribedDurationSeconds([{ type: 'repeat', repeat_count: 3, children: steps }]), 3600)
assert.equal(canonicalPrescribedDurationSeconds([{ target: { distance_m: 1609 } }]), null)
assert.equal(canonicalPrescribedDurationSeconds([...steps, { target: { distance_m: 1609 } }]), null,
  'A known-duration subtotal is not an exact total duration for a mixed distance/time workout')
for (const stale of ['long_aerobic','threshold_run','interval_run','assessment','race_rhythm_run']) {
  const recovery = {kind:'run',canonical:true,workoutFamily:'recovery_run',type:'recovery',title:'Useful recovery run',raw:{workout_id:stale}}
  assert.equal(canonicalWorkoutLabel(recovery),'Recovery run')
  assert.deepEqual(sessionIntensity(recovery),{key:'recovery',label:'Recovery'})
}
assert.deepEqual(sessionIntensity({kind:'run',canonical:true,workoutFamily:'race_rhythm_run',type:'race_rhythm_run'}),{key:'quality',label:'Quality'})
console.log('CANONICAL BRIEF TARGET OK: effort ranges render as useful text, not object coercion')
