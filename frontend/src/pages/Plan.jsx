import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'

const badgeStyles = {
  run: 'bg-orange-500/20 text-orange-300',
  rest: 'bg-gray-500/20 text-gray-300',
  'cross-train': 'bg-amber-500/20 text-amber-300',
  strength: 'bg-purple-500/20 text-purple-300'
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

  useEffect(() => {
    loadPlan()
  }, [])

  const weeklyStructure = useMemo(() => {
    if (!plan?.weekly_structure) return []
    if (Array.isArray(plan.weekly_structure)) return plan.weekly_structure
    try {
      return JSON.parse(plan.weekly_structure)
    } catch {
      return []
    }
  }, [plan])

  const regenerate = async () => {
    setRegenerating(true)
    try {
      await api.post('/plans/generate')
      await loadPlan()
    } finally {
      setRegenerating(false)
    }
  }

  if (loading) return <div className="rounded-xl bg-[#111318] p-4 text-gray-300">Loading your training data...</div>

  if (!plan) {
    return (
      <div className="rounded-2xl bg-[#111318] p-5 text-center">
        <div className="flex flex-col items-center justify-center gap-4 py-8">
          <img src="/empty-plan.png" alt="" className="h-40 w-40 object-contain opacity-90" />
          <p className="text-sm font-medium text-slate-400">No training plan yet.</p>
          <p className="text-xs text-slate-600">Generate one to get started.</p>
        </div>
        <button onClick={regenerate} className="rounded-xl bg-orange-500 px-4 py-2 font-semibold text-white">
          Generate
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[#111318] p-4">
        <h2 className="text-xl font-bold">{plan.title || 'Your Plan'}</h2>
        <p className="mt-1 text-sm text-gray-400">Goal: {plan.goal || '--'}</p>
      </div>

      <div className="space-y-3">
        {weeklyStructure.map((day, idx) => {
          const rawType = (day.workout_type || day.type || '').toString().toLowerCase()
          const typeKey = rawType.includes('cross')
            ? 'cross-train'
            : rawType.includes('strength')
              ? 'strength'
              : rawType.includes('rest')
                ? 'rest'
                : 'run'

          return (
            <div key={idx} className="rounded-xl bg-[#111318] p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="font-semibold text-white">{day.day || `Day ${idx + 1}`}</p>
                <span className={`rounded-full px-2 py-1 text-xs ${badgeStyles[typeKey]}`}>
                  {day.workout_type || day.type || 'Run'}
                </span>
              </div>
              <p className="text-sm text-gray-300">{day.description || 'No description.'}</p>
            </div>
          )
        })}
      </div>

      <button
        onClick={regenerate}
        disabled={regenerating}
        className="w-full rounded-xl border border-white/20 bg-[#111318] py-3 font-semibold text-white disabled:opacity-60"
      >
        {regenerating ? 'Regenerating...' : '🔄 Regenerate Plan'}
      </button>
    </div>
  )
}
