import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useLocation, useNavigate } from 'react-router-dom'
import { CalendarClock, Dumbbell, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import InsightsSheet, { CalendarDayDetailSheet, DailyCoachFlow, ReadinessBreakdownModal, RecentActivityCard, TodayDetailSheet, WatchSyncWidget } from '../components/InsightsSheet'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import track from '../lib/track'
import LoadingRunner from '../components/LoadingRunner'
import Skeleton from '../components/Skeleton'
import { useOnlineStatus } from '../lib/useOnlineStatus'
import HealthService from '../services/HealthService'
import { useProContext } from '../context/ProContext'
import { fetchDailyExecution, recommendationFromExecution, hasExecutableSession, runRouteState, localDateISO } from '../lib/dailyExecution'
import { formatGroupRunDate, upcomingGroupRun } from '../lib/groupRuns'
import { resolveReadiness } from '../lib/truthConsistency'
import { HEALTH_SYNC_RESULT_EVENT } from '../lib/healthSync'
import { isRunningActivity } from '../lib/activityType'
import TravelTrainingPrompt from '../components/TravelTrainingPrompt'

function fmtPace(durationSeconds, distance) {
  if (!durationSeconds || !distance) return '--'
  const paceSeconds = Math.round(durationSeconds / distance)
  return `${Math.floor(paceSeconds / 60)}:${String(paceSeconds % 60).padStart(2, '0')} /mi`
}

function fmtDuration(s) {
  if (!s) return '0 min'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h > 0 ? (m > 0 ? `${h}h ${m}min` : `${h}h`) : `${m} min`
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
    const timer = setInterval(() => { start += step; if (start >= target) { setCount(target); clearInterval(timer) } else setCount(Math.floor(start)) }, 16)
    return () => clearInterval(timer)
  }, [target, duration])
  return count
}

function getRecommendationLabel(recommendation) {
  return recommendation
    ? String(recommendation.recommendationType || "today's session").replace('_', ' ')
    : "today's session"
}

function getWeekKey() {
  const now = new Date()
  const weekStart = new Date(Date.UTC(now.getFullYear(), 0, 1))
  const dayOffset = Math.floor((now - weekStart) / 86400000)
  const weekNumber = Math.ceil((dayOffset + weekStart.getUTCDay() + 1) / 7)
  return `${now.getFullYear()}-${String(weekNumber).padStart(2, '0')}`
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch (error) {
    console.warn('[Dashboard] local timezone unavailable:', error?.message)
    return 'UTC'
  }
}

function runOccurredOnDate(run, dateISO) {
  const raw = run?.date || run?.started_at || run?.start_time || run?.created_at
  if (!raw) return false
  const text = String(raw)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text === dateISO
  const parsed = new Date(text)
  return !Number.isNaN(parsed.getTime()) && localDateISO(parsed) === dateISO
}

const TODAY_CARD_VIEWED_KEY = 'forge_track_today_card_viewed'

function trainingGapEvidence(proposal) {
  return (proposal?.evidence || []).find((item) => ['run_gap', 'training_gap'].includes(item?.signal)) || null
}

function TrainingGapPrompt({ proposal, deciding, error, onDecision }) {
  const gap = trainingGapEvidence(proposal)
  const changes = Array.isArray(proposal?.changes) ? proposal.changes : []
  if (!gap || proposal?.status !== 'proposal' || changes.length === 0) return null

  const days = Number(gap.daysSinceRun ?? gap.daysInactive ?? 0)
  const firstChange = changes[0]
  return (
    <section
      aria-labelledby="training-gap-title"
      className="rounded-xl p-4"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--accent)' }}
    >
      <div className="flex items-start gap-3">
        <CalendarClock size={20} color="var(--accent)" style={{ flex: '0 0 auto', marginTop: 2 }} />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Adaptive plan check</p>
          <h2 id="training-gap-title" className="mt-1 text-lg font-black" style={{ color: 'var(--text-primary)' }}>Everything okay?</h2>
          <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            We have not seen a logged run in {days} days. Lifting still counts; this check is only about returning to running safely. Ease the next seven days, or keep the original calendar.
          </p>
          {firstChange?.summary && (
            <p className="mt-3 border-t pt-3 text-xs leading-5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              Proposed: {firstChange.summary}{changes.length > 1 ? ` +${changes.length - 1} more` : ''}
            </p>
          )}
        </div>
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg p-2 text-sm" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{error}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          className="min-h-11 rounded-lg px-3 text-sm font-black disabled:opacity-60"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          disabled={Boolean(deciding)}
          onClick={() => onDecision('accept')}
        >
          {deciding === 'accept' ? 'Adjusting...' : 'Ease my return'}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-lg px-3 text-sm font-bold disabled:opacity-60"
          style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          disabled={Boolean(deciding)}
          onClick={() => onDecision('keep')}
        >
          {deciding === 'keep' ? 'Saving...' : 'Keep original'}
        </button>
      </div>
    </section>
  )
}

