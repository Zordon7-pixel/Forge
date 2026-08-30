// Forged Hybrid H5 — framework-free smoke for the shared daily-execution
// normalizer. Run: node frontend/test/dailyExecution.smoke.mjs
// Imports the dependency-free core (no axios/api) so it runs under plain node.

import {
  localDateISO,
  normalizeExecution,
  isRestSession,
  isRestExecutionAuthority,
  executionHasSession,
  executionAllowsSession,
  hasExecutableSession,
  formatHrZone,
  completionBody,
  scheduledRunFromExecution,
  scheduledLiftFromExecution,
  recommendationFromExecution,
  runRouteState,
  unplannedRunRouteState,
  makeupRunRouteState,
  planSessionIdFromState,
  currentWeekFromState,
  isRetryableCompletionFailure,
} from '../src/lib/dailyExecutionCore.js';
import {
  resolveTodayPlanAccess,
  workoutStartDecision,
} from '../src/lib/todayPlanAccess.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${msg}`); }
}

const hybridBody = {
  today: { day: 'Mon', date: '2026-07-13', type: 'run' },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: false,
    mode: 'hybrid_maintain',
    phase: 'base',
    week: 1,
    goal: { name: 'Army Ten-Miler', distanceMiles: 10 },
    orderGuidance: 'Run first; lift 6h later',
    status: 'planned',
    date: '2026-07-13',
    day: 'Mon',
    sessions: [
      { id: 'run-1', kind: 'run', workout_type: 'easy', distance_miles: 4, target_zone: 'Z2', completed: false, hrZone: { zone: 2, label: 'Easy', minBpm: 134, maxBpm: 148, model: 'hrr', source: 'calibrated' } },
      { id: 'lift-1', kind: 'lift', title: 'Lower', sets: 3, reps: 5, completed: true, },
    ],
    run: { id: 'run-1', kind: 'run', target_zone: 'Z2', completed: false, hrZone: { zone: 2, label: 'Easy', minBpm: 134, maxBpm: 148 } },
    lift: { id: 'lift-1', kind: 'lift', completed: true },
  },
};

const restBody = { today: { day: 'Wed', date: '2026-07-15', type: 'rest', rest: true }, execution: { hasPlan: true, hasDay: true, isRest: true, isPlannedRest: true, restSource: 'planned', mode: 'hybrid_maintain', sessions: [], run: null, lift: null, date: '2026-07-15' } };
const removedBody = { today: { day: 'Wed', date: '2026-07-15', type: 'rest', workout_type: 'rest', status: 'removed', sessions: [] }, execution: { hasPlan: true, hasDay: true, isRest: true, isPlannedRest: false, restSource: 'removed', mode: 'hybrid_maintain', type: 'rest', workout_type: 'rest', status: 'removed', checkinOverride: null, sessions: [], run: null, lift: null, date: '2026-07-15' } };
const noPlanBody = { today: null, execution: { hasPlan: false, hasDay: false, date: '2026-07-13' } };
const checkinRecoveryBody = {
  today: { day: 'Thu', date: '2026-08-14', type: 'rest' },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: false,
    isPlannedRest: false,
    restSource: null,
    week: 1,
    sessions: [{
      id: 'run-rest-override',
      kind: 'run',
      type: 'rest',
      workout_type: 'rest',
      title: 'Rest day',
      description: "Rest day from today's check-in.",
      completed: false,
    }],
    run: {
      id: 'run-rest-override',
      kind: 'run',
      type: 'rest',
      workout_type: 'rest',
      title: 'Rest day',
      description: "Rest day from today's check-in.",
      completed: false,
    },
    lift: null,
  },
};
const legacyCheckinRecoveryBody = {
  today: {
    day: 'Thu',
    date: '2026-08-14',
    type: 'rest',
    workout_type: 'rest',
    description: "Recovery is today's guidance.",
    checkin_override: { action: 'rest', label: 'Changed to rest from daily check-in' },
  },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: true,
    isPlannedRest: false,
    restSource: null,
    week: 1,
    type: 'rest',
    workout_type: 'rest',
    checkinOverride: { action: 'rest', label: 'Changed to rest from daily check-in' },
    sessions: [],
    run: null,
    lift: null,
  },
};
const minimumEffectiveRecoveryBody = {
  today: { day: 'Sun', date: '2026-08-30', type: 'rest', rest: true, sessions: [] },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: true,
    isPlannedRest: true,
    restSource: 'planned',
    sessions: [],
    run: null,
    lift: null,
    recoveryGuidance: {
      id: 'token-quality-run',
      kind: 'rest',
      type: 'rest',
      workout_type: 'rest',
      title: 'Rest, easy walking, or mobility',
      description: 'Missed-session history supports recovery. The reduced dose would not deliver the intended recovery session, so Forge does not label a token run as productive.',
      distance_miles: 0,
      recovery_alternative: {
        policy: 'minimum_effective_recovery_session_v1',
        minimum_run_minutes: 20,
        minimum_run_miles: 1.5,
        reduced_run_minutes: 11,
        reduced_run_miles: 0.8,
      },
    },
  },
};
const minimumEffectiveRecoveryWithLiftBody = {
  today: { day: 'Sun', date: '2026-08-30', type: 'strength', sessions: [] },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: false,
    isPlannedRest: false,
    restSource: null,
    sessions: [{ id: 'source-bound-lift', kind: 'lift', type: 'strength', title: 'Strength maintenance', completed: false }],
    run: null,
    lift: { id: 'source-bound-lift', kind: 'lift', type: 'strength', title: 'Strength maintenance', completed: false },
    // Defensive stale-server fixture: current backend omits this terminal field
    // whenever an executable sibling remains.
    recoveryGuidance: minimumEffectiveRecoveryBody.execution.recoveryGuidance,
  },
};

