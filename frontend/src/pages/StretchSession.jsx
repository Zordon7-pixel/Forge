import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { postRunStretches, preRunStretches } from '../data/stretches'
import MovementDemo from '../components/MovementDemo'
import api from '../lib/api'
import LoadingRunner from '../components/LoadingRunner'

export default function StretchSession() {
  const navigate = useNavigate()
  const location = useLocation()

  const typeFromQuery = new URLSearchParams(location.search).get('type')
  const sessionType = location.state?.type || typeFromQuery || 'pre'
  const isPre = sessionType !== 'post'

  const stretches = useMemo(() => (isPre ? preRunStretches : postRunStretches), [isPre])

  const [current, setCurrent] = useState(0)
  const [secondsLeft, setSecondsLeft] = useState(stretches[0].duration)
  const [paused, setPaused] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const [nextName, setNextName] = useState('')
  const [done, setDone] = useState(false)
  const [sex, setSex] = useState(null)
  const [profileReady, setProfileReady] = useState(false)

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
    setSecondsLeft(stretches[0].duration)
    setPaused(false)
    setTransitioning(false)
    setNextName('')
    setDone(false)
  }, [stretches])

  useEffect(() => {
    if (!profileReady || paused || transitioning || done) return

    const timer = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          if (current >= stretches.length - 1) {
            setDone(true)
            return 0
          }

          const upcoming = stretches[current + 1]
          setNextName(upcoming.name)
          setTransitioning(true)

          setTimeout(() => {
            setCurrent(prevCurrent => prevCurrent + 1)
            setSecondsLeft(upcoming.duration)
            setTransitioning(false)
            setNextName('')
          }, 2000)

          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [profileReady, paused, transitioning, done, current, stretches])

  const currentStretch = stretches[current]
  const nextStretch = stretches[current + 1]
  const progress = Math.round((current / stretches.length) * 100)

  const skipToNext = () => {
    if (current >= stretches.length - 1) {
      setDone(true)
      setSecondsLeft(0)
      return
    }

    const upcoming = stretches[current + 1]
    setNextName(upcoming.name)
    setTransitioning(true)
    setSecondsLeft(0)

    setTimeout(() => {
      setCurrent(prev => prev + 1)
      setSecondsLeft(upcoming.duration)
      setTransitioning(false)
      setNextName('')
    }, 2000)
  }

  if (!profileReady) return <LoadingRunner message="Preparing stretches" />

  return (
    <>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes fadeOut {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(0.95); }
        }
        @keyframes timerPulse {
          0%,100% { color: #EAB308; transform: scale(1); }
          50% { color: #fbbf24; transform: scale(1.15); }
        }
        @keyframes popIn {
          from { transform: scale(0); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .animate-transition-in { animation: fadeIn 0.3s ease forwards; }
        .animate-transition-out { animation: fadeOut 0.3s ease forwards; }
        .animate-timer-pulse { animation: timerPulse 0.6s ease-in-out infinite; }
        .animate-pop-in { animation: popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
      `}</style>
      
      <div className="min-h-screen rounded-2xl bg-bg-base text-text-primary">
        <div className="mx-auto flex min-h-screen max-w-[480px] flex-col p-4">
          <div className="mb-4 h-2 w-full rounded-full bg-bg-input">
            <div className="h-2 rounded-full bg-accent transition-all" style={{ width: `${done ? 100 : progress}%` }} />
          </div>

          <header className="mb-6 flex items-center justify-between">
            <button onClick={() => navigate(-1)} className="text-text-muted">← Back</button>
            <div className="text-center">
              <h1 className="text-lg font-bold">{isPre ? 'Pre-Run Warmup' : 'Post-Run Recovery'}</h1>
              <p className="text-xs text-text-muted">{Math.min(current + 1, stretches.length)} / {stretches.length}</p>
            </div>
            <div className="w-12" />
          </header>

          {transitioning ? (
            <div className="my-auto rounded-2xl border border-border-subtle bg-bg-card p-8 text-center animate-transition-in">
              <p className="text-sm text-text-muted">Next up:</p>
              <p className="mt-2 text-2xl font-black text-accent">{nextName}</p>
            </div>
          ) : done ? (
            <div className="my-auto rounded-2xl border border-success bg-bg-card p-8 text-center animate-pop-in">
              <div className="flex justify-center mb-4">
                <CheckCircle2 size={64} color="var(--accent)" strokeWidth={1.5} />
              </div>
              <p className="text-3xl font-black text-accent">Session Complete</p>
              <p className="mt-3 text-sm text-text-muted">
                {isPre ? 'You are warmed up with dynamic movement only. Ready to run strong.' : 'Recovery complete. Hold static stretches after each run to reduce tightness.'}
              </p>
              <button
                onClick={() => navigate('/log-run')}
                className="mt-5 rounded-xl bg-accent px-5 py-3 font-bold text-on-accent"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <div className={`rounded-2xl border border-border-subtle bg-bg-card p-5 ${transitioning ? 'animate-transition-out' : 'animate-transition-in'}`}>
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
                <p className={`text-7xl font-black mt-6 ${secondsLeft <= 5 ? 'animate-timer-pulse' : 'text-accent'}`}>
                  {secondsLeft}
                </p>
                <div className="mt-3 flex items-center justify-center gap-4">
                  <button onClick={() => setPaused(prev => !prev)} className="rounded-lg border border-border-subtle px-3 py-1 text-xs text-text-muted">
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                  <button onClick={skipToNext} className="rounded-lg border border-border-subtle bg-accent-dim px-3 py-1 text-xs font-bold text-accent">
                    Skip stretch
                  </button>
                </div>
              </div>

              <footer className="mt-auto pb-4 text-center">
                {current === stretches.length - 1 ? (
                  <button onClick={() => setDone(true)} className="rounded-xl bg-success px-5 py-3 font-bold text-on-accent">Done</button>
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
