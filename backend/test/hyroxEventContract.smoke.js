#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const standards = require('../src/lib/hyroxStandards');
const planSchema = require('../src/lib/planSchema');
const racesRouter = require('../src/routes/races');
const plansRouter = require('../src/routes/plans');

const ROOT = path.join(__dirname, '..');

function assertStandards() {
  assert.equal(standards.REGISTRY.schemaVersion, 1);
  assert.equal(standards.REGISTRY.rulesVersion, '2026-2027');
  assert.match(standards.REGISTRY.sourceUrl, /^https:\/\/hyrox\.com\//);
  assert.match(standards.REGISTRY.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(standards.REGISTRY.canonicalUnits, 'metric');
  assert.deepEqual(standards.STATION_ORDER, [
    'ski_erg', 'sled_push', 'sled_pull', 'burpee_broad_jump',
    'row', 'farmers_carry', 'sandbag_lunge', 'wall_ball',
  ]);
  assert.deepEqual(
    standards.REGISTRY.stations.map((station) => station.runBeforeMeters),
    Array(8).fill(1000),
  );
  const resolved = standards.resolveHyroxStandard({
    format: 'individual_open', category: 'men', rulesVersion: '2026-2027',
  });
  assert.equal(resolved.status, 'exact');
  assert.equal(resolved.stations.length, 8);
  assert.equal(resolved.stations.find((station) => station.id === 'sled_push').distanceMeters, 50);
  assert.equal(resolved.stations.find((station) => station.id === 'wall_ball').repetitions, 100);
  const mixedDoubles = standards.resolveHyroxStandard({
    format: 'doubles', category: 'mixed', rulesVersion: '2026-2027',
  });
  assert.equal(mixedDoubles.status, 'exact');
  assert.equal(mixedDoubles.stations.find((station) => station.id === 'sled_push').loadKgIncludingSled, 152);
  assert.equal(mixedDoubles.stations.find((station) => station.id === 'farmers_carry').loadKgPerImplement, 24);
  assert.equal(mixedDoubles.stations.find((station) => station.id === 'wall_ball').ballKg, 6);
  const mixedRelay = standards.resolveHyroxStandard({
    format: 'relay', category: 'mixed', rulesVersion: '2026-2027',
  });
  assert.equal(mixedRelay.status, 'exact');
  const relayPush = mixedRelay.stations.find((station) => station.id === 'sled_push');
  assert.equal(relayPush.loadKgIncludingSled, undefined, 'mixed relay must not claim one shared men-only sled load');
  assert.deepEqual(relayPush.loadsByAthleteCategory, {
    women: { loadKgIncludingSled: 102 },
    men: { loadKgIncludingSled: 152 },
  });
  assert.deepEqual(mixedRelay.stations.find((station) => station.id === 'farmers_carry').loadsByAthleteCategory, {
    women: { implements: 2, loadKgPerImplement: 16 },
    men: { implements: 2, loadKgPerImplement: 24 },
  });
  assert.deepEqual(mixedRelay.stations.find((station) => station.id === 'wall_ball').loadsByAthleteCategory, {
    women: { ballKg: 4, targetHeightMeters: 2.7 },
    men: { ballKg: 6, targetHeightMeters: 3.0 },
  });
  assert.equal(standards.resolveHyroxStandard({
    format: 'individual_open', category: null, rulesVersion: '2026-2027',
  }).status, 'incomplete');
  assert.equal(standards.resolveHyroxStandard({
    format: 'individual_open', category: 'men', rulesVersion: 'invented-season',
  }).status, 'unsupported_rules_version');
}

function assertEventNormalization() {
  const normalized = racesRouter._test.normalizeRaceEvent({
    race_name: 'HYROX Tokyo',
    event_kind: 'hyrox',
    event_local_date: '2026-10-18',
    event_timezone: 'Asia/Tokyo',
    event_format: 'Open',
    event_category: 'Male',
    rules_version: '2026-2027',
    event_config_json: {
      schemaVersion: 1,
      equipment: ['row_erg', 'ski_erg', 'row_erg'],
      runningPriority: 'improve',
    },
  });
  assert.equal(normalized.valid, true, normalized.error);
  assert.equal(normalized.value.race_date, '2026-10-18');
  assert.equal(normalized.value.event_local_date, '2026-10-18');
  assert.equal(normalized.value.event_timezone, 'Asia/Tokyo');
  assert.equal(normalized.value.event_format, 'individual_open');
  assert.equal(normalized.value.event_category, 'men');
  assert.equal(normalized.value.distance_miles, standards.HYROX_RUN_DISTANCE_MILES);
  assert.deepEqual(JSON.parse(normalized.value.event_config_json).equipment, ['ski_erg', 'row_erg']);

  const relay = racesRouter._test.normalizeRaceEvent({
    race_name: 'HYROX Relay',
    event_kind: 'hyrox',
    event_local_date: '2026-10-18',
    event_timezone: 'Asia/Tokyo',
    event_format: 'relay',
    event_category: 'women',
    rules_version: '2026-2027',
  });
  assert.equal(relay.valid, true, relay.error);
  assert.equal(
    relay.value.distance_miles,
    standards.HYROX_RELAY_ATHLETE_RUN_DISTANCE_MILES,
    'relay race records store the athlete-specific two-leg run distance',
  );
  assert.equal(standards.hyroxAthleteRunDistanceMiles('doubles'), standards.HYROX_RUN_DISTANCE_MILES);

  const invalidZone = racesRouter._test.normalizeRaceEvent({
    race_name: 'HYROX Anywhere',
    event_kind: 'hyrox',
    event_local_date: '2026-10-18',
    event_timezone: 'not/a_timezone',
    event_format: 'individual_open',
    event_category: 'men',
    rules_version: '2026-2027',
  });
  assert.equal(invalidZone.valid, false);
  assert.match(invalidZone.error, /IANA timezone/);

  const incomplete = racesRouter._test.normalizeRaceEvent({
    race_name: 'HYROX Anywhere',
    event_kind: 'hyrox',
    event_local_date: '2026-10-18',
    event_timezone: 'Europe/London',
    event_format: 'individual_open',
    rules_version: '2026-2027',
  });
  assert.equal(incomplete.valid, false);
  assert.match(incomplete.error, /event_category/);

  for (const [eventFormat, eventCategory] of [
    ['individual_open', 'women'],
    ['individual_pro', 'men'],
    ['doubles', 'women'],
    ['doubles', 'men'],
    ['doubles', 'mixed'],
    ['relay', 'women'],
    ['relay', 'men'],
    ['relay', 'mixed'],
  ]) {
    const supported = racesRouter._test.normalizeRaceEvent({
      race_name: eventFormat === 'doubles' ? 'HYROX Washington, D.C.' : 'Custom worldwide HYROX',
      event_kind: 'hyrox',
      event_local_date: '2026-09-06',
      event_timezone: 'America/New_York',
      event_format: eventFormat,
      event_category: eventCategory,
      rules_version: '2026-2027',
    });
    assert.equal(supported.valid, true, `${eventFormat}/${eventCategory}: ${supported.error}`);
    assert.equal(
      supported.value.distance_miles,
      eventFormat === 'relay'
        ? standards.HYROX_RELAY_ATHLETE_RUN_DISTANCE_MILES
        : standards.HYROX_RUN_DISTANCE_MILES,
      `${eventFormat}/${eventCategory} persists truthful athlete run distance`,
    );
  }
}

function hyroxContext(overrides = {}) {
  return {
    profile: {
      weekly_miles_current: 20,
      run_days_per_week: 5,
      comeback_mode: false,
    },
    history: { weeklyMileageBaseline: 20 },
    recovery: { state: 'normal' },
    target: {
      runDaysPerWeek: 3,
      trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'],
      hyroxEquipment: standards.EQUIPMENT_KEYS,
      hyroxEvent: {
        raceId: 'owned-hyrox',
        name: 'HYROX Washington, D.C.',
        eventLocalDate: '2026-09-06',
        eventTimezone: 'America/New_York',
        format: 'doubles',
        category: 'men',
        rulesVersion: '2026-2027',
      },
      ...overrides.target,
    },
    ...overrides.context,
  };
}

function assertPreviewGenerationContract() {
  const exactUserScenario = plansRouter._test.buildDeterministicCandidate(
    hyroxContext(),
    { planningDateLocal: '2026-08-11', timezoneOffsetMinutes: 240 },
  );
  assert.equal(exactUserScenario.validation.valid, true);
  assert.equal(exactUserScenario.plan.goal.division, 'doubles');
  assert.equal(exactUserScenario.plan.goal.category, 'men');
  assert.equal(exactUserScenario.plan.schedulePreferences.runDaysPerWeek, 3);
  assert.deepEqual(exactUserScenario.plan.schedulePreferences.trainingDays, ['Tue', 'Thu', 'Sat', 'Sun']);

  for (const [format, category, name] of [
    ['individual_open', 'women', 'HYROX New York'],
    ['individual_pro', 'men', 'Custom gym HYROX assessment'],
    ['doubles', 'mixed', 'HYROX Berlin'],
    ['relay', 'women', 'Custom worldwide relay'],
  ]) {
    const built = plansRouter._test.buildDeterministicCandidate(hyroxContext({
      target: { hyroxEvent: { ...hyroxContext().target.hyroxEvent, format, category, name } },
    }), { planningDateLocal: '2026-08-11', timezoneOffsetMinutes: 240 });
    assert.equal(built.validation.valid, true, `${format}/${category}`);
    assert.equal(built.plan.goal.division, format);
    assert.equal(built.plan.goal.category, category);
  }

  assert.throws(
    () => plansRouter._test.buildDeterministicCandidate(hyroxContext({
      target: { trainingDays: ['Tue', 'Thu'] },
    }), { planningDateLocal: '2026-08-11', timezoneOffsetMinutes: 240 }),
    (error) => (
      error.status === 400
      && error.code === 'INVALID_RUN_SCHEDULE'
      && /at least as many training weekdays/i.test(error.message)
    ),
  );
  assert.throws(
    () => plansRouter._test.buildDeterministicCandidate(hyroxContext({
      target: {
        hyroxEvent: { ...hyroxContext().target.hyroxEvent, format: 'invented-format' },
      },
    }), { planningDateLocal: '2026-08-11', timezoneOffsetMinutes: 240 }),
    (error) => error.status === 400 && error.code === 'UNSUPPORTED_HYROX_DIVISION',
  );
  assert.throws(
    () => plansRouter._test.buildDeterministicCandidate(
      hyroxContext(),
      { planningDateLocal: 'not-a-date', timezoneOffsetMinutes: 240 },
    ),
    (error) => error.status === 400 && error.code === 'INVALID_PLANNING_DATE',
  );
}

function assertPersistenceAndWiring() {
  assert.equal(planSchema.PLAN_MODES.HYROX_BUILD, 'hyrox_build');
  assert.equal(planSchema.getPlanMode({ planMode: 'hyrox_build', weeks: [] }), 'hyrox_build');
  const migrate = fs.readFileSync(path.join(ROOT, 'src/db/migrate.js'), 'utf8');
  const dbIndex = fs.readFileSync(path.join(ROOT, 'src/db/index.js'), 'utf8');
  const races = fs.readFileSync(path.join(ROOT, 'src/routes/races.js'), 'utf8');
  const plans = fs.readFileSync(path.join(ROOT, 'src/routes/plans.js'), 'utf8');
  const fields = [
    'event_kind', 'event_format', 'event_category', 'event_local_date',
    'event_timezone', 'rules_version', 'event_config_json',
  ];
  for (const field of fields) {
    assert.ok(migrate.includes(`ADD COLUMN IF NOT EXISTS ${field}`));
    assert.ok(dbIndex.includes(field));
  }
  assert.match(races, /router\.post\('\/', auth,/);
  assert.match(races, /WHERE id=\? AND user_id=\?/);
  assert.match(plans, /hyroxPlan\.generateHyroxPlan/);
  assert.match(plans, /buildDeterministicCandidate/);

  const built = plansRouter._test.buildDeterministicCandidate({
    profile: { weekly_miles_current: 20, run_days_per_week: 4, comeback_mode: false },
    history: { weeklyMileageBaseline: 20 },
    recovery: { state: 'normal' },
    target: {
      trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      hyroxEquipment: standards.EQUIPMENT_KEYS,
      hyroxEvent: {
        raceId: 'owned-hyrox',
        name: 'HYROX Tokyo',
        eventLocalDate: '2026-09-14',
        eventTimezone: 'Asia/Tokyo',
        format: 'individual_open',
        category: 'men',
        rulesVersion: '2026-2027',
      },
    },
  }, { planningDateLocal: '2026-08-10', timezoneOffsetMinutes: -540 });
  assert.equal(built.validation.valid, true);
  assert.equal(built.plan.planMode, 'hyrox_build');
  assert.equal(built.plan.goal.raceId, 'owned-hyrox');
}

function run() {
  assertStandards();
  assertEventNormalization();
  assertPreviewGenerationContract();
  assertPersistenceAndWiring();
  console.log('HYROX EVENT CONTRACT SMOKE OK');
}

if (require.main === module) run();
module.exports = { run };
