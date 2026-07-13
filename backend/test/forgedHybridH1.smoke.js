// Forged Hybrid H1 standalone smoke + deterministic fixtures.
// Run: node backend/test/forgedHybridH1.smoke.js
//
// Covers:
//   a) legacy run-only == schema-v2 run-only for today/compliance/override/reschedule
//   b) hybrid day with run+lift
//   c) hybrid -> run_only future-only switch preserving past/completed
//   d) run_only -> hybrid future-only injection with no hard-run/lower-lift conflict
//   e) 13-week Army Ten-Miler run_only and hybrid_maintain fixtures (written to disk)
//   f) repeat/idempotency behaviour
//
// No DB, no network. Pure adapter/model validation.

const fs = require('fs');
const path = require('path');
const schema = require('../src/lib/planSchema');
const checkin = require('../src/lib/checkinOverride');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error('  FAIL: ' + msg);
  }
}
function section(name) {
  console.log('\n== ' + name + ' ==');
}

// ---- deterministic date helpers ----
const BASE_START = '2026-07-13'; // Monday
const RACE_DATE = '2026-10-11'; // Sunday, Army Ten-Miler
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function phaseForWeek(w) {
  if (w <= 3) return 'base';
  if (w === 7) return 'down';
  if (w >= 4 && w <= 10) return 'build';
  if (w === 11) return 'peak';
  if (w === 12) return 'taper';
  return 'race';
}

function runSessionFor(weekday, w) {
  const idLow = weekday.toLowerCase();
  if (weekday === 'Tue') {
    return { id: 'w' + w + '-tue-run', kind: 'run', type: 'run', workout_type: 'run', title: 'Quality run', distance_miles: Math.round((4 + w * 0.1) * 10) / 10, target_zone: 'Zone 3', description: 'Quality intervals.' };
  }
  if (weekday === 'Sat') {
    return { id: 'w' + w + '-sat-run', kind: 'run', type: 'long', workout_type: 'run', title: 'Long run', distance_miles: Math.round((6 + w * 0.3) * 10) / 10, target_zone: 'Zone 2', description: 'Long aerobic run.' };
  }
  // Wed / Thu easy
  return { id: 'w' + w + '-' + idLow + '-run', kind: 'run', type: 'easy', workout_type: 'run', title: 'Easy run', distance_miles: 3, target_zone: 'Zone 2', description: 'Easy aerobic run.' };
}

function liftSessionFor(weekday, w) {
  const focus = weekday === 'Wed' ? 'Lower body' : 'Upper body';
  return { id: 'w' + w + '-' + weekday.toLowerCase() + '-lift', kind: 'lift', type: 'strength', workout_type: 'strength', title: schema.STRENGTH_MAINTAIN_TITLE + ' - ' + focus, focus, distance_miles: 0, description: schema.STRENGTH_MAINTAIN_TITLE + ' (' + focus + ').' };
}

// Build the canonical schema-v2 Army Ten-Miler plan for a given mode.
function buildArmy(mode) {
  const hybrid = schema.isHybridMode(mode);
  const weeks = [];
  for (let w = 1; w <= 13; w += 1) {
    const startDate = addDays(BASE_START, (w - 1) * 7);
    const days = WEEKDAYS.map((weekday, i) => {
      const date = addDays(startDate, i);
      const sessions = [];
      const hasRun = weekday === 'Tue' || weekday === 'Wed' || weekday === 'Thu' || weekday === 'Sat';
      if (hasRun) sessions.push(runSessionFor(weekday, w));
      if (hybrid && (weekday === 'Mon' || weekday === 'Wed' || weekday === 'Fri')) {
        sessions.push(liftSessionFor(weekday, w));
      }
      const day = { date, day: weekday, sessions };
      if (sessions.some((s) => s.kind === 'run') && sessions.some((s) => s.kind === 'lift')) {
        day.orderGuidance = 'Run first; lift at least 6 hours later.';
      }
      day.status = 'planned';
      return day;
    });
    weeks.push({ week: w, phase: phaseForWeek(w), startDate, days });
  }
  const plan = {
    schemaVersion: schema.SCHEMA_VERSION,
    planMode: mode,
    goal: { kind: 'race', name: 'Army Ten-Miler', date: RACE_DATE, distanceMiles: 10, goalType: 'pr', goalTimeSeconds: null },
    weeks,
  };
  if (hybrid) {
    plan.strengthPolicy = schema.normalizeStrengthPolicy(
      { sessionsPerWeek: 3, minimumSessionsPerWeek: 2, equipment: ['barbell', 'dumbbell', 'rack', 'bench'], preferredDays: ['Mon', 'Wed', 'Fri'] },
      mode
    );
  }
  return plan;
}