console.log('\n== normalizeExecution (hybrid) ==');
const h = normalizeExecution(hybridBody);
assert(h.hasPlan && h.hasDay && !h.isRest, 'hybrid day flagged executable');
assert(h.sessions.length === 2 && h.run.id === 'run-1' && h.lift.id === 'lift-1', 'both run+lift sessions with stable ids');
assert(h.mode === 'hybrid_maintain' && h.phase === 'base' && h.week === 1, 'mode/phase/week context normalized');
assert(h.goal && h.goal.name === 'Army Ten-Miler', 'goal preserved');
assert(h.legacyToday && h.legacyToday.date === '2026-07-13', 'legacy today passed through');
assert(hasExecutableSession(h) === true, 'hasExecutableSession true for hybrid day');

console.log('\n== rest + no-plan ==');
const r = normalizeExecution(restBody);
assert(r.hasDay && r.isRest && r.sessions.length === 0 && !r.run && !r.lift, 'rest day yields no run/lift');
assert(r.isPlannedRest && r.restSource === 'planned', 'scheduled rest provenance survives normalization');
assert(hasExecutableSession(r) === false, 'rest day is not executable');
const n = normalizeExecution(noPlanBody);
assert(!n.hasPlan && !n.hasDay && n.sessions.length === 0, 'no-plan normalizes safely');
assert(hasExecutableSession(n) === false, 'no-plan not executable → recommendation fallback');
assert(normalizeExecution(null).hasPlan === false, 'null body normalizes without throwing');
const recovery = normalizeExecution(checkinRecoveryBody);
assert(isRestSession(recovery.run) === true, 'rest prescription overrides retained run-slot kind');
assert(hasExecutableSession(recovery) === false, 'check-in recovery guidance is never executable');
assert(isRestExecutionAuthority(recovery) === true, 'rest-labelled session is a current-day safety-rest authority');

console.log('\n== formatHrZone ==');
assert(formatHrZone(h.run) === 'Zone 2 · 134-148 bpm', 'calibrated bpm band rendered');
assert(formatHrZone({ target_zone: 'Z3' }) === 'Zone 3', 'no profile → plain zone label');
assert(formatHrZone({ target_zone: 'Z2-3' }) === 'Zone 2-3', 'zone range stays readable and never collapses to Zone 23');
assert(formatHrZone({ target_zone: 'Zone 3-4', hrZone: { zone: '3-4', zoneLabel: 'Zone 3-4', minBpm: 149, maxBpm: 176 } }) === 'Zone 3-4 · 149-176 bpm', 'calibrated zone range renders its full label');
assert(formatHrZone({ target_zone: 'Zone 4', hrZone: null }) === 'Zone 4', 'null hrZone → plain label, no invented bpm');
assert(formatHrZone({}) === null, 'no zone info → null');

