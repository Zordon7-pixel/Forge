import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'

const MUSCLE_GROUPS = [
  { key: 'chest', label: 'Chest' },
  { key: 'back', label: 'Back' },
  { key: 'legs', label: 'Legs' },
  { key: 'shoulders', label: 'Shoulders' },
  { key: 'arms', label: 'Arms' },
  { key: 'core', label: 'Core' },
]

const BODY_GRAY = '#374151'
const BODY_ACCENT = '#EAB308'

function BodySVG({ highlight, sex = 'male' }) {
  const hi = (part) => highlight === 'full' || highlight === part ? BODY_ACCENT : BODY_GRAY
  const isFemale = sex === 'female'

  return (
    <svg viewBox="0 0 60 90" width="52" height="78" xmlns="http://www.w3.org/2000/svg">
      {/* Head */}
      <circle cx="30" cy="9" r="8" fill={BODY_GRAY} />
      {/* Neck */}
      <rect x="27" y="17" width="6" height="5" fill={BODY_GRAY} />
      {/* Left arm */}
      <rect x={isFemale ? 9 : 7} y="20" width="9" height="24" rx="4" fill={hi('arms')} />
      {/* Right arm */}
      <rect x={isFemale ? 42 : 44} y="20" width="9" height="24" rx="4" fill={hi('arms')} />
      {/* Torso base */}
      <rect x="16" y="20" width="28" height="33" rx="4" fill={BODY_GRAY} />
      {/* Female waist curve */}
      {isFemale && (
        <rect x="18" y="34" width="24" height="8" rx="2" fill={BODY_GRAY} />
      )}
      {/* Shoulder highlights */}
      {(highlight === 'shoulders' || highlight === 'full') && (
        <>
          <rect x={isFemale ? 9 : 7} y="20" width="9" height="11" rx="4" fill={BODY_ACCENT} />
          <rect x={isFemale ? 42 : 44} y="20" width="9" height="11" rx="4" fill={BODY_ACCENT} />
          <rect x="15" y="20" width="30" height="8" rx="3" fill={BODY_ACCENT} />
        </>
      )}
      {/* Chest highlight */}
      {(highlight === 'chest' || highlight === 'full') && (
        <rect x="18" y="23" width="24" height="14" rx="3" fill={BODY_ACCENT} />
      )}
      {/* Back highlight (upper trapezius area) */}
      {(highlight === 'back' || highlight === 'full') && (
        <rect x="16" y="22" width="28" height="13" rx="3" fill={BODY_ACCENT} />
      )}
      {/* Core highlight */}
      {(highlight === 'core' || highlight === 'full') && (
        <rect x="18" y="37" width="24" height="14" rx="3" fill={BODY_ACCENT} />
      )}
      {/* Left leg */}
      <rect x={isFemale ? 15 : 17} y="53" width={isFemale ? 13 : 11} height="33" rx="4" fill={hi('legs')} />
      {/* Right leg */}
      <rect x={isFemale ? 32 : 32} y="53" width={isFemale ? 13 : 11} height="33" rx="4" fill={hi('legs')} />
    </svg>
  )
}

