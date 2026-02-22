import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'

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
          api.get('/api/auth/me'),
          api.get('/api/coach/warning'),
          api.get('/api/runs', { params: { limit: 3 } }),
          api.get('/api/runs')
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

    return runs
      .filter(run => new Date(run.date || run.created_at) >= start)
      .reduce((sum, run) => sum + Number(run.distance || 0), 0)
      .toFixed(1)
  }, [runs])

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

  if (loading) {
    return <div className="rounded-xl bg-[#111318] p-4 text-gray-300">Loading dashboard...</div>
  }

  return (
    <div className="space-y-4">
      {warning && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          ⚠️ Heavy legs detected — consider a rest day
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-[#111318] p-3">
          <p className="text-xs text-gray-400">This Week</p>
          <p className="text-lg font-bold text-white">{thisWeekMiles} mi</p>
        </div>
        <div className="rounded-xl bg-[#111318] p-3">
          <p className="text-xs text-gray-400">Total Runs</p>
          <p className="text-lg font-bold text-white">{allRuns.length}</p>
        </div>
        <div className="rounded-xl bg-[#111318] p-3">
          <p className="text-xs text-gray-400">Best Pace</p>
          <p className="text-lg font-bold text-white">{bestPace}</p>
        </div>
      </div>

      <section className="rounded-2xl bg-[#111318] p-4">
        <h3 className="mb-3 text-base font-semibold">Recent Runs</h3>
        <div className="space-y-3">
          {runs.slice(0, 3).map(run => (
            <div key={run.id} className="rounded-xl border border-white/10 bg-[#09090f] p-3">
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

      <div className="grid grid-cols-2 gap-3">
        <Link to="/log-run" className="rounded-xl bg-orange-500 px-4 py-3 text-center font-semibold text-white">
          Log a Run →
        </Link>
        <Link
          to="/plan"
          className="rounded-xl border border-white/20 bg-transparent px-4 py-3 text-center font-semibold text-gray-100"
        >
          View Plan →
        </Link>
      </div>
    </div>
  )
}
