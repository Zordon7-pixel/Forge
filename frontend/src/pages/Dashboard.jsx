import React, { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'
import MuscleDiagram from '../components/MuscleDiagram'

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
  const [lifts, setLifts] = useState([])
  const [coachMode, setCoachMode] = useState('')
  const [userName, setUserName] = useState('Athlete')
  const [sex, setSex] = useState('male')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const [meRes, warningRes, runsRes, allRunsRes, liftsRes] = await Promise.all([
          api.get('/auth/me'),
          api.get('/coach/warning'),
          api.get('/runs', { params: { limit: 3 } }),
          api.get('/runs'),
          api.get('/lifts')
        ])

        setWarning(warningRes.data?.warning === true)
        setCoachMode(meRes.data?.user?.coach_personality || '')
        setUserName(meRes.data?.user?.name || 'Athlete')
        setSex(meRes.data?.user?.sex || 'male')
        const runsData = Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || []
        const allRunsData = Array.isArray(allRunsRes.data) ? allRunsRes.data : allRunsRes.data?.runs || []
        const liftsData = Array.isArray(liftsRes.data) ? liftsRes.data : liftsRes.data?.lifts || []
        setRuns(runsData)
        setAllRuns(allRunsData)
        setLifts(liftsData)
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

  const recentActivity = useMemo(() => {
    const runItems = runs.map(run => ({
      type: 'run',
      id: run.id,
      date: run.date || run.created_at,
      data: run
    }))
    const liftItems = lifts.map(lift => ({
      type: 'lift',
      id: lift.id,
      date: lift.date || lift.created_at,
      data: lift
    }))
    return [...runItems, ...liftItems]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 3)
  }, [runs, lifts])

  if (loading) {
    return <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>Loading your training data...</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{greeting}</p>
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{userName}</h2>
        {coachMode && <p className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>Coach mode: {COACH_LABELS[coachMode] || coachMode}</p>}
      </div>

      {allRuns.length === 0 && lifts.length === 0 && (
        <div className="rounded-xl border-l-4 p-4" style={{ borderColor: 'var(--accent)', background: 'var(--bg-card)' }}>
          <p className="text-base font-bold mb-1" style={{ color: 'var(--accent)' }}>FORGE beats the rest.</p>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            AI coaching that adapts to YOU — not generic plans. Real-time feedback after every run. Training that protects you from injury. The app serious athletes have been waiting for.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Weekly Miles", `${(weeklyMilesCount / 10).toFixed(1)} mi`], ["Total Runs", `${totalRunsCount}`], ["Total Miles", `${(totalMilesCount / 10).toFixed(1)} mi`], ["Best Pace", bestPace]].map(([label, value]) => (
          <div key={label} className="rounded-xl p-3" style={{ background: 'linear-gradient(135deg, rgba(234,179,8,0.12) 0%, var(--bg-card) 100%)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</p>
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
          </div>
        ))}
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

      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <h3 className="mb-3 text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Recent Activity</h3>
        <div className="space-y-3">
          {recentActivity.map(item => (
            <div key={`${item.type}-${item.id}`} className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
              {item.type === 'run' ? (
                <>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Run</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(item.data.date || item.data.created_at).toLocaleDateString()}</p>
                  </div>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    {Number(item.data.distance_miles || 0).toFixed(2)} mi · {formatPace(item.data.duration_seconds, item.data.distance_miles)} · {formatDuration(item.data.duration_seconds)}
                  </p>
                </>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Lift</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(item.data.date || item.data.created_at).toLocaleDateString()}</p>
                    </div>
                    <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                      {item.data.exercise_name || (item.data.muscle_groups || []).join(', ') || 'Strength Session'}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {item.data.sets || '-'}×{item.data.reps || '-'} @ {item.data.weight_lbs || '-'} lbs
                    </p>
                  </div>
                  <MuscleDiagram muscleGroups={item.data.muscle_groups || []} sex={sex} size={36} />
                </div>
              )}
            </div>
          ))}
          {recentActivity.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>No activity logged yet.</p>}
        </div>
      </section>
    </div>
  )
}
