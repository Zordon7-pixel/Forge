import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { MapPin, Mountain, RefreshCw, Gauge, Pencil } from 'lucide-react'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import { parseDuration, formatDurationDisplay } from '../lib/parseDuration'
import PostRunCheckIn from '../components/PostRunCheckIn'
import PhotoUploader from '../components/PhotoUploader'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

const WARM_UP_STEPS = [
  'Leg swings — 10 each side',
  'High knees — 30 seconds',
  'Ankle circles — 10 each side',
  'Hip circles — 10 each direction',
  'Arm swings — 20 reps',
]

const SURFACE_OPTIONS = [
  { value: 'road', label: 'Road', icon: MapPin },
  { value: 'track', label: 'Track', icon: RefreshCw },
  { value: 'trail', label: 'Trail', icon: Mountain },
  { value: 'treadmill', label: 'Treadmill', icon: Gauge },
  { value: 'other', label: 'Other', icon: MapPin },
]

const PANEL_KEY = 'forge_run_detail_panels'
const DEFAULT_PANELS = { overview: true, stats: true, pace: true, hr: true, notes: true }

function getEffortColor(level) {
  if (level <= 3) return 'var(--text-muted)'
  if (level <= 6) return 'var(--text-primary)'
  return 'var(--accent)'
}

function getEffortLabel(level) {
  if (level <= 3) return 'Easy'
  if (level <= 6) return 'Moderate'
  if (level <= 8) return 'Hard'
  return 'Max Effort'
}

function formatRunDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatPace(seconds, distance) {
  if (!seconds || !distance) return '—'
  const paceSec = Math.round(seconds / distance)
  const m = Math.floor(paceSec / 60)
  const s = paceSec % 60
  return `${m}:${String(s).padStart(2, '0')}/mi`
}

function parseSplits(run) {
  const raw = run?.splits || run?.splits_json || run?.gps_splits
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function EffortBar({ effort, setEffort }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(level => {
          const isActive = level <= effort
          return (
            <button
              key={level}
              type="button"
              onClick={() => setEffort(level)}
              style={{
                flex: 1,
                height: 40,
                borderRadius: 6,
                border: '1px solid var(--border-subtle)',
                cursor: 'pointer',
                background: isActive ? 'var(--accent)' : 'var(--bg-base)',
              }}
            />
          )
        })}
      </div>
      <div style={{ marginTop: 10, textAlign: 'center' }}>
        <span style={{ fontSize: 36, fontWeight: 900, color: getEffortColor(effort), lineHeight: 1 }}>
          {effort}
        </span>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3, fontWeight: 600 }}>
          {getEffortLabel(effort)}
        </div>
      </div>
    </div>
  )
}

function WorkoutWatchModal({ workout, onClose }) {
  if (!workout) return null

  const copyText = async () => {
    const text = `${workout.day}: ${workout.typeLabel}\nDistance: ${workout.distanceLabel}\n${workout.pace ? `Pace: ${workout.pace}\n` : ''}${workout.description ? `Notes: ${workout.description}` : ''}`
    try { await navigator.clipboard.writeText(text) } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-md rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <h3 className="text-xl font-black mb-4" style={{ color: 'var(--text-primary)' }}>Today's Workout</h3>
        <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
          <div className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>{workout.day}</div>
          <span className="inline-block rounded-full px-3 py-1 text-xs font-bold mb-3" style={{ background: 'var(--accent)', color: '#000' }}>
            {workout.typeLabel}
          </span>
          <div className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}><strong>Distance:</strong> {workout.distanceLabel}</div>
          {workout.pace && <div className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}><strong>Pace:</strong> {workout.pace}</div>}
          {workout.description && <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{workout.description}</div>}
        </div>

        <button
          onClick={copyText}
          className="w-full rounded-xl py-3 font-bold mb-3"
          style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}
        >
          Copy Workout
        </button>
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>Automatic watch sync is coming in the FORGE mobile app</p>
        <button onClick={onClose} className="w-full rounded-xl py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>Close</button>
      </div>
    </div>
  )
}

