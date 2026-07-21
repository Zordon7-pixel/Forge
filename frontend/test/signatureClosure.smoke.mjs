import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ZONE_HEAT_PALETTE,
  getPaceZone,
  getProgressiveOverloadTip,
} from '../src/lib/athleteLanguage.js'
import {
  buildRunComparison,
  parseZoneTimeline,
  resolveRunHeartRateZone,
} from '../src/lib/runRecap.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const css = read('frontend/src/index.css')
const workoutSummary = read('frontend/src/pages/WorkoutSummary.jsx')
const activeRun = read('frontend/src/pages/ActiveRun.jsx')
const runRecap = read('frontend/src/lib/runRecap.js')
const runDetail = read('frontend/src/components/RunDetailModal.jsx')
const history = read('frontend/src/pages/History.jsx')
const hrZones = read('frontend/src/pages/HrZones.jsx')
const runHub = read('frontend/src/pages/RunHub.jsx')
const upgrade = read('frontend/src/pages/Upgrade.jsx')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] || ''
}

function cssValue(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return block.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`))?.[1]?.trim() || null
}

console.log('\n== F0 source truth ==')
check(!workoutSummary.includes('+12% volume'), 'invented +12% comparison is absent')
check(!/hrZonesData\s*=\s*\[/.test(workoutSummary) && !workoutSummary.includes('min: 0.35'), 'workout summary has no default HR-zone distribution')
check(workoutSummary.includes('parseZoneTimeline') && workoutSummary.includes('if (!timeline.trusted'), 'workout zone chart is gated by trusted recorded coverage')
check(!workoutSummary.includes('calories_burned') && !workoutSummary.includes('Resting Cal') && !workoutSummary.includes('Total Cal Burned'), 'workout summary does not present unprovenanced calorie estimates')
check(!history.includes('session.calories_burned'), 'History does not present strength-session calorie estimates as measurements')
check(!workoutSummary.includes('Intensity (% est. 1RM)') && !workoutSummary.includes('const intensityPct'), 'unsupported intensity estimate is absent')
check(!workoutSummary.includes('set.duration_seconds || 30') && workoutSummary.includes('hasCompleteSetTiming'), 'work/rest timing is omitted unless every set has recorded timing')
check(!workoutSummary.includes('Solid work completing your lift session.') && workoutSummary.includes('setShowAiCard(false)'), 'failed AI feedback does not fall back to invented coaching')
check(/totalReps\s*=\s*sets\.reduce[\s\S]{0,180}Number\(set\.reps\)/.test(workoutSummary), 'recorded reps still produce a set-derived total')
check(/totalVolumeLbs\s*=\s*sets\.reduce[\s\S]{0,240}Number\(set\.reps\)[\s\S]{0,100}Number\(set\.weight_lbs\)/.test(workoutSummary), 'recorded reps and weights still produce mathematical volume')

const noZones = parseZoneTimeline(null, 1800)
check(noZones.totalSeconds === 0 && noZones.coveragePct === null && !noZones.trusted, 'absent zone data stays absent')
const sparseZones = parseZoneTimeline({ z2: 120 }, 1800)
check(sparseZones.totalSeconds === 120 && !sparseZones.trusted, 'partial recorded zones fail the trust gate')
const recordedZones = parseZoneTimeline({ z1: 120, z2: 900, z3: 360, z4: 240, z5: 180 }, 1800)
check(recordedZones.trusted && recordedZones.totalSeconds === 1800 && recordedZones.dominantZone === 2, 'complete recorded zones pass the trust gate without defaults')

const absentComparison = buildRunComparison({ distance_miles: 3, duration_seconds: 1800 })
check(!absentComparison.hasPlan && absentComparison.adherenceScore === undefined, 'run comparison stays absent without a real plan payload')
const realComparison = buildRunComparison({
  distance_miles: 3,
  duration_seconds: 1800,
  planned_session_json: { distanceMiles: 3, targetZone: 'Zone 2' },
  heart_rate_zones: { z1: 60, z2: 1500, z3: 180, z4: 60, z5: 0 },
})
check(realComparison.hasPlan && realComparison.adherenceScore !== null && Math.round(realComparison.zoneAdherencePct) === 83, 'comparison percentages derive from real plan and recorded-zone payloads')
const baselineTip = getProgressiveOverloadTip(null, { totalVolume: 1200 })
check(!/\d+%/.test(baselineTip) && /Baseline/.test(baselineTip), 'strength comparison does not invent a percentage without prior history')
check(getProgressiveOverloadTip({ totalVolume: 1000 }, { totalVolume: 1200 }).includes('20% more volume'), 'strength comparison uses real prior and current payload values when present')

console.log('\n== U8 tempered-steel foundation ==')
const root = cssBlock(':root')
const light = cssBlock('.light')
const expectedColors = ['#5E6C7B', '#EAB308', '#F97316', '#E5484D', '#FFF6DC']
for (const [index, expected] of expectedColors.entries()) {
  check(cssValue(root, `--z${index + 1}`) === expected, `dark token --z${index + 1} is canonical`)
  check(cssValue(light, `--z${index + 1}`) === expected, `light token --z${index + 1} remains available`)
}
check(cssValue(root, '--ember-grad') === 'linear-gradient(135deg,#EAB308,#F97316)', 'canonical ember gradient exists')
check(cssValue(light, '--text-primary') === '#111827' && cssValue(light, '--bg-card') === '#ffffff', 'light theme keeps readable text and card tokens')
const darkGround = [cssValue(root, '--bg-base'), cssValue(root, '--bg-card')].map((value) => value?.toUpperCase())
check(!darkGround.includes('#000000') && !darkGround.includes('#111111'), 'dark ground and card identity are coal/steel rather than pure black')
check(['--success', '--warning', '--danger'].every((token) => cssValue(root, token)), 'unrelated semantic success/warning/danger tokens remain compatible')

console.log('\n== U8b canonical zone heat ==')
check(ZONE_HEAT_PALETTE.map(({ color }) => color).join(',') === expectedColors.join(','), 'canonical JS fills match CSS Z1-Z5 tokens')
check(ZONE_HEAT_PALETTE.every(({ color, textColor }) => /^#[0-9A-F]{6}$/.test(color) && /^#[0-9A-F]{6}$/.test(textColor)), 'canonical JS palette remains raw hex for alpha templates')
check([activeRun, runRecap, runDetail, hrZones].every((source) => source.includes('ZONE_HEAT_PALETTE')), 'ActiveRun, recap helpers, RunDetailModal, and HR Zones derive from the canonical JS palette')
check(history.includes('resolveRunHeartRateZone') && runHub.includes('getPaceZone'), 'History and Run Hub consume canonical palette-backed helpers')
check(activeRun.includes('`${hrZone.color}22`') && activeRun.includes('...ZONE_HEAT_PALETTE[index]'), 'ActiveRun alpha template receives canonical raw hex')
check(runDetail.includes('`${zone.color}22`') && history.includes('`${heartRateZone.color}22`'), 'recap and History alpha templates consume helper-provided raw hex')
check(![activeRun, runRecap, runDetail, hrZones].some((source) => /color:\s*['"]var\(--z[1-5]\)/.test(source)), 'no JS zone color is a CSS-variable string that can corrupt alpha concatenation')

const paceInputs = [11, 10, 8, 7, 6]
check(paceInputs.every((pace, index) => getPaceZone(pace)?.color === expectedColors[index]), 'Run Hub pace-zone helper resolves the canonical five fills')
check(expectedColors.every((color, index) => {
  const seconds = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 }
  seconds[`z${index + 1}`] = 100
  return resolveRunHeartRateZone({ duration_seconds: 100, heart_rate_zones: seconds })?.color === color
}), 'run recap and History heart-rate helper resolves the canonical five fills')
check(resolveRunHeartRateZone({ duration_seconds: 100, heart_rate_zones: { z5: 100 } })?.textColor === '#B8A86A', 'Z5 uses readable text without changing its canonical fill')

console.log('\n== U9 premium upgrade surface ==')
check(['card', 'card-hero', 'num-ember', 't-title', 't-body', 't-micro', 'pressable'].every((className) => upgrade.includes(className)), 'Upgrade uses the Tempered Steel structural hierarchy')
check(upgrade.includes('Train with the full signal.') && upgrade.includes('Forged, not finished.'), 'Upgrade retains the intended restrained ember content hierarchy')
check(upgrade.includes('useProContext') && upgrade.includes('if (isPro)') && upgrade.includes('entitlementPresentation({ accessSource, paidTier })'), 'Upgrade remains driven by canonical entitlement truth')
check(upgrade.includes("subscriptionStatus === 'trialing'") && upgrade.includes('trialDaysLeft(trialEndsAt)'), 'trial presentation remains tied to real subscription metadata')
check(upgrade.includes('startStripeSubscription(selectedPlan)') && upgrade.includes('await refreshPro()'), 'selected billing plan and entitlement refresh hooks remain wired')
check(upgrade.includes("api.post('/comp/redeem'") && upgrade.includes("navigate(-1)"), 'beta/comp access and route-back behavior remain intact')
check(upgrade.includes('disabled={submitting}') && upgrade.includes('disabled={redeeming || !compCode.trim()}') && upgrade.includes('min-h-12'), 'billing controls preserve disabled states and mobile-sized targets')
check(!/(save|savings)\s+\d+%|\d+\s+(reviews|members|users)|rated\s+\d/i.test(upgrade), 'Upgrade contains no fabricated savings, reviews, or user counts')

console.log(`\nSIGNATURE CLOSURE SMOKE OK (${passed})`)