// Legacy (schema-v1) run-only twin: flat day entries, no sessions[].
function buildLegacyRunOnly() {
  const weeks = [];
  for (let w = 1; w <= 13; w += 1) {
    const startDate = addDays(BASE_START, (w - 1) * 7);
    const days = WEEKDAYS.map((weekday, i) => {
      const date = addDays(startDate, i);
      const hasRun = weekday === 'Tue' || weekday === 'Wed' || weekday === 'Thu' || weekday === 'Sat';
      if (!hasRun) {
        return { id: 'w' + w + '-' + weekday.toLowerCase() + '-rest', day: weekday, date, type: 'rest', workout_type: 'rest', distance_miles: 0, description: 'Rest and recovery', rest: true };
      }
      const r = runSessionFor(weekday, w);
      return { id: r.id, day: weekday, date, type: r.type, workout_type: 'run', title: r.title, distance_miles: r.distance_miles, target_zone: r.target_zone, description: r.description };
    });
    weeks.push({ week: w, phase: phaseForWeek(w), startDate, days });
  }
  return { weeks };
}

// ---- (e) fixtures ----
section('(e) 13-week Army Ten-Miler fixtures');
const runOnly = buildArmy(schema.PLAN_MODES.RUN_ONLY);
const hybrid = buildArmy(schema.PLAN_MODES.HYBRID_MAINTAIN);
assert(runOnly.weeks.length === 13, 'run_only has 13 weeks');
assert(hybrid.weeks.length === 13, 'hybrid_maintain has 13 weeks');
assert(runOnly.weeks[12].days[6].date === RACE_DATE, 'plan reaches race date ' + RACE_DATE + ' (got ' + runOnly.weeks[12].days[6].date + ')');
assert(runOnly.planMode === 'run_only' && !runOnly.strengthPolicy, 'run_only has no strengthPolicy');
assert(hybrid.strengthPolicy && hybrid.strengthPolicy.enabled === true, 'hybrid strengthPolicy enabled');
// No lifts anywhere in run_only.
let runOnlyLifts = 0;
for (const wk of runOnly.weeks) for (const d of wk.days) runOnlyLifts += schema.daySessions(d).filter((s) => s.kind === 'lift').length;
assert(runOnlyLifts === 0, 'run_only has zero lift sessions');
// Hybrid: each week has >= floor lifts and no lift on Tue/Sat.
let hybridOk = true;
for (const wk of hybrid.weeks) {
  let lifts = 0;
  for (const d of wk.days) {
    const sess = schema.daySessions(d);
    const hasLift = sess.some((s) => s.kind === 'lift');
    lifts += sess.filter((s) => s.kind === 'lift').length;
    if (hasLift && (d.day === 'Tue' || d.day === 'Sat')) hybridOk = false;
  }
  if (lifts < hybrid.strengthPolicy.minimumSessionsPerWeek) hybridOk = false;
}
assert(hybridOk, 'hybrid: every week meets strength floor and never lifts on Tue/Sat hard days');
// At least one rest day per week.
let everyWeekHasRest = true;
for (const wk of runOnly.weeks) {
  if (!wk.days.some((d) => schema.isRestEntry(d))) everyWeekHasRest = false;
}
assert(everyWeekHasRest, 'run_only: every week has at least one rest day');
// Write fixture artifacts.
const fixturesDir = path.join(__dirname, 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });
fs.writeFileSync(path.join(fixturesDir, 'army-ten-miler.run_only.json'), JSON.stringify(runOnly, null, 2));
fs.writeFileSync(path.join(fixturesDir, 'army-ten-miler.hybrid_maintain.json'), JSON.stringify(hybrid, null, 2));
assert(fs.existsSync(path.join(fixturesDir, 'army-ten-miler.run_only.json')), 'wrote run_only fixture');
assert(fs.existsSync(path.join(fixturesDir, 'army-ten-miler.hybrid_maintain.json')), 'wrote hybrid fixture');

