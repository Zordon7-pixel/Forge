const assert = require('node:assert/strict');
const { activityAssessment, runCompletionEvidence } = require('../src/lib/activityReconciliation');
const { explicitNoPlanMatchSnapshot } = require('../src/lib/plannedRunMatch');
const base = { date: '2026-09-09', type: 'easy', distance_miles: 2, duration_seconds: 1500,
  perceived_effort: 2, created_at: '2026-09-09T16:00:00Z',
  planned_session_json: { schemaVersion: 1, matchSource: 'explicit_owned_session', planId: 'own-plan', sessionId: 'planned-easy', date: '2026-09-09', type: 'easy' } };
const assess = runs => activityAssessment({ athleteId: 'own', runs, planningDateLocal: '2026-09-10', timezone: 'America/New_York',
  observationInstant: '2026-09-10T16:00:00Z' });
const session = { sessionId: 'planned-easy', date: base.date, session: { session_id: 'planned-easy',
  plan_id: 'own-plan', workout_family: 'easy_run', derived_totals: { duration_s: 1500, distance_m: 3219 } } };

const genuine = assess([{ ...base, id: 'one' }, { ...base, id: 'two' }]);
assert.equal(genuine.canonicalRuns.length, 2, 'Same date and dose do not prove duplicate identity');
assert.equal(genuine.recentRunLoad.currentWeek.runCount, 2);
assert.deepEqual(genuine.recentRunLoad.currentWeek.runDates, ['2026-09-09']);
assert.equal(genuine.recentRunLoad.currentWeek.miles, 4);
assert.equal(genuine.recentRunLoad.protection.active, false, 'Two short easy runs do not mandate next-day rest');

const provider = { ...base, health_source: 'apple_health', health_source_workout_id: 'real-source-1',
  health_start_at: '2026-09-09T16:00:00Z', watch_mode: 'import', notes: 'Imported workout' };
const duplicate = assess([{ ...provider, id: 'provider-one' }, { ...provider, id: 'provider-two',
  perceived_effort: 9, pain_level: 'severe', post_energy: 'low' }]);
assert.equal(duplicate.canonicalRuns.length, 1);
assert.equal(duplicate.recentRunLoad.currentWeek.miles, 2);
assert.equal(duplicate.recentRunLoad.protection.postRunSevere, true, 'Duplicate source selection retains athlete symptoms');
assert.equal(duplicate.recentRunLoad.protection.hardRunsThrough, '2026-09-12');
assert.deepEqual(duplicate.canonicalRuns[0].evidence_ids, ['provider-one', 'provider-two']);

const linked = assess([{ ...base, id: 'linked', plan_session_id: 'planned-easy' }]);
assert.equal(runCompletionEvidence([session], linked)[0].completed, true);
const canonicalSession = { ...session, session: { ...session.session, canonical_workout_schema_version: 1, content_hash: 'a'.repeat(64) } };
for (const hash of [undefined, '', 'not-a-hash', 'b'.repeat(64)]) {
  const evidence = assess([{ ...base, id:'canonical-link', plan_session_id:'planned-easy',
    planned_session_json:{...base.planned_session_json,content_hash:hash} }]);
  assert.equal(runCompletionEvidence([canonicalSession], evidence)[0].completed, false, 'Canonical links require the exact nonempty authenticated prescription hash');
  assert.equal(evidence.recentRunLoad.currentWeek.miles, 2);
}
assert.equal(runCompletionEvidence([canonicalSession], assess([{ ...base,id:'canonical-owned',plan_session_id:'planned-easy',
  planned_session_json:{...base.planned_session_json,content_hash:'a'.repeat(64)} }]))[0].completed, true);
for (const changed of [
  { date: '2026-09-08' },
  { planned_session_json: { ...base.planned_session_json, date: '2026-09-08' } },
  { planned_session_json: { ...base.planned_session_json, planId: 'old-plan' } },
  { planned_session_json: { ...base.planned_session_json, sessionId: 'other' } },
  { planned_session_json: { ...base.planned_session_json, kind: 'lift' } },
  { planned_session_json: null },
  { planned_session_json: { ...base.planned_session_json, matchSource: 'scheduled_date' } },
]) {
  const stale = assess([{ ...base, id: 'stale', plan_session_id: 'planned-easy', ...changed }]);
  assert.equal(runCompletionEvidence([session], stale)[0].completed, false, 'Only exact plan/date/modality lineage earns completion');
  assert.equal(stale.recentRunLoad.currentWeek.miles, 2, 'Stale links remain real workload');
}
assert.throws(() => assess([{ ...base, id: 'foreign', user_id: 'another-owner' }]), /foreign evidence/);
const conflictingDuplicate = assess([{ ...provider, id: 'linked-provider', plan_session_id: 'planned-easy' },
  { ...provider, id: 'unlinked-provider', planned_session_json: explicitNoPlanMatchSnapshot() }]);
