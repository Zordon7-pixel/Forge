import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useLocation, useNavigate } from 'react-router-dom'
import { CalendarClock, Footprints, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import AchievementUnlock from '../components/AchievementUnlock'
import InsightsSheet, { CalendarDayDetailSheet, DailyCoachFlow, ReadinessBreakdownModal, RecentActivityCard, TodayDetailSheet, WatchSyncWidget } from '../components/InsightsSheet'
import ReadinessCard from '../components/ReadinessCard'
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

function structureToWatchSteps(structure = []) {
  if (!Array.isArray(structure)) return []
  return structure.map((block) => {
    const parts = [
      block?.label || block?.phase,
      block?.hrZone ? `Z${block.hrZone}` : '',
      block?.durationMinutes ? `${block.durationMinutes} min` : '',
      block?.distanceMiles ? `${block.distanceMiles} mi` : '',
      block?.description || '',
    ].filter(Boolean)
    return parts.join(' - ')
  }).filter(Boolean)
}

function getWeekKey() {
  const now = new Date()
  const weekStart = new Date(Date.UTC(now.getFullYear(), 0, 1))
  const dayOffset = Math.floor((now - weekStart) / 86400000)
  const weekNumber = Math.ceil((dayOffset + weekStart.getUTCDay() + 1) / 7)
  return `${now.getFullYear()}-${String(weekNumber).padStart(2, '0')}`
}

const TODAY_CARD_VIEWED_KEY = 'forge_track_today_card_viewed'

function trainingGapEvidence(proposal) {
  return (proposal?.evidence || []).find((item) => item?.signal === 'training_gap') || null
}

function TrainingGapPrompt({ proposal, deciding, error, onDecision }) {
  const gap = trainingGapEvidence(proposal)
  const changes = Array.isArray(proposal?.changes) ? proposal.changes : []
  if (!gap || proposal?.status !== 'proposal' || changes.length === 0) return null

  const days = Number(gap.daysInactive || 0)
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
            We have not seen a logged run or lift in {days} days. Do you want to ease the next demanding session, or leave your calendar as it is?
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
          {deciding === 'accept' ? 'Adjusting...' : 'Adjust plan'}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-lg px-3 text-sm font-bold disabled:opacity-60"
          style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          disabled={Boolean(deciding)}
          onClick={() => onDecision('keep')}
        >
          {deciding === 'keep' ? 'Saving...' : 'Leave as is'}
        </button>
      </div>
    </section>
  )
}

