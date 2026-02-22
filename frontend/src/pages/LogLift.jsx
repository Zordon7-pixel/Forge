import { useState, useEffect, useRef } from 'react'
import api from '../lib/api'

const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core']
const REST_PRESETS = [30, 60, 90, 120, 180] // seconds

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function fmtTime(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function playAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const beep = (freq, start, dur) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.connect(g); g.connect(ctx.destination)
      o.frequency.value = freq
      o.type = 'sine'
      g.gain.setValueAtTime(0.5, ctx.currentTime + start)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur)
      o.start(ctx.currentTime + start)
      o.stop(ctx.currentTime + start + dur + 0.1)
    }
    beep(880, 0, 0.15)
    beep(1100, 0.2, 0.15)
    beep(880, 0.4, 0.15)
    beep(1320, 0.6, 0.3)
  } catch {}
}

export default function LogLift() {
  const [form, setForm] = useState({
    date: todayISO(),
    exercise_name: '',
    sets: '',
    reps: '',
    weight_lbs: '',
    notes: '',
    rest_seconds: 60,
  })
  const [selectedGroup, setSelectedGroup] = useState('')
  const [exercises, setExercises] = useState([])
  const [loadingEx, setLoadingEx] = useState(false)
  const [showExercises, setShowExercises] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  // Rest timer state
  const [timerActive, setTimerActive] = useState(false)
  const [timerSeconds, setTimerSeconds] = useState(60)
  const [timerRunning, setTimerRunning] = useState(false)
  const timerRef = useRef(null)

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  // Load exercises when muscle group selected
  useEffect(() => {
    if (!selectedGroup) return
    setLoadingEx(true)
    api.get('/exercises', { params: { muscle_group: selectedGroup } })
      .then(res => {
        setExercises(res.data?.exercises || [])
        setShowExercises(true)
      })
      .catch(() => setExercises([]))
      .finally(() => setLoadingEx(false))
  }, [selectedGroup])

  // Timer countdown
  useEffect(() => {
    if (timerRunning && timerSeconds > 0) {
      timerRef.current = setTimeout(() => setTimerSeconds(s => s - 1), 1000)
    } else if (timerRunning && timerSeconds === 0) {
      setTimerRunning(false)
      playAlarm()
    }
    return () => clearTimeout(timerRef.current)
  }, [timerRunning, timerSeconds])

  const selectExercise = (name) => {
    update('exercise_name', name)
    setShowExercises(false)
  }

  const addCustomExercise = async () => {
    if (!customInput.trim() || !selectedGroup) return
    try {
      await api.post('/exercises', { name: customInput.trim(), muscle_group: selectedGroup })
      update('exercise_name', customInput.trim())
      setCustomInput('')
      setShowExercises(false)
    } catch {}
  }

  const startTimer = (presetSeconds) => {
    clearTimeout(timerRef.current)
    setTimerSeconds(presetSeconds)
    setTimerRunning(true)
    setTimerActive(true)
    update('rest_seconds', presetSeconds)
  }

  const stopTimer = () => {
    clearTimeout(timerRef.current)
    setTimerRunning(false)
  }

  const resetTimer = () => {
    stopTimer()
    setTimerSeconds(form.rest_seconds)
  }

  const onSubmit = async e => {
    e.preventDefault()
    setSuccess(''); setError('')
    try {
      await api.post('/lifts', {
        ...form,
        sets: Number(form.sets),
        reps: Number(form.reps),
        weight_lbs: Number(form.weight_lbs),
        muscle_groups: selectedGroup ? [selectedGroup] : [],
      })
      setSuccess('Lift logged!')
      setForm({ date: todayISO(), exercise_name: '', sets: '', reps: '', weight_lbs: '', notes: '', rest_seconds: 60 })
      setSelectedGroup('')
      setShowExercises(false)
      stopTimer(); setTimerActive(false); setTimerSeconds(60)
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not log lift.')
    }
  }

  return (
    <div className="rounded-2xl p-4 space-y-4" style={{ background: 'var(--bg-card)' }}>
      <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Log Lift</h2>

      <form onSubmit={onSubmit} className="space-y-4">
        <input
          type="date"
          value={form.date}
          onChange={e => update('date', e.target.value)}
          className="w-full rounded-xl px-4 py-3 border"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        />

        {/* Muscle group selector */}
        <div>
          <p className="text-xs mb-2 font-medium" style={{ color: 'var(--text-muted)' }}>Select muscle group</p>
          <div className="grid grid-cols-3 gap-2">
            {MUSCLE_GROUPS.map(group => (
              <button
                type="button"
                key={group}
                onClick={() => setSelectedGroup(g => g === group ? '' : group)}
                className="rounded-xl border py-2 text-sm capitalize font-medium transition-all"
                style={selectedGroup === group
                  ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'black' }
                  : { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
              >
                {group}
              </button>
            ))}
          </div>
        </div>

        {/* Exercise picker */}
        {selectedGroup && (
          <div>
            <p className="text-xs mb-2 font-medium" style={{ color: 'var(--text-muted)' }}>
              {loadingEx ? 'Loading...' : `${selectedGroup.charAt(0).toUpperCase() + selectedGroup.slice(1)} exercises`}
            </p>
            {showExercises && exercises.length > 0 && (
              <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="max-h-48 overflow-y-auto">
                  {exercises.map(ex => (
                    <button
                      key={ex.id}
                      type="button"
                      onClick={() => selectExercise(ex.name)}
                      className="w-full px-4 py-3 text-left text-sm border-b transition-all hover:opacity-80"
                      style={{
                        background: form.exercise_name === ex.name ? 'var(--accent-dim)' : 'var(--bg-card)',
                        borderColor: 'var(--border-subtle)',
                        color: form.exercise_name === ex.name ? 'var(--accent)' : 'var(--text-primary)'
                      }}
                    >
                      {ex.name} {ex.is_custom ? '(custom)' : ''}
                    </button>
                  ))}
                </div>
                {/* Add custom */}
                <div className="flex gap-2 p-2" style={{ background: 'var(--bg-input)' }}>
                  <input
                    type="text"
                    placeholder="Add custom exercise..."
                    value={customInput}
                    onChange={e => setCustomInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addCustomExercise())}
                    className="flex-1 rounded-lg px-3 py-2 text-sm border"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  />
                  <button
                    type="button"
                    onClick={addCustomExercise}
                    className="rounded-lg px-3 py-2 text-sm font-semibold"
                    style={{ background: 'var(--accent)', color: 'black' }}
                  >Add</button>
                </div>
              </div>
            )}

            {/* Selected exercise display */}
            {form.exercise_name && !showExercises && (
              <div className="flex items-center justify-between rounded-xl px-4 py-3"
                style={{ background: 'var(--accent-dim)', borderColor: 'var(--accent)' }}>
                <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>{form.exercise_name}</span>
                <button type="button" onClick={() => { update('exercise_name', ''); setShowExercises(true) }}
                  className="text-xs opacity-60 hover:opacity-100" style={{ color: 'var(--text-muted)' }}>change</button>
              </div>
            )}

            {!form.exercise_name && !showExercises && (
              <button type="button" onClick={() => setShowExercises(true)}
                className="text-xs" style={{ color: 'var(--accent)' }}>
                Show exercises
              </button>
            )}
          </div>
        )}

        {/* Manual exercise name fallback */}
        {!selectedGroup && (
          <input
            type="text"
            placeholder="Exercise name"
            value={form.exercise_name}
            onChange={e => update('exercise_name', e.target.value)}
            className="w-full rounded-xl px-4 py-3 border"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          />
        )}

        {/* Sets / Reps / Weight */}
        <div className="grid grid-cols-3 gap-3">
          {[['sets', 'Sets', '1'], ['reps', 'Reps', '1'], ['weight_lbs', 'Weight (lbs)', '0']].map(([key, label, min]) => (
            <div key={key}>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
              <input
                type="number" min={min} step={key === 'weight_lbs' ? '0.5' : '1'}
                required placeholder={label}
                value={form[key]}
                onChange={e => update(key, e.target.value)}
                className="w-full rounded-xl px-3 py-3 border text-center font-bold text-lg"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              />
            </div>
          ))}
        </div>

        {/* Rest Timer */}
        <div className="rounded-xl p-3 space-y-2" style={{ background: 'var(--bg-input)' }}>
          <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Rest Timer</p>
          <div className="flex gap-2 flex-wrap">
            {REST_PRESETS.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => startTimer(s)}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-all"
                style={timerActive && form.rest_seconds === s && timerRunning
                  ? { background: 'var(--accent)', color: 'black' }
                  : { background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
              >
                {s < 60 ? `${s}s` : `${s / 60}m`}
              </button>
            ))}
          </div>
          {timerActive && (
            <div className="flex items-center gap-3 mt-1">
              <span className="text-2xl font-bold tabular-nums" style={{ color: timerSeconds === 0 ? 'var(--accent)' : 'var(--text-primary)' }}>
                {fmtTime(timerSeconds)}
              </span>
              <button type="button" onClick={timerRunning ? stopTimer : () => setTimerRunning(true)}
                className="rounded-lg px-3 py-1 text-xs font-semibold"
                style={{ background: 'var(--accent)', color: 'black' }}>
                {timerRunning ? 'Pause' : 'Resume'}
              </button>
              <button type="button" onClick={resetTimer}
                className="rounded-lg px-3 py-1 text-xs"
                style={{ color: 'var(--text-muted)' }}>
                Reset
              </button>
              {timerSeconds === 0 && (
                <span className="text-xs font-bold" style={{ color: 'var(--accent)' }}>Rest over!</span>
              )}
            </div>
          )}
        </div>

        <textarea
          rows={2}
          placeholder="Notes (optional)"
          value={form.notes}
          onChange={e => update('notes', e.target.value)}
          className="w-full rounded-xl px-4 py-3 border"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        />

        <button type="submit" className="w-full rounded-xl py-3 font-semibold"
          style={{ background: 'var(--accent)', color: 'black' }}>
          Save Lift
        </button>
      </form>

      {success && <p className="mt-3 text-sm text-green-400">{success}</p>}
      {error && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}
    </div>
  )
}
