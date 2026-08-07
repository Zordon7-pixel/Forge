const EACH_SIDE_PATTERN = /\b(?:each|per)\s+(?:side|leg|arm)\b/i
const HOLD_PATTERN = /\bhold\b/i
const TIME_PRESCRIPTION_PATTERN = /\b\d+(?:\.\d+)?\s*(?:s|secs?|seconds?|m|mins?|minutes?)\b/i

export const SWITCH_SIDE_SECONDS = 3

export const TIMER_PHASE = Object.freeze({
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  SWITCHING: 'switching',
  COMPLETE: 'complete',
})

export const TIMER_ACTION = Object.freeze({
  START: 'start',
  PAUSE: 'pause',
  RESTART: 'restart',
  TICK: 'tick',
  RESET: 'reset',
  CANCEL: 'cancel',
})

function boundedDuration(value, fallback = 30) {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed) || parsed < 5 || parsed > 180) return fallback
  return parsed
}

export function stretchTimerSeconds(stretch = {}) {
  const text = `${stretch.reps || ''} ${stretch.durationLabel || ''}`
  const holdMatch = text.match(/\bhold\s*(\d{1,3})\s*(?:s|sec|seconds?)\b/i)
    || text.match(/\b(\d{1,3})\s*(?:s|sec|seconds?)\s*(?:each|per)\s+(?:side|leg|arm)\b/i)
  return boundedDuration(holdMatch?.[1] ?? stretch.duration)
}

// A catalog display label may include an estimated duration alongside a rep
// prescription. Only the athlete-facing prescription makes a warm-up timed.
export function isTimePrescribedMovement(stretch = {}) {
  const duration = Number(stretch.duration)
  return Number.isFinite(duration)
    && duration > 0
    && TIME_PRESCRIPTION_PATTERN.test(String(stretch.reps || ''))
}

export function stretchSideCount(stretch = {}) {
  if (stretch.sideMode === 'each-side') return 2
  if (stretch.sideMode === 'alternating' || stretch.sideMode === 'bilateral') return 1
  if (Number(stretch.sides) === 2) return 2

  const text = `${stretch.reps || ''} ${stretch.durationLabel || ''}`
  const isTimedHold = HOLD_PATTERN.test(text) || String(stretch.type || '').toLowerCase() === 'static'
  return isTimedHold && EACH_SIDE_PATTERN.test(text) ? 2 : 1
}

export function stretchSideLabel(stretch, sideIndex = 0) {
  if (stretchSideCount(stretch) !== 2) return ''
  return sideIndex === 0 ? 'Left side' : 'Right side'
}

export function formatTimerClock(value) {
  const seconds = Math.max(0, Math.trunc(Number(value) || 0))
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
}

export function createStretchTimerState(stretch = {}, movementKey = '') {
  const duration = stretchTimerSeconds(stretch)
  return {
    movementKey: String(movementKey),
    duration,
    remaining: duration,
    sideCount: stretchSideCount(stretch),
    sideIndex: 0,
    switchRemaining: SWITCH_SIDE_SECONDS,
    phase: TIMER_PHASE.READY,
    resumePhase: TIMER_PHASE.RUNNING,
    completionCount: 0,
  }
}

export function stretchTimerReducer(state, action = {}) {
  switch (action.type) {
    case TIMER_ACTION.RESET:
      return createStretchTimerState(action.stretch, action.movementKey)

    case TIMER_ACTION.START:
      if (state.phase === TIMER_PHASE.READY) {
        return { ...state, phase: TIMER_PHASE.RUNNING, resumePhase: TIMER_PHASE.RUNNING }
      }
      if (state.phase === TIMER_PHASE.PAUSED) {
        return { ...state, phase: state.resumePhase, resumePhase: TIMER_PHASE.RUNNING }
      }
      return state

    case TIMER_ACTION.PAUSE:
      if (state.phase !== TIMER_PHASE.RUNNING && state.phase !== TIMER_PHASE.SWITCHING) return state
      return { ...state, phase: TIMER_PHASE.PAUSED, resumePhase: state.phase }

    case TIMER_ACTION.RESTART:
      return {
        ...state,
        remaining: state.duration,
        sideIndex: 0,
        switchRemaining: SWITCH_SIDE_SECONDS,
        phase: TIMER_PHASE.READY,
        resumePhase: TIMER_PHASE.RUNNING,
        completionCount: 0,
      }

    case TIMER_ACTION.CANCEL:
      return {
        ...state,
        phase: TIMER_PHASE.READY,
        resumePhase: TIMER_PHASE.RUNNING,
        completionCount: 0,
      }

    case TIMER_ACTION.TICK:
      if (state.phase === TIMER_PHASE.SWITCHING) {
        if (state.switchRemaining > 1) {
          return { ...state, switchRemaining: state.switchRemaining - 1 }
        }
        return {
          ...state,
          remaining: state.duration,
          switchRemaining: SWITCH_SIDE_SECONDS,
          phase: TIMER_PHASE.RUNNING,
          resumePhase: TIMER_PHASE.RUNNING,
        }
      }

      if (state.phase !== TIMER_PHASE.RUNNING) return state
      if (state.remaining > 1) return { ...state, remaining: state.remaining - 1 }

      if (state.sideCount === 2 && state.sideIndex === 0) {
        return {
          ...state,
          remaining: state.duration,
          sideIndex: 1,
          switchRemaining: SWITCH_SIDE_SECONDS,
          phase: TIMER_PHASE.SWITCHING,
          resumePhase: TIMER_PHASE.SWITCHING,
        }
      }

      return {
        ...state,
        remaining: 0,
        phase: TIMER_PHASE.COMPLETE,
        resumePhase: TIMER_PHASE.RUNNING,
        completionCount: state.completionCount + 1,
      }

    default:
      return state
  }
}

export function timerAriaMessage(state) {
  const side = state.sideCount === 2 ? (state.sideIndex === 0 ? 'Left side. ' : 'Right side. ') : ''
  if (state.phase === TIMER_PHASE.READY) {
    return 'Timer ready. ' + side + formatTimerClock(state.remaining) + '. Press Start.'
  }
  if (state.phase === TIMER_PHASE.PAUSED) {
    return state.resumePhase === TIMER_PHASE.SWITCHING
      ? 'Timer paused during the switch-sides transition.'
      : 'Timer paused. ' + side + formatTimerClock(state.remaining) + ' remaining.'
  }
  if (state.phase === TIMER_PHASE.SWITCHING) return 'Switch sides. Right side starts in three seconds.'
  if (state.phase === TIMER_PHASE.COMPLETE) return 'Movement complete.'
  return side + 'Timer running.'
}
