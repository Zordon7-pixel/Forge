import { useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
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

export default function History() {
  const [tab, setTab] = useState('runs')
  const [runs, setRuns] = useState([])
  const [lifts, setLifts] = useState([])
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    ;(async () => {
      const [runsRes, liftsRes] = await Promise.all([api.get('/runs'), api.get('/lifts')])
      setRuns(Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || [])
      setLifts(Array.isArray(liftsRes.data) ? liftsRes.data : liftsRes.data?.lifts || [])
    })()
  }, [])

  const deleteRun = async (id, e) => {
    e.stopPropagation()
    if (!confirm('Delete this run?')) return
    await api.delete(`/runs/${id}`)
    setRuns(prev => prev.filter(r => r.id !== id))
  }

  const deleteLift = async (id, e) => {
    e.stopPropagation()
    if (!confirm('Delete this lift?')) return
    await api.delete(`/lifts/${id}`)
    setLifts(prev => prev.filter(l => l.id !== id))
  }

  const monthMiles = useMemo(() => {
    const thisMonth = new Date()
    return runs
      .filter(r => {
        const d = new Date(r.date || r.created_at)
        return d.getMonth() === thisMonth.getMonth() && d.getFullYear() === thisMonth.getFullYear()
      })
      .reduce((s, r) => s + Number(r.distance || 0), 0)
  }, [runs])

  const avgPace = useMemo(() => {
    const validRuns = runs.filter(r => r.distance && r.duration_seconds)
    if (!validRuns.length) return '--'
    const avgPaceMin = validRuns.reduce((s, r) => s + r.duration_seconds / 60 / r.distance, 0) / validRuns.length
    const m = Math.floor(avgPaceMin)
    const s = Math.round((avgPaceMin - m) * 60)
    return `${m}:${String(s).padStart(2, '0')} /mi`
  }, [runs])

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-[#111318] p-3 text-center">
          <p className="text-xs text-gray-500">This Month</p>
          <p className="text-sm font-bold text-white">{monthMiles.toFixed(1)} mi</p>
        </div>
        <div className="rounded-xl bg-[#111318] p-3 text-center">
          <p className="text-xs text-gray-500">Avg Pace</p>
          <p className="text-sm font-bold text-white">{avgPace}</p>
        </div>
        <div className="rounded-xl bg-[#111318] p-3 text-center">
          <p className="text-xs text-gray-500">Lifts</p>
          <p className="text-sm font-bold text-white">{lifts.length}</p>
        </div>
      </div>

      <div className="mb-4 flex border-b border-white/10">
        {[
          ['runs', 'Runs'],
          ['lifts', 'Lifts']
        ].map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === value ? 'border-b-2 border-orange-500 text-white' : 'text-gray-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'runs' && (
        <div className="space-y-3">
          {runs.map(run => (
            <div
              key={run.id}
              className="cursor-pointer rounded-xl bg-[#111318] p-4 transition-all duration-150 hover:scale-[1.01] hover:bg-[#1e2235]"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm text-gray-300">{new Date(run.date || run.created_at).toLocaleDateString()}</p>
                <div className="flex items-center gap-2">
                  {run.effort ? (
                    <span className="rounded-full bg-[#09090f] px-2 py-1 text-xs text-gray-300">Effort {run.effort}/10</span>
                  ) : null}
                  <button
                    onClick={e => deleteRun(run.id, e)}
                    className="text-gray-600 transition-colors hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <p className="text-sm text-gray-200">
                {Number(run.distance || 0).toFixed(2)} mi · {formatDuration(run.duration_seconds)} ·{' '}
                {formatPace(run.duration_seconds, run.distance)}
              </p>

              {run.ai_feedback && (
                <>
                  <button
                    onClick={() => setExpanded(prev => ({ ...prev, [run.id]: !prev[run.id] }))}
                    className="mt-3 rounded-full bg-orange-500/20 px-3 py-1 text-xs text-orange-300"
                  >
                    💬 AI
                  </button>
                  {expanded[run.id] && <p className="mt-2 text-sm text-gray-300">{run.ai_feedback}</p>}
                </>
              )}
            </div>
          ))}

          {runs.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-4 py-16">
              <img src="/empty-runs.png" alt="" className="h-40 w-40 object-contain opacity-90" />
              <p className="text-sm font-medium text-slate-400">No runs logged yet.</p>
              <p className="text-xs text-slate-600">Lace up and log your first run to get started.</p>
            </div>
          )}
        </div>
      )}

      {tab === 'lifts' && (
        <div className="space-y-3">
          {lifts.map(lift => {
            let tags = []
            try {
              tags = Array.isArray(lift.muscle_groups) ? lift.muscle_groups : JSON.parse(lift.muscle_groups || '[]')
            } catch {
              tags = []
            }

            return (
              <div
                key={lift.id}
                className="cursor-pointer rounded-xl bg-[#111318] p-4 transition-all duration-150 hover:scale-[1.01] hover:bg-[#1e2235]"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-300">{new Date(lift.date || lift.created_at).toLocaleDateString()}</p>
                  <button
                    onClick={e => deleteLift(lift.id, e)}
                    className="text-gray-600 transition-colors hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <p className="mt-1 font-semibold text-white">{lift.exercise_name}</p>
                <p className="mt-1 text-sm text-gray-300">
                  {lift.sets} × {lift.reps} @ {lift.weight_lbs} lbs
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {tags.map(tag => (
                    <span key={tag} className="rounded-full bg-[#09090f] px-2 py-1 text-xs capitalize text-gray-300">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}

          {lifts.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-4 py-16">
              <img src="/empty-lifts.png" alt="" className="h-40 w-40 object-contain opacity-90" />
              <p className="text-sm font-medium text-slate-400">No lifts recorded yet.</p>
              <p className="text-xs text-slate-600">Hit the weights.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
