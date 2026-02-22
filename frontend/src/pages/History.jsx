import { useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import api from '../lib/api'

function getRunDate(run) {
  return run.date || run.created_at?.slice(0, 10) || ''
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

export default function History() {
  const [tab, setTab] = useState('runs')
  const [runs, setRuns] = useState([])
  const [lifts, setLifts] = useState([])
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    ;(async () => {
      const [runsRes, liftsRes] = await Promise.all([api.get('/runs'), api.get('/lifts')])
      setRuns([...(Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || [])].sort((a, b) => getRunDate(b).localeCompare(getRunDate(a))))
      setLifts([...(Array.isArray(liftsRes.data) ? liftsRes.data : liftsRes.data?.lifts || [])].sort((a, b) => (b.date || b.created_at || '').localeCompare(a.date || a.created_at || '')))
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
        const d = new Date(getRunDate(r))
        return d.getMonth() === thisMonth.getMonth() && d.getFullYear() === thisMonth.getFullYear()
      })
      .reduce((s, r) => s + Number(r.distance_miles || 0), 0)
  }, [runs])

  const avgPace = useMemo(() => {
    const validRuns = runs.filter(r => r.distance_miles && r.duration_seconds)
    if (!validRuns.length) return '--'
    const avgPaceMin = validRuns.reduce((s, r) => s + r.duration_seconds / 60 / r.distance_miles, 0) / validRuns.length
    const m = Math.floor(avgPaceMin)
    const s = Math.round((avgPaceMin - m) * 60)
    return `${m}:${String(s).padStart(2, '0')} /mi`
  }, [runs])

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {[["This Month", `${monthMiles.toFixed(1)} mi`], ['Avg Pace', avgPace], ['Lifts', `${lifts.length}`]].map(([l, v]) => (
          <div key={l} className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-card)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>{l}</p>
            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{v}</p>
          </div>
        ))}
      </div>

      <div className="mb-4 flex border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        {[['runs', 'Runs'], ['lifts', 'Lifts']].map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className="px-4 py-2 text-sm font-medium border-b-2"
            style={tab === value ? { borderColor: 'var(--accent)', color: 'var(--text-primary)' } : { borderColor: 'transparent', color: 'var(--text-muted)' }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'runs' && (
        <div className="space-y-3">
          {runs.map(run => (
            <div key={run.id} className="cursor-pointer rounded-xl p-4" style={{ background: 'var(--bg-card)' }}>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{new Date(getRunDate(run)).toLocaleDateString()}</p>
                <div className="flex items-center gap-2">
                  {run.perceived_effort ? <span className="rounded-full px-2 py-1 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Effort {run.perceived_effort}/10</span> : null}
                  <button onClick={e => deleteRun(run.id, e)} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Trash2 size={14} /></button>
                </div>
              </div>

              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {Number(run.distance_miles || 0).toFixed(2)} mi · {formatDuration(run.duration_seconds)} · {formatPace(run.duration_seconds, run.distance_miles)}
              </p>

              {run.notes && <p className="mt-1 text-xs italic" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>"{run.notes}"</p>}

              {run.ai_feedback && (
                <>
                  <button onClick={() => setExpanded(prev => ({ ...prev, [run.id]: !prev[run.id] }))} className="mt-3 rounded-full px-3 py-1 text-xs" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
                    AI Feedback
                  </button>
                  {expanded[run.id] && <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>{run.ai_feedback}</p>}
                </>
              )}
            </div>
          ))}

          {runs.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <img src="/empty-runs.png" alt="" className="w-64 h-64 object-contain" />
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>No runs logged yet.</p>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Lace up and log your first run.</p>
            </div>
          )}
        </div>
      )}

      {tab === 'lifts' && (
        <div className="space-y-3">
          {lifts.map(lift => {
            let tags = []
            try { tags = Array.isArray(lift.muscle_groups) ? lift.muscle_groups : JSON.parse(lift.muscle_groups || '[]') } catch { tags = [] }

            return (
              <div key={lift.id} className="cursor-pointer rounded-xl p-4" style={{ background: 'var(--bg-card)' }}>
                <div className="flex items-center justify-between">
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{new Date(lift.date || lift.created_at).toLocaleDateString()}</p>
                  <button onClick={e => deleteLift(lift.id, e)} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Trash2 size={14} /></button>
                </div>
                <p className="mt-1 font-semibold" style={{ color: 'var(--text-primary)' }}>{lift.exercise_name}</p>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{lift.sets} × {lift.reps} @ {lift.weight_lbs} lbs</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {tags.map(tag => <span key={tag} className="rounded-full px-2 py-1 text-xs capitalize" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>{tag}</span>)}
                </div>
              </div>
            )
          })}

          {lifts.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <img src="/empty-lifts.png" alt="" className="w-64 h-64 object-contain" />
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>No lifts recorded yet.</p>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Hit the weights.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
