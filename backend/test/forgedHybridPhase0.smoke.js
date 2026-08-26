// Forged Hybrid Phase 0 post-run truth smoke.
// Run: node backend/test/forgedHybridPhase0.smoke.js

const fs = require('fs');
const path = require('path');
const {
  MAX_ROUTE_POINTS,
  classifyRouteIntegrity,
  normalizeDistanceEvidence,
  normalizePlannedSession,
  normalizePostRunCheckIn,
  normalizeRouteCoords,
} = require('../src/lib/runPostRun');
const { importKeysForItem, normalizeRow, resolveCanonicalDistanceSource } = require('../src/routes/import')._test;
const { buildAdaptationProposal, classifyCompletionOutcome } = require('../src/lib/adaptationEngine');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  }
}

console.log('\n== post-run input boundaries ==');
const route = normalizeRouteCoords([
  [38.91, -76.95, 25, 1784030400000, 4.5],
  { lat: 38.92, lng: -76.96, altitude: 26, timestamp: '2026-07-14T12:01:00Z', horizontal_accuracy: 8 },
  [200, -76.97, 27, 1784030520000],
]);
check(route.length === 2, 'invalid route points are discarded');
check(route[0].time === '2026-07-14T12:00:00.000Z', 'numeric GPS timestamps are normalized');
check(route[1].time === '2026-07-14T12:01:00.000Z', 'ISO GPS timestamps are preserved');
check(route[0].accuracy === 4.5 && route[1].accuracy === 8, 'bounded horizontal accuracy is retained from native and aliased route fields');

const longRouteInput = Array.from({ length: MAX_ROUTE_POINTS + 2 }, (_, index) => ({
  lat: 38.9 + index / 1_000_000,
  lon: -76.95,
  accuracy: index === 1 ? 20_000 : 5,
}));
const boundedRoute = normalizeRouteCoords(longRouteInput);
check(boundedRoute.length === MAX_ROUTE_POINTS, 'backend route normalization enforces the point limit');
check(boundedRoute[0].lat === longRouteInput[0].lat && boundedRoute.at(-1).lat === longRouteInput.at(-1).lat, 'backend route bounding preserves the recorded start and finish');
check(!Object.prototype.hasOwnProperty.call(boundedRoute[1], 'accuracy'), 'out-of-range horizontal accuracy is discarded at the backend boundary');

const missingRoute = classifyRouteIntegrity({ routeCoords: [] });
const insufficientRoute = classifyRouteIntegrity({ routeCoords: [{ lat: 38.9, lon: -76.95 }] });
const partialRoute = classifyRouteIntegrity({
  routeCoords: [{ lat: 38.9, lon: -76.95 }, { lat: 38.90001, lon: -76.95001 }],
  materialGap: true,
});
const completeShortRoute = classifyRouteIntegrity({
  routeCoords: [{ lat: 38.9, lon: -76.95 }, { lat: 38.90001, lon: -76.95001 }],
});
check(missingRoute.status === 'missing', 'zero valid route points are missing');
check(insufficientRoute.status === 'insufficient', 'one valid route point is insufficient');
check(partialRoute.status === 'partial', 'two or more valid route points with an explicit material gap are partial');
check(completeShortRoute.status === 'complete', 'a complete valid recording is complete even when its route is short');

console.log('\n== canonical distance evidence ==');
const equivalentDistance = normalizeDistanceEvidence([
  { value: 5, unit: 'kilometers', source: 'forged_phone' },
  { value: 5000, unit: 'meters', source: 'apple_health' },
  { value: 3.106855961, unit: 'miles', source: 'strava' },
]);
check(equivalentDistance.miles === 3.106856 && equivalentDistance.unit === 'miles', 'equivalent kilometer, meter, and mile evidence becomes one canonical mile value');
check(equivalentDistance.source === 'forged_phone', 'canonical distance retains the deterministic winning source');
check(Boolean(normalizeDistanceEvidence([
  { value: 5, unit: 'kilometers', source: 'forged_phone' },
  { value: 3.2, unit: 'miles', source: 'apple_health' },
]).error), 'non-equivalent distance evidence is rejected as conflicting');
check(Boolean(normalizeDistanceEvidence([{ value: 5, unit: 'furlongs', source: 'apple_health' }]).error), 'unknown distance units are rejected fail-closed');

