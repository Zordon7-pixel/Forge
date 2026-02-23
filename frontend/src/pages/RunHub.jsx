import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, TrendingUp, Calendar, Zap, Heart } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import Plan from './Plan'
import LoadingRunner from '../components/LoadingRunner'

const WARM_UP_STEPS = [
  { name: 'Leg Swings', detail: '10 each side', icon: 'FootprintIcon' },
  { name: 'High Knees', detail: '30 seconds', icon: 'ArrowUp' },
  { name: 'Ankle Circles', detail: '10 each direction', icon: 'RefreshCw' },
  { name: 'Hip Circles', detail: '10 each direction', icon: 'RotateCw' },
  { name: 'Arm Swings', detail: '20 reps', icon: 'Waves' },
]

// Compute readiness score based on stats
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

function getReadinessColor(score) {
  if (score < 50) return '#ef4444' // red
  if (score < 75) return '#EAB308' // yellow
  return '#22c55e' // green
}

function getReadinessMessage(score, t) {
  if (score < 50) return t('run.takeItEasy')
  if (score < 75) return t('run.goodToGo')
  return t('run.youAreReady')
}

function getReadinessAdvice(score, stats, checkin) {
  const weekMiles = Number(stats?.week?.miles || 0)
  const streak = Number(stats?.streak || 0)

  if (weekMiles > 30) return 'You\'ve been grinding — keep today easy.'
  if (weekMiles < 10) return 'Your legs are fresh — push the pace today.'
  if (streak >= 5) return 'Your consistency is strong — let\'s build on it.'
  return 'You\'re ready. Trust your training.'
}

// ===== WARMUP STEPS SCREEN =====
function WarmupSteps({ stepIndex, onNext, onSkip }) {
  const { t } = useTranslation()
  const step = WARM_UP_STEPS[stepIndex]
  const progress = ((stepIndex + 1) / WARM_UP_STEPS.length) * 100

  return (
    <div
      className="flex flex-col min-h-screen justify-between relative overflow-hidden"
      style={{
        background: 'linear-gradient(135deg, var(--bg-base) 0%, rgba(0,0,0,0.3) 100%)',
        paddingBottom: 80,
      }}
    >
      {/* Progress bar */}
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
            background: '#EAB308',
            transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
            boxShadow: '0 0 16px rgba(234, 179, 8, 0.6)',
          }}
        />
      </div>

      {/* Header */}
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
          {t('run.step')} {stepIndex + 1} {t('run.of')} {WARM_UP_STEPS.length}
        </p>
      </div>

      {/* Main content — centered */}
      <div className="flex flex-col items-center justify-center flex-1 px-6">
        {/* Large step circle */}
        <div
          style={{
            width: 120,
            height: 120,
            borderRadius: '50%',
            border: '3px solid #EAB308',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 40,
            animation: 'scale-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        >
          <span
            style={{
              fontSize: 56,
              fontWeight: 900,
              color: '#EAB308',
            }}
          >
            {stepIndex + 1}
          </span>
        </div>

        {/* Exercise name — massive and bold */}
        <h2
          style={{
            fontSize: 48,
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

        {/* Detail text — prominent */}
        <p
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: '#EAB308',
            margin: '0 0 32px',
            textAlign: 'center',
          }}
        >
          {step.detail}
        </p>

        {/* Instruction hint */}
        <p
          style={{
            fontSize: 14,
            color: 'var(--text-muted)',
            textAlign: 'center',
            margin: 0,
            fontStyle: 'italic',
          }}
        >
          Complete this movement, then tap Next
        </p>
      </div>

      {/* Bottom actions */}
      <div className="fixed bottom-0 left-0 right-0 px-4 py-6" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.5), transparent)' }}>
        <div className="max-w-[480px] mx-auto">
          {/* Next/Finish button */}
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
              background: '#EAB308',
              color: '#000',
              cursor: 'pointer',
              boxShadow: '0 8px 24px rgba(234, 179, 8, 0.3)',
              transition: 'all 0.2s ease',
              marginBottom: 12,
            }}
            onMouseEnter={e => (e.target.style.boxShadow = '0 12px 32px rgba(234, 179, 8, 0.5)')}
            onMouseLeave={e => (e.target.style.boxShadow = '0 8px 24px rgba(234, 179, 8, 0.3)')}
          >
            {stepIndex === WARM_UP_STEPS.length - 1 ? t('run.finishWarmup') : t('run.next')}
          </button>

          {/* Skip link */}
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

