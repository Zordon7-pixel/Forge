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

function assertRollingHardLowerBodyCap(plan, label) {
  const hardDates = [...new Set(plan.weeks.flatMap((week) => week.days.flatMap((day) => (
    day.sessions.filter((session) => session.hardLowerBody).map(() => day.date)
  ))))].sort();
  for (const start of hardDates) {
    const count = hardDates.filter((date) => {
      const delta = hyrox.daysBetweenLocalDates(date, start);
      return delta >= 0 && delta <= 6;
    }).length;
    assert.ok(count <= 2, `${label}: ${start} begins a rolling seven-day window with ${count} hard-lower-body days`);
  }
}

function assertRaceSafetyWindow(plan, eventLocalDate, label) {
  const raceEntries = plan.weeks.flatMap(weekEntries)
    .filter(({ session }) => session.sessionType === 'hyrox_race');
  assert.equal(raceEntries.length, 1, `${label}: exactly one HYROX race session`);
  assert.equal(raceEntries[0].date, eventLocalDate, `${label}: race remains on the exact event-local date`);
  for (const { date, session } of plan.weeks.flatMap(weekEntries)) {
    const daysBeforeRace = hyrox.daysBetweenLocalDates(eventLocalDate, date);
    if (daysBeforeRace < 0 || daysBeforeRace > 6 || session.sessionType === 'hyrox_race') continue;
    assert.equal(session.sessionType === 'hyrox_compromised', false, `${label}: no compromised session at race -${daysBeforeRace}`);
    assert.equal(Boolean(session.heavyStationWork), false, `${label}: no heavy station at race -${daysBeforeRace}`);
    assert.equal(session.runningStress === 'long', false, `${label}: no long run at race -${daysBeforeRace}`);
    assert.equal(session.runningStress === 'hard', false, `${label}: no hard run at race -${daysBeforeRace}`);
  }
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

function assertFourWeekShortRunwayPeakSpecificity() {
  assert.deepEqual(
    hyrox.allocatePhases('short_runway', 4),
    ['orientation_assessment', 'peak_partial_simulation', 'sharpen_reduce', 'taper_race'],
  );
  assert.deepEqual(
    hyrox.allocatePhases('short_runway', 5),
    ['orientation_assessment', 'build', 'peak_partial_simulation', 'sharpen_reduce', 'taper_race'],
  );

  const bryan = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate: '2026-08-14',
    athlete: { weeklyMilesCurrent: 22, runDaysPerWeek: 4 },
    currentLoad: { weeklyMiles: 22 },
    event: { raceId: 'hyrox-nyc', eventLocalDate: '2026-09-06' },
  }));
  assert.deepEqual(
    bryan.weeks.map((week) => week.phase),
    ['orientation_assessment', 'peak_partial_simulation', 'sharpen_reduce', 'taper_race'],
  );
  const peakWeek = bryan.weeks.find((week) => week.startDate === '2026-08-17');
  assert.equal(peakWeek?.phase, 'peak_partial_simulation');
  const peakSessions = peakWeek.days.flatMap((day) => day.sessions);
  const peakCompromised = peakSessions.filter((session) => session.sessionType === 'hyrox_compromised');
  assert.equal(peakSessions.some((session) => ['hyrox_strength', 'hyrox_skill'].includes(session.sessionType)), true);
  assert.equal(peakCompromised.length, 1, 'the peak week has one controlled compromised exposure');
  assert.equal(peakCompromised[0].runSequenceMeters.length, 6, 'the peak week owns the largest bounded partial cluster');
  const preReductionPairings = bryan.weeks
    .slice(0, bryan.weeks.findIndex((week) => week.phase === 'sharpen_reduce'))
    .map((week) => week.days.flatMap((day) => day.sessions)
      .find((session) => session.sessionType === 'hyrox_compromised')?.runSequenceMeters.length || 0);
  assert.equal(peakCompromised[0].runSequenceMeters.length, Math.max(...preReductionPairings));
  assert.equal(peakSessions.some((session) => session.sessionType === 'hyrox_simulation'), false);
  assert.equal(
    peakSessions.filter((session) => session.kind === 'hyrox' && !session.includesRun)
      .every((session) => session.distance_miles === undefined),
    true,
    'station meters never become running mileage',
  );
  assert.ok(runningMiles(peakWeek) <= bryan.inputSummary.effectiveWeeklyMiles);
  assert.equal(hyrox.validateHyroxPlan(bryan).valid, true);
  assertRollingHardLowerBodyCap(bryan, 'Bryan four-week fixture');
  assertRaceSafetyWindow(bryan, '2026-09-06', 'Bryan four-week fixture');

  const safetyHold = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate: '2026-08-14',
    athlete: { weeklyMilesCurrent: 22, runDaysPerWeek: 4, comebackMode: true, readiness: 'low' },
    currentLoad: { weeklyMiles: 22, readiness: 'low' },
    event: { raceId: 'hyrox-nyc', eventLocalDate: '2026-09-06' },
  }));
  const heldPeakSessions = safetyHold.weeks[1].days.flatMap((day) => day.sessions);
  assert.equal(safetyHold.weeks[1].phase, 'peak_partial_simulation');
  assert.equal(heldPeakSessions.some((session) => session.heavyStationWork), false);
  assert.ok(heldPeakSessions
    .filter((session) => session.sessionType === 'hyrox_compromised')
    .every((session) => session.runSequenceMeters.length <= 2));
  assert.equal(hyrox.validateHyroxPlan(safetyHold).valid, true);
  assertRollingHardLowerBodyCap(safetyHold, 'Bryan safety-hold fixture');
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
  const substitutions = allSessions(limited).flatMap((session) => session.stationSequence || [])
    .filter((station) => station.substitute);
  assert.ok(substitutions.length > 0);
  assert.equal(substitutions.every((station) => (
    station.readinessClaim === 'pattern_only'
    && station.exactStation === false
    && station.exactStationReadiness !== true
    && station.prescribedLoadKg === null
    && station.officialStandard === undefined
  )), true, 'equipment substitutions remain pattern-only and never satisfy exact station readiness');

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

