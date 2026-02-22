import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const [, warningRes, runsRes, allRunsRes] = await Promise.all([
          api.get('/auth/me'),
          api.get('/coach/warning'),
          api.get('/runs', { params: { limit: 3 } }),
          api.get('/runs')
        ])

        setWarning(warningRes.data?.warning === true)
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
      .reduce((sum, run) => sum + Number(run.distance || 0), 0)
  }, [allRuns])

  const totalMiles = useMemo(() => {
    return allRuns.reduce((sum, run) => sum + Number(run.distance || 0), 0)
  }, [allRuns])

  const bestPace = useMemo(() => {
    const paces = runs
      .map(run => {
        if (!run.distance || !run.duration_seconds) return null
        return run.duration_seconds / 60 / run.distance
      })
      .filter(Boolean)

    if (!paces.length) return '--'
    const min = Math.min(...paces)
    const mins = Math.floor(min)
    const secs = Math.round((min - mins) * 60)
    return `${mins}:${String(secs).padStart(2, '0')} /mi`
  }, [runs])

  const greeting = useMemo(() => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning 👋'
    if (hour < 18) return 'Good afternoon 👋'
    return 'Good evening 👋'
  }, [])

  const weeklyMilesCount = useCountUp(Math.floor(thisWeekMiles * 10), 900)
  const totalRunsCount = useCountUp(allRuns.length, 900)
  const totalMilesCount = useCountUp(Math.floor(totalMiles * 10), 900)

  if (loading) {
    return <div className="rounded-xl bg-[#111318] p-4 text-gray-300">Loading your training data...</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-slate-400">{greeting}</p>
        <h2 className="text-xl font-bold text-white">Ready to forge your next PR?</h2>
      </div>

      {warning && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          ⚠️ Heavy legs detected — consider a rest day
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl bg-gradient-to-br from-rose-900/40 to-[#1a1d2e] p-3">
          <p className="text-xs text-gray-300">Weekly Miles</p>
          <p className="text-lg font-bold text-white">{(weeklyMilesCount / 10).toFixed(1)} mi</p>
        </div>
        <div className="rounded-xl bg-gradient-to-br from-red-900/40 to-[#1a1d2e] p-3">
          <p className="text-xs text-gray-300">Total Runs</p>
          <p className="text-lg font-bold text-white">{totalRunsCount}</p>
        </div>
        <div className="rounded-xl bg-gradient-to-br from-red-900/40 to-[#1a1d2e] p-3">
          <p className="text-xs text-gray-300">Total Miles</p>
          <p className="text-lg font-bold text-white">{(totalMilesCount / 10).toFixed(1)} mi</p>
        </div>
        <div className="rounded-xl bg-gradient-to-br from-orange-900/40 to-[#1a1d2e] p-3">
          <p className="text-xs text-gray-300">Best Pace</p>
          <p className="text-lg font-bold text-white">{bestPace}</p>
        </div>
      </div>

      <section className="rounded-2xl bg-[#111318] p-4">
        <h3 className="mb-3 text-base font-semibold">Recent Runs</h3>
        <div className="space-y-3">
          {runs.slice(0, 3).map(run => (
            <div
              key={run.id}
              className="cursor-pointer rounded-xl border border-white/10 bg-[#09090f] p-3 transition-all duration-150 hover:scale-[1.01] hover:bg-[#1e2235]"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm text-gray-300">{new Date(run.date || run.created_at).toLocaleDateString()}</p>
                <span className="rounded-full bg-orange-500/20 px-2 py-1 text-xs text-orange-400">
                  {formatPace(run.duration_seconds, run.distance)}
                </span>
              </div>
              <p className="text-sm text-gray-200">
                {Number(run.distance || 0).toFixed(2)} mi · {formatDuration(run.duration_seconds)}
              </p>
            </div>
          ))}
          {runs.length === 0 && <p className="text-sm text-gray-500">No runs logged yet.</p>}
        </div>
      </section>

      <div className="grid grid-cols-3 gap-3">
        <Link to="/log-run" className="rounded-xl bg-orange-500 px-4 py-3 text-center text-sm font-semibold text-white">
          🏃 Log Run
        </Link>
        <Link to="/log-lift" className="rounded-xl bg-purple-600 px-4 py-3 text-center text-sm font-semibold text-white">
          💪 Log Lift
        </Link>
        <Link
          to="/plan"
          className="rounded-xl border border-white/20 bg-transparent px-4 py-3 text-center text-sm font-semibold text-gray-100"
        >
          📋 View Plan
        </Link>
      </div>
    </div>
  )
}
