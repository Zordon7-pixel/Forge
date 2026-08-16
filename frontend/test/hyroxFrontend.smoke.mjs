import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hyroxCandidateReviewModel, normalizeSession, sessionKind } from '../src/lib/planCalendar.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const catalog = read('frontend/src/pages/PlanCatalog.jsx')
const setup = read('frontend/src/components/hyrox/HyroxPlanSetup.jsx')
const activation = read('frontend/src/lib/planCandidateActivation.js')
const reviewSheet = read('frontend/src/components/PlanCandidateDecisionSheet.jsx')
const calendar = read('frontend/src/components/calendar/ForgedCalendar.jsx')
const dayView = read('frontend/src/components/calendar/ForgedDayView.jsx')
const planCalendar = read('frontend/src/lib/planCalendar.js')
const changedFrontend = [catalog, setup, reviewSheet, calendar, dayView, planCalendar].join('\n')

assert.match(catalog, /HYROX/, 'plan catalog presents HYROX as a first-class choice')
assert.match(catalog, /<HyroxPlanSetup/, 'the catalog opens the focused HYROX setup flow')
assert.match(setup, /event_date[\s\S]*foundation/, 'setup offers dated and eight-week foundation modes')
for (const field of ['eventName', 'eventLocalDate', 'eventTimezone', 'eventFormat', 'eventCategory', 'rulesVersion', 'equipment', 'runDaysPerWeek', 'trainingDays', 'secondaryRaceId']) {
  assert.ok(setup.includes(field), `HYROX setup includes ${field}`)
}
assert.match(setup, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/, 'IANA timezone defaults from the browser')
assert.match(setup, /2026-2027/, 'setup sends the backend-supported metric canonical rules version')
assert.match(setup, /canonicalUnits:\s*'metric'/, 'canonical event rules remain metric')
assert.match(setup, /foundation[\s\S]*8-week|eight-week foundation/i, 'no-date mode is an eight-week foundation block')
assert.doesNotMatch(changedFrontend, /Bryan/i, 'frontend contains no identity special case')
assert.doesNotMatch(changedFrontend, /weeks\s*===?\s*5|weeks\s*==\s*5/, 'frontend contains no fixed five-week branch')

for (const route of ['/plans/generate-for-races', '/plans/generate-for-race', '/plans/generate']) {
  assert.ok(setup.includes(route), `setup uses backend candidate route ${route}`)
}

function candidateFixture({ weeks, days, runway, phases, missingEquipment = [], transition = false }) {
  const allPhases = transition ? [...phases, 'post_hyrox_recovery', 'running_specific'] : phases
  return {
    planMode: 'hyrox_build',
    overall_feasibility: 'supported',
    hyroxPolicy: {
      daysToEventAtGeneration: days,
      runwayClass: runway,
      sessionsPerWeek: 2,
      compromisedRunSessionsPerWeek: 1,
      maximumHardLowerBodyDaysPerRollingSeven: 2,
      equipment: ['row_erg', 'sandbag'],
      missingEquipment,
      substitutionsAllowed: true,
      fullSimulationRequired: false,
    },
    schedulePreferences: { runDaysPerWeek: 3, trainingDays: ['Tue', 'Thu', 'Sat'] },
    goals: transition ? [{ kind: 'hyrox', name: 'HYROX' }, { kind: 'run_race', name: 'Autumn 10 Mile' }] : [{ kind: 'hyrox', name: 'HYROX' }],
    weeks: Array.from({ length: weeks }, (_, index) => ({
      phase: allPhases[index] || allPhases.at(-1),
      days: [{ sessions: [{ kind: 'hyrox', sessionType: 'hyrox_skill' }, { kind: 'run', type: 'easy' }] }],
    })),
  }
}

const fixtures = [
  { weeks: 3, days: 20, runway: 'readiness_bridge', phases: ['readiness_bridge', 'consolidate', 'taper_race'] },
  { weeks: 5, days: 35, runway: 'short_runway', phases: ['orientation_assessment', 'build', 'peak_partial_simulation', 'sharpen_reduce', 'taper_race'] },
  { weeks: 8, days: 56, runway: 'standard_build', phases: ['foundation', 'foundation', 'build', 'build', 'specific', 'specific', 'sharpen_reduce', 'taper_race'] },
  { weeks: 16, days: 112, runway: 'full_build', phases: ['foundation', 'foundation', 'foundation', 'build', 'build', 'build', 'specific', 'specific', 'specific', 'sharpen_reduce', 'taper_race'] },
]

for (const fixture of fixtures) {
  const plan = candidateFixture(fixture)
  const review = hyroxCandidateReviewModel(plan)
  assert.equal(review.daysRemaining, fixture.days, `${fixture.weeks}-week fixture renders backend days remaining`)
  assert.equal(review.runwayClass, fixture.runway, `${fixture.weeks}-week fixture renders backend runway class`)
  assert.deepEqual(review.phases, [...new Set(plan.weeks.map((week) => week.phase))], `${fixture.weeks}-week fixture preserves backend phase sequence`)
  assert.equal(review.weekCount, fixture.weeks, `${fixture.weeks}-week fixture renders backend week count`)
}

