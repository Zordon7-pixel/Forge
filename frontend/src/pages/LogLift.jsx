import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import ExercisePickerModal from '../components/ExercisePickerModal'

const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core']

export default function LogLift() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showExercisePicker, setShowExercisePicker] = useState(false)
  const [selectedExercise, setSelectedExercise] = useState(null)

  const selectedMuscleGroup = selected[0] || ''

  const toggle = (g) => setSelected(prev => {
    const next = prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]
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
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Select the muscle groups you're targeting today</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {MUSCLE_GROUPS.map(group => (
          <button
            key={group}
            onClick={() => toggle(group)}
            className="rounded-2xl border py-4 text-base capitalize font-semibold transition-all"
            style={selected.includes(group)
              ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'black' }
              : { background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
          >
            {group}
          </button>
        ))}
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
        disabled={loading}
        className="w-full rounded-2xl py-4 text-lg font-bold disabled:opacity-60 transition-all"
        style={{ background: 'var(--accent)', color: 'black' }}
      >
        {loading ? 'Starting...' : 'Begin Workout'}
      </button>
    </div>
  )
}
