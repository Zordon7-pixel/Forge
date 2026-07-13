import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Footprints, Dumbbell, Moon, Timer, Gauge, Route, Flame, Brain,
  Maximize2, Minimize2, Minus, Plus, ChevronLeft, CheckCircle2, Circle,
} from 'lucide-react'
import WatchWorkoutSendButton from '../WatchWorkoutSendButton'
import WatchWorkoutService from '../../services/WatchWorkoutService'
import { sessionState } from '../../lib/planCalendar'
import './forgedCalendar.css'

const TEXT_SCALES = [0.9, 1, 1.15, 1.3]

// Defensive readers — never invent values that are not present in the plan.
function str(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}
function labelText(value) {
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
function displayValue(value) {
  const scalar = str(value)
  if (scalar) return scalar
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ')
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => {
        const itemText = displayValue(item)
        return itemText ? `${labelText(key)}: ${itemText}` : ''
      })
      .filter(Boolean)
      .join(' · ')
  }
  return ''
}
function list(value) {
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean)
  const single = displayValue(value)
  return single ? [single] : []
}
function structuredList(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return list(value)
  return Object.entries(value).flatMap(([key, item]) => {
    const valueText = displayValue(item)
    return valueText ? [`${labelText(key)}: ${valueText}`] : []
  })
}
function firstStr(...values) {
  for (const value of values) {
    const s = str(value)
    if (s) return s
  }
  return ''
}

function runFacts(session) {
  const p = session.prescription || {}
  const raw = session.raw || {}
  const miles = Number(session.distanceMiles || p.distanceMiles || p.distance_miles || raw.distance_miles || 0)
  const durationMinutes = firstStr(p.duration_min, raw.duration_min)
  return {
    purpose: firstStr(p.purpose, p.focus, raw.purpose),
    distance: miles > 0 ? `${miles.toFixed(1)} mi` : '',
    time: firstStr(p.duration, p.time, raw.duration, durationMinutes ? `${durationMinutes} min` : ''),
    pace: firstStr(p.pace, p.targetPace, p.pace_target, raw.pace, raw.pace_target),
    zone: firstStr(p.zone, p.hrZone, p.heartRateZone, p.target_zone, raw.zone, raw.target_zone),
    intensity: firstStr(p.intensity, raw.intensity),
    warmup: list(p.warmup || raw.warmup),
    steps: structuredList(p.steps || p.blocks || p.structure || raw.steps || raw.structure),
    cooldown: list(p.cooldown || raw.cooldown),
    recoveries: firstStr(p.recoveries, p.recovery),
  }
}

function liftFacts(session) {
  const p = session.prescription || {}
  const raw = session.raw || {}
  const exercises = Array.isArray(p.exercises) ? p.exercises
    : Array.isArray(p.main) ? p.main
    : Array.isArray(raw.exercises) ? raw.exercises
    : Array.isArray(raw.main) ? raw.main : []
  return {
    focus: firstStr(p.focus, raw.focus),
    warmup: list(p.warmup || raw.warmup),
    recovery: list(p.recovery || raw.recovery),
    exercises: exercises.map((ex) => ({
      name: firstStr(ex.name, ex.exercise, 'Exercise'),
      sets: firstStr(ex.sets),
      reps: firstStr(ex.reps),
      rest: firstStr(ex.rest),
      load: firstStr(ex.load, ex.weight, ex.targetLoad),
      rpe: firstStr(ex.rpe, ex.RPE, ex.rir, ex.RIR),
      cue: firstStr(ex.cue, ex.formCue, ex.notes),
      exFocus: firstStr(ex.focus),
    })),
  }
}

function PaperSection({ title, tone, icon, children, px }) {
  const toneClass = tone === 'green' ? 'forged-sec-green' : tone === 'red' ? 'forged-sec-red' : tone === 'run' ? 'forged-sec-run' : ''
  return (
    <section style={{ marginTop: 18 }}>
      <div className="flex items-center gap-2">
        {icon}
        <h4 className={`forged-hand ${toneClass}`} style={{ fontSize: px(19), fontWeight: 700 }}>{title}</h4>
      </div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </section>
  )
}

