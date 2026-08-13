import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { buildCalendarModel } from '../src/lib/planCalendar.js'
import { buildWeeklyRunBrief, sessionIntensity } from '../src/lib/weeklyRunBrief.js'

const require = createRequire(import.meta.url)
const adaptation = require('../../backend/src/lib/adaptationEngine.js')

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`  not ok  ${name}\n    ${error.message}`)
  }
}

const dates = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16']
const session = (id, type, distanceMiles, extras = {}) => ({
  id,
  kind: 'run',
  type,
  title: extras.title || `${type} run`,
  distanceMiles,
  durationMinutes: extras.durationMinutes || 0,
  prescriptionBasis: extras.prescriptionBasis || 'distance',
  prescription: {
    purpose: extras.purpose || '',
    target_zone: extras.zone || '',
    pace_target: extras.pace || '',
    surface: extras.surface || '',
  },
  raw: {},
  adjusted: Boolean(extras.adjusted),
})

const runDays = [
  { session: session('easy-1', 'easy', 4, { zone: 'Zone 2', pace: 'Conversational effort', purpose: 'Settle into the week.' }) },
  { session: session('tempo-1', 'tempo', 6, { zone: 'Zone 3-4', pace: 'Controlled threshold', purpose: 'Build sustainable speed.' }) },
  {},
  { session: { id: 'lift-1', kind: 'lift', type: 'strength', title: 'Strength', distanceMiles: 0, durationMinutes: 45, prescription: { focus: 'full body' }, raw: {} } },
  { session: session('easy-2', 'recovery', 3, { zone: 'Zone 1-2' }) },
  { session: session('long-1', 'long', 10, { zone: 'Zone 2', surface: 'road' }) },
  {},
]

const week = {
  phase: 'build',
  purpose: 'Turn steady aerobic work into controlled race-specific strength.',
  days: runDays.map((entry, index) => ({
    dayLabel: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index],
    dateISO: dates[index],
    date: new Date(`${dates[index]}T12:00:00`),
    sessions: entry.session ? [entry.session] : [],
    isRest: !entry.session,
    whyToday: index === 1 ? 'This quality session is the key workout for the week.' : '',
  })),
}

const shoes = [
  { id: 'daily-a', brand: 'User', model: 'Daily A', category: 'daily_trainer', surface: 'road', intent_tags: ['easy', 'long', 'recovery'], total_miles: 120, recommended_miles: 450, is_active: 1, is_retired: 0 },
  { id: 'tempo-a', brand: 'User', model: 'Tempo A', category: 'tempo', surface: 'road', intent_tags: ['tempo', 'threshold', 'intervals'], total_miles: 50, recommended_miles: 300, is_active: 1, is_retired: 0 },
  { id: 'tempo-b', brand: 'User', model: 'Tempo B', category: 'tempo', surface: 'road', intent_tags: ['tempo', 'long'], total_miles: 25, recommended_miles: 300, is_active: 1, is_retired: 0 },
]

const zones = [
  { zone: 1, minBpm: 100, maxBpm: 119 },
  { zone: 2, minBpm: 120, maxBpm: 139 },
  { zone: 3, minBpm: 140, maxBpm: 154 },
  { zone: 4, minBpm: 155, maxBpm: 169 },
  { zone: 5, minBpm: 170, maxBpm: 190 },
]

// Deterministic copies of backend computeZones() JSON output for each supported model.
const computedZoneFixtures = Object.freeze({
  hrr: [
    { zone: 1, minBpm: 120, maxBpm: 134, label: 'Recovery' },
    { zone: 2, minBpm: 134, maxBpm: 148, label: 'Easy' },
    { zone: 3, minBpm: 148, maxBpm: 162, label: 'Aerobic' },
    { zone: 4, minBpm: 162, maxBpm: 176, label: 'Threshold' },
    { zone: 5, minBpm: 176, maxBpm: 190, label: 'Maximum' },
  ],
  maxhr: [
    { zone: 1, minBpm: 95, maxBpm: 114, label: 'Recovery' },
    { zone: 2, minBpm: 114, maxBpm: 133, label: 'Easy' },
    { zone: 3, minBpm: 133, maxBpm: 152, label: 'Aerobic' },
    { zone: 4, minBpm: 152, maxBpm: 171, label: 'Threshold' },
    { zone: 5, minBpm: 171, maxBpm: 190, label: 'Maximum' },
  ],
  lthr: [
    { zone: 1, minBpm: 0, maxBpm: 134, label: 'Recovery' },
    { zone: 2, minBpm: 134, maxBpm: 150, label: 'Easy' },
    { zone: 3, minBpm: 150, maxBpm: 158, label: 'Aerobic' },
    { zone: 4, minBpm: 158, maxBpm: 166, label: 'Threshold' },
    { zone: 5, minBpm: 166, maxBpm: null, label: 'Maximum' },
  ],
  custom: [
    { zone: 1, minBpm: 100, maxBpm: 119, label: 'Recovery' },
    { zone: 2, minBpm: 120, maxBpm: 139, label: 'Easy' },
    { zone: 3, minBpm: 140, maxBpm: 154, label: 'Aerobic' },
    { zone: 4, minBpm: 155, maxBpm: 169, label: 'Threshold' },
    { zone: 5, minBpm: 170, maxBpm: 190, openEnded: true, label: 'Maximum' },
  ],
})
const calendarSource = fs.readFileSync(new URL('../src/components/calendar/ForgedCalendar.jsx', import.meta.url), 'utf8')
const dayViewSource = fs.readFileSync(new URL('../src/components/calendar/ForgedDayView.jsx', import.meta.url), 'utf8')
const calendarCss = fs.readFileSync(new URL('../src/components/calendar/forgedCalendar.css', import.meta.url), 'utf8')