console.log('\n== localDateISO + completionBody ==');
assert(/^\d{4}-\d{2}-\d{2}$/.test(localDateISO(new Date('2026-07-13T23:30:00'))), 'localDateISO returns YYYY-MM-DD');
assert(localDateISO(new Date(2026, 6, 5)) === '2026-07-05', 'localDateISO pads month/day and stays local');
const body = completionBody('run-1', 2);
assert(body.completed_session_id === 'run-1' && body.current_week === 2, 'completion body carries session id + week');
assert(completionBody('run-1').current_week === undefined, 'completion body omits week when not finite');
assert(completionBody('run-1', null).current_week === undefined, 'completion body never coerces null to week zero');
assert(completionBody('run-1', 0).current_week === undefined, 'completion body rejects week zero');

console.log('\n== scheduled run/lift extractors (calendar preference) ==');
assert(scheduledRunFromExecution(h) && scheduledRunFromExecution(h).id === 'run-1', 'scheduledRunFromExecution returns the executable run');
assert(scheduledLiftFromExecution(h) === null, 'scheduledLiftFromExecution excludes a completed lift');
assert(scheduledRunFromExecution(r) === null, 'rest day yields no scheduled run');
assert(scheduledLiftFromExecution(r) === null, 'rest day yields no scheduled lift');
assert(scheduledRunFromExecution(n) === null, 'no-plan yields no scheduled run');
assert(scheduledRunFromExecution(recovery) === null, 'rest-labelled run slot never becomes a scheduled run');
assert(scheduledLiftFromExecution(recovery) === null, 'recovery guidance never exposes a lift handoff');