function assertFridayCurrentWeekBoundaryRegression() {
  const planningDates = ['2026-08-14', '2026-08-15', '2026-08-16'];
  const schedules = [
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    ['Tue', 'Thu', 'Sat', 'Sun'],
  ];
  for (const planningLocalDate of planningDates) {
    for (const availableDays of schedules) {
      const plan = hyrox.generateHyroxPlan(fixture(null, {
        planningLocalDate,
        athlete: { weeklyMilesCurrent: 40, runDaysPerWeek: 4 },
        currentLoad: { weeklyMiles: 40 },
        event: { eventLocalDate: '2026-09-04' },
        availableDays,
      }));
      const label = `${planningLocalDate}/${availableDays.join('/')}`;
      assert.equal(hyrox.validateHyroxPlan(plan).valid, true, label);
      assertRollingHardLowerBodyCap(plan, label);
      assert.equal(
        plan.weeks[1].days.flatMap((day) => day.sessions)
          .some((session) => session.sessionType === 'hyrox_skill'),
        true,
        `${label}: the unsafe next heavy station is retained as non-heavy skill work`,
      );
    }
  }
}

function assertPlanningAndRaceWeekdayMatrix() {
  const planningDates = Array.from({ length: 7 }, (_, index) => hyrox.addLocalDays('2026-08-10', index));
  const eventDates = Array.from({ length: 7 }, (_, index) => hyrox.addLocalDays('2026-10-19', index));
  const scheduleCases = [
    { availableDays: ['Mon', 'Tue', 'Wed'], runDaysPerWeek: 3 },
    { availableDays: ['Tue', 'Wed', 'Thu'], runDaysPerWeek: 3 },
    { availableDays: ['Wed', 'Thu', 'Fri'], runDaysPerWeek: 3 },
    { availableDays: ['Fri', 'Sat', 'Sun'], runDaysPerWeek: 3 },
    { availableDays: ['Sat', 'Sun', 'Mon'], runDaysPerWeek: 3 },
    { availableDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4 },
    { availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], runDaysPerWeek: 4 },
  ];
  for (const planningLocalDate of planningDates) {
    for (const eventLocalDate of eventDates) {
      for (const { availableDays, runDaysPerWeek } of scheduleCases) {
        for (const weeklyMilesCurrent of [20, 40, 45]) {
          const label = `${planningLocalDate}/${eventLocalDate}/${runDaysPerWeek}/${availableDays.join('/')}/${weeklyMilesCurrent}`;
          const plan = hyrox.generateHyroxPlan(fixture(null, {
            planningLocalDate,
            athlete: { weeklyMilesCurrent, runDaysPerWeek },
            currentLoad: { weeklyMiles: weeklyMilesCurrent },
            event: { eventLocalDate },
            availableDays,
          }));
          const validation = hyrox.validateHyroxPlan(plan);
          assert.equal(validation.valid, true, `${label}: ${JSON.stringify(validation.errors)}`);
          assert.equal(plan.weeks[0].startDate, '2026-08-10', `${label}: current-week Monday anchor`);
          assert.equal(plan.weeks[1].startDate, '2026-08-17', `${label}: Week 2 starts next Monday`);
          assert.equal(plan.weeks.flatMap(weekEntries).every(({ date }) => date >= planningLocalDate), true, `${label}: no past sessions`);
          assertRollingHardLowerBodyCap(plan, label);
          assertRaceSafetyWindow(plan, eventLocalDate, label);
          for (const { session } of plan.weeks.flatMap(weekEntries)) {
            for (const field of ['distance_miles', 'distanceMeters', 'duration_min', 'durationMin']) {
              if (session[field] === null || session[field] === undefined) continue;
              assert.equal(Number.isFinite(Number(session[field])) && Number(session[field]) >= 0, true, `${label}: ${field} is finite and nonnegative`);
            }
          }
          if (planningLocalDate > '2026-08-10') {
            assert.ok(runningMiles(plan.weeks[0]) <= runningMiles(plan.weeks[1]), `${label}: partial running load remains bounded`);
            const firstWeekRuns = weekEntries(plan.weeks[0]).map(({ session }) => session)
              .filter((session) => session.kind === 'run');
            const long = firstWeekRuns.find((session) => session.runningStress === 'long');
            if (long) {
              assert.equal(
                firstWeekRuns.filter((session) => session.runningStress === 'easy')
                  .every((session) => session.distance_miles <= long.distance_miles),
                true,
                `${label}: easy runs do not exceed the long run`,
              );
            }
          }
        }
      }
    }
  }
}

