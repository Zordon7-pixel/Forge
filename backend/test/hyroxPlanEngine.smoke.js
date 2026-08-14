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
    planningLocalDate: overrides.planningLocalDate || TODAY,
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
    availableDays: overrides.availableDays || ['Tue', 'Thu', 'Sat', 'Sun'],
    currentLoad: overrides.currentLoad || null,
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

function runningMiles(week) {
  return Number(week.days.flatMap((day) => day.sessions)
    .filter((session) => session.kind === 'run' || session.includesRun === true)
    .reduce((sum, session) => sum + Number(session.distance_miles || 0), 0)
    .toFixed(1));
}

function weekEntries(week) {
  return week.days.flatMap((day) => (
    day.sessions.map((session) => ({ date: day.date, session }))
  ));
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
  const named = hyrox.generateHyroxPlan(fixture(34, { athlete: { name: 'Bryan', accountId: 'one' }, event: { id: 'one' } }));
  const anonymous = hyrox.generateHyroxPlan(fixture(34, { athlete: { name: 'Someone else', accountId: 'two' }, event: { id: 'two' } }));
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

function assertConsecutiveDayScheduleRegression() {
  const schedules = [
    ['Mon', 'Tue', 'Wed'],
    ['Tue', 'Wed', 'Thu'],
    ['Wed', 'Thu', 'Fri'],
    ['Sat', 'Sun', 'Mon'],
  ];
  const eventDates = ['2026-08-31', '2026-09-20', '2026-10-10'];
  for (const availableDays of schedules) {
    for (const eventLocalDate of eventDates) {
      const plan = hyrox.generateHyroxPlan(fixture(null, {
        athlete: { weeklyMilesCurrent: 22, runDaysPerWeek: 3 },
        event: { eventLocalDate },
        availableDays,
      }));
      const validation = hyrox.validateHyroxPlan(plan);
      assert.equal(
        validation.valid,
        true,
        `${availableDays.join('/')}/${eventLocalDate} must not fail formerly valid station placement: ${JSON.stringify(validation.errors)}`,
      );
      assert.equal(plan.schedulePreferences.runDaysPerWeek, 3);
    }
  }
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
  assert.deepEqual(race.officialTeamStationSequence.map((station) => station.id), STATION_ORDER);
  assert.ok(race.officialTeamStationSequence.every((station) => station.officialStandard));
  assert.equal(
    race.officialTeamStationSequence.find((station) => station.id === 'sled_push')
      .officialStandard.loadKgIncludingSled,
    152,
  );
  assert.deepEqual(race.runSequenceMeters, Array(8).fill(1000));
  assert.deepEqual(race.raceSequence.map((item) => item.kind), Array.from({ length: 16 }, (_, index) => (
    index % 2 === 0 ? 'run' : 'station'
  )));
  const foundation = hyrox.generateHyroxPlan(fixture(null));
  assert.equal(foundation.weeks.length, 8);
  assert.equal(allSessions(foundation).some((session) => session.sessionType === 'hyrox_race'), false);
}

function assertSaturdayEventCrossWeekSafety() {
  const eventLocalDate = '2026-10-10';
  const days = hyrox.daysBetweenLocalDates(eventLocalDate, TODAY);
  const plan = hyrox.generateHyroxPlan(fixture(days, {
    event: { eventLocalDate },
    availableDays: ['Tue', 'Thu', 'Sat', 'Sun'],
  }));
  const validation = hyrox.validateHyroxPlan(plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const entries = plan.weeks.flatMap((week) => week.days.flatMap((day) => (
    day.sessions.map((session) => ({ date: day.date, session }))
  )));
  const heavyStations = entries.filter(({ session }) => session.heavyStationWork);
  const hardOrLongRuns = entries.filter(({ session }) => (
    ['hard', 'long', 'race'].includes(session.runningStress)
    && (session.kind === 'run' || session.includesRun)
  ));
  assert.ok(heavyStations.length > 0, 'cross-week safety must not erase all heavy station work');
  assert.ok(heavyStations.every((heavy) => hardOrLongRuns.every((run) => (
    run.date === heavy.date
    || Math.abs(hyrox.daysBetweenLocalDates(run.date, heavy.date)) > 1
  ))), 'heavy stations must remain separated from adjacent hard or long running across week boundaries');
}

function assertPartialCurrentWeekAnchoringAndLoad() {
  const planningLocalDate = '2026-08-13';
  const eventLocalDate = '2026-10-18';
  const plan = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate,
    athlete: { weeklyMilesCurrent: 22, runDaysPerWeek: 4 },
    event: {
      eventLocalDate,
      eventTimezone: 'Pacific/Kiritimati',
    },
    availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    currentLoad: {
      weeklyMiles: 22,
      recentRunLoad: {
        currentWeek: {
          startDate: '2026-08-10',
          miles: 7,
          runCount: 1,
          runDates: ['2026-08-11'],
          longRunCompleted: true,
        },
        protection: {
          active: true,
          anchorDate: '2026-08-11',
          hardRunsThrough: '2026-08-13',
          lowerBodyThrough: '2026-08-13',
        },
      },
      currentWeekStrength: {
        startDate: '2026-08-10',
        count: 1,
        dates: ['2026-08-12'],
        loadPoints: 45,
      },
    },
  }));

  assert.equal(plan.weeks[0].startDate, '2026-08-10');
  assert.equal(plan.weeks[1].startDate, '2026-08-17');
  assert.equal(
    plan.weeks[0].days.filter((day) => day.date < planningLocalDate)
      .every((day) => day.sessions.length === 0),
    true,
    'a Thursday plan never generates sessions on Monday through Wednesday',
  );
  assert.equal(plan.weeks[0].currentWeekConstraint.completedRunCount, 1);
  assert.equal(plan.weeks[0].currentWeekConstraint.completedStrengthSessions, 1);
  assert.ok(
    runExposures(plan.weeks[0]) <= 3,
    'the completed run reduces the remaining current-week run quota',
  );
  assert.ok(
    plan.weeks[0].days.flatMap((day) => day.sessions)
      .filter((session) => session.kind === 'hyrox').length <= 1,
    'the completed lift/workout reduces the remaining HYROX-session quota',
  );
  assert.ok(
    plan.weeks[0].plannedLoadPoints < plan.weeks[1].plannedLoadPoints,
    'completed current-week load reshapes the bounded remaining load instead of restarting a full week',
  );
  const raceEntry = plan.weeks.flatMap((week) => week.days)
    .find((day) => day.sessions.some((session) => session.sessionType === 'hyrox_race'));
  assert.equal(plan.goal.eventLocalDate, eventLocalDate);
  assert.equal(plan.goal.eventTimezone, 'Pacific/Kiritimati');
  assert.equal(raceEntry?.date, eventLocalDate, 'event-local race date remains exact');
}

