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


  const generateManualWorkout = async () => {
    if (!selectedMuscleGroup || !selectedExercise?.name) return
    setManualAiLoading(true)
    setManualAiError('')
    try {
      const r = await api.post('/ai/workout', { bodyPart: selectedMuscleGroup, exercise: selectedExercise.name })
      setManualAiPlan(r.data?.recommendation || null)
    } catch (err) {
      setManualAiError(err?.response?.data?.error || 'Could not generate AI workout')
    } finally {
      setManualAiLoading(false)
    }
  }

  const acceptManualAiWorkout = async () => {
    if (!manualAiPlan) return
    setLoading(true)
    setError('')
    try {
      const muscleGroups = [selectedMuscleGroup || 'full']
      const res = await api.post('/workouts/start', { muscle_groups: muscleGroups, exercise_name: selectedExercise?.name || '' })
      navigate(`/workout/active/${res.data.session.id}`, {
        state: { exercises: manualAiPlan?.main || [], workoutName: manualAiPlan?.workoutName || '' }
      })
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not start workout. Try again.')
      setLoading(false)
    }
  }

  const pretty = (v='') => String(v).replace(/_/g, ' ').replace(/\w/g, c => c.toUpperCase())
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
  const [activeTab, setActiveTab] = useState('ai')
  const [aiRecommendation, setAiRecommendation] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState(null)
  const [exerciseInput, setExerciseInput] = useState('')
  const [manualAiPlan, setManualAiPlan] = useState(null)
  const [manualAiLoading, setManualAiLoading] = useState(false)
  const [manualAiError, setManualAiError] = useState('')

  useEffect(() => {
    api.get('/auth/me').then(res => {
      setUserSex(res.data.user?.sex || 'male')
    }).catch(() => {})
  }, [])

  const selectedMuscleGroup = selected[0] || ''

  useEffect(() => {
    setAiLoading(true)
    setAiError(null)
    api.get('/ai/workout-recommendation?date=today').then((r) => {
      setAiRecommendation(r.data?.recommendation || null)
    }).catch((err) => {
      console.error('Failed to fetch AI recommendation:', err)
      setAiError('Could not generate recommendation')
      setAiRecommendation(null)
    }).finally(() => setAiLoading(false))
  }, [])



  const toggle = (key) => setSelected(prev => {
    const next = prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key]
    const nextPrimary = next[0] || ''
    if (selectedExercise && selectedExercise.muscle_group !== nextPrimary) {
      setSelectedExercise(null)
      setExerciseInput('')
    }
    return next
  })

  const beginAI = async () => {
    setLoading(true)
    setError('')
    try {
      const targetStr = aiRecommendation?.target || ''
      const muscleGroups = targetStr.split(/[,\/\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
      const res = await api.post('/workouts/start', { muscle_groups: muscleGroups.length ? muscleGroups : ['full'] })
      navigate(`/workout/active/${res.data.session.id}`, {
        state: {
          exercises: aiRecommendation?.main || [],
          workoutName: aiRecommendation?.workoutName || ''
        }
      })
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not start workout. Try again.')
      setLoading(false)
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
      setError(err?.response?.data?.error || 'Could not start workout. Try again.')
      setLoading(false)
    }
  }

  const generateManualWorkout = async () => {
    if (!selectedMuscleGroup || !selectedExercise?.name) return
    setManualAiLoading(true)
    setManualAiError('')
    try {
      const r = await api.post('/ai/workout', { bodyPart: selectedMuscleGroup, exercise: selectedExercise.name })
      setManualAiPlan(r.data?.recommendation || null)
    } catch (err) {
      setManualAiError(err?.response?.data?.error || 'Could not generate AI workout')
    } finally {
      setManualAiLoading(false)
    }
  }

  const acceptManualAiWorkout = async () => {
    if (!manualAiPlan) return
    setLoading(true)
    setError('')
    try {
      const muscleGroups = [selectedMuscleGroup || 'full']
      const res = await api.post('/workouts/start', { muscle_groups: muscleGroups, exercise_name: selectedExercise?.name || '' })
      navigate(`/workout/active/${res.data.session.id}`, {
        state: { exercises: manualAiPlan?.main || [], workoutName: manualAiPlan?.workoutName || '' }
      })
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not start workout. Try again.')
      setLoading(false)
    }
  }

  const pretty = (v = '') => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

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

      {activeTab === 'ai' && (
        <>
          {aiLoading && (
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
              <p className="text-sm">Generating your personalized workout...</p>
            </div>
          )}
          {aiError && (
            <div className="rounded-2xl p-4" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
              <p className="text-sm">{aiError}</p>
            </div>
          )}
          {!aiLoading && !aiRecommendation && !aiError && (
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
              <p className="text-sm">No recommendation available yet. Check back later.</p>
            </div>
          )}
          {aiRecommendation && (
            <div className="rounded-2xl p-4" style={{
              background: '#F5F0E8', color: '#1a1a2e', border: '1px solid #d6c9a0', position: 'relative',
              fontFamily: 'Caveat, cursive',
              backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0 27px, rgba(26,26,46,0.12) 27px 28px)'
            }}>
              <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 11, fontWeight: 700, border: '1px solid #1a1a2e66', borderRadius: 999, padding: '2px 8px' }}>FORGE</div>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 14, background: 'linear-gradient(135deg, #eadfcd 25%, transparent 25%) 0 0/12px 12px, linear-gradient(225deg, #eadfcd 25%, transparent 25%) 6px 0/12px 12px' }} />
              <p className="text-lg font-bold">{aiRecommendation.workoutName} — {pretty(aiRecommendation.target)}</p>
              <p className="text-sm mt-2"><strong>Warmup:</strong> {(aiRecommendation.warmup || []).join(', ')}</p>
              <p className="text-sm mt-2"><strong>Main:</strong> {(aiRecommendation.main || []).map((m) => `${m.name} ${m.sets}x${m.reps} (${m.rest})`).join(' • ')}</p>
              <p className="text-sm mt-2"><strong>Recovery:</strong> {(aiRecommendation.recovery || []).join(', ')}</p>
              <p className="text-sm mt-2">{aiRecommendation.explanation}</p>
              <p className="text-xs mt-1">{aiRecommendation.restExplanation}</p>
              <button
                onClick={beginAI}
                disabled={loading}
                className="mt-3 w-full rounded-2xl py-4 text-base font-bold"
                style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer', opacity: loading ? 0.6 : 1, fontFamily: 'inherit' }}
              >
                {loading ? 'Starting...' : 'Start Workout'}
              </button>
            </div>
          )}
        </>
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
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Exercise</p>
            <input
              value={exerciseInput}
              onChange={(e) => { setExerciseInput(e.target.value); setSelectedExercise(e.target.value ? { name: e.target.value, muscle_group: selectedMuscleGroup } : null) }}
              placeholder="e.g. Incline Dumbbell Press"
              className="w-full mt-1 rounded-xl px-3 py-2"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            />
          </div>
          {selectedExercise && <p className="text-sm" style={{ color: 'var(--text-primary)' }}>Exercise: {selectedExercise.name}</p>}
          {liftPlan && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{liftPlan.workoutName} · Estimated: {liftPlan.estimatedTime}</p>}
          {selectedMuscleGroup && selectedExercise?.name && (
            <button type="button" onClick={generateManualWorkout} disabled={manualAiLoading} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: '#EAB308', color: '#000', border: 'none' }}>
              {manualAiLoading ? 'Generating...' : `Generate AI Workout for ${pretty(selectedMuscleGroup)}`}
            </button>
          )}
          {manualAiError && <p className="text-xs" style={{ color: '#ef4444' }}>{manualAiError}</p>}
          {manualAiPlan && (
            <div className="rounded-2xl p-4" style={{
              background: '#F5F0E8', color: '#1a1a2e', border: '1px solid #d6c9a0', position: 'relative', fontFamily: 'Caveat, cursive',
              backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0 27px, rgba(26,26,46,0.12) 27px 28px)'
            }}>
              <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 11, fontWeight: 700, border: '1px solid #1a1a2e66', borderRadius: 999, padding: '2px 8px' }}>FORGE</div>
              <p className="text-lg font-bold">{manualAiPlan.workoutName}</p>
              <p className="text-sm mt-2"><strong>Main:</strong> {(manualAiPlan.main || []).map((m) => `${m.name} ${m.sets}x${m.reps} (${m.rest})`).join(' • ')}</p>
              <div className="flex gap-2 mt-3">
                <button type="button" onClick={acceptManualAiWorkout} className="flex-1 rounded-xl py-2 font-bold" style={{ background: 'var(--accent)', color: '#000', border: 'none', fontFamily: 'inherit' }}>Accept Workout</button>
                <button type="button" onClick={generateManualWorkout} className="flex-1 rounded-xl py-2 font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontFamily: 'inherit' }}>Regenerate</button>
              </div>
            </div>
          )}
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
