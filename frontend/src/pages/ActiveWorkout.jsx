import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router'
import { Pause, Play, Plus, X } from 'lucide-react'
import api from '../lib/api'
import ExercisePickerModal from '../components/ExercisePickerModal'
import MovementDemo from '../components/MovementDemo'
import { getWeightDropWarning, scrollToFirstError, validateWorkoutSet } from '../utils/validation'
import { planSessionIdFromState, currentWeekFromState, markSessionComplete, queueSessionComplete, isRetryableCompletionFailure } from '../lib/dailyExecution'

const REST_PRESETS = [30, 60, 90, 120, 180]
const DEFAULT_REST_SECONDS = 90

function prescribedReps(value) {
  const match = String(value || '').match(/\d+/)
  return match ? match[0] : ''
}

function prescribedRestSeconds(value) {
  const match = String(value || '').toLowerCase().match(/(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?\s*(min|m|sec|s)?/)
  if (!match) return 90
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return 90
  return match[2] === 'min' || match[2] === 'm' ? Math.round(amount * 60) : Math.round(amount)
}

function normalizeWarmupItems(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return item.trim()
    if (!item || typeof item !== 'object') return ''
    return String(item.name || item.label || item.instruction || '').trim()
  }).filter(Boolean)
}

function fmtDuration(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  return `${m}:${String(sec).padStart(2,'0')}`
}

function playAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const beep = (freq, start, dur) => {
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.connect(g); g.connect(ctx.destination)
      o.frequency.value = freq; o.type = 'sine'
      g.gain.setValueAtTime(0.5, ctx.currentTime + start)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur)
      o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur + 0.1)
    }
    beep(880,0,0.15); beep(1100,0.2,0.15); beep(880,0.4,0.15); beep(1320,0.6,0.3)
  } catch (err) {
    console.warn('[active-workout/alarm] unable to play rest alert:', err?.message || err)
  }
}

function RestTimerDialog({ duration, remaining, running, complete, onToggle, onAddTime, onEnd, onClose }) {
  const progress = duration > 0 ? Math.max(0, Math.min(100, (remaining / duration) * 100)) : 0
  const dialogRef = useRef(null)
  const closeButtonRef = useRef(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = [...(dialogRef.current?.querySelectorAll('button:not([disabled])') || [])]
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

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rest-timer-title"
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.78)', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div ref={dialogRef} className="w-full rounded-2xl p-5" style={{ maxWidth: 380, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p id="rest-timer-title" className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Rest Timer</p>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Countdown length: {fmtDuration(duration)}</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close rest timer" className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="py-8 text-center">
          <p className="font-bold tabular-nums" style={{ color: complete ? 'var(--success)' : (remaining <= 5 ? 'var(--danger)' : 'var(--accent)'), fontSize: 72, lineHeight: 1 }}>
            {fmtDuration(remaining)}
          </p>
          <p role="status" aria-live="polite" className="mt-3 text-sm font-semibold" style={{ color: complete ? 'var(--success)' : 'var(--text-muted)' }}>
            {complete ? 'Rest complete' : (running ? 'Resting' : 'Timer paused')}
          </p>
        </div>

        <div className="h-2 rounded-full overflow-hidden mb-5" style={{ background: 'var(--bg-input)' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: complete ? 'var(--success)' : 'var(--accent)', transition: 'width 1s linear' }} />
        </div>

        {!complete && (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={onToggle} className="rounded-xl py-3 px-3 font-bold flex items-center justify-center gap-2" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
              {running ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
              {running ? 'Pause' : 'Resume'}
            </button>
            <button type="button" onClick={onAddTime} className="rounded-xl py-3 px-3 font-bold flex items-center justify-center gap-2" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
              <Plus size={18} aria-hidden="true" />
              30 sec
            </button>
          </div>
        )}

        <button type="button" onClick={complete ? onClose : onEnd} className="w-full mt-3 rounded-xl py-3 font-semibold" style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
          {complete ? 'Done' : 'End rest'}
        </button>
      </div>
    </div>
  )
}

