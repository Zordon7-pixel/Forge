import { useEffect, useReducer, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useNavigate, useLocation } from 'react-router'
import { TrendingUp, Calendar, Zap, Heart } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import MovementDemo from '../components/MovementDemo'
import { preRunStretches } from '../data/stretches'
import { chooseRotatingRoutine, rememberRoutine } from '../lib/routineRotation'
import { SWIPE_BACK_EVENT } from '../lib/swipeBack'
import { groupRunNavigationProvenance, isGroupRunNavigationState } from '../lib/groupRuns'
import { localDateISO } from '../lib/dailyExecution'
import {
  createStretchTimerState,
  isTimePrescribedMovement,
  stretchTimerReducer,
  TIMER_ACTION,
  TIMER_PHASE,
} from '../lib/stretchTimer'

const WARMUP_ROTATION_SCOPE = 'warmup'
const WARMUP_STEP_COUNT = 5

function computeReadiness(stats, checkin) {
  let score = 60

  if (checkin) score += 10

  const streak = Number(stats?.streak || 0)
  if (streak >= 3) score += 10

  const weekMiles = Number(stats?.week?.miles || 0)
  if (weekMiles < 10) score += 10
  if (weekMiles > 30) score -= 10

  return Math.max(30, Math.min(100, score))
}

// hex required: consumed by `${color}XX` alpha templates — do not tokenize
function getReadinessColor(score) {
  if (score < 50) return '#ef4444'
  if (score < 75) return '#EAB308'
  return '#22c55e'
}

function getReadinessMessage(score, t) {
  if (score < 50) return t('run.takeItEasy')
  if (score < 75) return t('run.goodToGo')
  return t('run.youAreReady')
}

function getReadinessAdvice(stats) {
  const weekMiles = Number(stats?.week?.miles || 0)
  const streak = Number(stats?.streak || 0)

  if (weekMiles > 30) return "You've been grinding - keep today easy."
  if (weekMiles < 10) return 'Your legs are fresh - push the pace today.'
  if (streak >= 5) return "Your consistency is strong - let's build on it."
  return "You're ready. Trust your training."
}

function WarmupCountdown({ movement, movementKey }) {
  const [state, dispatch] = useReducer(
    stretchTimerReducer,
    null,
    () => createStretchTimerState(movement, movementKey),
  )

  useEffect(() => {
    dispatch({ type: TIMER_ACTION.RESET, stretch: movement, movementKey })
  }, [movement, movementKey])

  useEffect(() => {
    if (state.phase !== TIMER_PHASE.RUNNING) return undefined
    const intervalId = window.setInterval(() => {
      dispatch({ type: TIMER_ACTION.TICK })
    }, 1000)
    return () => window.clearInterval(intervalId)
  }, [state.phase])

  useEffect(() => {
    let active = true
    let appStateHandle = null

    const pauseCountdown = () => {
      if (active) dispatch({ type: TIMER_ACTION.PAUSE })
    }
    const pauseWhenHidden = () => {
      if (document.visibilityState === 'hidden') pauseCountdown()
    }
    const removeAppStateListener = async (handle) => {
      try {
        await handle?.remove?.()
      } catch (error) {
        console.warn('[WarmupCountdown] app state listener cleanup failed:', error?.message || error)
      }
    }
    const registerAppStateListener = async () => {
      try {
        const handle = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) pauseCountdown()
        })
        if (!active) {
          await removeAppStateListener(handle)
          return
        }
        appStateHandle = handle
      } catch (error) {
        console.warn('[WarmupCountdown] app state listener setup failed:', error?.message || error)
      }
    }

    document.addEventListener('visibilitychange', pauseWhenHidden)
    void registerAppStateListener()

    return () => {
      active = false
      document.removeEventListener('visibilitychange', pauseWhenHidden)
      if (appStateHandle) {
        const handle = appStateHandle
        appStateHandle = null
        void removeAppStateListener(handle)
      }
    }
  }, [])

  const running = state.phase === TIMER_PHASE.RUNNING
  const complete = state.phase === TIMER_PHASE.COMPLETE
  const primaryLabel = state.phase === TIMER_PHASE.PAUSED ? 'Resume' : running ? 'Pause' : 'Start'
  const status = complete
    ? 'Movement complete'
    : state.phase === TIMER_PHASE.PAUSED ? 'Timer paused' : running ? 'Timer running' : 'Timer ready'

  return (
    <section
      aria-label="Warm-up countdown"
      className="mt-5 w-full max-w-sm rounded-2xl p-4 text-center"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <p aria-live="polite" className="text-xs font-black uppercase tracking-widest" style={{ color: complete ? 'var(--success, #22c55e)' : 'var(--text-muted)' }}>
        {status}
      </p>
      <p
        aria-label={`${state.remaining} seconds remaining`}
        className="mt-1 text-6xl font-black tabular-nums"
        style={{ color: complete ? 'var(--success, #22c55e)' : 'var(--accent)', lineHeight: 1 }}
      >
        {state.remaining}
      </p>
      <p className="mt-1 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>seconds remaining</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={complete}
          onClick={() => dispatch({ type: running ? TIMER_ACTION.PAUSE : TIMER_ACTION.START })}
          className="rounded-xl px-3 py-2 text-sm font-black"
          style={{ minHeight: 44, background: 'var(--accent)', color: 'var(--on-accent)', opacity: complete ? 0.55 : 1 }}
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: TIMER_ACTION.RESTART })}
          className="rounded-xl border px-3 py-2 text-sm font-black"
          style={{ minHeight: 44, background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          Restart
        </button>
      </div>
    </section>
  )
}

