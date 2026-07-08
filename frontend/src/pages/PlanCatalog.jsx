import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, SlidersHorizontal, X } from 'lucide-react'
import api from '../lib/api'
import { useProContext } from '../context/ProContext'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const PLAN_GOALS = [
  { key: '5k', name: '5K', distanceMiles: 3.1, duration: '6-8 weeks', minWeeks: 6, maxWeeks: 8, feel: 'Fast, sharp, repeatable' },
  { key: '10k', name: '10K', distanceMiles: 6.2, duration: '8-10 weeks', minWeeks: 8, maxWeeks: 10, feel: 'Speed with stamina' },
  { key: 'half', name: 'Half Marathon', distanceMiles: 13.1, duration: '10-14 weeks', minWeeks: 10, maxWeeks: 14, feel: 'Durable aerobic build' },
  { key: 'marathon', name: 'Marathon', distanceMiles: 26.2, duration: '14-18 weeks', minWeeks: 14, maxWeeks: 18, feel: 'Long-range endurance' },
  { key: 'custom', name: 'Custom', distanceMiles: null, duration: 'Flexible', minWeeks: 4, maxWeeks: 20, feel: 'Set your own target' },
]

function parseGoalTime(value) {
  const raw = String(value || '').trim()
  if (!raw) return undefined
  const parts = raw.split(':').filter(Boolean)
  if (!parts.length) return undefined
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null

  const numbers = parts.map(Number)
  if (numbers.some((part) => Number.isNaN(part) || part < 0)) return null

  if (numbers.length === 1) {
    const compact = parts[0]
    if (compact.length >= 3) {
      const minutes = Number(compact.slice(-2))
      const hours = Number(compact.slice(0, -2))
      if (minutes < 60) return hours * 3600 + minutes * 60
    }
    return numbers[0] * 60
  }
  if (numbers.length === 2) {
    if (numbers[1] >= 60) return null
    return numbers[0] <= 12 ? numbers[0] * 3600 + numbers[1] * 60 : numbers[0] * 60 + numbers[1]
  }
  if (numbers[1] >= 60 || numbers[2] >= 60) return null
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
}

function sortDays(days) {
  return [...new Set(days)].filter((day) => DAYS.includes(day)).sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b))
}