// ---- (b) hybrid day with run+lift ----
section('(b) hybrid day with run + lift');
const wedW1 = hybrid.weeks[0].days.find((d) => d.day === 'Wed');
const wedSessions = schema.daySessions(wedW1);
assert(wedSessions.length === 2, 'Wed hybrid day has two sessions (got ' + wedSessions.length + ')');
assert(wedSessions.some((s) => s.kind === 'run') && wedSessions.some((s) => s.kind === 'lift'), 'Wed hybrid day has one run and one lift');
assert(typeof wedW1.orderGuidance === 'string' && /run first/i.test(wedW1.orderGuidance), 'run+lift day carries order guidance');
const wedFlat = schema.flattenDayForConsumer(wedW1);
assert(wedFlat.type !== 'strength' && wedFlat.type !== 'rest' && Number(wedFlat.distance_miles) === 3, 'flattened Wed exposes the run as primary for legacy consumers');
assert(Array.isArray(wedFlat.sessions) && wedFlat.sessions.length === 2, 'flattened Wed still exposes both sessions');

// ---- (a) legacy run-only == schema-v2 run-only ----
section('(a) legacy run-only == schema-v2 run-only');
const legacy = buildLegacyRunOnly();
let todayOk = true;
let complianceOk = true;
let overrideOk = true;
const overridePatch = { type: 'recovery', workout_type: 'recovery', distance_miles: 1.5, intensity: 'Recovery' };
for (let wi = 0; wi < 13; wi += 1) {
  const v2Days = runOnly.weeks[wi].days;
  const lgDays = legacy.weeks[wi].days;
  for (let di = 0; di < 7; di += 1) {
    const v2 = v2Days[di];
    const lg = lgDays[di];
    // today projection
    const v2Flat = schema.flattenDayForConsumer(v2);
    const lgFlat = schema.flattenDayForConsumer(lg); // identity for legacy
    const v2Type = schema.isRestEntry(v2) ? 'rest' : v2Flat.type;
    const lgType = schema.isRestEntry(lg) ? 'rest' : lgFlat.type;
    if (v2Type !== lgType) todayOk = false;
    if (Number(v2Flat.distance_miles || 0) !== Number(lgFlat.distance_miles || 0)) todayOk = false;
    if (v2Flat.day !== lgFlat.day) todayOk = false;
    // compliance projection
    const v2Planned = schema.plannedSessionsForDay(v2, di, v2.date);
    const lgPlanned = schema.plannedSessionsForDay(lg, di, lg.date);
    if (v2Planned.length !== lgPlanned.length) complianceOk = false;
    for (let k = 0; k < v2Planned.length; k += 1) {
      if (v2Planned[k].type !== lgPlanned[k].type) complianceOk = false;
      if (v2Planned[k].distance !== lgPlanned[k].distance) complianceOk = false;
      if (v2Planned[k].date !== lgPlanned[k].date) complianceOk = false;
    }
    // override projection
    const v2Over = schema.applyOverrideToDay(v2Flat, overridePatch);
    const lgOver = checkin.applyOverride(lg, overridePatch);
    if (Number(v2Over.distance_miles) !== Number(lgOver.distance_miles)) overrideOk = false;
    if (v2Over.type !== lgOver.type) overrideOk = false;
    if (v2Over.workout_type !== lgOver.workout_type) overrideOk = false;
  }
}
assert(todayOk, 'today projection identical (type/distance/day) across all 91 days');
assert(complianceOk, 'compliance projection identical (type/distance/date) across all 91 days');
assert(overrideOk, 'override projection identical across all 91 days');
// legacy checkinOverride.applyOverride must be byte-identical to {...day,...patch} for legacy days
const sampleLegacy = legacy.weeks[0].days[1];
const legacyMerged = checkin.applyOverride(sampleLegacy, overridePatch);
const plainMerged = Object.assign({}, sampleLegacy, overridePatch);
assert(JSON.stringify(legacyMerged) === JSON.stringify(plainMerged), 'checkinOverride.applyOverride unchanged for legacy (single-session) days');