function WarmupSteps({ steps, stepIndex, onNext, onSkip, sex }) {
  const { t } = useTranslation()
  const step = steps[stepIndex]
  const progress = ((stepIndex + 1) / steps.length) * 100
  const timed = isTimePrescribedMovement(step)

  return (
    <div
      className="flex flex-col min-h-screen justify-between relative overflow-y-auto"
      style={{
        background: 'linear-gradient(135deg, var(--bg-base) 0%, rgba(0,0,0,0.3) 100%)',
        paddingBottom: 'calc(var(--app-bottom-nav-height, 59px) + 132px)',
      }}
    >
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '3px',
          background: 'rgba(255,255,255,0.1)',
          zIndex: 40,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${progress}%`,
            background: 'var(--accent)',
            transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
            boxShadow: '0 0 16px rgba(234, 179, 8, 0.6)',
          }}
        />
      </div>

      <div style={{ paddingTop: 16 }}>
        <p
          style={{
            textAlign: 'center',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 1.2,
            margin: 0,
            marginTop: 16,
          }}
        >
          Warm-Up
        </p>
        <p
          style={{
            textAlign: 'center',
            fontSize: 13,
            color: 'var(--text-muted)',
            margin: '4px 0 0',
          }}
        >
          {t('run.step')} {stepIndex + 1} {t('run.of')} {steps.length}
        </p>
      </div>

      <div className="flex flex-col items-center justify-center flex-1 px-6">
        <h2
          style={{
            fontSize: 38,
            fontWeight: 900,
            textAlign: 'center',
            color: 'var(--text-primary)',
            margin: '0 0 16px',
            lineHeight: 1.1,
            textTransform: 'uppercase',
            letterSpacing: -1,
            animation: 'fade-in 0.6s ease',
          }}
        >
          {step.name}
        </h2>

        <p
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--accent)',
            margin: '0 0 32px',
            textAlign: 'center',
          }}
        >
          {step.reps}
        </p>

        <MovementDemo name={step.name} compact sex={sex} imageUrl={step.image_url} cue={step.cue} />

        {timed && (
          <WarmupCountdown
            key={`${stepIndex}:${step.id}`}
            movement={step}
            movementKey={`${stepIndex}:${step.id}`}
          />
        )}

        <p
          style={{
            fontSize: 14,
            color: 'var(--text-muted)',
            textAlign: 'center',
            margin: '24px 0 0',
            fontStyle: 'italic',
          }}
        >
          {timed ? 'Use the timer when ready. Next stays in your control.' : 'Complete this movement, then tap Next'}
        </p>
      </div>

      <div
        className="fixed left-0 right-0 px-4 py-4"
        style={{
          bottom: 'var(--app-bottom-nav-height, 59px)',
          background: 'linear-gradient(to top, var(--bg-base) 72%, transparent)',
        }}
      >
        <div className="max-w-[480px] mx-auto">
          <button
            onClick={onNext}
            style={{
              width: '100%',
              padding: '20px 0',
              fontSize: 16,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 1.2,
              borderRadius: 24,
              border: 'none',
              background: 'var(--accent)',
              color: 'var(--on-accent)',
              cursor: 'pointer',
              boxShadow: '0 8px 24px rgba(234, 179, 8, 0.3)',
              transition: 'all 0.2s ease',
              marginBottom: 12,
            }}
            onMouseEnter={e => (e.target.style.boxShadow = '0 12px 32px rgba(234, 179, 8, 0.5)')}
            onMouseLeave={e => (e.target.style.boxShadow = '0 8px 24px rgba(234, 179, 8, 0.3)')}
          >
            {stepIndex === steps.length - 1 ? t('run.finishWarmup') : t('run.next')}
          </button>

          <button
            onClick={onSkip}
            style={{
              width: '100%',
              textAlign: 'center',
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: 12,
              cursor: 'pointer',
              padding: '8px 0',
              transition: 'color 0.2s',
            }}
            onMouseEnter={e => (e.target.style.color = 'var(--text-primary)')}
            onMouseLeave={e => (e.target.style.color = 'var(--text-muted)')}
          >
            {t('run.skipWarmup')}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes scale-in {
          from { transform: scale(0.8); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

function WarmupDone({ onStartRun, checkinConfirmed = false, checkinDate }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [checkin, setCheckin] = useState(null)
  const [plan, setPlan] = useState(null)
  const [recommendedStretches, setRecommendedStretches] = useState(null)
  const [loading, setLoading] = useState(true)
  const [checkInCompleted, setCheckInCompleted] = useState(checkinConfirmed)

  useEffect(() => {
    const load = async () => {
      try {
        const [statsRes, checkinRes, planRes, stretchRes] = await Promise.all([
          api.get('/auth/me/stats').catch(() => ({ data: null })),
          api.get('/checkin/today', { params: { date: checkinDate || localDateISO() } }).catch(() => ({ data: null })),
          api.get('/plans/current').catch(() => ({ data: null })),
          api.get('/stretches/recommended').catch(() => ({ data: null })),
        ])
        setStats(statsRes?.data)
        const checkinData = checkinRes?.data
        setCheckin(checkinData)
        setCheckInCompleted(Boolean(checkinConfirmed || (checkinData?.completed ?? checkinData?.id ?? checkinData)))
        setPlan(planRes?.data?.plan || planRes?.data)
        if (stretchRes?.data?.stretches?.length > 0) {
          setRecommendedStretches({
            category: stretchRes.data.recommendedCategory || 'Pre-Run',
            reason: stretchRes.data.reason || 'Prepare your body for the run ahead',
            stretches: stretchRes.data.stretches
          })
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [checkinConfirmed, checkinDate])

  if (loading) return <LoadingRunner message="Assessing readiness" />

  if (!checkInCompleted) {
    return (
      <div style={{ minHeight: '100vh', padding: '24px 16px', background: 'var(--bg-base)' }}>
        <div className="max-w-[480px] mx-auto rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <h2 style={{ color: 'var(--text-primary)', fontSize: 24, fontWeight: 900, margin: '0 0 10px' }}>Morning Check-In Required</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: '0 0 16px' }}>Complete your morning check-in before starting a run.</p>
          <button onClick={() => navigate('/checkin')} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: 12, padding: '12px 0', fontWeight: 800, cursor: 'pointer' }}>Go to Check-In</button>
        </div>
      </div>
    )
  }

  const readinessScore = computeReadiness(stats, checkin)
  const readinessColor = getReadinessColor(readinessScore)
  const readinessMessage = getReadinessMessage(readinessScore, t)
  const readinessAdvice = getReadinessAdvice(stats)

  const weekMiles = Number(stats?.week?.miles || 0)
  const streak = Number(stats?.streak || 0)

  let todayPlan = null
  if (plan?.plan_json?.weeks?.[0]?.days) {
    const today = new Date()
    const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1
    todayPlan = plan.plan_json.weeks[0].days[dayOfWeek]
  }

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, var(--bg-base) 0%, rgba(0,0,0,0.3) 100%)',
        minHeight: '100vh',
        paddingBottom: 100,
      }}
    >
      <div className="px-4 pt-6 max-w-[480px] mx-auto space-y-4">
        <div
          className="card-hero"
          style={{
            padding: 24,
            textAlign: 'center',
          }}
        >
          <p className="t-micro" style={{ color: 'var(--accent)', margin: 0 }}>Ready</p>
          <h1 style={{ color: 'var(--text-primary)', fontSize: 30, lineHeight: 1.1, fontWeight: 950, margin: '8px 0' }}>Warm-up complete</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.5, margin: '0 auto 18px', maxWidth: 340 }}>
            Your check-in is saved. Start today's scheduled run when you are ready.
          </p>
          <button
            type="button"
            onClick={onStartRun}
            className="pressable"
            style={{
              width: '100%',
              minHeight: 56,
              fontSize: 17,
              fontWeight: 900,
              borderRadius: 12,
              border: 'none',
              background: 'var(--accent)',
              color: 'var(--on-accent)',
              cursor: 'pointer',
            }}
          >
            {t('run.startRun')}
          </button>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45, margin: '12px 0 0' }}>
            Start Run checks Location, then begins the timer and route recording.
          </p>
        </div>

        <div
          style={{
            background: 'var(--bg-card)',
            borderRadius: 16,
            padding: 24,
            border: '1px solid var(--border-subtle)',
          }}
        >
          <p
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              margin: '0 0 12px',
              letterSpacing: 1,
            }}
          >
            {t('run.readiness')}
          </p>
          <p
            style={{
              fontSize: 32,
              fontWeight: 900,
              color: readinessColor,
              margin: '0 0 16px',
            }}
          >
            {readinessMessage}
          </p>

          <div
            style={{
              height: 8,
              background: 'var(--bg-input)',
              borderRadius: 4,
              overflow: 'hidden',
              marginBottom: 12,
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${readinessScore}%`,
                background: readinessColor,
                borderRadius: 4,
                transition: 'width 0.8s ease',
                boxShadow: `0 0 12px ${readinessColor}44`,
              }}
            />
          </div>

          <p
            style={{
              fontSize: 14,
              color: 'var(--text-muted)',
              margin: 0,
              fontStyle: 'italic',
            }}
          >
            {readinessAdvice}
          </p>
        </div>

        {todayPlan && (
          <div
            style={{
              background: 'var(--bg-card)',
              borderRadius: 16,
              padding: 16,
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <Calendar size={18} style={{ color: 'var(--accent)' }} />
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  margin: 0,
                  letterSpacing: 0.8,
                }}
              >
                {t('run.todayPlan')}
              </p>
            </div>
            <p
              style={{
                fontSize: 18,
                fontWeight: 800,
                color: 'var(--text-primary)',
                margin: '0 0 4px',
                textTransform: 'capitalize',
              }}
            >
              {String(todayPlan.workout_type || todayPlan.type || 'Rest Day').replace(/_/g, ' ')}
            </p>
            {todayPlan.distance && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Target: {todayPlan.distance} miles
              </p>
            )}
          </div>
        )}

        <div
          style={{
            background: 'var(--bg-card)',
            borderRadius: 16,
            padding: 16,
            border: '1px solid var(--border-subtle)',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <TrendingUp size={16} style={{ color: 'var(--accent)' }} />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, fontWeight: 600 }}>Week Miles</p>
            </div>
            <p style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
              {weekMiles.toFixed(1)}
            </p>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Zap size={16} style={{ color: 'var(--accent)' }} />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, fontWeight: 600 }}>Streak</p>
            </div>
            <p style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
              {streak} days
            </p>
          </div>
        </div>

        {checkin && (
          <div
            style={{
              background: 'var(--bg-card)',
              borderRadius: 16,
              padding: 16,
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <Heart size={18} style={{ color: 'var(--accent)' }} />
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  margin: 0,
                  letterSpacing: 0.8,
                }}
              >
                {t('run.feeling')}
              </p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {checkin.feeling && (
                <div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 4px' }}>Feeling</p>
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)', margin: 0 }}>
                    {checkin.feeling}/5
                  </p>
                </div>
              )}
              {checkin.time_available && (
                <div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 4px' }}>Time Available</p>
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)', margin: 0 }}>
                    {checkin.time_available} min
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {recommendedStretches && recommendedStretches.stretches?.length > 0 && (
          <div
            style={{
              background: 'var(--bg-card)',
              borderRadius: 16,
              padding: 16,
              border: '1px solid var(--border-subtle)',
            }}
          >
            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                margin: '0 0 8px',
                letterSpacing: 0.8,
              }}
            >
              {t('stretches.suggested') || 'Suggested Stretches'}
            </p>
            <p style={{ fontSize: 14, color: 'var(--text-primary)', margin: '0 0 12px', fontWeight: 700 }}>
              {recommendedStretches.category}
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
              {recommendedStretches.reason}
            </p>
            <button
              onClick={() => navigate('/stretches')}
              style={{
                width: '100%',
                background: 'transparent',
                border: '1px solid var(--accent)',
                color: 'var(--accent)',
                fontWeight: 700,
                borderRadius: 12,
                padding: '10px 0',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Do Stretches
            </button>
          </div>
        )}

      </div>
    </div>
  )
}