export default function PlanCatalog() {
  const navigate = useNavigate()
  const { isPro, loading: proLoading } = useProContext()
  const [selectedGoal, setSelectedGoal] = useState(null)
  const [prefillLoading, setPrefillLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [trainingDays, setTrainingDays] = useState(['Tue', 'Thu', 'Sat'])
  const [liftingEnabled, setLiftingEnabled] = useState(false)
  const [liftDaysPerWeek, setLiftDaysPerWeek] = useState(0)
  const [weeks, setWeeks] = useState('')
  const [goalTime, setGoalTime] = useState('')
  const [customDistance, setCustomDistance] = useState('')

  const selectedDistance = useMemo(() => {
    if (!selectedGoal) return ''
    return selectedGoal.key === 'custom' ? Number(customDistance || 0) : selectedGoal.distanceMiles
  }, [customDistance, selectedGoal])

  const openGoal = async (goal) => {
    if (proLoading) return
    if (isPro !== true) {
      navigate('/upgrade')
      return
    }

    setSelectedGoal(goal)
    setError('')
    setGoalTime('')
    setWeeks('')
    setCustomDistance(goal.key === 'custom' ? '' : String(goal.distanceMiles))
    setPrefillLoading(true)

    try {
      const { data } = await api.get('/plans/prefill')
      setTrainingDays(sortDays(data?.inferredTrainingDays || ['Tue', 'Thu', 'Sat']))
      setLiftingEnabled(Boolean(data?.liftingEnabled))
      setLiftDaysPerWeek(Number(data?.liftDaysPerWeek || 0))
    } catch (err) {
      if (err?.response?.status === 402) {
        navigate('/upgrade')
        return
      }
      setError(err?.response?.data?.error || 'Could not load your plan preferences. You can still edit and generate.')
    } finally {
      setPrefillLoading(false)
    }
  }

  const toggleDay = (day) => {
    setTrainingDays((prev) => {
      const next = prev.includes(day) ? prev.filter((item) => item !== day) : [...prev, day]
      return sortDays(next)
    })
  }

  const generatePlan = async () => {
    const goalTimeSeconds = parseGoalTime(goalTime)
    const parsedWeeks = Number(weeks)
    const distanceMiles = Number(selectedDistance)

    if (!distanceMiles || distanceMiles <= 0) {
      setError('Enter a target distance before generating.')
      return
    }
    if (goalTimeSeconds === null) {
      setError('Use hh:mm:ss, mm:ss, or minutes for your PR goal.')
      return
    }
    if (weeks && (!Number.isInteger(parsedWeeks) || parsedWeeks <= 0)) {
      setError('Weeks must be a whole number.')
      return
    }
    if (!trainingDays.length) {
      setError('Choose at least one training day.')
      return
    }

    setGenerating(true)
    setError('')
    try {
      const target = {
        templateKey: selectedGoal.key,
        templateName: selectedGoal.name,
        distanceMiles,
        trainingDays,
        runDaysPerWeek: trainingDays.length,
        liftingEnabled,
        liftDaysPerWeek: liftingEnabled ? Math.max(1, Number(liftDaysPerWeek || 2)) : 0,
      }
      if (goalTimeSeconds) target.goalTimeSeconds = goalTimeSeconds
      if (weeks) target.weeks = parsedWeeks

      await api.post('/plans/generate', { target })
      navigate('/plan')
    } catch (err) {
      if (err?.response?.status === 402) {
        navigate('/upgrade')
        return
      }
      setError(err?.response?.data?.error || 'Unable to generate this plan right now.')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div style={{ paddingBottom: 112 }}>
      <header style={{ marginBottom: 18 }}>
        <p style={{ color: '#EAB308', fontSize: 12, fontWeight: 900, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Plan Catalog</p>
        <h1 style={{ color: 'var(--text-primary)', fontSize: 30, fontWeight: 950, margin: 0 }}>Build your next block.</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 8, maxWidth: 520 }}>
          Pick a goal, tune your availability, then generate a plan around the days you can actually train.
        </p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {PLAN_GOALS.map((goal) => (
          <button
            key={goal.key}
            type="button"
            onClick={() => openGoal(goal)}
            className="rounded-xl p-4"
            style={{
              minHeight: 150,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              cursor: 'pointer',
            }}
          >
            <span>
              <span style={{ display: 'block', fontSize: 24, fontWeight: 950, letterSpacing: 0 }}>{goal.name}</span>
              <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 13, fontWeight: 800, marginTop: 6 }}>{goal.duration}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: '#EAB308', fontSize: 13, fontWeight: 900 }}>{goal.feel}</span>
              <ChevronRight size={20} color="#EAB308" />
            </span>
          </button>
        ))}
      </div>

      {selectedGoal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            background: 'rgba(0,0,0,0.62)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            padding: 12,
          }}
        >
          <div
            className="rounded-xl p-4"
            style={{
              width: 'min(640px, 100%)',
              maxHeight: '88vh',
              overflowY: 'auto',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
              <div>
                <p style={{ color: '#EAB308', fontSize: 12, fontWeight: 900, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>Confirm Target</p>
                <h2 style={{ color: 'var(--text-primary)', fontSize: 24, fontWeight: 950, margin: 0 }}>{selectedGoal.name}</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>{selectedGoal.duration} / {selectedGoal.feel}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedGoal(null)}
                aria-label="Close plan options"
                style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 10, color: 'var(--text-primary)' }}
              >
                <X size={18} />
              </button>
            </div>

            {prefillLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>Loading your usual training rhythm...</p>}
            {error && <div className="rounded-xl p-3" style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: '#FCA5A5', fontSize: 13, fontWeight: 700, marginBottom: 12 }}>{error}</div>}

            <div style={{ display: 'grid', gap: 14 }}>
              {selectedGoal.key === 'custom' && (
                <label style={{ display: 'grid', gap: 8 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Distance miles</span>
                  <input
                    value={customDistance}
                    onChange={(event) => setCustomDistance(event.target.value)}
                    inputMode="decimal"
                    placeholder="8.0"
                    style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '12px 14px', fontSize: 16 }}
                  />
                </label>
              )}

              <section>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Training days</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 800 }}>{trainingDays.length} days/week</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 7 }}>
                  {DAYS.map((day) => {
                    const active = trainingDays.includes(day)
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleDay(day)}
                        style={{
                          minHeight: 44,
                          borderRadius: 10,
                          border: `1px solid ${active ? '#EAB308' : 'var(--border-subtle)'}`,
                          background: active ? 'rgba(234,179,8,0.14)' : 'var(--bg-input)',
                          color: active ? '#EAB308' : 'var(--text-muted)',
                          fontSize: 12,
                          fontWeight: 950,
                        }}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
              </section>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <label style={{ display: 'grid', gap: 8 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>PR goal time</span>
                  <input
                    value={goalTime}
                    onChange={(event) => setGoalTime(event.target.value)}
                    placeholder="hh:mm:ss optional"
                    inputMode="numeric"
                    style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '12px 14px', fontSize: 16 }}
                  />
                </label>
                <label style={{ display: 'grid', gap: 8 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Weeks</span>
                  <input
                    value={weeks}
                    onChange={(event) => setWeeks(event.target.value)}
                    placeholder="optional"
                    inputMode="numeric"
                    style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '12px 14px', fontSize: 16 }}
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={() => setLiftingEnabled((value) => !value)}
                className="rounded-xl p-4"
                style={{
                  background: 'var(--bg-input)',
                  border: `1px solid ${liftingEnabled ? '#EAB308' : 'var(--border-subtle)'}`,
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <SlidersHorizontal size={18} color="#EAB308" />
                  <span>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 900 }}>Include lifting</span>
                    <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>Strength work follows your generated run plan.</span>
                  </span>
                </span>
                <span style={{ color: liftingEnabled ? '#EAB308' : 'var(--text-muted)', fontSize: 12, fontWeight: 950 }}>{liftingEnabled ? 'ON' : 'OFF'}</span>
              </button>

              <button
                type="button"
                onClick={generatePlan}
                disabled={generating || prefillLoading}
                className="rounded-xl p-4"
                style={{ background: '#EAB308', color: '#000', border: 'none', fontSize: 15, fontWeight: 950, opacity: generating || prefillLoading ? 0.65 : 1 }}
              >
                {generating ? 'Generating...' : 'Generate Plan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