function HybridSessionPrompt({ reconciliation, deciding, error, onDecision }) {
  if (!reconciliation) return null
  const choices = [
    ['completed_untracked', 'Completed it — forgot to track'],
    ['later', 'Doing it later'],
    ['life_event', 'Life got in the way'],
    ['skipped', 'Skipped this one'],
  ]
  return (
    <section
      aria-labelledby="hybrid-reconciliation-title"
      className="rounded-xl p-4"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--accent)' }}
    >
      <div className="flex items-start gap-3">
        <Dumbbell size={20} color="var(--accent)" style={{ flex: '0 0 auto', marginTop: 2 }} />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Hybrid session check</p>
          <h2 id="hybrid-reconciliation-title" className="mt-1 text-lg font-black" style={{ color: 'var(--text-primary)' }}>How did strength go?</h2>
          <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
            We found your run from {reconciliation.sessionDate}, but not the paired strength session: {reconciliation.liftTitle}.
          </p>
          <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
            Pick what happened. This is schedule context, not a failure score.
          </p>
          {reconciliation.pattern?.reviewRecommended && (
            <p className="mt-3 rounded-lg p-2 text-xs leading-5" style={{ background: 'var(--accent-dim)', color: 'var(--text-primary)' }}>
              This has happened {reconciliation.pattern.count} times recently. After this choice, consider fewer double days or a different strength frequency.
            </p>
          )}
        </div>
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg p-2 text-sm" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{error}</p>}
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {choices.map(([value, label], index) => (
          <button
            key={value}
            type="button"
            className="min-h-11 rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-60"
            style={index === 0
              ? { background: 'var(--accent)', color: 'var(--on-accent)' }
              : { background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            disabled={Boolean(deciding)}
            onClick={() => onDecision(value)}
          >
            {deciding === value ? 'Saving...' : label}
          </button>
        ))}
      </div>
    </section>
  )
}

const CELEBRATION_CONFETTI = Array.from({ length: 14 }, (_, index) => index)

function HybridMilestoneCelebration({ milestone, onDismiss }) {
  useEffect(() => {
    if (!milestone) return undefined
    const timer = setTimeout(onDismiss, 5200)
    return () => clearTimeout(timer)
  }, [milestone, onDismiss])

  if (!milestone) return null

  return (
    <div
      role="status"
      className="fixed left-4 right-4 top-4 z-50 overflow-hidden rounded-xl p-4 shadow-xl"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--accent)', color: 'var(--text-primary)' }}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {CELEBRATION_CONFETTI.map((item) => (
          <span
            key={item}
            className="absolute block h-2 w-1 rounded-sm"
            style={{
              left: `${8 + item * 6.5}%`,
              top: -8,
              background: item % 3 === 0 ? 'var(--accent)' : item % 3 === 1 ? 'var(--success)' : 'var(--warning)',
              animation: `hybridConfettiFall ${1200 + (item % 5) * 160}ms ease-out ${item * 45}ms both`,
            }}
          />
        ))}
      </div>
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Milestone</p>
          <p className="mt-1 text-base font-black" style={{ marginBottom: 0 }}>{milestone.title}</p>
          <p className="mt-1 text-sm leading-5" style={{ color: 'var(--text-muted)', marginBottom: 0 }}>{milestone.description}</p>
        </div>
        <button
          type="button"
          aria-label="Dismiss milestone celebration"
          onClick={onDismiss}
          className="shrink-0 rounded-md p-1"
          style={{ background: 'transparent', color: 'var(--text-muted)' }}
        >
          <X size={16} />
        </button>
      </div>
      <style>{`
        @keyframes hybridConfettiFall {
          0% { opacity: 0; transform: translate3d(0, -12px, 0) rotate(0deg); }
          15% { opacity: 1; }
          100% { opacity: 0; transform: translate3d(18px, 74px, 0) rotate(230deg); }
        }
      `}</style>
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const location = useLocation()
  const { fmt } = useUnits()
  const { t } = useTranslation()
  const [stats, setStats] = useState(null), [runs, setRuns] = useState([]), [lifts, setLifts] = useState([])
  const [warning, setWarning] = useState(false), [loading, setLoading] = useState(true), [period, setPeriod] = useState('week')
  const [checkedInToday, setCheckedInToday] = useState(false), [hasWatchData, setHasWatchData] = useState(false)
  const [goalMode, setGoalMode] = useState('auto'), [manualGoalMiles, setManualGoalMiles] = useState(null), [editingGoal, setEditingGoal] = useState(false), [goalInput, setGoalInput] = useState('')
  const [showReadinessModal, setShowReadinessModal] = useState(false), [selectedCalendarDay, setSelectedCalendarDay] = useState(null), [watchSyncNotice, setWatchSyncNotice] = useState(null)
  const [otherActivities, setOtherActivities] = useState([])
  const [milestones, setMilestones] = useState([]), [celebrationQueue, setCelebrationQueue] = useState([]), [compliance, setCompliance] = useState(null), [showComplianceDetails, setShowComplianceDetails] = useState(false)
  const [loadAnalysis, setLoadAnalysis] = useState(null), [nextRace, setNextRace] = useState(null), [loadWarningDismissedUntil, setLoadWarningDismissedUntil] = useState(Number(localStorage.getItem('forge_load_warning_dismissed_until') || 0))
  const [shoeAlerts, setShoeAlerts] = useState([]), [weeklyCalories, setWeeklyCalories] = useState(0)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('readiness') === '1') {
      setShowReadinessModal(true)
      navigate('/', { replace: true })
    }
  }, [location.search, navigate])
  const [checkinData, setCheckinData] = useState(null)
  const [dailySteps, setDailySteps] = useState(null)
  const [dailyStepsSource, setDailyStepsSource] = useState('manual')
  const [activeInjury, setActiveInjury] = useState(null)
  const [injurySafetyAvailable, setInjurySafetyAvailable] = useState(false)
  const [injuryBannerDismissed, setInjuryBannerDismissed] = useState(false)
  const [weeklyRecap, setWeeklyRecap] = useState(null)
  const [showWeeklyRecap, setShowWeeklyRecap] = useState(false)
  const [showSyncedFlash, setShowSyncedFlash] = useState(false)
  const [showTodayDetail, setShowTodayDetail] = useState(false)
  const [showMoreInsights, setShowMoreInsights] = useState(false)
  const [nextRecommendation, setNextRecommendation] = useState(null)
  const [execution, setExecution] = useState(null)
  const [ageGradedPerformance, setAgeGradedPerformance] = useState(null)
  const [healthSync, setHealthSync] = useState({ loading: true, available: false, reason: null, metrics: null })
  const [readinessState, setReadinessState] = useState({ loading: true, error: false, locked: false, data: null })
  const [healthSyncNotice, setHealthSyncNotice] = useState('')
  const [upcomingSocialRun, setUpcomingSocialRun] = useState(null)
  const [trainingGapProposal, setTrainingGapProposal] = useState(null)
  const [trainingGapDecision, setTrainingGapDecision] = useState(null)
  const [trainingGapError, setTrainingGapError] = useState('')
  const [trainingGapNotice, setTrainingGapNotice] = useState('')
  const [hybridReconciliation, setHybridReconciliation] = useState(null)
  const [hybridReconciliationDecision, setHybridReconciliationDecision] = useState(null)
  const [hybridReconciliationError, setHybridReconciliationError] = useState('')
  const [hybridReconciliationNotice, setHybridReconciliationNotice] = useState('')
  const { isOnline, queueCount } = useOnlineStatus()
  const { isPro, loading: proLoading } = useProContext()

  const fetchReadinessData = useCallback(async () => {
    setReadinessState((prev) => ({ ...prev, loading: true, error: false, locked: false }))
    try {
      const res = await api.get('/recovery/readiness')
      setReadinessState({ loading: false, error: false, locked: false, data: res.data || null })
    } catch (error) {
      if (error?.response?.status === 402) {
        setReadinessState({ loading: false, error: false, locked: true, data: null })
      } else {
        console.warn('[Dashboard] readiness fetch failed:', error?.message)
        setReadinessState({ loading: false, error: true, locked: false, data: null })
      }
    }
  }, [])

  const fetchDashboardData = useCallback(async () => {
    try {
        const [statsRes, runsRes, liftsRes, warningRes, checkinRes, goalRes, complianceRes, loadRes, nextRaceRes, gearRes, injuryRes, recapRes, recommendationRes, ageGradedRes, executionRes, groupRunsRes, adaptationRes, reconciliationRes, hybridStreakRes] = await Promise.all([
          api.get('/auth/me/stats'),
          api.get('/runs', { params: { limit: 5 } }),
          api.get('/lifts'),
          api.get('/coach/warning'),
          api.get('/checkin/today', { params: { date: localDateISO() } }).catch(() => ({ data: null })),
          api.get('/users/goal').catch(() => ({ data: null })),
          api.get('/plans/compliance').catch(() => ({ data: null })),
          api.get('/runs/load-analysis').catch(() => ({ data: null })),
          api.get('/races/next').catch(() => ({ data: { race: null } })),
          api.get('/gear/shoes').catch(() => ({ data: { shoes: [] } })),
          api.get('/injury/active').catch((error) => {
            console.error('[Dashboard] injury safety lookup failed:', error?.message || error)
            return { data: { injuries: [], safetyUnavailable: true } }
          }),
          api.get('/recap/weekly').catch(() => ({ data: null })),
          api.get('/runs/next-recommendation').catch(() => ({ data: null })),
          api.get('/runs/age-graded-performance').catch(() => ({ data: null })),
          fetchDailyExecution(localDateISO()).catch((err) => {
            console.error('[Dashboard] daily execution fetch failed:', err?.message || err)
            return null
          }),
          api.get('/group-runs').catch((error) => {
            console.error('[Dashboard] group run reminder fetch failed:', error?.message || error)
            return { data: { group_runs: [] } }
          }),
          api.get('/plans/adaptation/current', { params: { date: localDateISO() } }).catch((error) => {
            console.error('[Dashboard] training gap check failed:', error?.message || error)
            return { data: { proposal: null } }
          }),
          api.get('/plans/reconciliation/current', { params: { date: localDateISO(), hour: new Date().getHours(), timezone: localTimezone() } }).catch((error) => {
            console.error('[Dashboard] hybrid session reconciliation check failed:', error?.message || error)
            return { data: { reconciliation: null } }
          }),
          api.get('/stats/hybrid-streak').catch(() => ({ data: { currentStreak: 0, longestStreak: 0, unit: 'day', graceUsed: false, milestones: [] } })),
        ])
        setExecution(executionRes || null)
        setUpcomingSocialRun(upcomingGroupRun(groupRunsRes.data?.group_runs || []))
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
        const hybridStreakData = hybridStreakRes.data || { currentStreak: 0, longestStreak: 0, unit: 'day', graceUsed: false, milestones: [] }
        const fetchedMilestones = Array.isArray(hybridStreakData.milestones) ? hybridStreakData.milestones : []
        setMilestones(fetchedMilestones)
        if (fetchedMilestones.length > 0) {
          setCelebrationQueue(prev => {
            const existing = new Set(prev.map((item) => item.key))
            return prev.concat(fetchedMilestones.filter((item) => !existing.has(item.key)))
          })
        }
        setCompliance(complianceRes.data)
        setLoadAnalysis(loadRes.data)
        setNextRace(nextRaceRes.data?.race || null)
        const gearShoes = gearRes.data?.shoes || []
        setShoeAlerts(gearShoes.filter((shoe) => Boolean(shoe.alert)))
        setActiveInjury((injuryRes.data?.injuries || [])[0] || null)
        setInjurySafetyAvailable(injuryRes.data?.safetyUnavailable !== true)
        setWeeklyCalories(recapRes.data?.totalCalories || 0)
        setNextRecommendation(recommendationRes.data || null)
        setAgeGradedPerformance(ageGradedRes.data || null)
        const nextProposal = adaptationRes.data?.proposal || null
        const pendingGap = trainingGapEvidence(nextProposal)
          && nextProposal?.status === 'proposal'
          && (nextProposal?.changes || []).length > 0
          && !['accepted', 'kept'].includes(nextProposal?.decisionStatus)
        const nextReconciliation = reconciliationRes.data?.reconciliation || null
        setHybridReconciliation(nextReconciliation)
        setTrainingGapProposal(!nextReconciliation && pendingGap ? nextProposal : null)
        const isSunday = new Date().getDay() === 0
        const weekKey = `recap-seen-${getWeekKey()}`
        if (isSunday && localStorage.getItem(weekKey) !== '1') {
          setWeeklyRecap(recapRes.data || null)
          setShowWeeklyRecap(Boolean(recapRes.data))
        }
    } finally {
        setLoading(false)
      }
  }, [])

  useEffect(() => {
    fetchDashboardData()
    fetchReadinessData()
    let cancelled = false
    const listenerHandles = []
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchDashboardData()
        fetchReadinessData()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    const handleHealthSyncCompleted = (event) => {
      const metrics = event?.detail?.metrics
      const healthSteps = Number(metrics?.stepsToday || 0)
      if (Number.isFinite(healthSteps) && healthSteps > 0) {
        setDailySteps(healthSteps)
        setDailyStepsSource('watch')
      }
      if (metrics) setHealthSync({ loading: false, available: true, reason: null, metrics })
      fetchDashboardData()
      fetchReadinessData()
    }
    window.addEventListener(HEALTH_SYNC_RESULT_EVENT, handleHealthSyncCompleted)

    try {
      const appStateHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          fetchDashboardData()
          fetchReadinessData()
        }
      })
      const resumeHandle = CapacitorApp.addListener('resume', () => {
        fetchDashboardData()
        fetchReadinessData()
      })

      Promise.all([appStateHandle, resumeHandle])
        .then((handles) => {
          if (cancelled) {
            handles.forEach((handle) => handle?.remove?.())
            return
          }
          listenerHandles.push(...handles)
        })
        .catch((error) => {
          console.warn('[Dashboard] app listener setup failed:', error?.message)
        })
    } catch (error) {
      console.warn('[Dashboard] app listener setup failed:', error?.message)
    }

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener(HEALTH_SYNC_RESULT_EVENT, handleHealthSyncCompleted)
      listenerHandles.forEach((handle) => handle?.remove?.())
    }
  }, [fetchDashboardData, fetchReadinessData])

  useEffect(() => {
    if (loading) return
    try {
      if (sessionStorage.getItem(TODAY_CARD_VIEWED_KEY) === '1') return
      sessionStorage.setItem(TODAY_CARD_VIEWED_KEY, '1')
    } catch (err) {
      console.debug('[Dashboard] today_card_viewed session guard unavailable:', err?.message)
    }
    track('today_card_viewed')
  }, [loading])

  useEffect(() => {
    let active = true
    let retryTimer = null

    const syncHealthSummary = async (attempt = 0) => {
      try {
        const result = await HealthService.getHealthSummary()
        if (!active) return

        if (result?.available && result?.metrics) {
          const healthSteps = Number(result.metrics.stepsToday || 0)
          if (Number.isFinite(healthSteps) && healthSteps > 0) {
            setDailySteps(healthSteps)
            setDailyStepsSource('watch')
          }
          try {
            await HealthService.syncToProfile(result.metrics)
            if (active) setHealthSyncNotice('')
          } catch (error) {
            console.warn('[HealthSync] profile sync failed:', error?.message)
            if (!active) return

            if (attempt === 0) {
              setHealthSyncNotice('Apple Health connected, but profile sync is retrying in the background.')
              retryTimer = setTimeout(() => {
                retryTimer = null
                syncHealthSummary(1)
              }, 10000)
            } else {
              setHealthSyncNotice('Apple Health connected, but the latest metrics were not saved to your profile yet.')
            }
          }
        } else {
          setHealthSyncNotice('')
        }

        setHealthSync({ loading: false, ...result })
      } catch (error) {
        console.warn('[HealthSync] summary failed:', error?.message)
        if (!active) return
        setHealthSyncNotice('')
        setHealthSync({
          loading: false,
          available: false,
          reason: 'Unable to read Apple Health data on this device.',
          metrics: null,
        })
      }
    }

    syncHealthSummary()

    return () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
    }
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


  const readinessBreakdown = useMemo(() => {
    if (!resolveReadiness(readinessState.data).available || !Array.isArray(readinessState.data?.drivers)) return []
    return readinessState.data.drivers
      .filter((reason) => typeof reason === 'string' && reason.trim())
      .map((reason, index) => ({ label: `Recovery signal ${index + 1}`, reason }))
  }, [readinessState.data])

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

  // H5: prefer today's calendar session over the legacy next-recommendation.
  // Active-plan rest days stay explicit; only a missing calendar day falls
  // back to the legacy recommendation.
  const calendarRec = useMemo(() => recommendationFromExecution(execution), [execution])
  const calendarOwnsToday = Boolean(execution?.hasPlan && execution?.hasDay)
  const effectiveRecommendation = calendarRec || (calendarOwnsToday ? null : nextRecommendation)
  const hasRunRecordedToday = useMemo(() => {
    const todayISO = localDateISO()
    return runs.some((run) => isRunningActivity(run) && runOccurredOnDate(run, todayISO))
  }, [runs])
  const travelReadiness = useMemo(() => ({
    ...resolveReadiness(readinessState.data),
    band: readinessState.data?.band || null,
  }), [readinessState.data])

  const showLoadWarning = loadAnalysis && ['elevated', 'high', 'danger'].includes(loadAnalysis.loadStatus) && Date.now() > loadWarningDismissedUntil
  const complianceColor = compliance?.score >= 80 ? 'var(--success)' : compliance?.score >= 50 ? 'var(--accent)' : 'var(--danger)'
  const periodLabels = { day: 'Today', week: t('dashboard.thisWeek'), month: 'This Month', year: 'This Year', all: 'All Time' }
  const injuryDismissed = injuryBannerDismissed || (activeInjury && activeInjury.id && localStorage.getItem(`forge-injury-dismissed-${activeInjury.id}`) === '1')
  const handleWatchSyncPayload = useCallback((payload) => {
    if (!payload) return
    const syncedSteps = payload.step_count ?? payload.steps
    const numericSteps = Number(syncedSteps)
    if (Number.isFinite(numericSteps) && numericSteps >= 0) {
      setDailySteps(Math.round(numericSteps))
      setDailyStepsSource('watch')
    }
  }, [])

  const handleStartWorkout = useCallback(() => {
    // H5: when today has an executable calendar session, hand off the canonical
    // scheduled run/lift (with its plan session id) instead of the legacy rec.
    if (hasExecutableSession(execution)) {
      track('recommendation_followed', { via: 'today_card_start', source: 'calendar' })
      if (calendarRec && calendarRec.recommendationType === 'strength') {
        return navigate('/log-lift', { state: { planSessionId: calendarRec.planSessionId, currentWeek: execution.week ?? null, scheduledLift: execution.lift || null } })
      }
      return navigate('/log-run', { state: runRouteState(execution) })
    }
    if (calendarOwnsToday) return navigate('/plan')
    if (!nextRecommendation) return navigate('/run')
    track('recommendation_followed', { via: 'today_card_start' })
    if (nextRecommendation.recommendationType === 'rest') return navigate('/plan')
    if (nextRecommendation.recommendationType === 'strength') return navigate('/log-lift')
    const params = new URLSearchParams()
    if (Number(nextRecommendation.suggestedDistance || 0) > 0) params.set('distance', String(nextRecommendation.suggestedDistance))
    if (nextRecommendation.recommendationType) params.set('type', String(nextRecommendation.recommendationType))
    if (nextRecommendation.suggestedPace) params.set('pace', String(nextRecommendation.suggestedPace))
    navigate(`/log-run${params.toString() ? `?${params.toString()}` : ''}`)
  }, [navigate, nextRecommendation, execution, calendarRec, calendarOwnsToday])

  const handleStartTodayRun = useCallback(() => {
    if (!execution?.run) return
    track('recommendation_followed', { via: 'today_details_run', source: 'calendar' })
    navigate('/log-run', { state: runRouteState(execution) })
  }, [navigate, execution])

  const handleStartTodayLift = useCallback(() => {
    if (!execution?.lift) return
    track('recommendation_followed', { via: 'today_details_lift', source: 'calendar' })
    navigate('/log-lift', {
      state: {
        planSessionId: execution.lift.id || null,
        currentWeek: execution.week ?? null,
        scheduledLift: execution.lift,
      },
    })
  }, [navigate, execution])

  const handlePlanTodayRoute = useCallback(() => {
    if (!execution?.run) return
    track('route_planner_opened', { via: 'today_details', source: 'calendar' })
    navigate('/log-run', { state: { ...runRouteState(execution), openRoutePlanner: true } })
  }, [navigate, execution])

  const handleStartUnplannedRun = useCallback(() => {
    track('unplanned_run_selected', { via: 'today_rest_day' })
    setShowTodayDetail(false)
    navigate('/log-run?tab=manual&intent=rest-day')
  }, [navigate])

  const decideTrainingGap = useCallback(async (decision) => {
    if (!trainingGapProposal?.id || !['accept', 'keep'].includes(decision)) return
    setTrainingGapDecision(decision)
    setTrainingGapError('')
    try {
      await api.post(`/plans/adaptation/${trainingGapProposal.id}/${decision}`)
      setTrainingGapProposal(null)
      setTrainingGapNotice(decision === 'accept' ? 'Next seven days adjusted for a safer return.' : 'Calendar left as planned.')
      if (decision === 'accept') await fetchDashboardData()
    } catch (error) {
      setTrainingGapError(error?.response?.data?.error || 'Could not save that choice. Please try again.')
    } finally {
      setTrainingGapDecision(null)
    }
  }, [fetchDashboardData, trainingGapProposal])

  const decideHybridReconciliation = useCallback(async (decision) => {
    if (!hybridReconciliation || !['completed_untracked', 'later', 'life_event', 'skipped'].includes(decision)) return
    setHybridReconciliationDecision(decision)
    setHybridReconciliationError('')
    try {
      const response = await api.post('/plans/reconciliation/respond', {
        session_date: hybridReconciliation.sessionDate,
        lift_session_id: hybridReconciliation.liftSessionId,
        response: decision,
        current_date: localDateISO(),
        timezone: localTimezone(),
      })
      setHybridReconciliation(null)
      const planFitNote = response.data?.pattern?.reviewRecommended
        ? ' Forged Hybrid has noticed a recurring pattern; review whether fewer double days would fit your life better.'
        : ''
      setHybridReconciliationNotice(`${response.data?.message || 'Hybrid session updated.'}${planFitNote}`)
      await fetchDashboardData()
    } catch (error) {
      setHybridReconciliationError(error?.response?.data?.error || 'Could not save that choice. Please try again.')
    } finally {
      setHybridReconciliationDecision(null)
    }
  }, [fetchDashboardData, hybridReconciliation])

  const dismissCelebration = useCallback(() => {
    setCelebrationQueue(prev => prev.slice(1))
  }, [])

  if (loading) return <div className="space-y-4"><LoadingRunner message="Getting ready" /><Skeleton rows={3} /></div>

  return (
    <div className="space-y-4">
      {showSyncedFlash && (
        <div className="rounded-xl p-2 text-sm font-semibold" style={{ background: 'rgba(34,197,94,0.18)', border: '1px solid rgba(34,197,94,0.45)', color: '#16a34a' }}>
          Synced!
        </div>
      )}
      {trainingGapNotice && (
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-semibold" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
          <span>{trainingGapNotice}</span>
          <button type="button" aria-label="Dismiss plan update" onClick={() => setTrainingGapNotice('')} className="shrink-0 rounded-md p-1" style={{ background: 'transparent', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>
      )}
      {hybridReconciliationNotice && (
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-semibold" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
          <span>{hybridReconciliationNotice}</span>
          <button type="button" aria-label="Dismiss hybrid session update" onClick={() => setHybridReconciliationNotice('')} className="shrink-0 rounded-md p-1" style={{ background: 'transparent', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>
      )}
      {(!isOnline || queueCount > 0) && (
        <div className="rounded-xl p-2 text-sm font-semibold" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
          {isOnline ? `${queueCount} workouts queued for sync` : `📴 Offline — ${queueCount} workouts queued for sync`}
        </div>
      )}
      <HybridMilestoneCelebration milestone={celebrationQueue[0]} onDismiss={dismissCelebration} />
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

      {!injuryDismissed && activeInjury && activeInjury.id && (
        <div className="rounded-xl p-4" style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent)' }}>
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
              onClick={async () => {
                try {
                  await api.delete('/injury/active')
                } catch (error) {
                  console.error('[dashboard/injury] dismiss failed:', error?.message || error)
                }
                localStorage.setItem(`forge-injury-dismissed-${activeInjury.id}`, '1')
                setInjuryBannerDismissed(true)
                setActiveInjury(null)
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
              <p className="text-sm font-bold" style={{ color: 'var(--accent)' }}>Weekly Recap</p>
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

      <HybridSessionPrompt
        reconciliation={hybridReconciliation}
        deciding={hybridReconciliationDecision}
        error={hybridReconciliationError}
        onDecision={decideHybridReconciliation}
      />

      <TrainingGapPrompt
        proposal={trainingGapProposal}
        deciding={trainingGapDecision}
        error={trainingGapError}
        onDecision={decideTrainingGap}
      />

      <TravelTrainingPrompt
        execution={execution}
        checkinData={checkinData}
        adaptationProposal={trainingGapProposal}
        readiness={travelReadiness}
        activeInjury={injurySafetyAvailable ? activeInjury : { unknown: true }}
        runRecordedToday={hasRunRecordedToday}
        dateISO={localDateISO()}
      />

      <DailyCoachFlow /* H5: effectiveRecommendation prefers calendar */
        checkedInToday={checkedInToday}
        readinessData={readinessState.data}
        recommendation={effectiveRecommendation}
        execution={execution}
        hasRunRecordedToday={hasRunRecordedToday}
        onCheckIn={() => navigate('/checkin')}
        onStartWorkout={handleStartWorkout}
        onStartUnplannedRun={handleStartUnplannedRun}
        onDetails={() => setShowTodayDetail(true)}
      />

      {upcomingSocialRun && (
        <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <CalendarClock size={20} color="var(--accent)" style={{ flex: '0 0 auto', marginTop: 1 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ color: 'var(--accent)', fontSize: 10, fontWeight: 900, textTransform: 'uppercase', margin: 0 }}>{t('groupRuns.todayReminder')}</p>
              <h2 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: '4px 0 0', overflowWrap: 'anywhere' }}>{upcomingSocialRun.title}</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5, margin: '5px 0 0' }}>{formatGroupRunDate(upcomingSocialRun)} · {upcomingSocialRun.meetup_area}</p>
            </div>
          </div>
          <button type="button" className="pressable" onClick={() => navigate('/community?tab=runs')} style={{ width: '100%', minHeight: 44, marginTop: 12, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 850 }}>{t('groupRuns.openCommunity')}</button>
        </section>
      )}

      <TodayDetailSheet
        open={showTodayDetail}
        onClose={() => setShowTodayDetail(false)}
        checkedInToday={checkedInToday}
        readinessData={readinessState.data}
        readinessBreakdown={readinessBreakdown}
        recommendation={effectiveRecommendation}
        execution={execution}
        hasRunRecordedToday={hasRunRecordedToday}
        checkinData={checkinData}
        dailySteps={dailySteps}
        dailyStepsSource={dailyStepsSource}
        activeInjury={activeInjury}
        watchSyncNotice={watchSyncNotice}
        compliance={compliance}
        onCheckIn={() => navigate('/checkin')}
        onStartWorkout={handleStartWorkout}
        onStartRun={handleStartTodayRun}
        onStartLift={handleStartTodayLift}
        onPlanRoute={handlePlanTodayRoute}
        onStartUnplannedRun={handleStartUnplannedRun}
        onWarmup={() => navigate('/prep?mode=warmup')}
        onReflect={() => navigate('/history')}
        onOpenReadiness={() => {
          setShowTodayDetail(false)
          setShowReadinessModal(true)
        }}
      />

      {watchSyncNotice && (
        <div className="rounded-xl p-3" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)' }}>
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
              style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
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

      <RecentActivityCard recentActivity={recentActivity} navigate={navigate} fmt={fmt} fmtDuration={fmtDuration} t={t} />

      <button
        type="button"
        onClick={() => setShowMoreInsights(true)}
        className="w-full rounded-xl px-4 py-3 text-sm font-bold"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', textAlign: 'left' }}
      >
        More insights →
      </button>

      <InsightsSheet
        open={showMoreInsights}
        onClose={() => setShowMoreInsights(false)}
        watchSyncWidget={<WatchSyncWidget onSyncPayload={handleWatchSyncPayload} />}
        weeklyRecap={weeklyRecap}
        navigate={navigate}
        ageGradedPerformance={ageGradedPerformance}
        showLoadWarning={showLoadWarning}
        loadAnalysis={loadAnalysis}
        onDismissLoadWarning={() => {
          const until = Date.now() + 24 * 60 * 60 * 1000
          localStorage.setItem('forge_load_warning_dismissed_until', String(until))
          setLoadWarningDismissedUntil(until)
        }}
        nextRace={nextRace}
        compliance={compliance}
        showComplianceDetails={showComplianceDetails}
        setShowComplianceDetails={setShowComplianceDetails}
        complianceColor={complianceColor}
        milestones={milestones}
        setMilestones={setMilestones}
        healthSync={healthSync}
        proLoading={proLoading}
        isPro={isPro}
        healthSyncNotice={healthSyncNotice}
        stats={stats} onSelectCalendarDay={setSelectedCalendarDay}
        thisWeekLabel={t('dashboard.thisWeek')}
        period={period}
        setPeriod={setPeriod}
        periodLabels={periodLabels}
        milesCount={milesCount}
        runsCount={runsCount}
        periodStats={periodStats}
        weeklyCalories={weeklyCalories}
        fmt={fmt}
        fmtHours={fmtHours}
        warning={warning}
        shoeAlerts={shoeAlerts}
      />

      <CalendarDayDetailSheet
        selectedCalendarDay={selectedCalendarDay}
        onClose={() => setSelectedCalendarDay(null)}
        fmtDuration={fmtDuration}
      />

      <ReadinessBreakdownModal
        open={showReadinessModal}
        onClose={() => setShowReadinessModal(false)}
        readinessData={readinessState.data}
      />
    </div>
  )
}