export default function ForgedDayView({
  day,
  planContext = {},
  completedSet,
  onToggleComplete,
  onStartRun,
  onStartLift,
  onBack,
  updating = false,
}) {
  const [scaleIndex, setScaleIndex] = useState(1)
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef(null)
  const scale = TEXT_SCALES[scaleIndex]
  const px = (value) => `${Math.round(value * scale)}px`
  const rulePx = `${Math.round(30 * scale)}px`

  const sessions = day?.sessions || []
  const runSession = sessions.find((s) => s.kind === 'run') || null
  const liftSession = sessions.find((s) => s.kind === 'lift') || null
  const isRest = !day || day.isRest

  const dateLabel = useMemo(() => {
    if (!day?.date) return day?.dayLabel || ''
    return day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
  }, [day])

  useEffect(() => {
    if (!expanded) return undefined
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') { setExpanded(false); return }
      if (event.key !== 'Tab') return
      const focusable = Array.from(containerRef.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
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

  const whyToday = firstStr(day?.whyToday, runSession?.prescription?.explanation, liftSession?.prescription?.explanation)
  const recovery = firstStr(day?.recovery, runSession?.prescription?.recovery, liftSession?.prescription?.recovery)
  const orderGuidance = firstStr(day?.orderGuidance)

  const renderRun = () => {
    if (!runSession) return null
    const f = runFacts(runSession)
    const done = completedSet?.has(String(runSession.id))
    const watchWorkout = WatchWorkoutService.buildRunWorkout({
      day: dateLabel,
      typeLabel: runSession.title,
      distanceLabel: f.distance,
      pace: f.pace || undefined,
      zone: f.zone || undefined,
      intensity: f.intensity || undefined,
      steps: f.steps,
      progression: firstStr(runSession.prescription?.progression, runSession.raw?.progression),
      description: firstStr(runSession.prescription?.description, runSession.raw?.description),
    })
    const zoneLabel = /^\d+$/.test(f.zone) ? `Zone ${f.zone}` : f.zone
    return (
      <PaperSection title={firstStr(runSession.title, 'Run')} tone="run" px={px}
        icon={<span className="forged-stamp forged-stamp--run" data-state={sessionState(runSession, completedSet)}><Footprints size={16} /></span>}>
        {f.purpose && <p className="forged-hand" style={{ fontSize: px(15), margin: '0 0 8px' }}>{f.purpose}</p>}
        <div className="forged-paper-metric" style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          {f.distance && <span style={{ fontSize: px(13) }}><Route size={13} style={{ verticalAlign: -1 }} /> {f.distance}</span>}
          {f.time && <span style={{ fontSize: px(13) }}><Timer size={13} style={{ verticalAlign: -1 }} /> {f.time}</span>}
          {f.pace && <span style={{ fontSize: px(13) }}><Gauge size={13} style={{ verticalAlign: -1 }} /> {f.pace}</span>}
          {f.zone && <span style={{ fontSize: px(13) }}>{zoneLabel}</span>}
          {f.intensity && <span className="forged-sec-red" style={{ fontSize: px(13) }}><Flame size={13} style={{ verticalAlign: -1 }} /> {f.intensity}</span>}
        </div>
        {f.warmup.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p className="forged-hand forged-sec-green" style={{ fontSize: px(14), margin: 0 }}>Warm-up</p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.warmup.map((it, i) => <li key={`wu-${i}`}>{it}</li>)}</ul>
          </div>
        )}
        {f.steps.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p style={{ fontSize: px(13), fontWeight: 700, margin: 0 }}>Structure</p>
            <ol style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.steps.map((it, i) => <li key={`st-${i}`}>{it}</li>)}</ol>
          </div>
        )}
        {f.recoveries && <p style={{ fontSize: px(12), marginTop: 8 }}>Recoveries: {f.recoveries}</p>}
        {f.cooldown.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p className="forged-hand forged-sec-green" style={{ fontSize: px(14), margin: 0 }}>Cool-down</p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.cooldown.map((it, i) => <li key={`cd-${i}`}>{it}</li>)}</ul>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" onClick={onStartRun}
            className="forged-start-run" style={{ flex: '1 1 140px', border: 'none', borderRadius: 8, padding: '12px', fontWeight: 900, fontSize: px(14), cursor: 'pointer' }}>
            Start Run
          </button>
          <button type="button" onClick={() => onToggleComplete?.(runSession.id)} disabled={updating}
            style={{ flex: '0 0 auto', border: '1px solid rgba(60,55,45,0.2)', borderRadius: 8, padding: '12px 14px', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: px(13), cursor: 'pointer' }}>
            {done ? <CheckCircle2 size={16} color="#15803D" /> : <Circle size={16} />} {done ? 'Done' : 'Mark done'}
          </button>
        </div>
        <WatchWorkoutSendButton workout={watchWorkout} className="mt-2" />
      </PaperSection>
    )
  }

  const renderLift = () => {
    if (!liftSession) return null
    const f = liftFacts(liftSession)
    const done = completedSet?.has(String(liftSession.id))
    const watchWorkout = WatchWorkoutService.buildStrengthWorkout({
      workoutName: liftSession.title,
      target: f.focus,
      warmup: f.warmup,
      main: f.exercises,
      recovery: f.recovery,
      explanation: firstStr(liftSession.prescription?.explanation, liftSession.raw?.explanation),
    })
    return (
      <PaperSection title={firstStr(liftSession.title, 'Strength')} px={px}
        icon={<span className="forged-stamp forged-stamp--lift" data-state={sessionState(liftSession, completedSet)}><Dumbbell size={16} /></span>}>
        {f.focus && <p className="forged-hand" style={{ fontSize: px(15), margin: '0 0 8px' }}>{f.focus}</p>}
        {f.warmup.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <p className="forged-hand forged-sec-green" style={{ fontSize: px(14), margin: 0 }}>Warm-up</p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: px(13) }}>{f.warmup.map((it, i) => <li key={`lwu-${i}`}>{it}</li>)}</ul>
          </div>
        )}
        {f.exercises.map((ex, index) => (
          <div className="forged-exercise" key={`ex-${ex.name}-${index}`}>
            <div className="flex items-start justify-between gap-2">
              <p style={{ fontSize: px(15), fontWeight: 800, margin: 0 }}>{index + 1}. {ex.name}</p>
              {ex.exFocus && <span className="forged-sec-green" style={{ fontSize: px(11), fontWeight: 800, textTransform: 'uppercase' }}>{ex.exFocus}</span>}
            </div>
            <div className="forged-exercise-metrics">
              <span>Sets<strong style={{ fontSize: px(15) }}>{ex.sets || '—'}</strong></span>
              <span>Reps<strong style={{ fontSize: px(15) }}>{ex.reps || '—'}</strong></span>
              <span>Rest<strong style={{ fontSize: px(15) }}>{ex.rest || '—'}</strong></span>
              <span>Load<strong style={{ fontSize: px(15) }}>{ex.load || '—'}</strong></span>
              <span>RPE/RIR<strong style={{ fontSize: px(15) }}>{ex.rpe || '—'}</strong></span>
            </div>
            {ex.cue && <p style={{ fontSize: px(12), marginTop: 6, color: 'var(--ink-soft, #5A554B)' }}>{ex.cue}</p>}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" onClick={onStartLift}
            className="forged-start-lift" style={{ flex: '1 1 140px', border: 'none', borderRadius: 8, padding: '12px', fontWeight: 900, fontSize: px(14), cursor: 'pointer' }}>
            Start Lift
          </button>
          <button type="button" onClick={() => onToggleComplete?.(liftSession.id)} disabled={updating}
            style={{ flex: '0 0 auto', border: '1px solid rgba(60,55,45,0.2)', borderRadius: 8, padding: '12px 14px', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: px(13), cursor: 'pointer' }}>
            {done ? <CheckCircle2 size={16} color="#15803D" /> : <Circle size={16} />} {done ? 'Done' : 'Mark done'}
          </button>
        </div>
        <WatchWorkoutSendButton workout={watchWorkout} className="mt-2" />
      </PaperSection>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`forged-cal forged-paper ${expanded ? 'forged-paper--full' : ''}`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? 'true' : undefined}
      aria-label={expanded ? `${dateLabel} workout expanded` : undefined}
      tabIndex={expanded ? -1 : undefined}
      style={{
        '--rule': rulePx,
        position: expanded ? 'fixed' : 'relative',
        inset: expanded ? 0 : 'auto',
        zIndex: expanded ? 70 : 'auto',
        height: expanded ? '100dvh' : 'auto',
        overflowY: expanded ? 'auto' : 'visible',
        padding: 16,
        paddingTop: expanded ? 'calc(env(safe-area-inset-top, 0px) + 16px)' : 16,
        paddingBottom: expanded ? 'calc(env(safe-area-inset-bottom, 0px) + 24px)' : 16,
      }}
    >
      <header className="flex items-start justify-between gap-3">
        <div style={{ minWidth: 0 }}>
          <button type="button" onClick={onBack}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--ink-soft, #5A554B)', fontSize: px(12), fontWeight: 700, padding: 0, cursor: 'pointer' }}>
            <ChevronLeft size={15} /> Calendar
          </button>
          <h3 className="forged-hand" style={{ fontSize: px(24), fontWeight: 700, margin: '6px 0 0' }}>{dateLabel}</h3>
          {planContext.phase && <p style={{ fontSize: px(12), margin: '2px 0 0', color: 'var(--ink-soft, #5A554B)' }}>{planContext.phase} · {planContext.modeLabel}</p>}
        </div>
        <div className="forged-paper-controls">
          <button type="button" onClick={() => setScaleIndex((v) => Math.max(0, v - 1))} disabled={scaleIndex === 0} aria-label="Make text smaller" title="Smaller text" style={{ opacity: scaleIndex === 0 ? 0.4 : 1 }}><Minus size={16} /></button>
          <span aria-live="polite" style={{ width: 40, textAlign: 'center', fontSize: 11, fontWeight: 800 }}>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScaleIndex((v) => Math.min(TEXT_SCALES.length - 1, v + 1))} disabled={scaleIndex === TEXT_SCALES.length - 1} aria-label="Make text larger" title="Larger text" style={{ opacity: scaleIndex === TEXT_SCALES.length - 1 ? 0.4 : 1 }}><Plus size={16} /></button>
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-label={expanded ? 'Close full screen' : 'Full screen'} title={expanded ? 'Close full screen' : 'Full screen'}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        </div>
      </header>

      {isRest ? (
        <section style={{ marginTop: 24, textAlign: 'center' }}>
          <span className="forged-stamp forged-stamp--rest" style={{ margin: '0 auto' }}><Moon size={16} /></span>
          <h4 className="forged-hand" style={{ fontSize: px(20), fontWeight: 700, marginTop: 10 }}>Rest day</h4>
          <p style={{ fontSize: px(13), color: 'var(--ink-soft, #5A554B)', marginTop: 4 }}>Recover well and come back ready.</p>
        </section>
      ) : (
        <>
          {orderGuidance && (runSession && liftSession) && (
            <p className="forged-hand" style={{ fontSize: px(14), marginTop: 12, padding: '8px 10px', background: 'rgba(60,55,45,0.05)', borderRadius: 8 }}>{orderGuidance}</p>
          )}
          {renderRun()}
          {renderLift()}
          {recovery && (
            <PaperSection title="Recovery" tone="green" px={px}
              icon={<span className="forged-stamp forged-stamp--sm forged-stamp--rest"><Moon size={12} /></span>}>
              <p style={{ fontSize: px(13) }}>{recovery}</p>
            </PaperSection>
          )}
        </>
      )}

      {whyToday && (
        <section style={{ marginTop: 20, borderTop: '1px solid rgba(60,55,45,0.16)', paddingTop: 14 }}>
          <div className="flex items-center gap-2">
            <Brain size={17} color="#C2410C" />
            <h4 className="forged-hand" style={{ fontSize: px(17), fontWeight: 700 }}>Why today</h4>
          </div>
          <p style={{ fontSize: px(13), lineHeight: 1.55, marginTop: 8 }}>{whyToday}</p>
        </section>
      )}
    </div>
  )
}
