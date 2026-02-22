import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'

const badgeStyles = {
  run: { background: 'var(--accent-dim)', color: 'var(--accent)' },
  rest: { background: 'rgba(107,114,128,0.15)', color: 'var(--text-muted)' },
  'cross-train': { background: 'rgba(245,158,11,0.18)', color: '#f59e0b' },
  strength: { background: 'var(--accent-dim)', color: 'var(--accent)' }
}

export default function Plan() {
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)

  const loadPlan = async () => {
    try {
      const res = await api.get('/plans/current')
      setPlan(res.data?.plan || res.data || null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadPlan() }, [])

  const weeklyStructure = useMemo(() => {
    if (!plan?.weekly_structure) return []
    if (Array.isArray(plan.weekly_structure)) return plan.weekly_structure
    try { return JSON.parse(plan.weekly_structure) } catch { return [] }
  }, [plan])

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
