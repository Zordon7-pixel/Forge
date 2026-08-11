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
  assertPersistenceAndWiring();
  console.log('HYROX EVENT CONTRACT SMOKE OK');
}

if (require.main === module) run();
module.exports = { run };