export default function LogLift() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedExercise, setSelectedExercise] = useState(null)
  const [userSex, setUserSex] = useState('male')
  const [timeAvailable, setTimeAvailable] = useState('')
  const [liftPlan, setLiftPlan] = useState(null)
  const [activeTab, setActiveTab] = useState('manual')
  const [aiRecommendation, setAiRecommendation] = useState(null)
  const [sharedWorkoutId, setSharedWorkoutId] = useState(null)
  const [sharingWorkout, setSharingWorkout] = useState(false)

  useEffect(() => {
    api.get('/auth/me').then(res => {
      setUserSex(res.data.user?.sex || 'male')
    }).catch(() => {})
  }, [])

  const selectedMuscleGroup = selected[0] || ''

  useEffect(() => {
    api.get('/ai/workout-recommendation?date=today').then((r) => setAiRecommendation(r.data?.recommendation || null)).catch(() => {})
  }, [])



  const toggle = (key) => setSelected(prev => {
    const next = prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key]
    const nextPrimary = next[0] || ''
    if (selectedExercise && selectedExercise.muscle_group !== nextPrimary) {
      setSelectedExercise(null)
    }
    return next
  })

  const shareWorkout = async () => {
    if (!aiRecommendation) return
    setSharingWorkout(true)
    try {
      const res = await api.post('/ai/community-share', { workoutData: aiRecommendation })
      setSharedWorkoutId(res.data.id)
    } catch (err) {
      console.error('Failed to share workout:', err)
      setError('Could not share workout. Try again.')
    } finally {
      setSharingWorkout(false)
    }
  }

  const begin = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.post('/workouts/start', {
        muscle_groups: selected,
        exercise_name: selectedExercise?.name || ''
      })
      navigate(`/workout/active/${res.data.session.id}`)
    } catch (err) {
      setError('Could not start workout. Try again.')
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6 py-4">
      <div>
        <h2 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Start Workout</h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Select the muscle groups you are targeting today</p>
      </div>

      <div className="flex gap-2">
        {['manual','ai'].map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} className="rounded-full px-4 py-2 text-xs font-bold" style={{ background: activeTab===t ? 'var(--accent)' : 'var(--bg-input)', color: activeTab===t ? '#000' : 'var(--text-muted)' }}>{t === 'manual' ? 'Manual' : 'AI Recommends'}</button>
        ))}
      </div>

      {activeTab === 'ai' && aiRecommendation && (
        <div className="rounded-2xl p-4" style={{ background: '#f8f2df', color: '#111', border: '1px solid #d6c9a0' }}>
          <p className="text-lg font-bold">{aiRecommendation.workoutName} — {aiRecommendation.target}</p>
          <p className="text-sm mt-2"><strong>Warmup:</strong> {(aiRecommendation.warmup || []).join(', ')}</p>
          <p className="text-sm mt-2"><strong>Main:</strong> {(aiRecommendation.main || []).map((m) => `${m.name} ${m.sets}x${m.reps} (${m.rest})`).join(' • ')}</p>
          <p className="text-sm mt-2"><strong>Recovery:</strong> {(aiRecommendation.recovery || []).join(', ')}</p>
          <p className="text-sm mt-2">{aiRecommendation.explanation}</p>
          <p className="text-xs mt-1">{aiRecommendation.restExplanation}</p>
          <button
            onClick={shareWorkout}
            disabled={sharingWorkout || sharedWorkoutId}
            className="mt-3 w-full rounded-xl py-2 font-semibold text-sm"
            style={{ background: sharedWorkoutId ? 'var(--bg-base)' : 'var(--accent)', color: sharedWorkoutId ? 'var(--text-muted)' : '#000', border: 'none', cursor: sharedWorkoutId ? 'default' : 'pointer', opacity: sharingWorkout ? 0.6 : 1 }}
          >
            {sharingWorkout ? 'Sharing...' : sharedWorkoutId ? 'Shared' : 'Share to Community'}
          </button>
        </div>
      )}

      {activeTab === 'manual' && (
      <>
      {/* 3-column silhouette grid */}
      <div className="grid grid-cols-3 gap-3">
        {MUSCLE_GROUPS.map(({ key, label }) => {
          const isSelected = selected.includes(key)
          return (
            <button
              key={key}
              onClick={() => toggle(key)}
              className="flex flex-col items-center justify-between rounded-2xl py-3 px-2 transition-all"
              style={{
                background: isSelected ? 'rgba(234,179,8,0.08)' : 'var(--bg-card)',
                border: `2px solid ${isSelected ? BODY_ACCENT : 'var(--border-subtle)'}`,
                minHeight: 110,
                boxShadow: isSelected ? '0 0 10px rgba(234,179,8,0.25)' : 'none',
              }}
            >
              <BodySVG highlight={key} sex={userSex} />
              <span
                className="text-xs font-semibold mt-1 capitalize"
                style={{ color: isSelected ? BODY_ACCENT : 'var(--text-muted)' }}
              >
                {label}
              </span>
            </button>
          )
        })}

        {/* Full Body — spans all 3 columns */}
        {(() => {
          const isSelected = selected.includes('full')
          return (
            <button
              onClick={() => toggle('full')}
              className="col-span-3 flex items-center justify-center gap-4 rounded-2xl py-3 px-4 transition-all"
              style={{
                background: isSelected ? 'rgba(234,179,8,0.08)' : 'var(--bg-card)',
                border: `2px solid ${isSelected ? BODY_ACCENT : 'var(--border-subtle)'}`,
                minHeight: 72,
                boxShadow: isSelected ? '0 0 10px rgba(234,179,8,0.25)' : 'none',
              }}
            >
              <BodySVG highlight="full" sex={userSex} />
              <span
                className="text-sm font-bold"
                style={{ color: isSelected ? BODY_ACCENT : 'var(--text-muted)' }}
              >
                Full Body
              </span>
            </button>
          )
        })()}
      </div>

      {selectedMuscleGroup && (
        <div className="space-y-2">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>How much time do you have?</p>
          <div className="flex flex-wrap gap-2">
            {['15','30','45','60','90+'].map((t) => (
              <button key={t} type="button" onClick={async () => {
                setTimeAvailable(t)
                const r = await api.post('/ai/lift-plan', { bodyPart: selectedMuscleGroup, timeAvailable: t, userId: 'me' }).catch(() => null)
                setLiftPlan(r?.data?.plan || null)
              }} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: timeAvailable===t ? 'var(--accent)' : 'var(--bg-input)', color: timeAvailable===t ? '#000' : 'var(--text-muted)' }}>
                {t} min
              </button>
            ))}
          </div>
          {selectedExercise && <p className="text-sm" style={{ color: 'var(--text-primary)' }}>Exercise: {selectedExercise.name}</p>}
          {liftPlan && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{liftPlan.workoutName} · Estimated: {liftPlan.estimatedTime}</p>}
        </div>
      )}

      {error && <p className="text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}

      <button
        onClick={begin}
        disabled={loading || selected.length === 0}
        className="w-full rounded-2xl py-4 text-lg font-bold disabled:opacity-60 transition-all"
        style={{ background: 'var(--accent)', color: 'black' }}
      >
        {loading ? 'Starting...' : 'Begin Workout'}
      </button>
      </>
      )}
    </div>
  )
}
