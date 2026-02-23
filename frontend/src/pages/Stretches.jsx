import { useEffect, useRef, useState } from 'react'
import { MapPin, RefreshCw, X, ChevronRight, Check } from 'lucide-react'
import StretchAnimation from '../components/StretchAnimation'

/* ─── Stretch data ─── */
const STRETCHES = [
  {
    id: 'quad',
    name: 'Quad Stretch',
    duration: 30,
    durationLabel: '30 sec each side',
    cue: 'Stand on one leg and pull your opposite foot toward your glutes. Keep your knees together and stand tall. Use a wall for balance if needed.',
  },
  {
    id: 'hamstring',
    name: 'Hamstring Stretch',
    duration: 30,
    durationLabel: '30 sec each side',
    cue: 'Sit on the ground with one leg extended. Hinge at the hips and reach toward your toes, keeping your back flat. Avoid rounding through the spine.',
  },
  {
    id: 'hip-flexor',
    name: 'Hip Flexor Stretch',
    duration: 30,
    durationLabel: '30 sec each side',
    cue: 'Step into a deep lunge with your front knee at 90 degrees and your back knee near the floor. Shift your hips gently forward until you feel the stretch through the front of your back hip.',
  },
  {
    id: 'calf',
    name: 'Calf Stretch',
    duration: 30,
    durationLabel: '30 sec each side',
    cue: 'Press both hands on a wall and step one foot back with the heel flat on the floor. Lean into the wall until you feel the stretch through the back of your lower leg.',
  },
  {
    id: 'shoulder',
    name: 'Shoulder Stretch',
    duration: 30,
    durationLabel: '30 sec each side',
    cue: 'Bring one arm straight across your chest and hold it just above the elbow with your opposite hand. Gently pull until you feel the stretch across the back of the shoulder.',
  },
  {
    id: 'neck',
    name: 'Neck Tilt',
    duration: 30,
    durationLabel: '30 sec each side',
    cue: 'Sit or stand tall and slowly tilt your ear toward your shoulder. Keep both shoulders relaxed and down. Use a light hand to add a gentle assist if comfortable.',
  },
  {
    id: 'trunk',
    name: 'Trunk Rotation',
    duration: 45,
    durationLabel: '45 sec',
    cue: 'Sit cross-legged on the floor. Rotate your upper body to one side, placing your opposite hand on your outer knee. Keep your spine long and breathe into the twist.',
  },
  {
    id: 'childs-pose',
    name: "Child's Pose",
    duration: 45,
    durationLabel: '45 sec',
    cue: 'Kneel with your toes together and knees wide. Sit back toward your heels and extend your arms forward on the floor. Let your torso melt toward the ground with each exhale.',
  },
]

/* ─── Routines ─── */
const ROUTINES = {
  pre: {
    label: 'Pre-Run Routine',
    icon: MapPin,
    stretches: ['quad', 'hip-flexor', 'calf', 'neck'],
  },
  post: {
    label: 'Post-Run Routine',
    icon: RefreshCw,
    stretches: ['hamstring', 'hip-flexor', 'shoulder', 'trunk', 'childs-pose'],
  },
}

/* ─── Circular countdown ring ─── */
const RING_R = 44
const RING_CIRC = 2 * Math.PI * RING_R

function CountdownRing({ total, remaining }) {
  const pct = remaining / total
  const offset = RING_CIRC * (1 - pct)
  return (
    <svg width="110" height="110" viewBox="0 0 110 110">
      {/* Track */}
      <circle cx="55" cy="55" r={RING_R} fill="none" stroke="#1f2433" strokeWidth="7" />
      {/* Progress */}
      <circle
        cx="55"
        cy="55"
        r={RING_R}
        fill="none"
        stroke="#EAB308"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={RING_CIRC}
        strokeDashoffset={offset}
        style={{ transform: 'rotate(-90deg)', transformOrigin: '55px 55px', transition: 'stroke-dashoffset 1s linear' }}
      />
      {/* Number */}
      <text
        x="55"
        y="55"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#EAB308"
        fontSize="26"
        fontWeight="900"
        fontFamily="system-ui,sans-serif"
      >
        {remaining}
      </text>
    </svg>
  )
}

