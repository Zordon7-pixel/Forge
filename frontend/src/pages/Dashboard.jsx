import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Flame, ArrowUpRight, ArrowDownRight, Watch, Footprints, X, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import AchievementUnlock from '../components/AchievementUnlock'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import { useOnlineStatus } from '../lib/useOnlineStatus'

function fmtPace(durationSeconds, distance) {
  if (!durationSeconds || !distance) return '--'
  const pace = durationSeconds / 60 / distance
  const mins = Math.floor(pace)
  const secs = Math.round((pace - mins) * 60)
  return `${mins}:${String(secs).padStart(2,'0')} /mi`
}

function fmtDuration(s) {
  if (!s) return '0 min'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`
  return `${m} min`
}

function fmtHours(s) {
  if (!s) return '0m'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function useCountUp(target, duration = 900) {
  const [count, setCount] = React.useState(0)
  React.useEffect(() => {
    if (!target) { setCount(0); return }
    let start = 0; const step = target / (duration / 16)
    const timer = setInterval(() => {
      start += step
      if (start >= target) { setCount(target); clearInterval(timer) }
      else setCount(Math.floor(start))
    }, 16)
    return () => clearInterval(timer)
  }, [target, duration])
  return count
}

// Mini SVG line chart
function TrendChart({ data = [] }) {
  if (!data.length) return null
  const maxMiles = Math.max(...data.map(d => d.miles), 1)
  const w = 100, h = 40
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (d.miles / maxMiles) * h
    return `${x},${y}`
  }).join(' ')
  const areaPoints = `0,${h} ` + points + ` ${w},${h}`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16" preserveAspectRatio="none">
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.4"/>
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#trendGrad)" />
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => {
        const x = (i / (data.length - 1)) * w
        const y = h - (d.miles / maxMiles) * h
        return d.miles > 0 ? <circle key={i} cx={x} cy={y} r="1.5" fill="var(--accent)" /> : null
      })}
    </svg>
  )
}

// Readiness score circular gauge
function ReadinessGauge({ score, onClick }) {
  const r = 28, cx = 36, cy = 36
  const circumference = 2 * Math.PI * r
  const dash = (score / 100) * circumference
  const color = score >= 75 ? '#22c55e' : score >= 50 ? 'var(--accent)' : '#ef4444'
  const label = score >= 80 ? 'Optimal' : score >= 60 ? 'Good' : score >= 40 ? 'Moderate' : 'Low'

  return (
    <div onClick={onClick} style={{ cursor: 'pointer' }} className="flex flex-col">
      <div className="flex items-center gap-4">
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-subtle)" strokeWidth="5" />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="5"
            strokeDasharray={`${dash} ${circumference}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${cx} ${cy})`} />
          <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle"
            fontSize="13" fontWeight="bold" fill={color}>{score}</text>
        </svg>
        <div>
          <p className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{label}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Training readiness</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            {score >= 75 ? 'Go hard today.' : score >= 50 ? 'Moderate effort.' : 'Take it easy today.'}
          </p>
        </div>
      </div>
      <p className="text-xs mt-2" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>Tap to see breakdown</p>
    </div>
  )
}

function getWeekKey() {
  const now = new Date()
  const weekStart = new Date(Date.UTC(now.getFullYear(), 0, 1))
  const dayOffset = Math.floor((now - weekStart) / 86400000)
  const weekNumber = Math.ceil((dayOffset + weekStart.getUTCDay() + 1) / 7)
  return `${now.getFullYear()}-${String(weekNumber).padStart(2, '0')}`
}

// Watch Sync Widget
function WatchSyncWidget({ onSyncPayload }) {
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [justSynced, setJustSynced] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('forge_token')
    if (!token) return
    const applyStatus = (data) => {
      setSyncStatus((prev) => {
        if (data && prev && data.synced_at !== prev?.synced_at) {
          setJustSynced(true)
          setTimeout(() => setJustSynced(false), 3000)
        }
        return data
      })
      onSyncPayload?.(data)
    }
    fetch('/api/watch-sync/status', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(applyStatus)
      .catch(() => {})
    
    // Poll every 10 seconds while page is open
    const interval = setInterval(() => {
      fetch('/api/watch-sync/status', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : null)
        .then(applyStatus)
        .catch(() => {})
    }, 10000)
    return () => clearInterval(interval)
  }, [onSyncPayload])

  const watchBrand = syncStatus?.treadmill_brand || syncStatus?.watch_mode || null
  const hasData = syncStatus && (syncStatus.avg_heart_rate || syncStatus.distance_miles)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <style>{`
        @keyframes watchPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(234,179,8,0.4); } 50% { box-shadow: 0 0 0 8px rgba(234,179,8,0); } }
        @keyframes syncFlash { 0% { background: rgba(34,197,94,0.3); } 100% { background: transparent; } }
      `}</style>
      <button
        onClick={() => {
          setSyncing(true)
          setTimeout(() => setSyncing(false), 1500)
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: hasData ? 'rgba(234,179,8,0.1)' : 'var(--bg-input)',
          border: `1px solid ${hasData ? 'rgba(234,179,8,0.4)' : 'var(--border-subtle)'}`,
          borderRadius: 10, padding: '6px 12px', cursor: 'pointer',
          animation: syncing ? 'watchPulse 1s ease-in-out infinite' : 'none',
          transition: 'all 0.3s ease',
          ...(justSynced ? { animation: 'syncFlash 1s ease forwards' } : {}),
        }}
      >
        <Watch size={14} color={hasData ? '#EAB308' : 'var(--text-muted)'} />
        <div style={{ textAlign: 'left' }}>
          <p style={{ fontSize: 9, color: 'var(--text-muted)', margin: 0, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {watchBrand || 'Watch'}
          </p>
          <p style={{ fontSize: 11, fontWeight: 700, color: hasData ? '#EAB308' : 'var(--text-muted)', margin: 0 }}>
            {justSynced ? 'Synced!' : hasData ? `HR ${syncStatus.avg_heart_rate || '--'} bpm` : 'No data'}
          </p>
        </div>
        {hasData && (
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', animation: 'watchPulse 2s ease infinite' }} />
        )}
      </button>
      <p style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', marginTop: 2 }}>
        + Meta Glasses (soon)
      </p>
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { fmt } = useUnits()
  const { t } = useTranslation()
  const [stats, setStats] = useState(null)
  const [runs, setRuns] = useState([])
  const [lifts, setLifts] = useState([])
  const [warning, setWarning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState('week')
  const [checkedInToday, setCheckedInToday] = useState(false)
  const [hasWatchData, setHasWatchData] = useState(false)
  const [goalMode, setGoalMode] = useState('auto') // 'auto' | 'manual'
  const [manualGoalMiles, setManualGoalMiles] = useState(null)
  const [editingGoal, setEditingGoal] = useState(false)
  const [goalInput, setGoalInput] = useState('')
  const [showReadinessModal, setShowReadinessModal] = useState(false)
  const [selectedCalendarDay, setSelectedCalendarDay] = useState(null)
  const [watchSyncNotice, setWatchSyncNotice] = useState(null)
  const [otherActivities, setOtherActivities] = useState([])
  const [streakStats, setStreakStats] = useState({ currentStreak: 0, bestStreak: 0 })
  const [milestones, setMilestones] = useState([])
  const [milestoneUnlock, setMilestoneUnlock] = useState(null)
  const [compliance, setCompliance] = useState(null)
  const [showComplianceDetails, setShowComplianceDetails] = useState(false)
  const [loadAnalysis, setLoadAnalysis] = useState(null)
  const [nextRace, setNextRace] = useState(null)
  const [loadWarningDismissedUntil, setLoadWarningDismissedUntil] = useState(Number(localStorage.getItem('forge_load_warning_dismissed_until') || 0))
  const [shoeAlerts, setShoeAlerts] = useState([])
  const [weeklyCalories, setWeeklyCalories] = useState(0)
  const [checkinData, setCheckinData] = useState(null)
  const [dailySteps, setDailySteps] = useState(null)
  const [dailyStepsSource, setDailyStepsSource] = useState('manual')
  const [activeInjury, setActiveInjury] = useState(null)
  const [injuryBannerDismissed, setInjuryBannerDismissed] = useState(false)
  const [weeklyRecap, setWeeklyRecap] = useState(null)
  const [showWeeklyRecap, setShowWeeklyRecap] = useState(false)
  const [showSyncedFlash, setShowSyncedFlash] = useState(false)
  const { isOnline, queueCount } = useOnlineStatus()

  useEffect(() => {
    ;(async () => {
      try {
        const [statsRes, runsRes, liftsRes, warningRes, checkinRes, goalRes, streakRes, milestoneRes, complianceRes, loadRes, nextRaceRes, gearRes, injuryRes] = await Promise.all([
          api.get('/auth/me/stats'),
          api.get('/runs', { params: { limit: 5 } }),
          api.get('/lifts'),
          api.get('/coach/warning'),
          api.get('/checkin/today').catch(() => ({ data: null })),
          api.get('/users/goal').catch(() => ({ data: null })),
          api.get('/auth/me/streak').catch(() => ({ data: { currentStreak: 0, bestStreak: 0 } })),
          api.get('/milestones/new').catch(() => ({ data: { milestones: [] } })),
          api.get('/plans/compliance').catch(() => ({ data: null })),
          api.get('/runs/load-analysis').catch(() => ({ data: null })),
          api.get('/races/next').catch(() => ({ data: { race: null } })),
          api.get('/gear/shoes').catch(() => ({ data: { shoes: [] } })),
          api.get('/injury/active').catch(() => ({ data: { injuries: [] } })),
        ])
        setStats(statsRes.data)
        const runsList = Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || []
        setRuns(runsList)
        setHasWatchData(runsList.some((r) => r.avg_heart_rate || r.watch_mode || r.route_coords))
        setLifts(Array.isArray(liftsRes.data) ? liftsRes.data : liftsRes.data?.lifts || [])
        setWarning(warningRes.data?.warning === true)
        const checkinSteps = checkinRes.data?.step_count ?? checkinRes.data?.steps
        if (Number.isFinite(Number(checkinSteps))) {
          setDailySteps(Number(checkinSteps))
          setDailyStepsSource('manual')
        } else {
          const statsSteps = statsRes.data?.day?.steps ?? statsRes.data?.today?.steps
          if (Number.isFinite(Number(statsSteps))) {
            setDailySteps(Number(statsSteps))
            setDailyStepsSource('manual')
          }
        }
        if (checkinRes.data) {
          setCheckedInToday(true)
          setCheckinData(checkinRes.data)
        }
        if (goalRes.data) {
          setGoalMode(goalRes.data.mode || 'auto')
          setManualGoalMiles(goalRes.data.miles || null)
        }
        setStreakStats(streakRes.data || { currentStreak: 0, bestStreak: 0 })
        const fetchedMilestones = milestoneRes.data?.milestones || []
        setMilestones(fetchedMilestones)
        if (fetchedMilestones.length > 0) {
          setMilestoneUnlock(prev => prev || {
            name: fetchedMilestones[0].title,
            description: fetchedMilestones[0].description,
            icon: 'Award',
            color: '#EAB308',
          })
        }
        setCompliance(complianceRes.data)
        setLoadAnalysis(loadRes.data)
        setNextRace(nextRaceRes.data?.race || null)
        setShoeAlerts((gearRes.data?.shoes || []).filter((s) => Number(s.total_miles || 0) > 450))
        setActiveInjury((injuryRes.data?.injuries || [])[0] || null)
        // Fetch weekly calories from recap
        api.get('/recap/weekly').then((r) => {
          setWeeklyCalories(r.data?.totalCalories || 0)
          const isSunday = new Date().getDay() === 0
          const weekKey = `recap-seen-${getWeekKey()}`
          if (isSunday && localStorage.getItem(weekKey) !== '1') {
            setWeeklyRecap(r.data || null)
            setShowWeeklyRecap(true)
          }
        }).catch(() => {})
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    const lastSeen = localStorage.getItem('forge_last_watch_sync_seen_at') || '1970-01-01T00:00:00'
    api.get('/watch-sync/recent', { params: { since: lastSeen } })
      .then((res) => {
        const items = res.data?.items || []
        if (!items.length) return
        setOtherActivities(items.filter(i => i.routed_section === 'other'))
        setWatchSyncNotice(items[0])
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    setInjuryBannerDismissed(false)
  }, [activeInjury?.id])

  useEffect(() => {
    let timeoutId
    const triggerFlash = (flushedCount) => {
      if (!flushedCount || flushedCount < 1) return
      setShowSyncedFlash(true)
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => setShowSyncedFlash(false), 2500)
    }

    const onFlushed = (event) => {
      triggerFlash(Number(event?.detail?.flushedCount || 0))
    }

    const onServiceWorkerMessage = (event) => {
      if (event?.data?.type === 'OFFLINE_QUEUE_FLUSHED') {
        triggerFlash(Number(event?.data?.flushedCount || 0))
      }
    }

    window.addEventListener('offline-queue-flushed', onFlushed)
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage)
    }

    return () => {
      clearTimeout(timeoutId)
      window.removeEventListener('offline-queue-flushed', onFlushed)
      if (navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener('message', onServiceWorkerMessage)
      }
    }
  }, [])


  // Compute readiness from stats
  const { readiness, readinessBreakdown } = useMemo(() => {
    if (!stats || !checkedInToday || !hasWatchData) return { readiness: null, readinessBreakdown: [] }
    const { streak, week, all } = stats
    let score = 50
    const breakdown = []

    breakdown.push({ label: 'Base score', value: 50, delta: 0, reason: 'Starting point for all athletes.' })

    // Streak bonus
    const streakBonus = Math.min(streak * 4, 20)
    score += streakBonus
    breakdown.push({
      label: 'Consistency streak',
      value: streakBonus,
      delta: streakBonus,
      reason: streak > 0
        ? `${streak}-day active streak adds +${streakBonus} pts. Staying consistent pays off.`
        : 'No active streak. Logging runs builds your streak bonus.'
    })

    // Volume
    const avgWeekly = all.miles / Math.max(stats.weeklyTrend?.filter(w => w.miles > 0).length, 1)
    const weekRatio = avgWeekly > 0 ? week.miles / avgWeekly : 0
    let volDelta = 0
    let volReason = ''
    if (weekRatio < 0.5) {
      volDelta = 15
      volReason = `This week you ran ${fmt.distance(week.miles, 1)} vs your avg ${fmt.distance(avgWeekly, 1)} — low volume means your legs are fresh.`
    } else if (weekRatio > 1.3) {
      volDelta = -15
      volReason = `This week you ran ${fmt.distance(week.miles, 1)} vs your avg ${fmt.distance(avgWeekly, 1)} — high volume week, body needs recovery.`
    } else {
      volReason = `This week (${fmt.distance(week.miles, 1)}) is on par with your average (${fmt.distance(avgWeekly, 1)}) — balanced load.`
    }
    score += volDelta
    breakdown.push({ label: 'Weekly load', value: volDelta, delta: volDelta, reason: volReason })

    const sleepHours = Number(checkinData?.sleep_hours || 0)
    if (sleepHours > 0) {
      const sleepDelta = sleepHours < 6 ? -12 : sleepHours >= 8 ? 5 : 0
      score += sleepDelta
      breakdown.push({
        label: 'Sleep',
        value: sleepDelta,
        delta: sleepDelta,
        reason: sleepHours < 6
          ? `${sleepHours}h sleep lowers readiness today.`
          : sleepHours >= 8
            ? `${sleepHours}h sleep boosts recovery readiness.`
            : `${sleepHours}h sleep is neutral for readiness.`,
      })
    }

    return {
      readiness: Math.max(1, Math.min(99, Math.round(score))),
      readinessBreakdown: breakdown
    }
  }, [stats, checkedInToday, hasWatchData, checkinData, fmt])

  // Monthly challenge
  const monthlyGoal = useMemo(() => {
    if (!stats) return null
    const monthMiles = stats.month?.miles || 0
    let goal
    if (goalMode === 'manual' && manualGoalMiles) {
      goal = manualGoalMiles
    } else {
      // Auto: round up to next 25-mile milestone
      goal = Math.max(25, Math.ceil(monthMiles / 25) * 25 + (monthMiles >= 25 ? 25 : 0))
    }
    const pct = Math.min((monthMiles / goal) * 100, 100)
    return { miles: monthMiles, goal, pct }
  }, [stats, goalMode, manualGoalMiles])

  const periodStats = stats?.[period] || {}
  const milesCount = useCountUp(Math.round((periodStats.miles || 0) * 10), 900)
  const runsCount = useCountUp(periodStats.count || 0, 900)
  const streakCount = useCountUp(streakStats.currentStreak || 0, 900)

  // Combined recent activity
  const recentActivity = useMemo(() => {
    const runItems = runs.slice(0, 3).map(r => ({ ...r, _type: 'run' }))
    const liftItems = (lifts || []).slice(0, 3).map(l => ({ ...l, _type: 'lift' }))
    const otherItems = (otherActivities || []).slice(0, 3).map(o => ({ ...o, _type: 'other' }))
    const combined = [...runItems, ...liftItems, ...otherItems]
      .sort((a, b) => {
        const da = a.date || a.started_at || a.created_at || ''
        const db2 = b.date || b.started_at || b.created_at || ''
        return db2.localeCompare(da)
      })
    return combined.slice(0, 4)
  }, [runs, lifts, otherActivities])

  const showLoadWarning = loadAnalysis && ['elevated', 'high', 'danger'].includes(loadAnalysis.loadStatus) && Date.now() > loadWarningDismissedUntil
  const complianceColor = compliance?.score >= 80 ? '#22c55e' : compliance?.score >= 50 ? '#EAB308' : '#ef4444'
  const periodLabels = { day: 'Today', week: t('dashboard.thisWeek'), month: 'This Month', year: 'This Year', all: 'All Time' }
  const injuryDismissed = injuryBannerDismissed || (activeInjury && localStorage.getItem(`forge-injury-dismissed-${activeInjury.id}`) === '1')
  const handleWatchSyncPayload = useCallback((payload) => {
    if (!payload) return
    const syncedSteps = payload.step_count ?? payload.steps
    const numericSteps = Number(syncedSteps)
    if (Number.isFinite(numericSteps) && numericSteps >= 0) {
      setDailySteps(Math.round(numericSteps))
      setDailyStepsSource('watch')
    }
  }, [])

  if (loading) return <LoadingRunner message="Getting ready" />

  return (
    <div className="space-y-4">
      {showSyncedFlash && (
        <div className="rounded-xl p-2 text-sm font-semibold" style={{ background: 'rgba(34,197,94,0.18)', border: '1px solid rgba(34,197,94,0.45)', color: '#16a34a' }}>
          Synced!
        </div>
      )}
      {(!isOnline || queueCount > 0) && (
        <div className="rounded-xl p-2 text-sm font-semibold" style={{ background: 'rgba(234,179,8,0.14)', border: '1px solid rgba(234,179,8,0.35)', color: 'var(--text-primary)' }}>
          {isOnline ? `${queueCount} workouts queued for sync` : `📴 Offline — ${queueCount} workouts queued for sync`}
        </div>
      )}
      {milestoneUnlock && (
        <AchievementUnlock
          badge={milestoneUnlock}
          onDismiss={() => setMilestoneUnlock(null)}
        />
      )}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes ringClose {
          0% { opacity: 1; stroke-dasharray: 157 0; }
          80% { opacity: 1; stroke-dasharray: 157 0; }
          100% { opacity: 0; stroke-dasharray: 157 0; }
        }
      `}</style>

      {!injuryDismissed && activeInjury && (
        <div className="rounded-xl p-4" style={{ background: 'rgba(234,179,8,0.2)', border: '1px solid #EAB308' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold" style={{ color: '#0f1117' }}>
                Recovery Mode — {activeInjury.body_part || 'Injury'} — Est. return: {activeInjury.date || '--'}
              </p>
              <p className="text-xs mt-1" style={{ color: '#0f1117' }}>
                Your plan has been adjusted for recovery. Focus on PT and low-impact activity.
              </p>
            </div>
            <button
              onClick={() => {
                localStorage.setItem(`forge-injury-dismissed-${activeInjury.id}`, '1')
                setInjuryBannerDismissed(true)
              }}
              className="rounded-md p-1"
              style={{ background: 'transparent', color: '#0f1117' }}
              aria-label="Dismiss injury warning"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {showWeeklyRecap && weeklyRecap && (
        <div className="rounded-xl p-4" style={{ background: '#1a1d2e', border: '1px solid #2a2d3e' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold" style={{ color: '#EAB308' }}>Weekly Recap</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {weeklyRecap.totalMiles?.toFixed?.(1) || 0} mi · {weeklyRecap.totalRuns || 0} runs · {(weeklyRecap.totalCalories || 0).toLocaleString()} cal
              </p>
            </div>
            <button
              onClick={() => {
                localStorage.setItem(`recap-seen-${getWeekKey()}`, '1')
                setShowWeeklyRecap(false)
              }}
              style={{ background: 'transparent', color: 'var(--text-muted)' }}
              className="p-1"
              aria-label="Dismiss weekly recap"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {showLoadWarning && (
        <div className="rounded-xl p-3" style={{
          background: loadAnalysis.loadStatus === 'danger' ? 'rgba(239,68,68,0.12)' : loadAnalysis.loadStatus === 'high' ? 'rgba(249,115,22,0.12)' : 'rgba(234,179,8,0.12)',
          border: `1px solid ${loadAnalysis.loadStatus === 'danger' ? 'rgba(239,68,68,0.35)' : loadAnalysis.loadStatus === 'high' ? 'rgba(249,115,22,0.35)' : 'rgba(234,179,8,0.35)'}`
        }}>
          <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-primary)' }}>{loadAnalysis.loadStatus} load</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>{loadAnalysis.warning || loadAnalysis.recommendation}</p>
          <div className="mt-2 flex gap-2">
            <button className="rounded-lg px-3 py-1.5 text-xs font-bold" style={{ background: 'var(--accent)', color: '#000' }} onClick={() => navigate('/plan', { state: { suggestEasyDay: true } })}>Take Easy Day</button>
            <button className="rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }} onClick={() => {
              const until = Date.now() + 24 * 60 * 60 * 1000
              localStorage.setItem('forge_load_warning_dismissed_until', String(until))
              setLoadWarningDismissedUntil(until)
            }}>OK</button>
          </div>
        </div>
      )}

      {nextRace && (() => { const days = Math.ceil((new Date(`${nextRace.race_date}T12:00:00`).getTime() - Date.now()) / 86400000); return days > 0 && days <= 60 ? (
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Next Race</p>
          <p className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{nextRace.race_name}</p>
          <p className="text-sm" style={{ color: 'var(--accent)' }}>{days} days to go</p>
        </div>
      ) : null })()}

      {compliance && (
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }} onClick={() => setShowComplianceDetails(!showComplianceDetails)}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dashboard.thisWeek')}: {compliance.completed}/{compliance.planned} sessions — {compliance.score}%</p>
          <div className="w-full h-2 rounded-full mt-2" style={{ background: 'var(--bg-input)' }}>
            <div className="h-2 rounded-full" style={{ width: `${compliance.score}%`, background: complianceColor }} />
          </div>
          {showComplianceDetails && (
            <div className="mt-3 space-y-1">
              {(compliance.sessions || []).map((s, i) => (
                <p key={i} className="text-xs" style={{ color: s.completed ? '#22c55e' : '#ef4444' }}>{s.day}: {s.type} {s.completed ? 'hit' : 'missed'}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {milestones.length > 0 && (
        <div className="space-y-2">
          {milestones.map((m) => (
            <div key={m.key} className="rounded-xl p-3 flex items-center justify-between" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)' }}>
              <div>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{m.title}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{m.description}</p>
              </div>
              <button onClick={() => setMilestones(prev => prev.filter(x => x.key !== m.key))} className="text-xs" style={{ color: 'var(--text-muted)' }}>Dismiss</button>
            </div>
          ))}
        </div>
      )}

      {!checkedInToday && (
        <a href="/checkin"
          style={{ display: 'block', background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 14, padding: '12px 16px', marginBottom: 12, textDecoration: 'none' }}>
          <p style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 14, margin: 0 }}>Quick check-in — 3 taps</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '2px 0 0' }}>Help me adjust today's plan around your day</p>
        </a>
      )}

      {watchSyncNotice && (
        <div className="rounded-xl p-3" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            New activity synced from your watch — {watchSyncNotice.activity_name}. View it in {watchSyncNotice.routed_section === 'lift' ? 'Lift' : watchSyncNotice.routed_section === 'other' ? 'History' : 'Run'} tab.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                localStorage.setItem('forge_last_watch_sync_seen_at', watchSyncNotice.synced_at)
                if (watchSyncNotice.routed_section === 'lift') navigate('/log-lift')
                else if (watchSyncNotice.normalized_type === 'treadmill') navigate('/run/treadmill', { state: { incline: watchSyncNotice.incline_pct, speed: watchSyncNotice.belt_speed_mph, durationSeconds: watchSyncNotice.duration_seconds, treadmillType: watchSyncNotice.treadmill_brand || 'Generic', watchMetrics: watchSyncNotice } })
                else navigate('/log-run')
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: 'var(--accent)', color: '#000' }}
            >
              View
            </button>
            <button
              onClick={() => {
                localStorage.setItem('forge_last_watch_sync_seen_at', watchSyncNotice.synced_at)
                setWatchSyncNotice(null)
              }}
              className="rounded-lg px-3 py-1.5 text-xs"
              style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Ready to Run CTA */}
      <div className="rounded-2xl p-6 flex flex-col items-center" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <h2 className="text-2xl font-black mb-1" style={{ color: 'var(--text-primary)' }}>Ready to Run?</h2>
        <p className="text-sm mb-10 text-center" style={{ color: 'var(--text-muted)' }}>Dynamic warm-up reduces injury risk and improves performance.</p>
        <button
          onClick={() => navigate('/warmup')}
          className="rounded-full w-28 h-28 mb-3 font-black flex flex-col items-center justify-center"
          style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}
        >
          <Flame className="mb-1" />
          <span className="text-xs font-black">Start Warm-Up</span>
        </button>
        <button onClick={() => navigate('/log-run')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: '8px 0' }}>Skip warm-up</button>
      </div>

      {/* Training Readiness */}
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        {readiness === null ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Complete your daily check-in and sync your watch to unlock your Training Readiness score</p>
        ) : (
          <>
            <ReadinessGauge score={readiness} onClick={() => setShowReadinessModal(true)} />
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              Based on your HRV, sleep, soreness, and energy levels{checkinData?.sleep_hours ? ` · Sleep: ${checkinData.sleep_hours}h` : ''}
            </p>
          </>
        )}
        {dailySteps !== null && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <p className="text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <Footprints size={14} />
              <span>
                <strong style={{ color: 'var(--text-primary)' }}>{Number(dailySteps).toLocaleString()} steps</strong>
                {dailyStepsSource === 'watch' && <span style={{ marginLeft: 6, fontSize: 11, color: '#22c55e' }}>⌚ synced</span>}
              </span>
            </p>
          </div>
        )}
      </div>

      <WatchSyncWidget onSyncPayload={handleWatchSyncPayload} />

      {/* 7-day calendar */}
      {stats?.calendarDays && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
          <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>{t('dashboard.thisWeek')}</p>
          <div className="grid grid-cols-7 gap-1">
            {stats.calendarDays.map((day) => (
              <div key={day.date} className="flex flex-col items-center gap-1"
                onClick={() => setSelectedCalendarDay(day)}
                style={{ cursor: 'pointer' }}
              >
                <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>{day.day}</span>
                <div className="w-8 h-8 rounded-full flex items-center justify-center border"
                  style={{
                    background: day.hasRun || day.hasLift ? 'var(--accent)' : 'var(--bg-input)',
                    borderColor: day.isToday ? 'var(--accent)' : 'transparent',
                    borderWidth: day.isToday ? 2 : 1
                  }}>
                  {day.hasRun && day.hasLift ? (
                    <span className="text-xs font-bold text-black">R+L</span>
                  ) : day.hasRun ? (
                    <span className="text-xs font-bold text-black">R</span>
                  ) : day.hasLift ? (
                    <span className="text-xs font-bold text-black">L</span>
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.4 }}>·</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats with period selector */}
      <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)' }}>
        {/* Period tabs — pill-style: All | D | W | M */}
        <div className="flex gap-2">
          {[
            { key: 'day',   label: 'D'   },
            { key: 'week',  label: 'W'   },
            { key: 'month', label: 'M'   },
            { key: 'all', label: 'All' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setPeriod(key)}
              className="px-4 py-1.5 rounded-full text-xs font-semibold transition-all"
              style={period === key
                ? { background: 'var(--accent)', color: '#000' }
                : { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
              {label}
            </button>
          ))}
        </div>

        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{periodLabels[period]}</p>

        {/* Hero number */}
        <div>
          <p className="text-5xl font-black tabular-nums" style={{ color: 'var(--text-primary)' }}>
            {fmt.distanceValue((milesCount / 10)).toFixed(1)}
          </p>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{fmt.distanceLabel.charAt(0).toUpperCase() + fmt.distanceLabel.slice(1)}s</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            {label:'Runs', value:runsCount},
            {label:'Time', value:fmtHours(periodStats.seconds)},
            {label:'Cal', value: period === 'week' ? weeklyCalories.toLocaleString() : (periodStats.calories || 0).toLocaleString()},
          ].map((s, i) => {
            const improving = i % 2 === 0
            return <div key={s.label} className="rounded-lg p-2" style={{ border: '1px solid var(--border-subtle)' }}><p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{s.value}</p><p className="text-xs flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>{s.label}{improving ? <ArrowUpRight size={12} color="#22c55e"/> : <ArrowDownRight size={12} color="#ef4444"/>}</p></div>
          })}
        </div>
      </div>

      {/* 12-week trend chart */}
      {stats?.weeklyTrend && stats.weeklyTrend.some(w => w.miles > 0) && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Past 12 Weeks</p>
            <p className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
              {fmt.distance(stats.weeklyTrend[stats.weeklyTrend.length - 1]?.miles, 1)} last week
            </p>
          </div>
          <TrendChart data={stats.weeklyTrend} />
          <div className="flex justify-between mt-1">
            <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
              {new Date(stats.weeklyTrend[0]?.week).toLocaleDateString('en-US', { month: 'short' })}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>Now</span>
          </div>
        </div>
      )}

      {/* AI Warning */}
      {warning && (
        <div className="rounded-xl border p-3 text-sm" style={{ borderColor: 'rgba(234,179,8,0.3)', background: 'rgba(234,179,8,0.08)', color: 'var(--accent)' }}>
          Heavy legs detected — consider a rest day or easy run today
        </div>
      )}

      {/* Shoe Alerts */}
      {shoeAlerts.map(shoe => (
        <div key={shoe.id} style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 12, padding: '10px 14px' }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={14} /> Your {shoe.nickname || `${shoe.brand} ${shoe.model}`} has {Number(shoe.total_miles || 0).toFixed(0)} miles — time to replace soon
          </p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>{shoe.total_miles} of 500 miles</p>
        </div>
      ))}

      {/* Recent Activity */}
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <h3 className="text-base font-bold mb-3" style={{ color: 'var(--text-primary)', borderBottom: '1px solid rgba(234,179,8,0.45)', paddingBottom: 6 }}>Recent Activity</h3>
        <div className="space-y-3">
          {recentActivity.map(item => {
            if (item._type === 'run') {
              return (
                <div key={item.id} onClick={() => navigate(`/history?runId=${item.id}`)} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', borderLeft: '4px solid #EAB308', cursor: 'pointer' }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>Run</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {new Date(item.date || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  <div className="flex gap-4 mt-1">
                    <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt.distance(Number(item.distance_miles || 0), 2)}</p></div>
                    <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt.pace(item.duration_seconds / item.distance_miles)}</p></div>
                    <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmtDuration(item.duration_seconds)}</p></div>
                    {item.calories > 0 && <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{item.calories} cal</p></div>}
                  </div>
                </div>
              )
            }

            if (item._type === 'other') {
              return (
                <div key={item.id} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)' }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(234,179,8,0.2)', color: 'var(--accent)' }}>Other Activity</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(item.synced_at || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  </div>
                  <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{item.activity_name || item.activity_type || 'Synced activity'}</p>
                </div>
              )
            }

            return (
              <div key={item.id} onClick={() => navigate(`/history?workoutId=${item.id}`)} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', borderLeft: '4px solid #ffffff', cursor: 'pointer' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa' }}>Lift</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(item.date || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                  {item.exercise_name || (Array.isArray(item.muscle_groups) ? item.muscle_groups.join(', ') : 'Workout')}
                </p>
                {item.sets && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{item.sets} sets · {item.reps} reps · {item.weight_lbs} lbs</p>}
              </div>
            )
          })}
          {recentActivity.length === 0 && (
            <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>{t('dashboard.noActivity')}</p>
          )}
        </div>
      </section>

      {/* Calendar Day Detail Sheet */}
      {selectedCalendarDay && (
        <div onClick={() => setSelectedCalendarDay(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxHeight: '60vh', overflowY: 'auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {new Date(selectedCalendarDay.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </p>
                <p style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)' }}>
                  {selectedCalendarDay.hasRun || selectedCalendarDay.hasLift ? 'Active Day' : 'Rest Day'}
                </p>
              </div>
              <button onClick={() => setSelectedCalendarDay(null)}
                style={{ background: 'var(--bg-input)', border: 'none', borderRadius: 10, padding: '8px 14px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>
                Close
              </button>
            </div>

            {/* Run info */}
            {selectedCalendarDay.run && (
              <div style={{ background: 'var(--bg-base)', borderRadius: 14, padding: 16, marginBottom: 12 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>Run</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>
                      {Number(selectedCalendarDay.run.distance || 0).toFixed(2)}
                    </p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>miles</p>
                  </div>
                  {selectedCalendarDay.run.duration > 0 && (
                    <div>
                      <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>
                        {fmtDuration(selectedCalendarDay.run.duration)}
                      </p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>duration</p>
                    </div>
                  )}
                  {selectedCalendarDay.run.distance > 0 && selectedCalendarDay.run.duration > 0 && (
                    <div>
                      <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)' }}>
                        {(() => { const ppm = selectedCalendarDay.run.duration / selectedCalendarDay.run.distance; return `${Math.floor(ppm/60)}:${String(Math.round(ppm%60)).padStart(2,'0')}`})()}
                      </p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>avg pace /mi</p>
                    </div>
                  )}
                  {selectedCalendarDay.run.surface && (
                    <div>
                      <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>{selectedCalendarDay.run.surface}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>surface</p>
                    </div>
                  )}
                </div>
                {selectedCalendarDay.run.notes && (
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
                    {selectedCalendarDay.run.notes}
                  </p>
                )}
              </div>
            )}

            {/* Lift info */}
            {selectedCalendarDay.lifts && (
              <div style={{ background: 'var(--bg-base)', borderRadius: 14, padding: 16, marginBottom: 12 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>Strength</p>
                <p style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)' }}>{selectedCalendarDay.lifts} workout session{selectedCalendarDay.lifts > 1 ? 's' : ''}</p>
              </div>
            )}

            {/* Rest day */}
            {!selectedCalendarDay.hasRun && !selectedCalendarDay.hasLift && (
              <div style={{ background: 'var(--bg-base)', borderRadius: 14, padding: 20, textAlign: 'center' }}>
                <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Rest day</p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  {selectedCalendarDay.isToday ? "No activity logged yet today." : "Recovery is part of training. Rest days make you stronger."}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Readiness Breakdown Modal */}
      {showReadinessModal && (
        <div
          onClick={() => setShowReadinessModal(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxHeight: '70vh', overflowY: 'auto' }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Training Readiness</p>
                <p style={{ fontSize: 28, fontWeight: 900, color: 'var(--accent)' }}>{readiness} <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)' }}>/ 100</span></p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{readiness >= 80 ? 'Go hard today.' : readiness >= 60 ? 'Moderate effort — push but listen to your body.' : readiness >= 40 ? 'Take it easy — a recovery run or rest day is smart.' : 'Rest today. Your body is telling you something.'}</p>
              </div>
              <button onClick={() => setShowReadinessModal(false)} style={{ background: 'var(--bg-input)', border: 'none', borderRadius: 10, padding: '8px 14px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Close</button>
            </div>

            {/* Factor breakdown */}
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Score Breakdown</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {readinessBreakdown.map((f, i) => (
                <div key={i} style={{ background: 'var(--bg-base)', borderRadius: 12, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{f.label}</p>
                    <p style={{ fontSize: 13, fontWeight: 700, color: f.delta > 0 ? '#22c55e' : f.delta < 0 ? '#ef4444' : 'var(--text-muted)' }}>
                      {f.delta > 0 ? `+${f.delta}` : f.delta < 0 ? `${f.delta}` : `${f.value}`}
                    </p>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{f.reason}</p>
                </div>
              ))}
            </div>

            {/* What improves it */}
            <div style={{ marginTop: 20, padding: 14, background: 'var(--bg-base)', borderRadius: 12, borderLeft: '3px solid var(--accent)' }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>How to improve your score</p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Log runs consistently to build your streak. Keep weekly mileage within 10–20% of your average. Connect your Garmin for HRV and sleep data — that unlocks a much more accurate score.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
