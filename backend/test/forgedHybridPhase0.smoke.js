// Forged Hybrid Phase 0 post-run truth smoke.
// Run: node backend/test/forgedHybridPhase0.smoke.js

const fs = require('fs');
const path = require('path');
const {
  MAX_ROUTE_POINTS,
  normalizePlannedSession,
  normalizePostRunCheckIn,
  normalizeRouteCoords,
  shouldInvalidateRunFeedback,
} = require('../src/lib/runPostRun');
const { summarizeRecentRunLoad } = require('../src/lib/recentRunLoad');
const { buildAdaptationProposal } = require('../src/lib/adaptationEngine');

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
check(shouldInvalidateRunFeedback({ pain_level: 'moderate' }), 'pain edits invalidate stored run feedback');
check(shouldInvalidateRunFeedback({ notes: 'Felt smooth' }), 'note edits invalidate stored run feedback');
check(!shouldInvalidateRunFeedback({ run_surface: 'trail' }), 'non-coaching metadata edits retain stored run feedback');
check(!shouldInvalidateRunFeedback({ date: '2026-07-14' }), 'date-only edits retain stored run feedback');

console.log('\n== pain and energy protection ==');
const severeLoad = summarizeRecentRunLoad([{
  date: '2026-07-14',
  type: 'run',
  distance_miles: 0.2,
  duration_seconds: 300,
  perceived_effort: 3,
  pain_level: 'severe',
  post_energy: 'medium',
}], { todayISO: '2026-07-14', weeklyBaseline: 12, recoveryState: 'normal' });
check(severeLoad.available && severeLoad.protection.postRunSevere, 'severe pain makes even a short run meaningful');
check(severeLoad.protection.hardRunsThrough === '2026-07-17', 'severe pain protects running for 72 hours');
check(severeLoad.protection.lowerBodyThrough === '2026-07-17', 'severe pain protects lower-body work for 72 hours');

const lowEnergyLoad = summarizeRecentRunLoad([{
  date: '2026-07-14',
  type: 'run',
  distance_miles: 0.2,
  duration_seconds: 300,
  perceived_effort: 3,
  pain_level: 'none',
  post_energy: 'low',
}], { todayISO: '2026-07-14', weeklyBaseline: 12, recoveryState: 'normal' });
check(lowEnergyLoad.protection.postRunCaution && !lowEnergyLoad.protection.postRunSevere, 'low energy creates a caution without inventing severe pain');
check(lowEnergyLoad.protection.hardRunsThrough === '2026-07-16', 'low energy protects hard running for 48 hours');

const cleanFragment = summarizeRecentRunLoad([{
  date: '2026-07-14',
  type: 'run',
  distance_miles: 0.2,
  duration_seconds: 300,
  perceived_effort: 3,
  pain_level: 'none',
  post_energy: 'high',
}], { todayISO: '2026-07-14', weeklyBaseline: 12, recoveryState: 'normal' });
check(!cleanFragment.available, 'an easy short fragment without warning signals does not drive adaptation');

console.log('\n== severe-pain calendar adaptation ==');
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
const proposal = buildAdaptationProposal({
  plan,
  planningDateISO: '2026-07-14',
  recentRunLoad: severeLoad,
});
check(proposal.status === 'proposal', 'severe post-run pain creates a transparent proposal');
check(proposal.evidence.some((item) => item.source === 'post_run_checkin' && item.objective === false), 'subjective check-in evidence is labeled truthfully');
check(proposal.changes.length === 3 && proposal.changes.every((change) => change.after.kind === 'rest'), 'all non-race runs in the protection window become safety holds');

console.log('\n== source wiring ==');
const root = path.resolve(__dirname, '..', '..');
const runsRoute = fs.readFileSync(path.join(root, 'backend/src/routes/runs.js'), 'utf8');
const aiService = fs.readFileSync(path.join(root, 'backend/src/services/ai.js'), 'utf8');
const activeRun = fs.readFileSync(path.join(root, 'frontend/src/pages/ActiveRun.jsx'), 'utf8');
check(/ai_feedback_requested_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'/.test(runsRoute), 'feedback generation has a stale-claim retry guard');
check(/router\.patch\('\/:id\/check-in'/.test(runsRoute), 'post-run check-in has a dedicated endpoint');
check(/router\.post\('\/', auth/.test(runsRoute), 'run creation remains authenticated');
check(/ON CONFLICT \(id\) DO NOTHING/.test(runsRoute) && /SELECT \* FROM runs WHERE id=\? AND user_id=\?/.test(runsRoute), 'replayed client capture ids resolve to one user-scoped canonical run');
check(/JSON\.stringify\(normalizedRouteCoords\)/.test(runsRoute), 'only backend-normalized route points are persisted');
check(/sanitizeObj\(sessionData \|\| \{\}\)/.test(aiService), 'structured AI session data is sanitized before prompting');
check(!activeRun.includes('/ai/session-feedback'), 'ActiveRun no longer requests analysis before the check-in');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('PHASE 0 SMOKE OK');