console.log('\n== recommendationFromExecution (calendar vs fallback) ==');
const calRec = recommendationFromExecution(h);
assert(calRec && calRec.source === 'calendar', 'calendar recommendation is flagged source=calendar');
assert(calRec.recommendationType === 'run' && calRec.planSessionId === 'run-1', 'run preferred; carries planSessionId');
assert(calRec.targetZone === 'Z2', 'targetZone taken from the scheduled run');
const restRec = recommendationFromExecution(r);
assert(restRec && restRec.source === 'calendar' && restRec.recommendationType === 'rest', 'calendar rest stays explicit instead of falling back to an unrelated workout');
const removed = normalizeExecution(removedBody);
assert(removed.isRest && !removed.isPlannedRest && removed.restSource === 'removed', 'removed-empty day retains distinct provenance');
assert(recommendationFromExecution(removed) === null, 'removed-empty day cannot masquerade as planned rest');
assert(isRestExecutionAuthority(removed) === false, 'removed-empty day cannot masquerade as check-in recovery authority');
assert(recommendationFromExecution(n) === null, 'no-plan → null so callers fall back to next-recommendation');
const recoveryRec = recommendationFromExecution(recovery);
assert(recoveryRec?.type === 'rest' && recoveryRec?.recommendationType === 'rest', 'rest-labelled slot remains explicit recovery guidance');
assert(recoveryRec?.reason === "Rest day from today's check-in.", 'recovery guidance preserves the safety explanation');
const legacyRecovery = normalizeExecution(legacyCheckinRecoveryBody);
const legacyRecoveryRec = recommendationFromExecution(legacyRecovery);
assert(isRestExecutionAuthority(legacyRecovery) === true, 'legacy empty check-in rest remains canonical rest authority');
assert(legacyRecoveryRec?.type === 'rest' && legacyRecoveryRec?.recommendationType === 'rest', 'legacy empty check-in rest remains truthful recovery guidance');
assert(legacyRecoveryRec?.reason === 'Changed to rest from daily check-in', 'legacy empty check-in rest preserves its check-in reason');
const minimumEffectiveRecovery = normalizeExecution(minimumEffectiveRecoveryBody);
const minimumEffectiveRecoveryRec = recommendationFromExecution(minimumEffectiveRecovery);
assert(minimumEffectiveRecovery.recoveryGuidance?.recovery_alternative?.minimum_run_minutes === 20, 'reviewed minimum-effective recovery guidance survives normalization');
assert(isRestExecutionAuthority(minimumEffectiveRecovery) === true, 'reviewed recovery alternative remains non-executable rest authority');
assert(minimumEffectiveRecoveryRec?.recommendationType === 'rest', 'reviewed recovery alternative stays a rest recommendation');
assert(/Rest, easy walking, or mobility/.test(minimumEffectiveRecoveryRec?.reason || ''), 'reviewed alternatives remain visible in customer guidance');
assert(/reduced dose would not deliver/.test(minimumEffectiveRecoveryRec?.reason || ''), 'the source-bound recovery explanation remains visible');
assert(!/0\.8\s*mi|11\s*min/i.test(minimumEffectiveRecoveryRec?.reason || ''), 'the rejected token dose is never presented as the workout');
const minimumEffectiveRecoveryWithLift = normalizeExecution(minimumEffectiveRecoveryWithLiftBody);
const minimumEffectiveRecoveryWithLiftRec = recommendationFromExecution(minimumEffectiveRecoveryWithLift);
assert(minimumEffectiveRecoveryWithLift.recoveryGuidance === null, 'terminal recovery guidance is discarded when a non-rest sibling remains visible');
assert(isRestExecutionAuthority(minimumEffectiveRecoveryWithLift) === false, 'a run alternative cannot relabel its lift sibling as terminal rest');
assert(hasExecutableSession(minimumEffectiveRecoveryWithLift) === true, 'the surviving lift remains executable');
assert(minimumEffectiveRecoveryWithLiftRec?.recommendationType === 'strength', 'the surviving lift remains today\'s recommendation');
assert(scheduledLiftFromExecution(minimumEffectiveRecoveryWithLift)?.id === 'source-bound-lift', 'the surviving lift keeps its exact plan handoff');
const stepsRec = recommendationFromExecution(normalizeExecution({ execution: { hasPlan: true, hasDay: true, isRest: false, sessions: [], run: { id: 'run-steps', kind: 'run', steps: ['Warm up', '3 x 5 min', 'Cool down'] } } }));
assert(stepsRec && stepsRec.structure.length === 3, 'run steps remain visible when structure is absent');
const liftOnly = normalizeExecution({ execution: { hasPlan: true, hasDay: true, isRest: false, week: 3, sessions: [{ id: 'lift-9', kind: 'lift', title: 'Upper' }], run: null, lift: { id: 'lift-9', kind: 'lift', title: 'Upper' } } });
const liftRec = recommendationFromExecution(liftOnly);
assert(liftRec && liftRec.recommendationType === 'strength' && liftRec.planSessionId === 'lift-9', 'lift-only day → strength recommendation with lift session id');
const staleLiftAfterRestDirective = normalizeExecution({
  today: {
    type: 'rest',
    workout_type: 'rest',
    checkin_override: { action: 'rest', label: 'Changed to rest from daily check-in' },
  },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: false,
    type: 'rest',
    workout_type: 'rest',
    checkinOverride: { action: 'rest', label: 'Changed to rest from daily check-in' },
    sessions: [{ id: 'lift-stale', kind: 'lift', type: 'strength', title: 'Strength maintenance', completed: false }],
    run: null,
    lift: { id: 'lift-stale', kind: 'lift', type: 'strength', title: 'Strength maintenance', completed: false },
  },
});
assert(hasExecutableSession(staleLiftAfterRestDirective) === false, 'day-level safety rest fails closed even if a stale lift session is still strength');
assert(isRestExecutionAuthority(staleLiftAfterRestDirective) === true, 'day-level check-in rest is canonical even when its retained lift payload says strength');
assert(executionHasSession(staleLiftAfterRestDirective, { id: 'lift-stale', kind: 'lift' }, 'lift') === false, 'safety-rest authority never recognizes its stale retained lift as actionable plan truth');
assert(executionAllowsSession(staleLiftAfterRestDirective, { id: 'lift-stale', kind: 'lift' }, 'lift') === false, 'stale retained lift cannot pass the current-day execution gate');
assert(scheduledLiftFromExecution(staleLiftAfterRestDirective) === null, 'day-level safety rest never exposes a stale lift handoff');
assert(recommendationFromExecution(staleLiftAfterRestDirective)?.type === 'rest', 'day-level safety rest remains recovery guidance with stale session data');
const liftPendingAfterRun = normalizeExecution({ execution: {
  hasPlan: true,
  hasDay: true,
  isRest: false,
  week: 3,
  sessions: [{ id: 'run-done', kind: 'run', completed: true }, { id: 'lift-next', kind: 'lift', completed: false }],
  run: { id: 'run-done', kind: 'run', completed: true },
  lift: { id: 'lift-next', kind: 'lift', completed: false },
} });
assert(hasExecutableSession(liftPendingAfterRun) === true, 'hybrid day stays executable while the lift remains unfinished');
assert(scheduledRunFromExecution(liftPendingAfterRun) === null, 'completed run cannot reopen from Today');
assert(scheduledLiftFromExecution(liftPendingAfterRun)?.id === 'lift-next', 'unfinished lift becomes the next executable session');
assert(recommendationFromExecution(liftPendingAfterRun)?.recommendationType === 'strength', 'Today recommends the pending lift after the run is complete');
assert(executionHasSession(liftPendingAfterRun, { id: 'run-done', kind: 'run' }, 'run') === true, 'completed canonical run remains recognized for reversible review');
assert(executionAllowsSession(liftPendingAfterRun, { id: 'run-done', kind: 'run' }, 'run') === false, 'completed canonical run cannot reopen start or export actions');
assert(executionAllowsSession(liftPendingAfterRun, { id: 'lift-next', kind: 'lift' }, 'lift') === true, 'exact unfinished canonical lift remains executable');
assert(executionAllowsSession(liftPendingAfterRun, { id: 'lift-stale', kind: 'lift' }, 'lift') === false, 'noncanonical stale lift id fails closed');
assert(executionAllowsSession(liftPendingAfterRun, { id: 'lift-next', kind: 'run' }, 'run') === false, 'session kind must match the canonical execution');
const allComplete = normalizeExecution({ execution: {
  hasPlan: true,
  hasDay: true,
  isRest: false,
  sessions: [{ id: 'run-done', kind: 'run', completed: true }, { id: 'lift-done', kind: 'lift', completed: true }],
  run: { id: 'run-done', kind: 'run', completed: true },
  lift: { id: 'lift-done', kind: 'lift', completed: true },
} });
assert(hasExecutableSession(allComplete) === false, 'fully completed day has no executable session');
assert(recommendationFromExecution(allComplete) === null, 'fully completed day cannot create a new start recommendation');

