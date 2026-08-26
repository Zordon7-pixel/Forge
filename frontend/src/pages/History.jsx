import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ResponsiveContainer, BarChart, LineChart, XAxis, YAxis, Tooltip, Bar, Line } from 'recharts'
import { useLocation, Link } from 'react-router'
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
import { resolveRunHeartRateZone } from '../lib/runRecap'
import { chartAccent, chartAxisProps, chartTooltipProps, hasUsableChartData, isUsableChartValue } from '../lib/chartTheme'
import { activityLabel, isRunningActivity } from '../lib/activityType'

function getRunDate(run) {
  return run.date || run.created_at?.slice(0, 10) || ''
}

function formatHistoryDate(value) {
  if (!value) return '--'
  const raw = String(value)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00`)
    : new Date(raw)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleDateString()
}

function formatDuration(totalSeconds = 0) {
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function formatPace(durationSeconds, distance) {
  if (!durationSeconds || !distance) return '--'
  const roundedSeconds = Math.round(durationSeconds / distance)
  const mins = Math.floor(roundedSeconds / 60)
  const secs = roundedSeconds % 60
  return `${mins}:${String(secs).padStart(2, '0')} /mi`
}

function formatWorkoutDuration(totalSeconds = 0) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function hasTrustedEffort(activity) {
  return !(activity?.watch_mode === 'import' && activity?.notes === 'Imported workout')
}

function monthKeyFor(value) {
  const raw = String(value || '')
  const isoMatch = raw.match(/^(\d{4})-(\d{2})/)
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function monthLabelFor(key) {
  if (key === 'unknown') return 'Date unavailable'
  const [year, month] = key.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function pluralizeItemNoun(noun, count) {
  if (count === 1) return noun
  return noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`
}

function MonthGroup({ label, count, itemNoun, initiallyOpen, children }) {
  const [open, setOpen] = useState(initiallyOpen)

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="overflow-hidden rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{count} {pluralizeItemNoun(itemNoun, count)}</span>
      </summary>
      <div className="space-y-2 border-t p-2" style={{ borderColor: 'var(--border-subtle)' }}>
        {children}
      </div>
    </details>
  )
}