const limited = hyroxCandidateReviewModel(candidateFixture({
  weeks: 5,
  days: 35,
  runway: 'short_runway',
  phases: ['orientation_assessment', 'build', 'peak_partial_simulation', 'sharpen_reduce', 'taper_race'],
  missingEquipment: ['sled_push', 'sled_pull', 'ski_erg'],
}))
assert.deepEqual(limited.missingEquipment, ['sled_push', 'sled_pull', 'ski_erg'])
assert.match(limited.equipmentTruth, /pattern-only substitutions/i, 'limited equipment never claims exact station readiness')
assert.match(limited.safetyPolicy, /2 hard lower-body days/, 'candidate shows the backend hard-day policy')

const transition = hyroxCandidateReviewModel(candidateFixture({
  weeks: 5,
  days: 35,
  runway: 'short_runway',
  phases: ['orientation_assessment', 'build', 'peak_partial_simulation'],
  transition: true,
}))
assert.match(transition.recoveryTransition, /recovery[\s\S]*Autumn 10 Mile/i, 'candidate shows HYROX-to-running-race recovery transition')

const hyroxRaw = {
  id: 'hyrox-1',
  kind: 'hyrox',
  sessionType: 'hyrox_compromised',
  title: 'Controlled compromised running',
  stationSequence: [
    { id: 'ski_erg', name: 'SkiErg', distanceMeters: 1000, exactStation: true },
    { id: 'sled_push', name: 'Sled push', distanceMeters: 50, exactStation: false, substitute: 'Incline march; pattern training only' },
  ],
  runSequenceMeters: [1000, 1000],
  canonicalUnits: 'metric',
}
assert.equal(sessionKind(hyroxRaw), 'hyrox', 'HYROX is not disguised as a generic run or lift')
const normalizedHyrox = normalizeSession(hyroxRaw)
assert.equal(normalizedHyrox.kind, 'hyrox')
assert.deepEqual(normalizedHyrox.raw.stationSequence, hyroxRaw.stationSequence, 'exact sequence and canonical station prescriptions survive normalization')
assert.equal(normalizedHyrox.raw.canonicalUnits, 'metric', 'display normalization does not mutate canonical units')

assert.match(setup, /hyroxCandidateReviewModel/, 'candidate dialog uses the backend-driven HYROX review model')
assert.match(setup, /Days remaining[\s\S]*Phase sequence[\s\S]*Equipment and substitutions[\s\S]*Hard-day safety/, 'candidate dialog presents the required review sections before apply')
assert.match(setup, /setCandidate\(data\)[\s\S]*applyCandidate[\s\S]*applyPlanCandidateWithActivation/, 'HYROX always pauses on the candidate before explicit apply')
assert.match(activation, /candidate_hash:\s*normalizedCandidateHash[\s\S]*choice:\s*'train_for_target'/, 'the bounded activation helper applies the exact reviewed candidate')
assert.match(setup, /goal_time_seconds:\s*goalTimeSeconds \|\| null/, 'HYROX saves the explicit performance target with the event truth')
assert.match(setup, /hyroxRace:\s*eventMode === 'event_date' \? ownedHyroxRace : null[\s\S]*secondaryRaceId:\s*eventMode === 'event_date'/, 'foundation activation ignores dated owned-race truth without mutating the saved event')
assert.match(activation, /verifyHyroxPlanActivation[\s\S]*expectedUserPlanId[\s\S]*secondaryRaceId/, 'HYROX apply verifies assignment identity and exact combined-goal membership')
assert.match(calendar, /kind === 'hyrox'|kind="hyrox"/, 'calendar visibly distinguishes HYROX sessions')
assert.match(dayView, /stationSequence[\s\S]*exactStation[\s\S]*substitute/, 'day details show ordered stations and truthful substitutions')
assert.match(dayView, /distanceMeters|repetitions|officialStandard/, 'day details keep metric station prescriptions visible')
assert.match(dayView, /officialTeamStationSequence[\s\S]*displayedStationSequence/, 'relay details render the complete official team order separately from athlete assignments')
assert.match(dayView, /2 × 1,000 m run[\s\S]*2 team-assigned stations/, 'relay details state truthful athlete-specific race volume')
assert.match(dayView, /displayedStationSequence\.map[\s\S]*officialMetricFacts/, 'official race standards drive the rendered station load facts')
assert.match(dayView, /loadsByAthleteCategory[\s\S]*Women:[\s\S]*Men:/, 'mixed-relay day details show athlete-category-specific official loads')
assert.match(dayView, /minWidth:\s*0|overflowWrap:\s*'anywhere'/, 'HYROX detail content is constrained at 320px')
assert.match(setup, /minHeight:\s*44/, 'HYROX setup touch controls meet the 44px target')
assert.match(reviewSheet, /min-h-12|min-h-11/, 'candidate actions retain accessible touch targets')

assert.match(catalog, /PLAN_GOALS\.map/, 'legacy no-date running blocks remain wired')
assert.match(catalog, /openRace/, 'legacy race setup remains wired')
assert.match(catalog, /previewAndApplyPlan/, 'legacy preview/apply remains wired')

console.log('HYROX FRONTEND SMOKE OK (65)')