// reschedule parity: run-only planned sessions match, and mapType-equivalent per-day type matches
let reschedTypesOk = true;
for (let wi = 0; wi < 13; wi += 1) {
  for (let di = 0; di < 7; di += 1) {
    const v2 = runOnly.weeks[wi].days[di];
    const lg = legacy.weeks[wi].days[di];
    const v2Rest = schema.isRestEntry(v2);
    const lgRest = schema.isRestEntry(lg);
    if (v2Rest !== lgRest) reschedTypesOk = false;
  }
}
assert(reschedTypesOk, 'reschedule day-type (rest vs non-rest) parity across all days');

// Id-less legacy plans must keep the original index identifier across reads so
// compliance output can be passed back to reschedule-missed.
const idlessWeek = {
  days: [
    { day: 'Mon', type: 'easy', workout_type: 'run', distance_miles: 3, description: 'Easy run' },
    { day: 'Tue', type: 'rest', workout_type: 'rest', rest: true },
  ],
};
const firstLegacyId = schema.plannedSessionsForDay(idlessWeek.days[0], 0, '2026-07-13')[0].sessionId;
const secondLegacyId = schema.plannedSessionsForDay(idlessWeek.days[0], 0, '2026-07-13')[0].sessionId;
assert(firstLegacyId === '0' && secondLegacyId === firstLegacyId, 'id-less legacy compliance id is deterministic');
const movedLegacy = schema.rescheduleSessionInWeek(idlessWeek, firstLegacyId);
assert(!movedLegacy.error && schema.isRestEntry(movedLegacy.week.days[0]), 'legacy reschedule leaves a rest day at the source');
assert(Number(movedLegacy.week.days[1].distance_miles) === 3 && movedLegacy.week.days[1].day === 'Tue', 'legacy reschedule inserts the workout into the target day');

// A v2 reschedule moves only the requested session and retains its sibling.
const v2RescheduleWeek = {
  days: [
    {
      date: '2026-07-15', day: 'Wed',
      orderGuidance: 'Run first; lift at least 6 hours later.',
      sessions: [
        { id: 'wed-run', kind: 'run', type: 'easy', distance_miles: 3 },
        { id: 'wed-lift', kind: 'lift', type: 'strength', title: 'Lower body' },
      ],
    },
    { date: '2026-07-16', day: 'Thu', sessions: [] },
  ],
};
const movedV2 = schema.rescheduleSessionInWeek(v2RescheduleWeek, 'wed-run');
assert(!movedV2.error, 'v2 session reschedule succeeds');
assert(schema.daySessions(movedV2.week.days[0]).length === 1 && schema.daySessions(movedV2.week.days[0])[0].id === 'wed-lift', 'v2 reschedule preserves the lift sibling');
assert(schema.daySessions(movedV2.week.days[1]).length === 1 && schema.daySessions(movedV2.week.days[1])[0].id === 'wed-run', 'v2 reschedule inserts only the requested run in the target day');
assert(!movedV2.week.days[0].orderGuidance && !movedV2.week.days[1].orderGuidance, 'reschedule removes stale run/lift ordering guidance');
const repeatedV2Id = schema.plannedSessionsForDay(movedV2.week.days[1], 1, '2026-07-16')[0].sessionId;
assert(repeatedV2Id === 'wed-run', 'moved v2 session keeps its stable id');

