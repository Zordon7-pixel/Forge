import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { postRunStretches, preRunStretches } from '../data/stretches'

// Animated stick figure component
function StretchFigure({ stretchName, active }) {
  const getAnimType = (name) => {
    const lower = name.toLowerCase()
    if (lower.includes('hip') || lower.includes('lunge')) return 'hip'
    if (lower.includes('quad')) return 'quad'
    if (lower.includes('hamstring')) return 'hamstring'
    if (lower.includes('calf')) return 'calf'
    if (lower.includes('shoulder') || lower.includes('arm') || lower.includes('cross')) return 'shoulder'
    if (lower.includes('neck')) return 'neck'
    if (lower.includes('glute') || lower.includes('pigeon')) return 'glute'
    if (lower.includes('back') || lower.includes('cat') || lower.includes('spine')) return 'back'
    if (lower.includes('ankle') || lower.includes('roll')) return 'ankle'
    return 'sway'
  }

  const animType = getAnimType(stretchName)

  return (
    <>
      <style>{`
        @keyframes hip-body { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(12deg); transform-origin: 50px 25px; } }
        @keyframes hip-lleg { 0%,100% { transform: translateX(0); } 50% { transform: translateX(-8px); } }
        @keyframes hip-rleg { 0%,100% { transform: translateX(0); } 50% { transform: translateX(8px); } }
        
        @keyframes quad-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-35deg); transform-origin: 50px 75px; } }
        @keyframes quad-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(0deg); } }
        
        @keyframes hamstring-body { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(18deg); transform-origin: 50px 25px; } }
        @keyframes hamstring-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(0deg); } }
        @keyframes hamstring-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(0deg); } }
        
        @keyframes calf-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(15deg); transform-origin: 50px 75px; } }
        @keyframes calf-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-15deg); transform-origin: 50px 75px; } }
        
        @keyframes shoulder-larm { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-40deg); transform-origin: 50px 40px; } }
        @keyframes shoulder-rarm { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-40deg); transform-origin: 50px 40px; } }
        
        @keyframes neck-head { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(15deg); } 75% { transform: rotate(-15deg); } }
        
        @keyframes glute-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(45deg); transform-origin: 50px 75px; } }
        @keyframes glute-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-10deg); transform-origin: 50px 75px; } }
        
        @keyframes back-body { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-15deg); transform-origin: 50px 40px; } }
        
        @keyframes ankle-lleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(12deg); transform-origin: 30px 115px; } }
        @keyframes ankle-rleg { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-12deg); transform-origin: 70px 115px; } }
        
        @keyframes sway-body { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(5deg); transform-origin: 50px 25px; } }
        @keyframes sway-larm { 0%,100% { transform: translateY(0); } 50% { transform: translateY(3px); } }
        @keyframes sway-rarm { 0%,100% { transform: translateY(0); } 50% { transform: translateY(3px); } }
        
        .animate-hip-body { animation: hip-body 2.5s ease-in-out infinite; }
        .animate-hip-lleg { animation: hip-lleg 2.5s ease-in-out infinite; }
        .animate-hip-rleg { animation: hip-rleg 2.5s ease-in-out infinite; }
        
        .animate-quad-lleg { animation: quad-lleg 2.5s ease-in-out infinite; }
        .animate-quad-rleg { animation: quad-rleg 2.5s ease-in-out infinite; }
        
        .animate-hamstring-body { animation: hamstring-body 2.5s ease-in-out infinite; }
        
        .animate-calf-lleg { animation: calf-lleg 2.5s ease-in-out infinite; }
        .animate-calf-rleg { animation: calf-rleg 2.5s ease-in-out infinite; }
        
        .animate-shoulder-larm { animation: shoulder-larm 2.5s ease-in-out infinite; }
        .animate-shoulder-rarm { animation: shoulder-rarm 2.5s ease-in-out infinite; }
        
        .animate-neck-head { animation: neck-head 3s ease-in-out infinite; }
        
        .animate-glute-lleg { animation: glute-lleg 2.5s ease-in-out infinite; }
        .animate-glute-rleg { animation: glute-rleg 2.5s ease-in-out infinite; }
        
        .animate-back-body { animation: back-body 2.5s ease-in-out infinite; }
        
        .animate-ankle-lleg { animation: ankle-lleg 2.5s ease-in-out infinite; }
        .animate-ankle-rleg { animation: ankle-rleg 2.5s ease-in-out infinite; }
        
        .animate-sway-body { animation: sway-body 3s ease-in-out infinite; }
        .animate-sway-larm { animation: sway-larm 3s ease-in-out infinite; }
        .animate-sway-rarm { animation: sway-rarm 3s ease-in-out infinite; }
      `}</style>
      
      <div style={{ width: 160, height: 200, margin: '0 auto' }}>
        <svg viewBox="0 0 100 140" style={{ width: '100%', height: '100%' }}>
          {/* Head */}
          <circle 
            cx="50" 
            cy="15" 
            r="10" 
            fill="none" 
            stroke="#EAB308" 
            strokeWidth="2.5"
            className={active && animType === 'neck' ? `animate-neck-head` : ''}
          />
          
          {/* Body */}
          <line 
            x1="50" 
            y1="25" 
            x2="50" 
            y2="75" 
            stroke="#6b7280" 
            strokeWidth="2.5"
            className={active ? `animate-${animType}-body` : ''}
            style={{ transformOrigin: '50px 25px' }}
          />
          
          {/* Left Arm */}
          <line 
            x1="50" 
            y1="40" 
            x2="25" 
            y2="60" 
            stroke="#6b7280" 
            strokeWidth="2.5"
            className={active ? `animate-${animType}-larm` : ''}
            style={{ transformOrigin: '50px 40px' }}
          />
          
          {/* Right Arm */}
          <line 
            x1="50" 
            y1="40" 
            x2="75" 
            y2="60" 
            stroke="#6b7280" 
            strokeWidth="2.5"
            className={active ? `animate-${animType}-rarm` : ''}
            style={{ transformOrigin: '50px 40px' }}
          />
          
          {/* Left Leg */}
          <line 
            x1="50" 
            y1="75" 
            x2="30" 
            y2="115" 
            stroke="#6b7280" 
            strokeWidth="2.5"
            className={active ? `animate-${animType}-lleg` : ''}
            style={{ transformOrigin: '50px 75px' }}
          />
          
          {/* Right Leg */}
          <line 
            x1="50" 
            y1="75" 
            x2="70" 
            y2="115" 
            stroke="#6b7280" 
            strokeWidth="2.5"
            className={active ? `animate-${animType}-rleg` : ''}
            style={{ transformOrigin: '50px 75px' }}
          />
        </svg>
      </div>
    </>
  )
}

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

  useEffect(() => {
    setCurrent(0)
    setSecondsLeft(stretches[0].duration)
    setPaused(false)
    setTransitioning(false)
    setNextName('')
    setDone(false)
  }, [stretches])

  useEffect(() => {
    if (paused || transitioning || done) return

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
  }, [paused, transitioning, done, current, stretches])

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

  return (
    <div className="bg-[#0f1117] min-h-screen text-white rounded-2xl">
      <div className="mx-auto flex min-h-screen max-w-[480px] flex-col p-4">
        <div className="mb-4 h-2 w-full rounded-full bg-[#1f2433]">
          <div className="h-2 rounded-full bg-yellow-500 transition-all" style={{ width: `${done ? 100 : progress}%` }} />
        </div>

        <header className="mb-6 flex items-center justify-between">
          <button onClick={() => navigate(-1)} className="text-slate-300">← Back</button>
          <div className="text-center">
            <h1 className="text-lg font-bold">{isPre ? 'Pre-Run Warmup' : 'Post-Run Recovery'}</h1>
            <p className="text-xs text-slate-400">{Math.min(current + 1, stretches.length)} / {stretches.length}</p>
          </div>
          <div className="w-12" />
        </header>

        {transitioning ? (
          <div className="my-auto rounded-2xl border border-[#2a2d3e] bg-[#151823] p-8 text-center">
            <p className="text-sm text-slate-400">Next up:</p>
            <p className="mt-2 text-2xl font-black text-yellow-500">{nextName}</p>
          </div>
        ) : done ? (
          <div className="my-auto rounded-2xl border border-emerald-600 bg-[#151823] p-8 text-center">
            <p className="text-3xl font-black text-emerald-400">Session Complete — Done</p>
            <p className="mt-2 text-sm text-slate-300">
              {isPre ? 'You are warmed up with dynamic movement only. Ready to run strong.' : 'Recovery complete. Hold static stretches after each run to reduce tightness.'}
            </p>
            <button
              onClick={() => navigate('/log-run')}
              className="mt-5 rounded-xl bg-yellow-500 px-5 py-3 font-bold text-black"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-[#2a2d3e] bg-[#151823] p-5">
              <span className="rounded-full bg-slate-700 px-2 py-1 text-xs text-slate-200">{currentStretch.muscle}</span>
              <h2 className="mt-3 text-3xl font-black text-white">{currentStretch.name}</h2>
              <p className="mt-3 text-sm text-slate-400">{currentStretch.cue}</p>
              <p className="mt-3 text-sm font-semibold text-slate-300">{currentStretch.reps}</p>

              <button
                onClick={() => window.open(currentStretch.videoUrl, '_blank', 'noopener,noreferrer')}
                className="mt-4 border border-[#2a2d3e] text-slate-300 rounded-lg px-4 py-2 text-sm flex items-center gap-2"
              >
                ▶ Watch How
              </button>
            </div>

            <div className="my-8 text-center">
              <p className="text-7xl font-black text-yellow-500">{secondsLeft}</p>
              <div className="mt-3 flex items-center justify-center gap-4">
                <button onClick={() => setPaused(prev => !prev)} className="rounded-lg border border-[#2a2d3e] px-3 py-1 text-xs text-slate-300">
                  {paused ? 'Resume' : 'Pause'}
                </button>
                <button onClick={skipToNext} className="text-xs text-slate-400 underline">Skip</button>
              </div>
            </div>

            <footer className="mt-auto pb-4 text-center">
              {current === stretches.length - 1 ? (
                <button onClick={() => setDone(true)} className="rounded-xl bg-emerald-500 px-5 py-3 font-bold text-black">Done</button>
              ) : (
                <p className="text-sm text-slate-400">Up next: {nextStretch?.name} →</p>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