check('classifies quality, long, recovery, and strength without changing the plan', () => {
  assert.equal(sessionIntensity(runDays[1].session).key, 'quality')
  assert.equal(sessionIntensity(runDays[5].session).key, 'long')
  assert.equal(sessionIntensity(runDays[4].session).key, 'recovery')
  assert.equal(sessionIntensity(runDays[3].session).key, 'strength')
})

check('builds a seven-day concise weekly story with truthful totals and mix', () => {
  const brief = buildWeeklyRunBrief({ week, todayISO: dates[3], gear: { available: true, shoes }, hrContext: { profile: { source: 'manual_watch' }, zones } })
  assert.equal(brief.days.length, 7)
  assert.equal(brief.totalMilesLabel, '23.0 mi')
  assert.equal(brief.totalTimeLabel, '45 min')
  assert.equal(brief.mix.quality, 1)
  assert.equal(brief.mix.long, 1)
  assert.equal(brief.mix.strength, 1)
  assert.equal(brief.mix.rest, 2)
  assert.equal(brief.today.title, 'Full Body strength')
  assert.equal(brief.purpose, week.purpose)
})

check('counts every planned session in the weekly mix when run and strength share a day', () => {
  const hybridWeek = structuredClone(week)
  hybridWeek.days[0].sessions.push(structuredClone(runDays[3].session))
  hybridWeek.days[3].sessions = []
  hybridWeek.days[3].isRest = true
  const brief = buildWeeklyRunBrief({ week: hybridWeek })
  assert.equal(brief.mix.easy, 2)
  assert.equal(brief.mix.strength, 1)
  assert.equal(brief.mix.rest, 3)
})

check('derives primary and alternate shoes only from the current Gear inventory', () => {
  const brief = buildWeeklyRunBrief({ week, todayISO: dates[0], gear: { available: true, shoes }, hrContext: { profile: null, zones: [] } })
  const tempo = brief.days[1]
  const long = brief.days[5]
  assert.match(tempo.footwear.primary.name, /^User Tempo [AB]$/)
  assert.match(tempo.footwear.alternate.name, /^User Tempo [AB]$/)
  assert.notEqual(tempo.footwear.primary.id, tempo.footwear.alternate.id)
  assert.ok(shoes.some((shoe) => tempo.footwear.primary.id === shoe.id))
  assert.ok(shoes.some((shoe) => long.footwear.primary.id === shoe.id))
  assert.equal(brief.days[2].footwear, null)
})

check('fails closed instead of guessing footwear when Gear is unavailable or empty', () => {
  const unavailable = buildWeeklyRunBrief({ week, gear: { available: false, shoes } })
  const empty = buildWeeklyRunBrief({ week, gear: { available: true, shoes: [] } })
  assert.equal(unavailable.days[0].footwear.state, 'unavailable')
  assert.equal(unavailable.days[0].footwear.primary, null)
  assert.equal(empty.days[0].footwear.state, 'empty')
  assert.equal(empty.days[0].footwear.primary, null)
})

check('shows numeric HR only when a saved profile and complete valid zones support the plan target', () => {
  const trusted = buildWeeklyRunBrief({ week, hrContext: { profile: { source: 'manual_watch' }, zones } })
  const missingProfile = buildWeeklyRunBrief({ week, hrContext: { profile: null, zones } })
  const incompleteZones = buildWeeklyRunBrief({ week, hrContext: { profile: { source: 'manual_watch' }, zones: zones.slice(0, 4) } })
  const duplicateZones = buildWeeklyRunBrief({ week, hrContext: { profile: { source: 'manual_watch' }, zones: [...zones.slice(0, 4), zones[3]] } })
  assert.deepEqual(trusted.days[0].hrTarget, { zoneLabel: 'Zone 2', bpmLabel: '120–139 bpm', sourceLabel: 'Saved HR profile' })
  assert.deepEqual(trusted.days[1].hrTarget, { zoneLabel: 'Zones 3–4', bpmLabel: '140–169 bpm', sourceLabel: 'Saved HR profile' })
  assert.equal(missingProfile.days[0].hrTarget, null)
  assert.equal(incompleteZones.days[0].hrTarget, null)
  assert.equal(duplicateZones.days[0].hrTarget, null)
  assert.equal(missingProfile.days[0].effortTarget, 'Conversational effort')
})

