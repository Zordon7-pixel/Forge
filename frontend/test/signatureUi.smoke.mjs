import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeExecution, recommendationFromExecution } from '../src/lib/dailyExecutionCore.js'
import { humanizeMachineValue } from '../src/lib/goalBackwardPresentation.js'
import { resolveReadiness } from '../src/lib/truthConsistency.js'

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
const readinessCard = read('src/components/ReadinessArcCard.jsx')
const coachsLog = read('src/components/CoachsLogCard.jsx')
const dashboard = read('src/pages/Dashboard.jsx')
const css = read('src/index.css')

const readinessPayload = {
  available: true,
  score: 83,
  band: 'AMBER',
  verdict: 'Ready with one limiter.',
  drivers: ['Sleep duration supports today.', 'Recent training load calls for control.'],
}
const session = {
  id: 'signature-mission-run',
  kind: 'run',
  type: 'progression_run',
  title: 'Controlled progression run',
  distance_miles: 4.25,
  duration_min: 38,
  pace_target: '9:15-9:45 /mi',
  target_zone: 'Zone 2',
  intensity: 'Controlled aerobic',
  description: 'Build aerobic control before the next quality session.',
}
const executionPayload = {
  today: { date: '2026-08-15', day: 'Sat', type: session.type },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: false,
    date: '2026-08-15',
    sessions: [session],
    run: session,
    lift: null,
  },
}
const readinessBefore = structuredClone(readinessPayload)
const executionBefore = structuredClone(executionPayload)
const readiness = resolveReadiness(readinessPayload)
const execution = normalizeExecution(executionPayload)
const recommendation = recommendationFromExecution(execution)

assert.equal(readiness.score, readinessPayload.score, 'arc reuses the normalized readiness score exactly')
assert.equal(readiness.display, String(readinessPayload.score), 'arc reuses the normalized readiness display exactly')
assert.equal(humanizeMachineValue(readinessPayload.band), 'Amber', 'the source band receives presentation-only humanization')
assert.equal(recommendation.planSessionId, session.id, 'mission stays bound to the canonical execution session')
assert.equal(recommendation.suggestedDistance, session.distance_miles, 'mission distance comes from daily execution')
assert.equal(recommendation.durationMinutes, session.duration_min, 'mission duration comes from daily execution')
assert.equal(recommendation.suggestedPace, session.pace_target, 'mission pace comes from daily execution')
assert.equal(recommendation.targetZone, session.target_zone, 'mission zone comes from daily execution')
assert.equal(recommendation.intensity, session.intensity, 'mission effort comes from daily execution')
assert.equal(recommendation.reason, session.description, 'mission rationale comes from daily execution')
assert.deepEqual(readinessPayload, readinessBefore, 'readiness fixture remains byte-identical after presentation')
assert.deepEqual(executionPayload, executionBefore, 'daily-execution fixture remains byte-identical after presentation')

for (const [name, source] of [['ReadinessArcCard', readinessCard], ['CoachsLogCard', coachsLog]]) {
  assert.doesNotMatch(source, /\bfetch\s*\(|\bapi\s*\.|axios\s*\./, `${name} issues zero network requests`)
  assert.match(source, /aria-expanded=\{expanded\}/, `${name} exposes disclosure state to assistive technology`)
  assert.match(source, /humanizeMachineValue/, `${name} uses the shared presentation helper for machine values`)
}

assert.doesNotMatch(readinessCard, /resolveReadiness|finiteReadinessScore/, 'the arc does not normalize or recompute readiness')
assert.match(readinessCard, /data-readiness-score>\{normalized\.display\}/, 'the arc renders the Dashboard-normalized score')
assert.match(readinessCard, /state\.data\?\.drivers/, 'the arc only renders existing readiness drivers')
assert.doesNotMatch(readinessCard, /Recovery signals look steady/, 'the arc does not invent a fallback recovery driver')
for (const [state, copy] of [
  ['loading', 'Loading today'],
  ['locked', 'Upgrade to Forged Hybrid Pro'],
  ['error', 'load recovery readiness.'],
  ['unavailable', 'Sync Health data to unlock'],
]) {
  assert.ok(readinessCard.includes(copy), `${state} readiness copy remains truthful`)
}
assert.match(coachsLog, /matchingSession\(execution, recommendation\)/, 'the log binds the recommendation to daily execution')
assert.match(coachsLog, /if \(!recommendation[^\n]+return null/, 'the log is omitted when no canonical mission exists')
assert.match(coachsLog, /recommendation\?\.durationMinutes/, 'duration is conditional on an existing recommendation field')
assert.match(coachsLog, /recommendation\?\.suggestedDistance/, 'distance is conditional on an existing recommendation field')
assert.match(coachsLog, /recommendation\?\.brief\?\.effort \|\| recommendation\?\.intensity/, 'effort is conditional on an existing recommendation field')
assert.match(coachsLog, /formatHrZone\(session\) \|\| recommendation\?\.targetZone/, 'zone uses the existing shared formatter and payload')

assert.match(dashboard, /readiness=\{travelReadiness\}/, 'Dashboard passes its existing normalized readiness state to the arc')
assert.match(dashboard, /recommendation=\{effectiveRecommendation\}/, 'Dashboard passes its existing canonical recommendation to the log')
assert.match(dashboard, /execution=\{execution\}/, 'Dashboard passes its existing daily execution to the log')
assert.equal((dashboard.match(/['"]\/recovery\/readiness['"]/g) || []).length, 1, 'Dashboard retains exactly one readiness request path')
assert.equal((dashboard.match(/fetchDailyExecution\(localDateISO\(\)\)/g) || []).length, 1, 'Dashboard retains exactly one daily-execution request path')

const signatureCss = css.slice(css.indexOf("/* FORGE Signature UI: Readiness Arc + Coach's Log */"))
assert.ok(signatureCss.length > 0, 'signature styles are present')
assert.doesNotMatch(signatureCss, /gradient|backdrop-filter|\bblur\b/i, 'signature styles contain no gradient, glass, or blur treatment')
assert.match(signatureCss, /@media \(max-width: 340px\)/, 'compact-mobile-320 receives explicit responsive behavior')
assert.match(signatureCss, /@media \(prefers-reduced-motion: reduce\)/, 'signature motion has an explicit reduced-motion path')
assert.match(signatureCss, /\.signature-arc-progress[\s\S]*animation: none;[\s\S]*transition: none;/, 'the readiness arc stops moving under reduced motion')
assert.match(signatureCss, /min-width: 44px;[\s\S]*min-height: 44px;/, 'signature controls retain a 44px minimum target')
assert.match(signatureCss, /:focus-visible/, 'signature controls have a visible keyboard focus treatment')

const customerCopy = [
  readiness.display,
  humanizeMachineValue(readinessPayload.band),
  readinessPayload.verdict,
  ...readinessPayload.drivers,
  session.title,
  `${recommendation.suggestedDistance} mi`,
  `${recommendation.durationMinutes} min`,
  recommendation.suggestedPace,
  recommendation.targetZone,
  recommendation.intensity,
  recommendation.reason,
].join(' ')
assert.doesNotMatch(customerCopy, /_/, 'signature fixture copy is underscore-free after presentation')
assert.doesNotMatch(customerCopy, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, 'signature fixture copy contains no raw closed enum')

console.log('Signature UI smoke checks passed')