function assertPartialWeekNoActivityLoadBounds() {
  const planningLocalDate = '2026-08-13';
  for (const weeklyMilesCurrent of [20, 40, 45]) {
    const plan = hyrox.generateHyroxPlan(fixture(null, {
      planningLocalDate,
      athlete: { weeklyMilesCurrent, runDaysPerWeek: 4 },
      event: { eventLocalDate: '2026-10-18' },
      availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      currentLoad: { weeklyMiles: weeklyMilesCurrent },
    }));
    const partialWeek = plan.weeks[0];
    const nextFullWeek = plan.weeks[1];
    const partialRunningMiles = runningMiles(partialWeek);
    const nextFullWeekRunningMiles = runningMiles(nextFullWeek);
    const partialRuns = weekEntries(partialWeek)
      .map(({ session }) => session)
      .filter((session) => session.kind === 'run');
    const longRun = partialRuns.find((session) => session.sessionType === 'long_run');
    const easyRuns = partialRuns.filter((session) => session.sessionType === 'easy_run');

    assert.equal(partialWeek.startDate, '2026-08-10');
    assert.equal(nextFullWeek.startDate, '2026-08-17');
    assert.equal(partialWeek.currentWeekConstraint.completedRunCount, 0);
    assert.equal(partialWeek.currentWeekConstraint.completedStrengthSessions, 0);
    assert.equal(
      partialWeek.days.filter((day) => day.date < planningLocalDate)
        .every((day) => day.sessions.length === 0),
      true,
    );
    assert.ok(
      partialRunningMiles <= nextFullWeekRunningMiles,
      `${weeklyMilesCurrent} mi/week partial load ${partialRunningMiles} must not exceed next full week ${nextFullWeekRunningMiles}`,
    );
    assert.ok(
      partialRunningMiles <= partialWeek.currentWeekConstraint.boundedWeeklyRunningLoad,
      `${weeklyMilesCurrent} mi/week partial load stays within its deterministic bounded load`,
    );
    assert.ok(longRun, `${weeklyMilesCurrent} mi/week partial week retains a bounded long run`);
    assert.ok(
      easyRuns.every((session) => session.distance_miles <= longRun.distance_miles),
      `${weeklyMilesCurrent} mi/week easy runs must not exceed the long run`,
    );
  }
}

