import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const modal = read('frontend/src/components/RunDetailModal.jsx')
const impact = read('frontend/src/components/RunPlanImpact.jsx')
const plans = read('backend/src/routes/plans.js')
const migration = read('backend/src/db/migrate.js')
const recentRunLoad = read('backend/src/lib/recentRunLoad.js')
const { summarizeRecentRunLoad } = require(path.join(repoRoot, 'backend/src/lib/recentRunLoad.js'))

assert.match(modal, /isRun && <RunPlanImpact run=\{run\} \/>/, 'every running-activity detail mounts plan-impact analysis')
assert.match(impact, /adaptation\/run\/\$\{encodeURIComponent\(run\.id\)\}/, 'the viewed run id is sent to the deterministic impact endpoint')
assert.match(impact, /api\.post\(`\/plans\/adaptation\/\$\{proposalId\}\/\$\{nextDecision\}`\)/, 'plan decisions are bound to the captured proposal id')
assert.match(impact, /requestTokenRef\.current !== requestToken/, 'late analysis and decision responses are ignored')
assert.match(impact, /proposalIdRef\.current !== proposalId/, 'a response cannot mutate a replacement proposal')
assert.ok(impact.includes("'Apply adjustment'"), 'the user can apply a proposed adjustment')
assert.ok(impact.includes("'Keep plan'"), 'the user can keep the original plan')
assert.match(plans, /router\.get\('\/adaptation\/run\/:runId', auth/, 'the run-impact endpoint requires authentication')
assert.match(plans, /WHERE id=\? AND user_id=\? AND \$\{runActivitySql\(\)\}/, 'the analyzed run is selected by id and owner')
assert.match(plans, /WHERE user_id=\? AND trigger_run_id=\?/, 'run impact lookup is owner and run scoped')
assert.match(plans, /existing\.status === 'accepted' \|\| existing\.status === 'kept'/, 'completed run-plan decisions remain immutable')
assert.match(plans, /WHERE id=\? AND user_id=\? AND trigger_run_id=\? AND status IN \('pending','reviewed'\)/, 'undecided impact is refreshed from the current owner-scoped run record')
assert.match(plans, /source: 'run',[\s\S]*runId: run\.id/, 'stored evidence names the exact viewed run')
assert.match(plans, /ownedRun = await tx\.get\(`SELECT id FROM runs WHERE id=\? AND user_id=\?/, 'accept and keep re-check trigger-run ownership')
assert.match(plans, /trigger_run_id IS NULL/, 'daily adaptation queries exclude run-triggered reviews')
assert.match(migration, /idx_plan_adjustment_proposals_run[\s\S]*user_id, trigger_run_id/, 'one durable impact record is indexed per user-owned run')
assert.match(recentRunLoad, /focusRunId[\s\S]*run\.id === focusRunId/, 'load analysis focuses the selected run instead of another same-day run')
const focused = summarizeRecentRunLoad([
  { id: 'longer-run', date: '2026-07-22', type: 'run', distance_miles: 8, duration_seconds: 4200 },
  { id: 'viewed-run', date: '2026-07-22', type: 'run', distance_miles: 2, duration_seconds: 1200 },
], { todayISO: '2026-07-22', weeklyBaseline: 12, focusRunId: 'viewed-run' })
assert.equal(focused.latestRun?.id, 'viewed-run', 'same-day analysis remains tied to the viewed run')
const insignificant = summarizeRecentRunLoad([
  { id: 'hard-run', date: '2026-07-22', type: 'run', distance_miles: 8, duration_seconds: 4200 },
  { id: 'viewed-warmup', date: '2026-07-22', type: 'run', distance_miles: 0.2, duration_seconds: 120 },
], { todayISO: '2026-07-22', weeklyBaseline: 12, focusRunId: 'viewed-warmup' })
assert.equal(insignificant.available, false, 'an insignificant viewed run cannot inherit another run\'s plan impact')
assert.doesNotMatch(impact, /ai\/|openai|anthropic/i, 'run-plan impact does not add an LLM path')

console.log('RUN PLAN IMPACT SMOKE OK (19)')
