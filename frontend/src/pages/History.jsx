import { useEffect, useMemo, useState } from 'react'
import { useLocation, Link } from 'react-router-dom'
import { Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import EditRunModal from '../components/EditRunModal'
import EditLiftModal from '../components/EditLiftModal'
import MissedWorkoutModal from '../components/MissedWorkoutModal'
import RunDetailModal from '../components/RunDetailModal'
import WorkoutDetailModal from '../components/WorkoutDetailModal'
import LoadingRunner from '../components/LoadingRunner'

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

function formatWorkoutDuration(totalSeconds = 0) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function History() {
  const location = useLocation()
  const { fmt } = useUnits()
  const { t, i18n } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')
  const [period, setPeriod] = useState('all')
  const [runs, setRuns] = useState([])
  const [lifts, setLifts] = useState([])
  const [workoutSessions, setWorkoutSessions] = useState([])
  const [races, setRaces] = useState([])
  const [editingRun, setEditingRun] = useState(null)
  const [editingLift, setEditingLift] = useState(null)
  const [selectedRun, setSelectedRun] = useState(null)
  const [selectedWorkout, setSelectedWorkout] = useState(null)
  const [showMissedModal, setShowMissedModal] = useState(false)

  const currentYear = new Date().getFullYear()
  const [selectedYear, setSelectedYear] = useState(null)
  const [customRange, setCustomRange] = useState({ from: '', to: '' })
  const [showDatePicker, setShowDatePicker] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const [runsRes, liftsRes, workoutsRes, racesRes] = await Promise.all([
          api.get('/runs'),
          api.get('/lifts'),
          api.get('/workouts').catch(() => ({ data: { sessions: [] } })),
          api.get('/races').catch(() => ({ data: { races: [] } })),
        ])
        setRuns([...(Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || [])].sort((a, b) => getRunDate(b).localeCompare(getRunDate(a))))
        setLifts([...(Array.isArray(liftsRes.data) ? liftsRes.data : liftsRes.data?.lifts || [])].sort((a, b) => (b.date || b.created_at || '').localeCompare(a.date || a.created_at || '')))
        setWorkoutSessions([...(workoutsRes.data?.sessions || [])].sort((a, b) => (b.started_at || '').localeCompare(a.started_at || '')))
        setRaces([...(racesRes.data?.races || [])].sort((a, b) => (b.race_date || '').localeCompare(a.race_date || '')))
      } finally {
        setLoading(false)
      }
    })()
  }, [])


  useEffect(() => {
    if (!loading) {
      const params = new URLSearchParams(location.search)
      const runId = params.get('runId')
      const workoutId = params.get('workoutId')
      if (runId) {
        const r = runs.find((x) => x.id === runId)
        if (r) setSelectedRun(r)
      }
      if (workoutId) {
        const w = workoutSessions.find((x) => x.id === workoutId)
        if (w) setSelectedWorkout(w)
      }
    }
  }, [loading, location.search, runs, workoutSessions])

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

  const updateRunInState = updated => {
    setRuns(prev => prev.map(r => (r.id === updated.id ? { ...r, ...updated } : r)))
    setEditingRun(null)
  }

  const updateLiftInState = updated => {
    setLifts(prev => prev.map(l => (l.id === updated.id ? { ...l, ...updated } : l)))
    setEditingLift(null)
  }

  const filterItems = (items, dateKey) => {
    if (customRange.from || customRange.to) {
      return items.filter(item => {
        const d = (item[dateKey] || item.created_at || '').slice(0, 10)
        if (customRange.from && d < customRange.from) return false
        if (customRange.to && d > customRange.to) return false
        return true
      })
    }
    if (selectedYear) {
      return items.filter(item => {
        const d = (item[dateKey] || item.created_at || '').slice(0, 10)
        return d.startsWith(String(selectedYear))
      })
    }
    if (period === 'all') return items
    const days = { week: 7, month: 30, year: 365 }[period]
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    return items.filter(item => {
      const d = (item[dateKey] || item.created_at || '').slice(0, 10)
      return d >= since
    })
  }

  const filteredRuns = filterItems(runs, 'date')
  const filteredLifts = filterItems(lifts, 'date')
  const filteredWorkoutSessions = filterItems(workoutSessions, 'started_at')

  const periodMiles = useMemo(
    () => filteredRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0),
    [filteredRuns]
  )

  const avgPace = useMemo(() => {
    const validRuns = filteredRuns.filter(r => r.distance_miles && r.duration_seconds)
    if (!validRuns.length) return '--'
    const avgPaceSeconds = validRuns.reduce((s, r) => s + r.duration_seconds / r.distance_miles, 0) / validRuns.length
    return fmt.pace(avgPaceSeconds)
  }, [filteredRuns, fmt])

  const weeklyMileage = useMemo(() => {
    const out = []
    for (let i = 7; i >= 0; i -= 1) {
      const start = new Date(); start.setDate(start.getDate() - i * 7)
      const end = new Date(start); end.setDate(end.getDate() + 6)
      const miles = runs.filter((r) => { const d = new Date((r.date || r.created_at || '') + 'T12:00:00'); return d >= start && d <= end }).reduce((sum, r) => sum + Number(r.distance_miles || 0), 0)
      out.push({ week: `${start.getMonth()+1}/${start.getDate()}`, miles: Number(miles.toFixed(1)) })
    }
    return out
  }, [runs])
  const paceTrend = useMemo(() => filteredRuns.slice(0, 20).reverse().map((r, i) => ({ idx: i + 1, pace: r.distance_miles ? Number((r.duration_seconds / 60 / r.distance_miles).toFixed(2)) : 0 })).filter((x) => x.pace > 0), [filteredRuns])

  if (loading) return <LoadingRunner message="Loading history" />

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {[['Distance', fmt.distance(periodMiles, 1)], ['Avg Pace', avgPace], ['Lifts', `${filteredLifts.length + filteredWorkoutSessions.length}`]].map(([l, v]) => (
          <div key={l} className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-card)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>{l}</p>
            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{v}</p>
          </div>
        ))}
      </div>

      <Link to="/journal" className="mb-3 inline-block text-sm" style={{ color: 'var(--accent)' }}>View Journal</Link>

      <div className="grid grid-cols-1 gap-3 mb-4">
        <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <BarChart data={weeklyMileage}><XAxis dataKey="week" stroke="#fff" tick={{ fontSize: 10 }} /><YAxis stroke="#fff" tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="miles" fill="#EAB308" /></BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <LineChart data={paceTrend}><XAxis dataKey="idx" stroke="#fff" tick={{ fontSize: 10 }} /><YAxis stroke="#fff" tick={{ fontSize: 10 }} /><Tooltip /><Line type="monotone" dataKey="pace" stroke="#EAB308" strokeWidth={2} dot={false} /></LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="mb-4">
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, marginBottom: 12 }}>
          {Array.from({ length: 1 }, (_, i) => currentYear - i).map(year => (
            <button key={year} onClick={() => { setSelectedYear(selectedYear === year ? null : year); setCustomRange({ from: '', to: '' }) }}
              style={{
                flexShrink: 0,
                padding: '6px 16px',
                borderRadius: 20,
                border: `1.5px solid ${selectedYear === year ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: selectedYear === year ? 'var(--accent)' : 'var(--bg-input)',
                color: selectedYear === year ? 'black' : 'var(--text-muted)',
                fontWeight: 700,
                fontSize: 13,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}>
              {year}
            </button>
          ))}
          <button onClick={() => { setShowDatePicker(p => !p); setSelectedYear(null) }}
            style={{
              flexShrink: 0,
              padding: '6px 14px',
              borderRadius: 20,
              border: `1.5px solid ${(customRange.from || customRange.to) ? 'var(--accent)' : 'var(--border-subtle)'}`,
              background: (customRange.from || customRange.to) ? 'var(--accent-dim)' : 'var(--bg-input)',
              color: (customRange.from || customRange.to) ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}>
            Custom Range
          </button>
        </div>

        {showDatePicker && (
          <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-semibold mb-3" style={{ color: 'var(--text-muted)' }}>Custom Date Range</p>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>From</label>
                <input type="date" value={customRange.from}
                  min={`${currentYear - 5}-01-01`}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={e => setCustomRange(p => ({ ...p, from: e.target.value }))}
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 10px', color: 'var(--text-primary)', fontSize: 13 }} />
              </div>
              <div className="flex-1">
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>To</label>
                <input type="date" value={customRange.to}
                  min={`${currentYear - 5}-01-01`}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={e => setCustomRange(p => ({ ...p, to: e.target.value }))}
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 10px', color: 'var(--text-primary)', fontSize: 13 }} />
              </div>
            </div>
            {(customRange.from || customRange.to) && (
              <button onClick={() => { setCustomRange({ from: '', to: '' }); setShowDatePicker(false) }}
                className="mt-3 text-xs"
                style={{ color: 'var(--text-muted)' }}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mb-4 flex rounded-xl overflow-hidden border" style={{ borderColor: 'var(--border-subtle)', opacity: (selectedYear || customRange.from || customRange.to) ? 0.4 : 1 }}>
        {['week', 'month', 'year', 'all'].map(p => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className="flex-1 py-2 text-xs font-semibold uppercase"
            style={period === p
              ? { background: 'var(--accent)', color: 'black' }
              : { background: 'var(--bg-input)', color: 'var(--text-muted)' }}
          >
            {p === 'week' ? 'W' : p === 'month' ? 'M' : p === 'year' ? 'Y' : 'All'}
          </button>
        ))}
      </div>

      <div className="mb-4 flex border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        {[['all', 'All'], ['runs', t('history.runs')], ['lifts', t('history.workouts')], ['races', t('history.races')]].map(([value, label]) => (
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

      {(tab === 'all' || tab === 'runs') && (
        <div className="space-y-3 mb-3">
          {filteredRuns.map(run => (
            <div key={run.id} onClick={() => setSelectedRun(run)} className="cursor-pointer rounded-xl p-4" style={{ background: 'var(--bg-card)' }}>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{new Date(getRunDate(run)).toLocaleDateString()}</p>
                <div className="flex items-center gap-2">
                  {run.perceived_effort ? <span className="rounded-full px-2 py-1 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Effort {run.perceived_effort}/10</span> : null}
                  <button onClick={e => { e.stopPropagation(); setEditingRun(run) }} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Pencil size={14} /></button>
                  <button onClick={e => deleteRun(run.id, e)} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Trash2 size={14} /></button>
                </div>
              </div>

              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {fmt.distance(Number(run.distance_miles || 0), 2)} · {formatDuration(run.duration_seconds)} · {fmt.pace(run.duration_seconds / run.distance_miles)}
                {run.calories > 0 && <span> · {run.calories} cal</span>}
              </p>

              {run.notes && <p className="mt-1 text-xs italic" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>&quot;{run.notes}&quot;</p>}
            </div>
          ))}

          {filteredRuns.length === 0 && tab !== 'lifts' && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <img src="/empty-runs.png" alt="" className="w-64 h-64 object-contain" />
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('history.noRuns')}</p>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Lace up and log your next run.</p>
            </div>
          )}

          <button onClick={() => setShowMissedModal(true)}
            className="w-full py-3 rounded-xl text-sm mt-2"
            style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
            Miss a workout? Let me know - I'll adjust your plan
          </button>
        </div>
      )}

      {(tab === 'all' || tab === 'lifts') && (
        <div className="space-y-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('history.workouts')} & {t('history.races')}</p>

          {filteredWorkoutSessions.map(session => (
            <div key={session.id} onClick={() => setSelectedWorkout(session)} className="cursor-pointer rounded-xl p-4" style={{ background: 'var(--bg-card)' }}>
              <div className="flex items-center justify-between">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{new Date(session.started_at || session.created_at).toLocaleDateString()}</p>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>View Details</span>
              </div>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-primary)' }}>Duration: {session.total_seconds ? formatWorkoutDuration(session.total_seconds) : '--'}</p>
              {Array.isArray(session.muscle_groups) && session.muscle_groups.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {session.muscle_groups.map(tag => (
                    <span key={tag} className="rounded-full px-2 py-1 text-xs capitalize" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
          ))}

          {filteredLifts.map(lift => {
            let tags = []
            try { tags = Array.isArray(lift.muscle_groups) ? lift.muscle_groups : JSON.parse(lift.muscle_groups || '[]') } catch { tags = [] }

            return (
              <div key={lift.id} className="cursor-pointer rounded-xl p-4" style={{ background: 'var(--bg-card)' }}>
                <div className="flex items-center justify-between">
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{new Date(lift.date || lift.created_at).toLocaleDateString()}</p>
                  <div className="flex items-center gap-2">
                    <button onClick={e => { e.stopPropagation(); setEditingLift(lift) }} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Pencil size={14} /></button>
                    <button onClick={e => deleteLift(lift.id, e)} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Trash2 size={14} /></button>
                  </div>
                </div>
                <p className="mt-1 font-semibold" style={{ color: 'var(--text-primary)' }}>{lift.exercise_name}</p>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{lift.sets} × {lift.reps} @ {lift.weight_lbs} lbs</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {tags.map(tag => <span key={tag} className="rounded-full px-2 py-1 text-xs capitalize" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>{tag}</span>)}
                </div>
              </div>
            )
          })}

          {filteredLifts.length === 0 && filteredWorkoutSessions.length === 0 && tab !== 'runs' && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <img src="/empty-lifts.png" alt="" className="w-64 h-64 object-contain" />
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>No lifts recorded for this period.</p>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Hit the weights.</p>
            </div>
          )}
        </div>
      )}

      {(tab === 'all' || tab === 'races') && (
        <div className="space-y-3">
          {races.length === 0 ? (
            <p className="text-center py-8" style={{ color: 'var(--text-muted)', fontSize: 14 }}>{t('history.noRaces')}</p>
          ) : (
            races.map(r => (
              <div key={r.id} className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{r.race_name}</p>
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{r.race_date} · {r.distance_miles} mi{r.location ? ` · ${r.location}` : ''}</p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full font-semibold" style={{ background: r.status === 'completed' ? 'rgba(34,197,94,0.15)' : 'rgba(234,179,8,0.15)', color: r.status === 'completed' ? '#22c55e' : '#EAB308' }}>
                    {r.status || 'upcoming'}
                  </span>
                </div>
                {r.goal_time_seconds && (
                  <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                    Goal: {Math.floor(r.goal_time_seconds/3600) > 0 ? `${Math.floor(r.goal_time_seconds/3600)}h ` : ''}{Math.floor((r.goal_time_seconds%3600)/60)}:{String(r.goal_time_seconds%60).padStart(2,'0')}
                  </p>
                )}
              </div>
            ))
          )}
          <button onClick={() => window.location.href = '/races'} style={{ width: '100%', padding: '10px 0', borderRadius: 12, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
            + Add Race
          </button>
        </div>
      )}

      {editingRun && <EditRunModal run={editingRun} onSave={updateRunInState} onClose={() => setEditingRun(null)} />}
      {editingLift && <EditLiftModal lift={editingLift} onSave={updateLiftInState} onClose={() => setEditingLift(null)} />}
      {showMissedModal && <MissedWorkoutModal onClose={() => setShowMissedModal(false)} />}

      {selectedRun && (
        <RunDetailModal
          run={selectedRun}
          onClose={() => setSelectedRun(null)}
          onFeedbackGenerated={(id, fb) => setRuns(prev => prev.map(r => (r.id === id ? { ...r, ai_feedback: fb } : r)))}
        />
      )}

      {selectedWorkout && (
        <WorkoutDetailModal
          session={selectedWorkout}
          onClose={() => setSelectedWorkout(null)}
          onFeedbackGenerated={(id, fb) => setWorkoutSessions(prev => prev.map(s => (s.id === id ? { ...s, ai_feedback: fb } : s)))}
        />
      )}
    </div>
  )
}