function HybridScoreCard({ hybridScore }) {
  if (!hybridScore) return null
  const components = hybridScore.components || {}
  const bars = [
    { label: 'Run', value: components.run || 0, color: 'var(--accent)' },
    { label: 'Lift', value: components.lift || 0, color: 'var(--success)' },
    { label: 'Consistency', value: components.consistency || 0, color: 'var(--warning)' },
  ]
  const driver = Array.isArray(hybridScore.drivers) && hybridScore.drivers.length
    ? hybridScore.drivers.join(' ')
    : 'Run and lift balance sets the ceiling.'

  return (
    <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 16 }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Hybrid Score</p>
          <div className="mt-1 flex items-end gap-2">
            <span className="text-4xl font-black leading-none" style={{ color: 'var(--text-primary)' }}>{Math.round(Number(hybridScore.score || 0))}</span>
            <span className="pb-1 text-sm font-bold" style={{ color: 'var(--text-muted)' }}>/100</span>
          </div>
        </div>
        <p className="max-w-[58%] text-right text-xs leading-5" style={{ color: 'var(--text-muted)', margin: 0 }}>{driver}</p>
      </div>
      <div className="mt-4 space-y-2">
        {bars.map((bar) => {
          const value = Math.max(0, Math.min(100, Math.round(Number(bar.value || 0))))
          return (
            <div key={bar.label} className="grid items-center gap-2" style={{ gridTemplateColumns: '86px 1fr 34px' }}>
              <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>{bar.label}</span>
              <div aria-hidden="true" style={{ height: 8, borderRadius: 999, background: 'var(--bg-input)', overflow: 'hidden' }}>
                <div style={{ width: `${value}%`, height: '100%', borderRadius: 999, background: bar.color }} />
              </div>
              <span className="text-right text-xs font-black" style={{ color: 'var(--text-primary)' }}>{value}</span>
            </div>
          )
        })}
      </div>
    </section>
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
  const [otherActivities, setOtherActivities] = useState([]), [streakStats, setStreakStats] = useState({ currentStreak: 0, bestStreak: 0 })
  const [milestones, setMilestones] = useState([]), [milestoneUnlock, setMilestoneUnlock] = useState(null), [compliance, setCompliance] = useState(null), [showComplianceDetails, setShowComplianceDetails] = useState(false)
  const [loadAnalysis, setLoadAnalysis] = useState(null), [nextRace, setNextRace] = useState(null), [loadWarningDismissedUntil, setLoadWarningDismissedUntil] = useState(Number(localStorage.getItem('forge_load_warning_dismissed_until') || 0))
  const [shoeAlerts, setShoeAlerts] = useState([]), [weeklyCalories, setWeeklyCalories] = useState(0)
  const [hybridScore, setHybridScore] = useState(null)

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
        const [statsRes, runsRes, liftsRes, warningRes, checkinRes, goalRes, streakRes, milestoneRes, complianceRes, loadRes, nextRaceRes, gearRes, injuryRes, recapRes, recommendationRes, ageGradedRes, executionRes, groupRunsRes, adaptationRes, hybridScoreRes] = await Promise.all([
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
          api.get('/stats/hybrid-score').catch(() => ({ data: null })),
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
        setStreakStats(streakRes.data || { currentStreak: 0, bestStreak: 0 })
        const fetchedMilestones = milestoneRes.data?.milestones || []
        setMilestones(fetchedMilestones)
        if (fetchedMilestones.length > 0) {
          setMilestoneUnlock(prev => prev || {
            name: fetchedMilestones[0].title,
            description: fetchedMilestones[0].description,
            icon: 'Award',
            color: 'var(--accent)',
          })
        }
        setCompliance(complianceRes.data)
        setLoadAnalysis(loadRes.data)
        setNextRace(nextRaceRes.data?.race || null)
        const gearShoes = gearRes.data?.shoes || []
        setShoeAlerts(gearShoes.filter((shoe) => Boolean(shoe.alert)))
        setActiveInjury((injuryRes.data?.injuries || [])[0] || null)
        setWeeklyCalories(recapRes.data?.totalCalories || 0)
        setNextRecommendation(recommendationRes.data || null)
        setAgeGradedPerformance(ageGradedRes.data || null)
        setHybridScore(hybridScoreRes.data || null)
        const nextProposal = adaptationRes.data?.proposal || null
        const pendingGap = trainingGapEvidence(nextProposal)
          && nextProposal?.status === 'proposal'
          && (nextProposal?.changes || []).length > 0
          && !['accepted', 'kept'].includes(nextProposal?.decisionStatus)
        setTrainingGapProposal(pendingGap ? nextProposal : null)
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


  // Compute readiness from stats
  const { readiness, readinessBreakdown } = useMemo(() => {
    const healthMetrics = healthSync.metrics || null
    const hasHealthContext = Boolean(healthMetrics) || checkedInToday || hasWatchData
    if (!stats || !hasHealthContext) return { readiness: null, readinessBreakdown: [] }
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
    const activeWeeks = (stats.weeklyTrend || []).filter(w => Number(w.miles || 0) > 0)
    const avgWeekly = activeWeeks.length
      ? activeWeeks.reduce((sum, weekEntry) => sum + Number(weekEntry.miles || 0), 0) / activeWeeks.length
      : 0
    const weekRatio = avgWeekly > 0 ? week.miles / avgWeekly : 0
    let volDelta = 0
    let volReason = ''
    if (avgWeekly <= 0) {
      volReason = 'No recent weekly mileage baseline yet. Log a few weeks so Forged Hybrid can compare load safely.'
    } else if (weekRatio < 0.5) {
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

    const sleepHours = Number(healthMetrics?.sleepHoursLastNight || 0)
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

    const hrvMs = Number(healthMetrics?.heartRateVariabilityMs || 0)
    if (hrvMs > 0) {
      const hrvDelta = hrvMs < 35 ? -14 : hrvMs < 45 ? -8 : hrvMs >= 65 ? 5 : 0
      score += hrvDelta
      breakdown.push({
        label: 'Apple Health HRV',
        value: hrvDelta,
        delta: hrvDelta,
        reason: hrvMs < 35
          ? `${hrvMs} ms HRV points to recovery stress.`
          : hrvMs < 45
            ? `${hrvMs} ms HRV is slightly suppressed today.`
            : hrvMs >= 65
              ? `${hrvMs} ms HRV supports readiness.`
              : `${hrvMs} ms HRV is neutral for readiness.`,
      })
    }

    const restingHr = Number(healthMetrics?.restingHeartRate || 0)
    if (restingHr > 0) {
      const rhrDelta = restingHr >= 85 ? -14 : restingHr >= 75 ? -7 : restingHr <= 60 ? 4 : 0
      score += rhrDelta
      breakdown.push({
        label: 'Resting heart rate',
        value: rhrDelta,
        delta: rhrDelta,
        reason: restingHr >= 85
          ? `${restingHr} bpm resting HR is elevated, so Forged Hybrid lowers intensity.`
          : restingHr >= 75
            ? `${restingHr} bpm resting HR is above the preferred range.`
            : restingHr <= 60
              ? `${restingHr} bpm resting HR looks calm.`
              : `${restingHr} bpm resting HR is neutral today.`,
      })
    }

    const activeMinutes = Number(healthMetrics?.activeMinutesThisWeek || 0)
    const workoutCount = Number(healthMetrics?.workoutCountThisWeek || 0)
    if (activeMinutes > 0 || workoutCount > 0) {
      const loadDelta = activeMinutes >= 420 || workoutCount >= 6 ? -8 : 0
      score += loadDelta
      breakdown.push({
        label: 'Apple Health load',
        value: loadDelta,
        delta: loadDelta,
        reason: loadDelta < 0
          ? `${activeMinutes} active minutes and ${workoutCount} workouts this week mean recovery matters.`
          : `${activeMinutes} active minutes and ${workoutCount} workouts this week are included in the score.`,
      })
    }

    return {
      readiness: Math.max(1, Math.min(99, Math.round(score))),
      readinessBreakdown: breakdown
    }
  }, [stats, checkedInToday, hasWatchData, healthSync.metrics, fmt])
  const passiveReadinessScore = Number.isFinite(Number(readinessState.data?.score))
    ? Math.round(Number(readinessState.data.score))
    : null
  const userFacingReadiness = passiveReadinessScore !== null ? passiveReadinessScore : readiness

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

  // H5: prefer today's calendar session over the legacy next-recommendation.
  // Active-plan rest days stay explicit; only a missing calendar day falls
  // back to the legacy recommendation.
  const calendarRec = useMemo(() => recommendationFromExecution(execution), [execution])
  const calendarOwnsToday = Boolean(execution?.hasPlan && execution?.hasDay)
  const effectiveRecommendation = calendarRec || (calendarOwnsToday ? null : nextRecommendation)

  const todayWatchWorkout = useMemo(() => {
    if (!effectiveRecommendation) return null
    const hasDistance = Number(effectiveRecommendation.suggestedDistance || 0) > 0
    const hasPace = Boolean(effectiveRecommendation.suggestedPace)
    if (!hasDistance && !hasPace) return null
    return {
      typeLabel: effectiveRecommendation.type || effectiveRecommendation.recommendationType || 'Forged Hybrid Workout',
      distanceLabel: hasDistance ? `${effectiveRecommendation.suggestedDistance} mi` : '',
      pace: effectiveRecommendation.suggestedPace || '',
      progression: effectiveRecommendation.progression || effectiveRecommendation.summary || '',
      description: effectiveRecommendation.interference?.reason || effectiveRecommendation.reason || effectiveRecommendation.why || '',
      zone: effectiveRecommendation.targetZone || '',
      intensity: effectiveRecommendation.intensity || '',
      steps: structureToWatchSteps(effectiveRecommendation.structure),
    }
  }, [effectiveRecommendation])

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

  const decideTrainingGap = useCallback(async (decision) => {
    if (!trainingGapProposal?.id || !['accept', 'keep'].includes(decision)) return
    setTrainingGapDecision(decision)
    setTrainingGapError('')
    try {
      await api.post(`/plans/adaptation/${trainingGapProposal.id}/${decision}`)
      setTrainingGapProposal(null)
      setTrainingGapNotice(decision === 'accept' ? 'Plan adjusted for a safer return.' : 'Calendar left as planned.')
      if (decision === 'accept') await fetchDashboardData()
    } catch (error) {
      setTrainingGapError(error?.response?.data?.error || 'Could not save that choice. Please try again.')
    } finally {
      setTrainingGapDecision(null)
    }
  }, [fetchDashboardData, trainingGapProposal])

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
      {(!isOnline || queueCount > 0) && (
        <div className="rounded-xl p-2 text-sm font-semibold" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
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

      <TrainingGapPrompt
        proposal={trainingGapProposal}
        deciding={trainingGapDecision}
        error={trainingGapError}
        onDecision={decideTrainingGap}
      />

      <DailyCoachFlow /* H5: effectiveRecommendation prefers calendar */
        checkedInToday={checkedInToday}
        readiness={userFacingReadiness}
        recommendation={effectiveRecommendation}
        todayWatchWorkout={todayWatchWorkout}
        onCheckIn={() => navigate('/checkin')}
        onStartWorkout={handleStartWorkout}
        onReflect={() => navigate('/history')}
        onDetails={() => setShowTodayDetail(true)}
      />

      <HybridScoreCard hybridScore={hybridScore} />

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
        readiness={userFacingReadiness}
        readinessBreakdown={readinessBreakdown}
        recommendation={effectiveRecommendation}
        checkinData={checkinData}
        dailySteps={dailySteps}
        dailyStepsSource={dailyStepsSource}
        activeInjury={activeInjury}
        watchSyncNotice={watchSyncNotice}
        compliance={compliance}
        onCheckIn={() => navigate('/checkin')}
        onStartWorkout={handleStartWorkout}
        onWarmup={() => navigate('/prep?mode=warmup')}
        onReflect={() => navigate('/history')}
        onOpenReadiness={() => {
          setShowTodayDetail(false)
          setShowReadinessModal(true)
        }}
      />

      <ReadinessCard readinessState={readinessState} onOpenDetail={() => setShowReadinessModal(true)} />

      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        {dailySteps !== null && (
          <div>
            <p className="text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)', margin: 0 }}>
              <Footprints size={14} />
              <span>
                <strong style={{ color: 'var(--text-primary)' }}>{Number(dailySteps).toLocaleString()} steps</strong>
                {dailyStepsSource === 'watch' && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--success)' }}>⌚ synced</span>}
              </span>
            </p>
          </div>
        )}
        {dailySteps === null && (
          <p className="text-sm" style={{ color: 'var(--text-muted)', margin: 0 }}>Sync Apple Health to show today&apos;s steps.</p>
        )}
      </div>

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