check('F1 accepts real computed HR zone shapes for hrr, maxhr, lthr, and custom while failing closed', () => {
  const expectedZone2 = { hrr: '134–148 bpm', maxhr: '114–133 bpm', lthr: '134–150 bpm', custom: '120–139 bpm' }
  for (const [model, modelZones] of Object.entries(computedZoneFixtures)) {
    const brief = buildWeeklyRunBrief({ week, hrContext: { profile: { source: 'manual_watch', zoneModel: model }, zones: modelZones } })
    assert.equal(brief.days[0].hrTarget?.bpmLabel, expectedZone2[model], `${model} computeZones() output remains usable`)
  }
  const lthrZone5Week = structuredClone(week)
  lthrZone5Week.days[0].sessions[0].prescription.target_zone = 'Zone 5'
  const openEnded = buildWeeklyRunBrief({
    week: lthrZone5Week,
    hrContext: { profile: { source: 'manual_watch', zoneModel: 'lthr' }, zones: computedZoneFixtures.lthr },
  })
  assert.equal(openEnded.days[0].hrTarget?.bpmLabel, '166+ bpm')

  const overlapping = structuredClone(computedZoneFixtures.hrr)
  overlapping[1].minBpm = 133
  const malformed = buildWeeklyRunBrief({ week, hrContext: { profile: { zoneModel: 'hrr' }, zones: overlapping } })
  assert.equal(malformed.days[0].hrTarget, null)
})

check('reveals an adaptation explanation only when the session is actually marked adjusted', () => {
  const adjustedWeek = structuredClone(week)
  adjustedWeek.days[0].sessions[0].adjusted = true
  adjustedWeek.days[0].sessions[0].raw.adjustmentReason = 'Recovery evidence reduced the original load.'
  const brief = buildWeeklyRunBrief({ week: adjustedWeek })
  assert.equal(brief.days[0].adjustmentReason, 'Recovery evidence reduced the original load.')
  assert.equal(brief.days[1].adjustmentReason, '')
})

check('real accepted adaptation persists its reviewed reason through the calendar into the brief', () => {
  const sourcePlan = {
    schemaVersion: 2,
    planMode: 'run_only',
    strengthPolicy: { enabled: false },
    weeks: [{
      week: 1,
      phase: 'build',
      startDate: '2026-08-10',
      purpose: 'Respond to trusted recovery evidence without hiding why.',
      days: [{
        date: '2026-08-13',
        day: 'Thu',
        sessions: [{
          id: 'real-adaptation-run',
          kind: 'run',
          type: 'tempo',
          workout_type: 'run',
          title: 'Tempo repeats',
          distance_miles: 5,
          intensity: 'Hard',
          target_zone: 'Zone 4',
          steps: ['4 × 5 min threshold'],
        }],
      }],
    }],
  }
  const proposal = adaptation.buildAdaptationProposal({
    plan: sourcePlan,
    planningDateISO: '2026-08-13',
    healthSignals: {
      metrics: {
        readinessScore: {
          value: 40,
          source: 'apple_health',
          asOf: '2026-08-13',
          freshness: 'fresh',
          suspect: false,
        },
      },
    },
  })
  assert.equal(proposal.status, 'proposal')
  assert.ok(proposal.changes.length > 0)

  // The accept route persists proposed_json, so a JSON round-trip here models
  // the real proposal -> accepted plan boundary rather than fabricating UI-only
  // adjustment fields.
  const persistedPlan = JSON.parse(JSON.stringify(proposal.proposedPlan))
  const model = buildCalendarModel(persistedPlan, { progress: { completedSessionIds: [] } }, {
    now: new Date(2026, 7, 13, 12, 0, 0),
  })
  const normalizedWeek = model.getWeek(0)
  const brief = buildWeeklyRunBrief({ week: normalizedWeek, todayISO: '2026-08-13' })
  const reviewedChange = proposal.changes.find((change) => change.sessionId === 'real-adaptation-run')
  assert.equal(brief.today?.adjustmentReason, reviewedChange?.summary)
  assert.equal(brief.today?.rawDay?.sessions?.[0]?.adjusted, true)
  assert.equal(brief.today?.rawDay?.sessions?.[0]?.raw?.adjustment_reason, reviewedChange?.summary)
})

