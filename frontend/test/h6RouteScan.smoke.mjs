// Forged Hybrid H6 — permanent simplification/migration route + surface scan.
// Run: node frontend/test/h6RouteScan.smoke.mjs
// Proves the H6 invariants hold so a future refactor can't silently regress them:
//  - More exposes no duplicate plan/PR destinations; Train owns the unified plan,
//    while Community owns PRs/badges and catalog/race routes stay reachable.
//  - Old direct routes still resolve (backward compatibility preserved).
//  - No user-data routes were removed.
//  - The shared AI-guidance note carries the exact required copy and appears on
//    every audited active AI-prose surface.
//  - Active-plan Train/Home prefer the canonical calendar execution (source=calendar).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { recommendationFromExecution, normalizeExecution } from '../src/lib/dailyExecutionCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '../..');
const srcDir = resolve(__dirname, '../src');
const read = (rel) => readFileSync(resolve(srcDir, rel), 'utf8');
const readRepo = (rel) => readFileSync(resolve(repoDir, rel), 'utf8');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${msg}`); }
}

const AI_GUIDANCE_TEXT = 'AI guidance — not medical advice.';

console.log('\n== shared AI-guidance note ==');
const note = read('components/AiGuidanceNote.jsx');
assert(note.includes(AI_GUIDANCE_TEXT), 'AiGuidanceNote carries the exact required copy');
assert(/export default function AiGuidanceNote/.test(note), 'AiGuidanceNote is the single shared component');

console.log('\n== AI-prose surfaces carry the note ==');
// Every active surface that renders AI-generated coaching / plan rationale /
// recommendation prose must import and render the ONE shared note.
const aiSurfaces = [
  'components/AICoachFeedbackCard.jsx',
  'components/InsightsSheet.jsx',
  'components/RunDetailModal.jsx',
  'components/StrengthWorkoutRecommendation.jsx',
  'components/WorkoutDetailModal.jsx',
  'components/calendar/ForgedDayView.jsx',
  'pages/LogRun.jsx',
  'pages/RunHub.jsx',
  'pages/WeeklyRecap.jsx',
  'pages/Plan.jsx',
];
for (const rel of aiSurfaces) {
  const src = read(rel);
  assert(/import AiGuidanceNote from '.*AiGuidanceNote'/.test(src), `${rel} imports the shared AiGuidanceNote`);
  assert(/<AiGuidanceNote\s*\/>/.test(src), `${rel} renders <AiGuidanceNote />`);
}
const insights = read('components/InsightsSheet.jsx');
assert(/\{\(recommendation\?\.reason \|\| coachWhy\) && <AiGuidanceNote \/>\}/.test(insights), 'Today detail note requires AI recommendation/coach prose');
assert(!/topFactors\.length[^\n]*AiGuidanceNote/.test(insights), 'deterministic health factors alone do not trigger the AI note');

console.log('\n== deterministic surfaces stay note-free ==');
// Readiness score + gear pick are rule-based/deterministic — the note must NOT be
// plastered onto them.
for (const rel of ['components/ReadinessCard.jsx', 'components/TodaysPickCard.jsx']) {
  const src = read(rel);
  assert(!/AiGuidanceNote/.test(src), `${rel} (deterministic) does not carry the AI note`);
}

console.log('\n== More stays free of duplicate plan and PR destinations ==');
const more = read('pages/More.jsx');
const planEntries = (more.match(/to:\s*'\/plan'/g) || []).length;
assert(planEntries === 0, 'More does not duplicate the unified plan owned by Train');
assert(!/to:\s*'\/plan-catalog'/.test(more), 'More no longer lists a competing Plan Catalog nav entry');
assert(!/to:\s*'\/races'/.test(more), 'More no longer lists a competing Races nav entry');
assert(!/to:\s*'\/prs'/.test(more), 'More does not duplicate PR Wall after it moved to Community');
const community = read('pages/Community.jsx');
const engagementCards = read('components/EngagementProgressCards.jsx');
assert(/<EngagementHighlights engagement=\{engagement\}/.test(community), 'Community renders the PR and badge highlights');
assert(/navigate\('\/prs'\)/.test(engagementCards), 'Community keeps PR Wall reachable from its progress card');

console.log('\n== catalog/races stay reachable from the Plan flow ==');
const plan = read('pages/Plan.jsx');
assert(/navigate\('\/plan-catalog'\)/.test(plan), 'Plan flow links to /plan-catalog (create/manage)');
assert(/navigate\('\/races'\)/.test(plan), 'Plan flow links to /races');
assert(!/api\.get\('\/plans'\)/.test(plan), 'Plan no longer duplicates the catalog listing');
assert(!/\/plans\/adaptive\/recommend/.test(plan), 'legacy Adaptive Plan recommendation panel is removed');
assert(!/plans\.map|Assign Plan/.test(plan), 'Plan no longer renders competing assignment cards');

console.log('\n== Plan Catalog reframed as Create / Manage Plan ==');
const catalog = read('pages/PlanCatalog.jsx');
assert(catalog.includes('Create / Manage Plan'), 'PlanCatalog eyebrow reframed to Create / Manage Plan');

console.log('\n== backward-compatible routes still defined ==');
const app = read('App.jsx');
for (const path of ['/plan', '/plan-catalog', '/races', '/prs', '/history', '/gear', '/hr-zones', '/injury', '/recap']) {
  assert(new RegExp(`path="${path}"`).test(app), `route ${path} still resolves (no route definition removed)`);
}

console.log('\n== active-plan Train prefers canonical calendar execution ==');
const hybridBody = {
  today: { day: 'Mon', date: '2026-07-13', type: 'run' },
  execution: {
    hasPlan: true, hasDay: true, isRest: false, mode: 'hybrid_maintain', week: 1,
    sessions: [
      { id: 'run-1', kind: 'run', workout_type: 'easy', distance_miles: 4, target_zone: 'Z2', completed: false },
      { id: 'lift-1', kind: 'lift', title: 'Lower', completed: false },
    ],
    run: { id: 'run-1', kind: 'run', target_zone: 'Z2', completed: false },
    lift: { id: 'lift-1', kind: 'lift', completed: false },
  },
};
const rec = recommendationFromExecution(normalizeExecution(hybridBody));
assert(rec && rec.source === 'calendar', 'active-plan recommendation is sourced from the calendar, not a disconnected suggestion');
assert(rec && rec.planSessionId === 'run-1', 'calendar recommendation carries the scheduled run session id');
assert(recommendationFromExecution(normalizeExecution({ today: null, execution: { hasPlan: false, hasDay: false } })) === null, 'no-plan yields null so callers fall back to manual recommendation');

console.log('\n== Run Hub uses the canonical calendar when a plan is active ==');
const runHub = read('pages/RunHub.jsx');
assert(/fetchDailyExecution/.test(runHub) && /recommendationFromExecution/.test(runHub), 'RunHub imports the canonical daily execution helpers');
assert(/dailyExecution\?\.hasPlan[\s\S]{0,120}recommendationFromExecution\(dailyExecution\)/.test(runHub), 'RunHub prefers the calendar recommendation for an active plan');
assert(/to="\/plan"/.test(runHub), 'RunHub plan CTA opens the unified calendar');
assert(!/to="\/plan-catalog"/.test(runHub), 'RunHub no longer bypasses the unified calendar');

console.log('\n== legacy owned plans remain visible without migration writes ==');
const plansRoute = readRepo('backend/src/routes/plans.js');
assert(/SELECT \* FROM training_plans WHERE user_id = \? ORDER BY created_at DESC LIMIT 1/.test(plansRoute), '/plans/my falls back to a user-scoped legacy plan');
assert(/source:\s*'legacy'/.test(plansRoute) && /user_plan:\s*null/.test(plansRoute), 'legacy fallback is explicitly read-only until normal progress migration');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H6 ROUTE SCAN OK');