const v2IdlessDay = { date: '2026-07-17', day: 'Fri', sessions: [{ kind: 'run', type: 'easy' }] };
const v2IdA = schema.plannedSessionsForDay(v2IdlessDay, 4, '2026-07-17')[0].sessionId;
const v2IdB = schema.plannedSessionsForDay(v2IdlessDay, 4, '2026-07-17')[0].sessionId;
assert(v2IdA === v2IdB, 'id-less v2 session fallback id is deterministic');

const idlessConversionPlan = {
  weeks: [
    { days: [
      { day: 'Mon', date: '2026-07-20', type: 'easy', workout_type: 'run' },
      { day: 'Tue', date: '2026-07-21', type: 'rest', workout_type: 'rest', rest: true },
    ] },
    { days: [
      { day: 'Mon', date: '2026-07-27', type: 'easy', workout_type: 'run' },
      { day: 'Tue', date: '2026-07-28', type: 'rest', workout_type: 'rest', rest: true },
    ] },
  ],
};
const idlessConverted = schema.switchPlanMode(idlessConversionPlan, schema.PLAN_MODES.RUN_ONLY, { todayISO: '2026-07-01' });
const convertedIds = idlessConverted.weeks.flatMap((week) => schema.getDayEntries(week).flatMap((day) => schema.daySessions(day).map((session) => session.id)));
assert(convertedIds.length === new Set(convertedIds).size && convertedIds.every(Boolean), 'mode conversion assigns unique persisted ids to id-less sessions');

// ---- (c) hybrid -> run_only future-only, preserving past + completed ----
section('(c) hybrid -> run_only future-only switch');
const todayISO_c = hybrid.weeks[2].days[2].date; // week 3 Wed
// mark one FUTURE lift as completed so it must be preserved
const futureLiftDay = hybrid.weeks[5].days.find((d) => d.day === 'Fri');
const futureLiftId = schema.daySessions(futureLiftDay).find((s) => s.kind === 'lift').id;
const switched = schema.switchPlanMode(hybrid, schema.PLAN_MODES.RUN_ONLY, { todayISO: todayISO_c, completedSessionIds: [futureLiftId] });
assert(switched.planMode === 'run_only', 'switched planMode is run_only');
assert(switched.strengthPolicy && switched.strengthPolicy.enabled === false, 'run_only strengthPolicy disabled after switch');
let pastLiftsPreserved = true;
let futureLiftsRemoved = true;
let completedPreserved = false;
let runsIntact = true;
for (const wk of switched.weeks) {
  for (const d of wk.days) {
    const isFuture = d.date > todayISO_c;
    const lifts = schema.daySessions(d).filter((s) => s.kind === 'lift');
    const runs = schema.daySessions(d).filter((s) => s.kind === 'run');
    // runs must never be dropped
    const hadRun = d.day === 'Tue' || d.day === 'Wed' || d.day === 'Thu' || d.day === 'Sat';
    if (hadRun && runs.length === 0) runsIntact = false;
    if (!isFuture) {
      // past/today lifts must remain (Mon/Wed/Fri had lifts)
      if ((d.day === 'Mon' || d.day === 'Wed' || d.day === 'Fri') && lifts.length === 0) pastLiftsPreserved = false;
    } else {
      for (const l of lifts) {
        if (l.id === futureLiftId) completedPreserved = true;
        else futureLiftsRemoved = false;
      }
    }
  }
}
assert(pastLiftsPreserved, 'past/today lift sessions preserved');
assert(futureLiftsRemoved, 'future non-completed lifts removed');
assert(completedPreserved, 'completed future lift preserved despite switch to run_only');
assert(runsIntact, 'all run sessions intact after switch');

