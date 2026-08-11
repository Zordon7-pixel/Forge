#!/usr/bin/env node

const assert = require('node:assert/strict');
const hyrox = require('../src/lib/hyroxPlan');
const { STATION_ORDER } = require('../src/lib/hyroxStandards');

const TODAY = '2026-08-10';
const EQUIPMENT = ['ski_erg', 'row_erg', 'sled_push', 'sled_pull', 'wall_ball_target', 'sandbag', 'farmers_carry', 'treadmill'];

function fixture(days, overrides = {}) {
  return {
    athlete: {
      weeklyMilesCurrent: 22,
      runDaysPerWeek: 4,
      readiness: 'normal',
      comebackMode: false,
      ...overrides.athlete,
    },
    planningLocalDate: TODAY,
    event: {
      name: 'Worldwide HYROX',
      eventLocalDate: days == null ? null : hyrox.addLocalDays(TODAY, days),
      eventTimezone: 'America/New_York',
      format: 'individual_open',
      category: 'men',
      rulesVersion: '2026-2027',
      ...overrides.event,
    },
    equipment: overrides.equipment || EQUIPMENT,
    availableDays: overrides.availableDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    secondaryRace: overrides.secondaryRace || null,
  };
}

function allSessions(plan) {
  return plan.weeks.flatMap((week) => week.days.flatMap((day) => (
    day.sessions.map((session) => ({ ...session, date: day.date, phase: week.phase }))
  )));
}

function runExposures(week) {
  return week.days.flatMap((day) => day.sessions)
    .filter((session) => session.kind === 'run' || session.includesRun === true).length;
}

function assertRunways() {
  const cases = [[null, 'foundation_only'], [0, 'race_week'], [6, 'race_week'], [7, 'readiness_bridge'], [20, 'readiness_bridge'], [21, 'short_runway'], [35, 'short_runway'], [41, 'short_runway'], [42, 'standard_build'], [83, 'standard_build'], [84, 'full_build'], [140, 'full_build'], [141, 'base_then_build']];
  for (const [days, expected] of cases) assert.equal(hyrox.classifyHyroxRunway(days), expected);
  assert.throws(() => hyrox.classifyHyroxRunway(-1), /invalid_days_to_event/);
  assert.throws(() => hyrox.classifyHyroxRunway(3.5), /invalid_days_to_event/);
  for (const [days, expected] of [[21, 'short_runway'], [35, 'short_runway'], [56, 'standard_build'], [112, 'full_build'], [null, 'foundation_only']]) {
    const plan = hyrox.generateHyroxPlan(fixture(days));
    assert.equal(plan.hyroxPolicy.daysToEventAtGeneration, days);
    assert.equal(plan.hyroxPolicy.runwayClass, expected);
    assert.equal(hyrox.validateHyroxPlan(plan).valid, true, JSON.stringify(hyrox.validateHyroxPlan(plan).errors));
  }
}

function assertFiveWeekPlanIsGeneric() {
  const named = hyrox.generateHyroxPlan(fixture(35, { athlete: { name: 'Bryan', accountId: 'one' }, event: { id: 'one' } }));
  const anonymous = hyrox.generateHyroxPlan(fixture(35, { athlete: { name: 'Someone else', accountId: 'two' }, event: { id: 'two' } }));
  assert.deepEqual(named, anonymous, 'identity must not affect deterministic output');
  assert.equal(named.hyroxPolicy.runwayClass, 'short_runway');
  assert.deepEqual(named.weeks.map((week) => week.phase), ['orientation_assessment', 'build', 'peak_partial_simulation', 'sharpen_reduce', 'taper_race']);
  assert.ok(named.weeks[2].plannedLoadPoints > named.weeks[1].plannedLoadPoints);
  assert.ok(named.weeks[3].plannedLoadPoints < named.weeks[2].plannedLoadPoints);
  assert.ok(named.weeks[4].plannedLoadPoints < named.weeks[3].plannedLoadPoints);
  assert.equal(named.hyroxPolicy.fullSimulationRequired, false);
  assert.equal(allSessions(named).some((session) => session.sessionType === 'hyrox_simulation'), false);
}

function assertTimezoneStability() {
  const instant = '2026-08-10T10:30:00.000Z';
  assert.equal(hyrox.localDateInTimeZone(instant, 'Pacific/Kiritimati'), '2026-08-11');
  assert.equal(hyrox.localDateInTimeZone(instant, 'Etc/GMT+12'), '2026-08-09');
  assert.equal(hyrox.daysToEventForEvent({
    eventLocalDate: '2026-09-14', eventTimezone: 'Pacific/Kiritimati',
  }, { now: instant }), 34);
  assert.equal(hyrox.daysToEventForEvent({
    eventLocalDate: '2026-09-14', eventTimezone: 'Etc/GMT+12',
  }, { now: instant }), 36);
  for (const eventTimezone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    const plan = hyrox.generateHyroxPlan(fixture(35, { event: { eventTimezone } }));
    assert.equal(plan.goal.eventLocalDate, '2026-09-14');
  }
}

