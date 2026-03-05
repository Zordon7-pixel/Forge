import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Circle, Dumbbell, Lock, MoonStar, Plus, TrendingUp } from 'lucide-react'
import api from '../lib/api'
import { getRecurringInjuryWarning, scrollToFirstError, validateInjuryLog } from '../utils/validation'

const BODY_PARTS = ['knee', 'hip', 'ankle', 'shin', 'calf', 'hamstring', 'lower back', 'shoulder', 'other']
const COMMON_PT_EXERCISES = [
  'Clamshells',
  'Hip Bridges',
  'Calf Raises',
  'Single-Leg Stance',
  'Monster Walks',
  'Foam Roll IT Band',
  'Eccentric Heel Drops',
]
const MILESTONE_FLOW = [
  { type: 'first_walk', label: 'First Walk' },
  { type: 'first_jog', label: 'First Jog' },
  { type: 'first_run', label: 'First Run' },
  { type: 'pain_free_day', label: 'Pain Free Day' },
]

function painColor(level) {
  if (level <= 3) return '#22c55e'
  if (level <= 6) return '#EAB308'
  return '#ef4444'
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  return `${m}/${d}/${y}`
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num))
}

function getReadinessTone(score) {
  if (score <= 30) return { color: '#ef4444', label: 'Rest needed' }
  if (score <= 60) return { color: '#EAB308', label: 'Light activity OK' }
  if (score <= 80) return { color: '#22c55e', label: 'Return to training' }
  return { color: '#3b82f6', label: 'Full training cleared' }
}