// ---- (d) run_only -> hybrid future-only injection, no conflicts ----
section('(d) run_only -> hybrid future-only injection');
const todayISO_d = runOnly.weeks[1].days[6].date; // end of week 2
const toHybrid = schema.switchPlanMode(runOnly, schema.PLAN_MODES.HYBRID_MAINTAIN, { todayISO: todayISO_d });
assert(toHybrid.planMode === 'hybrid_maintain', 'switched to hybrid_maintain');
let pastUntouched = true;
let noConflict = true;
let futureFloorOk = true;
for (const wk of toHybrid.weeks) {
  let futureWeekHasFutureDays = false;
  let futureLifts = 0;
  for (const d of wk.days) {
    const isFuture = d.date > todayISO_d;
    const sess = schema.daySessions(d);
    const lifts = sess.filter((s) => s.kind === 'lift');
    if (!isFuture) {
      // past must have NO lifts (source run_only had none)
      if (lifts.length > 0) pastUntouched = false;
    } else {
      futureWeekHasFutureDays = true;
      futureLifts += lifts.length;
      // never a lift on a hard/long run day
      if (lifts.length > 0 && sess.some((s) => s.kind === 'run' && schema.isHardOrLongRun(s))) noConflict = false;
      // never on Tue/Sat
      if (lifts.length > 0 && (d.day === 'Tue' || d.day === 'Sat')) noConflict = false;
    }
  }
  if (futureWeekHasFutureDays && futureLifts < toHybrid.strengthPolicy.minimumSessionsPerWeek) {
    // only enforce floor on fully-future weeks
    const allFuture = wk.days.every((d) => d.date > todayISO_d);
    if (allFuture) futureFloorOk = false;
  }
}
assert(pastUntouched, 'past dates received no injected lifts');
assert(noConflict, 'no lift injected onto hard/long run days or Tue/Sat');
assert(futureFloorOk, 'fully-future weeks meet the strength floor after injection');
// Wed future day should now be run+lift
const wedFuture = toHybrid.weeks[4].days.find((d) => d.day === 'Wed');
const wedFutureSess = schema.daySessions(wedFuture);
assert(wedFutureSess.some((s) => s.kind === 'run') && wedFutureSess.some((s) => s.kind === 'lift'), 'future Wed becomes run+lift after injection');

// ---- (f) idempotency ----
section('(f) idempotency');
const hToR1 = schema.switchPlanMode(hybrid, schema.PLAN_MODES.RUN_ONLY, { todayISO: todayISO_c, completedSessionIds: [futureLiftId] });
const hToR2 = schema.switchPlanMode(hToR1, schema.PLAN_MODES.RUN_ONLY, { todayISO: todayISO_c, completedSessionIds: [futureLiftId] });
assert(JSON.stringify(hToR1) === JSON.stringify(hToR2), 'hybrid->run_only switch is idempotent');
const rToH1 = schema.switchPlanMode(runOnly, schema.PLAN_MODES.HYBRID_MAINTAIN, { todayISO: todayISO_d });
const rToH2 = schema.switchPlanMode(rToH1, schema.PLAN_MODES.HYBRID_MAINTAIN, { todayISO: todayISO_d });
assert(JSON.stringify(rToH1) === JSON.stringify(rToH2), 'run_only->hybrid switch is idempotent');

// ---- summary ----
console.log('\n----------------------------------------');
console.log('PASSED: ' + passed + '  FAILED: ' + failed);
if (failed > 0) {
  process.exit(1);
}
console.log('H1 SMOKE OK');
