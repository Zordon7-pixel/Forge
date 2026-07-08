import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useLocation, useNavigate } from 'react-router-dom'
import { Footprints, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import AchievementUnlock from '../components/AchievementUnlock'
import InsightsSheet, { CalendarDayDetailSheet, DailyCoachFlow, ReadinessBreakdownModal, RecentActivityCard, TodayDetailSheet, WatchSyncWidget } from '../components/InsightsSheet'
import ReadinessCard from '../components/ReadinessCard'
import TodaysPickCard from '../components/TodaysPickCard'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import track from '../lib/track'
import LoadingRunner from '../components/LoadingRunner'
import { useOnlineStatus } from '../lib/useOnlineStatus'
import HealthService from '../services/HealthService'
import { useProContext } from '../context/ProContext'

function fmtPace(durationSeconds, distance) {
  if (!durationSeconds || !distance) return '--'; const pace = durationSeconds / 60 / distance
  return `${Math.floor(pace)}:${String(Math.round((pace - Math.floor(pace)) * 60)).padStart(2,'0')} /mi` }

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

function getRecommendationRunType(recommendation) {
  const rawType = String(recommendation?.recommendationType || recommendation?.type || '').toLowerCase()
  if (rawType.includes('race')) return 'race'
  if (rawType.includes('long')) return 'long'
  if (rawType.includes('interval') || rawType.includes('speed') || rawType.includes('track')) return 'intervals'
  if (rawType.includes('tempo') || rawType.includes('threshold')) return 'tempo'
  return 'easy'
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
  const [shoes, setShoes] = useState([]), [shoeAlerts, setShoeAlerts] = useState([]), [weeklyCalories, setWeeklyCalories] = useState(0)

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
  const [ageGradedPerformance, setAgeGradedPerformance] = useState(null)
  const [healthSync, setHealthSync] = useState({ loading: true, available: false, reason: null, metrics: null })
  const [readinessState, setReadinessState] = useState({ loading: true, error: false, locked: false, data: null })
  const [healthSyncNotice, setHealthSyncNotice] = useState('')
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
        const [statsRes, runsRes, liftsRes, warningRes, checkinRes, goalRes, streakRes, milestoneRes, complianceRes, loadRes, nextRaceRes, gearRes, injuryRes, recapRes, recommendationRes, ageGradedRes] = await Promise.all([
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
        const gearShoes = gearRes.data?.shoes || []
        setShoes(gearShoes)
        setShoeAlerts(gearShoes.filter((s) => Number(s.total_miles || 0) > 450))
        setActiveInjury((injuryRes.data?.injuries || [])[0] || null)
        setWeeklyCalories(recapRes.data?.totalCalories || 0)
        setNextRecommendation(recommendationRes.data || null)
        setAgeGradedPerformance(ageGradedRes.data || null)
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
          ? `${restingHr} bpm resting HR is elevated, so Forge lowers intensity.`
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

  const todayWatchWorkout = useMemo(() => {
    if (!nextRecommendation) return null
    const hasDistance = Number(nextRecommendation.suggestedDistance || 0) > 0
    const hasPace = Boolean(nextRecommendation.suggestedPace)
    if (!hasDistance && !hasPace) return null
    return {
      typeLabel: nextRecommendation.type || nextRecommendation.recommendationType || 'Forge Workout',
      distanceLabel: hasDistance ? `${nextRecommendation.suggestedDistance} mi` : '',
      pace: nextRecommendation.suggestedPace || '',
      progression: nextRecommendation.progression || nextRecommendation.summary || '',
      description: nextRecommendation.interference?.reason || nextRecommendation.reason || nextRecommendation.why || '',
      zone: nextRecommendation.targetZone || '',
      intensity: nextRecommendation.intensity || '',
      steps: structureToWatchSteps(nextRecommendation.structure),
    }
  }, [nextRecommendation])

  const shoeSummary = useMemo(() => {
    const allShoes = Array.isArray(shoes) ? shoes : []
    const activeShoes = allShoes.filter((shoe) => !shoe.is_retired)
    const closest = activeShoes
      .map((shoe) => {
        const miles = Number(shoe.total_miles || 0)
        const recommended = Number(shoe.recommended_miles || 0)
        return {
          shoe,
          miles,
          recommended,
          remaining: recommended > 0 ? recommended - miles : Number.POSITIVE_INFINITY,
        }
      })
      .sort((a, b) => {
        if (a.remaining !== b.remaining) return a.remaining - b.remaining
        return b.miles - a.miles
      })[0]

    return {
      totalCount: allShoes.length,
      activeCount: activeShoes.length,
      closest,
    }
  }, [shoes])

  const showLoadWarning = loadAnalysis && ['elevated', 'high', 'danger'].includes(loadAnalysis.loadStatus) && Date.now() > loadWarningDismissedUntil
  const complianceColor = compliance?.score >= 80 ? '#22c55e' : compliance?.score >= 50 ? '#EAB308' : '#ef4444'
  const todaysPickRunType = getRecommendationRunType(nextRecommendation)
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
    if (!nextRecommendation) return navigate('/run')
    track('recommendation_followed', { via: 'today_card_start' })
    if (nextRecommendation.recommendationType === 'rest') return navigate('/plan')
    if (nextRecommendation.recommendationType === 'strength') return navigate('/log-lift')
    const params = new URLSearchParams()
    if (Number(nextRecommendation.suggestedDistance || 0) > 0) params.set('distance', String(nextRecommendation.suggestedDistance))
    if (nextRecommendation.recommendationType) params.set('type', String(nextRecommendation.recommendationType))
    if (nextRecommendation.suggestedPace) params.set('pace', String(nextRecommendation.suggestedPace))
    navigate(`/log-run${params.toString() ? `?${params.toString()}` : ''}`)
  }, [navigate, nextRecommendation])

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

      {!injuryDismissed && activeInjury && activeInjury.id && (
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
              onClick={async () => {
                try {
                  await api.delete('/injury/active')
                } catch (_) {}
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

      <DailyCoachFlow
        checkedInToday={checkedInToday}
        readiness={userFacingReadiness}
        recommendation={nextRecommendation}
        todayWatchWorkout={todayWatchWorkout}
        onCheckIn={() => navigate('/checkin')}
        onStartWorkout={handleStartWorkout}
        onReflect={() => navigate('/history')}
        onDetails={() => setShowTodayDetail(true)}
      />

      <TodayDetailSheet
        open={showTodayDetail}
        onClose={() => setShowTodayDetail(false)}
        checkedInToday={checkedInToday}
        readiness={userFacingReadiness}
        readinessBreakdown={readinessBreakdown}
        recommendation={nextRecommendation}
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
      <TodaysPickCard runType={todaysPickRunType} />

      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        {dailySteps !== null && (
          <div>
            <p className="text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)', margin: 0 }}>
              <Footprints size={14} />
              <span>
                <strong style={{ color: 'var(--text-primary)' }}>{Number(dailySteps).toLocaleString()} steps</strong>
                {dailyStepsSource === 'watch' && <span style={{ marginLeft: 6, fontSize: 11, color: '#22c55e' }}>⌚ synced</span>}
              </span>
            </p>
          </div>
        )}
        {dailySteps === null && (
          <p className="text-sm" style={{ color: 'var(--text-muted)', margin: 0 }}>Sync Apple Health to show today&apos;s steps.</p>
        )}
      </div>

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

      <RecentActivityCard recentActivity={recentActivity} navigate={navigate} fmt={fmt} fmtDuration={fmtDuration} t={t} />

      <button
        type="button"
        onClick={() => navigate('/gear')}
        className="w-full rounded-2xl p-4 text-left"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
      >
        <div className="flex items-center gap-3">
          <span style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(148, 163, 184, 0.14)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Footprints size={20} color="#94A3B8" />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="text-sm font-black" style={{ display: 'block' }}>Shoes</span>
            <span className="text-xs mt-1" style={{ display: 'block', color: 'var(--text-muted)' }}>
              {shoeSummary.totalCount === 0
                ? 'Add your shoes'
                : `${shoeSummary.activeCount} active${shoeSummary.closest ? ` · ${shoeSummary.closest.shoe.name || 'Shoe'} ${Math.round(shoeSummary.closest.miles)}/${shoeSummary.closest.recommended > 0 ? Math.round(shoeSummary.closest.recommended) : '--'} mi` : ''}`}
            </span>
          </span>
          <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>Gear →</span>
        </div>
      </button>

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