function assertPreparedMileageBaselineAuthority() {
  const plan = hyrox.generateHyroxPlan(fixture(null, {
    athlete: { weeklyMilesCurrent: 40, runDaysPerWeek: 4 },
    currentLoad: { weeklyMiles: 12.5 },
    event: { eventLocalDate: '2026-10-19' },
    availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  }));
  assert.equal(plan.inputSummary.weeklyMileageBaseline, 12.5);
  assert.equal(plan.inputSummary.effectiveWeeklyMiles, 12.5);
  assert.ok(runningMiles(plan.weeks[1]) < 15, 'prepared currentLoad remains authoritative over a contradictory profile value');
}

function assertDateBasedRaceSafetyValidator() {
  const plan = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate: '2026-08-13',
    athlete: { weeklyMilesCurrent: 40, runDaysPerWeek: 4 },
    currentLoad: { weeklyMiles: 40 },
    event: { eventLocalDate: '2026-10-19' },
    availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  }));
  const unsafe = JSON.parse(JSON.stringify(plan));
  const dayBeforeRace = unsafe.weeks.flatMap((week) => week.days)
    .find((day) => day.date === '2026-10-18');
  dayBeforeRace.sessions.push({
    id: 'unsafe-day-before-race-long',
    kind: 'run',
    sessionType: 'long_run',
    runningStress: 'long',
    hardLowerBody: false,
  });
  assert.equal(
    hyrox.validateHyroxPlan(unsafe).errors.some((error) => error.code === 'RACE_SAFETY_WINDOW'),
    true,
    'the date-based validator rejects a long run on race day minus one regardless of calendar week',
  );
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
    const { plan, race } = raceSessionFor(format);
    assert.deepEqual(race.runSequenceMeters, Array(8).fill(1000), `${format} athlete runs all 8 legs`);
    assert.equal(race.distanceMeters, 8000);
    assert.equal(race.distance_miles, 4.97);
    assert.deepEqual(race.stationSequence.map((station) => station.id), STATION_ORDER);
    assert.deepEqual(race.officialTeamStationSequence.map((station) => station.id), STATION_ORDER);
    assert.deepEqual(race.officialTeamRaceSequence.map((item) => item.kind), Array.from({ length: 16 }, (_, index) => (
      index % 2 === 0 ? 'run' : 'station'
    )));
    const state = hyrox.buildHyroxEventState({
      athlete_id: 'race-truth-fixture',
      format: format === 'doubles' ? 'doubles' : 'singles',
      event_format: format,
      registered_division: 'men',
      ruleset_id: 'hyrox-global',
      ruleset_version: plan.standardsProvenance.rulesVersion,
    });
    assert.equal(state.official_run_requirements.length, 8);
    assert.equal(
      state.official_station_requirements.every((station) => (
        station.ownership === (format === 'doubles' ? 'team_shared' : 'athlete')
      )),
      true,
    );
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