function MonthGroups({ items, getDate, itemNoun, resetKey, children }) {
  const groups = new Map()
  items.forEach((item) => {
    const key = monthKeyFor(getDate(item))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  })
  const ordered = [...groups.entries()].sort(([left], [right]) => {
    if (left === 'unknown') return 1
    if (right === 'unknown') return -1
    return right.localeCompare(left)
  })

  return ordered.map(([key, groupedItems], index) => (
    <MonthGroup
      key={`${resetKey}:${key}`}
      label={monthLabelFor(key)}
      count={groupedItems.length}
      itemNoun={itemNoun}
      initiallyOpen={index === 0}
    >
      {groupedItems.map(children)}
    </MonthGroup>
  ))
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
  const [hrZones, setHrZones] = useState([])
  const [hrProfile, setHrProfile] = useState(null)
  const [editingRun, setEditingRun] = useState(null)
  const [editingLift, setEditingLift] = useState(null)
  const [selectedRun, setSelectedRun] = useState(null)
  const [selectedWorkout, setSelectedWorkout] = useState(null)
  const [showMissedModal, setShowMissedModal] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const requestedRunIdRef = useRef(null)

  const currentYear = new Date().getFullYear()
  const [selectedYear, setSelectedYear] = useState(null)
  const [customRange, setCustomRange] = useState({ from: '', to: '' })
  const [showDatePicker, setShowDatePicker] = useState(false)

  const openRunDetail = useCallback(async (run) => {
    if (!run?.id) return
    setSelectedRun(run)
    try {
      const response = await api.get(`/runs/${encodeURIComponent(run.id)}`)
      const detailedRun = response.data?.run
      if (!detailedRun) return
      setSelectedRun((current) => current?.id === run.id ? { ...current, ...detailedRun } : current)
    } catch (error) {
      console.error('[history/run-detail] enrichment failed:', error?.message || error)
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const [runsRes, liftsRes, workoutsRes, racesRes, hrZonesRes] = await Promise.all([
          api.get('/runs'),
          api.get('/lifts'),
          api.get('/workouts').catch(() => ({ data: { sessions: [] } })),
          api.get('/races').catch(() => ({ data: { races: [] } })),
          api.get('/profile/hr-zones').catch(() => ({ data: { zones: [] } })),
        ])
        setRuns([...(Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || [])].sort((a, b) => getRunDate(b).localeCompare(getRunDate(a))))
        setLifts([...(Array.isArray(liftsRes.data) ? liftsRes.data : liftsRes.data?.lifts || [])].sort((a, b) => (b.date || b.created_at || '').localeCompare(a.date || a.created_at || '')))
        setWorkoutSessions([...(workoutsRes.data?.sessions || [])].sort((a, b) => (b.started_at || '').localeCompare(a.started_at || '')))
        setRaces([...(racesRes.data?.races || [])].sort((a, b) => (b.race_date || '').localeCompare(a.race_date || '')))
        setHrZones(Array.isArray(hrZonesRes.data?.zones) ? hrZonesRes.data.zones : [])
        setHrProfile(hrZonesRes.data?.profile || null)
      } finally {
        setLoading(false)
      }
    })()
  }, [])


  useEffect(() => {
    let active = true
    if (!loading) {
      const params = new URLSearchParams(location.search)
      const runId = params.get('runId')
      const workoutId = params.get('workoutId')
      if (runId) {
        const r = runs.find((x) => x.id === runId)
        if (r) {
          requestedRunIdRef.current = runId
          openRunDetail(r)
        } else if (requestedRunIdRef.current !== runId) {
          requestedRunIdRef.current = runId
          api.get(`/runs/${encodeURIComponent(runId)}`)
            .then((response) => {
              if (!active) return
              const detailedRun = response.data?.run
              if (detailedRun) setSelectedRun(detailedRun)
            })
            .catch((error) => {
              console.error('[history/run-link] requested run load failed:', error?.message || error)
            })
        }
      }
      if (workoutId) {
        const w = workoutSessions.find((x) => x.id === workoutId)
        if (w) setSelectedWorkout(w)
      }
    }
    return () => { active = false }
  }, [loading, location.search, openRunDetail, runs, workoutSessions])

  const requestDelete = (type, item, e) => {
    e?.stopPropagation?.()
    setDeleteError('')
    setPendingDelete({ type, item })
  }

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return
    const { type, item } = pendingDelete
    setDeleting(true)
    setDeleteError('')
    try {
      if (type === 'run') {
        await api.delete(`/runs/${item.id}`)
        setRuns(prev => prev.filter(r => r.id !== item.id))
        setSelectedRun(current => current?.id === item.id ? null : current)
      } else if (type === 'workout') {
        await api.delete(`/workouts/${item.id}`)
        setWorkoutSessions(prev => prev.filter(session => session.id !== item.id))
      } else {
        await api.delete(`/lifts/${item.id}`)
        setLifts(prev => prev.filter(l => l.id !== item.id))
      }
      setPendingDelete(null)
    } catch (error) {
      console.error('[history/delete] failed:', error?.message || error)
      setDeleteError(error?.response?.data?.error || `Could not delete this ${type}. Try again.`)
    } finally {
      setDeleting(false)
    }
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
  const actualRuns = useMemo(() => filteredRuns.filter(isRunningActivity), [filteredRuns])
  const filteredLifts = filterItems(lifts, 'date')
  const filteredWorkoutSessions = filterItems(workoutSessions, 'started_at')
  const monthGroupResetKey = `${tab}:${period}:${selectedYear || ''}:${customRange.from}:${customRange.to}`
  const trainingHistoryItems = useMemo(() => [
    ...filteredWorkoutSessions.map((session) => ({ kind: 'workout', id: `workout-${session.id}`, date: session.started_at || session.created_at, value: session })),
    ...filteredLifts.map((lift) => ({ kind: 'lift', id: `lift-${lift.id}`, date: lift.date || lift.created_at, value: lift })),
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))), [filteredLifts, filteredWorkoutSessions])

  const periodMiles = useMemo(
    () => actualRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0),
    [actualRuns]
  )

  const avgPace = useMemo(() => {
    const validRuns = actualRuns.filter(r => r.distance_miles && r.duration_seconds)
    if (!validRuns.length) return '--'
    const avgPaceSeconds = validRuns.reduce((s, r) => s + r.duration_seconds / r.distance_miles, 0) / validRuns.length
    return fmt.pace(avgPaceSeconds)
  }, [actualRuns, fmt])

  const weeklyMileage = useMemo(() => {
    const mileageRuns = runs
      .filter(isRunningActivity)
      .filter((run) => isUsableChartValue(run.distance_miles))
    if (mileageRuns.length === 0) return []

    const out = []
    for (let i = 7; i >= 0; i -= 1) {
      const start = new Date(); start.setDate(start.getDate() - i * 7)
      const end = new Date(start); end.setDate(end.getDate() + 6)
      const miles = mileageRuns.filter((r) => { const d = new Date((r.date || r.created_at || '') + 'T12:00:00'); return d >= start && d <= end }).reduce((sum, r) => sum + Number(r.distance_miles), 0)
      out.push({ week: `${start.getMonth()+1}/${start.getDate()}`, miles: Number(miles.toFixed(1)) })
    }
    return out
  }, [runs])
  const paceTrend = useMemo(() => actualRuns
    .slice(0, 20)
    .reverse()
    .map((run, index) => {
      const distance = Number(run.distance_miles)
      const duration = Number(run.duration_seconds)
      const pace = isUsableChartValue(run.distance_miles)
        && isUsableChartValue(run.duration_seconds)
        && distance > 0
        && duration > 0
        ? Number((duration / 60 / distance).toFixed(2))
        : null
      return { idx: index + 1, pace }
    })
    .filter((point) => isUsableChartValue(point.pace)), [actualRuns])
  const hasWeeklyMileage = hasUsableChartData(weeklyMileage, 'miles')
  const hasPaceTrend = hasUsableChartData(paceTrend, 'pace')

  if (loading) return <LoadingRunner message="Loading history" />

  return (
    <div className="pt-2">
      <div className="mb-4">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>History</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Review your runs, lifts, and race efforts.</p>
      </div>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {[['Run Distance', fmt.distance(periodMiles, 1)], ['Run Pace', avgPace], ['Lifts', `${filteredLifts.length + filteredWorkoutSessions.length}`]].map(([l, v]) => (
          <div key={l} className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-card)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>{l}</p>
            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{v}</p>
          </div>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-3">
        <Link to="/recap"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 20,
            background: 'var(--accent)', color: 'var(--on-accent)',
            fontWeight: 700, fontSize: 13, textDecoration: 'none',
          }}>
          Weekly Recap
        </Link>
      </div>

      {(hasWeeklyMileage || hasPaceTrend) && (
        <details className="mb-4 overflow-hidden rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
            <span>Trends</span><span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>Mileage and pace</span>
          </summary>
          <div className="grid grid-cols-1 gap-3 border-t p-3" style={{ borderColor: 'var(--border-subtle)' }}>
          {hasWeeklyMileage && (
            <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ width: '100%', height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={weeklyMileage}><XAxis dataKey="week" {...chartAxisProps} /><YAxis {...chartAxisProps} /><Tooltip {...chartTooltipProps} /><Bar dataKey="miles" fill={chartAccent} /></BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {hasPaceTrend && (
            <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ width: '100%', height: 180 }}>
                <ResponsiveContainer>
                  <LineChart data={paceTrend}><XAxis dataKey="idx" {...chartAxisProps} /><YAxis {...chartAxisProps} /><Tooltip {...chartTooltipProps} /><Line type="monotone" dataKey="pace" stroke={chartAccent} strokeWidth={2} dot={false} /></LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          </div>
        </details>
      )}

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
              ? { background: 'var(--accent)', color: 'var(--on-accent)' }
              : { background: 'var(--bg-input)', color: 'var(--text-muted)' }}
          >
            {p === 'week' ? 'W' : p === 'month' ? 'M' : p === 'year' ? 'Y' : 'All'}
          </button>
        ))}
      </div>

      <div className="mb-4 flex border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        {[['all', 'All'], ['runs', 'Activities'], ['lifts', t('history.workouts')], ['races', t('history.races')]].map(([value, label]) => (
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
          <MonthGroups items={filteredRuns} getDate={getRunDate} itemNoun="activity" resetKey={monthGroupResetKey}>{run => {
            const heartRateZone = isRunningActivity(run) ? resolveRunHeartRateZone(run, hrZones) : null
            return (
            <div key={run.id} onClick={() => openRunDetail(run)} className="cursor-pointer rounded-lg p-4" style={{ background: 'var(--bg-input)' }}>
              <div className="mb-2 flex min-w-0 flex-wrap items-start gap-2">
                <p className="min-w-0 flex-1 text-sm" style={{ color: 'var(--text-muted)' }}>{formatHistoryDate(getRunDate(run))}</p>
                <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
                  <span className="rounded-full px-2 py-1 text-xs font-semibold" style={{ background: isRunningActivity(run) ? 'var(--accent-dim)' : 'rgba(34,197,94,0.12)', color: isRunningActivity(run) ? 'var(--accent)' : 'var(--success)' }}>{activityLabel(run)}</span>
                  {heartRateZone ? <span className="rounded-full px-2 py-1 text-xs font-semibold" title={`${heartRateZone.source === 'timeline' ? 'Dominant recorded' : 'Average'} heart-rate zone`} style={{ background: `${heartRateZone.color}22`, color: heartRateZone.textColor || heartRateZone.color }}>{`HR Z${heartRateZone.zone}`}</span> : null}
                  {run.perceived_effort && hasTrustedEffort(run) ? <span className="rounded-full px-2 py-1 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Effort {run.perceived_effort}/10</span> : null}
                  <button type="button" aria-label="Edit run" title="Edit run" onClick={e => { e.stopPropagation(); setEditingRun(run) }} className="grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors" style={{ color: 'var(--text-muted)' }}><Pencil size={14} /></button>
                  <button type="button" aria-label="Delete run" title="Delete run" onClick={e => requestDelete('run', run, e)} className="grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors" style={{ color: 'var(--text-muted)' }}><Trash2 size={14} /></button>
                </div>
              </div>

              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {fmt.distance(Number(run.distance_miles || 0), 2)} · {formatDuration(run.duration_seconds)} · {Number(run.distance_miles || 0) > 0 && Number(run.duration_seconds || 0) > 0 ? fmt.pace(run.duration_seconds / run.distance_miles) : '--'}
                {(run.calories_burned || run.calories) > 0 && <span> · {run.calories_burned || run.calories} cal</span>}
              </p>

              {heartRateZone && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{heartRateZone.source === 'timeline' ? `Dominant HR zone Z${heartRateZone.zone}${Number.isFinite(heartRateZone.dominantPct) ? ` for ${heartRateZone.dominantPct.toFixed(0)}% of recorded HR time` : ''}` : `Average HR classified as Z${heartRateZone.zone} with your saved zones`}</p>}

              {run.notes && <p className="mt-1 text-xs italic" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>&quot;{run.notes}&quot;</p>}
            </div>
            )
          }}</MonthGroups>

          {filteredRuns.length === 0 && tab !== 'lifts' && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <img src="/icon.svg" alt="Forged Hybrid" className="w-24 h-24 object-contain opacity-20" />
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
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('history.workouts')}</p>

          <MonthGroups items={trainingHistoryItems} getDate={(item) => item.date} itemNoun="workout" resetKey={monthGroupResetKey}>{item => {
            if (item.kind === 'workout') {
              const session = item.value
              return (
            <div key={item.id} onClick={() => setSelectedWorkout(session)} className="cursor-pointer rounded-lg p-4" style={{ background: 'var(--bg-input)' }}>
              <div className="flex items-center justify-between">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{formatHistoryDate(session.started_at || session.created_at)}</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>View Details</span>
                  <button type="button" aria-label="Delete workout" title="Delete workout" onClick={e => requestDelete('workout', session, e)} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Trash2 size={14} /></button>
                </div>
              </div>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-primary)' }}>
                Duration: {session.total_seconds ? formatWorkoutDuration(session.total_seconds) : '--'}
              </p>
              {Array.isArray(session.muscle_groups) && session.muscle_groups.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {session.muscle_groups.map(tag => (
                    <span key={tag} className="rounded-full px-2 py-1 text-xs capitalize" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
              )
            }
            const lift = item.value
            let tags = []
            try { tags = Array.isArray(lift.muscle_groups) ? lift.muscle_groups : JSON.parse(lift.muscle_groups || '[]') } catch { tags = [] }

            return (
              <div key={item.id} className="cursor-pointer rounded-lg p-4" style={{ background: 'var(--bg-input)' }}>
                <div className="flex items-center justify-between">
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{formatHistoryDate(lift.date || lift.created_at)}</p>
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label="Edit lift" title="Edit lift" onClick={e => { e.stopPropagation(); setEditingLift(lift) }} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Pencil size={14} /></button>
                    <button type="button" aria-label="Delete lift" title="Delete lift" onClick={e => requestDelete('lift', lift, e)} className="transition-colors" style={{ color: 'var(--text-muted)' }}><Trash2 size={14} /></button>
                  </div>
                </div>
                <p className="mt-1 font-semibold" style={{ color: 'var(--text-primary)' }}>{lift.exercise_name}</p>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{lift.sets} × {lift.reps} @ {lift.weight_lbs} lbs</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {tags.map(tag => <span key={tag} className="rounded-full px-2 py-1 text-xs capitalize" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>{tag}</span>)}
                </div>
              </div>
            )
          }}</MonthGroups>

          {filteredLifts.length === 0 && filteredWorkoutSessions.length === 0 && tab !== 'runs' && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <img src="/icon.svg" alt="Forged Hybrid" className="w-24 h-24 object-contain opacity-20" />
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
            <MonthGroups items={races} getDate={(race) => race.race_date} itemNoun="race" resetKey={monthGroupResetKey}>{r => (
              <div key={r.id} className="rounded-lg p-4" style={{ background: 'var(--bg-input)' }}>
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{r.race_name}</p>
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{r.race_date} · {r.distance_miles} mi{r.location ? ` · ${r.location}` : ''}</p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full font-semibold" style={{ background: r.status === 'completed' ? 'rgba(34,197,94,0.15)' : 'var(--accent-dim)', color: r.status === 'completed' ? 'var(--success)' : 'var(--accent)' }}>
                    {r.status || 'upcoming'}
                  </span>
                </div>
                {r.goal_time_seconds && (
                  <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                    Goal: {Math.floor(r.goal_time_seconds/3600) > 0 ? `${Math.floor(r.goal_time_seconds/3600)}h ` : ''}{Math.floor((r.goal_time_seconds%3600)/60)}:{String(r.goal_time_seconds%60).padStart(2,'0')}
                  </p>
                )}
              </div>
            )}</MonthGroups>
          )}
          <button onClick={() => window.location.href = '/races'} style={{ width: '100%', padding: '10px 0', borderRadius: 12, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
            + Add Race
          </button>
        </div>
      )}

      {editingRun && <EditRunModal run={editingRun} onSave={updateRunInState} onClose={() => setEditingRun(null)} />}
      {editingLift && <EditLiftModal lift={editingLift} onSave={updateLiftInState} onClose={() => setEditingLift(null)} />}
      {showMissedModal && <MissedWorkoutModal onClose={() => setShowMissedModal(false)} />}

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
            <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>Delete {pendingDelete.type}?</h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>This removes it from Forged Hybrid, recalculates affected records, and keeps an imported activity hidden from future syncs. It does not delete the original workout from Apple Health.</p>
            {deleteError && <p className="mt-2 text-sm" role="alert" style={{ color: 'var(--danger)' }}>{deleteError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={deleting} onClick={() => setPendingDelete(null)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', opacity: deleting ? 0.5 : 1 }}>Cancel</button>
              <button type="button" disabled={deleting} onClick={confirmDelete} className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: 'var(--danger)', color: '#FFFFFF', opacity: deleting ? 0.6 : 1 }}>{deleting ? 'Deleting...' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {selectedRun && (
        <RunDetailModal
          run={selectedRun}
          hrZones={hrZones}
          hrProfile={hrProfile}
          onClose={() => setSelectedRun(null)}
          onDelete={() => {
            const run = selectedRun
            setSelectedRun(null)
            requestDelete('run', run)
          }}
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
