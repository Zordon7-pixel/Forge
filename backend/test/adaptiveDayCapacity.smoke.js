// Synthetic local preparation and taper fixtures; no live observations or database writes.
const assert = require('node:assert/strict');
const { canonicalizeRunLoadInput } = require('../src/lib/goalBackwardEvidence');
const { prepare } = require('../src/lib/adaptiveCoachingShadow');
const { fixture, windows, withObservedWork } = require('./adaptiveCoachingSolver.smoke');
const { buildAdaptiveCoachingCandidate } = require('../src/lib/adaptiveCoachingSolver');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const { buildAdaptiveSessionSelection } = require('../src/lib/adaptiveCoachingSelection');
const { normalizeSolverConstraints, validateAdaptivePlacement } = require('../src/lib/adaptiveCoachingValidation');
const { validateCanonicalSessionSet } = require('../src/lib/canonicalWorkout');

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
for (const [runDays, liftDays, lifts] of [
  [['Mon', 'Wed'], days, 7],
  [['Mon', 'Wed'], ['Tue', 'Thu'], 2],
]) {
  let snapshot;
  const load = canonicalizeRunLoadInput({ athleteId: 'synthetic-day-capacity', timezone: 'UTC',
    planningInstant: '2026-09-14T00:00:00Z', planningDateLocal: '2026-09-14', runs: [],
    captureSnapshot: s => { snapshot = s; } });
  const target = { runDaysPerWeek: 2, liftDaysPerWeek: lifts, trainingDays: runDays,
    runEligibleWeekdays: runDays, liftEligibleWeekdays: liftDays };
  const input = { userId: snapshot.athlete_id, source: { snapshot, load, rawRuns: [], sourceFailed: false },
    state: { snapshot, target, context: { target, todayISO: '2026-09-14' }, races: [],
      inputHash: 'synthetic-input', planningInputRevision: 1,
      planningConstraints: { locks: [], manual_edits: [], lock_revision: 0, edit_revision: 0,
        constraint_fingerprint: 'synthetic-constraints' } },
    accepted: null, goals: [], trainingAgeClass: 'BEGINNER' };
  const before = structuredClone(input);
  const result = prepare(input);
  assert.deepEqual(input, before, 'real prepare must not mutate inputs');
  assert.equal(result.blockedReason, null);
  assert.deepEqual(result.foundation.decision.weekly_objectives.capacities, { run: 2, lift: lifts });
  const dates = modality => [...new Set(result.availability[modality].map(w => w.start_at.slice(0, 10)))];
  const expected = pool => days.flatMap((day, i) => pool.includes(day) ? [`2026-09-${14 + i}`] : []);
  assert.deepEqual(dates('run'), expected(runDays));
  assert.deepEqual(dates('lift'), expected(liftDays));
  for (const modality of ['run', 'lift']) assert.ok(result.foundation.decision.session_selection.used_capacity[modality]
    <= result.foundation.decision.weekly_objectives.capacities[modality]);
}
console.log('ok - real prepare retains seven lift capacity and independent overlapping/disjoint weekday pools without input mutation');

// Reuse existing solver synthetic observed-work fixture. Taper selection itself
// constructs recovery_run prescriptions; no easy-run relabeling or validator bypass.
const input = withObservedWork(fixture(5, 1, 300), { quality: true, strengthSets: 6 });
input.goals = [{ goal_id: 'synthetic-taper', athlete_id: input.snapshot.athlete_id,
  event_kind: 'ROAD_ENDURANCE', distance_miles: 13.109,
  event_local_date: '2026-09-23', event_state: 'SCHEDULED' }];
const availability = windows();
availability.run = availability.run.slice(0, 5);
availability.lift = availability.lift.slice(0, 1);
const before = structuredClone({ input, availability });
const foundation = buildAdaptiveCoachingFoundation(input);
const result = buildAdaptiveCoachingCandidate({ foundation, availability });
assert.deepEqual({ input, availability }, before);
assert.equal(result.applicable, true);
assert.equal(result.selected_candidate?.validation.valid, true);
assert.equal(validateCanonicalSessionSet(result.selected_candidate.canonical_session_set).valid, true);
const sessions = result.selected_candidate.sessions;
const lift = sessions.find(s => s.kind === 'lift');
const recovery = sessions.find(s => s.workout_family === 'recovery_run' && s.scheduled_local_date === lift?.scheduled_local_date);
assert.ok(recovery, 'real taper selection and placement must produce a recovery-run/lift double');
assert.ok(recovery.derived_totals.duration_s >= 1200 && recovery.derived_totals.duration_s <= 1500);
assert.equal(recovery.beginner_or_rehab_protocol_id == null, true);
assert.ok(!recovery.purpose_reason_codes.includes('BELOW_PRESENTATION_FLOOR_EXCEPTION'));
assert.ok(Date.parse(lift.scheduled_start_at) - Date.parse(recovery.scheduled_start_at)
  - recovery.derived_totals.duration_s * 1000 >= 6 * 3600000);
const constraints = normalizeSolverConstraints(foundation.athlete_state, availability);
const selection = buildAdaptiveSessionSelection(foundation);
const collision = sessions.map(s => s.session_id === lift.session_id
  ? { ...s, scheduled_start_at: recovery.scheduled_start_at } : s);
const rejected = validateAdaptivePlacement(collision, constraints, foundation.athlete_state, selection.weekly_objectives, { complete: true });
assert.equal(rejected.valid, false);
assert.ok(rejected.violations.some(v => v.code === 'ADAPTIVE_RECOVERY_HOURS'));
console.log('ok - validator-backed short recovery-run/lift double; insufficient recovery spacing still rejected');
