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
import { validatePostRunCheckInAnswers } from '../src/lib/postRunCheckIn.js'

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

const staleStorage = new MemoryStorage()
saveRunCompletionHandoff({ runId: 'stale-run', snapshot: { id: 'stale-run' } }, owner, staleStorage, 1)
check(!clearRunCompletionHandoff('stale-run', null, staleStorage), 'a missing caller identity cannot clear a stale handoff')
check(staleStorage.getItem(RUN_COMPLETION_HANDOFF_KEY) !== null, 'missing caller identity leaves the stale handoff untouched')
check(!clearRunCompletionHandoff('   ', owner, staleStorage), 'an invalid supplied run identity cannot become an unscoped clear')
check(staleStorage.getItem(RUN_COMPLETION_HANDOFF_KEY) !== null, 'invalid supplied run identity leaves the stale handoff untouched')
check(!clearRunCompletionHandoff('stale-run', 'another-owner', staleStorage), 'another owner cannot clear a stale handoff')
check(staleStorage.getItem(RUN_COMPLETION_HANDOFF_KEY) !== null, 'owner mismatch leaves the stale handoff untouched')
check(!clearRunCompletionHandoff('another-run', owner, staleStorage), 'a different run cannot clear a stale handoff')
check(staleStorage.getItem(RUN_COMPLETION_HANDOFF_KEY) !== null, 'run mismatch leaves the stale handoff untouched')
check(clearRunCompletionHandoff('stale-run', owner, staleStorage), 'the owning run can clear a handoff after restore expiry')
check(staleStorage.getItem(RUN_COMPLETION_HANDOFF_KEY) === null, 'stale handoff cleanup removes persisted state')

const malformedStorage = new MemoryStorage()
malformedStorage.setItem(RUN_COMPLETION_HANDOFF_KEY, '{bad json')
check(!clearRunCompletionHandoff('malformed-run', owner, malformedStorage), 'malformed handoff cleanup fails visibly')
check(malformedStorage.getItem(RUN_COMPLETION_HANDOFF_KEY) === null, 'malformed handoff state is removed after the logged failure')

const malformedIdentityStorage = new MemoryStorage()
malformedIdentityStorage.setItem(RUN_COMPLETION_HANDOFF_KEY, JSON.stringify({ ownerUserId: owner }))
check(!clearRunCompletionHandoff('malformed-run', owner, malformedIdentityStorage), 'stored handoff without a run identity is rejected')
check(malformedIdentityStorage.getItem(RUN_COMPLETION_HANDOFF_KEY) === null, 'stored malformed identity is removed after the logged failure')

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

console.log('\n== single-screen check-in validation ==')
const unansweredCheckIn = validatePostRunCheckInAnswers({ effort: null, pain: null, energy: null })
check(!unansweredCheckIn.valid && Boolean(unansweredCheckIn.errors.effort) && Boolean(unansweredCheckIn.errors.pain), 'effort and pain are both required')
check(unansweredCheckIn.firstInvalid === 'effort', 'effort is the first invalid section when both required answers are missing')
const missingPain = validatePostRunCheckInAnswers({ effort: 7, pain: null, energy: null })
check(!missingPain.valid && missingPain.firstInvalid === 'pain' && !missingPain.errors.effort, 'validation advances focus to pain after effort is answered')
const optionalEnergy = validatePostRunCheckInAnswers({ effort: 7, pain: 'none', energy: null })
check(optionalEnergy.valid && Object.keys(optionalEnergy.errors).length === 0, 'energy remains optional')

console.log('\n== semantic source gates ==')
const activeRun = read('src/pages/ActiveRun.jsx')
const recap = read('src/pages/RunRecap.jsx')
const detail = read('src/components/RunDetailModal.jsx')
const checkIn = read('src/components/PostRunCheckIn.jsx')
const pageStart = checkIn.indexOf('if (isPage)')
const sheetStart = checkIn.indexOf('className="sheet-backdrop"', pageStart)
const pagePresentation = checkIn.slice(pageStart, sheetStart)
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
check(recap.includes('data-testid="post-run-checkin-viewport"'), 'immediate post-run questions own a separate full-screen viewport')
check(recap.includes('presentation="page"'), 'recap renders immediate post-run questions as page content rather than a map overlay')
check(checkIn.includes("presentation = 'sheet'") && checkIn.includes("presentation === 'page'"), 'check-in keeps retrospective sheets and supports the dedicated completion page')
check(checkIn.includes("maxHeight: 'calc(100dvh") && checkIn.includes("overflowY: 'auto'"), 'check-in remains internally scrollable inside mobile safe areas')
check(pageStart >= 0 && sheetStart > pageStart, 'page and retrospective sheet presentations have separate render branches')
const effortAt = pagePresentation.indexOf('data-testid="post-run-checkin-page-effort"')
const painAt = pagePresentation.indexOf('data-testid="post-run-checkin-page-pain"')
const energyAt = pagePresentation.indexOf('data-testid="post-run-checkin-page-energy"')
const saveAt = pagePresentation.indexOf('data-testid="post-run-checkin-page-submit"')
check(effortAt >= 0 && painAt > effortAt && energyAt > painAt && saveAt > energyAt, 'page renders effort, pain, energy, and one save action together in form order')
check((pagePresentation.match(/type="submit"/g) || []).length === 1 && pagePresentation.includes('Save check-in and view recap'), 'page exposes one primary submit action')
check(!pagePresentation.includes('STEPS.map') && !pagePresentation.includes('requestStepChange') && !pagePresentation.includes('Confirm your check-in'), 'page omits numbered step navigation, review flow, and downstream-reset controls')
const validateAt = checkIn.indexOf('validatePostRunCheckInAnswers({ effort, pain })')
const submitAt = checkIn.indexOf('void submit()', validateAt)
check(validateAt >= 0 && submitAt > validateAt, 'page validates required answers before invoking shared submission')
check(pagePresentation.includes('role="radiogroup"') && pagePresentation.includes('aria-checked=') && pagePresentation.includes('<fieldset'), 'page answer groups expose accessible selection semantics')
check(checkIn.includes('invalidSection.focus') && checkIn.includes('invalidSection.scrollIntoView'), 'invalid page submission focuses and scrolls to the first required section')

console.log(`\nRUN COMPLETION PHASE A SMOKE OK (${passed})`)
