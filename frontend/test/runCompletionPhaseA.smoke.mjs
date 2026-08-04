import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildRunCompletionSnapshot,
  clearRunCompletionHandoff,
  discardRunCompletionHandoff,
  loadRunCompletionHandoff,
  runCompletionNavigation,
  RUN_COMPLETION_HANDOFF_KEY,
  RUN_COMPLETION_PHASE,
  RUN_RECAP_TABS,
  saveRunCompletionHandoff,
  updateRunCompletionHandoff,
} from '../src/lib/runCompletionHandoff.js'
import { resolveRunCompletion, RUN_PROVENANCE } from '../src/lib/runCompletionPolicy.js'

class MemoryStorage {
  constructor() { this.values = new Map() }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

const storage = new MemoryStorage()
const owner = 'phase-a-owner'
const now = Date.parse('2026-08-04T15:00:00Z')
const route = Array.from({ length: 1_000 }, (_, index) => ({
  lat: 38.9 + index / 100_000,
  lon: -76.95,
  time: now + index,
}))

console.log('\n== deterministic completion transitions ==')
const saved = saveRunCompletionHandoff({
  runId: 'saved-run',
  queued: false,
  checkInPending: true,
  provenance: 'live_tracked',
  snapshot: { id: 'saved-run', distance_miles: 5, duration_seconds: 3000, route_coords: route, private_extra: 'drop me' },
}, owner, storage, now)
check(saved.phase === RUN_COMPLETION_PHASE.CHECKIN_PENDING, 'save success enters check-in pending')
check(saved.snapshot.distance_miles === 5 && saved.snapshot.private_extra === undefined, 'fallback snapshot keeps allowlisted facts only')
check(saved.snapshot.route_coords.length === 800, 'fallback route is deterministically bounded')
check(saved.snapshot.route_coords[0].lat === route[0].lat && saved.snapshot.route_coords.at(-1).lat === route.at(-1).lat, 'bounded route preserves start and finish')
check(runCompletionNavigation(saved)?.destination === '/run/recap/saved-run', 'save success targets the exact recap')
check(runCompletionNavigation(saved)?.options?.replace === true, 'completion navigation replaces Active Run history')
check(loadRunCompletionHandoff('saved-run', owner, storage, now + 1000)?.phase === RUN_COMPLETION_PHASE.CHECKIN_PENDING, 'reload resumes the pending handoff')

const afterPlanFailure = updateRunCompletionHandoff('saved-run', owner, {
  planProgressNotice: 'Run saved. Open Plan to mark this session complete.',
}, storage, now + 2000)
check(afterPlanFailure?.snapshot.distance_miles === 5, 'plan failure cannot roll back the saved run snapshot')
check(afterPlanFailure?.planProgressNotice.includes('Run saved'), 'plan failure is retained as a non-blocking notice')
check(clearRunCompletionHandoff('saved-run', owner, storage), 'check-in cancel/complete can terminate the handoff')
check(storage.getItem(RUN_COMPLETION_HANDOFF_KEY) === null, 'terminal completion clears persisted handoff state')

const queued = saveRunCompletionHandoff({
  runId: 'queued/run',
  queued: true,
  checkInPending: true,
  snapshot: { id: 'queued/run', distance_miles: 2.5, duration_seconds: 1500 },
}, owner, storage, now + 3000)
check(queued.phase === RUN_COMPLETION_PHASE.QUEUED, 'offline save enters queued state')
check(runCompletionNavigation(queued)?.destination === '/run/recap/queued%2Frun', 'queued offline completion still owns a recap route')
check(loadRunCompletionHandoff('missing-row', owner, storage, now + 4000) === null, 'a handoff never attaches to a different server row')
check(loadRunCompletionHandoff('queued/run', 'another-owner', storage, now + 4000) === null, 'owner mismatch fails closed')

saveRunCompletionHandoff({ runId: 'logout-run', snapshot: { id: 'logout-run' } }, owner, storage, now + 5000)
check(discardRunCompletionHandoff(storage), 'logout can discard private completion data without an owner lookup')
check(storage.getItem(RUN_COMPLETION_HANDOFF_KEY) === null, 'logout removes the private fallback snapshot')

const livePolicy = resolveRunCompletion({ provenance: RUN_PROVENANCE.LIVE_TRACKED, runId: 'live-run' })
check(livePolicy.requiresImmediateCheckIn && livePolicy.destination === '/run/recap/live-run', 'live check-in is owned by the dedicated recap route')
const queuedPolicy = resolveRunCompletion({ provenance: RUN_PROVENANCE.LIVE_TRACKED, runId: 'queued-live', queued: true })
check(queuedPolicy.destination === '/run/recap/queued-live', 'queued policy never resets to Active Run')

console.log('\n== semantic source gates ==')
const activeRun = read('src/pages/ActiveRun.jsx')
const recap = read('src/pages/RunRecap.jsx')
const detail = read('src/components/RunDetailModal.jsx')
const checkIn = read('src/components/PostRunCheckIn.jsx')
check(!activeRun.includes('<PostRunCheckIn') && !activeRun.includes('<WorkoutCard'), 'ActiveRun renders neither check-in nor saved workout after completion')
const persistAt = activeRun.indexOf('saveRunCompletionHandoff({')
check(persistAt >= 0 && activeRun.indexOf('clearActiveRunSession()', persistAt) > persistAt, 'handoff persists before active-session clearing')
check(activeRun.indexOf('exitActiveRun(completionNavigation.destination', persistAt) > activeRun.indexOf('clearActiveRunSession()', persistAt), 'replace navigation follows durable handoff and active-session clearing')
check(activeRun.indexOf('const savePromise = saveRun()') < activeRun.indexOf('await clearActiveWatch()', activeRun.indexOf('const savePromise = saveRun()')), 'run save starts before watcher cleanup')
check(/awaitingManualDistance[\s\S]*onClick=\{saveRun\}/.test(activeRun), 'manual-distance and normal completion share saveRun')
check(recap.includes('handoff?.snapshot || null') && recap.includes('Showing the recap saved on this device'), 'missing server row or fetch failure retains factual fallback')
check(recap.includes("navigate(destination, { replace: true })"), 'History, recovery, Done, and Back leave recap with replacement navigation')
check(RUN_RECAP_TABS.length === 7 && new Set(RUN_RECAP_TABS.map((tab) => tab.key)).size === 7, 'all seven recap panels have stable unique keys')
for (const tab of RUN_RECAP_TABS) {
  check(recap.includes(`run-recap-tab-\${tab.key}`) || recap.includes('RUN_RECAP_TABS.map'), `${tab.label} is rendered through the semantic tab model`)
  check(detail.includes(`panelIs('${tab.key}')`) || tab.key === 'media', `${tab.label} activates panel-specific detail content`)
}
check(recap.includes('role="tablist"') && recap.includes('role="tabpanel"') && recap.includes('aria-selected={selected}'), 'recap tabs expose semantic selection state')
check(recap.includes("event.key === 'ArrowRight'") && recap.includes("event.key === 'ArrowLeft'"), 'recap tabs support keyboard navigation')
check(detail.includes('No heart-rate value is estimated') && detail.includes('Splits unavailable'), 'unavailable metrics are explicit and never fabricated')
check(detail.includes('Elevation loss') && detail.includes('VO₂ max') && detail.includes('Recovery time'), 'available route and workout facts have dedicated recap output')
check(recap.includes("style={{ background: 'var(--bg-base)'") && recap.includes('data-testid="run-recap-viewport"'), 'recap owns an opaque full viewport')
check(checkIn.includes("maxHeight: 'calc(100dvh") && checkIn.includes("overflowY: 'auto'"), 'check-in remains internally scrollable inside mobile safe areas')

console.log(`\nRUN COMPLETION PHASE A SMOKE OK (${passed})`)