check('F2 attributes adjustments only to a saved reason and never to generic or integrity-only context', () => {
  const adjustedWithoutEvidence = structuredClone(week)
  adjustedWithoutEvidence.days[0].sessions[0].adjusted = true
  adjustedWithoutEvidence.days[0].whyToday = 'This is the generic reason this workout was scheduled.'
  assert.equal(buildWeeklyRunBrief({ week: adjustedWithoutEvidence }).days[0].adjustmentReason, '')

  const savedAdjustment = structuredClone(adjustedWithoutEvidence)
  savedAdjustment.days[0].sessions[0].raw.adjustment_reason = 'Saved recovery evidence reduced the load.'
  assert.equal(buildWeeklyRunBrief({ week: savedAdjustment }).days[0].adjustmentReason, 'Saved recovery evidence reduced the load.')

  const integrityRepair = structuredClone(adjustedWithoutEvidence)
  integrityRepair.days[0].sessions[0].prescription.prescriptionIntegrityAdjusted = true
  integrityRepair.days[0].sessions[0].raw.prescriptionIntegrityAdjusted = true
  assert.equal(buildWeeklyRunBrief({ week: integrityRepair }).days[0].adjustmentReason, '')
})

check('wear and surface mismatches are visible instead of hidden', () => {
  const worn = shoes.map((shoe) => ({ ...shoe, total_miles: shoe.recommended_miles }))
  const wornBrief = buildWeeklyRunBrief({ week, gear: { available: true, shoes: worn } })
  assert.equal(wornBrief.days[0].footwear.state, 'wear-review')
  assert.match(wornBrief.days[0].footwear.warning, /at or over/i)
  const trailWeek = structuredClone(week)
  trailWeek.days[0].sessions[0].prescription.surface = 'trail'
  const trailBrief = buildWeeklyRunBrief({ week: trailWeek, gear: { available: true, shoes } })
  assert.match(trailBrief.days[0].footwear.warning, /No verified trail match/i)
})

check('F4 uses truthful closest-available wording for a lone race-shoe fallback', () => {
  const raceOnly = [{
    id: 'race-only', brand: 'User', model: 'Carbon Racer', category: 'race', surface: 'road', intent_tags: [],
    total_miles: 20, recommended_miles: 200, is_active: 1, is_retired: 0,
  }]
  const footwear = buildWeeklyRunBrief({ week, gear: { available: true, shoes: raceOnly } }).days[0].footwear
  assert.doesNotMatch(footwear.primary.reason, /Matches this easy session/i)
  assert.match(`${footwear.primary.reason} ${footwear.warning}`, /closest available/i)
  assert.match(`${footwear.primary.reason} ${footwear.warning}`, /no daily trainer/i)
})

check('F7 keeps an estimate marker on a weekly total containing estimated distance', () => {
  const estimatedWeek = structuredClone(week)
  estimatedWeek.days[0].sessions[0].distanceIsEstimate = true
  assert.equal(buildWeeklyRunBrief({ week: estimatedWeek }).totalMilesLabel, '~23.0 mi')
})

check('F3 never labels prescribed HYROX transition or run recovery as optional', () => {
  assert.doesNotMatch(dayViewSource, /title="Optional recovery"/)
  assert.match(dayViewSource, /<strong>Transition \/ rest:<\/strong>/)
  assert.match(dayViewSource, /Recoveries: \{f\.recoveries\}/)
})

check('F5 rest-day recorded mileage and Not scheduled provenance override the brief recovery target', () => {
  assert.match(calendarSource, /const displayedSub = day\.isRest && hasRecordedRun\s*\? sub\s*: briefDay\?\.target \|\| sub/)
  assert.match(calendarSource, /\{displayedSub \|\| \(isToday \? 'Today' : 'Planned'\)\}/)
})

check('F6 week row and mission card share the same canonical brief title', () => {
  assert.match(calendarSource, /const displayedTitle = day\.isRest && hasRecordedRun \? title : briefDay\?\.title \|\| title/)
  assert.match(calendarSource, /forged-day-title">\{displayedTitle\}/)
  assert.match(calendarSource, /<strong>\{brief\.today\.title\}<\/strong>/)
})

check('F8 standalone Gear warning links have a 44px target', () => {
  assert.match(calendarCss, /\.forged-gear-warning a,\s*\.forged-gear-unavailable a\s*\{[^}]*min-height:\s*44px;[^}]*\}/s)
})

if (failures.length) {
  console.error(`\n${failures.length} Weekly Run Brief checks failed; ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\n${passed} Weekly Run Brief checks passed`)
}