assert.equal(runCompletionEvidence([session], conflictingDuplicate)[0].completed, false,
  'Conflicting completion intent within a proven physical duplicate remains workload-only');
assert.equal(conflictingDuplicate.recentRunLoad.currentWeek.miles, 2);
const independentChoice = assess([{ ...base, id: 'independent-linked', plan_session_id: 'planned-easy' },
  { ...base, id: 'independent-unlinked', planned_session_json: explicitNoPlanMatchSnapshot() }]);
assert.equal(runCompletionEvidence([session], independentChoice)[0].completed, true,
  'Unlinked intent on a different physical activity does not suppress a qualified link');
const unlinked = assess([{ ...base, id: 'unlinked', planned_session_json: explicitNoPlanMatchSnapshot() }]);
assert.equal(unlinked.recentRunLoad.currentWeek.miles, 2);
assert.equal(runCompletionEvidence([session], unlinked)[0].completed, false);
assert.equal(runCompletionEvidence([{ sessionId: '', session: {} }], unlinked)[0].attempted, false);
const quality = { ...session, session: { ...session.session, workout_family: 'interval_run' } };
assert.equal(runCompletionEvidence([quality], linked)[0].completed, false, 'Easy/date/link is not interval execution');
const labelledQuality = assess([{ ...base, type: 'interval', id: 'labelled', plan_session_id: 'planned-easy', perceived_effort: 8 }]);
assert.equal(runCompletionEvidence([quality], labelledQuality)[0].completed, false, 'A label and RPE do not prove interval structure');
assert.equal(runCompletionEvidence([quality], labelledQuality, ['planned-easy'])[0].source, 'explicit_completion');
assert.equal(runCompletionEvidence([quality], labelledQuality, ['planned-easy'])[0].outcome, null, 'Explicit completion does not fabricate target success');
const legacyQuality = { ...session, session: { id: 'planned-easy', type: 'quality', derived_totals: session.session.derived_totals } };
assert.equal(runCompletionEvidence([legacyQuality], linked)[0].completed, false);

const partials = assess([{ ...base, id: 'partial-a', plan_session_id: 'planned-easy', duration_seconds: 600, distance_miles: 0.8 },
  { ...base, id: 'partial-b', plan_session_id: 'planned-easy', duration_seconds: 600, distance_miles: 0.8 }]);
assert.equal(runCompletionEvidence([session], partials)[0].completed, false, 'Separate partials do not silently complete a continuous prescription');
const partialThenFull = assess([{ ...base, id: 'first-partial', plan_session_id: 'planned-easy', duration_seconds: 300, distance_miles: 0.4 },
  { ...base, id: 'later-full', plan_session_id: 'planned-easy' }]);
assert.equal(runCompletionEvidence([session], partialThenFull)[0].completed, true);
assert.equal(runCompletionEvidence([session, { ...session, sessionId: 'other' }], linked).filter(row => row.completed).length, 1);

const unknown = assess([{ id: 'unknown', date: base.date, type: 'run' }]);
assert.equal(unknown.recentRunLoad.sevenDayMiles, null);
assert.equal(unknown.canonicalRuns[0].perceived_effort, null);
const late = assess([{ ...base, id: 'late', health_start_at: '2026-09-10T02:00:00Z' }]);
assert.equal(late.canonicalRuns[0].date, '2026-09-09', 'Originating device-local date wins over UTC date');
assert.notEqual(linked.fingerprint, assess([{ ...base, id: 'linked', plan_session_id: 'planned-easy', perceived_effort: 8 }]).fingerprint);
assert.notEqual(linked.fingerprint, assess([]).fingerprint);
const enriched = assess([{...base,id:'linked',plan_session_id:'planned-easy',pace_avg:750,
  workout_metrics_json:JSON.stringify({summary_source:'manual'})}]);
assert.equal(enriched.fingerprint,linked.fingerprint,'Derived pace and transport summary attribution do not cause another coaching decision');
console.log('activity identity, load and completion separation smoke: PASS');
