import assert from 'node:assert/strict'
import {
  resolveReadiness,
  resolveRecoveryState,
} from '../src/lib/truthConsistency.js'

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

const missing = resolveReadiness({ available: false, score: null })
const missingTodayCopy = `${missing.sentencePrefix}Rest and recovery are scheduled today.`
check(missing.available === false && missing.score === null, 'unavailable null readiness stays unavailable')
check(missing.display === '--', 'unavailable readiness renders a placeholder')
check(!missingTodayCopy.includes('Readiness 0'), 'unavailable readiness never produces the Today Readiness 0 sentence')

const realZero = resolveReadiness({ available: true, score: 0 })
check(realZero.available === true && realZero.score === 0, 'available numeric zero is preserved')
check(realZero.display === '0' && realZero.sentencePrefix === 'Readiness 0. ', 'available zero renders as a real score')

const normal = resolveReadiness({ available: true, score: 82 })
check(normal.available === true && normal.display === '82', 'normal finite readiness renders correctly')
check(normal.sentencePrefix === 'Readiness 82. ', 'normal finite readiness produces consistent Today copy')

for (const invalidScore of [null, undefined, '', false, '0', Number.NaN, Number.POSITIVE_INFINITY, 'not-a-score']) {
  const invalid = resolveReadiness({ available: true, score: invalidScore })
  check(invalid.available === false && invalid.display === '--' && invalid.sentencePrefix === '', `invalid readiness ${String(invalidScore)} fails closed`)
}

const comeback = resolveRecoveryState({
  injury_status: 'recovering',
  comeback_mode: 1,
  injury_mode: false,
})
check(comeback.kind === 'comeback' && comeback.protected, 'recovering comeback athlete has effective protection')
check(comeback.label !== 'Off' && comeback.activeInjuryMode === false, 'comeback is truthful without becoming active injury mode')

const active = resolveRecoveryState({ injury_mode: true, comeback_mode: 0, injury_status: 'none' })
check(active.kind === 'active' && active.protected && active.label === 'Active injury protection', 'active injury mode shows active protection')

for (const healthyProfile of [
  {},
  { injury_status: 'none', comeback_mode: 0, injury_mode: false },
  { injury_status: 'resolved', injury_detail: 'old ankle injury', comeback_mode: 0, injury_mode: false },
]) {
  const healthy = resolveRecoveryState(healthyProfile)
  check(healthy.kind === 'off' && !healthy.protected && !healthy.activeInjuryMode, 'healthy or resolved profile remains off')
}

console.log(`TRUTH CONSISTENCY SMOKE OK (${passed})`)
