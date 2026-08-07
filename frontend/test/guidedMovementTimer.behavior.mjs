import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { preRunStretches } from '../src/data/stretches.js'
import {
  createStretchTimerState,
  formatTimerClock,
  isTimePrescribedMovement,
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

const restartedSwitch = reduce(state, TIMER_ACTION.RESTART)
assert.equal(restartedSwitch.phase, TIMER_PHASE.READY, 'restart during the switch returns to ready')
assert.equal(restartedSwitch.sideIndex, 0, 'restart during the switch returns to the left side')
assert.equal(restartedSwitch.remaining, 5, 'restart during the switch restores the full duration')

const cancelledSwitch = reduce(state, TIMER_ACTION.CANCEL)
assert.equal(cancelledSwitch.phase, TIMER_PHASE.READY, 'navigation cancels a pending switch transition')
assert.equal(reduce(cancelledSwitch, TIMER_ACTION.TICK).switchRemaining, 3, 'cancelled transitions cannot keep ticking')

state = tick(state, 3)
assert.equal(state.phase, TIMER_PHASE.RUNNING, 'three-second switch resumes on the right')
assert.equal(state.remaining, 5, 'right side starts with the full duration')
const restartedRight = reduce(state, TIMER_ACTION.RESTART)
assert.equal(restartedRight.phase, TIMER_PHASE.READY, 'restart on the right returns to ready')
assert.equal(restartedRight.sideIndex, 0, 'restart on the right returns to the left side')
assert.equal(restartedRight.remaining, 5, 'restart on the right restores the full left-side duration')
state = tick(state, 5)
assert.equal(state.phase, TIMER_PHASE.COMPLETE, 'right side completes the unilateral hold')
assert.equal(state.completionCount, 1)

const reset = stretchTimerReducer(cancelledSwitch, { type: TIMER_ACTION.RESET, stretch: move, movementKey: 'next' })
assert.equal(reset.movementKey, 'next', 'Skip or Previous movement changes reset timer identity')
assert.equal(reset.sideIndex, 0)
assert.equal(reset.phase, TIMER_PHASE.READY)
assert.equal(formatTimerClock(125), '02:05', 'all countdowns use MM:SS formatting')

assert.equal(isTimePrescribedMovement({ duration: 30, reps: '30 seconds', durationLabel: '30 sec' }), true, 'an explicit timed prescription receives a countdown')
assert.equal(isTimePrescribedMovement({ duration: 30, reps: '10 each side', durationLabel: '30 sec · 10 each side' }), false, 'a display duration cannot turn a rep prescription into a countdown')
assert.equal(isTimePrescribedMovement({ duration: 30, reps: '20 reps', durationLabel: '30 sec · 20 reps' }), false, 'rep-only movements remain manual')
assert.equal(isTimePrescribedMovement({ duration: 0, reps: '30 seconds' }), false, 'a timed label without a positive numeric duration is ineligible')
assert.equal(isTimePrescribedMovement({ duration: Number.NaN, reps: '30 seconds' }), false, 'an invalid duration is ineligible')
assert.equal(isTimePrescribedMovement(preRunStretches.find((movement) => movement.id === 'butt-kicks')), true, 'Butt Kicks receives its prescribed 30-second countdown')
assert.equal(isTimePrescribedMovement(preRunStretches.find((movement) => movement.id === 'leg-swings')), false, 'Leg Swings remains a manual rep movement despite its display estimate')

const warmupSource = readFileSync(new URL('../src/pages/Warmup.jsx', import.meta.url), 'utf8')
assert.match(warmupSource, /isTimePrescribedMovement\(step\)/, 'warm-up applies the explicit timed-vs-rep eligibility rule')
assert.match(warmupSource, /TIMER_ACTION\.RESET/, 'changing warm-up steps resets the countdown state')
assert.match(warmupSource, /window\.setInterval[\s\S]*window\.clearInterval/, 'warm-up timer owns strict-mode-safe interval cleanup')
assert.match(warmupSource, /primaryLabel[\s\S]{0,160}'Resume'[\s\S]{0,80}'Pause'[\s\S]{0,80}'Start'/, 'timed warm-up exposes explicit Start, Pause, and Resume states')
assert.match(warmupSource, />\s*Restart\s*</, 'timed warm-up exposes Restart')
assert.match(warmupSource, /Movement complete/, 'zero has a clear completion state')
assert.doesNotMatch(warmupSource, /completionCount[\s\S]{0,160}onNext/, 'timer completion never auto-navigates the warm-up')

console.log('GUIDED MOVEMENT TIMER BEHAVIOR OK')
