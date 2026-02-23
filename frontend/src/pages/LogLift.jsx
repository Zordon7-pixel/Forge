import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import ExercisePickerModal from '../components/ExercisePickerModal'

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

function BodySVG({ highlight }) {
  const hi = (part) => highlight === 'full' || highlight === part ? BODY_ACCENT : BODY_GRAY

  return (
    <svg viewBox="0 0 60 90" width="52" height="78" xmlns="http://www.w3.org/2000/svg">
      {/* Head */}
      <circle cx="30" cy="9" r="8" fill={BODY_GRAY} />
      {/* Neck */}
      <rect x="27" y="17" width="6" height="5" fill={BODY_GRAY} />
      {/* Left arm */}
      <rect x="7" y="20" width="9" height="24" rx="4" fill={hi('arms')} />
      {/* Right arm */}
      <rect x="44" y="20" width="9" height="24" rx="4" fill={hi('arms')} />
      {/* Torso base */}
      <rect x="16" y="20" width="28" height="33" rx="4" fill={BODY_GRAY} />
      {/* Shoulder highlights */}
      {(highlight === 'shoulders' || highlight === 'full') && (
        <>
          <rect x="7" y="20" width="9" height="11" rx="4" fill={BODY_ACCENT} />
          <rect x="44" y="20" width="9" height="11" rx="4" fill={BODY_ACCENT} />
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
      <rect x="17" y="53" width="11" height="33" rx="4" fill={hi('legs')} />
      {/* Right leg */}
      <rect x="32" y="53" width="11" height="33" rx="4" fill={hi('legs')} />
    </svg>
  )
}

export default function LogLift() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showExercisePicker, setShowExercisePicker] = useState(false)
  const [selectedExercise, setSelectedExercise] = useState(null)

  const selectedMuscleGroup = selected[0] || ''

  const toggle = (key) => setSelected(prev => {
    const next = prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key]
    const nextPrimary = next[0] || ''
    if (selectedExercise && selectedExercise.muscle_group !== nextPrimary) {
      setSelectedExercise(null)
    }
    return next
  })

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
              <BodySVG highlight={key} />
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
              <BodySVG highlight="full" />
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
        <div>
          <button
            onClick={() => setShowExercisePicker(true)}
            className="w-full mt-2 py-3 px-4 rounded-xl text-sm font-semibold text-left flex items-center justify-between"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
            <span>{selectedExercise ? selectedExercise.name : 'Choose exercise...'}</span>
            <span style={{ color: 'var(--text-muted)' }}>›</span>
          </button>
          {selectedExercise && (
            <p className="text-xs mt-1 px-1" style={{ color: 'var(--text-muted)' }}>
              {selectedExercise.secondary_muscles && `Also targets: ${selectedExercise.secondary_muscles}`}
            </p>
          )}
        </div>
      )}

      {showExercisePicker && (
        <ExercisePickerModal
          muscleGroup={selectedMuscleGroup}
          onSelect={(ex) => { setSelectedExercise(ex); setShowExercisePicker(false) }}
          onClose={() => setShowExercisePicker(false)}
        />
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
    </div>
  )
}
