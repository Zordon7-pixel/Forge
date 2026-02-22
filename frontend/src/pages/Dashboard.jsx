import React, { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'

function useCountUp(target, duration = 1000) {
  const [count, setCount] = React.useState(0)

  React.useEffect(() => {
    if (!target) {
      setCount(0)
      return
    }

    let start = 0
    const step = target / (duration / 16)
    const timer = setInterval(() => {
      start += step
      if (start >= target) {
        setCount(target)
        clearInterval(timer)
      } else {
        setCount(Math.floor(start))
      }
    }, 16)

    return () => clearInterval(timer)
  }, [target, duration])

  return count
}

function formatDuration(totalSeconds = 0) {
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function formatPace(durationSeconds, distance) {
  if (!durationSeconds || !distance) return '--'
  const pace = durationSeconds / 60 / distance
  const mins = Math.floor(pace)
  const secs = Math.round((pace - mins) * 60)
  return `${mins}:${String(secs).padStart(2, '0')} /mi`
}

export default function Dashboard() {
  const [warning, setWarning] = useState(false)
  const [runs, setRuns] = useState([])
  const [allRuns, setAllRuns] = useState([])
  const [coachMode, setCoachMode] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const [meRes, warningRes, runsRes, allRunsRes] = await Promise.all([
          api.get('/auth/me'),
          api.get('/coach/warning'),
          api.get('/runs', { params: { limit: 3 } }),
          api.get('/runs')
        ])

        setWarning(warningRes.data?.warning === true)
        setCoachMode(meRes.data?.user?.coach_personality || '')
        const runsData = Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || []
        const allRunsData = Array.isArray(allRunsRes.data) ? allRunsRes.data : allRunsRes.data?.runs || []
        setRuns(runsData)
        setAllRuns(allRunsData)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const thisWeekMiles = useMemo(() => {
    const now = new Date()
    const day = now.getDay()
    const start = new Date(now)
    start.setDate(now.getDate() - day)
    start.setHours(0, 0, 0, 0)

    return allRuns
      .filter(run => new Date(run.date || run.created_at) >= start)
      .reduce((sum, run) => sum + Number(run.distance_miles || 0), 0)
  }, [allRuns])

  const totalMiles = useMemo(() => allRuns.reduce((sum, run) => sum + Number(run.distance_miles || 0), 0), [allRuns])

  const bestPace = useMemo(() => {
    const paces = allRuns
      .map(run => {
        if (!run.distance_miles || !run.duration_seconds) return null
        return run.duration_seconds / 60 / run.distance_miles
      })
      .filter(Boolean)

    if (!paces.length) return '--'
    const min = Math.min(...paces)
    const mins = Math.floor(min)
    const secs = Math.round((min - mins) * 60)
    return `${mins}:${String(secs).padStart(2, '0')} /mi`
  }, [allRuns])

  const streak = useMemo(() => {
    if (!allRuns.length) return 0
    const dates = [...new Set(allRuns.map(r => r.date || r.created_at?.slice(0, 10)))].sort().reverse()
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    if (dates[0] !== today && dates[0] !== yesterday) return 0
    let count = 1
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1])
      const curr = new Date(dates[i])
      const diff = Math.round((prev - curr) / 86400000)
      if (diff === 1) count++
      else break
    }
    return count
  }, [allRuns])

  const greeting = useMemo(() => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning,'
    if (hour < 18) return 'Good afternoon,'
    return 'Good evening,'
  }, [])

  const COACH_LABELS = {
    mentor: 'Mentor',
    hype_coach: 'Hype Coach',
    drill_sergeant: 'Drill Sergeant',
    training_partner: 'Training Partner'
  }

  const weeklyMilesCount = useCountUp(Math.floor(thisWeekMiles * 10), 900)
  const totalRunsCount = useCountUp(allRuns.length, 900)
  const totalMilesCount = useCountUp(Math.floor(totalMiles * 10), 900)

  if (loading) {
    return <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>Loading your training data...</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{greeting}</p>
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Ready to forge your next PR?</h2>
        {coachMode && <p className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>Coach mode: {COACH_LABELS[coachMode] || coachMode}</p>}
      </div>

      {streak > 0 && (
        <div className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
          {streak}-day streak
        </div>
      )}

      {warning && (
        <div className="rounded-xl border p-3 text-sm" style={{ borderColor: 'var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)' }}>
          Heavy legs detected — consider a rest day
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['Weekly Miles', `${(weeklyMilesCount / 10).toFixed(1)} mi`], ['Total Runs', `${totalRunsCount}`], ['Total Miles', `${(totalMilesCount / 10).toFixed(1)} mi`], ['Best Pace', bestPace]].map(([label, value]) => (
          <div key={label} className="rounded-xl p-3" style={{ background: 'linear-gradient(135deg, rgba(234,179,8,0.12) 0%, var(--bg-card) 100%)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</p>
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
          </div>
        ))}
      </div>

      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <h3 className="mb-3 text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Recent Runs</h3>
        <div className="space-y-3">
          {runs.slice(0, 3).map(run => (
            <div key={run.id} className="cursor-pointer rounded-xl border p-3 transition-all duration-150 hover:scale-[1.01]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{new Date(run.date || run.created_at).toLocaleDateString()}</p>
                <span className="rounded-full px-2 py-1 text-xs" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
                  {formatPace(run.duration_seconds, run.distance_miles)}
                </span>
              </div>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {Number(run.distance_miles || 0).toFixed(2)} mi · {formatDuration(run.duration_seconds)}
              </p>
            </div>
          ))}
          {runs.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>No runs logged yet.</p>}
        </div>
      </section>

    </div>
  )
}
