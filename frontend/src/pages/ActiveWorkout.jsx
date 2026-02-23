import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import ExercisePickerModal from '../components/ExercisePickerModal'

const REST_PRESETS = [30, 60, 90, 120, 180]

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
  } catch {}
}

export default function ActiveWorkout() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [elapsed, setElapsed] = useState(0)
  const workoutTimerRef = useRef(null)

  const [activeGroup, setActiveGroup] = useState('')
  const [muscleGroups, setMuscleGroups] = useState([])
  const [selectedExercise, setSelectedExercise] = useState(null)
  const [showExercisePicker, setShowExercisePicker] = useState(false)
  const [reps, setReps] = useState('')
  const [weight, setWeight] = useState('')
  const [setNumber, setSetNumber] = useState(1)

  const [sets, setSets] = useState([])

  const [showRest, setShowRest] = useState(true)
  const [restSeconds, setRestSeconds] = useState(0)
  const [restRunning, setRestRunning] = useState(false)
  const restRef = useRef(null)

  const [hrInfo, setHrInfo] = useState(null)

  const [ending, setEnding] = useState(false)

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
    }).catch(() => {})
  }, [id])

  useEffect(() => {
    api.get(`/workouts/${id}/sets`).then(res => {
      setSets(res.data?.sets || [])
    }).catch(() => {})
  }, [id])

  useEffect(() => {
    api.get('/runs').then((r) => {
      const latest = (r.data?.runs || [])[0]
      if (latest?.avg_heart_rate) {
        setHrInfo({ bpm: latest.avg_heart_rate, ts: latest.created_at || latest.date })
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (restRunning && restSeconds > 0) {
      restRef.current = setTimeout(() => setRestSeconds(s => s - 1), 1000)
    } else if (restRunning && restSeconds === 0) {
      setRestRunning(false)
      playAlarm()
    }
    return () => clearTimeout(restRef.current)
  }, [restRunning, restSeconds])

  const startRest = (s) => {
    clearTimeout(restRef.current)
    setRestSeconds(s)
    setRestRunning(true)
  }

  const logSet = async () => {
    if (!selectedExercise?.name || !reps || !weight) return
    try {
      const res = await api.post(`/workouts/${id}/sets`, {
        exercise_name: selectedExercise.name,
        muscle_group: activeGroup,
        reps: Number(reps),
        weight_lbs: Number(weight),
        set_number: setNumber
      })
      setSets(prev => [...prev, res.data.set])
      setSetNumber(s => s + 1)
      setReps('')
      setWeight('')
      startRest(90)
    } catch {}
  }

  const endWorkout = async () => {
    setEnding(true)
    clearInterval(workoutTimerRef.current)
    try {
      await api.put(`/workouts/${id}/end`, {})
      navigate(`/workout/summary/${id}`)
    } catch {
      setEnding(false)
    }
  }

  const currentExerciseName = selectedExercise?.name || ''
  const lastSet = [...sets].reverse().find(s => s.exercise_name === currentExerciseName)
  const exerciseSets = sets.filter(s => s.exercise_name === currentExerciseName)

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Workout Time</p>
          <p className="text-3xl font-bold tabular-nums" style={{ color: 'var(--accent)' }}>{fmtDuration(elapsed)}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{hrInfo ? `HR: ${hrInfo.bpm} bpm · ${Math.max(1, Math.round((Date.now()-new Date(hrInfo.ts).getTime())/60000))} min ago` : 'No watch data yet — sync your watch to unlock this'}</p>
        </div>
        <button onClick={endWorkout} disabled={ending} className="rounded-xl px-5 py-3 font-bold text-sm" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
          {ending ? 'Ending...' : 'End Workout'}
        </button>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setShowRest(v => !v)} className="rounded-full px-3 py-1.5 text-xs font-medium border transition-all" style={showRest ? { background: 'var(--accent-dim)', borderColor: 'var(--accent)', color: 'var(--accent)' } : { background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
          Rest Timer
        </button>
      </div>

      {showRest && (
        <div className="rounded-xl p-3 space-y-2" style={{ background: 'var(--bg-card)' }}>
          <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Rest Timer</p>
          <div className="flex gap-2 flex-wrap">
            {REST_PRESETS.map(s => (
              <button key={s} onClick={() => startRest(s)} className="rounded-lg px-3 py-1.5 text-xs font-semibold border" style={restRunning && restSeconds === s ? { background: 'var(--accent)', color: 'black', borderColor: 'var(--accent)' } : { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                {s < 60 ? `${s}s` : `${s/60}m`}
              </button>
            ))}
          </div>
          {restSeconds > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold tabular-nums" style={{ color: restSeconds <= 5 ? '#ef4444' : 'var(--text-primary)' }}>
                {fmtDuration(restSeconds)}
              </span>
              <button onClick={() => setRestRunning(v => !v)} className="rounded-lg px-3 py-1 text-xs font-semibold" style={{ background: 'var(--accent)', color: 'black' }}>
                {restRunning ? 'Pause' : 'Resume'}
              </button>
            </div>
          )}
        </div>
      )}

      {muscleGroups.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {muscleGroups.map(g => (
            <button key={g} onClick={() => { setActiveGroup(g); setSelectedExercise(null); setSetNumber(1) }} className="rounded-full px-4 py-1.5 text-sm capitalize font-medium whitespace-nowrap border flex-shrink-0" style={activeGroup === g ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'black' } : { background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              {g}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)' }}>
        <div className="flex items-center justify-between">
          <span className="font-bold text-base" style={{ color: 'var(--accent)' }}>
            Current: {currentExerciseName || 'None selected'}
          </span>
          <button onClick={() => setShowExercisePicker(true)} className="text-xs" style={{ color: 'var(--text-muted)' }}>
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
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Reps</p>
              <input type="number" min="1" placeholder="0" value={reps} onChange={e => setReps(e.target.value)} className="w-full rounded-xl px-3 py-3 text-center text-xl font-bold border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
            </div>
            <div className="flex-1">
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Weight (lbs)</p>
              <input type="number" min="0" step="2.5" placeholder="0" value={weight} onChange={e => setWeight(e.target.value)} className="w-full rounded-xl px-3 py-3 text-center text-xl font-bold border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
            </div>
            <button onClick={logSet} disabled={!reps || !weight} className="rounded-xl px-4 py-3 font-bold text-sm disabled:opacity-40" style={{ background: 'var(--accent)', color: 'black' }}>
              + Set {setNumber}
            </button>
          </div>
        )}
      </div>

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