function assertGoalBackwardModeCompatibility() {
  const previousMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  try {
    delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    const missingMode = hyrox.generateHyroxPlan(fixture(35));
    process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'off';
    const explicitOff = hyrox.generateHyroxPlan(fixture(35));
    assert.deepEqual(explicitOff, missingMode, 'missing and explicit off retain byte-compatible plan data');
    process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'invalid-mode';
    const invalidMode = hyrox.generateHyroxPlan(fixture(35));
    assert.deepEqual(invalidMode, missingMode, 'invalid mode also fails closed to byte-compatible plan data');
    assert.equal(Object.hasOwn(missingMode, 'hyroxEventState'), false);
    assert.equal(Object.hasOwn(missingMode, 'hyroxPerformanceBudget'), false);
    assert.equal(Object.hasOwn(missingMode.goal, 'rulesetId'), false);
    assert.equal(Object.hasOwn(missingMode.standardsProvenance, 'rulesetId'), false);
    assert.equal(allSessions(missingMode).every((session) => !Object.hasOwn(session, 'rulesetId')), true);
    assert.equal(
      allSessions(missingMode).flatMap((session) => session.stationSequence || [])
        .every((station) => !Object.hasOwn(station, 'exactStationReadiness')),
      true,
    );

    process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'shadow';
    assert.deepEqual(
      hyrox.generateHyroxPlan(fixture(35)),
      missingMode,
      'shadow returns the current candidate byte-for-byte',
    );

    process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';
    const enabled = hyrox.generateHyroxPlan(fixture(35));
    assert.equal(enabled.hyroxEventState.format, 'singles');
    assert.equal(enabled.hyroxEventState.ruleset_status, 'exact');
    assert.equal(enabled.hyroxPerformanceBudget.projected_run_time_s, null);
    assert.equal(enabled.hyroxPerformanceBudget.supported, false);
    assert.equal(enabled.standardsProvenance.rulesetId, 'hyrox-global');
    const enabledPeak = enabled.weeks.flatMap((week) => week.days)
      .flatMap((day) => day.sessions)
      .find((session) => session.workout_family === 'hyrox_partial_simulation');
    assert.ok(enabledPeak, 'v2.4 replaces only the flagged peak exposure with the closed cluster');
    assert.ok(enabledPeak.run_station_pair_count >= 2 && enabledPeak.run_station_pair_count <= 4);
    assert.equal(hyrox.validatePartialRaceOrderCluster(enabledPeak, {
      training_age_class: 'ESTABLISHED',
    }).valid, true);
    assert.equal(
      allSessions(enabled).filter((session) => session.sessionType === 'hyrox_compromised')
        .some((session) => session.runSequenceMeters?.length === 6),
      false,
      'the old six-pair compromised workout is not relabeled as compliant in v2.4',
    );
    assert.equal(
      allSessions(missingMode).some((session) => (
        session.sessionType === 'hyrox_compromised' && session.runSequenceMeters?.length === 6
      )),
      true,
      'flag-off retains the existing six-pair compromised workout byte-for-byte',
    );
  } finally {
    if (previousMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    else process.env.FORGE_GOAL_BACKWARD_V24_MODE = previousMode;
  }
}

function combinations(values, size, start = 0, prefix = [], output = []) {
  if (prefix.length === size) {
    output.push(prefix);
    return output;
  }
  for (let index = start; index <= values.length - (size - prefix.length); index += 1) {
    combinations(values, size, index + 1, [...prefix, values[index]], output);
  }
  return output;
}

function assertClusterPlacementMatrixDoesNotCrash() {
  const previousMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';
  try {
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const schedules = [
      ...combinations(weekdays, 4),
      ...combinations(weekdays, 5),
      ...combinations(weekdays, 6),
    ];
    const planningDates = weekdays.map((_, offset) => hyrox.addLocalDays('2026-08-03', offset));
    for (const runwayDays of [28, 42, 84]) {
      for (const planningLocalDate of planningDates) {
        for (const availableDays of schedules) {
          const eventLocalDate = hyrox.addLocalDays(planningLocalDate, runwayDays);
          const label = `${planningLocalDate} +${runwayDays}d ${availableDays.join('/')}`;
          let plan;
          assert.doesNotThrow(() => {
            plan = hyrox.generateHyroxPlan(fixture(null, {
              planningLocalDate,
              availableDays,
              event: { raceId: 'matrix-hyrox', eventLocalDate },
            }));
          }, `cluster placement must not crash for ${label}`);
          assert.equal(hyrox.validateHyroxPlan(plan).valid, true, label);
          if (plan.hyroxPolicy.partialRaceOrderCluster.required
            && plan.hyroxPolicy.partialRaceOrderCluster.unplaceable) {
            assert.equal(plan.overall_feasibility, 'at_risk', label);
            assert.ok(plan.reasons.includes('REQUIRED_EXPOSURE_UNPLACEABLE'), label);
          }
        }
      }
    }
  } finally {
    if (previousMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    else process.env.FORGE_GOAL_BACKWARD_V24_MODE = previousMode;
  }
}

function assertSecondaryTransition() {
  const planningLocalDate = '2026-08-14';
  const eventDate = '2026-09-06';
  const secondaryRace = {
    kind: 'run_race',
    raceId: 'army-ten-miler-2026',
    name: 'Army Ten-Miler',
    eventLocalDate: '2026-10-11',
    eventTimezone: 'America/New_York',
    distanceMiles: 10,
    goalType: 'pr',
    goalTimeSeconds: 5220,
  };
  const plan = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate,
    athlete: { weeklyMilesCurrent: 22, runDaysPerWeek: 4 },
    currentLoad: { weeklyMiles: 22 },
    event: { raceId: 'hyrox-nyc', eventLocalDate: eventDate },
    secondaryRace,
  }));
  assert.deepEqual(plan.goals.map((goal) => goal.kind), ['hyrox', 'run_race']);
  assert.deepEqual(plan.goals.map((goal) => goal.raceId), ['hyrox-nyc', 'army-ten-miler-2026']);
  assert.equal(plan.goals[1].goalType, 'pr');
  assert.equal(plan.goals[1].goalTimeSeconds, 5220);
  assert.equal(plan.goals[1].goalPaceSecondsPerMile, 522);
  assert.equal(plan.goals[1].goalPaceLabel, '8:42/mi');
  const raceWeek = plan.weeks.findIndex((week) => week.days.some((day) => (
    day.sessions.some((session) => session.sessionType === 'hyrox_race')
  )));
  assert.equal(plan.weeks[raceWeek + 1].phase, 'post_hyrox_recovery');
  const recoverySessions = plan.weeks[raceWeek + 1].days.flatMap((day) => day.sessions);
  assert.equal(recoverySessions.every((session) => session.runningStress === 'easy'), true);
  const specificWeeks = plan.weeks.filter((week) => week.phase === 'running_specific');
  assert.ok(specificWeeks.length >= 2);
  const specificSessions = specificWeeks.map((week) => (
    week.days.flatMap((day) => day.sessions)
      .find((session) => session.sessionType === 'running_specific')
  ));
  assert.equal(specificSessions.every(Boolean), true);
  for (const session of specificSessions) {
    assert.equal(session.goal_pace_seconds_per_mile, 522);
    assert.equal(session.goal_pace_label, '8:42/mi');
    assert.equal(session.pace_target, '8:42/mi');
    assert.notEqual(session.target_zone, 'Zone 2');
    assert.ok(Array.isArray(session.warmup) && session.warmup.length > 0);
    assert.ok(Array.isArray(session.steps) && session.steps.length > 0);
    assert.ok(Array.isArray(session.cooldown) && session.cooldown.length > 0);
    assert.doesNotMatch(`${session.title} ${session.description || ''}`, /easy aerobic|time trial/i);
  }
  const longRuns = specificWeeks.map((week) => (
    week.days.flatMap((day) => day.sessions).find((session) => session.sessionType === 'long_run')
  ));
  assert.equal(longRuns.every(Boolean), true);
  assert.equal(longRuns.every((session) => session.distance_miles < 10), true, 'training never jumps to race distance');
  assert.equal(
    longRuns.every((session, index) => index === 0 || session.distance_miles > longRuns[index - 1].distance_miles),
    true,
    'the long run rises across the bounded running-specific block',
  );
  assert.equal(plan.weeks.at(-1).phase, 'running_taper_race');
  assert.equal(
    plan.weeks.at(-1).days.flatMap((day) => day.sessions)
      .some((session) => session.sessionType === 'long_run'),
    false,
    'long-run loading is removed before the retained race',
  );
  for (const week of plan.weeks.slice(raceWeek + 1)) {
    assert.ok(runningMiles(week) <= plan.inputSummary.effectiveWeeklyMiles);
  }
  assert.equal(plan.weeks.some((week, index) => index > raceWeek && week.phase === 'base_development'), false);
  assert.equal(hyrox.validateHyroxPlan(plan).valid, true);
  assertRollingHardLowerBodyCap(plan, 'HYROX plus Army fixture');

  const effortBased = hyrox.generateHyroxPlan(fixture(null, {
    planningLocalDate,
    event: { raceId: 'hyrox-nyc', eventLocalDate: eventDate },
    secondaryRace: { ...secondaryRace, goalType: 'completion', goalTimeSeconds: null },
  }));
  const effortSession = allSessions(effortBased).find((session) => session.sessionType === 'running_specific');
  assert.equal(effortSession.goal_pace_seconds_per_mile, undefined);
  assert.match(effortSession.pace_target, /10-mile effort|RPE/i);
  assert.notEqual(effortSession.target_zone, 'Zone 2');
}

function run() {
  assertRunways();
  assertFiveWeekPlanIsGeneric();
  assertFourWeekShortRunwayPeakSpecificity();
  assertTimezoneStability();
  assertFrequencyAndEquipment();
  assertConsecutiveDayScheduleRegression();
  assertSafetyAndOrder();
  assertSaturdayEventCrossWeekSafety();
  assertFridayCurrentWeekBoundaryRegression();
  assertPlanningAndRaceWeekdayMatrix();
  assertPreparedMileageBaselineAuthority();
  assertDateBasedRaceSafetyValidator();
  assertPartialCurrentWeekAnchoringAndLoad();
  assertPartialWeekNoActivityLoadBounds();
  assertPartialRaceWeekSafety();
  assertCurrentWeekActivityMismatchMarker();
  assertSundayPartialWeekEdge();
  assertMidweekFoundationAnchoring();
  assertRaceDayTruthByFormat();
  assertGoalBackwardModeCompatibility();
  assertClusterPlacementMatrixDoesNotCrash();
  assertSecondaryTransition();
  console.log('HYROX PLAN ENGINE SMOKE OK');
}

if (require.main === module) run();
module.exports = { run };