function assertFrequencyAndEquipment() {
  for (const runDaysPerWeek of [3, 4]) {
    const plan = hyrox.generateHyroxPlan(fixture(35, { athlete: { runDaysPerWeek } }));
    assert.equal(plan.schedulePreferences.runDaysPerWeek, runDaysPerWeek);
    for (const week of plan.weeks.slice(0, -1)) {
      assert.equal(runExposures(week), runDaysPerWeek);
    }
  }
  const limited = hyrox.generateHyroxPlan(fixture(35, { equipment: ['row_erg', 'sandbag'] }));
  const sleds = allSessions(limited)
    .filter((session) => session.sessionType !== 'hyrox_race')
    .flatMap((session) => session.stationSequence || [])
    .filter((station) => ['sled_push', 'sled_pull'].includes(station.id));
  assert.ok(sleds.length > 0);
  assert.ok(sleds.every((station) => (
    station.exactStation === false
    && station.readinessClaim === 'pattern_only'
    && station.substitute
    && station.prescribedLoadKg == null
  )));
  assert.ok(limited.hyroxPolicy.missingEquipment.includes('sled_push'));

  const comeback = hyrox.generateHyroxPlan(fixture(35, {
    athlete: { comebackMode: true, readiness: 'low' },
  }));
  assert.equal(comeback.hyroxPolicy.safetyHold, true);
  assert.equal(allSessions(comeback).some((session) => session.heavyStationWork), false);
  assert.ok(allSessions(comeback)
    .filter((session) => session.sessionType === 'hyrox_compromised')
    .every((session) => session.runSequenceMeters.length <= 2));
}

function assertSafetyAndOrder() {
  const plan = hyrox.generateHyroxPlan(fixture(35));
  const validation = hyrox.validateHyroxPlan(plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  for (const week of plan.weeks) {
    const hardDates = new Set(week.days.flatMap((day) => (
      day.sessions.filter((session) => session.hardLowerBody).map(() => day.date)
    )));
    assert.ok(hardDates.size <= 2);
  }
  const race = allSessions(plan).find((session) => session.sessionType === 'hyrox_race');
  assert.deepEqual(race.stationSequence.map((station) => station.id), STATION_ORDER);
  assert.deepEqual(race.runSequenceMeters, Array(8).fill(1000));
  assert.deepEqual(race.raceSequence.map((item) => item.kind), Array.from({ length: 16 }, (_, index) => (
    index % 2 === 0 ? 'run' : 'station'
  )));
  const foundation = hyrox.generateHyroxPlan(fixture(null));
  assert.equal(foundation.weeks.length, 8);
  assert.equal(allSessions(foundation).some((session) => session.sessionType === 'hyrox_race'), false);
}

function assertSecondaryTransition() {
  const eventDate = hyrox.addLocalDays(TODAY, 35);
  const secondaryRace = {
    kind: 'run_race',
    name: 'Ten Mile Running Race',
    eventLocalDate: hyrox.addLocalDays(eventDate, 42),
    eventTimezone: 'America/New_York',
    distanceMiles: 10,
  };
  const plan = hyrox.generateHyroxPlan(fixture(35, { secondaryRace }));
  assert.deepEqual(plan.goals.map((goal) => goal.kind), ['hyrox', 'run_race']);
  const raceWeek = plan.weeks.findIndex((week) => week.days.some((day) => (
    day.sessions.some((session) => session.sessionType === 'hyrox_race')
  )));
  assert.equal(plan.weeks[raceWeek + 1].phase, 'post_hyrox_recovery');
  assert.ok(plan.weeks.slice(raceWeek + 2).some((week) => week.phase === 'running_specific'));
  assert.equal(plan.weeks.at(-1).phase, 'running_taper_race');
  assert.equal(plan.weeks.some((week, index) => index > raceWeek && week.phase === 'base_development'), false);
  assert.equal(hyrox.validateHyroxPlan(plan).valid, true);
}

function run() {
  assertRunways();
  assertFiveWeekPlanIsGeneric();
  assertTimezoneStability();
  assertFrequencyAndEquipment();
  assertSafetyAndOrder();
  assertSecondaryTransition();
  console.log('HYROX PLAN ENGINE SMOKE OK');
}

if (require.main === module) run();
module.exports = { run };
