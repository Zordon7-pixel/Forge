// Real route + real SQLite source evidence. No pure-domain outcome substitution.
const assert = require('node:assert/strict');
const { createDb } = require('./helpers/adaptiveShadowDb');
const { addDays } = require('../src/lib/racePlanPolicy');
const source = require('../src/lib/adaptiveCoachingSources');
const shadow = require('../src/lib/adaptiveCoachingShadow');
const fixture = createDb(), { db, tx, hooks, calls } = fixture;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const RealDate = Date, DATE = '2026-09-14', NOW = `${DATE}T12:00:00Z`;
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return RealDate.parse(NOW); } };
const realPrepare = shadow.prepare, realCompute = shadow.compute;
let prepared, result;
shadow.prepare = args => { prepared = realPrepare(args); return prepared; };
shadow.compute = p => { result = realCompute(p); return result; };
const plans = require('../src/routes/plans')._test;
const options = mode => ({ goalBackwardDependencies: { mode, audience: 'all', telemetrySink: () => {} } });
const request = (run, lift, races = []) => ({ planning_date_local: DATE, planning_timezone: 'UTC', timezone_offset_minutes: 0,
  race_ids: races, target: { runDaysPerWeek: run, liftDaysPerWeek: lift, liftingEnabled: lift > 0,
    trainingDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], liftEligibleWeekdays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], maxSessionMinutes: 180 } });