const distanceFixture = {
  type: 'Running',
  startDate: '2026-07-14T12:00:00.000Z',
  durationSeconds: 1500,
  source: 'apple_health',
};
const fiveKilometers = normalizeRow({ ...distanceFixture, distance: 5, distanceUnit: 'km' });
const fiveThousandMeters = normalizeRow({ ...distanceFixture, distanceMeters: 5000 });
const equivalentMiles = normalizeRow({ ...distanceFixture, distanceMiles: 3.106855961 });
const nonEquivalentDistance = normalizeRow({ ...distanceFixture, distanceKilometers: 5.2 });
const allEquivalent = normalizeRow({
  ...distanceFixture,
  distanceKilometers: 5,
  distanceMeters: 5000,
  distanceMiles: 3.106855961,
});
const canonicalKeys = [fiveKilometers, fiveThousandMeters, equivalentMiles, allEquivalent]
  .map((item) => importKeysForItem(item)[0]);
check(new Set(canonicalKeys).size === 1, 'equivalent 5 km, 5000 m, and 3.106855... mi imports share one reconciliation identity');
check(importKeysForItem(nonEquivalentDistance)[0] !== canonicalKeys[0], 'non-equivalent normalized distance keeps a distinct reconciliation identity');
check(allEquivalent.distanceMiles === 3.107 && allEquivalent.workoutMetrics.distance_unit === 'miles' && allEquivalent.workoutMetrics.distance_source === 'apple_health', 'equivalent evidence is persisted once with canonical unit and explicit source');
check(resolveCanonicalDistanceSource(
  { distance_source: 'forged_phone' },
  { health_source: 'forged_hybrid', watch_mode: null },
  { source: 'apple_health' }
) === 'forged_phone', 'provider enrichment preserves the canonical phone distance source');
let conflictingImportRejected = false;
try {
  normalizeRow({ ...distanceFixture, distanceKilometers: 5, distanceMiles: 3.2 });
} catch (error) {
  conflictingImportRejected = error.code === 'IMPORT_ROW_INVALID';
}
check(conflictingImportRejected, 'non-equivalent import candidates fail closed before reconciliation');

const planned = normalizePlannedSession({
  sessionId: 'session-1',
  date: '2026-07-14',
  type: 'recovery',
  distanceMiles: 3,
  paceTarget: 'Conversational',
  targetZone: 'Zone 1-2',
  steps: ['20 min easy', '5 min walk'],
  untrustedExtra: 'not persisted',
});
check(planned.sessionId === 'session-1' && planned.distanceMiles === 3, 'planned prescription is normalized');
check(!Object.prototype.hasOwnProperty.call(planned, 'untrustedExtra'), 'unknown planned-session fields are dropped');
check(Boolean(normalizePostRunCheckIn({ perceived_effort: 7, pain_level: 'moderate', post_energy: 'low' }).value), 'complete check-in is accepted');
check(normalizePostRunCheckIn({ perceived_effort: 7, pain_level: 'moderate', post_energy: null }).value?.post_energy === null, 'post-run energy is optional');
check(Boolean(normalizePostRunCheckIn({ perceived_effort: 11, pain_level: 'none', post_energy: 'high' }).error), 'invalid effort is rejected');

console.log('\n== passive-only adaptation authority ==');
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => ({
  date: `2026-07-${String(13 + index).padStart(2, '0')}`,
  day,
  status: 'planned',
  sessions: index >= 1 && index <= 3 ? [{
    id: `run-${index}`,
    kind: 'run',
    type: index === 3 ? 'tempo' : 'easy',
    workout_type: 'run',
    title: index === 3 ? 'Tempo run' : 'Easy run',
    distance_miles: 3,
    duration_min: 30,
    target_zone: index === 3 ? 'Zone 3-4' : 'Zone 2',
    intensity: index === 3 ? 'Hard' : 'Easy',
    steps: ['Run'],
  }] : [],
}));
const plan = {
  schemaVersion: 2,
  planMode: 'run_only',
  goal: { type: 'race', date: '2026-10-11', distanceMiles: 10 },
  strengthPolicy: { minimumSessionsPerWeek: 0 },
  weeks: [{ week: 1, phase: 'base', startDate: '2026-07-13', days }],
};
const baselineProposal = buildAdaptationProposal({
  plan,
  planningDateISO: '2026-07-14',
});
const subjectiveProposal = buildAdaptationProposal({
  plan,
  planningDateISO: '2026-07-14',
  checkin: {
    perceived_effort: 10,
    pain_level: 'severe',
    post_energy: 'low',
  },
  recentRunLoad: {
    latestRun: {
      evidence_id: 'legacy-subjective-run',
      linked_session_id: 'run-1',
      perceivedEffort: 10,
      postRunPain: 'severe',
      postRunEnergy: 'low',
    },
    protection: { active: false },
  },
});
check(JSON.stringify(subjectiveProposal) === JSON.stringify(baselineProposal), 'subjective effort, pain, and energy cannot change the accepted calendar');
check(subjectiveProposal.evidence.length === 0, 'subjective effort, pain, and energy are absent from adaptation evidence');
const subjectiveCompletion = classifyCompletionOutcome({
  observation: {
    target_met: true,
    perceived_effort: 10,
    pain_level: 'severe',
    post_energy: 'low',
  },
  prescribedSession: { session_id: 'run-1' },
});
check(subjectiveCompletion.outcome === 'ON_TARGET', 'subjective effort, pain, and energy cannot classify objective completion');