console.log('\n== runRouteState + state readers ==');
const rs = runRouteState(h);
assert(rs && rs.planSessionId === 'run-1' && rs.currentWeek === 1, 'runRouteState carries planSessionId + week');
assert(rs.scheduledRun && rs.scheduledRun.id === 'run-1', 'runRouteState embeds the scheduled run');
assert(rs.prescription && rs.prescription.zone === 'Z2', 'runRouteState prescription carries the plan zone');
assert(runRouteState(r) === null && runRouteState(n) === null, 'no executable run → null route state');
assert(runRouteState(recovery) === null, 'rest-labelled run cannot create a warm-up or active-run route');
const unplanned = unplannedRunRouteState({ countdown: 5, runType: 'tempo', surface: 'track' });
assert(unplanned.source === 'unplanned' && unplanned.planSessionId === null && unplanned.currentWeek === null, 'unplanned run has no plan linkage');
assert(unplanned.startAfterWarmup && unplanned.mapMyRun && unplanned.trackMode, 'unplanned outdoor run preserves warm-up and route capture');
assert(planSessionIdFromState(unplanned) === null, 'unplanned run can never resolve a plan session id');

const makeup = makeupRunRouteState({
  sessionId: 'mon-run',
  date: '2026-07-20',
  distance: 4,
  raw: { id: 'mon-run', kind: 'run', type: 'tempo', pace_target: '9:00/mi', target_zone: 'Zone 3' },
}, { environment: 'indoor', treadmillBrand: 'Peloton' });
assert(makeup.source === 'makeup' && makeup.planSessionId === 'mon-run', 'make-up run preserves the exact missed session id');
assert(makeup.runEnvironment === 'indoor' && makeup.surface === 'treadmill' && makeup.mapMyRun === false, 'make-up run supports indoor manual-distance capture');
assert(makeup.workoutTarget.distanceMiles === 4 && makeup.workoutTarget.zone === 'Zone 3', 'make-up run carries the original prescription');
assert(makeupRunRouteState(null) === null, 'make-up run rejects a missing session');
assert(planSessionIdFromState({ planSessionId: 42 }) === '42', 'planSessionIdFromState stringifies planSessionId');
assert(planSessionIdFromState({ scheduledRun: { id: 'run-7' } }) === 'run-7', 'planSessionIdFromState falls back to scheduledRun.id');
assert(planSessionIdFromState({ planSessionId: null, scheduledRun: { id: 'group-run-7' } }) === null, 'an explicit null plan id never falls back to a synthetic scheduled-run id');
assert(planSessionIdFromState({ source: 'group_run', planSessionId: 'bad-plan-id', scheduledRun: { id: 'group-run-7' } }) === null, 'group-run provenance can never resolve to plan progress');
assert(planSessionIdFromState(null) === null && planSessionIdFromState({}) === null, 'planSessionIdFromState null-safe');
assert(currentWeekFromState({ currentWeek: '4' }) === 4, 'currentWeekFromState coerces finite numbers');
assert(currentWeekFromState({ currentWeek: 'nope' }) === null && currentWeekFromState(null) === null, 'currentWeekFromState rejects non-finite / null');
assert(currentWeekFromState({ currentWeek: null }) === null && currentWeekFromState({ currentWeek: 0 }) === null, 'currentWeekFromState never emits week zero');