function formatDayLabel(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00`)
  return dt.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 1)
}

function totalSleepSeconds(row) {
  return Number(row?.deep_sleep_seconds || 0)
    + Number(row?.light_sleep_seconds || 0)
    + Number(row?.rem_sleep_seconds || 0)
}

function formatSleepHours(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return '0.0h'
  return `${(totalSeconds / 3600).toFixed(1)}h`
}

function buildSleepSeries(rows, days) {
  const byDate = new Map((rows || []).map((row) => [row.calendar_date, row]))
  const series = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const dt = new Date()
    dt.setHours(0, 0, 0, 0)
    dt.setDate(dt.getDate() - i)
    const date = dt.toISOString().slice(0, 10)
    const row = byDate.get(date) || null
    series.push({
      date,
      label: formatDayLabel(date),
      row,
      totalSeconds: row ? totalSleepSeconds(row) : null,
    })
  }
  return series
}

export default function Injury() {
  const today = new Date().toISOString().slice(0, 10)

  const [activeTab, setActiveTab] = useState('pain')
  const [active, setActive] = useState([])
  const [history, setHistory] = useState([])
  const [allInjuries, setAllInjuries] = useState([])
  const [ptExercises, setPtExercises] = useState([])
  const [milestones, setMilestones] = useState([])
  const [sleepNights, setSleepNights] = useState([])
  const [readiness, setReadiness] = useState({ score: 0, days_since_injury: 0, avg_pain_3d: 0, avg_pain_7d: 0 })
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [showExerciseForm, setShowExerciseForm] = useState(false)
  const [exerciseMessage, setExerciseMessage] = useState('')
  const [celebrateExerciseId, setCelebrateExerciseId] = useState('')
  const [milestoneDates, setMilestoneDates] = useState({
    first_walk: today,
    first_jog: today,
    first_run: today,
    pain_free_day: today,
  })

  const bodyPartErrorRef = useRef(null)
  const painErrorRef = useRef(null)

  const [form, setForm] = useState({ body_part: '', pain_level: '', notes: '', date: today })
  const [exerciseForm, setExerciseForm] = useState({ name: '', sets: 3, reps: 10, notes: '', date: today })

  const loadData = async () => {
    try {
      const [activeRes, allRes, ptRes, milestoneRes, readinessRes, sleepRes] = await Promise.all([
        api.get('/injury/active'),
        api.get('/injury'),
        api.get('/pt/exercises'),
        api.get('/pt/milestones'),
        api.get('/pt/readiness'),
        api.get('/garmin/sleep').catch(() => ({ data: { sleep: [] } })),
      ])
      setActive(activeRes.data?.injuries || [])
      const all = allRes.data?.injuries || []
      setAllInjuries(all)
      setHistory(all.filter(i => i.cleared === 1))
      setPtExercises(ptRes.data?.exercises || [])
      setMilestones(milestoneRes.data?.milestones || [])
      setReadiness(readinessRes.data || { score: 0, days_since_injury: 0, avg_pain_3d: 0, avg_pain_7d: 0 })
      setSleepNights(Array.isArray(sleepRes.data?.sleep) ? sleepRes.data.sleep : [])
    } catch (_) {}
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

  const recurringWarning = useMemo(() => (
    getRecurringInjuryWarning({ bodyPart: form.body_part, injuries: allInjuries })
  ), [form.body_part, allInjuries])

  const milestonesByType = useMemo(() => {
    const map = {}
    milestones.forEach(m => {
      if (!map[m.type]) map[m.type] = m
    })
    return map
  }, [milestones])

  const todayExercises = useMemo(() => (
    ptExercises
      .filter(ex => ex.date === today)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
  ), [ptExercises, today])

  const painTrend7 = useMemo(() => {
    const daily = {}
    allInjuries.forEach(row => {
      if (!row.date) return
      if (!daily[row.date]) daily[row.date] = []
      daily[row.date].push(Number(row.pain_level || 0))
    })

    const days = []
    for (let i = 6; i >= 0; i -= 1) {
      const dt = new Date()
      dt.setDate(dt.getDate() - i)
      const key = dt.toISOString().slice(0, 10)
      const values = daily[key] || []
      const avg = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
      days.push({
        date: key,
        label: formatDayLabel(key),
        pain: Number(avg.toFixed(1)),
      })
    }
    return days
  }, [allInjuries])

  const avgPain3 = useMemo(() => {
    const recent = [...allInjuries]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 3)

    if (!recent.length) return 0
    return recent.reduce((sum, r) => sum + Number(r.pain_level || 0), 0) / recent.length
  }, [allInjuries])

  const allMilestonesAchieved = MILESTONE_FLOW.every(m => !!milestonesByType[m.type])
  const firstWalkAchieved = !!milestonesByType.first_walk
  const sleepTrend7 = useMemo(() => buildSleepSeries(sleepNights, 7), [sleepNights])
  const sleepTrend30 = useMemo(() => buildSleepSeries(sleepNights, 30), [sleepNights])

  const latestSleep = useMemo(() => (
    [...sleepNights]
      .sort((a, b) => String(b.calendar_date || '').localeCompare(String(a.calendar_date || '')))
      .find((row) => totalSleepSeconds(row) > 0) || null
  ), [sleepNights])

  const avgSleepHours7 = useMemo(() => {
    const values = sleepTrend7.map(d => d.totalSeconds).filter(v => Number.isFinite(v) && v > 0)
    if (!values.length) return 0
    return values.reduce((sum, v) => sum + v, 0) / values.length / 3600
  }, [sleepTrend7])

  const avgSleepHours30 = useMemo(() => {
    const values = sleepTrend30.map(d => d.totalSeconds).filter(v => Number.isFinite(v) && v > 0)
    if (!values.length) return 0
    return values.reduce((sum, v) => sum + v, 0) / values.length / 3600
  }, [sleepTrend30])

  const consistentSleepStreak = useMemo(() => {
    let streak = 0
    for (let i = sleepTrend30.length - 1; i >= 0; i -= 1) {
      const hours = Number(sleepTrend30[i].totalSeconds || 0) / 3600
      if (hours >= 7) streak += 1
      else break
    }
    return streak
  }, [sleepTrend30])

  const recoverySleepSignal = useMemo(() => {
    const readinessScore = Number(readiness.score || 0)
    if (avgSleepHours7 >= 7.5 && readinessScore >= 70) return 'Strong recovery signal: sleep + readiness are aligned.'
    if (avgSleepHours7 >= 6.5 && readinessScore >= 50) return 'Stable recovery signal: keep your sleep window consistent.'
    return 'Recovery signal is low: prioritize 7+ hours and lower intensity when possible.'
  }, [avgSleepHours7, readiness.score])

  const adaptiveSuggestion = useMemo(() => {
    if (allMilestonesAchieved) return '🎉 Cleared for full training'
    if (avgPain3 <= 1 && firstWalkAchieved) return '✅ Ready to try a gentle jog'
    if (avgPain3 <= 2 && Number(readiness.days_since_injury || 0) > 7) return '✅ Ready to try a short walk'
    return '📋 Keep up PT exercises and rest'
  }, [allMilestonesAchieved, avgPain3, firstWalkAchieved, readiness.days_since_injury])

  const submitPainLog = async (e) => {
    e.preventDefault()
    const { errors } = validateInjuryLog({ bodyPart: form.body_part, severity: form.pain_level })
    setFieldErrors(errors)

    if (Object.keys(errors).length) {
      scrollToFirstError({ body_part: bodyPartErrorRef, pain_level: painErrorRef }, ['body_part', 'pain_level'])
      return
    }

    setSubmitting(true)
    try {
      await api.post('/injury', {
        body_part: form.body_part,
        pain_level: Number(form.pain_level),
        notes: form.notes,
        date: form.date,
      })
      setForm({ body_part: '', pain_level: '', notes: '', date: today })
      setFieldErrors({})
      setMessage('Injury logged')
      await loadData()
      setTimeout(() => setMessage(''), 2000)
    } catch (_) {
      setMessage('Failed to log injury')
    }
    setSubmitting(false)
  }

  const markCleared = async (id) => {
    try {
      await api.put(`/injury/${id}/clear`)
      await loadData()
    } catch (_) {}
  }

  const addExercise = async (payload) => {
    try {
      await api.post('/pt/exercises', payload)
      setExerciseMessage('Exercise added')
      await loadData()
      setTimeout(() => setExerciseMessage(''), 1500)
    } catch (_) {
      setExerciseMessage('Failed to add exercise')
    }
  }

  const submitExercise = async (e) => {
    e.preventDefault()
    if (!exerciseForm.name.trim()) {
      setExerciseMessage('Exercise name is required')
      return
    }
    await addExercise({
      name: exerciseForm.name.trim(),
      sets: Number(exerciseForm.sets) || 3,
      reps: Number(exerciseForm.reps) || 10,
      completed: false,
      date: exerciseForm.date || today,
      notes: exerciseForm.notes || '',
    })
    setExerciseForm({ name: '', sets: 3, reps: 10, notes: '', date: today })
    setShowExerciseForm(false)
  }

  const toggleExerciseComplete = async (exercise) => {
    const nextCompleted = Number(exercise.completed) ? 0 : 1
    try {
      await api.put(`/pt/exercises/${exercise.id}`, { completed: nextCompleted })
      if (nextCompleted) {
        setCelebrateExerciseId(exercise.id)
        setTimeout(() => setCelebrateExerciseId(''), 450)
      }
      await loadData()
    } catch (_) {}
  }

  const markMilestone = async (type) => {
    try {
      await api.post('/pt/milestone', {
        type,
        date: milestoneDates[type] || today,
        notes: '',
      })
      await loadData()
    } catch (_) {}
  }

  const cardStyle = {
    background: 'var(--bg-card)',
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
    border: '1px solid var(--border-subtle)',
  }

  const sectionLabel = {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 14,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  }

  const inputStyle = {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 14,
    color: 'var(--text-primary)',
    width: '100%',
    boxSizing: 'border-box',
  }

  if (loading) {
    return (
      <div style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 20, color: 'var(--text-muted)' }}>
        Loading...
      </div>
    )
  }

  const readinessScore = clamp(Number(readiness.score || 0), 0, 100)
  const readinessTone = getReadinessTone(readinessScore)

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 16 }}>
        PT Recovery Module
      </h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
        {[
          { key: 'pain', label: 'Pain Log' },
          { key: 'pt', label: 'PT Exercises' },
          { key: 'sleep', label: 'Sleep' },
          { key: 'progress', label: 'Recovery Progress' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              border: `1px solid ${activeTab === tab.key ? 'var(--accent)' : 'var(--border-subtle)'}`,
              background: activeTab === tab.key ? 'var(--accent-dim)' : 'var(--bg-card)',
              color: activeTab === tab.key ? 'var(--accent)' : 'var(--text-primary)',
              borderRadius: 10,
              padding: '10px 8px',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'pain' && (
        <>
          <div style={cardStyle}>
            <div style={sectionLabel}>
              <AlertTriangle size={14} color="#EAB308" />
              Active Injuries
            </div>
            {active.length === 0 ? (
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No active injuries</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {active.map(injury => (
                  <div
                    key={injury.id}
                    style={{
                      background: 'var(--bg-base)',
                      borderRadius: 12,
                      padding: 14,
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                          {String(injury.body_part || '').replace(/_/g, ' ')}
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: '#000',
                            background: painColor(injury.pain_level),
                            borderRadius: 20,
                            padding: '2px 10px',
                          }}
                        >
                          Pain {injury.pain_level}/10
                        </span>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatDate(injury.date)}</span>
                    </div>
                    {injury.notes && (
                      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.4 }}>
                        {injury.notes}
                      </p>
                    )}
                    <button
                      onClick={() => markCleared(injury.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        background: 'rgba(34,197,94,0.1)',
                        border: '1px solid rgba(34,197,94,0.3)',
                        borderRadius: 8,
                        padding: '6px 12px',
                        fontSize: 13,
                        fontWeight: 600,
                        color: '#22c55e',
                        cursor: 'pointer',
                      }}
                    >
                      <CheckCircle2 size={14} />
                      Mark Cleared
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>
              <AlertTriangle size={14} />
              Log New Injury
            </div>
            <form onSubmit={submitPainLog} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                  Body Part
                </label>
                <select
                  value={form.body_part}
                  onChange={e => setForm(prev => ({ ...prev, body_part: e.target.value }))}
                  style={inputStyle}
                >
                  <option value="">Select body part</option>
                  {BODY_PARTS.map(part => (
                    <option key={part} value={part}>
                      {part.charAt(0).toUpperCase() + part.slice(1)}
                    </option>
                  ))}
                </select>
                {fieldErrors.body_part && <p ref={bodyPartErrorRef} style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>{fieldErrors.body_part}</p>}
                {recurringWarning && <p style={{ fontSize: 12, color: '#f59e0b', marginTop: 6 }}>{recurringWarning}</p>}
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                  Pain Level: <span style={{ fontWeight: 700, color: painColor(Number(form.pain_level) || 1) }}>{Number(form.pain_level) || 1}/10</span>
                </label>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={form.pain_level || 1}
                  onChange={e => setForm(prev => ({ ...prev, pain_level: Number(e.target.value) }))}
                  style={{ width: '100%', accentColor: painColor(Number(form.pain_level) || 1) }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                  <span style={{ fontSize: 11, color: '#22c55e' }}>1 Mild</span>
                  <span style={{ fontSize: 11, color: '#EAB308' }}>5 Moderate</span>
                  <span style={{ fontSize: 11, color: '#ef4444' }}>10 Severe</span>
                </div>
                {fieldErrors.pain_level && <p ref={painErrorRef} style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>{fieldErrors.pain_level}</p>}
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                  Date
                </label>
                <input
                  type="date"
                  value={form.date}
                  onChange={e => setForm(prev => ({ ...prev, date: e.target.value }))}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                  Notes
                </label>
                <textarea
                  rows={3}
                  placeholder="Describe the injury, when it started, what aggravates it..."
                  value={form.notes}
                  onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </div>

              {message && (
                <p style={{ fontSize: 13, color: message.startsWith('Failed') ? '#ef4444' : '#22c55e' }}>
                  {message}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                style={{
                  background: '#EAB308',
                  color: '#000',
                  border: 'none',
                  borderRadius: 10,
                  padding: '12px 0',
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.7 : 1,
                }}
              >
                {submitting ? 'Logging...' : 'Log Injury'}
              </button>
            </form>
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>
              <Activity size={14} />
              Injury History
            </div>
            {history.length === 0 ? (
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No injury history yet</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {history.map(injury => (
                  <div
                    key={injury.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: 'var(--bg-base)',
                      borderRadius: 10,
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CheckCircle2 size={14} color="#22c55e" />
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                        {String(injury.body_part || '').replace(/_/g, ' ')}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: '#000',
                          background: painColor(injury.pain_level),
                          borderRadius: 20,
                          padding: '1px 8px',
                        }}
                      >
                        {injury.pain_level}/10
                      </span>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{formatDate(injury.date)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === 'pt' && (
        <>
          <div style={cardStyle}>
            <div style={{ ...sectionLabel, marginBottom: 10 }}>
              <Dumbbell size={14} />
              Today&apos;s PT Checklist
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                onClick={() => setShowExerciseForm(prev => !prev)}
                style={{
                  border: '1px solid var(--accent)',
                  background: 'var(--accent-dim)',
                  color: 'var(--accent)',
                  borderRadius: 10,
                  padding: '8px 12px',
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Plus size={14} />
                Add Exercise
              </button>
            </div>

            {showExerciseForm && (
              <form onSubmit={submitExercise} style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 12, marginBottom: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                  <input
                    placeholder="Exercise name"
                    value={exerciseForm.name}
                    onChange={e => setExerciseForm(prev => ({ ...prev, name: e.target.value }))}
                    style={inputStyle}
                  />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <input
                      type="number"
                      min={1}
                      placeholder="Sets"
                      value={exerciseForm.sets}
                      onChange={e => setExerciseForm(prev => ({ ...prev, sets: e.target.value }))}
                      style={inputStyle}
                    />
                    <input
                      type="number"
                      min={1}
                      placeholder="Reps"
                      value={exerciseForm.reps}
                      onChange={e => setExerciseForm(prev => ({ ...prev, reps: e.target.value }))}
                      style={inputStyle}
                    />
                  </div>
                  <button
                    type="submit"
                    style={{
                      background: '#EAB308',
                      color: '#000',
                      border: 'none',
                      borderRadius: 10,
                      padding: '10px 0',
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Save Exercise
                  </button>
                </div>
              </form>
            )}

            {exerciseMessage && (
              <p style={{ fontSize: 13, color: exerciseMessage.startsWith('Failed') ? '#ef4444' : '#22c55e', marginBottom: 10 }}>
                {exerciseMessage}
              </p>
            )}

            {todayExercises.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No PT exercises logged for today.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {todayExercises.map(exercise => {
                  const complete = Number(exercise.completed) === 1
                  const celebrating = celebrateExerciseId === exercise.id
                  return (
                    <button
                      key={exercise.id}
                      onClick={() => toggleExerciseComplete(exercise)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        borderRadius: 10,
                        border: complete ? '1px solid rgba(34,197,94,0.4)' : '1px solid var(--border-subtle)',
                        background: complete ? 'rgba(34,197,94,0.12)' : 'var(--bg-base)',
                        padding: '12px 14px',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        transition: 'all 180ms ease',
                        transform: celebrating ? 'scale(1.02)' : 'scale(1)',
                        boxShadow: celebrating ? '0 0 0 3px rgba(34,197,94,0.18)' : 'none',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{exercise.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{exercise.sets} sets x {exercise.reps} reps</div>
                      </div>
                      {complete ? <CheckCircle2 size={20} color="#22c55e" /> : <Circle size={20} color="var(--text-muted)" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>Common PT Exercises</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {COMMON_PT_EXERCISES.map(name => (
                <button
                  key={name}
                  onClick={() => addExercise({ name, sets: 3, reps: 10, completed: false, date: today, notes: '' })}
                  style={{
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-base)',
                    color: 'var(--text-primary)',
                    borderRadius: 999,
                    padding: '7px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  + {name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {activeTab === 'sleep' && (
        <>
          <div style={cardStyle}>
            <div style={sectionLabel}>
              <MoonStar size={14} />
              Sleep Recovery Summary
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 12, background: 'var(--bg-base)' }}>
                <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.8 }}>Last Night</p>
                <p style={{ margin: '6px 0 2px', fontSize: 24, fontWeight: 900, color: 'var(--text-primary)' }}>
                  {formatSleepHours(totalSleepSeconds(latestSleep))}
                </p>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{latestSleep?.calendar_date ? formatDate(latestSleep.calendar_date) : 'No Garmin sleep data yet'}</p>
              </div>
              <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 12, background: 'var(--bg-base)' }}>
                <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.8 }}>30-Day Avg</p>
                <p style={{ margin: '6px 0 2px', fontSize: 24, fontWeight: 900, color: avgSleepHours30 >= 7 ? '#22c55e' : '#EAB308' }}>
                  {avgSleepHours30 ? `${avgSleepHours30.toFixed(1)}h` : '--'}
                </p>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>7-day avg: {avgSleepHours7 ? `${avgSleepHours7.toFixed(1)}h` : '--'}</p>
              </div>
            </div>

            <div style={{ marginTop: 12, borderRadius: 12, border: `1px solid ${consistentSleepStreak >= 4 ? 'rgba(34,197,94,0.35)' : 'var(--border-subtle)'}`, padding: '10px 12px', background: consistentSleepStreak >= 4 ? 'rgba(34,197,94,0.08)' : 'var(--bg-base)' }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: consistentSleepStreak >= 4 ? '#22c55e' : 'var(--text-primary)' }}>
                {consistentSleepStreak >= 4 ? 'Consistency Badge: Sleep Streak Active' : 'Consistency Badge: Build Your Streak'}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                {consistentSleepStreak} consecutive {consistentSleepStreak === 1 ? 'night' : 'nights'} with 7h+ sleep
              </p>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>Nightly Breakdown (30 Nights)</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: '#6366f1' }}>Deep</span>
              <span style={{ fontSize: 11, color: '#60a5fa' }}>Light</span>
              <span style={{ fontSize: 11, color: '#a855f7' }}>REM</span>
              <span style={{ fontSize: 11, color: '#f59e0b' }}>Awake</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Gap = OFF_WRIST / no data</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 4, height: 128 }}>
              {sleepTrend30.map((day) => {
                if (!day.row) {
                  return (
                    <div key={day.date} style={{ flex: 1, borderRadius: 6, border: '1px dashed var(--border-subtle)', height: 22, background: 'var(--bg-base)' }} title={`${day.date}: no sleep data`} />
                  )
                }
                const deep = Number(day.row.deep_sleep_seconds || 0)
                const light = Number(day.row.light_sleep_seconds || 0)
                const rem = Number(day.row.rem_sleep_seconds || 0)
                const awake = Number(day.row.awake_seconds || 0)
                const total = Math.max(1, deep + light + rem + awake)
                const maxHeight = 116
                return (
                  <div key={day.date} style={{ flex: 1, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-subtle)', height: maxHeight, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: 'var(--bg-base)' }} title={`${day.date}: ${formatSleepHours(day.totalSeconds || 0)}`}>
                    <div style={{ height: `${Math.round((awake / total) * maxHeight)}px`, background: '#f59e0b', opacity: 0.8 }} />
                    <div style={{ height: `${Math.round((rem / total) * maxHeight)}px`, background: '#a855f7', opacity: 0.9 }} />
                    <div style={{ height: `${Math.round((light / total) * maxHeight)}px`, background: '#60a5fa', opacity: 0.9 }} />
                    <div style={{ height: `${Math.round((deep / total) * maxHeight)}px`, background: '#6366f1', opacity: 0.95 }} />
                  </div>
                )
              })}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>7-Day Sleep Trend</div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8, height: 120 }}>
              {sleepTrend7.map((day) => {
                const hours = Number(day.totalSeconds || 0) / 3600
                const barHeight = day.totalSeconds ? Math.max(8, Math.round((hours / 10) * 90)) : 6
                return (
                  <div key={day.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{day.totalSeconds ? `${hours.toFixed(1)}h` : '-'}</div>
                    <div style={{ width: '100%', maxWidth: 28, height: barHeight, borderRadius: 8, background: day.totalSeconds ? (hours >= 7 ? '#22c55e' : '#EAB308') : 'transparent', border: day.totalSeconds ? 'none' : '1px dashed var(--border-subtle)', opacity: 0.9 }} />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{day.label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>30-Day Sleep Trend + PT Recovery</div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 4, height: 84, marginBottom: 10 }}>
              {sleepTrend30.map((day) => {
                const hours = Number(day.totalSeconds || 0) / 3600
                const height = day.totalSeconds ? Math.max(4, Math.round((hours / 10) * 72)) : 2
                return (
                  <div key={day.date} style={{ flex: 1, height, borderRadius: 3, background: day.totalSeconds ? (hours >= 7 ? '#22c55e' : '#EAB308') : 'var(--border-subtle)', opacity: day.totalSeconds ? 0.9 : 0.4 }} />
                )
              })}
            </div>
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '10px 12px', background: 'var(--bg-base)' }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>PT Recovery Tie-In</p>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.4 }}>{recoverySleepSignal}</p>
            </div>
          </div>
        </>
      )}

      {activeTab === 'progress' && (
        <>
          <div style={cardStyle}>
            <div style={sectionLabel}>
              <TrendingUp size={14} />
              Recovery Readiness
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
              <div
                style={{
                  width: 104,
                  height: 104,
                  borderRadius: '50%',
                  background: `conic-gradient(${readinessTone.color} ${readinessScore}%, rgba(255,255,255,0.12) 0)`,
                  display: 'grid',
                  placeItems: 'center',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    width: 78,
                    height: 78,
                    borderRadius: '50%',
                    background: 'var(--bg-card)',
                    display: 'grid',
                    placeItems: 'center',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: readinessTone.color, lineHeight: 1 }}>{readinessScore}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>of 100</div>
                  </div>
                </div>
              </div>
              <div>
                <p style={{ fontSize: 16, fontWeight: 800, color: readinessTone.color, marginBottom: 4 }}>{readinessTone.label}</p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Days since injury: {readiness.days_since_injury || 0}</p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Avg pain (3 days): {Number(readiness.avg_pain_3d || 0).toFixed(1)}</p>
              </div>
            </div>

            <div
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 12,
                padding: '10px 12px',
                background: 'var(--bg-base)',
                color: 'var(--text-primary)',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {adaptiveSuggestion}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>Pain Trend (7 Days)</div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8, height: 100 }}>
              {painTrend7.map(day => {
                const barHeight = Math.max(6, Math.round((day.pain / 10) * 84))
                return (
                  <div key={day.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <div
                      title={`${day.date}: ${day.pain}/10`}
                      style={{
                        width: '100%',
                        maxWidth: 28,
                        height: barHeight,
                        borderRadius: 8,
                        background: painColor(day.pain || 0),
                        opacity: day.pain === 0 ? 0.25 : 0.9,
                        transition: 'height 160ms ease',
                      }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{day.label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>Recovery Milestones</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {MILESTONE_FLOW.map((m, index) => {
                const achieved = !!milestonesByType[m.type]
                const previous = MILESTONE_FLOW[index - 1]
                const locked = !!previous && !milestonesByType[previous.type]
                return (
                  <div
                    key={m.type}
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 12,
                      padding: 12,
                      background: locked ? 'rgba(148,163,184,0.08)' : 'var(--bg-base)',
                      opacity: locked ? 0.6 : 1,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {locked ? <Lock size={14} color="var(--text-muted)" /> : achieved ? <CheckCircle2 size={14} color="#22c55e" /> : <Circle size={14} color="var(--text-muted)" />}
                        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{m.label}</span>
                      </div>
                      {achieved && <span style={{ fontSize: 12, color: '#22c55e' }}>{formatDate(milestonesByType[m.type].date)}</span>}
                    </div>
                    {!locked && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="date"
                          value={milestoneDates[m.type] || today}
                          onChange={e => setMilestoneDates(prev => ({ ...prev, [m.type]: e.target.value }))}
                          style={{ ...inputStyle, padding: '8px 10px', fontSize: 13 }}
                        />
                        <button
                          onClick={() => markMilestone(m.type)}
                          style={{
                            border: '1px solid rgba(34,197,94,0.3)',
                            background: achieved ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.08)',
                            color: '#22c55e',
                            borderRadius: 8,
                            padding: '8px 10px',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {achieved ? 'Update' : 'Mark Achieved'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
