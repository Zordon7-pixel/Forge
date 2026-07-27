import { lazy, Suspense, useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { MapPin, Mountain, RefreshCw, Gauge, Pencil } from 'lucide-react'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import track from '../lib/track'
import { parseDuration, formatDurationDisplay } from '../lib/parseDuration'
import PostRunCheckIn from '../components/PostRunCheckIn'
import WatchWorkoutSendButton from '../components/WatchWorkoutSendButton'
import AiGuidanceNote from '../components/AiGuidanceNote'
import { queueRequest } from '../lib/offlineQueue'
import { scrollToFirstError, validateRunLog } from '../utils/validation'
import WatchWorkoutService from '../services/WatchWorkoutService'
import { fetchDailyExecution, scheduledRunFromExecution, planSessionIdFromState, currentWeekFromState, markSessionComplete, queueSessionComplete, isRetryableCompletionFailure, localDateISO, unplannedRunRouteState, makeupRunRouteState } from '../lib/dailyExecution'
import { loadPostRunCheckInDraft } from '../lib/postRunCheckInDraft'
import { buildPlannedSessionSnapshot } from '../lib/runProvenance'
import { lockDocumentScroll } from '../lib/documentScrollLock'
import { activeRunReturnTargetFromLocation, withActiveRunReturnTarget } from '../lib/activeRunControls'
import { resolveRunCompletion, RUN_PROVENANCE } from '../lib/runCompletionPolicy'

const RoutePlanner = lazy(() => import('../components/RoutePlanner'))

function todayISO() {
  const now = new Date()
  const offsetDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return offsetDate.toISOString().slice(0, 10)
}

function createClientRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    const nibble = char === 'x' ? value : (value & 0x3) | 0x8
    return nibble.toString(16)
  })
}

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

function parsePaceToSecondsPerMile(pace) {
  if (!pace || typeof pace !== 'string') return null
  const clean = pace.trim().toLowerCase().replace('/mi', '')
  const [m, s] = clean.split(':').map(Number)
  if (!Number.isFinite(m) || !Number.isFinite(s)) return null
  return (m * 60) + s
}

function cleanRunType(value = '') {
  return String(value || 'run').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function getRunCoachingDetails(type = '', pace = '') {
  const normalized = String(type || '').toLowerCase()
  if (normalized.includes('interval')) {
    return {
      zone: 'Zone 4',
      intensity: 'Threshold / intervals',
      progression: 'Quality day — keep reps controlled, recover easy between pushes.',
      steps: ['10 min easy warm-up', 'Main intervals at controlled hard effort', '5-10 min easy cool-down'],
    }
  }
  if (normalized.includes('tempo') || normalized.includes('quality') || normalized.includes('moderate') || normalized.includes('steady')) {
    return {
      zone: 'Zone 3',
      intensity: 'Comfortably hard',
      progression: 'Progression run — start easy, settle into steady rhythm, finish controlled.',
      steps: ['8-10 min easy', 'Middle miles steady', 'Last 5 min controlled, not sprinting'],
    }
  }
  if (normalized.includes('long')) {
    return {
      zone: 'Zone 2',
      intensity: 'Easy aerobic',
      progression: 'Long aerobic build — keep it conversational so the distance does the work.',
      steps: ['First mile relaxed', 'Hold even effort through the middle', 'Finish with form tall and breathing calm'],
    }
  }
  if (normalized.includes('recovery')) {
    return {
      zone: 'Zone 1-2',
      intensity: 'Recovery',
      progression: 'Recovery run — slower than normal is the goal today.',
      steps: ['5 min very easy', 'Keep every mile conversational', 'Stop if soreness changes your stride'],
    }
  }
  return {
    zone: pace ? 'Zone 2' : 'Easy effort',
    intensity: 'Conversational aerobic',
    progression: 'Easy aerobic run — build consistency without forcing speed.',
    steps: ['5-10 min relaxed warm-up', 'Hold steady conversational pace', 'Cool down easy'],
  }
}

function normalizeSteps(value) {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter(Boolean) : []
    } catch {
      return value.split(/\n|•/).map((item) => item.trim()).filter(Boolean)
    }
  }
  return []
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
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Effort (optional)</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Leave blank if you would rather add how you felt from the recap.</p>
        </div>
        {effort !== null && (
          <button type="button" onClick={() => setEffort(null)} className="text-xs font-bold" style={{ color: 'var(--accent)' }}>
            Clear
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(level => {
          const isActive = effort !== null && level <= effort
          return (
            <button
              key={level}
              type="button"
              aria-label={`Set effort to ${level} out of 10`}
              aria-pressed={effort === level}
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
          {effort ?? '—'}
        </span>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3, fontWeight: 600 }}>
          {effort === null ? 'Not provided' : getEffortLabel(effort)}
        </div>
      </div>
    </div>
  )
}

function WorkoutWatchModal({ workout, onClose }) {
  if (!workout) return null

  const watchWorkout = WatchWorkoutService.buildRunWorkout(workout)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-md rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <h3 className="text-xl font-black mb-4" style={{ color: 'var(--text-primary)' }}>Today's Workout</h3>
        <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
          <div className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>{workout.day}</div>
          <span className="inline-block rounded-full px-3 py-1 text-xs font-bold mb-3" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            {workout.typeLabel}
          </span>
          <div className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}><strong>Distance:</strong> {workout.distanceLabel}</div>
          {workout.pace && <div className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}><strong>Pace:</strong> {workout.pace}</div>}
          {workout.zone && <div className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}><strong>Target:</strong> {workout.zone} · {workout.intensity}</div>}
          {workout.durationLabel && <div className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}><strong>Est. time:</strong> {workout.durationLabel}</div>}
          {workout.description && <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{workout.description}</div>}
          {workout.steps?.length > 0 && (
            <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <p className="text-xs font-bold uppercase mb-2" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Workout structure</p>
              {workout.steps.map((step, index) => (
                <p key={`${step}-${index}`} className="text-xs mb-1" style={{ color: 'var(--text-primary)' }}>{index + 1}. {step}</p>
              ))}
            </div>
          )}
        </div>

        <WatchWorkoutSendButton workout={watchWorkout} className="mb-4" />
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>Forged Hybrid prepares a structured watch workout. Apple Watch can receive it from the iPhone app now; Garmin, COROS, Polar, Suunto, Wahoo, and TrainingPeaks plug in after partner access.</p>
        <button onClick={onClose} className="w-full rounded-xl py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>Close</button>
      </div>
    </div>
  )
}