console.log('\n== completion retry policy ==');
assert(isRetryableCompletionFailure(new Error('offline')) === true, 'network completion failure is retryable');
assert(isRetryableCompletionFailure({ response: { status: 503 } }) === true, 'server completion failure is retryable');
assert(isRetryableCompletionFailure({ response: { status: 400 } }) === false, 'deterministic 4xx completion failure is not queued forever');

console.log('\n== v2.4 fail-closed workout starts ==');
const manifestIdentity = {
  plan_id: 'plan-start-1',
  plan_revision: 4,
  athlete_state_revision: 8,
  safety_state_hash: `sha256:${'a'.repeat(64)}`,
};
const startSession = (id, family, overrides = {}) => ({
  session_id: id,
  session_revision: 2,
  plan_id: manifestIdentity.plan_id,
  plan_revision: manifestIdentity.plan_revision,
  workout_family: family,
  executability: 'EXECUTABLE',
  content_hash: 'b'.repeat(64),
  safety_scope: [],
  steps: [],
  ...overrides,
});
const acceptedExecution = (action, sessions) => ({
  hasPlan: true,
  hasDay: true,
  isRest: false,
  sessions,
  run: sessions.find((entry) => entry.workout_family.endsWith('_run')) || null,
  lift: sessions.find((entry) => entry.workout_family.startsWith('strength_')) || null,
  surface: {
    status: 'accepted',
    identity: manifestIdentity,
    manifest: {
      schema_version: 'goal_backward_surface_manifest_v1',
      surface_revision: 5,
      status: 'accepted',
      identity: manifestIdentity,
      safety: { action, scope: [], reason_codes: [action] },
      sessions,
    },
  },
});

const noRunning = acceptedExecution('NO_RUNNING', [
  startSession('run-blocked', 'easy_run', { safety_scope: ['RUN', 'IMPACT'] }),
  startSession('upper-safe', 'strength_upper'),
]);
assert(workoutStartDecision({ execution: noRunning, sessionId: 'run-blocked', activity: { kind: 'run' } }).allowed === false, 'NO_RUNNING blocks the scheduled run start');
const upperDecision = workoutStartDecision({ execution: noRunning, sessionId: 'upper-safe', activity: { kind: 'lift' } });
assert(upperDecision.allowed === true, 'NO_RUNNING leaves unrelated upper-body strength eligible');

const noLower = acceptedExecution('NO_LOWER_BODY', [
  startSession('lower-blocked', 'strength_lower', { safety_scope: ['LOWER_BODY'] }),
  startSession('upper-still-safe', 'strength_upper', { content_hash: 'c'.repeat(64) }),
]);
assert(workoutStartDecision({ execution: noLower, sessionId: 'lower-blocked', activity: { kind: 'lift' } }).allowed === false, 'NO_LOWER_BODY blocks lower-body lifting');
assert(workoutStartDecision({ execution: noLower, sessionId: 'upper-still-safe', activity: { kind: 'lift' } }).allowed === true, 'NO_LOWER_BODY leaves upper-body lifting eligible');

