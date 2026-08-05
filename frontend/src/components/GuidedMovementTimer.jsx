import { useEffect, useReducer, useRef } from 'react'
import {
  createStretchTimerState,
  formatTimerClock,
  stretchSideLabel,
  stretchTimerReducer,
  TIMER_ACTION,
  TIMER_PHASE,
  timerAriaMessage,
} from '../lib/stretchTimer'

export const STRETCH_SAFETY_NOTE = 'Move in a controlled, pain-free range. Stop for sharp pain, numbness, instability, or a change in your stride.'

const BUTTON_STYLE = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 12,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 800,
  minHeight: 44,
  minWidth: 0,
  padding: '10px 8px',
}

const VISUALLY_HIDDEN_STYLE = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: 1,
  margin: -1,
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: 1,
}

export default function GuidedMovementTimer({
  movement,
  movementKey,
  onComplete,
  onSkip,
  onPrevious,
  onSideChange,
  canPrevious = true,
  skipLabel = 'Skip',
}) {
  const [state, dispatch] = useReducer(
    stretchTimerReducer,
    null,
    () => createStretchTimerState(movement, movementKey),
  )
  const completionNotifiedRef = useRef(false)

  useEffect(() => {
    completionNotifiedRef.current = false
    dispatch({ type: TIMER_ACTION.RESET, stretch: movement, movementKey })
  }, [movement, movementKey])

  useEffect(() => {
    if (state.phase !== TIMER_PHASE.RUNNING && state.phase !== TIMER_PHASE.SWITCHING) return undefined
    const intervalId = window.setInterval(() => {
      dispatch({ type: TIMER_ACTION.TICK })
    }, 1000)
    return () => window.clearInterval(intervalId)
  }, [state.phase])

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.visibilityState === 'hidden') dispatch({ type: TIMER_ACTION.PAUSE })
    }
    document.addEventListener('visibilitychange', pauseWhenHidden)
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden)
  }, [])

  useEffect(() => {
    onSideChange?.(state.sideIndex)
  }, [onSideChange, state.sideIndex])

  useEffect(() => {
    if (
      state.movementKey !== String(movementKey)
      || state.phase !== TIMER_PHASE.COMPLETE
      || state.completionCount !== 1
      || completionNotifiedRef.current
    ) return
    completionNotifiedRef.current = true
    onComplete?.()
  }, [movementKey, onComplete, state.completionCount, state.movementKey, state.phase])

  const isSwitching = state.phase === TIMER_PHASE.SWITCHING
    || (state.phase === TIMER_PHASE.PAUSED && state.resumePhase === TIMER_PHASE.SWITCHING)
  const displaySeconds = isSwitching ? state.switchRemaining : state.remaining
  const clock = formatTimerClock(displaySeconds)
  const sideLabel = stretchSideLabel(movement, state.sideIndex)
  const isActive = state.phase === TIMER_PHASE.RUNNING || state.phase === TIMER_PHASE.SWITCHING
  const isComplete = state.phase === TIMER_PHASE.COMPLETE
  const primaryLabel = state.phase === TIMER_PHASE.READY
    ? 'Start'
    : (state.phase === TIMER_PHASE.PAUSED ? 'Resume' : 'Pause')
  const statusLabel = isSwitching
    ? 'SWITCH SIDES'
    : (state.phase === TIMER_PHASE.READY
      ? 'READY'
      : (state.phase === TIMER_PHASE.PAUSED
        ? 'PAUSED'
        : (state.phase === TIMER_PHASE.COMPLETE ? 'COMPLETE' : 'IN PROGRESS')))

  const handlePrimary = () => {
    dispatch({ type: isActive ? TIMER_ACTION.PAUSE : TIMER_ACTION.START })
  }

  const handlePrevious = () => {
    if (isComplete) return
    dispatch({ type: TIMER_ACTION.CANCEL })
    onPrevious?.()
  }

  const handleSkip = () => {
    if (isComplete) return
    dispatch({ type: TIMER_ACTION.CANCEL })
    onSkip?.()
  }

  return (
    <>
      <section
        aria-label="Guided movement timer"
        style={{
          alignItems: 'center',
          display: 'flex',
          flexDirection: 'column',
          margin: '24px auto',
          maxWidth: 480,
          width: '100%',
        }}
      >
        <p style={{ color: isSwitching ? 'var(--warning, #eab308)' : 'var(--text-muted)', fontSize: 12, fontWeight: 900, letterSpacing: '0.12em', margin: 0 }}>
          {statusLabel}
        </p>
        {sideLabel && !isSwitching && (
          <p style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 800, margin: '6px 0 0' }}>
            {sideLabel}
          </p>
        )}
        {isSwitching && (
          <p style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 800, margin: '6px 0 0' }}>
            Right side next
          </p>
        )}
        <p
          aria-label={'Countdown ' + clock}
          style={{
            color: displaySeconds <= 5 ? 'var(--warning, #eab308)' : 'var(--accent)',
            fontSize: '4.5rem',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 900,
            letterSpacing: 0,
            lineHeight: 1,
            margin: '10px 0 0',
            maxWidth: '100%',
          }}
        >
          {clock}
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '12px 0 0', maxWidth: 420, padding: '0 8px', textAlign: 'center' }}>
          {STRETCH_SAFETY_NOTE}
        </p>
        <div aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN_STYLE}>
          {timerAriaMessage(state)}
        </div>
      </section>

      <div
        data-testid="guided-timer-action-bar"
        style={{
          background: 'var(--bg-base)',
          borderTop: '1px solid var(--border-subtle)',
          bottom: 'var(--app-bottom-nav-height, calc(59px + env(safe-area-inset-bottom, 0px)))',
          boxSizing: 'border-box',
          left: 0,
          padding: '10px 12px',
          position: 'fixed',
          right: 0,
          zIndex: 25,
        }}
      >
        <div style={{ display: 'grid', gap: 8, margin: '0 auto', maxWidth: 480, minWidth: 0, width: '100%' }}>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', minWidth: 0 }}>
            <button
              type="button"
              onClick={handlePrimary}
              disabled={isComplete}
              style={{
                ...BUTTON_STYLE,
                background: 'var(--accent)',
                borderColor: 'var(--accent)',
                color: 'var(--on-accent)',
                opacity: isComplete ? 0.55 : 1,
              }}
            >
              {primaryLabel}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: TIMER_ACTION.RESTART })}
              disabled={isComplete}
              style={{ ...BUTTON_STYLE, background: 'var(--bg-input)', color: 'var(--text-primary)', opacity: isComplete ? 0.5 : 1 }}
            >
              Restart
            </button>
          </div>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', minWidth: 0 }}>
            <button
              type="button"
              onClick={handlePrevious}
              disabled={isComplete || !canPrevious || !onPrevious}
              style={{
                ...BUTTON_STYLE,
                background: 'var(--bg-card)',
                color: 'var(--text-muted)',
                cursor: isComplete || !canPrevious || !onPrevious ? 'not-allowed' : 'pointer',
                opacity: isComplete || !canPrevious || !onPrevious ? 0.5 : 1,
              }}
            >
              Previous
            </button>
            <button
              type="button"
              onClick={handleSkip}
              disabled={isComplete || !onSkip}
              style={{ ...BUTTON_STYLE, background: 'var(--accent-dim)', color: 'var(--accent)', opacity: isComplete || !onSkip ? 0.5 : 1 }}
            >
              {skipLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