export default function LogRun() {
  const navigate = useNavigate()
  const location = useLocation()
  const { units, fmt } = useUnits()
  const [warmUpState, setWarmUpState] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('warmup') === 'true' ? 'warmup' : 'done'
  })
  const [activeTab, setActiveTab] = useState('today')
  const [countdown, setCountdown] = useState(3)
  const [surface, setSurface] = useState('road')
  const [runType, setRunType] = useState('easy')
  const [environment, setEnvironment] = useState('outside')
  const [treadmillType, setTreadmillType] = useState('Generic')
  const [runBrief, setRunBrief] = useState(null)
  const [trackWorkout, setTrackWorkout] = useState('no')

  const [date, setDate] = useState(todayISO())
  const [distance, setDistance] = useState('')
  const [duration, setDuration] = useState('30:00')
  const [notes, setNotes] = useState('')
  const [effort, setEffort] = useState(5)
  const [loading, setLoading] = useState(false)
  const [polling, setPolling] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false)
  const [showPostCheckIn, setShowPostCheckIn] = useState(false)
  const [savedRunId, setSavedRunId] = useState(null)
  const [recentRuns, setRecentRuns] = useState([])
  const [runsLoading, setRunsLoading] = useState(false)

  const [todayWorkout, setTodayWorkout] = useState(null)
  const [todayLoading, setTodayLoading] = useState(false)
  const [weekPlan, setWeekPlan] = useState(null)
  const [weekPlanLoading, setWeekPlanLoading] = useState(false)
  const [selectedDay, setSelectedDay] = useState(null)
  const [showWatchModal, setShowWatchModal] = useState(false)

  const [selectedRun, setSelectedRun] = useState(null)
  const [showCustomize, setShowCustomize] = useState(false)
  const [panelPrefs, setPanelPrefs] = useState(() => {
    try { return { ...DEFAULT_PANELS, ...(JSON.parse(localStorage.getItem(PANEL_KEY) || '{}')) } } catch { return DEFAULT_PANELS }
  })
  const [editingNotes, setEditingNotes] = useState('')

  useEffect(() => {
    if (warmUpState === 'done') setActiveTab('today')
  }, [warmUpState])

  useEffect(() => {
    if (activeTab !== 'today' || todayWorkout) return
    setTodayLoading(true)
    api.get('/plans/today')
      .then(res => {
        const w = res.data?.today || null
        if (!w) return
        setTodayWorkout({
          day: w.day || w.day_of_week || new Date().toLocaleDateString(undefined, { weekday: 'short' }),
          typeLabel: String(w.type || 'run').replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase()),
          distanceLabel: Number(w.distance_miles) > 0 ? `${Number(w.distance_miles).toFixed(1)} miles` : 'No distance target',
          pace: w.pace_target || w.pace || w.target_pace || '',
          description: w.description || w.notes || '',
        })
      })
      .catch(() => {})
      .finally(() => setTodayLoading(false))
  }, [activeTab, todayWorkout])

  useEffect(() => {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panelPrefs))
  }, [panelPrefs])

  useEffect(() => {
    if (activeTab !== 'week' || weekPlan) return
    setWeekPlanLoading(true)
    api.get('/plans')
      .then(res => {
        const planJson = res.data?.plan?.plan_json
        if (planJson?.weeks?.length) setWeekPlan(planJson.weeks[0].days || [])
      })
      .catch(() => {})
      .finally(() => setWeekPlanLoading(false))
  }, [activeTab, weekPlan])


  useEffect(() => {
    const sid = selectedRun?.id || todayWorkout?.id
    if (!sid) return
    api.get(`/ai/run-brief?sessionId=${sid}`).then((r) => setRunBrief(r.data || null)).catch(() => setRunBrief(null))
  }, [selectedRun?.id, todayWorkout?.id])

  const estimatedTime = useMemo(() => {
    const dist = Number(distance || todayWorkout?.distanceLabel?.split(' ')[0] || 0)
    if (!dist || recentRuns.length === 0) return null
    const paces = recentRuns.filter(r => r.distance_miles > 0 && r.duration_seconds > 0).map(r => r.duration_seconds / 60 / r.distance_miles)
    if (!paces.length) return null
    const avg = paces.reduce((a,b)=>a+b,0) / paces.length
    const low = Math.round((avg * 0.95) * dist)
    const high = Math.round((avg * 1.05) * dist)
    return { low, high, avg }
  }, [distance, todayWorkout, recentRuns])

  const onSubmit = async e => {
    e.preventDefault()
    setError('')
    setFeedback('')
    const seconds = parseDuration(duration)
    if (!seconds) return setError('Please enter a valid duration.')

    try {
      setLoading(true)
      const resolvedSurface = environment === 'inside' ? 'treadmill' : surface
      if (resolvedSurface === 'treadmill') {
        navigate('/run/treadmill', { state: { treadmillType } })
        return
      }
      // Convert distance to miles for backend
      const distanceMiles = units === 'metric' ? fmt.milesFromKm(Number(distance)) : Number(distance)
      const runRes = await api.post('/runs', { date, type: runType, surface: resolvedSurface, run_surface: resolvedSurface, distance_miles: distanceMiles, duration_seconds: seconds, notes, perceived_effort: Number(effort), treadmill_type: treadmillType })
      const runId = runRes.data?.id || runRes.data?.run?.id
      if (runId) api.post('/prs/auto-detect', { run_id: runId }).catch(() => {})
      api.post('/badges/check', {}).catch(() => {})
      if (!runId) {
        setFeedback('Feedback coming soon...')
        setShowRecoveryPrompt(true)
        return
      }

      setSavedRunId(runId)
      setShowPostCheckIn(true)
      setPolling(true)

      let attempts = 0
      let aiFeedback = ''
      while (attempts < 5 && !aiFeedback) {
        attempts += 1
        await new Promise(resolve => setTimeout(resolve, 2000))
        const feedbackRes = await api.get(`/coach/feedback/${runId}`)
        aiFeedback = feedbackRes.data?.ai_feedback || ''
      }

      setFeedback(aiFeedback || 'Your coach is thinking... check back after your next run.')
      setShowRecoveryPrompt(true)
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save run. Check your connection and try again.')
    } finally {
      setLoading(false)
      setPolling(false)
    }
  }

  const selectedSplits = useMemo(() => parseSplits(selectedRun), [selectedRun])

  const saveNotes = async () => {
    if (!selectedRun) return
    try {
      const res = await api.patch(`/runs/${selectedRun.id}`, { notes: editingNotes })
      const updated = res.data || { ...selectedRun, notes: editingNotes }
      setSelectedRun(updated)
      setRecentRuns(prev => prev.map(r => (r.id === updated.id ? { ...r, notes: updated.notes } : r)))
    } catch {
      try {
        const res = await api.put(`/runs/${selectedRun.id}`, { notes: editingNotes })
        const updated = res.data || { ...selectedRun, notes: editingNotes }
        setSelectedRun(updated)
        setRecentRuns(prev => prev.map(r => (r.id === updated.id ? { ...r, notes: updated.notes } : r)))
      } catch {}
    }
  }

  const deleteRun = async () => {
    if (!selectedRun) return
    if (!window.confirm("Are you sure? This can't be undone.")) return
    await api.delete(`/runs/${selectedRun.id}`)
    setRecentRuns(prev => prev.filter(r => r.id !== selectedRun.id))
    setSelectedRun(null)
  }

  if (warmUpState === 'warmup') {
    return (
      <div className="rounded-2xl p-6" style={{ background: 'var(--bg-card)' }}>
        <h2 className="text-xl font-black mb-1" style={{ color: 'var(--text-primary)' }}>Dynamic Warm-Up</h2>
        <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>Complete each movement before you run.</p>
        <div className="space-y-3 mb-6">
          {WARM_UP_STEPS.map((step, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl p-3" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--accent)', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 13, flexShrink: 0 }}>{i + 1}</div>
              <span style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 500 }}>{step}</span>
            </div>
          ))}
        </div>
        <button onClick={() => setWarmUpState('done')} className="w-full rounded-xl py-3 font-bold" style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer', fontSize: 16 }}>Done — Start Run</button>
      </div>
    )
  }

  return (
    <>
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <div className="flex gap-2 mb-5 flex-wrap">
          {[{ key: 'today', label: 'Today' }, { key: 'week', label: 'Week' }, { key: 'log', label: 'Manual' }].map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{ padding: '5px 18px', borderRadius: 999, border: activeTab === tab.key ? '1.5px solid var(--accent)' : '1.5px solid var(--border-subtle)', background: activeTab === tab.key ? 'var(--accent)' : 'transparent', color: activeTab === tab.key ? '#000' : 'var(--text-muted)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>{tab.label}</button>
          ))}
        </div>

        {activeTab === 'today' && (
          <div>
            {runBrief && (
              <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{runBrief.why}</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Effort: {runBrief.effort} · BPM: {runBrief.bpmRange} · Cadence: {runBrief.cadence}</p>
              </div>
            )}
            {todayLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading workout...</p> : todayWorkout ? (
              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                <span className="inline-block rounded-full px-3 py-1 text-xs font-bold mb-3" style={{ background: 'var(--accent)', color: '#000' }}>{todayWorkout.typeLabel}</span>
                <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{todayWorkout.distanceLabel}</p>
                {todayWorkout.pace && <p className="mt-1" style={{ color: 'var(--text-muted)' }}>{todayWorkout.pace}</p>}
                {todayWorkout.description && <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>{todayWorkout.description}</p>}
                <button onClick={() => setShowWatchModal(true)} className="w-full mt-4 rounded-xl py-3 font-bold" style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}>Send to Watch</button>
              </div>
            ) : (
              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                <p style={{ color: 'var(--text-muted)' }}>No workout scheduled today — rest up or log a free run.</p>
                <button onClick={() => setActiveTab('log')} className="mt-4 rounded-xl px-4 py-2 font-semibold" style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}>Log Free Run</button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'week' && (
          <div>
            {weekPlanLoading && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading your week...</p>}
            {!weekPlanLoading && !weekPlan && (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 14 }}>
                No training plan yet. Go to your Plan tab to generate one.
              </div>
            )}
            {weekPlan && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(() => {
                  const todayShort = new Date().toLocaleDateString('en-US', { weekday: 'short' })
                  return weekPlan.map((day, i) => {
                    const isToday = day.day === todayShort
                    const isExpanded = selectedDay === i
                    const typeColor = day.rest ? 'var(--text-muted)' : day.type === 'long' ? '#3b82f6' : 'var(--accent)'
                    return (
                      <div key={i}
                        onClick={() => setSelectedDay(isExpanded ? null : i)}
                        style={{
                          borderRadius: 14, padding: '12px 16px', cursor: 'pointer',
                          background: isToday ? 'var(--accent-dim)' : 'var(--bg-base)',
                          border: `1.5px solid ${isToday ? 'var(--accent)' : 'var(--border-subtle)'}`,
                          transition: 'background 0.15s',
                        }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 36, textAlign: 'center' }}>
                              <p style={{ fontSize: 12, fontWeight: 700, color: isToday ? 'var(--accent)' : 'var(--text-muted)' }}>{day.day}</p>
                              {isToday && <p style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 700 }}>TODAY</p>}
                            </div>
                            <div>
                              <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                                {day.rest ? 'Rest Day' : day.type === 'long' ? 'Long Run' : day.type === 'easy' ? 'Easy Run' : String(day.type).replace(/_/g,' ')}
                              </p>
                              {!day.rest && day.distance_miles > 0 && (
                                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{Number(day.distance_miles).toFixed(1)} miles</p>
                              )}
                            </div>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 700, color: typeColor, background: day.rest ? 'var(--bg-card)' : 'transparent',
                            padding: '3px 8px', borderRadius: 8, border: `1px solid ${typeColor}` }}>
                            {day.rest ? 'Rest' : day.type === 'long' ? 'Long' : 'Easy'}
                          </span>
                        </div>

                        {isExpanded && (
                          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                            {day.description && <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 12 }}>{day.description}</p>}
                            {!day.rest && (
                              <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                                {day.distance_miles > 0 && <div><p style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)' }}>{Number(day.distance_miles).toFixed(1)}</p><p style={{ fontSize: 11, color: 'var(--text-muted)' }}>miles</p></div>}
                                {day.duration_min > 0 && <div><p style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)' }}>{day.duration_min}</p><p style={{ fontSize: 11, color: 'var(--text-muted)' }}>minutes</p></div>}
                                {day.pace_target && <div><p style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)' }}>{day.pace_target}</p><p style={{ fontSize: 11, color: 'var(--text-muted)' }}>target pace</p></div>}
                              </div>
                            )}
                            {!day.rest && isToday && (
                              <button onClick={e => { e.stopPropagation(); navigate('/run/active', { state: { countdown, runType: day.type || 'easy', runEnvironment: 'outdoor', surface: trackWorkout === 'yes' ? 'track' : 'road', mapMyRun: true, trackMode: trackWorkout === 'yes' } }) }}
                                style={{ width: '100%', background: 'var(--accent)', color: '#000', fontWeight: 900, borderRadius: 10, padding: '12px', border: 'none', cursor: 'pointer', fontSize: 14 }}>
                                Start This Run
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })
                })()}
              </div>
            )}
          </div>
        )}

        {activeTab === 'log' && (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
              <p className="text-sm mb-2" style={{ color: 'var(--text-primary)' }}>Run type</p>
              <div className="flex gap-2 mb-4">{['easy','tempo','long','walk'].map((t)=><button key={t} type="button" onClick={()=>setRunType(t)} className="rounded-full px-3 py-1 text-xs font-semibold" style={{background:runType===t?'var(--accent)':'var(--bg-card)',color:runType===t?'#000':'var(--text-muted)',border:'1px solid var(--border-subtle)'}}>{t === 'walk' ? 'Walk' : t.charAt(0).toUpperCase()+t.slice(1)}</button>)}</div>
              <p className="text-sm mb-2" style={{ color: 'var(--text-primary)' }}>Are you running outside or inside?</p>
              <div className="flex gap-2">{['outside','inside'].map((e)=><button key={e} type="button" onClick={()=>setEnvironment(e)} className="rounded-full px-3 py-1 text-xs font-semibold" style={{background:environment===e?'var(--accent)':'var(--bg-card)',color:environment===e?'#000':'var(--text-muted)',border:'1px solid var(--border-subtle)'}}>{e.charAt(0).toUpperCase()+e.slice(1)}</button>)}</div>
              {environment === 'outside' && (
                <div className="mt-3">
                  <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Are you doing a track workout?</p>
                  <div className="flex gap-2">
                    {['yes','no'].map(v => <button key={v} type="button" onClick={() => setTrackWorkout(v)} className="rounded-full px-3 py-1 text-xs font-semibold" style={{background:trackWorkout===v?'var(--accent)':'var(--bg-card)',color:trackWorkout===v?'#000':'var(--text-muted)',border:'1px solid var(--border-subtle)'}}>{v === 'yes' ? 'Yes (track intervals)' : 'No (road run)'}</button>)}
                  </div>
                </div>
              )}
              {environment === 'inside' && (
                <div className="mt-3">
                  <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>What treadmill are you using?</p>
                  <select value={treadmillType} onChange={(e)=>setTreadmillType(e.target.value)} className="w-full rounded-xl px-3 py-2" style={{background:'var(--bg-card)',color:'var(--text-primary)',border:'1px solid var(--border-subtle)'}}>
                    {['Generic','Peloton','NordicTrack','Precor','Life Fitness','Other'].map(o=><option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-center py-6">
                <input type="number" step="0.1" min="0" required className="text-5xl font-bold bg-transparent text-center w-32 focus:outline-none" style={{ color: 'var(--accent)' }} value={distance} onChange={e => setDistance(e.target.value)} placeholder="0.0" />
                <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Distance ({fmt.distanceLabel})</div>
                {estimatedTime && <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Estimated time: {estimatedTime.low}–{estimatedTime.high} min based on your recent {Math.floor(estimatedTime.avg)}:{String(Math.round((estimatedTime.avg%1)*60)).padStart(2,'0')}/mi average pace</p>}
              </div>
            </div>

            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex gap-2 justify-center">
                <input type="text" required value={duration} onChange={e => setDuration(e.target.value)} onBlur={() => { const sec = parseDuration(duration); if (sec) setDuration(formatDurationDisplay(sec)) }} placeholder="MM:SS or HH:MM:SS" className="w-full max-w-xs rounded-full border px-4 py-3 text-center text-xl font-bold" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-primary)' }} />
              </div>
            </div>

            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
              <textarea rows={4} placeholder="How did it feel? Anything worth remembering?" value={notes} onChange={e => setNotes(e.target.value)} className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-primary)' }} />
            </div>

            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex gap-2 mb-4">
                {SURFACE_OPTIONS.map(opt => {
                  const Icon = opt.icon
                  const selected = surface === opt.value
                  return (
                    <button key={opt.value} type="button" onClick={() => setSurface(opt.value)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '10px 4px', borderRadius: 12, border: selected ? '2px solid var(--accent)' : '2px solid var(--border-subtle)', background: selected ? 'var(--bg-card)' : 'var(--bg-base)', color: selected ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}><Icon size={20} /><span>{opt.label}</span></button>
                  )
                })}
              </div>
              <EffortBar effort={effort} setEffort={setEffort} />
            </div>

            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-primary)' }} />

            <button type="submit" disabled={loading || polling} className="w-full rounded-xl py-3 font-semibold disabled:opacity-70" style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}>{loading ? 'Logging run...' : 'Save Run'}</button>
            {error && <p className="mt-2 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}
            {feedback && <div className="mt-2 rounded-xl p-3" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>{feedback}</div>}
            {savedRunId && (
              <div className="mt-4">
                <PhotoUploader activityId={savedRunId} activityType="run" />
              </div>
            )}
          </form>
        )}

        <Link to="/" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>← Back</Link>
      </div>

      {showWatchModal && <WorkoutWatchModal workout={todayWorkout} onClose={() => setShowWatchModal(false)} />}

      {selectedRun && (
        <div className="fixed inset-0 z-50" style={{ background: 'var(--bg-base)' }}>
          <div className="h-full overflow-auto p-4">
            <div className="flex items-center justify-between mb-4">
              <button onClick={() => setSelectedRun(null)} style={{ color: 'var(--text-primary)' }}>← Back</button>
              <h3 className="font-bold" style={{ color: 'var(--text-primary)' }}>Run Detail</h3>
              <button onClick={() => setShowCustomize(true)} style={{ color: 'var(--text-primary)' }}><Pencil size={18} /></button>
            </div>

            {panelPrefs.overview && <div className="rounded-xl p-4 mb-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}><h4 className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Overview</h4><div className="text-sm" style={{ color: 'var(--text-muted)' }}>{selectedRun.date}</div><div className="flex gap-2 mt-2"><span className="px-2 py-1 rounded-full text-xs" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>{selectedRun.surface || selectedRun.run_surface || 'road'}</span><span className="px-2 py-1 rounded-full text-xs" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>Effort {selectedRun.perceived_effort || 5}/10</span><span className="px-2 py-1 rounded-full text-xs" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>{selectedRun.type}</span></div></div>}

            {panelPrefs.stats && <div className="rounded-xl p-4 mb-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}><h4 className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Stats</h4><div className="grid grid-cols-2 gap-2"><div className="rounded-xl p-3" style={{ background: 'var(--bg-base)' }}><div className="text-xs" style={{ color: 'var(--text-muted)' }}>Distance</div><div className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{selectedRun.distance_miles || 0} mi</div></div><div className="rounded-xl p-3" style={{ background: 'var(--bg-base)' }}><div className="text-xs" style={{ color: 'var(--text-muted)' }}>Time</div><div className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{formatRunDuration(selectedRun.duration_seconds || 0)}</div></div><div className="rounded-xl p-3" style={{ background: 'var(--bg-base)' }}><div className="text-xs" style={{ color: 'var(--text-muted)' }}>Avg Pace</div><div className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{formatPace(selectedRun.duration_seconds, selectedRun.distance_miles)}</div></div><div className="rounded-xl p-3" style={{ background: 'var(--bg-base)' }}><div className="text-xs" style={{ color: 'var(--text-muted)' }}>Calories</div><div className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{selectedRun.calories || '—'}</div></div></div></div>}

            {panelPrefs.pace && <div className="rounded-xl p-4 mb-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}><h4 className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Pace Chart</h4>{selectedSplits.length ? <svg width="100%" height="120" viewBox="0 0 320 120">{selectedSplits.map((split, i) => { const v = Number(split.seconds || split.pace_seconds || split.value || 0); const h = Math.max(10, 100 - Math.min(90, Math.floor(v / 10))); return <rect key={i} x={10 + i * 30} y={110 - h} width="20" height={h} fill="var(--accent)" /> })}</svg> : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>GPS splits available in the mobile app</p>}</div>}

            {panelPrefs.hr && <div className="rounded-xl p-4 mb-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}><h4 className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Heart Rate</h4>{selectedRun.avg_hr || selectedRun.avg_heart_rate ? <div className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{selectedRun.avg_hr || selectedRun.avg_heart_rate} bpm</div> : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Connect a watch to see HR data</p>}</div>}

            {panelPrefs.notes && <div className="rounded-xl p-4 mb-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}><h4 className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Notes</h4><textarea rows={5} value={editingNotes} onChange={e => setEditingNotes(e.target.value)} className="w-full rounded-xl border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-primary)' }} /><button onClick={saveNotes} className="mt-2 rounded-lg px-3 py-2 text-sm font-semibold" style={{ background: 'var(--accent)', color: '#000', border: 'none' }}>Save Notes</button></div>}

            <button onClick={deleteRun} className="w-full rounded-xl py-3 font-bold" style={{ background: 'var(--bg-card)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>Delete Run</button>
          </div>

          {showCustomize && (
            <div className="fixed inset-x-0 bottom-0 z-10 rounded-t-2xl p-4" style={{ background: 'var(--bg-card)', borderTop: '1px solid var(--border-subtle)' }}>
              <h4 className="font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Customize Panels</h4>
              {Object.entries({ overview: 'Overview', stats: 'Stats Grid', pace: 'Pace Chart', hr: 'Heart Rate', notes: 'Notes' }).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between py-2" style={{ color: 'var(--text-primary)' }}>
                  <span>{label}</span>
                  <input type="checkbox" checked={panelPrefs[key]} onChange={e => setPanelPrefs(prev => ({ ...prev, [key]: e.target.checked }))} />
                </label>
              ))}
              <button onClick={() => setShowCustomize(false)} className="w-full mt-3 rounded-xl py-2" style={{ background: 'var(--accent)', color: '#000', border: 'none' }}>Done</button>
            </div>
          )}
        </div>
      )}

      {showPostCheckIn && savedRunId && <PostRunCheckIn runId={savedRunId} onDone={() => { setShowPostCheckIn(false); navigate('/') }} />}

      {showRecoveryPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <h3 className="text-xl font-black" style={{ color: 'var(--text-primary)' }}>Great run! Time to recover.</h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Post-run recovery uses static holds. Hold each stretch for the full duration to target the muscles you just used.</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => { setShowRecoveryPrompt(false); navigate('/stretches/session?type=post') }} className="flex-1 rounded-xl px-4 py-2 font-bold" style={{ background: 'var(--accent)', color: '#000', border: 'none' }}>Start Recovery</button>
              <button onClick={() => setShowRecoveryPrompt(false)} className="flex-1 rounded-xl px-4 py-2" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>Skip</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
