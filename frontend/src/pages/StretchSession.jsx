import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { postRunStretches, preRunStretches } from '../data/stretches'
import GuidedMovementTimer from '../components/GuidedMovementTimer'
import MovementDemo from '../components/MovementDemo'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'
import { chooseRotatingRoutine, rememberRoutine } from '../lib/routineRotation'
import { getLiftMobilityPool } from '../data/liftMobility'
import { stretchSideCount } from '../lib/stretchTimer'

const STRETCH_SESSION_COUNT = 6

function safeLiftRoutine(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).flatMap((item) => {
    const id = String(item?.id || '').slice(0, 80)
    const name = String(item?.name || '').slice(0, 80)
    const duration = Math.trunc(Number(item?.duration))
    const imageUrl = String(item?.image_url || item?.imageUrl || '')
    if (!id || !name || duration < 10 || duration > 120 || !imageUrl.startsWith('/stretches/')) return []
    return [{
      ...item,
      id,
      name,
      duration,
      reps: String(item?.reps || item?.durationLabel || '').slice(0, 80),
      muscle: String(item?.muscle || 'mobility').slice(0, 80),
      cue: String(item?.cue || '').slice(0, 240),
      image_url: imageUrl,
    }]
  })
}

export default function StretchSession() {
  const navigate = useNavigate()
  const location = useLocation()

  const typeFromQuery = new URLSearchParams(location.search).get('type')
  const sessionType = location.state?.type || typeFromQuery || 'pre'
  const isPre = sessionType !== 'post'
  const isLift = location.state?.context === 'lift'
  const liftPhase = location.state?.phase === 'recovery' ? 'recovery' : 'warmup'
  const liftWorkoutName = String(location.state?.workoutName || 'Strength Workout').slice(0, 80)

  const rotationScope = isLift
    ? String(location.state?.rotationScope || `lift-mobility:${liftPhase}:full`).slice(0, 120)
    : (isPre ? 'stretch-session:pre' : 'stretch-session:post')
  const stretches = useMemo(() => {
    if (isLift) {
      const passedRoutine = safeLiftRoutine(location.state?.routine)
      if (passedRoutine.length) return passedRoutine
      return chooseRotatingRoutine(rotationScope, getLiftMobilityPool({}, liftPhase), STRETCH_SESSION_COUNT)
    }
    return chooseRotatingRoutine(rotationScope, isPre ? preRunStretches : postRunStretches, STRETCH_SESSION_COUNT)
  }, [isLift, isPre, liftPhase, location.state?.routine, rotationScope])

  const [current, setCurrent] = useState(0)
  const [sideIndex, setSideIndex] = useState(0)
  const [done, setDone] = useState(false)
  const [sex, setSex] = useState(null)
  const [profileReady, setProfileReady] = useState(false)

  const currentStretch = stretches[current]
  const nextStretch = stretches[current + 1]
  const currentSideCount = stretchSideCount(currentStretch)
  const progress = Math.round(((current + (currentSideCount === 2 ? sideIndex / 2 : 0)) / stretches.length) * 100)

  useEffect(() => {
    rememberRoutine(rotationScope, stretches)
  }, [rotationScope, stretches])

  useEffect(() => {
    let active = true
    api.get('/auth/me')
      .then((res) => {
        if (active) setSex(String(res.data?.user?.sex || res.data?.sex || '').toLowerCase() === 'female' ? 'female' : 'male')
      })
      .catch((err) => {
        console.error('[stretch-session] profile load failed:', err?.message || err)
        if (active) setSex('male')
      })
      .finally(() => {
        if (active) setProfileReady(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setCurrent(0)
    setSideIndex(0)
    setDone(false)
  }, [stretches])

  const advance = () => {
    if (current >= stretches.length - 1) {
      setDone(true)
      return
    }

    setCurrent(value => value + 1)
    setSideIndex(0)
  }

  const goPrevious = () => {
    if (current === 0) return
    setCurrent(value => value - 1)
    setSideIndex(0)
  }

  if (!profileReady) return <LoadingRunner message="Preparing stretches" />

  return (
    <>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes popIn {
          from { transform: scale(0); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .animate-transition-in { animation: fadeIn 0.3s ease forwards; }
        .animate-pop-in { animation: popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
      `}</style>
      
      <div className="min-h-screen rounded-2xl bg-bg-base text-text-primary">
        <div
          className="mx-auto flex min-h-screen max-w-[480px] flex-col p-4"
          style={{ paddingBottom: 'calc(var(--app-bottom-nav-height, 59px) + 164px)' }}
        >
          <div className="mb-4 h-2 w-full rounded-full bg-bg-input">
            <div className="h-2 rounded-full bg-accent transition-all" style={{ width: `${done ? 100 : progress}%` }} />
          </div>

          <header className="mb-6 flex items-center justify-between">
            <button onClick={() => navigate(-1)} className="min-h-[44px] text-text-muted">← Back</button>
            <div className="text-center">
              <h1 className="text-lg font-bold">{isLift ? (liftPhase === 'warmup' ? 'Lift Warm-Up' : 'Post-Lift Stretch') : (isPre ? 'Pre-Run Warmup' : 'Post-Run Recovery')}</h1>
              <p className="text-xs text-text-muted">{Math.min(current + 1, stretches.length)} / {stretches.length}</p>
            </div>
            <div className="w-12" />
          </header>

          {done ? (
            <div className="my-auto rounded-2xl border border-success bg-bg-card p-8 text-center animate-pop-in">
              <div className="flex justify-center mb-4">
                <CheckCircle2 size={64} color="var(--accent)" strokeWidth={1.5} />
              </div>
              <p className="text-3xl font-black text-accent">Session Complete</p>
              <p className="mt-3 text-sm text-text-muted">
                {isLift
                  ? (liftPhase === 'warmup' ? `Your body is prepared for ${liftWorkoutName}.` : `Post-lift mobility for ${liftWorkoutName} is complete.`)
                  : (isPre ? 'You are warmed up with dynamic movement only. Ready to run strong.' : 'Recovery complete. Hold static stretches after each run to reduce tightness.')}
              </p>
              <button
                onClick={() => navigate(isLift ? '/log-lift' : '/log-run')}
                className="mt-5 rounded-xl bg-accent px-5 py-3 font-bold text-on-accent"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <div className="rounded-2xl border border-border-subtle bg-bg-card p-5 animate-transition-in">
                <span className="rounded-full bg-bg-input px-2 py-1 text-xs text-text-muted">{currentStretch.muscle}</span>
                <h2 className="mt-3 text-3xl font-black text-text-primary">{currentStretch.name}</h2>
                <p className="mt-3 text-sm text-text-muted">{currentStretch.cue}</p>
                <p className="mt-3 text-sm font-semibold text-text-muted">{currentStretch.reps}</p>
                <div className="mt-4 text-xs" style={{ color: 'var(--accent)', fontWeight: 700 }}>
                  Review the visual guide and movement cue before starting.
                </div>
              </div>

              <div className="my-8 flex flex-col items-center">
                <MovementDemo name={currentStretch.name} sex={sex} imageUrl={currentStretch.image_url || currentStretch.imageUrl} cue={currentStretch.cue} />
                <GuidedMovementTimer
                  key={rotationScope + ':' + current + ':' + currentStretch.id}
                  movement={currentStretch}
                  movementKey={rotationScope + ':' + current + ':' + currentStretch.id}
                  onComplete={advance}
                  onSkip={advance}
                  onPrevious={goPrevious}
                  onSideChange={setSideIndex}
                  canPrevious={current > 0}
                  skipLabel={current === stretches.length - 1 ? 'Skip and finish' : 'Skip'}
                />
              </div>

              <footer className="mt-auto pb-4 text-center">
                {current === stretches.length - 1 ? (
                  <p className="text-sm text-text-muted">Final movement</p>
                ) : (
                  <p className="text-sm text-text-muted">Up next: {nextStretch?.name} →</p>
                )}
              </footer>
            </>
          )}
        </div>
      </div>
    </>
  )
}