export default function LogRun() {
  const navigate = useNavigate()
  const location = useLocation()
  const activeRunReturnTo = activeRunReturnTargetFromLocation(location.pathname, location.search)
  const query = useMemo(() => new URLSearchParams(location.search), [location.search])
  const { units, fmt } = useUnits()
  const [warmUpState] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('warmup') === 'true' ? 'warmup' : 'done'
  })
  const [activeTab, setActiveTab] = useState(() => {
    if (query.get('tab') === 'manual') return 'log'
    if (query.get('tab') === 'week') return 'week'
    return 'today'
  })
  const [countdown, setCountdown] = useState(3)
  const [surface, setSurface] = useState('road')
  const [runType, setRunType] = useState(() => {
    const qType = query.get('type')
    if (qType === 'moderate_run') return 'tempo'
    if (qType === 'long_run') return 'long'
    if (qType === 'easy_run') return 'easy'
    return 'easy'
  })
  const [environment, setEnvironment] = useState('outside')
  const [treadmillType, setTreadmillType] = useState('Generic')
  const [runBrief, setRunBrief] = useState(null)
  const [trackWorkout, setTrackWorkout] = useState('no')

  const [date, setDate] = useState(todayISO())
  const [distance, setDistance] = useState(() => query.get('distance') || '')
  const [duration, setDuration] = useState(() => {
    const rawDistance = Number(query.get('distance') || 0)
    const paceSec = parsePaceToSecondsPerMile(query.get('pace'))
    if (rawDistance > 0 && paceSec) {
      return formatRunDuration(Math.round(rawDistance * paceSec))
    }
    return '30:00'
  })
  const [notes, setNotes] = useState('')
  const [effort, setEffort] = useState(null)
  const [loading, setLoading] = useState(false)
  const [pendingPostRunDraft] = useState(() => loadPostRunCheckInDraft())
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [fieldWarnings, setFieldWarnings] = useState({})
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false)
  const [showPostCheckIn, setShowPostCheckIn] = useState(Boolean(pendingPostRunDraft))
  const [savedRunId, setSavedRunId] = useState(pendingPostRunDraft?.runId || null)
  const [savedHeatDrift, setSavedHeatDrift] = useState(pendingPostRunDraft?.heatDrift || null)
  const [recentRuns, setRecentRuns] = useState([])
  const [runsLoading, setRunsLoading] = useState(false)

  const [todayWorkout, setTodayWorkout] = useState(null)
  // H5: canonical scheduled-run handoff — the plan session id + week survive
  // through warmup / ActiveRun so completion targets the exact calendar session.
  const [planSessionId, setPlanSessionId] = useState(() => planSessionIdFromState(location.state))
  const [planCurrentWeek, setPlanCurrentWeek] = useState(() => currentWeekFromState(location.state))
  const [todayLoading, setTodayLoading] = useState(false)
  const [weekPlan, setWeekPlan] = useState(null)
  const [weekPlanLoading, setWeekPlanLoading] = useState(false)
  const [selectedDay, setSelectedDay] = useState(null)
  const [showWatchModal, setShowWatchModal] = useState(false)
  const [routePlannerStatus, setRoutePlannerStatus] = useState({ available: false, requiresPro: false })
  const [runIntentOpen, setRunIntentOpen] = useState(() => query.get('intent') === 'rest-day')
  const [runIntentLoading, setRunIntentLoading] = useState(false)
  const [runIntentError, setRunIntentError] = useState('')
  const [missedRunOptions, setMissedRunOptions] = useState([])
  const [todayIsPlanRestDay, setTodayIsPlanRestDay] = useState(false)
  const [startingMakeupId, setStartingMakeupId] = useState(null)
  const [selectedRunIntentId, setSelectedRunIntentId] = useState('extra')

  const [selectedRun, setSelectedRun] = useState(null)
  const [showCustomize, setShowCustomize] = useState(false)
  const [panelPrefs, setPanelPrefs] = useState(() => {
    try { return { ...DEFAULT_PANELS, ...(JSON.parse(localStorage.getItem(PANEL_KEY) || '{}')) } } catch { return DEFAULT_PANELS }
  })
  const [editingNotes, setEditingNotes] = useState('')
  const [activeShoes, setActiveShoes] = useState([])
  const [selectedShoeId, setSelectedShoeId] = useState('')
  const [checkingCheckIn, setCheckingCheckIn] = useState(true)
  const [checkInCompleted, setCheckInCompleted] = useState(false)
  const distanceErrorRef = useRef(null)
  const durationErrorRef = useRef(null)
  const runIntentDialogRef = useRef(null)
  const runBriefIsAi = runBrief?.source === 'ai'
  const todayCoachingIsAi = runBriefIsAi || Boolean(todayWorkout?.aiReason)

  useEffect(() => {
    if (warmUpState !== 'done') return
    if (query.get('tab') === 'manual') setActiveTab('log')
    else if (query.get('tab') === 'week') setActiveTab('week')
    else setActiveTab('today')
    if (query.get('intent') === 'rest-day') setRunIntentOpen(true)
  }, [query, warmUpState])

  useEffect(() => {
    if (!runIntentOpen) return undefined
    let active = true
    setRunIntentLoading(true)
    setRunIntentError('')
    Promise.all([
      api.get(`/plans/compliance?date=${encodeURIComponent(localDateISO())}`),
      fetchDailyExecution(localDateISO()),
    ])
      .then(([complianceRes, execution]) => {
        if (!active) return
        const missed = Array.isArray(complianceRes.data?.missed) ? complianceRes.data.missed : []
        setMissedRunOptions(missed.filter((item) => item?.type === 'run').sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))))
        setTodayIsPlanRestDay(Boolean(execution?.hasPlan && execution?.hasDay && execution?.isRest))
      })
      .catch((err) => {
        if (!active) return
        console.error('[LogRun] missed-run choices failed:', err?.message || err)
        setMissedRunOptions([])
        setTodayIsPlanRestDay(false)
        setRunIntentError('Forged Hybrid could not check missed sessions right now. You can still start an extra run.')
      })
      .finally(() => {
        if (active) setRunIntentLoading(false)
      })
    return () => { active = false }
  }, [runIntentOpen])

  useEffect(() => {
    if (!runIntentOpen) return undefined
    const previouslyFocused = document.activeElement
    const unlockDocumentScroll = lockDocumentScroll()
    const focusFrame = window.requestAnimationFrame(() => {
      runIntentDialogRef.current?.focus({ preventScroll: true })
    })
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setRunIntentOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown)
      unlockDocumentScroll()
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        window.requestAnimationFrame(() => previouslyFocused.focus({ preventScroll: true }))
      }
    }
  }, [runIntentOpen])

  useEffect(() => {
    let active = true
    api.get('/routes/planner-status')
      .then((response) => {
        if (active) {
          setRoutePlannerStatus({
            available: Boolean(response.data?.available),
            requiresPro: Boolean(response.data?.requiresPro),
          })
        }
      })
      .catch((err) => {
        console.error('[LogRun] route planner availability check failed:', err.message)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const { data } = await api.get('/checkin/today', { params: { date: todayISO() } })
        const completed = Boolean(data?.completed ?? data?.id ?? data)
        if (active) setCheckInCompleted(completed)
      } catch {
        if (active) setCheckInCompleted(false)
      } finally {
        if (active) setCheckingCheckIn(false)
      }
    }
    check()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (activeTab !== 'today' || todayWorkout) return
    setTodayLoading(true)
    // H5: source today's run from the canonical daily execution. The legacy
    // `today` payload + next-recommendation stay ONLY as a fallback when there
    // is no executable scheduled calendar run (rest day / no plan / legacy).
    Promise.all([
      fetchDailyExecution(localDateISO()).catch((err) => {
        console.error('[LogRun] canonical daily execution fetch failed:', err?.message || err)
        return null
      }),
      api.get('/plans/today'),
      api.get('/runs/next-recommendation').catch((err) => {
        console.error('[LogRun] next recommendation fetch failed:', err?.message || err)
        return { data: null }
      }),
    ])
      .then(([execution, planRes, recRes]) => {
        const scheduledRun = scheduledRunFromExecution(execution)
        if (scheduledRun) {
          // Canonical scheduled run — do NOT merge the AI recommendation over it.
          const type = scheduledRun.type || scheduledRun.workout_type || 'run'
          const distanceMiles = Number(scheduledRun.distance_miles || scheduledRun.distance || 0)
          const pace = scheduledRun.pace_target || scheduledRun.pace || scheduledRun.target_pace || ''
          const details = getRunCoachingDetails(type, pace)
          const plannedSteps = normalizeSteps(scheduledRun.steps || scheduledRun.structure)
          const zoneLabel = scheduledRun.target_zone
            || (scheduledRun.hrZone && scheduledRun.hrZone.zone ? `Zone ${scheduledRun.hrZone.zone}` : '')
            || details.zone
          const bpmLabel = scheduledRun.hrZone && Number.isFinite(scheduledRun.hrZone.minBpm) && Number.isFinite(scheduledRun.hrZone.maxBpm)
            ? `${scheduledRun.hrZone.minBpm}${scheduledRun.hrZone.openEnded ? '+' : `-${scheduledRun.hrZone.maxBpm}`} bpm`
            : ''
          const estimatedSeconds = distanceMiles > 0 && parsePaceToSecondsPerMile(pace)
            ? Math.round(distanceMiles * parsePaceToSecondsPerMile(pace))
            : Number(scheduledRun.duration_min || 0) > 0 ? Number(scheduledRun.duration_min) * 60 : 0
          setPlanSessionId(scheduledRun.id ? String(scheduledRun.id) : null)
          setPlanCurrentWeek(currentWeekFromState({ currentWeek: execution?.week }))
          setRunBrief(null)
          setTodayWorkout({
            id: scheduledRun.id || '',
            source: 'calendar',
            day: execution.day || new Date().toLocaleDateString(undefined, { weekday: 'short' }),
            typeLabel: cleanRunType(type),
            rawType: type,
            distanceMiles,
            distanceLabel: distanceMiles > 0 ? `${distanceMiles.toFixed(1)} miles` : 'No distance target',
            pace,
            targetZone: zoneLabel,
            zone: bpmLabel ? `${zoneLabel} · ${bpmLabel}` : zoneLabel,
            intensity: scheduledRun.intensity || details.intensity,
            progression: scheduledRun.progression || details.progression,
            steps: plannedSteps.length ? plannedSteps : details.steps,
            durationLabel: estimatedSeconds ? formatRunDuration(estimatedSeconds) : '',
            description: scheduledRun.description || scheduledRun.notes || '',
            aiReason: '',
            healthAdjusted: false,
          })
          return
        }
        // An active calendar owns today's prescription even when today is rest
        // or lift-only. Never reinterpret the flattened legacy day as a run.
        if (execution?.hasPlan && execution?.hasDay) {
          setRunBrief(null)
          setTodayWorkout(null)
          return
        }
        // Fallback: legacy /plans/today `today` merged with next-recommendation.
        const w = planRes.data?.today || null
        const rec = recRes.data && typeof recRes.data === 'object' ? recRes.data : {}
        const recommendationType = String(rec.recommendationType || '').toLowerCase()
        if (!w && (!recommendationType || recommendationType === 'rest' || recommendationType === 'strength')) return
        const source = w || rec
        setRunBrief(rec.brief && typeof rec.brief === 'object' ? { ...rec.brief, source: 'ai' } : null)
        const type = source.type || source.workout_type || rec.recommendationType || 'run'
        const distanceMiles = Number(source.distance_miles || source.distance || rec.suggestedDistance || 0)
        const pace = source.pace_target || source.pace || source.target_pace || rec.suggestedPace || ''
        const details = getRunCoachingDetails(type, pace)
        const plannedSteps = normalizeSteps(source.steps || source.structure)
        const recommendedSteps = normalizeSteps(rec.steps)
        const estimatedSeconds = distanceMiles > 0 && parsePaceToSecondsPerMile(pace)
          ? Math.round(distanceMiles * parsePaceToSecondsPerMile(pace))
          : Number(source.duration_min || 0) > 0 ? Number(source.duration_min) * 60 : 0
        setTodayWorkout({
          id: source.id || '',
          source: w ? 'legacy-plan' : 'recommendation',
          day: source.day || source.day_of_week || new Date().toLocaleDateString(undefined, { weekday: 'short' }),
          typeLabel: cleanRunType(type),
          rawType: type,
          distanceMiles,
          distanceLabel: distanceMiles > 0 ? `${distanceMiles.toFixed(1)} miles` : 'No distance target',
          pace,
          targetZone: source.zone || source.target_zone || rec.targetZone || details.zone,
          zone: source.zone || source.target_zone || rec.targetZone || details.zone,
          intensity: source.intensity || rec.intensity || details.intensity,
          progression: source.progression || rec.progression || details.progression,
          steps: plannedSteps.length ? plannedSteps : recommendedSteps.length ? recommendedSteps : details.steps,
          durationLabel: estimatedSeconds ? formatRunDuration(estimatedSeconds) : '',
          description: source.description || source.notes || rec.reason || '',
          aiReason: rec.reason || '',
          healthAdjusted: Boolean(rec.healthAdjusted),
        })
      })
      .catch((err) => {
        console.error('[LogRun] failed to load today workout:', err?.message || err)
      })
      .finally(() => setTodayLoading(false))
  }, [activeTab, todayWorkout])

  useEffect(() => {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panelPrefs))
  }, [panelPrefs])

  useEffect(() => {
    api.get('/gear/shoes').then(r => setActiveShoes(r.data?.shoes || [])).catch((err) => {
      console.error('[LogRun] shoe lookup failed:', err?.message || err)
    })
  }, [])

  useEffect(() => {
    if (activeTab !== 'week' || weekPlan) return
    setWeekPlanLoading(true)
    api.get('/plans/my')
      .then(res => {
        const planJson = res.data?.plan?.plan_data || res.data?.plan?.plan_json
        const currentWeek = Math.max(1, Number(res.data?.user_plan?.current_week || 1))
        if (planJson?.weeks?.length) {
          const week = planJson.weeks[currentWeek - 1] || planJson.weeks[0]
          setWeekPlan(week?.days || week?.sessions || [])
        }
      })
      .catch((err) => {
        console.error('[LogRun] week plan fetch failed:', err?.message || err)
      })
      .finally(() => setWeekPlanLoading(false))
  }, [activeTab, weekPlan])


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
    const distanceMiles = units === 'metric' ? fmt.milesFromKm(Number(distance)) : Number(distance)
    const { errors: validationErrors, warnings } = validateRunLog({
      distance,
      durationSeconds: seconds,
      distanceMiles,
    })
    setFieldErrors(validationErrors)
    setFieldWarnings(warnings)
    if (Object.keys(validationErrors).length) {
      scrollToFirstError({ distance: distanceErrorRef, duration: durationErrorRef }, ['distance', 'duration'])
      return
    }

    const clientRunId = createClientRunId()
    const resolvedSurface = environment === 'inside' ? 'treadmill' : surface
    // The Manual tab records an ad-hoc activity. It must not inherit a plan
    // session just because the athlete arrived here from a scheduled workout.
    const submittedPlanSessionId = activeTab === 'log' ? null : planSessionId
    const submittedScheduledRun = submittedPlanSessionId ? todayWorkout : null
    const plannedSession = buildPlannedSessionSnapshot({
      planSessionId: submittedPlanSessionId,
      scheduledRun: submittedScheduledRun,
      workoutTarget: {
        distanceMiles: submittedScheduledRun?.distanceMiles || null,
        pace: submittedScheduledRun?.pace || null,
        zone: submittedScheduledRun?.targetZone || null,
      },
      date,
    })
    const runPayload = {
      id: clientRunId,
      date,
      type: runType,
      surface: resolvedSurface,
      run_surface: resolvedSurface,
      distance_miles: distanceMiles,
      duration_seconds: seconds,
      notes,
      perceived_effort: effort,
      watch_mode: RUN_PROVENANCE.MANUAL,
      treadmill_brand: treadmillType,
      shoe_id: selectedShoeId || null,
      target_zone: submittedScheduledRun?.targetZone || null,
      plan_session_id: submittedPlanSessionId,
      planned_session: plannedSession,
    }

    try {
      setLoading(true)
      if (!navigator.onLine) {
        await queueRequest('/api/runs', 'POST', runPayload)
        // H5: order completion AFTER the queued run so it replays second.
        let progressNotice = ''
        if (submittedPlanSessionId) {
          try {
            await queueSessionComplete(submittedPlanSessionId, planCurrentWeek)
          } catch (completionErr) {
            console.error('[LogRun] failed to queue plan completion:', completionErr?.message || completionErr)
            progressNotice = ' Open Plan after the run syncs to mark this session complete.'
          }
        }
        const completion = resolveRunCompletion({
          provenance: RUN_PROVENANCE.MANUAL,
          runId: clientRunId,
          queued: true,
        })
        setShowPostCheckIn(completion.requiresImmediateCheckIn)
        setFeedback(`Saved offline — will sync when connected.${progressNotice}`)
        setShowRecoveryPrompt(true)
        return
      }

      const runRes = await api.post('/runs', runPayload)
      track('run_logged')
      const runId = runRes.data?.id || runRes.data?.run?.id || clientRunId
      if (runId) api.post('/prs/auto-detect', { run_id: runId }).catch((err) => {
        console.error('[LogRun] PR auto-detect failed:', err?.message || err)
      })
      // Phase 2L — /badges/check removed (display retired in 2K).
      // H5: mark the scheduled calendar session complete ONLY after the run
      // saved successfully. A failed completion must never roll back the run —
      // surface a non-blocking notice instead.
      let planProgressNotice = ''
      if (submittedPlanSessionId) {
        try {
          await markSessionComplete(submittedPlanSessionId, planCurrentWeek)
        } catch (completionErr) {
          console.error('[LogRun] plan completion failed:', completionErr?.message || completionErr)
          if (isRetryableCompletionFailure(completionErr)) {
            try {
              await queueSessionComplete(submittedPlanSessionId, planCurrentWeek)
              planProgressNotice = 'Plan progress is queued for sync.'
            } catch (queueErr) {
              console.error('[LogRun] failed to queue completion retry:', queueErr?.message || queueErr)
              planProgressNotice = 'Open Plan to mark this session complete.'
            }
          } else {
            planProgressNotice = 'Open Plan to mark this session complete.'
          }
        }
      }

      setFeedback(planProgressNotice)
      const completion = resolveRunCompletion({
        provenance: RUN_PROVENANCE.MANUAL,
        runId,
      })
      if (completion.destination) {
        navigate(completion.destination, { replace: true })
      }
    } catch (err) {
      if (!err?.response) {
        await queueRequest('/api/runs', 'POST', runPayload)
        // H5: order completion AFTER the queued run so it replays second.
        let progressNotice = ''
        if (submittedPlanSessionId) {
          try {
            await queueSessionComplete(submittedPlanSessionId, planCurrentWeek)
          } catch (completionErr) {
            console.error('[LogRun] failed to queue plan completion:', completionErr?.message || completionErr)
            progressNotice = ' Open Plan after the run syncs to mark this session complete.'
          }
        }
        const completion = resolveRunCompletion({
          provenance: RUN_PROVENANCE.MANUAL,
          runId: clientRunId,
          queued: true,
        })
        setShowPostCheckIn(completion.requiresImmediateCheckIn)
        setFeedback(`Saved offline — will sync when connected.${progressNotice}`)
        setShowRecoveryPrompt(true)
        setError('')
        return
      }
      setError(err?.response?.data?.error || 'Could not save run. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  const selectedSplits = useMemo(() => parseSplits(selectedRun), [selectedRun])

  const startPlannedRoute = (plannedRoute, routeSurface) => {
    navigate('/run/active', {
      state: withActiveRunReturnTarget({
        countdown,
        runType: todayWorkout?.rawType || 'easy',
        runEnvironment: 'outdoor',
        surface: routeSurface,
        mapMyRun: true,
        plannedRoute,
        // H5: carry the canonical plan session so ActiveRun can mark it complete.
        planSessionId,
        currentWeek: planCurrentWeek,
        scheduledRun: todayWorkout,
        workoutTarget: {
          distanceMiles: todayWorkout?.distanceMiles || plannedRoute?.targetDistanceMiles || null,
          pace: todayWorkout?.pace || null,
          zone: todayWorkout?.targetZone || null,
        },
      }, activeRunReturnTo),
    })
  }

  // H5: the scheduled run keeps the normal warm-up, then carries the exact
  // calendar session into ActiveRun. Manual logging remains secondary.
  const startScheduledRun = () => {
    navigate('/warmup', {
      state: withActiveRunReturnTarget({
        countdown,
        runType: todayWorkout?.rawType || 'easy',
        runEnvironment: 'outdoor',
        mapMyRun: true,
        planSessionId,
        currentWeek: planCurrentWeek,
        scheduledRun: todayWorkout,
        startAfterWarmup: true,
        workoutTarget: {
          distanceMiles: todayWorkout?.distanceMiles || null,
          pace: todayWorkout?.pace || null,
          zone: todayWorkout?.targetZone || null,
        },
      }, activeRunReturnTo),
    })
  }

  const startUnplannedRun = () => {
    track('unplanned_run_started', { via: activeTab === 'log' ? 'manual_tab' : 'rest_day' })
    if (environment === 'inside') {
      navigate('/run/treadmill', { state: { treadmillType, disablePlanMatch: true } })
      return
    }
    const selectedSurface = trackWorkout === 'yes'
      ? 'track'
      : surface === 'treadmill' ? 'road' : surface
    navigate('/warmup', {
      state: withActiveRunReturnTarget(
        unplannedRunRouteState({ countdown, runType, surface: selectedSurface }),
        activeRunReturnTo,
      ),
    })
  }

  const openRunIntent = () => {
    setRunIntentError('')
    setSelectedRunIntentId('extra')
    setRunIntentOpen(true)
    track('run_intent_opened', { via: activeTab === 'log' ? 'manual_tab' : 'rest_day' })
  }

  const startExtraRun = () => {
    setRunIntentOpen(false)
    startUnplannedRun()
  }

  const startMakeupRun = async (missed) => {
    const state = makeupRunRouteState(missed, {
      countdown,
      environment: environment === 'inside' ? 'indoor' : 'outdoor',
      surface: trackWorkout === 'yes' ? 'track' : surface,
      treadmillBrand: treadmillType,
    })
    if (!state) {
      setRunIntentError('That missed session is no longer available. Refresh and choose another run.')
      return
    }
    if (!todayIsPlanRestDay) {
      setRunIntentError('Make-up runs can replace a plan rest day only. Start an extra run or open the calendar to avoid stacking workouts.')
      return
    }

    setStartingMakeupId(state.planSessionId)
    setRunIntentError('')
    try {
      const targetDate = localDateISO()
      const response = await api.post('/plans/reschedule-missed', {
        sessionId: state.planSessionId,
        targetDate,
      })
      if (response.data?.movedToDate && response.data.movedToDate !== targetDate) {
        throw new Error('The missed session was not moved onto today.')
      }
      track('makeup_run_started', { session_id: state.planSessionId, missed_date: missed.date || null })
      setRunIntentOpen(false)
      navigate('/warmup', { state: withActiveRunReturnTarget(state, activeRunReturnTo) })
    } catch (err) {
      console.error('[LogRun] make-up reschedule failed:', err?.message || err)
      setRunIntentError(err?.response?.data?.error || 'Forged Hybrid could not move that workout onto today. Your plan was not changed.')
    } finally {
      setStartingMakeupId(null)
    }
  }

  const selectedMissedRun = selectedRunIntentId === 'extra'
    ? null
    : missedRunOptions.find((missed) => String(missed.sessionId || missed.raw?.id || '') === selectedRunIntentId)

  const continueRunIntent = () => {
    if (selectedRunIntentId === 'extra') {
      startExtraRun()
      return
    }
    if (selectedMissedRun) startMakeupRun(selectedMissedRun)
  }

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
      } catch (error) {
        console.error('[LogRun] notes update failed:', error?.message || error)
      }
    }
  }

  const deleteRun = async () => {
    if (!selectedRun) return
    if (!window.confirm("Are you sure? This can't be undone.")) return
    await api.delete(`/runs/${selectedRun.id}`)
    setRecentRuns(prev => prev.filter(r => r.id !== selectedRun.id))
    setSelectedRun(null)
  }

  if (checkingCheckIn) {
    return <div className="p-4" style={{ color: 'var(--text-muted)' }}>Checking today's check-in...</div>
  }

  if (!checkInCompleted) {
    return (
      <div className="rounded-2xl p-6" style={{ background: 'var(--bg-card)' }}>
        <h2 className="text-xl font-black mb-2" style={{ color: 'var(--text-primary)' }}>Morning Check-In Required</h2>
        <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>Complete your morning check-in before starting a run.</p>
        <button onClick={() => navigate('/checkin')} className="w-full rounded-xl py-3 font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}>Go to Check-In</button>
      </div>
    )
  }

  if (warmUpState === 'warmup') {
    const returnParams = new URLSearchParams(location.search)
    returnParams.delete('warmup')
    const returnSearch = returnParams.toString()
    const returnTo = `/log-run${returnSearch ? `?${returnSearch}` : ''}`
    const incomingState = location.state && typeof location.state === 'object' ? location.state : {}
    return <Navigate to="/warmup" replace state={{ ...incomingState, warmupReturnTo: returnTo, checkinCompleted: true, checkinDate: todayISO() }} />
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
            {todayLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading workout...</p> : todayWorkout ? (
              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <span className="inline-block rounded-full px-3 py-1 text-xs font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>{todayWorkout.typeLabel}</span>
                  {todayWorkout.source === 'calendar' && (
                    <span className="inline-block rounded-full px-2 py-1 text-[10px] font-bold" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>From your plan</span>
                  )}
                  <span className="rounded-full px-2 py-1 text-[10px] font-black uppercase" style={{ background: 'rgba(34,197,94,0.12)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.35)', whiteSpace: 'nowrap' }}>
                    {todayCoachingIsAi ? 'AI coach' : 'Data coach'}
                  </span>
                </div>
                <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{todayWorkout.distanceLabel}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Target pace</p>
                    <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{todayWorkout.pace || '--'}</p>
                  </div>
                  <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Zone</p>
                    <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{todayWorkout.zone || '--'}</p>
                  </div>
                  <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Focus</p>
                    <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{todayWorkout.intensity || '--'}</p>
                  </div>
                  <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Est. time</p>
                    <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{todayWorkout.durationLabel || '--'}</p>
                  </div>
                </div>
                {todayWorkout.progression && <p className="mt-3 text-sm" style={{ color: 'var(--text-primary)' }}>{todayWorkout.progression}</p>}
                {todayWorkout.description && <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>{todayWorkout.description}</p>}
                {todayCoachingIsAi && <AiGuidanceNote />}
                {runBrief && (
                  <div className="rounded-xl p-3 mt-3" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs font-black uppercase mb-1" style={{ color: 'var(--accent)', letterSpacing: 0.8 }}>{runBriefIsAi ? 'AI check' : 'Coach baseline'}</p>
                    <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{runBrief.why}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Effort: {runBrief.effort} · BPM: {runBrief.bpmRange} · Cadence: {runBrief.cadence}</p>
                  </div>
                )}
                {todayWorkout.steps?.length > 0 && (
                  <div className="rounded-xl p-3 mt-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs font-black uppercase mb-2" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Workout structure</p>
                    {todayWorkout.steps.map((step, index) => (
                      <p key={`${step}-${index}`} className="text-xs mb-1" style={{ color: 'var(--text-primary)' }}>{index + 1}. {step}</p>
                    ))}
                  </div>
                )}
                <button onClick={() => setShowWatchModal(true)} className="w-full mt-4 rounded-xl py-3 font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}>Send to Watch</button>
                <button type="button" onClick={startScheduledRun} className="w-full rounded-xl py-3 font-bold mt-3" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer', fontSize: 15 }}>
                  {todayWorkout.source === 'calendar' ? 'Start Scheduled Run' : 'Start Run'}
                </button>
                {routePlannerStatus.available && (
                  <Suspense fallback={<p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>Loading route planner...</p>}>
                    <RoutePlanner workout={todayWorkout} onStart={startPlannedRoute} />
                  </Suspense>
                )}
                {routePlannerStatus.requiresPro && (
                  <Link to="/upgrade" className="mt-4 flex items-center justify-between py-3 px-1 text-sm font-black" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
                    <span className="flex items-center gap-2"><Mountain size={18} style={{ color: 'var(--accent)' }} /> Elevation routes</span>
                    <span className="text-xs" style={{ color: 'var(--accent)' }}>Pro</span>
                  </Link>
                )}
              </div>
            ) : (
              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                <p className="font-bold" style={{ color: 'var(--text-primary)' }}>No run is scheduled today.</p>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Run extra or make up a missed plan session. Forged Hybrid will ask before changing the calendar.</p>
                <button type="button" onClick={openRunIntent} className="mt-4 w-full rounded-xl px-4 py-3 font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}>Start a Run</button>
                <button type="button" onClick={() => setActiveTab('log')} className="mt-2 w-full rounded-xl px-4 py-3 font-semibold" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>Log a Completed Run</button>
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
                              <button onClick={e => { e.stopPropagation(); navigate('/run/active', { state: withActiveRunReturnTarget({ countdown, runType: day.type || 'easy', runEnvironment: 'outdoor', surface: trackWorkout === 'yes' ? 'track' : 'road', mapMyRun: true, trackMode: trackWorkout === 'yes' }, activeRunReturnTo) }) }}
                                style={{ width: '100%', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, borderRadius: 10, padding: '12px', border: 'none', cursor: 'pointer', fontSize: 14 }}>
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
              <p className="text-base font-black" style={{ color: 'var(--text-primary)' }}>Run now</p>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Choose whether this is extra work or a missed plan session you are making up.</p>
              <button type="button" onClick={openRunIntent} className="mt-4 w-full rounded-xl py-3 font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}>
                Choose Run
              </button>
            </div>
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Already finished? Log it below</p>
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-center py-6">
                <input aria-label={`Run distance in ${fmt.distanceLabel}`} type="number" step="0.01" min="0" required className="text-5xl font-bold bg-transparent text-center w-32 focus:outline-none" style={{ color: 'var(--accent)' }} value={distance} onChange={e => setDistance(e.target.value)} placeholder="0.0" />
                <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Distance ({fmt.distanceLabel})</div>
                {fieldErrors.distance && <p ref={distanceErrorRef} className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{fieldErrors.distance}</p>}
                {estimatedTime && <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Estimated time: {estimatedTime.low}–{estimatedTime.high} min based on your recent {Math.floor(estimatedTime.avg)}:{String(Math.round((estimatedTime.avg%1)*60)).padStart(2,'0')}/mi average pace</p>}
              </div>
            </div>

            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex gap-2 justify-center">
                <input type="text" required value={duration} onChange={e => setDuration(e.target.value)} onBlur={() => { const sec = parseDuration(duration); if (sec) setDuration(formatDurationDisplay(sec)) }} placeholder="MM:SS or HH:MM:SS" className="w-full max-w-xs rounded-full border px-4 py-3 text-center text-xl font-bold" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-primary)' }} />
              </div>
              {fieldErrors.duration && <p ref={durationErrorRef} className="text-xs mt-2 text-center" style={{ color: 'var(--danger)' }}>{fieldErrors.duration}</p>}
              {fieldWarnings.pace && <p className="text-xs mt-2 text-center" style={{ color: 'var(--warning)' }}>{fieldWarnings.pace}</p>}
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

            {activeShoes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Running In</p>
                {activeShoes.find(s => s.id === selectedShoeId)?.alert && (
                  <p style={{ fontSize: 11, color: 'var(--warning)', marginBottom: 4 }}>
                    This shoe is at {activeShoes.find(s => s.id === selectedShoeId)?.pct_used}% — consider rotating to a fresh pair
                  </p>
                )}
                <select value={selectedShoeId} onChange={e => setSelectedShoeId(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 14 }}>
                  <option value="">No shoe selected</option>
                  {activeShoes.map(s => (
                    <option key={s.id} value={s.id}>{s.brand} {s.model}{s.nickname ? ` (${s.nickname})` : ''} — {s.total_miles} mi</option>
                  ))}
                </select>
                <button
                  onClick={() => window.location.href = '/gear'}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', padding: '4px 0', textDecoration: 'underline', marginTop: 8 }}
                >
                  Manage shoes / add new pair
                </button>
              </div>
            )}

            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-primary)' }} />

            <button type="submit" disabled={loading} className="w-full rounded-xl py-3 font-semibold disabled:opacity-70" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}>{loading ? 'Logging run...' : 'Save Run'}</button>
            {error && <p className="mt-2 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}
            {feedback && <div className="mt-2 rounded-xl p-3" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>{feedback}</div>}
          </form>
        )}

        <Link to="/" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>← Back</Link>
      </div>

      {showWatchModal && <WorkoutWatchModal workout={todayWorkout} onClose={() => setShowWatchModal(false)} />}

      {runIntentOpen && createPortal(
        <div className="run-intent-overlay" data-testid="run-intent-overlay">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Dismiss run choices"
            className="run-intent-backdrop"
            onClick={() => setRunIntentOpen(false)}
          />
          <section
            ref={runIntentDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-intent-title"
            tabIndex={-1}
            data-swipe-back-ignore
            className="run-intent-sheet"
          >
            <div className="run-intent-header">
              <div>
                <p className="text-xs font-black uppercase" style={{ color: 'var(--accent)', letterSpacing: 0.8 }}>Run today</p>
                <h2 id="run-intent-title" className="mt-1 text-xl font-black" style={{ color: 'var(--text-primary)' }}>Why are you running?</h2>
              </div>
              <button type="button" onClick={() => setRunIntentOpen(false)} aria-label="Close run choices" className="run-intent-close rounded-full px-3 py-2 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>Close</button>
            </div>

            <div className="run-intent-scrollport" data-testid="run-intent-scrollport" data-swipe-back-ignore>
              <div className="run-intent-content">
                <button
                  type="button"
                  aria-pressed={selectedRunIntentId === 'extra'}
                  onClick={() => setSelectedRunIntentId('extra')}
                  className="run-intent-option w-full rounded-xl p-4 text-left"
                  style={{
                    background: selectedRunIntentId === 'extra' ? 'var(--accent)' : 'var(--bg-input)',
                    color: selectedRunIntentId === 'extra' ? 'var(--on-accent)' : 'var(--text-primary)',
                    border: selectedRunIntentId === 'extra' ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
                  }}
                >
                  <span className="block text-base font-black">Extra run</span>
                  <span className="mt-1 block text-sm font-semibold">Push today without completing or moving a scheduled workout. The activity still informs future load decisions.</span>
                </button>

                <div className="mt-5">
                  <p className="text-xs font-black uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Make up a missed run</p>
                  <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Select a recent missed session. Forged Hybrid moves it onto today before you start.</p>
                  {runIntentLoading && <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>Checking your calendar...</p>}
                  {!runIntentLoading && !todayIsPlanRestDay && (
                    <p className="mt-3 rounded-xl p-3 text-sm" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>Today is not an available plan rest day, so Forged Hybrid will not stack a missed workout here.</p>
                  )}
                  {!runIntentLoading && todayIsPlanRestDay && missedRunOptions.length === 0 && (
                    <p className="mt-3 rounded-xl p-3 text-sm" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>No missed run is available in this training week.</p>
                  )}
                  {!runIntentLoading && todayIsPlanRestDay && missedRunOptions.map((missed) => {
                    const raw = missed.raw || {}
                    const title = raw.title || cleanRunType(raw.type || raw.workout_type || 'Run')
                    const distanceMiles = Number(raw.distance_miles ?? missed.distance ?? 0)
                    const detail = [
                      missed.date || null,
                      distanceMiles > 0 ? `${distanceMiles.toFixed(1)} mi` : null,
                      raw.pace_target || raw.target_zone || null,
                    ].filter(Boolean).join(' · ')
                    const id = String(missed.sessionId || raw.id || '')
                    const isSelected = selectedRunIntentId === id
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedRunIntentId(id)}
                        disabled={Boolean(startingMakeupId)}
                        className="run-intent-option mt-3 w-full rounded-xl p-4 text-left disabled:opacity-60"
                        style={{
                          background: isSelected ? 'var(--accent-dim)' : 'var(--bg-input)',
                          color: 'var(--text-primary)',
                          border: isSelected ? '2px solid var(--accent)' : '1px solid var(--border-subtle)',
                        }}
                      >
                        <span className="block text-sm font-black">{title}</span>
                        <span className="mt-1 block text-xs" style={{ color: 'var(--text-muted)' }}>{detail || 'Missed plan session'}</span>
                        {startingMakeupId === id && <span className="mt-2 block text-xs font-bold" style={{ color: 'var(--accent)' }}>Moving workout onto today...</span>}
                      </button>
                    )
                  })}
                </div>
                {runIntentError && <p role="alert" className="mt-4 rounded-xl p-3 text-sm" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{runIntentError}</p>}
                <button
                  type="button"
                  onClick={continueRunIntent}
                  disabled={Boolean(startingMakeupId) || (selectedRunIntentId !== 'extra' && !selectedMissedRun)}
                  className="run-intent-primary mt-5 w-full rounded-xl py-3 font-black disabled:opacity-60"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}
                >
                  {startingMakeupId
                    ? 'Moving workout...'
                    : selectedRunIntentId === 'extra' ? 'Start extra run' : 'Move workout & start'}
                </button>
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )}

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

            {panelPrefs.notes && <div className="rounded-xl p-4 mb-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}><h4 className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Notes</h4><textarea rows={5} value={editingNotes} onChange={e => setEditingNotes(e.target.value)} className="w-full rounded-xl border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-primary)' }} /><button onClick={saveNotes} className="mt-2 rounded-lg px-3 py-2 text-sm font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}>Save Notes</button></div>}

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
              <button onClick={() => setShowCustomize(false)} className="w-full mt-3 rounded-xl py-2" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}>Done</button>
            </div>
          )}
        </div>
      )}

      {showPostCheckIn && savedRunId && <PostRunCheckIn runId={savedRunId} heatDrift={savedHeatDrift} onDone={(result) => {
        setShowPostCheckIn(false)
        if (!result?.queued) {
          navigate(`/run/recap/${savedRunId}`, { replace: true })
          return
        }
        const checkInNotice = 'Post-run check-in queued and will sync with your run.'
        setFeedback((current) => [checkInNotice, current].filter(Boolean).join(' '))
        setShowRecoveryPrompt(true)
      }} />}

      {showRecoveryPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <h3 className="text-xl font-black" style={{ color: 'var(--text-primary)' }}>Great run! Time to recover.</h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Post-run recovery uses static holds. Hold each stretch for the full duration to target the muscles you just used.</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => { setShowRecoveryPrompt(false); navigate('/stretches/session?type=post') }} className="flex-1 rounded-xl px-4 py-2 font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}>Start Recovery</button>
              <button onClick={() => setShowRecoveryPrompt(false)} className="flex-1 rounded-xl px-4 py-2" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>Skip</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
