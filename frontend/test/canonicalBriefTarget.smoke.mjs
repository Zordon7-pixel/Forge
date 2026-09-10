import assert from 'node:assert/strict'
import { canonicalTargetValue, canonicalRunStructure } from '../src/lib/weeklyRunBrief.js'
import { canonicalPrescribedDurationSeconds } from '../src/lib/planCalendar.js'
assert.equal(canonicalTargetValue({ rpe_range: { minimum: 2, maximum: 4 } }), 'RPE: 2–4')
assert.equal(canonicalTargetValue({ rpe_range: { minimum: 3, maximum: 3 } }), 'RPE: 3')
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
console.log('CANONICAL BRIEF TARGET OK: effort ranges render as useful text, not object coercion')
