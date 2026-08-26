import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildRestDayReasons, buildWeeklyRecapView, dashboardCustomerText } from '../src/lib/dashboardBrief.js'

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
const dashboard = read('src/pages/Dashboard.jsx')
const coachsLog = read('src/components/CoachsLogCard.jsx')
const weeklyRecap = read('src/pages/WeeklyRecap.jsx')
const css = read('src/index.css')

const recapFixture = {
  weekLabel: 'Aug 10 - Aug 16',
  totalMiles: 7.2,
  totalRuns: 2,
  totalMinutes: 83,
  totalCalories: 830,
  avgPace: '11:32',
  bestRun: { date: '2026-08-13', miles: 4.5, pace: '11:10' },
  liftSessions: 1,
  mileageVsLastWeek: -4.3,
  insight: 'Keep Monday easy, then bring full energy to Tuesday’s progression run.',
  is_pro: true,
}
const restFixture = {
  recommendation: {
    recommendationType: 'rest',
    reason: 'Rest and recovery are scheduled today.',
  },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: true,
    isPlannedRest: true,
    restSource: 'planned',
  },
  weeklyRecap: recapFixture,
  readinessData: {
    score: 79,
    drivers: ['Recent training load supports a lighter day.'],
  },
  nextRace: {
    race_name: 'Army Ten-Miler',
    race_date: '2026-10-11',
  },
}
const before = structuredClone({ recapFixture, restFixture })

const reasons = buildRestDayReasons(restFixture)
assert.deepEqual(reasons, [
  { key: 'plan', label: 'Planned recovery', detail: 'Rest and recovery are scheduled today.' },
  { key: 'recent-work', label: 'Absorb recent work', detail: '7.2 mi across 2 runs · Aug 10 - Aug 16' },
  { key: 'forward-purpose', label: 'Protect the build', detail: 'Army Ten-Miler · Oct 11' },
], 'rest rationale selects only exact plan, recap, and event fields')
assert.doesNotMatch(reasons.map((reason) => `${reason.label} ${reason.detail}`).join(' '), /79/, 'readiness score is not presented as rest authority')

const readinessFallback = buildRestDayReasons({
  ...restFixture,
  weeklyRecap: null,
  nextRace: null,
})
assert.deepEqual(readinessFallback[1], {
  key: 'recovery-signal',
  label: 'Recovery signal',
  detail: 'Recent training load supports a lighter day.',
}, 'a real readiness driver is used only when recent recap evidence is unavailable')

const recapView = buildWeeklyRecapView(recapFixture)
assert.equal(recapView.weekLabel, recapFixture.weekLabel)
assert.deepEqual(recapView.teaserItems, ['7.2 mi', '2 runs', '830 cal'])
assert.deepEqual(Object.fromEntries(recapView.metrics.map((metric) => [metric.key, metric.value])), {
  distance: '7.2 mi',
  runs: '2',
  duration: '83 min',
  calories: '830 cal',
  pace: '11:32/mi',
})
assert.deepEqual(recapView.highlight, { label: 'Longest run', text: '4.5 mi on Aug 13' })
assert.equal(recapView.nextWeek, recapFixture.insight)
assert.equal(buildWeeklyRecapView({ ...recapFixture, totalCalories: 0 }).metrics.some((metric) => metric.key === 'calories'), false, 'calories are gracefully omitted without a positive source value')
assert.equal(buildWeeklyRecapView({ ...recapFixture, totalCalories: null }).teaserItems.includes('0 cal'), false, 'the teaser never manufactures zero-calorie copy')
assert.equal(dashboardCustomerText('FULL_REST'), 'Full rest', 'closed enums are humanized before presentation')
assert.deepEqual({ recapFixture, restFixture }, before, 'presentation helpers never mutate dashboard payloads')

assert.equal((dashboard.match(/api\.get\('\/recap\/weekly'\)/g) || []).length, 1, 'Dashboard retains one weekly recap request')
assert.match(dashboard, /<WeeklyRecapDialog open=\{weeklyRecapOpen\} data=\{weeklyRecap\}/, 'the dialog reuses the loaded Dashboard recap payload')
assert.match(dashboard, /event\.stopPropagation\(\)[\s\S]*recap-seen-/, 'teaser dismissal stops propagation and retains announcement persistence')
assert.match(dashboard, /aria-haspopup="dialog"/, 'the recap opener advertises the dialog interaction')
assert.match(coachsLog, /className="signature-coachs-log card-hero"/, 'Daily Brief reuses the Today card family')
assert.match(dashboard, /className="card-hero dashboard-weekly-recap"/, 'Weekly Recap teaser reuses the Today card family')
assert.match(dashboard, /<DailyCoachFlow/, 'Review today’s plan remains on the Dashboard')
assert.match(dashboard, /<TomorrowPlanCard/, 'the Dashboard includes the evening Tomorrow handoff')
assert.match(dashboard, /shouldPromoteTomorrow\(dashboardNow\)/, 'Tomorrow stays gated by device-local time')
assert.match(dashboard, /localTomorrowDateISO\(requestNow\)/, 'Tomorrow fetch uses device-local date math')
assert.doesNotMatch(dashboard, /onCheckIn=\{\(\) => navigate\('\/checkin'\)\}/, 'changed Dashboard/Today wiring exposes no check-in action')
assert.match(weeklyRecap, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="weekly-recap-dialog-title"/, 'opened recap has accessible modal semantics')
assert.match(weeklyRecap, /useDialogFocus\(active, onClose\)/, 'opened recap reuses the focus trap and Escape dismissal helper')
assert.match(weeklyRecap, /document\.body\.style\.overflow = 'hidden'/, 'opened recap locks body scrolling')
assert.match(weeklyRecap, /<WeeklyRecapPresenter data=\{data\} modal \/>/, 'dialog reuses the existing Weekly Recap presenter')
assert.doesNotMatch(weeklyRecap, /Keep your next run easy and consistent to build aerobic fitness safely/, 'the presenter no longer fabricates fallback coaching')

const signatureCss = css.slice(css.indexOf("/* FORGE Signature UI: Readiness Arc + Coach's Log */"))
assert.doesNotMatch(signatureCss, /#f5ead7|#c2410c|#1a1d2e|#2a2d3e/i, 'cream, orange-rail, and navy recap surfaces are absent')
assert.match(css, /\.weekly-recap-dialog-scrollport[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto;/, 'recap dialog owns a bounded internal scrollport')
assert.match(css, /\.weekly-recap-dialog-header button[\s\S]*min-width: 44px;[\s\S]*min-height: 44px;/, 'recap close target remains at least 44px')
assert.match(css, /@media \(max-width: 340px\)[\s\S]*\.dashboard-weekly-recap-open[\s\S]*\.weekly-recap-stat/, 'compact 320 styling covers teaser and opened recap metrics')

const customerCopy = [
  ...reasons.flatMap((reason) => [reason.label, reason.detail]),
  ...recapView.teaserItems,
  ...recapView.metrics.flatMap((metric) => [metric.label, metric.value]),
  recapView.highlight.label,
  recapView.highlight.text,
  recapView.nextWeek,
].join(' ')
assert.doesNotMatch(customerCopy, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, 'fixture customer copy exposes no raw enum')

console.log('Dashboard unified brief and weekly recap smoke checks passed')
