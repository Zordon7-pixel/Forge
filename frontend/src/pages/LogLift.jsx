import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Accessibility, ChevronRight, Flame, History } from 'lucide-react'
import api from '../lib/api'
import track from '../lib/track'
import { queueRequest } from '../lib/offlineQueue'
import { getVolumeLoad, getProgressiveOverloadTip } from '../lib/athleteLanguage'
import StrengthWorkoutRecommendation from '../components/StrengthWorkoutRecommendation'
import WatchWorkoutService from '../services/WatchWorkoutService'
import { fetchDailyExecution, scheduledLiftFromExecution, planSessionIdFromState, currentWeekFromState, localDateISO } from '../lib/dailyExecution'
import { getLiftMobilityPool, inferLiftFocus } from '../data/liftMobility'
import { chooseRotatingRoutine } from '../lib/routineRotation'

const MUSCLE_GROUPS = [
  { key: 'chest', label: 'Chest' },
  { key: 'back', label: 'Back' },
  { key: 'legs', label: 'Legs' },
  { key: 'shoulders', label: 'Shoulders' },
  { key: 'arms', label: 'Arms' },
  { key: 'core', label: 'Core' },
]

const BODY_GRAY = '#374151'
const BODY_ACCENT = 'var(--accent)'

function muscleGroupsFromTarget(target = '') {
  const value = String(target).toLowerCase()
  const groups = MUSCLE_GROUPS
    .filter(({ key }) => value.includes(key))
    .map(({ key }) => key)
  if (/lower body|glute|quad|hamstring|calf/.test(value) && !groups.includes('legs')) groups.push('legs')
  if (/upper body/.test(value)) groups.push(...['chest', 'back', 'shoulders', 'arms'].filter((key) => !groups.includes(key)))
  return groups.length ? groups : ['full']
}

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
  // H5: calendar scheduled lift is the primary path; AI/manual are secondary.
  const location = useLocation()
  const incomingScheduledLift = location.state?.scheduledLift || null
  const [scheduledLift, setScheduledLift] = useState(incomingScheduledLift)
  const [planSessionId, setPlanSessionId] = useState(() => planSessionIdFromState(location.state))
  const [planCurrentWeek, setPlanCurrentWeek] = useState(() => currentWeekFromState(location.state))
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedExercise, setSelectedExercise] = useState(null)
  const [userSex, setUserSex] = useState('male')
  const [timeAvailable, setTimeAvailable] = useState('')
  const [liftPlan, setLiftPlan] = useState(null)
  const [activeTab, setActiveTab] = useState(incomingScheduledLift ? 'scheduled' : 'ai')
  const [aiRecommendation, setAiRecommendation] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState(null)
  const [exerciseInput, setExerciseInput] = useState('')
  const [manualAiPlan, setManualAiPlan] = useState(null)
  const [manualAiLoading, setManualAiLoading] = useState(false)
  const [manualAiError, setManualAiError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [recentLifts, setRecentLifts] = useState([])

  useEffect(() => {
    api.get('/auth/me').then(res => {
      setUserSex(res.data.user?.sex || 'male')
    }).catch((err) => console.error('[LogLift] profile load failed:', err?.message || err))
  }, [])

  useEffect(() => {
    api.get('/lifts')
      .then((res) => setRecentLifts(res.data?.lifts || []))
      .catch(() => setRecentLifts([]))
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

  // H5: source today's lift from the canonical calendar execution. When a
  // scheduled lift exists it becomes the default primary tab; AI/manual remain
  // available. Falls back silently to AI/manual when there is no calendar lift.
  useEffect(() => {
    if (incomingScheduledLift) return undefined
    let active = true
    fetchDailyExecution(localDateISO())
      .then((execution) => {
        if (!active) return
        const lift = scheduledLiftFromExecution(execution)
        if (lift) {
          setScheduledLift(lift)
          setActiveTab('scheduled')
          if (lift.id != null) setPlanSessionId((prev) => prev || String(lift.id))
          if (execution && execution.week != null) {
            setPlanCurrentWeek((prev) => (prev != null ? prev : Number(execution.week)))
          }
        }
      })
      .catch((err) => console.error('[LogLift] scheduled lift lookup failed:', err?.message || err))
    return () => { active = false }
  }, [incomingScheduledLift])



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
    setFeedback('')
    try {
      const muscleGroups = muscleGroupsFromTarget(aiRecommendation?.target)
      const payload = { muscle_groups: muscleGroups }
      if (!navigator.onLine) {
        await queueRequest('/api/workouts/start', 'POST', payload)
        setFeedback('Saved offline — will sync when connected')
        setLoading(false)
        return
      }

      const res = await api.post('/workouts/start', payload)
      track('lift_logged')
      navigate(`/workout/active/${res.data.session.id}`, {
        state: {
          exercises: aiRecommendation?.main || [],
          workoutName: aiRecommendation?.workoutName || '',
          warmup: aiRecommendation?.warmup || [],
        }
      })
    } catch (err) {
      if (!err?.response) {
        await queueRequest('/api/workouts/start', 'POST', { muscle_groups: muscleGroupsFromTarget(aiRecommendation?.target) })
        setFeedback('Saved offline — will sync when connected')
        setError('')
        return
      }
      setError(err?.response?.data?.error || 'Could not start workout. Try again.')
    } finally {
      setLoading(false)
    }
  }

  // H5: start the scheduled calendar lift. Carries planSessionId + currentWeek
  // so ActiveWorkout marks the exact plan session complete on a successful end.
  const beginScheduled = async () => {
    if (!scheduledLiftPlan) return
    setLoading(true)
    setError('')
    setFeedback('')
    const muscleGroups = muscleGroupsFromTarget(scheduledLiftPlan.target)
    const payload = { muscle_groups: muscleGroups }
    try {
      if (!navigator.onLine) {
        await queueRequest('/api/workouts/start', 'POST', payload)
        setFeedback('Saved offline — will sync when connected')
        setLoading(false)
        return
      }
      const res = await api.post('/workouts/start', payload)
      track('lift_logged')
      navigate(`/workout/active/${res.data.session.id}`, {
        state: {
          exercises: scheduledLiftPlan.main || [],
          workoutName: scheduledLiftPlan.workoutName || '',
          warmup: scheduledLiftPlan.warmup || [],
          planSessionId,
          currentWeek: planCurrentWeek,
        }
      })
    } catch (err) {
      if (!err?.response) {
        await queueRequest('/api/workouts/start', 'POST', payload)
        setFeedback('Saved offline — will sync when connected')
        setError('')
        return
      }
      setError(err?.response?.data?.error || 'Could not start workout. Try again.')
    } finally {
      setLoading(false)
    }
  }

  const begin = async () => {
    setLoading(true)
    setError('')
    setFeedback('')
    try {
      const payload = {
        muscle_groups: selected,
        exercise_name: selectedExercise?.name || ''
      }
      if (!navigator.onLine) {
        await queueRequest('/api/workouts/start', 'POST', payload)
        setFeedback('Saved offline — will sync when connected')
        return
      }

      const res = await api.post('/workouts/start', payload)
      track('lift_logged')
      navigate(`/workout/active/${res.data.session.id}`)
    } catch (err) {
      if (!err?.response) {
        await queueRequest('/api/workouts/start', 'POST', {
          muscle_groups: selected,
          exercise_name: selectedExercise?.name || ''
        })
        setFeedback('Saved offline — will sync when connected')
        setError('')
        return
      }
      setError(err?.response?.data?.error || 'Could not start workout. Try again.')
    } finally {
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
    setFeedback('')
    try {
      const muscleGroups = [selectedMuscleGroup || 'full']
      const payload = { muscle_groups: muscleGroups, exercise_name: selectedExercise?.name || '' }
      if (!navigator.onLine) {
        await queueRequest('/api/workouts/start', 'POST', payload)
        setFeedback('Saved offline — will sync when connected')
        return
      }

      const res = await api.post('/workouts/start', payload)
      track('lift_logged')
      navigate(`/workout/active/${res.data.session.id}`, {
        state: {
          exercises: manualAiPlan?.main || [],
          workoutName: manualAiPlan?.workoutName || '',
          warmup: manualAiPlan?.warmup || [],
        }
      })
    } catch (err) {
      if (!err?.response) {
        const muscleGroups = [selectedMuscleGroup || 'full']
        await queueRequest('/api/workouts/start', 'POST', { muscle_groups: muscleGroups, exercise_name: selectedExercise?.name || '' })
        setFeedback('Saved offline — will sync when connected')
        setError('')
        return
      }
      setError(err?.response?.data?.error || 'Could not start workout. Try again.')
    } finally {
      setLoading(false)
    }
  }

  const pretty = (v = '') => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const aiRecommendationTitle = useMemo(() => {
    if (!aiRecommendation) return ''
    const prettyTarget = String(aiRecommendation.target || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const pieces = [aiRecommendation.workoutName, prettyTarget].filter(Boolean)
    const seen = new Set()
    const cleaned = []
    pieces
      .flatMap((part) => String(part).split(/[—-]/))
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const key = part.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        cleaned.push(part)
      })
    return cleaned.join(' — ')
  }, [aiRecommendation])
  const latestLift = recentLifts[0] || null
  const previousLift = useMemo(() => {
    if (!latestLift) return null
    return recentLifts.slice(1).find((lift) => lift.exercise_name === latestLift.exercise_name) || recentLifts[1] || null
  }, [latestLift, recentLifts])
  const latestVolume = latestLift ? getVolumeLoad(latestLift.sets, latestLift.reps, latestLift.weight_lbs) : null
  const overloadTip = latestLift
    ? getProgressiveOverloadTip(
        previousLift ? { sets: previousLift.sets, reps: previousLift.reps, weight: previousLift.weight_lbs } : null,
        { sets: latestLift.sets, reps: latestLift.reps, weight: latestLift.weight_lbs }
      )
    : ''
  // H5: normalize the scheduled calendar lift into the plan shape the existing
  // StrengthWorkoutRecommendation + WatchWorkoutService already consume.
  const scheduledLiftPlan = useMemo(() => {
    if (!scheduledLift) return null
    const p = scheduledLift.prescription || scheduledLift
    const main = Array.isArray(scheduledLift.main) ? scheduledLift.main
      : Array.isArray(p.main) ? p.main
      : Array.isArray(p.exercises) ? p.exercises
      : Array.isArray(scheduledLift.exercises) ? scheduledLift.exercises
      : []
    return {
      workoutName: scheduledLift.title || p.title || 'Scheduled Strength',
      target: scheduledLift.focus || p.focus || p.target || '',
      warmup: Array.isArray(p.warmup) ? p.warmup : [],
      main,
      recovery: p.recovery || scheduledLift.recovery || '',
      explanation: p.explanation || p.description || scheduledLift.description || '',
    }
  }, [scheduledLift])
  const scheduledWatchWorkout = useMemo(
    () => scheduledLiftPlan ? WatchWorkoutService.buildStrengthWorkout(scheduledLiftPlan) : null,
    [scheduledLiftPlan]
  )
  const aiWatchWorkout = useMemo(
    () => aiRecommendation ? WatchWorkoutService.buildStrengthWorkout(aiRecommendation) : null,
    [aiRecommendation]
  )
  const manualWatchWorkout = useMemo(
    () => manualAiPlan ? WatchWorkoutService.buildStrengthWorkout(manualAiPlan) : null,
    [manualAiPlan]
  )
  const mobilityPlan = useMemo(() => {
    if (activeTab === 'scheduled' && scheduledLiftPlan) return scheduledLiftPlan
    if (activeTab === 'manual') {
      if (manualAiPlan) return manualAiPlan
      if (liftPlan) return liftPlan
      return {
        workoutName: selectedExercise?.name || (selectedMuscleGroup ? `${pretty(selectedMuscleGroup)} Workout` : 'Full Body Strength'),
        target: selectedMuscleGroup || 'full body',
        main: selectedExercise ? [{ name: selectedExercise.name, muscle_group: selectedMuscleGroup }] : [],
      }
    }
    return aiRecommendation || scheduledLiftPlan || { workoutName: 'Full Body Strength', target: 'full body', main: [] }
  }, [activeTab, aiRecommendation, liftPlan, manualAiPlan, scheduledLiftPlan, selectedExercise, selectedMuscleGroup])
  const mobilityFocus = inferLiftFocus(mobilityPlan)
  const mobilityLabel = mobilityPlan?.workoutName || `${pretty(mobilityFocus)} Strength`

  const launchLiftMobility = (phase) => {
    const pool = getLiftMobilityPool(mobilityPlan, phase)
    const rotationScope = `lift-mobility:${phase}:${mobilityFocus}`
    const routine = chooseRotatingRoutine(rotationScope, pool, 6)
    navigate('/stretches/session', {
      state: {
        context: 'lift',
        phase,
        routine,
        rotationScope,
        workoutName: mobilityLabel,
      },
    })
  }

  return (
    <div className="space-y-4 py-2 pb-16">
      <div>
        <h2 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Start Workout</h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Select the muscle groups you are targeting today</p>
      </div>

      {latestLift && latestVolume && (
        <details className="rounded-2xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
          <summary className="pressable flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <span className="block text-[10px] font-black uppercase" style={{ color: 'var(--text-muted)' }}>Last logged lift</span>
              <span className="mt-1 block truncate text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{latestLift.exercise_name || 'Lift'}</span>
              <span className="mt-0.5 block text-xs" style={{ color: 'var(--text-muted)' }}>{latestLift.sets} x {latestLift.reps} @ {latestLift.weight_lbs} lbs</span>
            </span>
            <ChevronRight size={18} color="var(--text-muted)" className="shrink-0" />
          </summary>
          <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
              Volume: {latestVolume.totalLbs.toLocaleString()} lbs - {latestVolume.label} effort
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{overloadTip}</p>
          </div>
        </details>
      )}

      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${scheduledLiftPlan ? 3 : 2}, minmax(0, 1fr))` }}>
        {[...(scheduledLiftPlan ? ['scheduled'] : []), 'manual', 'ai'].map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} className="min-h-11 rounded-lg px-2 py-2 text-xs font-bold leading-tight" style={{ background: activeTab===t ? 'var(--accent)' : 'var(--bg-input)', color: activeTab===t ? '#000' : 'var(--text-muted)' }}>{t === 'scheduled' ? 'From your plan' : t === 'manual' ? 'Manual' : 'AI Recommends'}</button>
        ))}
      </div>

      {activeTab === 'scheduled' && scheduledLiftPlan && (
        <StrengthWorkoutRecommendation
          plan={scheduledLiftPlan}
          title={scheduledLiftPlan.workoutName || 'Scheduled Strength'}
          onStart={beginScheduled}
          startBusy={loading}
          watchWorkout={scheduledWatchWorkout}
        />
      )}

      {activeTab === 'ai' && (
        <>
          {aiLoading && (
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
              <p className="text-sm">Generating your personalized workout...</p>
            </div>
          )}
          {aiError && (
            <div className="rounded-2xl p-4" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.3)' }}>
              <p className="text-sm">{aiError}</p>
            </div>
          )}
          {!aiLoading && !aiRecommendation && !aiError && (
            <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
              <p className="text-sm">No recommendation available yet. Check back later.</p>
            </div>
          )}
          {aiRecommendation && (
            <StrengthWorkoutRecommendation
              plan={aiRecommendation}
              title={aiRecommendationTitle}
              onStart={beginAI}
              startBusy={loading}
              watchWorkout={aiWatchWorkout}
            />
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
                background: isSelected ? 'var(--accent-dim)' : 'var(--bg-card)',
                border: `2px solid ${isSelected ? BODY_ACCENT : 'var(--border-subtle)'}`,
                minHeight: 110,
                boxShadow: isSelected ? '0 0 10px var(--border-subtle)' : 'none',
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
                background: isSelected ? 'var(--accent-dim)' : 'var(--bg-card)',
                border: `2px solid ${isSelected ? BODY_ACCENT : 'var(--border-subtle)'}`,
                minHeight: 72,
                boxShadow: isSelected ? '0 0 10px var(--border-subtle)' : 'none',
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
                const r = await api.post('/ai/lift-plan', { bodyPart: selectedMuscleGroup, timeAvailable: t }).catch(() => null)
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
            <button type="button" onClick={generateManualWorkout} disabled={manualAiLoading} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}>
              {manualAiLoading ? 'Generating...' : `Generate AI Workout for ${pretty(selectedMuscleGroup)}`}
            </button>
          )}
          {manualAiError && <p className="text-xs" style={{ color: 'var(--danger)' }}>{manualAiError}</p>}
          {manualAiPlan && (
            <StrengthWorkoutRecommendation
              plan={manualAiPlan}
              title={manualAiPlan.workoutName}
              onStart={acceptManualAiWorkout}
              startLabel="Accept and Start"
              startBusy={loading}
              onRegenerate={generateManualWorkout}
              watchWorkout={manualWatchWorkout}
            />
          )}
        </div>
      )}

      {error && <p className="text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}
      {feedback && <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{feedback}</p>}

      <button
        onClick={begin}
        disabled={loading || selected.length === 0}
        className="w-full rounded-2xl py-4 text-lg font-bold disabled:opacity-60 transition-all"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
      >
        {loading ? 'Starting...' : 'Begin Workout'}
      </button>
      </>
      )}

      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.8 }}>Quick Actions</p>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Prepared for {mobilityLabel}</p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button type="button" onClick={() => launchLiftMobility('warmup')} className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-xl border-0 px-1.5 py-2 text-center text-xs font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
            <Flame size={19} color="var(--accent)" />
            <span>Lift Warm-Up</span>
          </button>
          <button type="button" onClick={() => launchLiftMobility('recovery')} className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-xl border-0 px-1.5 py-2 text-center text-xs font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
            <Accessibility size={19} color="var(--accent)" />
            <span>Post-Lift Stretch</span>
          </button>
          <button type="button" onClick={() => navigate('/history')} className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-xl border-0 px-1.5 py-2 text-center text-xs font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
            <History size={19} color="var(--accent)" />
            <span>Lift History</span>
          </button>
        </div>
      </section>
    </div>
  )
}