function user(id, age) {
  db.prepare(`INSERT INTO users(id,name,email,password_hash,timezone,training_age_class,preferred_workout_days,planning_input_revision)
    VALUES (?,?,?,'','UTC',?,?,1)`).run(id, 'Synthetic', `${id}@example.invalid`, age, JSON.stringify(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']));
  db.prepare('INSERT INTO daily_checkins(id,user_id,checkin_date,feeling,time_available,created_at) VALUES (?,?,?,?,?,?)')
    .run(`ready-${id}`, id, DATE, 4, 180, NOW);
}
function measurements(id, count, oldest = 1) {
  for (let i = 0; i < count; i++) db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,created_at)
    VALUES (?,?,?,'easy',6,3600,?)`).run(`run-${id}-${i}`, id, addDays(DATE, -oldest-i), `${addDays(DATE, -oldest-i)}T12:00:00Z`);
}
function strength(id) {
  db.prepare(`INSERT INTO workout_sessions(id,user_id,started_at,ended_at,total_seconds,created_at)
    VALUES (?,?,'2026-09-12T10:00:00Z','2026-09-12T11:00:00Z',3600,'2026-09-12T10:00:00Z')`).run(`work-${id}`, id);
  for (let i = 1; i <= 8; i++) db.prepare(`INSERT INTO workout_sets(id,user_id,session_id,exercise_name,set_number,reps,weight_lbs,logged_at)
    VALUES (?,?,?,'Squat',?,8,100,'2026-09-12T10:30:00Z')`).run(`set-${id}-${i}`, id, `work-${id}`, i);
  db.prepare(`INSERT INTO lifts(id,user_id,date,exercise_name,sets,reps,weight_lbs,workout_duration_seconds,created_at)
    VALUES (?,?,'2026-09-11','Bench press',8,8,100,1800,'2026-09-11T11:00:00Z')`).run(`lift-${id}`, id);
}
function race(id, suffix, days, miles, hyrox = false) {
  const key = `race-${id}-${suffix}`, date = addDays(DATE, days);
  db.prepare(`INSERT INTO race_events(id,user_id,race_name,race_date,event_local_date,event_timezone,distance_miles,
    goal_time_seconds,event_kind,event_format,event_category,rules_version) VALUES (?,?,?,?,?,'UTC',?,?,?,?,?,'2026-2027')`)
    .run(key, id, 'Synthetic event', date, date, miles, hyrox ? null : 3600, hyrox ? 'hyrox' : 'run_race', hyrox ? 'doubles' : null, hyrox ? 'men' : null);
  return key;
}
async function main() {
  const rows = [
    ['sparse beginner', 'BEGINNER', 2, 0, 1, 1, []],
    ['developing hybrid', 'DEVELOPING', 3, 2, 20, 1, [[70,6.2]]],
    ['established high frequency', 'ESTABLISHED', 6, 4, 28, 1, []],
    ['returning interrupted', 'ESTABLISHED', 3, 1, 8, 30, []],
    ['timed endurance', 'ESTABLISHED', 5, 2, 28, 1, [[84,13.1094]]],
    ['short runway A race', 'ESTABLISHED', 3, 1, 20, 1, [[5,3.106856]]],
    ['dual goal', 'ESTABLISHED', 4, 2, 28, 1, [[5,3.106856],[70,13.1094]]],
    ['HYROX doubles', 'ESTABLISHED', 4, 2, 28, 1, [[28,4.97097,true]]],
  ];
  for (const [index, [name, age, run, lift, count, oldest, events]] of rows.entries()) {
    const id = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`; user(id, age); measurements(id, count, oldest); if (lift) strength(id);
    const req = request(run, lift, events.map(([days,miles,hyrox], i) => race(id,i,days,miles,hyrox)));
    const plain = await plans.previewPlanForUser(id, req, options('off'));
    prepared = null; result = null;
    const response = await plans.previewPlanForUser(id, req, options('shadow'));
    assert.deepEqual(response.plan, plain.plan); assert.equal(response.candidateHash, plain.candidateHash);
    assert.ok(prepared && result, `${name}: real route reached SHADOW`);
    const artifacts = db.prepare('SELECT * FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?').all(response.id);
    assert.ok(artifacts.length >= 5, `${name}: persisted validated chain`);
    const snapshot = JSON.parse(artifacts.find(a => a.artifact_kind === 'evidence_snapshot').payload_json);
    assert.ok(snapshot.physical_sources); assert.equal(snapshot.physical_sources.coverage_state, 'UNKNOWN');
    const sessions = result.selected_candidate?.sessions || [];
    const week = JSON.parse(artifacts.find(a => a.artifact_kind === 'candidate_week').payload_json);
    assert.equal(week.source_support.priority_authority, 'CURRENT_CHRONOLOGICAL_DEFAULT');
    assert.equal(week.source_support.stored_priority_used, false);
    assert.ok(prepared.foundation.athlete_state.adaptive_foundation.completion_pairs.every(p => p.prescribed_session.kind !== 'lift'));
    const sourceLimited = week.source_support.source_limited;
    // Road strength objectives lack measured caps here. FOUNDATION HYROX
    // asks only for aerobic consistency; absent station work is explicitly
    // unsupported but not required for this week's conservative objective.
    assert.equal(sourceLimited, index > 0 && index < 7);
    if (!sourceLimited) assert.equal(result.applicable, true, 'sparse maintenance schedule is supported');
    if (index === 7) {
      assert.ok(week.source_support.limits.some(l => l.reason_code === 'INDIVIDUAL_DOUBLES_BURDEN_UNKNOWN' && l.required === false && l.status === 'UNSUPPORTED'));
      assert.ok(sessions.every(s => !s.workout_family.startsWith('hyrox_')));
    }
    assert.ok(sessions.filter(s => s.workout_family === 'rest').every(s => s.purpose_reason_codes.length));
    console.log(JSON.stringify({ class: name, phase: result.decision.phase, active_goal_id: result.decision.active_goal_id,
      roles: sessions.map(s => [s.workout_family,s.role]), dose: sessions.map(s => [s.workout_family,s.derived_totals.duration_s,s.derived_totals.distance_m]),
      strength: result.strength_dose_receipt, rest: result.rest_days, feasibility: result.status,
      internal_applicable: result.applicable, source_limited: sourceLimited,
      diagnostics: week.source_support, deferred: result.deferred_objectives }));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_plans').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE artifact_kind='surface_manifest'").get().n, 0);
  const id = '11111111-1111-4111-8111-000000000001', req = request(3,2), args = { tx, userId: id, planningDateISO: DATE, observationInstant: NOW };
  const baseline = await source.loadMeasuredSources(args);
  assert.equal(baseline.sourceFailed, false); assert.equal(baseline.receipt.sessions[0].measured_set_count, 8);
  // A set linked to a foreign session cannot enter this owner's snapshot.
  db.prepare("INSERT INTO workout_sets(id,user_id,session_id,exercise_name,reps,weight_lbs) VALUES ('foreign-link',?,'work-11111111-1111-4111-8111-000000000002','Squat',8,100)").run(id);
  assert.deepEqual(await source.loadMeasuredSources(args), baseline);
  db.prepare("INSERT INTO workout_sets(id,user_id,session_id,exercise_name,reps,weight_lbs) VALUES ('foreign-owner','11111111-1111-4111-8111-000000000002',?,'Squat',8,100)").run(`work-${id}`);
  assert.deepEqual(await source.loadMeasuredSources(args), baseline);
  for (const sql of [
    "UPDATE workout_sets SET reps=NULL WHERE id='set-11111111-1111-4111-8111-000000000001-1'",
    "UPDATE workout_sets SET logged_at='2026-09-15T10:00:00Z' WHERE id='set-11111111-1111-4111-8111-000000000001-1'",
    "UPDATE workout_sets SET set_number=2 WHERE id='set-11111111-1111-4111-8111-000000000001-1'",
  ]) {
    db.exec('SAVEPOINT negative'); db.exec(sql);
    const acquired = await source.loadMeasuredSources(args);
    assert.equal(acquired.receipt.sessions[0].measured_set_count, null);
    db.exec('ROLLBACK TO negative'); db.exec('RELEASE negative');
  }
  db.exec('SAVEPOINT missing'); db.prepare('DELETE FROM workout_sets WHERE user_id=? AND session_id=?').run(id, `work-${id}`);
  assert.equal((await source.loadMeasuredSources(args)).receipt.sessions[0].measured_set_count, null);
  db.exec('ROLLBACK TO missing'); db.exec('RELEASE missing');
  // Same immutable snapshot stale recheck catches acquired-row edits without revision.
  for (const sql of ["UPDATE workout_sets SET weight_lbs=101 WHERE id='set-11111111-1111-4111-8111-000000000001-1'",
    "UPDATE lifts SET reps=9 WHERE id='lift-11111111-1111-4111-8111-000000000001'", "UPDATE workout_sessions SET total_seconds=3599 WHERE id='work-11111111-1111-4111-8111-000000000001'"]) {
    let n = 0; hooks.beforeTransaction = () => { if (++n === 2) db.exec(sql); };
    await assert.rejects(plans.previewPlanForUser(id, req, options('shadow')), e => e.code === 'CANDIDATE_STALE');
    hooks.beforeTransaction = null;
  }
  const plain = await plans.previewPlanForUser(id, req, options('off'));
  for (const table of ['lifts','workout_sessions','workout_sets','planning_evidence_corrections']) {
    hooks.before = (method, sql) => { if (method === 'all' && sql.includes(`FROM ${table}`)
      && (sql.includes('LIMIT 65') || sql.includes('LIMIT 257'))) throw new Error('private SQL failure'); };
    const response = await plans.previewPlanForUser(id, req, options('shadow'));
    assert.deepEqual(response.plan, plain.plan); assert.equal(response.candidateHash, plain.candidateHash);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?').get(response.id).n,0);
    hooks.before = null;
  }
  const sourceReadCount = () => calls.filter(c => /LIMIT (65|257)/.test(c.sql) && !c.sql.includes('daily_checkins')).length;
  for (const mode of ['off','preview','on']) {
    const count = sourceReadCount(); await plans.previewPlanForUser(id, req, options(mode)); assert.equal(sourceReadCount(), count);
  }

  for (let i=0;i<65;i++) db.prepare(`INSERT INTO lifts(id,user_id,date) VALUES (?,?,'2026-09-10')`).run(`overflow-${i}`,id);
  assert.equal((await source.loadMeasuredSources(args)).reason_code,'SOURCE_OVERFLOW');
  const overflow = await plans.previewPlanForUser(id,req,options('shadow'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?').get(overflow.id).n,0);
  db.prepare("DELETE FROM lifts WHERE user_id=? AND id LIKE 'overflow-%'").run(id);
  // Corrections unsupported by the existing lift resolver fail closed.
  db.prepare(`INSERT INTO planning_evidence_corrections(id,user_id,raw_evidence_kind,raw_evidence_ref,revision,
    corrected_canonical_value_json,canonical_unit,reason_code,reason,attributed_by_user_id,attribution_json,content_hash,created_at)
    VALUES ('strength-correction',?,'lift',?,1,'{}','ordinal','MANUAL_CORRECTION','Synthetic correction',?,'{}','synthetic-correction-hash','2026-09-13T12:00:00Z')`)
    .run(id, `lift-${id}`, id);
  assert.equal((await source.loadMeasuredSources(args)).reason_code, 'SOURCE_CORRECTION_UNSUPPORTED');
  db.prepare('DELETE FROM planning_evidence_corrections WHERE id=? AND user_id=?').run('strength-correction',id);
  db.exec('SAVEPOINT future_lift');
  db.prepare('UPDATE lifts SET created_at=? WHERE user_id=?').run('2026-09-15T10:00:00Z',id);
  assert.equal((await source.loadMeasuredSources(args)).lifts.length,0);
  assert.equal((await source.loadMeasuredSources(args)).receipt.lifts.length,1);
  db.exec('ROLLBACK TO future_lift'); db.exec('RELEASE future_lift');
  db.exec('SAVEPOINT duplicate_lift');
  db.prepare('UPDATE lifts SET watch_sync_id=? WHERE user_id=?').run('same-watch',id);
  db.prepare(`INSERT INTO lifts(id,user_id,date,sets,reps,weight_lbs,workout_duration_seconds,watch_sync_id,created_at)
    VALUES ('duplicate-lift',?,'2026-09-11',8,8,100,1800,'same-watch','2026-09-11T11:00:00Z')`).run(id);
  assert.equal((await source.loadMeasuredSources(args)).lifts.length,0);
  db.exec('ROLLBACK TO duplicate_lift'); db.exec('RELEASE duplicate_lift');
  console.log('ok - eight real SQLite route classes; measured sources, missing/invalid/foreign sets, stale rows, SQL failure, overflow, mode parity, no accepted surfaces');
}
main().catch(e => { console.error(e); process.exitCode=1; }).finally(() => { global.Date=RealDate; shadow.prepare=realPrepare; shadow.compute=realCompute; db.close(); });