function assertPartialRaceWeekSafety() {
  const planningLocalDate = '2026-08-13';
  for (const eventLocalDate of ['2026-08-16', '2026-08-13', '2026-08-17']) {
    const plan = hyrox.generateHyroxPlan(fixture(null, {
      planningLocalDate,
      athlete: { weeklyMilesCurrent: 22, runDaysPerWeek: 4 },
      event: { eventLocalDate },
      availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      currentLoad: { weeklyMiles: 22 },
    }));
    const partialEntries = weekEntries(plan.weeks[0]);
    const raceEntries = plan.weeks.flatMap(weekEntries)
      .filter(({ session }) => session.sessionType === 'hyrox_race');
    assert.equal(raceEntries.length, 1, `${eventLocalDate} has exactly one race session`);
    assert.equal(raceEntries[0].date, eventLocalDate, `${eventLocalDate} race remains exact`);
    assert.equal(
      partialEntries.some(({ session }) => session.sessionType === 'hyrox_compromised'),
      false,
      `${eventLocalDate} partial race-safety window has no compromised session`,
    );
    assert.equal(
      partialEntries.some(({ session }) => session.heavyStationWork),
      false,
      `${eventLocalDate} partial race-safety window has no heavy station`,
    );
    assert.equal(
      partialEntries.some(({ session }) => session.sessionType === 'long_run'),
      false,
      `${eventLocalDate} partial race-safety window has no long run`,
    );
    assert.equal(plan.weeks[0].currentWeekConstraint.raceSafetyWindow, true);
    assert.equal(hyrox.validateHyroxPlan(plan).valid, true);
  }
}

function assertCurrentWeekActivityMismatchMarker() {
  const plan = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate: '2026-08-13',
    athlete: { weeklyMilesCurrent: 20, runDaysPerWeek: 4 },
    event: { eventLocalDate: '2026-10-18' },
    availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    currentLoad: {
      weeklyMiles: 20,
      recentRunLoad: {
        currentWeek: {
          startDate: '2026-08-03',
          miles: 12,
          runCount: 2,
          runDates: ['2026-08-11'],
          longRunCompleted: true,
        },
        protection: { active: false },
      },
      currentWeekStrength: {
        startDate: '2026-08-03',
        count: 3,
        dates: ['2026-08-12'],
        loadPoints: 120,
      },
    },
  }));
  const reconciliation = plan.inputSummary.currentWeekActivityReconciliation;
  assert.equal(reconciliation.mismatch, true);
  assert.deepEqual(reconciliation.reasons, [
    'RUN_ACTIVITY_WEEK_START_MISMATCH',
    'STRENGTH_ACTIVITY_WEEK_START_MISMATCH',
  ]);
  assert.equal(plan.weeks[0].currentWeekConstraint.completedRunCount, 0);
  assert.equal(plan.weeks[0].currentWeekConstraint.completedRunMiles, 0);
  assert.equal(plan.weeks[0].currentWeekConstraint.completedStrengthSessions, 0);
  assert.deepEqual(plan.weeks[0].currentWeekConstraint.activityReconciliation, reconciliation);
}

function assertSundayPartialWeekEdge() {
  const planningLocalDate = '2026-08-16';
  const plan = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate,
    event: { eventLocalDate: '2026-10-18', eventTimezone: 'Etc/GMT+12' },
    availableDays: ['Tue', 'Thu', 'Sat', 'Sun'],
    currentLoad: {
      weeklyMiles: 22,
      recentRunLoad: {
        currentWeek: {
          startDate: '2026-08-10', miles: 8, runCount: 2,
          runDates: ['2026-08-11', '2026-08-15'], longRunCompleted: true,
        },
        protection: { active: false },
      },
      currentWeekStrength: {
        startDate: '2026-08-10', count: 1, dates: ['2026-08-13'], loadPoints: 40,
      },
    },
  }));
  assert.equal(plan.weeks[0].startDate, '2026-08-10');
  assert.equal(plan.weeks[1].startDate, '2026-08-17');
  assert.equal(
    plan.weeks[0].days.filter((day) => day.sessions.length > 0)
      .every((day) => day.date === planningLocalDate),
    true,
    'Sunday creation may use Sunday only',
  );
}