export default function ActiveWorkout() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const plannedExercises = location.state?.exercises || []
  const plannedWarmup = useMemo(() => normalizeWarmupItems(location.state?.warmup), [location.state?.warmup])
  const workoutName = location.state?.workoutName || ''
  // H5: canonical plan session carried from LogLift so a successful workout end
  // marks the exact calendar lift complete. Null for ad-hoc/manual workouts.
  const planSessionId = planSessionIdFromState(location.state)
  const planCurrentWeek = currentWeekFromState(location.state)

  const [elapsed, setElapsed] = useState(0)
  const workoutTimerRef = useRef(null)
  const [queueIndex, setQueueIndex] = useState(0)

  const [activeGroup, setActiveGroup] = useState('')
  const [muscleGroups, setMuscleGroups] = useState([])
  const [selectedExercise, setSelectedExercise] = useState(null)
  const [showExercisePicker, setShowExercisePicker] = useState(false)
  const [reps, setReps] = useState('')
  const [weight, setWeight] = useState('')
  const [setNumber, setSetNumber] = useState(1)

  const [sets, setSets] = useState([])
  const [recentLifts, setRecentLifts] = useState([])
  const [formErrors, setFormErrors] = useState({})
  const [formWarning, setFormWarning] = useState('')

  const [showRest, setShowRest] = useState(true)
  const [restSeconds, setRestSeconds] = useState(0)
  const [restDuration, setRestDuration] = useState(DEFAULT_REST_SECONDS)
  const [selectedRestPreset, setSelectedRestPreset] = useState(DEFAULT_REST_SECONDS)
  const [restRunning, setRestRunning] = useState(false)
  const [restComplete, setRestComplete] = useState(false)
  const [showRestDialog, setShowRestDialog] = useState(false)
  const restRef = useRef(null)

  const [hrInfo, setHrInfo] = useState(null)
  const [userSex, setUserSex] = useState('male')

  const [ending, setEnding] = useState(false)
  const repsErrorRef = useRef(null)
  const weightErrorRef = useRef(null)
  const endErrorRef = useRef(null)

  useEffect(() => {
    workoutTimerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(workoutTimerRef.current)
  }, [])

  useEffect(() => {
    api.get(`/workouts/${id}`).then(res => {
      const groups = res.data?.session?.muscle_groups || []
      setMuscleGroups(groups)
      if (groups.length > 0) {
        setActiveGroup(groups[0])
      }
    }).catch((error) => {
      console.error('[active-workout/session] load failed:', error?.message || error)
    })
  }, [id])

  useEffect(() => {
    api.get(`/workouts/${id}/sets`).then(res => {
      setSets(res.data?.sets || [])
    }).catch((error) => {
      console.error('[active-workout/sets] load failed:', error?.message || error)
    })
  }, [id])

  useEffect(() => {
    api.get('/lifts').then((r) => setRecentLifts(r.data?.lifts || [])).catch((error) => {
      console.error('[active-workout/lifts] recent lifts lookup failed:', error?.message || error)
      setRecentLifts([])
    })
  }, [])

  useEffect(() => {
    api.get('/runs').then((r) => {
      const latest = (r.data?.runs || [])[0]
      if (latest?.avg_heart_rate) {
        setHrInfo({ bpm: latest.avg_heart_rate, ts: latest.created_at || latest.date })
      }
    }).catch((error) => {
      console.error('[active-workout/runs] heart-rate lookup failed:', error?.message || error)
    })
  }, [])

  useEffect(() => {
    api.get('/auth/me').then((r) => setUserSex(r.data?.user?.sex || 'male')).catch((error) => {
      console.error('[active-workout/profile] lookup failed:', error?.message || error)
    })
  }, [])

  useEffect(() => {
    if (plannedExercises.length > 0) {
      const first = plannedExercises[0]
      setSelectedExercise({ name: first.name })
      setReps(prescribedReps(first.reps))
    }
  }, [])

  useEffect(() => {
    if (restRunning && restSeconds > 0) {
      restRef.current = setTimeout(() => setRestSeconds(s => s - 1), 1000)
    } else if (restRunning && restSeconds === 0) {
      setRestRunning(false)
      setRestComplete(true)
      playAlarm()
    }
    return () => clearTimeout(restRef.current)
  }, [restRunning, restSeconds])

  const weightDropWarning = useMemo(() => {
    return getWeightDropWarning({
      exerciseName: selectedExercise?.name,
      nextWeight: weight,
      recentLifts,
    })
  }, [selectedExercise?.name, weight, recentLifts])

  useEffect(() => {
    setFormWarning(weightDropWarning)
  }, [weightDropWarning])

  const startRest = (s) => {
    clearTimeout(restRef.current)
    setSelectedRestPreset(s)
    setRestDuration(s)
    setRestSeconds(s)
    setRestRunning(true)
    setRestComplete(false)
    setShowRestDialog(true)
  }

  const addRestTime = () => {
    setRestDuration((seconds) => seconds + 30)
    setRestSeconds((seconds) => seconds + 30)
    setRestComplete(false)
    setRestRunning(true)
  }

  const endRest = () => {
    clearTimeout(restRef.current)
    setRestSeconds(0)
    setRestRunning(false)
    setRestComplete(false)
    setShowRestDialog(false)
  }

  const logSet = async () => {
    if (!selectedExercise?.name) return
    const { errors } = validateWorkoutSet({ reps, weight })
    setFormErrors(errors)
    if (Object.keys(errors).length) {
      scrollToFirstError(
        { reps: repsErrorRef, weight: weightErrorRef },
        ['reps', 'weight']
      )
      return
    }
    try {
      const res = await api.post(`/workouts/${id}/sets`, {
        exercise_name: selectedExercise.name,
        muscle_group: activeGroup,
        reps: Number(reps),
        weight_lbs: Number(weight),
        set_number: setNumber
      })
      setSets(prev => [...prev, res.data.set])
      const nextSetNumber = setNumber + 1
      setSetNumber(nextSetNumber)
      setReps('')
      setWeight('')
      setFormErrors({})
      setFormWarning('')
      const currentPlanned = plannedExercises[queueIndex]
      startRest(prescribedRestSeconds(currentPlanned?.rest))

      // Auto-advance to next planned exercise after completing all sets
      if (currentPlanned && nextSetNumber > Number(currentPlanned.sets)) {
        const nextIndex = queueIndex + 1
        if (nextIndex < plannedExercises.length) {
          const next = plannedExercises[nextIndex]
          setQueueIndex(nextIndex)
          setSelectedExercise({ name: next.name })
          setReps(prescribedReps(next.reps))
          setWeight('')
          setSetNumber(1)
        }
      }
    } catch (err) {
      console.error('[active-workout/log-set] failed:', err?.message || err)
      setFormErrors((previous) => ({ ...previous, workout: 'Could not save this set. Check your connection and try again.' }))
    }
  }

  const endWorkout = async () => {
    if (sets.length < 1) {
      setFormErrors({ workout: 'Log at least 1 set before ending workout.' })
      scrollToFirstError({ workout: endErrorRef }, ['workout'])
      return
    }
    setEnding(true)
    clearInterval(workoutTimerRef.current)
    try {
      await api.put(`/workouts/${id}/end`, {})
      let planProgressNotice = ''
      // H5: mark the scheduled calendar session complete ONLY after the workout
      // end succeeded. A failed completion must never block the summary nav.
      if (planSessionId) {
        try {
          await markSessionComplete(planSessionId, planCurrentWeek)
        } catch (completionErr) {
          console.error('[active-workout] plan completion failed:', completionErr?.message || completionErr)
          if (isRetryableCompletionFailure(completionErr)) {
            try {
              await queueSessionComplete(planSessionId, planCurrentWeek)
              planProgressNotice = 'Workout saved. Plan progress is queued for sync.'
            } catch (queueErr) {
              console.error('[active-workout] failed to queue completion retry:', queueErr?.message || queueErr)
              planProgressNotice = 'Workout saved. Open Plan to mark this session complete.'
            }
          } else {
            planProgressNotice = 'Workout saved. Open Plan to mark this session complete.'
          }
        }
      }
      navigate(`/workout/summary/${id}`, { state: { planProgressNotice } })
    } catch (err) {
      console.error('[active-workout/end] failed:', err?.message || err)
      setFormErrors((previous) => ({ ...previous, workout: 'Could not finish this workout. Try again.' }))
      setEnding(false)
    }
  }

  const currentExerciseName = selectedExercise?.name || ''
  const lastSet = [...sets].reverse().find(s => s.exercise_name === currentExerciseName)
  const exerciseSets = sets.filter(s => s.exercise_name === currentExerciseName)

  return (
    <div className="space-y-3" style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}>
      <div className="flex items-center justify-between rounded-2xl p-3" style={{ background: 'var(--bg-card)', gap: 10 }}>
        <div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Workout Time</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--accent)' }}>{fmtDuration(elapsed)}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{hrInfo ? `HR: ${hrInfo.bpm} bpm · ${Math.max(1, Math.round((Date.now()-new Date(hrInfo.ts).getTime())/60000))} min ago` : 'No watch data yet — sync your watch to unlock this'}</p>
        </div>
        <button onClick={endWorkout} disabled={ending} className="rounded-xl px-3 py-2 font-bold text-xs" style={{ background: 'var(--danger-dim)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.3)', flexShrink: 0 }}>
          {ending ? 'Ending...' : 'End Workout'}
        </button>
      </div>

      {plannedWarmup.length > 0 && (
        <details className="rounded-2xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
          <summary className="flex items-center justify-between gap-3 px-4 py-3 font-bold" style={{ color: 'var(--text-primary)', cursor: 'pointer' }}>
            <span>Warm-up</span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{plannedWarmup.length} steps</span>
          </summary>
          <ol className="grid gap-2 px-4 pb-4 pl-9 text-sm" style={{ color: 'var(--text-muted)' }}>
            {plannedWarmup.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
          </ol>
        </details>
      )}

      {plannedExercises.length > 0 && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
          {workoutName && <p className="text-xs font-bold mb-3 uppercase tracking-widest" style={{ color: 'var(--accent)' }}>{workoutName}</p>}
          <div className="space-y-2">
            {plannedExercises.map((ex, i) => {
              const isCurrent = i === queueIndex
              const isDone = i < queueIndex
              return (
                <div key={i} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{
                  background: isCurrent ? 'var(--accent-dim)' : 'transparent',
                  borderLeft: isCurrent ? '3px solid var(--accent)' : '3px solid transparent',
                  opacity: isDone ? 0.4 : 1
                }}>
                  <span className="flex-1 text-sm font-semibold" style={{ color: isCurrent ? 'var(--accent)' : 'var(--text-primary)', textDecoration: isDone ? 'line-through' : 'none' }}>{ex.name}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{ex.sets}x{ex.reps}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{ex.rest}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={() => setShowRest(v => !v)} className="rounded-full px-3 py-1.5 text-xs font-medium border transition-all" style={showRest ? { background: 'var(--accent-dim)', borderColor: 'var(--accent)', color: 'var(--accent)' } : { background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
          Rest Timer
        </button>
      </div>

      {showRest && (
        <div className="rounded-xl p-3 space-y-2" style={{ background: 'var(--bg-card)' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Rest Timer</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {restSeconds > 0 || restComplete ? `Countdown length: ${fmtDuration(restDuration)}` : `Default countdown: ${fmtDuration(restDuration)}`}
              </p>
            </div>
            {(restSeconds > 0 || restComplete) && (
              <button type="button" onClick={() => setShowRestDialog(true)} className="rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
                Open large timer
              </button>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {REST_PRESETS.map(s => (
              <button key={s} type="button" aria-pressed={selectedRestPreset === s} onClick={() => startRest(s)} className="rounded-lg px-3 py-2 text-xs font-semibold border" style={selectedRestPreset === s ? { background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'var(--accent)' } : { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                {s < 60 ? `${s}s` : `${s/60}m`}
              </button>
            ))}
          </div>
          {restSeconds > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-4xl font-bold tabular-nums" style={{ color: restSeconds <= 5 ? 'var(--danger)' : 'var(--text-primary)' }}>
                {fmtDuration(restSeconds)}
              </span>
              <button type="button" onClick={() => setRestRunning(v => !v)} className="rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                {restRunning ? 'Pause' : 'Resume'}
              </button>
            </div>
          )}
          {restComplete && <p className="text-sm font-semibold" style={{ color: 'var(--success)' }}>Rest complete</p>}
        </div>
      )}

      {showRestDialog && (
        <RestTimerDialog
          duration={restDuration}
          remaining={restSeconds}
          running={restRunning}
          complete={restComplete}
          onToggle={() => setRestRunning((running) => !running)}
          onAddTime={addRestTime}
          onEnd={endRest}
          onClose={() => setShowRestDialog(false)}
        />
      )}

      {muscleGroups.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {muscleGroups.map(g => (
            <button key={g} onClick={() => { setActiveGroup(g); setSelectedExercise(null); setSetNumber(1) }} className="rounded-full px-4 py-1.5 text-sm capitalize font-medium whitespace-nowrap border flex-shrink-0" style={activeGroup === g ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--on-accent)' } : { background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              {g}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-2xl p-3 space-y-3" style={{ background: 'var(--bg-card)', minWidth: 0 }}>
        <div className="flex items-start justify-between gap-2">
          <span className="font-bold text-sm" style={{ color: 'var(--accent)', minWidth: 0, overflowWrap: 'anywhere' }}>
            Current: {currentExerciseName || 'None selected'}
          </span>
          <button onClick={() => setShowExercisePicker(true)} className="text-xs" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
            {currentExerciseName ? 'Change Exercise' : 'Choose Exercise'}
          </button>
        </div>

        {showExercisePicker && (
          <ExercisePickerModal
            muscleGroup={activeGroup}
            onSelect={(ex) => { setSelectedExercise(ex); setSetNumber(1); setShowExercisePicker(false) }}
            onClose={() => setShowExercisePicker(false)}
          />
        )}

        {lastSet && (
          <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Last set: <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{lastSet.reps} reps @ {lastSet.weight_lbs} lbs</span>
            </p>
          </div>
        )}

        {exerciseSets.length > 0 && (
          <div className="space-y-1">
            {exerciseSets.map((s, i) => (
              <div key={s.id} className="flex gap-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                <span>Set {i+1}</span>
                <span>{s.reps} reps</span>
                <span>{s.weight_lbs} lbs</span>
              </div>
            ))}
          </div>
        )}

        {currentExerciseName && (
          <>
            <MovementDemo name={currentExerciseName} compact sex={userSex} />
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10, alignItems: 'end' }}>
              <div style={{ minWidth: 0 }}>
                <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Reps</p>
                <input aria-label="Reps" type="number" min="1" placeholder="0" value={reps} onChange={e => setReps(e.target.value)} className="w-full rounded-xl px-3 py-3 text-center text-xl font-bold border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
                {formErrors.reps && <p ref={repsErrorRef} className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{formErrors.reps}</p>}
              </div>
              <div style={{ minWidth: 0 }}>
                <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Weight (lbs)</p>
                <input aria-label="Weight in pounds" type="number" min="0" step="2.5" placeholder="0" value={weight} onChange={e => setWeight(e.target.value)} className="w-full rounded-xl px-3 py-3 text-center text-xl font-bold border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
                {formErrors.weight && <p ref={weightErrorRef} className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{formErrors.weight}</p>}
                {formWarning && <p className="text-xs mt-1" style={{ color: 'var(--warning)' }}>{formWarning}</p>}
              </div>
              <button onClick={logSet} className="rounded-xl px-4 py-3 font-bold text-sm" style={{ background: 'var(--accent)', color: 'var(--on-accent)', gridColumn: '1 / -1', width: '100%' }}>
                + Set {setNumber}
              </button>
            </div>
          </>
        )}
      </div>

      {formErrors.workout && (
        <p ref={endErrorRef} className="text-xs" style={{ color: 'var(--danger)' }}>
          {formErrors.workout}
        </p>
      )}

      {sets.length > 0 && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
          <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>Sets logged — {sets.length} total</p>
          <div className="space-y-2">
            {Object.entries(sets.reduce((acc, s) => {
              if (!acc[s.exercise_name]) acc[s.exercise_name] = []
              acc[s.exercise_name].push(s)
              return acc
            }, {})).map(([name, exSets]) => (
              <div key={name}>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{name}</p>
                <div className="flex flex-wrap gap-2 mt-1">
                  {exSets.map((s, i) => (
                    <span key={s.id} className="text-xs px-2 py-1 rounded-lg" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                      {i+1}: {s.reps}×{s.weight_lbs}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