export default function Warmup() {
  const navigate = useNavigate()
  // H5: preserve any incoming scheduled-run / plan-session state so the run
  // stays canonical through the warm-up → LogRun handoff.
  const location = useLocation()
  const [runState, setRunState] = useState('warmup-steps')
  const [stepIndex, setStepIndex] = useState(0)
  const [sex, setSex] = useState('')
  const [profileReady, setProfileReady] = useState(false)
  const [warmupSteps] = useState(() => chooseRotatingRoutine(
    WARMUP_ROTATION_SCOPE,
    preRunStretches,
    WARMUP_STEP_COUNT,
  ))

  useEffect(() => {
    rememberRoutine(WARMUP_ROTATION_SCOPE, warmupSteps)
  }, [warmupSteps])

  useEffect(() => {
    const handleSwipeBack = (event) => {
      if (runState === 'warmup-done') {
        event.preventDefault()
        setRunState('warmup-steps')
        setStepIndex(warmupSteps.length - 1)
      } else if (stepIndex > 0) {
        event.preventDefault()
        setStepIndex((current) => Math.max(0, current - 1))
      }
    }
    window.addEventListener(SWIPE_BACK_EVENT, handleSwipeBack)
    return () => window.removeEventListener(SWIPE_BACK_EVENT, handleSwipeBack)
  }, [runState, stepIndex, warmupSteps.length])

  useEffect(() => {
    let active = true
    api.get('/auth/me')
      .then((res) => {
        if (!active) return
        setSex(String(res.data?.user?.sex || res.data?.sex || '').toLowerCase() === 'female' ? 'female' : 'male')
      })
      .catch((err) => {
        console.error('[warmup] profile load failed:', err?.message || err)
        if (active) setSex('male')
      })
      .finally(() => {
        if (active) setProfileReady(true)
      })
    return () => {
      active = false
    }
  }, [])

  const handleNextStep = () => {
    if (stepIndex === warmupSteps.length - 1) {
      setRunState('warmup-done')
    } else {
      setStepIndex((s) => s + 1)
    }
  }

  const handleSkipWarmup = () => {
    setRunState('warmup-done')
  }

  const handleStartRun = () => {
    const incomingState = location.state && typeof location.state === 'object' ? location.state : {}
    const { warmupReturnTo, checkinCompleted, checkinDate, ...nextState } = incomingState
    if (isGroupRunNavigationState(nextState)) {
      navigate('/run/active', { replace: true, state: groupRunNavigationProvenance(nextState) })
      return
    }
    if (nextState.startAfterWarmup) {
      navigate('/run/active', { state: { ...nextState, autoStart: true } })
      return
    }
    const returnTo = typeof warmupReturnTo === 'string' && /^\/log-run(?:\?|$)/.test(warmupReturnTo)
      ? warmupReturnTo
      : '/log-run'
    navigate(returnTo, Object.keys(nextState).length ? { state: nextState } : undefined)
  }

  if (!profileReady) return <LoadingRunner message="Preparing warm-up" />

  return (
    <div>
      {runState === 'warmup-steps' && (
        <WarmupSteps steps={warmupSteps} stepIndex={stepIndex} onNext={handleNextStep} onSkip={handleSkipWarmup} sex={sex} />
      )}
      {runState === 'warmup-done' && (
        <WarmupDone
          onStartRun={handleStartRun}
          checkinConfirmed={Boolean(location.state?.checkinCompleted)}
          checkinDate={location.state?.checkinDate}
        />
      )}
    </div>
  )
}
