import assert from 'node:assert/strict'
import {
  createStretchTimerState,
  formatTimerClock,
  stretchTimerReducer,
  TIMER_ACTION,
  TIMER_PHASE,
} from '../src/lib/stretchTimer.js'

const move = { id: 'alternating', duration: 5, type: 'dynamic', sideMode: 'alternating' }
const reduce = (state, type) => stretchTimerReducer(state, { type })
const tick = (initial, count) => Array.from({ length: count }).reduce(value => reduce(value, TIMER_ACTION.TICK), initial)

let state = createStretchTimerState(move, move.id)
assert.equal(state.phase, TIMER_PHASE.READY)
assert.equal(state.remaining, 5)
assert.equal(formatTimerClock(state.remaining), '00:05')
assert.deepEqual(reduce(state, TIMER_ACTION.TICK), state, 'ready state must not consume time')

state = reduce(state, TIMER_ACTION.START)
state = reduce(state, TIMER_ACTION.TICK)
assert.equal(state.remaining, 4, 'running timer decrements once per tick')
state = reduce(state, TIMER_ACTION.PAUSE)
assert.equal(reduce(state, TIMER_ACTION.TICK).remaining, 4, 'paused timer freezes')
state = reduce(state, TIMER_ACTION.START)
assert.equal(reduce(state, TIMER_ACTION.TICK).remaining, 3, 'resume continues the same timer')
state = reduce(state, TIMER_ACTION.RESTART)
assert.equal(state.remaining, 5, 'restart restores the current block duration')
assert.equal(state.phase, TIMER_PHASE.READY, 'restart returns to a safe ready state')

state = tick(reduce(createStretchTimerState(move, move.id), TIMER_ACTION.START), 5)
assert.equal(state.phase, TIMER_PHASE.COMPLETE, 'dynamic alternating movement is one timed block')
assert.equal(state.remaining, 0, 'completed countdown stops at zero')
assert.equal(state.completionCount, 1, 'completion emits exactly once')
state = tick(state, 3)
assert.equal(state.remaining, 0, 'completed countdown never becomes negative')
assert.equal(state.completionCount, 1, 'extra ticks cannot emit duplicate completion')

const hold = { id: 'hold', duration: 5, type: 'static', sideMode: 'each-side' }
state = tick(reduce(createStretchTimerState(hold, hold.id), TIMER_ACTION.START), 5)
assert.equal(state.phase, TIMER_PHASE.SWITCHING)
assert.equal(state.sideIndex, 1, 'left side advances to the right-side transition')
assert.equal(state.switchRemaining, 3, 'side transition begins at three seconds')
assert.equal(state.remaining, 5, 'right side retains its full movement duration')

let pausedSwitch = reduce(state, TIMER_ACTION.PAUSE)
pausedSwitch = tick(pausedSwitch, 2)
assert.equal(pausedSwitch.switchRemaining, 3, 'pause freezes the switch transition')
pausedSwitch = reduce(pausedSwitch, TIMER_ACTION.START)
assert.equal(tick(pausedSwitch, 3).phase, TIMER_PHASE.RUNNING, 'resume completes exactly three switch ticks')

const cancelledSwitch = reduce(state, TIMER_ACTION.CANCEL)
assert.equal(cancelledSwitch.phase, TIMER_PHASE.READY, 'navigation cancels a pending switch transition')
assert.equal(reduce(cancelledSwitch, TIMER_ACTION.TICK).switchRemaining, 3, 'cancelled transitions cannot keep ticking')

state = tick(state, 3)
assert.equal(state.phase, TIMER_PHASE.RUNNING, 'three-second switch resumes on the right')
assert.equal(state.remaining, 5, 'right side starts with the full duration')
state = tick(state, 5)
assert.equal(state.phase, TIMER_PHASE.COMPLETE, 'right side completes the unilateral hold')
assert.equal(state.completionCount, 1)

const reset = stretchTimerReducer(cancelledSwitch, { type: TIMER_ACTION.RESET, stretch: move, movementKey: 'next' })
assert.equal(reset.movementKey, 'next', 'Skip or Previous movement changes reset timer identity')
assert.equal(reset.sideIndex, 0)
assert.equal(reset.phase, TIMER_PHASE.READY)
assert.equal(formatTimerClock(125), '02:05', 'all countdowns use MM:SS formatting')

console.log('GUIDED MOVEMENT TIMER BEHAVIOR OK')