/* ─── Full-screen modal ─── */
function StretchModal({ stretch, routineStretches, routineIndex, onNext, onDone }) {
  const total = stretch.duration
  const [remaining, setRemaining] = useState(total)
  const [phase, setPhase] = useState('active') // 'active' | 'transition'
  const [transCountdown, setTransCountdown] = useState(3)
  const intervalRef = useRef(null)
  const transRef = useRef(null)

  // Reset whenever the stretch changes
  useEffect(() => {
    setRemaining(total)
    setPhase('active')
    setTransCountdown(3)
  }, [stretch.id, total])

  // Main countdown
  useEffect(() => {
    if (phase !== 'active') return
    intervalRef.current = setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          clearInterval(intervalRef.current)
          const isLast = !routineStretches || routineIndex >= routineStretches.length - 1
          if (isLast) {
            setPhase('done')
          } else {
            setPhase('transition')
          }
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(intervalRef.current)
  }, [phase, routineStretches, routineIndex])

  // Transition countdown (auto-advance)
  useEffect(() => {
    if (phase !== 'transition') return
    setTransCountdown(3)
    let tc = 3
    transRef.current = setInterval(() => {
      tc -= 1
      setTransCountdown(tc)
      if (tc <= 0) {
        clearInterval(transRef.current)
        onNext()
      }
    }, 1000)
    return () => clearInterval(transRef.current)
  }, [phase])

  const inRoutine = routineStretches && routineStretches.length > 1
  const progressLabel = inRoutine ? `${routineIndex + 1} of ${routineStretches.length}` : null
  const nextStretch = inRoutine && routineIndex < routineStretches.length - 1
    ? STRETCHES.find(s => s.id === routineStretches[routineIndex + 1])
    : null

  const handleNext = () => {
    clearInterval(intervalRef.current)
    clearInterval(transRef.current)
    onNext()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0f1117] overflow-y-auto">
      <div className="mx-auto w-full max-w-[480px] flex flex-col min-h-full p-4 pb-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          {progressLabel ? (
            <span className="text-sm font-semibold text-slate-400">{progressLabel}</span>
          ) : <div />}
          <button
            onClick={onDone}
            className="ml-auto p-2 rounded-full bg-[#1c2130] text-slate-400"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Animated character */}
        <div className="flex justify-center mb-4" style={{ height: 250 }}>
          <StretchAnimation stretchId={stretch.id} style={{ height: 250, width: 'auto' }} />
        </div>

        {/* Name */}
        <h2 className="text-2xl font-black text-white text-center mb-3">{stretch.name}</h2>

        {/* Instruction cue */}
        <p className="text-sm text-slate-400 text-center leading-relaxed mb-6 px-2">{stretch.cue}</p>

        {/* Timer ring */}
        {phase === 'active' && (
          <div className="flex flex-col items-center mb-6">
            <CountdownRing total={total} remaining={remaining} />
            <p className="mt-2 text-xs text-slate-500">seconds remaining</p>
          </div>
        )}

        {/* Transition overlay */}
        {phase === 'transition' && nextStretch && (
          <div className="flex flex-col items-center mb-6 rounded-2xl border border-[#2a2d3e] bg-[#151823] p-6 text-center">
            <p className="text-slate-400 text-sm mb-1">Next up in {transCountdown}...</p>
            <p className="text-xl font-black text-yellow-500">{nextStretch.name}</p>
          </div>
        )}

        {/* Done state */}
        {phase === 'done' && (
          <div className="flex flex-col items-center mb-6 rounded-2xl border border-emerald-700 bg-[#0f1a14] p-6 text-center">
            <Check size={32} className="text-emerald-400 mb-2" />
            <p className="text-lg font-black text-emerald-400">
              {inRoutine ? 'Routine Complete' : 'Stretch Complete'}
            </p>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Buttons */}
        <div className="flex gap-3 mt-4">
          <button
            onClick={onDone}
            className="flex-1 rounded-xl border border-[#2a2d3e] py-3 text-sm font-semibold text-slate-300"
          >
            Done
          </button>
          {(phase === 'active' || phase === 'transition') && (
            <button
              onClick={handleNext}
              className="flex-1 rounded-xl bg-yellow-500 py-3 text-sm font-black text-black flex items-center justify-center gap-1"
            >
              {nextStretch ? (
                <>Next <ChevronRight size={16} /></>
              ) : (
                <>Finish <Check size={16} /></>
              )}
            </button>
          )}
          {phase === 'done' && (
            <button
              onClick={onDone}
              className="flex-1 rounded-xl bg-emerald-500 py-3 text-sm font-black text-black flex items-center justify-center gap-1"
            >
              <Check size={16} /> Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Main page ─── */
export default function Stretches() {
  const [modal, setModal] = useState(null)
  // modal: { stretchId, routineIds: string[]|null, routineIndex: number }

  const openStretch = (id) => {
    setModal({ stretchId: id, routineIds: null, routineIndex: 0 })
  }

  const openRoutine = (routineKey) => {
    const ids = ROUTINES[routineKey].stretches
    setModal({ stretchId: ids[0], routineIds: ids, routineIndex: 0 })
  }

  const handleNext = () => {
    if (!modal) return
    const { routineIds, routineIndex } = modal
    if (!routineIds || routineIndex >= routineIds.length - 1) {
      setModal(null)
      return
    }
    const next = routineIndex + 1
    setModal({ stretchId: routineIds[next], routineIds, routineIndex: next })
  }

  const handleDone = () => setModal(null)

  const activeStretch = modal ? STRETCHES.find(s => s.id === modal.stretchId) : null

  return (
    <div className="bg-[#0f1117] min-h-screen rounded-2xl p-4 text-white">
      <header className="mb-5">
        <h1 className="text-2xl font-bold">Stretches</h1>
        <p className="text-sm text-slate-400">Guided stretches — no internet required.</p>
      </header>

      {/* ── Quick-start routines ── */}
      <section className="mb-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">Quick-Start Routines</h2>
        <div className="grid grid-cols-2 gap-3">
          {Object.entries(ROUTINES).map(([key, r]) => {
            const Icon = r.icon
            return (
              <button
                key={key}
                onClick={() => openRoutine(key)}
                className="flex flex-col items-start gap-2 rounded-xl border border-[#2a2d3e] bg-[#151823] p-4 text-left active:bg-[#1c2130] transition"
              >
                <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-yellow-500/10">
                  <Icon size={18} className="text-yellow-500" />
                </div>
                <span className="text-sm font-bold text-white leading-tight">{r.label}</span>
                <span className="text-xs text-slate-500">{r.stretches.length} stretches</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* ── All Stretches grid ── */}
      <section className="mb-24">
        <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">All Stretches</h2>
        <div className="grid grid-cols-2 gap-3">
          {STRETCHES.map(stretch => (
            <button
              key={stretch.id}
              onClick={() => openStretch(stretch.id)}
              className="flex flex-col items-center rounded-xl border border-[#2a2d3e] bg-[#151823] p-3 text-left active:bg-[#1c2130] transition"
            >
              {/* Animated character */}
              <div style={{ width: '100%', height: 150 }}>
                <StretchAnimation stretchId={stretch.id} />
              </div>
              <p className="mt-2 text-sm font-bold text-white text-center">{stretch.name}</p>
              <p className="mt-0.5 text-xs text-slate-500 text-center">{stretch.durationLabel}</p>
            </button>
          ))}
        </div>
      </section>

      {/* ── Modal ── */}
      {modal && activeStretch && (
        <StretchModal
          stretch={activeStretch}
          routineStretches={modal.routineIds}
          routineIndex={modal.routineIndex}
          onNext={handleNext}
          onDone={handleDone}
        />
      )}
    </div>
  )
}
