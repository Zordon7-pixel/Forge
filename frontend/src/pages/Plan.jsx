import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import api from '../lib/api'

const badgeStyles = {
  run: { background: 'var(--accent-dim)', color: 'var(--accent)' },
  rest: { background: 'rgba(107,114,128,0.15)', color: 'var(--text-muted)' },
  'cross-train': { background: 'rgba(245,158,11,0.18)', color: '#f59e0b' },
  strength: { background: 'var(--accent-dim)', color: 'var(--accent)' }
}

export default function Plan() {
  const navigate = useNavigate()
  const location = useLocation()
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [runBriefs, setRunBriefs] = useState({})
  const [compliance, setCompliance] = useState(null)
  const [reschedulingId, setReschedulingId] = useState(null)

  const loadPlan = async () => {
    try {
      const [res, comp] = await Promise.all([
        api.get('/plans/current'),
        api.get('/plans/compliance').catch(() => ({ data: null }))
      ])
      setPlan(res.data?.plan || res.data || null)
      setCompliance(comp.data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadPlan() }, [])

  const showEasyDaySuggestion = Boolean(location.state?.suggestEasyDay)

  const weeklyStructure = useMemo(() => {
    if (plan?.plan_json?.weeks?.[0]?.days) return plan.plan_json.weeks[0].days
    if (!plan?.weekly_structure) return []
    if (Array.isArray(plan.weekly_structure)) return plan.weekly_structure
    try { return JSON.parse(plan.weekly_structure) } catch { return [] }
  }, [plan])


  useEffect(() => {
    const runDays = weeklyStructure.filter((d) => {
      const t = (d.workout_type || d.type || '').toLowerCase()
      return !t.includes('rest') && !t.includes('strength') && !t.includes('cross')
    })
    runDays.forEach((d, i) => {
      api.get(`/ai/run-brief?sessionId=${d.id || i}`).then((r) => {
        setRunBriefs((prev) => ({ ...prev, [d.id || i]: r.data }))
      }).catch(() => {})
    })
  }, [weeklyStructure])

  const regenerate = async () => {
    setRegenerating(true)
    try { await api.post('/plans/generate'); await loadPlan() } finally { setRegenerating(false) }
  }

  const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' })

  if (loading) return <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>Loading your training data...</div>

  if (!plan) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <img src="/empty-plan.png" alt="" className="w-64 h-64 object-contain" />
        <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>No training plan yet.</p>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Generate one to get started.</p>
        <button
          onClick={regenerate}
          className="mt-2 rounded-xl px-6 py-3 font-semibold text-black"
          style={{ background: 'var(--accent)' }}
        >
          Generate Plan
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{plan.title || 'Your Plan'}</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Goal: {plan.goal || '--'}</p>
      </div>

      {showEasyDaySuggestion && (
        <div className="rounded-xl p-3" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Recovery suggestion: replace today with an easy 20-30 minute run.</p>
        </div>
      )}

      {compliance?.missed?.length > 0 && (
        <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Missed sessions</p>
          <div className="space-y-2">
            {compliance.missed.map((m) => (
              <div key={m.sessionId} className="flex items-center justify-between">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{m.day} · {m.type} {m.distance ? `· ${m.distance} mi` : ''}</p>
                <button
                  onClick={async () => {
                    setReschedulingId(m.sessionId)
                    await api.post('/plans/reschedule-missed', { originalDate: m.date, sessionId: m.sessionId })
                    await loadPlan()
                    setReschedulingId(null)
                  }}
                  className="rounded-lg px-2 py-1 text-xs font-semibold"
                  style={{ background: 'var(--accent)', color: '#000' }}
                >
                  {reschedulingId === m.sessionId ? 'Rescheduling...' : 'Reschedule'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {weeklyStructure.map((day, idx) => {
          const rawType = (day.workout_type || day.type || '').toString().toLowerCase()
          const typeKey = rawType.includes('cross') ? 'cross-train' : rawType.includes('strength') ? 'strength' : rawType.includes('rest') ? 'rest' : 'run'
          const isToday = (day.day || '').toLowerCase().includes(todayName.toLowerCase())

          return (
            <div key={idx} className="rounded-xl border p-4" style={isToday ? { borderColor: 'var(--accent)', background: 'linear-gradient(135deg, rgba(234,179,8,0.12) 0%, var(--bg-card) 100%)' } : { borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{day.day || `Day ${idx + 1}`}</p>
                  {isToday ? <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: 'var(--accent)', color: 'black' }}>TODAY</span> : null}
                </div>
                <span className="rounded-full px-2 py-1 text-xs" style={badgeStyles[typeKey]}>{day.workout_type || day.type || 'Run'}</span>
              </div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{day.description || 'No description.'}</p>
              {runBriefs[day.id || idx] && (
                <div className="mt-2 rounded-lg p-2" style={{ background: 'var(--bg-input)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-primary)' }}>{runBriefs[day.id || idx].why}</p>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Effort: {runBriefs[day.id || idx].effort} · BPM: {runBriefs[day.id || idx].bpmRange} · Cadence: {runBriefs[day.id || idx].cadence}</p>
                </div>
              )}
              {isToday && (
                <div style={{ marginTop: 12 }}>
                  {(() => {
                    const type = (day.workout_type || day.type || '').toLowerCase()
                    const isRest = type.includes('rest')
                    const isStrength = type.includes('strength') || type.includes('lift') || type.includes('cross')
                    
                    return (
                      <button
                        onClick={() => {
                          if (!isRest) {
                            if (isStrength) {
                              navigate('/log-lift')
                            } else {
                              navigate('/log-run')
                            }
                          }
                        }}
                        style={{
                          width: '100%',
                          padding: '14px',
                          background: isRest ? 'var(--bg-input)' : 'var(--accent)',
                          color: isRest ? 'var(--text-muted)' : '#000',
                          fontWeight: 900,
                          fontSize: 15,
                          borderRadius: 12,
                          border: 'none',
                          cursor: isRest ? 'default' : 'pointer',
                        }}
                      >
                        {isRest ? 'Rest Day — Take it easy' : isStrength ? 'Log Workout' : 'Start Run'}
                      </button>
                    )
                  })()}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button onClick={regenerate} disabled={regenerating} className="w-full rounded-xl border py-3 font-semibold disabled:opacity-60" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
        {regenerating ? 'Regenerating...' : 'Regenerate Plan'}
      </button>
    </div>
  )
}