// ===== POST-WARMUP READINESS SCREEN =====
function WarmupDone({ onStartRun }) {
  const { t } = useTranslation()
  const [stats, setStats] = useState(null)
  const [checkin, setCheckin] = useState(null)
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [statsRes, checkinRes, planRes] = await Promise.all([
          api.get('/auth/me/stats').catch(() => ({ data: null })),
          api.get('/checkin/today').catch(() => ({ data: null })),
          api.get('/plans/current').catch(() => ({ data: null })),
        ])
        setStats(statsRes?.data)
        setCheckin(checkinRes?.data)
        setPlan(planRes?.data?.plan || planRes?.data)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) return <LoadingRunner message="Assessing readiness" />

  const readinessScore = computeReadiness(stats, checkin)
  const readinessColor = getReadinessColor(readinessScore)
  const readinessMessage = getReadinessMessage(readinessScore, t)
  const readinessAdvice = getReadinessAdvice(readinessScore, stats, checkin)

  const weekMiles = Number(stats?.week?.miles || 0)
  const streak = Number(stats?.streak || 0)

  // Extract today's plan
  let todayPlan = null
  if (plan?.plan_json?.weeks?.[0]?.days) {
    const today = new Date()
    const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1 // 0=Mon
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
        {/* Readiness summary card */}
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

          {/* Readiness bar */}
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

        {/* Today's Plan card (if available) */}
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
              <Calendar size={18} style={{ color: '#EAB308' }} />
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
              {todayPlan.workout_type || todayPlan.type || 'Rest Day'}
            </p>
            {todayPlan.distance && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Target: {todayPlan.distance} miles
              </p>
            )}
          </div>
        )}

        {/* This Week card */}
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
              <TrendingUp size={16} style={{ color: '#EAB308' }} />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, fontWeight: 600 }}>Week Miles</p>
            </div>
            <p style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
              {weekMiles.toFixed(1)}
            </p>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Zap size={16} style={{ color: '#EAB308' }} />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, fontWeight: 600 }}>Streak</p>
            </div>
            <p style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-primary)', margin: 0 }}>
              {streak} days
            </p>
          </div>
        </div>

        {/* Feeling card (if checkin exists) */}
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
              <Heart size={18} style={{ color: '#EAB308' }} />
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

        {/* Start Run button */}
        <button
          onClick={onStartRun}
          style={{
            width: '100%',
            padding: '20px 0',
            fontSize: 16,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 1.2,
            borderRadius: 24,
            border: 'none',
            background: '#EAB308',
            color: '#000',
            cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(234, 179, 8, 0.3)',
            transition: 'all 0.2s ease',
            marginTop: 24,
          }}
          onMouseEnter={e => (e.target.style.boxShadow = '0 12px 32px rgba(234, 179, 8, 0.5)')}
          onMouseLeave={e => (e.target.style.boxShadow = '0 8px 24px rgba(234, 179, 8, 0.3)')}
        >
          {t('run.startRun')}
        </button>
      </div>
    </div>
  )
}

// ===== MAIN RUN HUB COMPONENT =====
export default function RunHub() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [tab, setTab] = useState('run') // 'run' | 'plan'
  const [runState, setRunState] = useState('warmup-steps') // 'warmup-steps' | 'warmup-done' | 'run-form'
  const [stepIndex, setStepIndex] = useState(0)

  const handleNextStep = () => {
    if (stepIndex === WARM_UP_STEPS.length - 1) {
      setRunState('warmup-done')
    } else {
      setStepIndex(s => s + 1)
    }
  }

  const handleSkipWarmup = () => {
    setRunState('warmup-done')
  }

  const handleStartRun = () => {
    navigate('/log-run')
  }

  if (tab === 'plan') {
    return (
      <div>
        {/* Tab header */}
        <div className="sticky top-0 z-10 flex gap-0 px-4 pt-2 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
          <button
            onClick={() => setTab('run')}
            style={{
              flex: 1,
              padding: '12px 0',
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--text-muted)',
              background: 'none',
              border: 'none',
              borderBottom: '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            Run
          </button>
          <button
            onClick={() => setTab('plan')}
            style={{
              flex: 1,
              padding: '12px 0',
              fontSize: 14,
              fontWeight: 700,
              color: '#EAB308',
              background: 'none',
              border: 'none',
              borderBottom: '2px solid #EAB308',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            Plan
          </button>
        </div>

        {/* Plan tab content */}
        <div className="pt-4">
          <Plan />
        </div>
      </div>
    )
  }

  // Run tab
  return (
    <div>
      {/* Tab header */}
      <div className="sticky top-0 z-10 flex gap-0 px-4 pt-2 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
        <button
          onClick={() => setTab('run')}
          style={{
            flex: 1,
            padding: '12px 0',
            fontSize: 14,
            fontWeight: 700,
            color: '#EAB308',
            background: 'none',
            border: 'none',
            borderBottom: '2px solid #EAB308',
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
        >
          Run
        </button>
        <button
          onClick={() => setTab('plan')}
          style={{
            flex: 1,
            padding: '12px 0',
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--text-muted)',
            background: 'none',
            border: 'none',
            borderBottom: '2px solid transparent',
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
        >
          Plan
        </button>
      </div>

      {/* Run states */}
      {runState === 'warmup-steps' && (
        <WarmupSteps stepIndex={stepIndex} onNext={handleNextStep} onSkip={handleSkipWarmup} />
      )}
      {runState === 'warmup-done' && <WarmupDone onStartRun={handleStartRun} />}
    </div>
  )
}
