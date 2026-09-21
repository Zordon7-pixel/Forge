// Real route/SQLite witnesses plus independently generated canonical calendar.
const assert = require('node:assert/strict');
const f = require('./raceAvailabilityApply.smoke');
const { fixture } = require('./adaptiveCoachingSolver.smoke');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const calendar = require('../src/lib/adaptiveCoachingCalendar');
const { normalizeSolverConstraints, validateAdaptivePlacement } = require('../src/lib/adaptiveCoachingValidation');
const { addDays, canonicalHash } = require('../src/lib/racePlanPolicy');
const { validateCanonicalSessionSet } = require('../src/lib/canonicalWorkout');
const shadow = require('../src/lib/adaptiveCoachingShadow');
async function positiveRoute(athlete) {
  // Independent supported event/history fixture. These recorded actuals are
  // explicit synthetic inputs, never copied from a generated prescription.
  for (const offset of [1, 3, 5, 6]) f.db.prepare("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,created_at) VALUES (?,?,?,'easy',6,3600,?)")
    .run(`supported-easy-${offset}`, athlete.owner, addDays(f.DATE, -offset), `${addDays(f.DATE, -offset)}T14:00:00Z`);
  f.db.prepare("INSERT INTO race_events(id,user_id,race_name,race_date,event_local_date,event_timezone,distance_miles,goal_time_seconds,event_kind) VALUES ('compressed-road',?,'Synthetic supported road','2026-10-11','2026-10-11','America/New_York',3.1,1800,'run_race')").run(athlete.owner);
  const shortRequest = { ...athlete.req, race_ids: ['compressed-road'], target: { ...athlete.req.target, runDaysPerWeek: 3, liftDaysPerWeek: 0, liftingEnabled: false } };
  const review = await f.plans.previewPlanForUser(athlete.owner, shortRequest, f.options('preview'));
  assert.equal(review.plan.candidate_window_end_local, '2026-10-11');
  assert.equal(review.surfaceManifest.apply_disabled, true);
  assert.equal(review.surfaceManifest.surface_capability, 'PREVIEW_ONLY');
  assert.equal(review.surfaceManifest.sessions.filter(s => s.workout_family === 'race' && s.event_identity?.race_id === 'compressed-road').length, 1);
  const full = await f.plans.previewPlanForUser(athlete.owner, shortRequest, { goalBackwardDependencies: { ...f.options('on').goalBackwardDependencies, inspectFailure: e => console.error('positive route diagnostic', e.code, e.message, e.details, f.observed().result?.failed_calendar_window) } });
  assert.equal(full.plan.candidate_window_end_local, '2026-10-11');
  assert.equal(full.plan.calendar_windows.length, 4);
  assert.equal(full.surfaceManifest.sessions.filter(s => s.workout_family === 'race' && s.event_identity?.race_id === 'compressed-road' && s.scheduled_local_date === '2026-10-11').length, 1);
  const applied = await f.plans.applyPlanCandidate(athlete.owner, full.id,
    { ...full.applyBindings, candidate_hash: full.candidateHash, choice: 'train_for_target', planning_date_local: f.DATE }, f.options('on'));
  assert.equal(applied.status, 200, JSON.stringify(applied));
  const active = await f.tx.get("SELECT up.*,up.id AS user_plan_id,tp.plan_json FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status='active'", [athlete.owner]);
  const manifest = await f.plans.canonicalSurfaceManifestForActive(athlete.owner, active, f.tx.get);
  assert.equal(manifest.status, 'accepted');
  assert.deepEqual(manifest.sessions, full.surfaceManifest.sessions);
  console.log('22-day owned 5K ON generate/apply/accepted surface', full.candidateHash);

}
async function main() {
  const input = fixture(3, 0, 600);
  input.stateOptions.weeks = []; // Unknown coverage remains unknown; no fabricated completed weeks.
  input.goals = [{ goal_id: 'road', race_id: 'road', athlete_id: input.snapshot.athlete_id,
    event_kind: 'ROAD_SHORT', distance_miles: 6.2, event_local_date: '2026-10-04', event_state: 'SCHEDULED' }];
  input.races = [{ race_id: 'road', athlete_id: input.snapshot.athlete_id }];
  const foundation = buildAdaptiveCoachingFoundation(input);
  const evidenceBefore = canonicalHash(foundation);
  const window = calendar.resolveWindow('2026-09-14', ['2026-10-04']);
  const availability = { run: Array.from({ length: 21 }, (_, i) => ({
    start_at: `${addDays(window.start_date, i)}T06:00:00Z`, end_at: `${addDays(window.start_date, i)}T23:00:00Z` })), lift: [] };
  const result = calendar.buildProgram({ foundation, availability, calendarWindow: window });
  assert.equal(result.applicable, true);
  assert.equal(validateCanonicalSessionSet(result.selected_candidate.canonical_session_set).valid, true);
  assert.deepEqual(result.decision.calendar_windows.map(w => w.phase), ['FOUNDATION', 'FOUNDATION', 'TAPER_RACE_WEEK']);
  assert.equal(canonicalHash(foundation), evidenceBefore);
  const sessions = result.selected_candidate.sessions;
  assert.equal(new Set(sessions.map(s => s.scheduled_local_date)).size, 21);
  assert.equal(sessions.filter(s => s.workout_family === 'race').length, 1);
  assert.equal(sessions.find(s => s.workout_family === 'race').event_identity.race_id, 'road');
  assert.equal(sessions.find(s => s.workout_family === 'race').scheduled_local_date, window.end_date);
  for (const w of result.decision.calendar_windows) {
    assert.ok(sessions.filter(s => s.kind === 'run' && s.scheduled_local_date >= w.start_date && s.scheduled_local_date <= w.end_date).length <= 3);
  }
  result.artifacts.forEach(a => assert.equal(require('../src/lib/goalBackwardContracts').validatePipelineArtifact(a).valid, true));
  const allDates = { run: Array.from({ length: 42 }, (_, i) => [6, 17].map(h => ({ start_at: `${addDays(window.start_date, i)}T${h}:00:00Z`.replace('T6:', 'T06:'), end_at: `${addDays(window.start_date, i)}T23:00:00Z` }))).flat(), lift: [] };
  const maximum = calendar.resolveWindow(window.start_date, [addDays(window.start_date, 41)]);
  assert.equal(normalizeSolverConstraints(foundation.athlete_state, allDates, maximum).run.length, 84);
  const maximumFoundation = buildAdaptiveCoachingFoundation({ ...input,
    goals: input.goals.map(g => ({ ...g, event_local_date: maximum.end_date })) });
  const maximumResult = calendar.buildProgram({ foundation: maximumFoundation, calendarWindow: maximum,
    availability: { ...allDates, run: allDates.run.filter(w => w.start_at.includes('T06:')) } });
  assert.equal(maximumResult.applicable, true);
  assert.equal(new Set(maximumResult.selected_candidate.sessions.map(s => s.scheduled_local_date)).size, 42);
  assert.equal(maximumResult.selected_candidate.sessions.filter(s => s.workout_family === 'race' && s.scheduled_local_date === maximum.end_date).length, 1);
  assert.equal(validateCanonicalSessionSet(maximumResult.selected_candidate.canonical_session_set).valid, true);
  assert.equal(normalizeSolverConstraints(foundation.athlete_state, { ...allDates,
    blocked_dates: Array.from({ length: 42 }, (_, i) => addDays(maximum.start_date, i)) }, maximum).blocked_dates.length, 42);
  console.log('generated maximum 42-day calendar', maximumResult.selected_candidate.candidate_hash);
  assert.throws(() => normalizeSolverConstraints(foundation.athlete_state, { ...allDates, run: [...allDates.run, allDates.run[0]] }, maximum));
  assert.throws(() => calendar.resolveWindow(window.start_date, [addDays(window.start_date, 42)]), { code: 'RACE_CALENDAR_HORIZON_UNSUPPORTED' });
  assert.throws(() => calendar.buildProgram({ foundation, availability, calendarWindow: { ...window, end_date: '2026-10-03', day_count: 20 } }), /owned event/);
  // Rolling capacity is independent of calendar-week reset and observed evidence.
  const last = result.decision.calendar_windows[2];
  const constraint = normalizeSolverConstraints(foundation.athlete_state, { run: availability.run.filter(w => w.start_at.slice(0, 10) >= last.start_date), lift: [],
    planned_sessions: sessions.filter(s => s.workout_family !== 'rest' && s.scheduled_local_date < last.start_date && s.scheduled_local_date >= addDays(last.start_date, -6)),
    rolling_policy: { ...result.decision.calendar_windows[0].weekly_objectives, capacities: { run: 0, lift: 0 } } },
  { start_date: last.start_date, end_date: last.end_date });
  assert.ok(validateAdaptivePlacement([], constraint, foundation.athlete_state, last.weekly_objectives).violations.some(v => v.code === 'FREQUENCY_IS_CAPACITY'));
  console.log('generated 21-day calendar', result.selected_candidate.candidate_hash, 'phases FOUNDATION/FOUNDATION/TAPER_RACE_WEEK; exact road race 2026-10-04');

  const athlete = await f.armyFixture();
  if (process.argv.includes('--route-positive')) return positiveRoute(athlete);
  for (const mode of ['preview', 'on']) {
    const before = f.snapshot();
    await assert.rejects(f.plans.previewPlanForUser(athlete.owner, { ...athlete.req, target: { ...athlete.req.target, raceDate: '2026-09-20' } }, f.options(mode)), e => {
      assert.equal(e.code, 'GOAL_BACKWARD_GENERATION_FAILED');
      assert.equal(e.details.reason_code, 'MEANINGFUL_DOSE_REQUIRED');
      assert.match(e.message, /active plan was not changed/i);
      return true;
    });
    assert.deepEqual(f.snapshot(), before);
    const { prepared, result: actual } = f.observed();
    assert.deepEqual(prepared.calendarWindow, { start_date: '2026-09-20', end_date: '2026-10-11', day_count: 22 });
    assert.equal(actual.failed_calendar_window.end_date, '2026-10-11');
    assert.equal(actual.calendar_windows.length, 4);
    assert.equal(new Set(prepared.availability.lift.map(w => require('../src/lib/adaptiveCoachingValidation').localDate(w.start_at, 'America/New_York'))).size, 22);
    console.log('Army', mode, actual.status, 'MEANINGFUL_DOSE_REQUIRED at', actual.failed_calendar_window.start_date, 'through', actual.failed_calendar_window.end_date);
  }
  const before = f.snapshot();
  f.db.prepare("UPDATE race_events SET race_date='2026-11-01',event_local_date='2026-11-01' WHERE id='army' AND user_id=?").run(athlete.owner);
  const beyondBefore = f.snapshot();
  for (const mode of ['preview', 'on']) await assert.rejects(f.plans.previewPlanForUser(athlete.owner, athlete.req, f.options(mode)), e => {
    assert.deepEqual(e.details, { reason_code: 'RACE_CALENDAR_HORIZON_UNSUPPORTED', planning_date_local: f.DATE,
      requested_end_date: '2026-11-01', supported_end_date: '2026-10-31' });
    return true;
  });
  assert.deepEqual(f.snapshot(), beyondBefore);
  f.db.prepare("UPDATE race_events SET race_date='2026-09-26',event_local_date='2026-09-26' WHERE id='army' AND user_id=?").run(athlete.owner);
  const boundaryBefore = f.snapshot();
  await assert.rejects(f.plans.previewPlanForUser(athlete.owner, athlete.req, f.options('on')), e => {
    assert.equal(e.code, 'GOAL_BACKWARD_GENERATION_FAILED');
    assert.ok(require('../src/lib/adaptiveCoachingPreview').publicGenerationFailure({ code: e.details.reason_code }));
    assert.notEqual(e.details.reason_code, 'RACE_CALENDAR_HORIZON_UNSUPPORTED');
    console.log('old +6 boundary', e.details.reason_code); return true;
  });
  assert.deepEqual(f.snapshot(), boundaryBefore);
  f.db.prepare("UPDATE race_events SET race_date='2026-10-11',event_local_date='2026-10-11' WHERE id='army' AND user_id=?").run(athlete.owner);
  assert.deepEqual(f.snapshot(), before);
  const weekly = { ...athlete.req, race_ids: [] };
  const preview = await f.plans.previewPlanForUser(athlete.owner, weekly, f.options('preview'));
  assert.equal(preview.surfaceManifest.apply_disabled, true);
  const on = await f.plans.previewPlanForUser(athlete.owner, weekly, f.options('on'));
  assert.deepEqual(['run', 'lift'].map(kind => on.surfaceManifest.sessions.filter(s => s.kind === kind).length), [4, 4]);
  assert.equal(f.observed().prepared.calendarWindow.day_count, 7);
  const body = { ...on.applyBindings, candidate_hash: on.candidateHash, choice: 'train_for_target', planning_date_local: f.DATE };
  const stored = f.db.prepare('SELECT planning_snapshot_json FROM plan_generation_candidates WHERE id=?').get(on.id).planning_snapshot_json;
  const legacy = JSON.parse(stored); legacy.request.race_ids = ['army'];
  f.db.prepare('UPDATE plan_generation_candidates SET planning_snapshot_json=? WHERE id=? AND user_id=?').run(JSON.stringify(legacy), on.id, athlete.owner);
  const legacyBefore = f.snapshot(), compute = shadow.compute;
  let calls = 0; shadow.compute = p => { calls++; return compute(p); };
  try {
    const rejected = await f.plans.applyPlanCandidate(athlete.owner, on.id, body, f.options('on'));
    assert.equal(rejected.details.reason_code, 'CANDIDATE_WINDOW_STALE');
    assert.equal(calls, 0); assert.deepEqual(f.snapshot(), legacyBefore);
  } finally { shadow.compute = compute; }
  f.db.prepare('UPDATE plan_generation_candidates SET planning_snapshot_json=? WHERE id=? AND user_id=?').run(stored, on.id, athlete.owner);
  assert.equal((await f.plans.applyPlanCandidate(athlete.owner, on.id, body, f.options('on'))).status, 200);
  console.log('42-day cap, old +6 evidence gate, legacy precompute rejection, PREVIEW permissions, weekly 4+4 ON apply passed');

}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(f.close);
