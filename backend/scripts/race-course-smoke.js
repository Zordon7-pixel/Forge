#!/usr/bin/env node
// Forged Hybrid H7 - race course intelligence & provenance smoke.
// Pure, deterministic, no DB and no external network. Fixture data only.

const assert = require('assert');
const raceCourse = require('../src/lib/raceCourse');
const concurrentPlan = require('../src/lib/concurrentPlan');

const NOW = '2026-07-12T00:00:00.000Z';
const SEED_ASOF = '2026-07-12T00:00:00.000Z';

const armyRow = {
  id: 'army-10-miler-2026-10-11',
  name: 'Army 10-Miler',
  race_date: '2026-10-11',
  distance_miles: 10.0,
  city: 'Washington',
  state: 'DC',
  source: 'Army Ten-Miler',
  url: 'https://www.armytenmiler.com/',
  elevation_gain_ft: 190,
  max_altitude_ft: 100,
  terrain: 'road',
};
const armyRow2027 = Object.assign({}, armyRow, {
  id: 'army-10-miler-2027-10-10',
  race_date: '2027-10-10',
});
const bostonRow = {
  id: 'boston-marathon-2027-04-19',
  name: 'Boston Marathon',
  race_date: '2027-04-19',
  distance_miles: 26.2,
  source: 'Boston Athletic Association',
  url: 'https://www.baa.org/',
  elevation_gain_ft: 815,
  max_altitude_ft: 490,
  terrain: 'road',
};
const catalog = [armyRow, bostonRow];
const catalogAmbiguous = [armyRow, armyRow2027, bostonRow];

function armyEnvelopeJson() {
  return JSON.stringify(raceCourse.buildCatalogCourseEnvelope(armyRow, { asOf: SEED_ASOF, provenance: 'curated' }));
}

function testResolution() {
  assert.strictEqual(raceCourse.normalizeRaceName('Army Ten-Miler'), 'army 10 miler', 'alias normalizes');
  assert.strictEqual(raceCourse.normalizeRaceName('army 10-miler'), 'army 10 miler', 'hyphen form normalizes');
  const r = raceCourse.resolveCatalogRace({ catalog, name: 'Army Ten-Miler', date: '2026-10-11', distanceMiles: 10 });
  assert.strictEqual(r.status, 'resolved', 'army resolves');
  assert.strictEqual(r.race.id, 'army-10-miler-2026-10-11', 'resolves to 2026 edition');
  const byId = raceCourse.resolveCatalogRace({ catalog, id: 'army-10-miler-2026-10-11' });
  assert.strictEqual(byId.status, 'resolved', 'exact id resolves');

  const wrongYear = raceCourse.resolveCatalogRace({ catalog, name: 'Army Ten-Miler', date: '2025-10-12', distanceMiles: 10 });
  assert.notStrictEqual(wrongYear.status, 'resolved', 'wrong year does not resolve');
  const ambiguous = raceCourse.resolveCatalogRace({ catalog: catalogAmbiguous, name: 'Army Ten-Miler' });
  assert.strictEqual(ambiguous.status, 'ambiguous', 'multiple editions without disambiguator is ambiguous');
  const missing = raceCourse.resolveCatalogRace({ catalog, name: 'Some Race That Does Not Exist' });
  assert.strictEqual(missing.status, 'unknown', 'unknown name does not resolve');
  const disamb = raceCourse.resolveCatalogRace({ catalog: catalogAmbiguous, name: 'Army Ten-Miler', date: '2027-10-10' });
  assert.strictEqual(disamb.status, 'resolved', 'exact date disambiguates editions');
  assert.strictEqual(disamb.race.id, 'army-10-miler-2027-10-10');
  console.log('resolution + edition gating: OK');
}

