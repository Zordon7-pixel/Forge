import { useEffect, useRef, useState } from 'react'
import { Brain, Maximize2, Minimize2, Minus, Plus, Zap } from 'lucide-react'
import WatchWorkoutSendButton from './WatchWorkoutSendButton'
import AiGuidanceNote from './AiGuidanceNote'

const TEXT_SCALES = [0.9, 1, 1.15, 1.3]

function GuidanceList({ title, items, fontSize }) {
  if (!Array.isArray(items) || items.length === 0) return null

  return (
    <section style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
      <h4 style={{ color: 'var(--text-primary)', fontSize, fontWeight: 900, margin: 0 }}>{title}</h4>
      <ol style={{ display: 'grid', gap: 8, margin: '10px 0 0', paddingLeft: 20, color: 'var(--text-muted)', fontSize, lineHeight: 1.5 }}>
        {items.map((item, index) => <li key={`${title}-${index}`}>{String(item)}</li>)}
      </ol>
    </section>
  )
}

export default function StrengthWorkoutRecommendation({
  plan,
  title,
  onStart,
  startLabel = 'Start Workout',
  startBusy = false,
  onRegenerate,
  watchWorkout,
}) {
  const [scaleIndex, setScaleIndex] = useState(1)
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef(null)
  const scale = TEXT_SCALES[scaleIndex]
  const px = (value) => `${Math.round(value * scale)}px`
  const exercises = Array.isArray(plan?.main) ? plan.main : []

  useEffect(() => {
    if (!expanded) return undefined
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setExpanded(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(containerRef.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    containerRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus?.()
    }
  }, [expanded])

  return (
    <div
      ref={containerRef}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? 'true' : undefined}
      aria-label={expanded ? `${title || 'Strength workout'} expanded` : undefined}
      tabIndex={expanded ? -1 : undefined}
      className="p-4"
      style={{
        position: expanded ? 'fixed' : 'relative',
        inset: expanded ? 0 : 'auto',
        zIndex: expanded ? 70 : 'auto',
        height: expanded ? '100dvh' : 'auto',
        overflowY: expanded ? 'auto' : 'visible',
        background: 'var(--bg-card)',
        color: 'var(--text-primary)',
        border: expanded ? 'none' : '1px solid var(--border-subtle)',
        borderRadius: expanded ? 0 : 8,
        paddingTop: expanded ? 'calc(env(safe-area-inset-top, 0px) + 16px)' : 16,
        paddingBottom: expanded ? 'calc(env(safe-area-inset-bottom, 0px) + 24px)' : 16,
      }}
    >
      <header className="flex items-start justify-between gap-3">
        <div style={{ minWidth: 0 }}>
          <div className="flex items-center gap-2" style={{ color: 'var(--accent)' }}>
            <Zap size={17} />
            <span style={{ fontSize: px(11), fontWeight: 950, textTransform: 'uppercase' }}>Strength + speed session</span>
          </div>
          <h3 style={{ color: 'var(--text-primary)', fontSize: px(22), lineHeight: 1.2, fontWeight: 950, margin: '8px 0 0' }}>
            {title || plan?.workoutName || 'Forged Hybrid Workout'}
          </h3>
        </div>

        <div className="flex shrink-0 items-center" style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
          <button
            type="button"
            onClick={() => setScaleIndex((value) => Math.max(0, value - 1))}
            disabled={scaleIndex === 0}
            aria-label="Make workout text smaller"
            title="Smaller text"
            style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: 'none', opacity: scaleIndex === 0 ? 0.4 : 1 }}
          >
            <Minus size={17} />
          </button>
          <span aria-live="polite" style={{ width: 44, textAlign: 'center', fontSize: 11, fontWeight: 900, color: 'var(--text-muted)' }}>
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScaleIndex((value) => Math.min(TEXT_SCALES.length - 1, value + 1))}
            disabled={scaleIndex === TEXT_SCALES.length - 1}
            aria-label="Make workout text larger"
            title="Larger text"
            style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: 'none', opacity: scaleIndex === TEXT_SCALES.length - 1 ? 0.4 : 1 }}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? 'Close expanded workout' : 'Expand workout'}
            title={expanded ? 'Close expanded view' : 'Expand workout'}
            style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--accent)', border: 'none', borderLeft: '1px solid var(--border-subtle)' }}
          >
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
        </div>
      </header>

      <section style={{ marginTop: 20 }}>
        <h4 style={{ color: 'var(--text-primary)', fontSize: px(17), fontWeight: 950, margin: 0 }}>Workout</h4>
        <div style={{ marginTop: 8 }}>
          {exercises.length === 0 && (
            <p role="status" style={{ color: 'var(--text-muted)', fontSize: px(14), lineHeight: 1.55, margin: '12px 0 0' }}>
              This plan does not include a detailed lift prescription. Choose AI Recommends or Manual to build a complete workout before starting.
            </p>
          )}
          {exercises.map((exercise, index) => (
            <article
              key={`${exercise?.name || 'exercise'}-${index}`}
              style={{ padding: '14px 0', borderBottom: index === exercises.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-start gap-3">
                <span style={{ width: 28, height: 28, flex: '0 0 28px', display: 'grid', placeItems: 'center', borderRadius: '50%', background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 12, fontWeight: 950 }}>
                  {index + 1}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h5 style={{ color: 'var(--text-primary)', fontSize: px(18), lineHeight: 1.3, fontWeight: 900, margin: 0 }}>{exercise?.name || 'Exercise'}</h5>
                    {exercise?.focus && (
                      <span style={{ color: 'var(--success)', fontSize: px(11), fontWeight: 900, textTransform: 'uppercase' }}>{exercise.focus}</span>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2" style={{ color: 'var(--text-muted)' }}>
                    <span style={{ fontSize: px(12) }}>Sets<br /><strong style={{ color: 'var(--text-primary)', fontSize: px(17) }}>{exercise?.sets || '-'}</strong></span>
                    <span style={{ fontSize: px(12) }}>Reps<br /><strong style={{ color: 'var(--text-primary)', fontSize: px(17) }}>{exercise?.reps || '-'}</strong></span>
                    <span style={{ fontSize: px(12) }}>Rest<br /><strong style={{ color: 'var(--text-primary)', fontSize: px(17) }}>{exercise?.rest || '-'}</strong></span>
                  </div>
                  {exercise?.cue && <p style={{ color: 'var(--text-muted)', fontSize: px(14), lineHeight: 1.5, margin: '10px 0 0' }}>{exercise.cue}</p>}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <div style={{ display: 'grid', gap: 16, marginTop: 8 }}>
        <GuidanceList title="Warm-up" items={plan?.warmup} fontSize={px(15)} />
        <GuidanceList title="Recovery" items={plan?.recovery} fontSize={px(15)} />
      </div>

      {(plan?.explanation || plan?.restExplanation) && (
        <section style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 18, paddingTop: 16 }}>
          <div className="flex items-center gap-2">
            <Brain size={18} color="var(--accent)" />
            <h4 style={{ color: 'var(--text-primary)', fontSize: px(16), fontWeight: 950, margin: 0 }}>Why this workout</h4>
          </div>
          {plan?.explanation && <p style={{ color: 'var(--text-muted)', fontSize: px(14), lineHeight: 1.55, margin: '10px 0 0' }}>{plan.explanation}</p>}
          {plan?.restExplanation && <p style={{ color: 'var(--text-muted)', fontSize: px(13), lineHeight: 1.5, margin: '8px 0 0' }}><strong style={{ color: 'var(--text-primary)' }}>Rest guidance:</strong> {plan.restExplanation}</p>}
          <AiGuidanceNote />
        </section>
      )}

      <div className={onRegenerate ? 'mt-5 grid grid-cols-2 gap-2' : 'mt-5'}>
        <button
          type="button"
          onClick={onStart}
          disabled={startBusy || exercises.length === 0}
          className="w-full py-4 font-black disabled:opacity-60"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 8, fontSize: px(16) }}
        >
          {startBusy ? 'Starting...' : startLabel}
        </button>
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={startBusy}
            className="w-full py-4 font-black disabled:opacity-60"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8, fontSize: px(15) }}
          >
            Regenerate
          </button>
        )}
      </div>

      {exercises.length > 0 && <WatchWorkoutSendButton workout={watchWorkout} className="mt-3" />}
    </div>
  )
}
