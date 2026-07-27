import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import {
  resolveRunCompletion,
  runCompletionPolicy,
  runProvenanceFromRecord,
  RUN_PROVENANCE,
} from '../src/lib/runCompletionPolicy.js'

const require = createRequire(import.meta.url)
const { summarizeRecentRunLoad } = require('../../backend/src/lib/recentRunLoad')
const {
  explicitNoPlanMatchSnapshot,
  findPlanSessionRunEvidence,
} = require('../../backend/src/lib/plannedRunMatch')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

console.log('\n== provenance-aware completion ==')
const manual = resolveRunCompletion({
  provenance: RUN_PROVENANCE.MANUAL,
  runId: 'manual-run-1',
})
check(!manual.requiresImmediateCheckIn, 'manual save does not require immediate post-run check-in')
check(manual.destination === '/run/recap/manual-run-1', 'manual save routes to the exact run recap')
check(manual.offersRetrospectiveCheckIn, 'manual recap keeps retrospective check-in available')

const live = resolveRunCompletion({
  provenance: RUN_PROVENANCE.LIVE_TRACKED,
  runId: 'live-run-1',
})
check(live.requiresImmediateCheckIn && live.destination === null, 'live tracked completion remains blocked on immediate check-in')

const imported = runCompletionPolicy(RUN_PROVENANCE.IMPORTED)
check(!imported.requiresImmediateCheckIn, 'provider imports are never interrupted by a mandatory check-in')
check(imported.offersRetrospectiveCheckIn, 'provider imports retain retrospective check-in')

const queuedManual = resolveRunCompletion({
  provenance: RUN_PROVENANCE.MANUAL,
  runId: 'queued-manual',
  queued: true,
})
check(!queuedManual.requiresImmediateCheckIn && queuedManual.destination === null, 'offline manual save stays queued without opening an unavailable recap or check-in')

console.log('\n== explicit provenance only ==')
check(runProvenanceFromRecord({ watch_mode: 'manual' }) === RUN_PROVENANCE.MANUAL, 'manual watch mode is explicit provenance')
check(runProvenanceFromRecord({ health_source: 'forged_hybrid' }) === RUN_PROVENANCE.LIVE_TRACKED, 'Forge recording source is explicit live provenance')
check(runProvenanceFromRecord({ watch_mode: 'import', health_source: 'apple_health' }) === RUN_PROVENANCE.IMPORTED, 'provider watch mode is explicit imported provenance')
check(runProvenanceFromRecord({ perceived_effort: null, pain_level: null }) === RUN_PROVENANCE.UNKNOWN, 'missing subjective metrics never imply manual provenance')

console.log('\n== objective adaptation without invented subjectives ==')
const manualLoad = summarizeRecentRunLoad([{
  id: 'manual-run-1',
  date: '2026-07-27',
  type: 'easy',
  distance_miles: 6,
  duration_seconds: 3600,
  perceived_effort: null,
  pain_level: null,
  post_energy: null,
  watch_mode: 'manual',
}], {
  todayISO: '2026-07-27',
  weeklyBaseline: 15,
  recoveryState: 'normal',
})
check(manualLoad.latestRun.distanceMiles === 6 && manualLoad.sevenDayMiles === 6, 'manual factual distance contributes to deterministic workload')
check(manualLoad.latestRun.perceivedEffort === null && manualLoad.latestRun.postRunPain === null && manualLoad.latestRun.postRunEnergy === null, 'missing RPE, pain, and energy remain unknown')
check(manualLoad.protection.active, 'manual duration and distance still protect near-term training load')

const externalRun = {
  id: 'manual-external',
  date: '2026-07-27',
  plan_session_id: null,
  planned_session_json: JSON.stringify(explicitNoPlanMatchSnapshot()),
}
check(findPlanSessionRunEvidence([externalRun], {
  sessionId: 'unrelated-forge-session',
  date: '2026-07-27',
}) === null, 'explicitly external manual run cannot complete an unrelated Forge session')

console.log('\n== executable wiring ==')
const logRunSource = fs.readFileSync(new URL('../src/pages/LogRun.jsx', import.meta.url), 'utf8')
const activeRunSource = fs.readFileSync(new URL('../src/pages/ActiveRun.jsx', import.meta.url), 'utf8')
const recapSource = fs.readFileSync(new URL('../src/pages/RunRecap.jsx', import.meta.url), 'utf8')
const detailSource = fs.readFileSync(new URL('../src/components/RunDetailModal.jsx', import.meta.url), 'utf8')
const manualSubmit = logRunSource.slice(logRunSource.indexOf('const onSubmit = async'), logRunSource.indexOf('const selectedSplits = useMemo'))

check(manualSubmit.includes('RUN_PROVENANCE.MANUAL') && manualSubmit.includes('navigate(completion.destination'), 'manual save uses provenance policy and direct recap navigation')
check(!manualSubmit.includes('savePostRunCheckInDraft') && !manualSubmit.includes('setShowPostCheckIn(true)'), 'manual completion does not create or open a mandatory check-in')
check(manualSubmit.includes('plan_session_id: submittedPlanSessionId') && logRunSource.includes("const submittedPlanSessionId = activeTab === 'log' ? null : planSessionId"), 'manual payload explicitly opts out of inherited session completion')
check(manualSubmit.includes('perceived_effort: effort') && logRunSource.includes('useState(null)'), 'untouched manual effort is saved as null instead of a default RPE')
check(activeRunSource.includes('RUN_PROVENANCE.LIVE_TRACKED') && activeRunSource.includes('setShowPostCheckIn(completion.requiresImmediateCheckIn)'), 'ActiveRun retains provenance-gated immediate check-in')
check(activeRunSource.includes('savePostRunCheckInDraft') && activeRunSource.includes('PostRunCheckIn'), 'live check-in answers retain durable recovery')
check(recapSource.includes('PostRunCheckIn') && detailSource.includes('Add how you felt'), 'manual and imported details retain the optional retrospective action')

console.log(`\nPASSED: ${passed}  FAILED: 0`)
console.log('ADAPTIVE MANUAL RUN COMPLETION SMOKE OK')
