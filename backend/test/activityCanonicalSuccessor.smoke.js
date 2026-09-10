const assert = require('node:assert/strict');
const { scenario } = require('./programFixtures');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const canonical = require('../src/lib/canonicalWorkout');
const policy = require('../src/lib/activityAdaptationAuthority');
const successor = require('../src/lib/activityCanonicalSuccessor');
const tickets = require('../src/lib/activityObservationTicket');
const { activityProgramReconciliation } = require('../src/lib/activityProgramReconciliation');
const { buildObservation } = require('../src/lib/activityObservation');
const { activityAssessment } = require('../src/lib/activityReconciliation');

function observationFor(parent, date) {
  return buildObservation({ ownerId: 'synthetic-owner', planningDate: date, timezone: parent.program_contract.timezone,
    planningInputRevision: parent.plan_revision + 3, assessment: activityAssessment({ athleteId: 'synthetic-owner',
      planningDateLocal: date, timezone: parent.program_contract.timezone, observationInstant: `${date}T16:00:00Z` }) });
}

function contextFor(parent, date, ids) {
  return { version: policy.VERSION, owner_id: 'synthetic-owner', assignment_id: 'synthetic-assignment',
    parent_plan_id: parent.plan_id, parent_plan_revision: parent.plan_revision, parent_canonical_set_hash: parent.content_hash,
    planning_input_revision: parent.plan_revision + 3, activity_fingerprint: canonicalHash(`saved-activity-${date}`),
    evidence_ids: [`saved-run-${date}`], safety_state_hash: canonicalHash('saved-safety'), observed_at: `${date}T16:00:00Z`,
    planning_date: date, timezone: parent.program_contract.timezone, window_start: date, window_end: `${date.slice(0, 8)}13`,
    expires_at: `${date.slice(0, 8)}14T04:00:00Z`, reason_code: 'RECENT_RUN_PROTECTION', affected_session_ids: ids.slice().sort(),
    parent_goals_hash: canonicalHash(parent.program_contract.goals),
    parent_horizon: { start_date: parent.program_contract.start_date, end_date: parent.program_contract.end_date },
    missed_outcome_fingerprint: canonicalHash({}), observation_hash: observationFor(parent, date).content_hash,
    recent_run_load_hash: canonicalHash(observationFor(parent, date).recent_run_load) };
}
for (const frequency of [4, 7]) {
  const fixture = scenario({ date: '2026-09-10', count: 3, liftDays: frequency,
    ...(frequency === 7 ? { runDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] } : {}) });
  assert.ok(fixture.accepted);
  const parent = fixture.result.selected_candidate.canonical_session_set;
  const originalBytes = JSON.stringify(parent);
  const ids = parent.sessions.filter(session => session.scheduled_local_date === '2026-09-10').map(session => session.session_id);
  assert.equal(ids.length, 2);
  const context = contextFor(parent, '2026-09-10', ids);
  const first = successor.buildActivityCanonicalSuccessor({ parent, context, observationArtifact: observationFor(parent, '2026-09-10'),
    changes: ids.map(id => ({ session_id: id, action: 'rest' })) }).canonical;
  assert.equal(JSON.stringify(parent), originalBytes, 'The accepted predecessor remains immutable');
  assert.equal(canonical.validateCanonicalSessionSet(first).valid, true);
  require('../src/lib/activityValidationScope').withActivityValidationScope(() => {
    const scoped = successor.buildActivityCanonicalSuccessor({ parent, context, observationArtifact: observationFor(parent, '2026-09-10'),
      changes: ids.map(id => ({ session_id: id, action: 'rest' })) });
    assert.deepEqual(scoped.canonical, first, 'Scoped reuse leaves the entire canonical prescription and lineage byte-equivalent');
    assert.equal(canonical.validateCanonicalSessionSet(first).valid, true);
    assert.equal(successor.validateActivitySet(first, { authenticatedParent: parent, authenticatedContext: context }), true);
    assert.equal(successor.validateActivitySet(first, { authenticatedContext: { ...context, owner_id: 'foreign-owner' } }), false,
      'A previously validated immutable set cannot bypass a different authenticated owner/context');
    assert.equal(successor.validateActivitySet(first, { authenticatedParent: { ...parent, plan_revision: parent.plan_revision + 1 } }), false,
      'A cached pure validation cannot bypass the freshly authenticated parent');
    assert.ok(require('../src/lib/immutableOwnJson').immutableOwnJson(successor.predecessorFor(first)));
  });
  assert.equal(first.sessions.length, parent.sessions.length, 'Rest dispositions preserve the exact full-horizon slot inventory');
  assert.deepEqual(first.program_contract, parent.program_contract, 'Goals, requested frequencies, horizon and eligibility are unchanged');
  for (const session of first.sessions.filter(session => !ids.includes(session.session_id))) {
    const previous = parent.sessions.find(item => item.session_id === session.session_id);
    assert.deepEqual(session.steps, previous.steps, 'Every unaffected executable prescription is unchanged');
  }
  assert.equal(successor.rootCandidateHash(first), parent.candidate_hash);
  const combined = require('../src/lib/canonicalCombinedLoad').evaluateActivityCombinedLoad;
  const burden = combined(first, parent, {planningDate:'2026-09-10'});
  assert.equal(burden.valid,true);
  assert.equal(burden.comparison_kind,'FUTURE_PRESCRIPTION_NONINCREASE');
  assert.equal(burden.absolute_observed_plus_future_v3_budget_claimed,false);
  assert.ok(burden.windows.every(window=>window.actual_placed.every((value,index)=>value<=window.source_placed_ceiling[index]+1e-6)
    && window.actual_distance_m<=window.source_distance_m+1e-6 && window.actual_duration_s<=window.source_duration_s));
  assert.equal(combined(first,parent,{planningDate:'2026-09-11'}).valid,false,'Cannot skip an unauthorized opening date');
  assert.equal(combined(first,parent,{planningDate:'2026-09-10',completedIds:parent.sessions.map(session=>session.session_id)}).valid,false,
    'Caller-created completion cannot erase future capacity checks');
  const protectionOptions={parent,successor:first,observationArtifact:observationFor(parent,'2026-09-10'),
    planningDate:'2026-09-10',recentRunLoad:observationFor(parent,'2026-09-10').recent_run_load,
    training_age_class:parent.sessions.find(session=>session.training_age_class)?.training_age_class};
  const validateProtection=require('../src/lib/activityProgramReconciliation').validateFutureProtection;
  assert.equal(validateProtection(protectionOptions).valid,true);
  const pinned=parent.sessions.find(session=>session.session_id===ids[0]);
  for(const manual of [false,true]) {
    const constraint={kind:'session_lock',session_id:pinned.session_id,content_hash:pinned.content_hash,
      session_revision:pinned.session_revision,owner:'athlete',active:true};
    const locked=validateProtection({...protectionOptions,constraints:{locks:manual?[]:[constraint],manual_edits:manual?[constraint]:[]}});
    assert.equal(locked.valid,false,'Fresh athlete locks/manual edits cannot be bypassed by reduction authority');
    assert.ok(locked.reason_codes.includes(manual?'ATHLETE_EDIT_PRESERVED':'ATHLETE_LOCK_CONFLICT'));
  }
  const actualRace=parent.sessions.find(session=>session.workout_family==='race');
  assert.throws(()=>successor.reductionRest(actualRace,{...context,planning_date:actualRace.scheduled_local_date,
    observed_at:actualRace.scheduled_local_date+'T16:00:00Z',window_start:actualRace.scheduled_local_date,
    window_end:actualRace.scheduled_local_date,expires_at:actualRace.scheduled_local_date+'T23:00:00Z',
    affected_session_ids:[actualRace.session_id]}),/ORIGINAL_INVALID/,'An exact event is not ordinary recovery material');
  const plan = activityProgramReconciliation(fixture.accepted, first);
  const unchangedRun = first.sessions.find(session => session.kind === 'run' && !ids.includes(session.session_id));
  const originalRun = parent.sessions.find(session => session.session_id === unchangedRun.session_id);
  const pastHash = successor.completionPredecessorHashes(plan).get(unchangedRun.session_id);
  assert.ok(pastHash.has(originalRun.content_hash), 'An unchanged prescription retains authenticated predecessor completion identity');
  assert.ok(!pastHash.has(canonicalHash('forged-old-hash')));
  assert.ok(!successor.completionPredecessorHashes(plan).get(ids[0])?.has(parent.sessions.find(session => session.session_id === ids[0]).content_hash),
    'A replaced prescription cannot reuse completion of different material');
  assert.equal(plan.weeks.length, fixture.accepted.weeks.length);
  const weeks = Array.isArray(plan.programReconciliation) ? plan.programReconciliation : plan.programReconciliation.weeks;
  assert.ok(weeks[0].entries.every(entry => entry.outcome === 'DISCLOSED_ADJUSTMENT' && entry.withheld_as_rest === 1));
  assert.ok(plan.weeks[0].days.find(day => day.date === '2026-09-10').sessions.every(session => session.kind === 'rest' && !session.steps.length));
  for (const mutate of [
    value => { value.programReconciliation[0].entries[0].delivered += 1; },
    value => { value.programReconciliation[0].entries[0].withheld_as_rest = 0; },
    value => { value.programReconciliation[0].actual_calendar_occupancy.occupied_dates.push('2026-09-10'); },
  ]) {
    const malformed = structuredClone(plan); mutate(malformed);
    assert.equal(require('../src/lib/activityProgramReconciliation').validateActivityProgramReconciliation(malformed, first), false);
  }
  const secondDate = first.sessions.filter(session => session.scheduled_local_date > '2026-09-10' && session.workout_family !== 'rest')
    .map(session => session.scheduled_local_date).sort()[0];
  const secondIds = first.sessions.filter(session => session.scheduled_local_date === secondDate && session.workout_family !== 'rest')
    .map(session => session.session_id);
  assert.ok(secondIds.length);
  const secondContext = contextFor(first, secondDate, secondIds);
  const second = successor.buildActivityCanonicalSuccessor({ parent: first, context: secondContext, observationArtifact: observationFor(first, secondDate),
    changes: secondIds.map(id => ({ session_id: id, action: 'rest' })) }).canonical;
  assert.equal(canonical.validateCanonicalSessionSet(second).valid, true, 'A second accepted adaptation preserves the first authority through authenticated revision lineage');
  assert.equal(successor.rootCandidateHash(second), parent.candidate_hash);
  assert.deepEqual(successor.predecessorFor(second), first);
  const firstRest = second.sessions.find(session => ids.includes(session.session_id));
  assert.equal(firstRest.activity_plan_lineage.at(-1).parent_set_hash, first.content_hash);
  for (const mutate of [
    value => { value.sessions.find(session => ids.includes(session.session_id)).activity_plan_lineage[0].parent_set_hash = canonicalHash('foreign-parent'); },
    value => { value.activity_adaptation.context.owner_id = 'foreign-owner'; },
    value => { value.activity_adaptation.context.affected_session_ids.push('extra-id'); },
    value => { value.sessions.find(session => secondIds.includes(session.session_id)).scheduled_local_date = '2026-09-13'; },
    value => { value.program_contract.run_days_per_week = 1; },
  ]) {
    const altered = structuredClone(second); mutate(altered);
    altered.sessions.forEach(session => { session.content_hash = canonical.canonicalWorkoutHash(session); });
    altered.session_content_hashes = altered.sessions.map(session => ({ session_id: session.session_id, content_hash: session.content_hash }));
    altered.content_hash = canonical.canonicalSessionSetHash(altered);
    altered.candidate_hash = canonicalHash({ candidate_skeleton_hash: altered.candidate_skeleton_hash, canonical_session_set_hash: altered.content_hash });
    assert.equal(successor.validateActivitySet(altered, { authenticatedParent: first, authenticatedContext: secondContext }), false);
  }
  const secret = 'synthetic-only-observation-signing-key';
  const ticket = tickets.signObservation(context, secret);
  const verification = { ownerId: context.owner_id, assignmentId: context.assignment_id, now: '2026-09-10T16:00:01Z', secret };
  assert.deepEqual(tickets.verifyObservation(ticket, verification), context);
  for (const options of [{ ownerId: 'other' }, { assignmentId: 'other' }, { secret: 'wrong-secret' },
    { now: '2026-09-10T15:59:59Z' }, { now: context.expires_at }, { now: 'not-a-date' }]) {
    assert.equal(tickets.verifyObservation(ticket, { ...verification, ...options }), null);
  }
  assert.equal(tickets.verifyObservation(`${ticket.slice(0, -1)}${ticket.endsWith('0') ? '1' : '0'}`, verification), null);
  assert.equal(tickets.sameFreshObservation(context, { ...context, observed_at: '2026-09-10T16:00:01Z' }), true);
  for (const patch of [{ planning_input_revision: 99 }, { activity_fingerprint: canonicalHash('new-activity') },
    { missed_outcome_fingerprint: canonicalHash('new-missed-outcome') }, { parent_canonical_set_hash: canonicalHash('other-parent') },
    { timezone: 'UTC' }, { planning_date: '2026-09-11' }]) assert.equal(tickets.sameFreshObservation(context, { ...context, ...patch }), false);
}
console.log('ACTIVITY CANONICAL SUCCESSOR SMOKE OK: full 4/4 + 7/7, two accepted revisions, immutable parent, exact disposition counts, ticket and lineage negatives');