function testTrustGating() {
  const manual = raceCourse.evaluateCourseTrust({ envelope: null, looseFacts: {}, raceDate: '2026-12-01', nowISO: NOW });
  assert.strictEqual(manual.trusted, false, 'manual/no-data is untrusted');
  assert.strictEqual(manual.state, raceCourse.COURSE_STATES.DISTANCE_ONLY, 'manual is distance-only');
  assert.deepStrictEqual(manual.facts, {}, 'no course facts surfaced for manual');

  const trusted = raceCourse.evaluateCourseTrust({ envelope: armyEnvelopeJson(), raceDate: '2026-10-11', nowISO: NOW });
  assert.strictEqual(trusted.trusted, true, 'curated + current edition is trusted');
  assert.strictEqual(trusted.state, raceCourse.COURSE_STATES.CURATED);
  assert.strictEqual(trusted.facts.elevationGainFt, 190, 'trusted elevation surfaced');

  const staleEdition = raceCourse.evaluateCourseTrust({ envelope: armyEnvelopeJson(), raceDate: '2027-10-10', nowISO: NOW });
  assert.strictEqual(staleEdition.trusted, false, 'edition mismatch is untrusted');
  assert.strictEqual(staleEdition.state, raceCourse.COURSE_STATES.STALE);
  assert.deepStrictEqual(staleEdition.facts, {}, 'stale facts are not surfaced');

  const oldEnvelope = raceCourse.buildCatalogCourseEnvelope(armyRow, { asOf: '2020-01-01T00:00:00.000Z', provenance: 'curated' });
  const staleAge = raceCourse.evaluateCourseTrust({ envelope: oldEnvelope, raceDate: '2026-10-11', nowISO: NOW });
  assert.strictEqual(staleAge.trusted, false, 'aged facts are stale');
  assert.strictEqual(staleAge.state, raceCourse.COURSE_STATES.STALE);

  const officialEnv = raceCourse.buildCatalogCourseEnvelope(armyRow, { asOf: SEED_ASOF, provenance: 'official' });
  const verified = raceCourse.evaluateCourseTrust({ envelope: officialEnv, raceDate: '2026-10-11', nowISO: NOW });
  assert.strictEqual(verified.state, raceCourse.COURSE_STATES.VERIFIED, 'official is verified state');

  const legacy = raceCourse.evaluateCourseTrust({
    envelope: { elevationGainFt: 190, terrain: 'road' },
    looseFacts: { elevationGainFt: 190, terrain: 'road', source: 'Army Ten-Miler', url: 'https://x' },
    raceDate: '2026-10-11',
    nowISO: NOW,
  });
  assert.strictEqual(legacy.trusted, true, 'legacy curated loose facts remain trusted');
  console.log('trust/stale/verified gating: OK');
}

function buildGpx(points) {
  const pts = points.map((p) => `<trkpt lat="${p.lat}" lon="${p.lng}"><ele>${p.ele}</ele></trkpt>`).join('');
  return `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${pts}</trkseg></trk></gpx>`;
}
function linePoints(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ lat: 38.9 + i * 0.001, lng: -77.0 + i * 0.001, ele: 30 + (i % 5) * 4 });
  }
  return out;
}

async function testGpx() {
  const analysis = await raceCourse.analyzeGpx(buildGpx(linePoints(30)), { asOf: NOW });
  assert.ok(analysis.distanceMiles > 0, 'gpx yields positive distance');
  assert.ok(analysis.elevationGainFt >= 0, 'gpx elevation gain is non-negative');
  assert.strictEqual(analysis.privacy.coordinatesStored, false, 'privacy: no coordinates stored');
  assert.strictEqual(analysis.privacy.startEndStored, false, 'privacy: no start/end stored');

  const analysis2 = await raceCourse.analyzeGpx(buildGpx(linePoints(30)), { asOf: NOW });
  assert.strictEqual(analysis.distanceMiles, analysis2.distanceMiles, 'gpx distance deterministic');
  assert.strictEqual(analysis.elevationGainFt, analysis2.elevationGainFt, 'gpx elevation deterministic');

  const gpxEnvelope = raceCourse.buildUserGpxEnvelope(analysis, { asOf: NOW });
  const serialized = JSON.stringify(gpxEnvelope);
  assert.ok(!/"lat"/i.test(serialized), 'serialized envelope has no lat');
  assert.ok(!/"lng"/i.test(serialized) && !/"lon"/i.test(serialized), 'serialized envelope has no lng/lon');
  assert.ok(!/38\.9/.test(serialized), 'serialized envelope has no raw coordinate values');
  assert.ok(!/startLat|endLat|start_point|end_point/i.test(serialized), 'no start/end points');
  assert.strictEqual(gpxEnvelope.provenance, 'user_gpx', 'gpx envelope provenance is user_gpx');

  await assert.rejects(() => raceCourse.analyzeGpx('not xml at all <<<', {}), /valid XML|root element/i, 'invalid XML rejected');
  await assert.rejects(() => raceCourse.analyzeGpx(buildGpx(linePoints(3)), {}), /too few/i, 'too-few-points rejected');
  const badCoords = [{ lat: 200, lng: 0, ele: 10 }, { lat: 201, lng: 0, ele: 10 }].concat(linePoints(12));
  await assert.rejects(() => raceCourse.analyzeGpx(buildGpx(badCoords), {}), /out-of-range coordinates/i, 'out-of-range coords rejected');

  const gpxTrust = raceCourse.evaluateCourseTrust({ envelope: gpxEnvelope, raceDate: '2026-10-11', nowISO: NOW });
  assert.strictEqual(gpxTrust.state, raceCourse.COURSE_STATES.USER_GPX, 'gpx envelope is user_gpx state');
  assert.strictEqual(gpxTrust.trusted, true, 'gpx envelope is trusted');
  console.log('GPX analysis + privacy: OK');
}