console.log('\n== explicit injury safety coverage ==');
const injuryProposal = buildAdaptationProposal({
  plan,
  planningDateISO: '2026-07-14',
  injuryState: {
    openInjuries: [{
      id: 'explicit-knee-injury',
      body_part: 'knee',
      severity: 'severe',
      date: '2026-07-14',
      active: true,
    }],
  },
});
check(injuryProposal.status === 'proposal' && injuryProposal.safetyException, 'a structured explicit severe injury record creates a transparent safety proposal');
check(injuryProposal.evidence.some((item) => item.source === 'injury' && item.signal === 'severe injury'), 'the safety proposal cites the explicit injury record instead of a post-run questionnaire');
check(!injuryProposal.evidence.some((item) => item.source === 'post_run_checkin'), 'subjective post-run check-ins remain absent from safety evidence');
check(injuryProposal.changes.length === 3 && injuryProposal.changes.every((change) => change.after.kind === 'rest'), 'all non-race runs in the injury safety window become holds');

console.log('\n== source wiring ==');
const root = path.resolve(__dirname, '..', '..');
const runsRoute = fs.readFileSync(path.join(root, 'backend/src/routes/runs.js'), 'utf8');
const aiService = fs.readFileSync(path.join(root, 'backend/src/services/ai.js'), 'utf8');
const activeRun = fs.readFileSync(path.join(root, 'frontend/src/pages/ActiveRun.jsx'), 'utf8');
check(
  /const RUN_FEEDBACK_CLAIM_STALE_MS = 10 \* 60 \* 1000;/.test(runsRoute)
    && /WHERE id=\? AND user_id=\? AND ai_feedback IS NULL[\s\S]*ai_feedback_requested_at IS NULL[\s\S]*OR ai_feedback_requested_at < \?/.test(runsRoute)
    && /\[claimAt, run\.id, userId, staleBefore\]/.test(runsRoute),
  'feedback generation atomically reclaims only owner-scoped stale claims after the parameterized ten-minute cutoff',
);
check(/UPDATE runs SET ai_feedback=\?[\s\S]*AND ai_feedback_requested_at=\?/.test(runsRoute), 'an older feedback worker cannot overwrite a newer claim result');
check(/router\.patch\('\/:id\/check-in'/.test(runsRoute), 'post-run check-in has a dedicated endpoint');
check(/router\.post\('\/', auth/.test(runsRoute), 'run creation remains authenticated');
check(/ON CONFLICT \(id\) DO NOTHING/.test(runsRoute) && /SELECT \* FROM runs WHERE id=\? AND user_id=\?/.test(runsRoute), 'replayed client capture ids resolve to one user-scoped canonical run');
check(/JSON\.stringify\(normalizedRouteCoords\)/.test(runsRoute), 'only backend-normalized route points are persisted');
check(/route_status: routeIntegrity\.status/.test(runsRoute) && /workout_metrics_json/.test(runsRoute), 'run creation persists executable route-integrity status with the canonical run');
check(/\^\\\[gps_gap_notice:/.test(runsRoute), 'the existing ActiveRun material-gap evidence drives server route classification');
check(/sanitizeObj\(sessionData \|\| \{\}\)/.test(aiService), 'structured AI session data is sanitized before prompting');
check(!activeRun.includes('/ai/session-feedback'), 'ActiveRun no longer requests analysis before the check-in');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('PHASE 0 SMOKE OK');