const noIntensity = acceptedExecution('NO_HIGH_INTENSITY', [
  startSession('quality-blocked', 'threshold_run', { steps: [{ target: { rpe: 7 } }] }),
  startSession('easy-safe', 'easy_run', { steps: [{ target: { rpe: 2 } }], content_hash: 'd'.repeat(64) }),
]);
assert(workoutStartDecision({ execution: noIntensity, sessionId: 'quality-blocked', activity: { kind: 'run' } }).allowed === false, 'NO_HIGH_INTENSITY blocks intensity three and above');
assert(workoutStartDecision({ execution: noIntensity, sessionId: 'easy-safe', activity: { kind: 'run' } }).allowed === true, 'NO_HIGH_INTENSITY leaves explicitly easy work eligible');

const modifiedOnly = acceptedExecution('MODIFIED_SESSION_ONLY', [
  startSession('original-blocked', 'hyrox_compromised', { safety_scope: ['RUN', 'LOWER_BODY'] }),
  startSession('modified-safe', 'hyrox_compromised', { explicitly_validated_modified_session: true, content_hash: 'e'.repeat(64) }),
]);
assert(workoutStartDecision({ execution: modifiedOnly, sessionId: 'original-blocked', activity: { kind: 'hybrid' } }).allowed === false, 'MODIFIED_SESSION_ONLY blocks the unmodified hybrid');
assert(workoutStartDecision({ execution: modifiedOnly, sessionId: 'modified-safe', activity: { kind: 'hybrid' } }).allowed === true, 'MODIFIED_SESSION_ONLY permits only the explicitly validated hybrid');

const fullRest = acceptedExecution('FULL_REST', [
  startSession('rest-run', 'easy_run'),
  startSession('rest-lift', 'strength_upper', { content_hash: 'f'.repeat(64) }),
  startSession('rest-hybrid', 'hyrox_station_skill', { content_hash: '1'.repeat(64) }),
]);
for (const [sessionId, kind] of [['rest-run', 'run'], ['rest-lift', 'lift'], ['rest-hybrid', 'hybrid']]) {
  assert(workoutStartDecision({ execution: fullRest, sessionId, activity: { kind } }).allowed === false, `FULL_REST blocks ${kind} start`);
}
assert(workoutStartDecision({ execution: fullRest, activity: { kind: 'run' } }).allowed === false, 'FULL_REST blocks an unplanned run start');

const runDecision = workoutStartDecision({ execution: noIntensity, sessionId: 'easy-safe', activity: { kind: 'run' } });
const liftDecision = workoutStartDecision({ execution: noLower, sessionId: 'upper-still-safe', activity: { kind: 'lift' } });
const hybridDecision = workoutStartDecision({ execution: modifiedOnly, sessionId: 'modified-safe', activity: { kind: 'hybrid' } });
assert(JSON.stringify(Object.keys(runDecision.access.manifest)) === JSON.stringify(Object.keys(liftDecision.access.manifest)), 'run and lift access consume the same manifest binding shape');
assert(JSON.stringify(Object.keys(liftDecision.access.manifest)) === JSON.stringify(Object.keys(hybridDecision.access.manifest)), 'hybrid access consumes the same manifest binding shape');

const staleAccess = structuredClone(runDecision.access);
staleAccess.manifest.athlete_state_revision += 1;
assert(workoutStartDecision({ execution: noIntensity, sessionId: 'easy-safe', activity: { kind: 'run' }, expectedAccess: staleAccess, requireBoundAccess: true }).reasonCode === 'WORKOUT_START_ACCESS_STALE', 'stale safety revision cannot start');
assert(workoutStartDecision({ execution: noIntensity, sessionId: 'easy-safe', activity: { kind: 'run' }, expectedAccess: null, requireBoundAccess: true }).reasonCode === 'WORKOUT_START_ACCESS_MISSING', 'missing safety access cannot start');

const blockedToday = resolveTodayPlanAccess({
  checkedInToday: true,
  calendarSessions: [{ id: 'restricted-run', executability: 'RESTRICTED' }],
  onStartWorkout: () => 'unsafe-start',
  onDetails: () => 'details',
});
assert(blockedToday.primaryLabel === 'View workout' && blockedToday.primaryAction() === 'details', 'Today/Train never exposes Start for a restricted-only day');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H5 FRONTEND SMOKE OK');
