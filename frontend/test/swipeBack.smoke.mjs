import assert from 'node:assert/strict'
import {
  isCompletedSwipeBack,
  isSwipeBackRouteEnabled,
  isSwipeBackUnsafeSessionStatus,
} from '../src/lib/swipeBack.js'

assert.equal(isSwipeBackRouteEnabled('/history'), true)
assert.equal(isSwipeBackRouteEnabled('/'), false)
assert.equal(isSwipeBackRouteEnabled('/run/active'), false)
assert.equal(isSwipeBackRouteEnabled('/workout/active/session-1'), false)

const valid = { startX: 12, startY: 300, endX: 112, endY: 315, elapsedMs: 420 }
assert.equal(isCompletedSwipeBack(valid), true)
assert.equal(isCompletedSwipeBack({ ...valid, startX: 45 }), false, 'gesture must begin at the left edge')
assert.equal(isCompletedSwipeBack({ ...valid, endX: 60 }), false, 'short drags must not navigate')
assert.equal(isCompletedSwipeBack({ ...valid, endY: 400 }), false, 'vertical drags must not navigate')
assert.equal(isCompletedSwipeBack({ ...valid, elapsedMs: 1500 }), false, 'slow drags must not navigate')
assert.equal(isCompletedSwipeBack({ ...valid, endX: 102, endY: 360 }), true, 'an exact 1.5x horizontal gesture must navigate')

assert.equal(isSwipeBackUnsafeSessionStatus('idle'), false)
assert.equal(isSwipeBackUnsafeSessionStatus('running'), true)
assert.equal(isSwipeBackUnsafeSessionStatus('paused'), true)
assert.equal(isSwipeBackUnsafeSessionStatus('done'), true, 'completed but unsaved treadmill data must remain protected')

console.log('SWIPE BACK SMOKE OK')