function testCorrectionHistory() {
  let env = raceCourse.buildCatalogCourseEnvelope(armyRow, { asOf: SEED_ASOF, provenance: 'curated' });
  env = raceCourse.appendCorrection(env, { field: 'elevationGainFt', previous: 190, next: 205, reason: 'organizer update' });
  env = raceCourse.appendCorrection(env, { field: 'terrain', previous: 'road', next: 'road/gravel', reason: 'reroute' });
  assert.strictEqual(env.corrections.length, 2, 'two corrections retained');
  assert.strictEqual(env.corrections[0].field, 'elevationGainFt', 'first correction preserved');
  assert.strictEqual(env.corrections[1].next, 'road/gravel', 'second correction preserved');
  console.log('correction history: OK');
}

function testPlanIntegration() {
  const distanceOnlyTarget = {
    raceName: 'Backyard Fun Run',
    raceDate: '2026-10-11',
    distanceMiles: 10,
    weeks: 13,
    startDate: '2026-07-13',
    todayISO: '2026-07-12',
    nowISO: NOW,
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  };
  const plan = concurrentPlan.buildConcurrentPlan({ target: distanceOnlyTarget, profile: {}, history: {}, recovery: {} });
  const goal = concurrentPlan.goalMetadata(distanceOnlyTarget, {});
  assert.ok(!goal.course || goal.course.elevationGainFt === undefined, 'distance-only goal has no elevation fact');
  assert.ok(!/Course-specific/i.test(JSON.stringify(plan)), 'distance-only plan invents no course-specific work');

  const hillyRow = Object.assign({}, armyRow, { elevation_gain_ft: 450 });
  const hillyEnvelope = JSON.stringify(raceCourse.buildCatalogCourseEnvelope(hillyRow, { asOf: SEED_ASOF, provenance: 'curated' }));
  const hillyTarget = {
    raceName: 'Army 10-Miler',
    raceDate: '2026-10-11',
    distanceMiles: 10,
    weeks: 13,
    startDate: '2026-07-13',
    todayISO: '2026-07-12',
    nowISO: NOW,
    elevation_gain_ft: 450,
    terrain: 'road',
    source: 'Army Ten-Miler',
    course_profile_json: hillyEnvelope,
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  };
  const hillyPlan = concurrentPlan.buildConcurrentPlan({ target: hillyTarget, profile: {}, history: {}, recovery: {} });
  assert.ok(/Course-specific/i.test(JSON.stringify(hillyPlan)), 'trusted hilly course drives course-specific work');

  const fabTarget = Object.assign({}, distanceOnlyTarget);
  const fabricated = {
    schemaVersion: 2,
    planMode: 'run_only',
    goal: { distanceMiles: 10, date: '2026-10-11', course: { elevationGainFt: 1800, terrain: 'mountain' } },
    weeks: [],
  };
  const result = concurrentPlan.validateConcurrentPlan(fabricated, { target: fabTarget, profile: {} });
  assert.ok(result.errors.some((e) => /not supported by trusted structured data/i.test(e)), 'fabricated course facts rejected');
  console.log('plan distance-only + fabrication guard: OK');
}

function testUserScopedGpx() {
  const rows = [{ id: 'race-1', user_id: 'owner', course_profile_json: null }];
  function scopedGpxUpdate(id, userId, envelope) {
    const row = rows.find((r) => r.id === id && r.user_id === userId);
    if (!row) return { updated: 0 };
    row.course_profile_json = JSON.stringify(envelope);
    return { updated: 1 };
  }
  const env = raceCourse.buildUserGpxEnvelope({ elevationGainFt: 50, maxAltitudeFt: 60, terrain: 'road', samples: [] });
  assert.strictEqual(scopedGpxUpdate('race-1', 'attacker', env).updated, 0, 'other user cannot mutate GPX');
  assert.strictEqual(rows[0].course_profile_json, null, 'race unchanged after unauthorized attempt');
  assert.strictEqual(scopedGpxUpdate('race-1', 'owner', env).updated, 1, 'owner can mutate GPX');
  console.log('user-scoped GPX mutation: OK');
}

function testGoalTaxonomy() {
  const kinds = ['race', 'distance_pr', 'beginner_first_run', 'weight_loss', 'general_fitness', 'hybrid_performance', 'run_for_enjoyment'];
  for (const k of kinds) assert.strictEqual(raceCourse.validateGoalKind(k), true, `${k} is a valid goal kind`);
  assert.strictEqual(raceCourse.validateGoalKind('not_a_goal'), false, 'unknown goal kind rejected');
  assert.strictEqual(raceCourse.isRaceGoal('race'), true, 'race is a race goal');
  assert.strictEqual(raceCourse.isRaceGoal('weight_loss'), false, 'weight_loss is not a race goal');
  assert.strictEqual(raceCourse.normalizeGoalKind('bogus'), 'general_fitness', 'invalid goal kind normalizes to fallback');
  console.log('goal taxonomy validation: OK');
}

async function main() {
  testResolution();
  testTrustGating();
  await testGpx();
  testCorrectionHistory();
  testPlanIntegration();
  testUserScopedGpx();
  testGoalTaxonomy();
  console.log('race-course-smoke: ALL PASS');
}

main().catch((err) => {
  console.error('race-course-smoke FAILED:', err && err.message);
  process.exit(1);
});