function assertMidweekFoundationAnchoring() {
  const plan = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate: '2026-08-13',
    event: { eventLocalDate: null },
  }));
  assert.equal(plan.weeks[0].startDate, '2026-08-10');
  assert.equal(plan.weeks[1].startDate, '2026-08-17');
  assert.equal(
    plan.weeks[0].days.filter((day) => day.date < '2026-08-13')
      .every((day) => day.sessions.length === 0),
    true,
    'an undated HYROX foundation preview also starts in the current partial week',
  );
}

function raceSessionFor(format, category = 'men') {
  const plan = hyrox.generateHyroxPlan(fixture(35, {
    event: { format, category },
  }));
  const validation = hyrox.validateHyroxPlan(plan);
  assert.equal(validation.valid, true, `${format}/${category}: ${JSON.stringify(validation.errors)}`);
  return {
    plan,
    race: plan.weeks.flatMap((week) => week.days)
      .flatMap((day) => day.sessions)
      .find((session) => session.sessionType === 'hyrox_race'),
  };
}

function assertRaceDayTruthByFormat() {
  for (const format of ['individual_open', 'doubles']) {
    const { race } = raceSessionFor(format);
    assert.deepEqual(race.runSequenceMeters, Array(8).fill(1000), `${format} athlete runs all 8 legs`);
    assert.equal(race.distanceMeters, 8000);
    assert.equal(race.distance_miles, 4.97);
    assert.deepEqual(race.stationSequence.map((station) => station.id), STATION_ORDER);
    assert.deepEqual(race.officialTeamStationSequence.map((station) => station.id), STATION_ORDER);
    assert.deepEqual(race.officialTeamRaceSequence.map((item) => item.kind), Array.from({ length: 16 }, (_, index) => (
      index % 2 === 0 ? 'run' : 'station'
    )));
  }

  const { plan: relayPlan, race: relay } = raceSessionFor('relay', 'women');
  assert.equal(relay.participationScope, 'relay_athlete');
  assert.deepEqual(relay.runSequenceMeters, [1000, 1000]);
  assert.equal(relay.distanceMeters, 2000);
  assert.equal(relay.distance_miles, 1.24);
  assert.deepEqual(relay.stationSequence, [], 'relay athlete stations must be assigned by the team');
  assert.deepEqual(relay.raceSequence, [], 'relay athlete sequence must not claim the complete team race');
  assert.deepEqual(relay.athleteStationAssignment, {
    stationCount: 2,
    status: 'team_assignment_required',
    instruction: 'Confirm this athlete’s two stations with the relay team before race day.',
  });
  assert.deepEqual(relay.officialTeamStationSequence.map((station) => station.id), STATION_ORDER);
  assert.deepEqual(relay.officialTeamRaceSequence.map((item) => item.kind), Array.from({ length: 16 }, (_, index) => (
    index % 2 === 0 ? 'run' : 'station'
  )));
  assert.equal(
    relay.officialTeamStationSequence.find((station) => station.id === 'sled_push')
      .officialStandard.loadKgIncludingSled,
    102,
  );

  relay.runSequenceMeters = Array(8).fill(1000);
  relay.distanceMeters = 8000;
  assert.ok(
    hyrox.validateHyroxPlan(relayPlan).errors.some((error) => (
      ['OFFICIAL_RUN_ORDER', 'UNTRUTHFUL_RELAY_ATHLETE_VOLUME'].includes(error.code)
    )),
    'validator rejects the old full-individual relay-athlete volume',
  );
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
  assertConsecutiveDayScheduleRegression();
  assertSafetyAndOrder();
  assertSaturdayEventCrossWeekSafety();
  assertPartialCurrentWeekAnchoringAndLoad();
  assertPartialWeekNoActivityLoadBounds();
  assertPartialRaceWeekSafety();
  assertCurrentWeekActivityMismatchMarker();
  assertSundayPartialWeekEdge();
  assertMidweekFoundationAnchoring();
  assertRaceDayTruthByFormat();
  assertSecondaryTransition();
  console.log('HYROX PLAN ENGINE SMOKE OK');
}

if (require.main === module) run();
module.exports = { run };
