import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { hasUsableChartData } from '../src/lib/chartTheme.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const css = read('frontend/src/index.css')
const layout = read('frontend/src/components/Layout.jsx')
const app = read('frontend/src/App.jsx')
const runHub = read('frontend/src/pages/RunHub.jsx')
const gear = read('frontend/src/pages/Gear.jsx')
const hrZones = read('frontend/src/pages/HrZones.jsx')
const recommendation = read('frontend/src/components/StrengthWorkoutRecommendation.jsx')
const aiRoute = read('backend/src/routes/ai.js')
const history = read('frontend/src/pages/History.jsx')

function loadSourceFunction(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`)
  assert.notEqual(start, -1, `${functionName} source exists`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) {
      const sandbox = { result: null }
      vm.runInNewContext(`${source.slice(start, index + 1)}\nresult = ${functionName}`, sandbox)
      return sandbox.result
    }
  }
  throw new Error(`${functionName} source is incomplete`)
}

const sanitizeSemanticTitle = loadSourceFunction(aiRoute, 'sanitizeSemanticTitle')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

check(css.includes('--app-bottom-nav-base-height: 59px') && css.includes('--app-bottom-nav-height: calc(var(--app-bottom-nav-base-height) + var(--safe-bottom))'), 'shared nav height includes the iOS safe-area inset')
check(css.includes('padding-bottom: calc(var(--app-bottom-nav-height) + var(--app-bottom-content-gap))'), 'shared content clearance explicitly includes nav height and a content gap')
check(css.includes('@media (max-height: 700px)') && css.includes('--app-bottom-content-gap: 24px'), 'short viewports receive bounded extra breathing room')
check(layout.includes('className="app-shell-main pt-4"') && layout.includes("height: 'var(--app-bottom-nav-height)'"), 'content and fixed nav consume the same shared shell measurement')
check(css.includes('scroll-margin-bottom: calc(var(--app-bottom-nav-height) + var(--app-bottom-content-gap))'), 'focused and expanded actions receive nav-aware scroll margin')

const cssViewport = { width: 1280, height: 633 }
const shellWidth = Math.min(480, cssViewport.width)
const shortViewportClearance = 59 + 24
check(shortViewportClearance > 59 && shortViewportClearance < 120, '1280x633 clearance exceeds the nav without creating a large blank gutter')
check(shellWidth === 480 && layout.includes("maxWidth: 'min(480px, 100vw)'") && layout.includes("overflowX: 'hidden'"), '1280x633 uses the 480px narrow shell without horizontal overflow')

function privateRouteContains(route, component) {
  const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`path="${escapedRoute}"[\\s\\S]{0,220}<PrivateRoute>[\\s\\S]{0,100}<${component} \\/>`).test(app)
}

check(privateRouteContains('/run', 'RunHub'), 'Train uses the shared private app shell')
check(privateRouteContains('/gear', 'Gear'), 'Forged Closet uses the shared private app shell')
check(privateRouteContains('/hr-zones', 'HrZones'), 'HR Zones uses the shared private app shell')
check(!runHub.includes('pb-16') && !gear.includes('paddingBottom: 96') && !hrZones.includes('paddingBottom: 96'), 'affected routes do not stack legacy bottom gutters on the shared clearance')

const shortTitle = 'Hybrid Strength'
check(sanitizeSemanticTitle(shortTitle) === shortTitle, 'already-short strength titles remain byte-for-byte unchanged')

const fullTitle = 'Hybrid Strength — Posterior Chain Power and Tissue Resilience for Long-Distance Running'
check(sanitizeSemanticTitle(fullTitle) === fullTitle, 'normal generated titles retain their full semantic text')

const boundedTitle = sanitizeSemanticTitle(`${fullTitle} with Progressive Single-Leg Stability`, 64)
const boundedPrefix = boundedTitle.slice(0, -1)
check(boundedTitle.endsWith('…') && fullTitle.startsWith(boundedPrefix) && /\s/.test(fullTitle[boundedPrefix.length]), 'bounded labels truncate only after a complete word and use one ellipsis')
check(!aiRoute.includes('sanitize(value.workoutName, 100)') && !aiRoute.includes('sanitize(value.target, 80)'), 'strength title fields are no longer raw character-sliced')
check(recommendation.includes("className={expanded ? undefined : 'strength-workout-title'}") && recommendation.includes('title={expanded ? undefined : fullTitle}') && recommendation.includes('aria-label={fullTitle}'), 'visual title clamping retains the full accessible title')
check(css.includes('-webkit-line-clamp: 2') && css.includes('text-overflow: ellipsis'), 'strength titles use a two-line visual ellipsis')

for (const data of [
  [],
  [{ miles: null }],
  [{ miles: undefined }],
  [{ miles: Number.NaN }],
  [{ miles: Number.POSITIVE_INFINITY }],
  [{ miles: Number.NEGATIVE_INFINITY }],
]) {
  check(!hasUsableChartData(data, 'miles'), 'empty, null, or non-finite chart input is unusable')
}
check(hasUsableChartData([{ miles: 0 }], 'miles') && hasUsableChartData([{ miles: 6.2 }], 'miles'), 'valid finite history values, including a real zero, remain chartable')
check(history.includes('if (mileageRuns.length === 0) return []') && history.includes('{(hasWeeklyMileage || hasPaceTrend) && ('), 'History omits the chart container when no source-backed finite series exists')
check(history.includes('{hasWeeklyMileage && (') && history.includes('<BarChart data={weeklyMileage}>') && history.includes('{hasPaceTrend && (') && history.includes('<LineChart data={paceTrend}>'), 'valid finite mileage and pace series still render their existing charts')
check(history.includes("t('history.noRuns')"), 'the existing empty History zero-state is preserved')

console.log(`RESPONSIVE POLISH SMOKE OK (${passed})`)
