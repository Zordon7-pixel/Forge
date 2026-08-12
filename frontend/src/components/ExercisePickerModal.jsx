import React, { useEffect, useState } from 'react'
import api from '../lib/api'
import MovementDemo from './MovementDemo'

const AGGREGATE_GROUPS = new Set(['', 'all', 'full', 'full body', 'full-body', 'full_body'])

function exerciseFilterGroup(muscleGroup) {
  const normalized = String(muscleGroup || '').trim().toLowerCase()
  return AGGREGATE_GROUPS.has(normalized) ? '' : normalized
}

export default function ExercisePickerModal({ muscleGroup, onSelect, onClose }) {
  const [exercises, setExercises] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newInstructions, setNewInstructions] = useState('')
  const [howToExercise, setHowToExercise] = useState(null)
  const [addFeedback, setAddFeedback] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [userSex, setUserSex] = useState('')

  useEffect(() => {
    loadExercises()
  }, [muscleGroup])

  useEffect(() => {
    api.get('/auth/me').then((r) => setUserSex(r.data?.user?.sex || '')).catch((error) => {
      console.error('[exercise-picker/profile] lookup failed:', error?.message || error)
    })
  }, [])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
  }, [])

  const closePicker = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    onClose()
  }

  const selectExercise = (exercise) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    onSelect(exercise)
    onClose()
  }

  const loadExercises = async () => {
    setLoading(true)
    try {
      const filterGroup = exerciseFilterGroup(muscleGroup)
      const params = filterGroup ? { muscle_group: filterGroup } : {}
      const res = await api.get('/exercises', { params })
      setExercises(Array.isArray(res.data) ? res.data : [])
    } catch (error) {
      console.error('[exercise-picker/load] failed:', error?.message || error)
      setExercises([])
    } finally {
      setLoading(false)
    }
  }

  const filtered = exercises.filter(e =>
    e.name.toLowerCase().includes(search.toLowerCase())
  )

  const handleAdd = async () => {
    if (!newName.trim()) return
    setAddLoading(true); setAddFeedback('')
    try {
      const res = await api.post('/exercises', {
        name: newName.trim(),
        muscle_group: exerciseFilterGroup(muscleGroup) || 'other',
        instructions: newInstructions.trim()
      })
      if (res.data.alreadyExists) {
        setAddFeedback('Already in the library — found it!')
      } else {
        setAddFeedback('Added to community library!')
      }
      await loadExercises()
      setTimeout(() => {
        setAdding(false); setNewName(''); setNewInstructions(''); setAddFeedback('')
      }, 1200)
    } catch (e) {
      setAddFeedback(e?.response?.data?.error || 'Could not add exercise.')
    } finally {
      setAddLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70"
      style={{ width: '100%', maxWidth: '100vw', overflowX: 'hidden', paddingTop: 'env(safe-area-inset-top, 0px)' }}
      onClick={e => { if (e.target === e.currentTarget) closePicker() }}>
      <div className="w-full max-w-lg rounded-t-2xl flex flex-col max-h-[80vh] relative"
        style={{ background: 'var(--bg-card)', minWidth: 0, maxWidth: 'min(32rem, 100vw)', overflow: 'hidden', overscrollBehavior: 'contain' }}>

        {/* How-to overlay */}
        {howToExercise && (
          <div className="absolute inset-0 z-10 rounded-t-2xl flex flex-col"
            style={{ background: 'var(--bg-card)' }}>
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <h3 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>{howToExercise.name}</h3>
              <button onClick={() => setHowToExercise(null)}
                className="text-sm px-3 py-1 rounded-lg"
                style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Back</button>
            </div>
            <div className="overflow-y-auto p-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className="text-xs px-2 py-1 rounded-full font-medium"
                  style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
                  Primary: {howToExercise.muscle_group}
                </span>
                {howToExercise.secondary_muscles && (
                  <span className="text-xs px-2 py-1 rounded-full font-medium"
                    style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                    Also: {howToExercise.secondary_muscles}
                  </span>
                )}
              </div>
              <MovementDemo name={howToExercise.name} compact sex={userSex} />
              {howToExercise.how_to_image_url && (
                <div className="rounded-xl overflow-hidden">
                  <img src={howToExercise.how_to_image_url} alt={howToExercise.name}
                    className="w-full object-contain max-h-48"
                    onError={e => { e.target.style.display = 'none' }} />
                </div>
              )}
              {howToExercise.instructions ? (
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-input)' }}>
                  <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>How to do it</p>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {howToExercise.instructions}
                  </p>
                </div>
              ) : (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  No instructions yet for this exercise.
                </p>
              )}
              {!howToExercise.is_system && (
                <p className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
                  Community exercise — added by a Forged Hybrid user
                </p>
              )}
            </div>
            <div className="p-4">
              <button onClick={() => selectExercise(howToExercise)}
                className="w-full py-3 rounded-xl font-bold text-on-accent"
                style={{ background: 'var(--accent)' }}>
                Select {howToExercise.name}
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div>
            <h3 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>Choose Exercise</h3>
            {muscleGroup && <p className="text-xs mt-0.5 capitalize" style={{ color: 'var(--text-muted)' }}>{muscleGroup}</p>}
          </div>
          <button onClick={closePicker} className="text-sm px-3 py-1 rounded-lg"
            style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Close</button>
        </div>

        <div className="p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search exercises..."
            aria-label="Search exercises"
            className="w-full px-4 py-3 rounded-xl outline-none"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 16, minWidth: 0 }}
          />
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-2">
          {loading ? (
            <p className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</p>
          ) : filtered.length === 0 && !search ? (
            <p className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>No exercises for this muscle group yet.</p>
          ) : filtered.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>No results for "{search}"</p>
              {!adding && (
                <button onClick={() => { setNewName(search); setAdding(true) }}
                  className="text-sm font-semibold px-4 py-2 rounded-xl"
                  style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
                  Add "{search}" to library
                </button>
              )}
            </div>
          ) : (
            filtered.map(ex => (
              <div key={ex.id}
                className="flex items-center justify-between rounded-xl px-4 py-3 cursor-pointer transition-all hover:opacity-80"
                style={{ background: 'var(--bg-input)' }}>
                <button className="flex-1 text-left" onClick={() => selectExercise(ex)}>
                  <p className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{ex.name}</p>
                  {ex.secondary_muscles && (
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      Also: {ex.secondary_muscles}
                    </p>
                  )}
                  {!ex.is_system && (
                    <span className="text-xs" style={{ color: 'var(--accent)', opacity: 0.7 }}>community</span>
                  )}
                </button>
                {(ex.instructions || ex.how_to_image_url) && (
                  <button
                    onClick={e => { e.stopPropagation(); setHowToExercise(ex) }}
                    className="ml-3 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
                    title="How to do this exercise">
                    ?
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="border-t p-4" style={{ borderColor: 'var(--border-subtle)' }}>
          {!adding ? (
            <button onClick={() => setAdding(true)}
              className="w-full py-3 rounded-xl text-sm font-semibold"
              style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
              Don't see yours? Add it to the library
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
                New exercise — saved for everyone
              </p>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Exercise name (e.g. Sissy Squat)"
                className="w-full px-4 py-3 rounded-xl outline-none"
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 16, minWidth: 0 }}
              />
              <textarea
                value={newInstructions}
                onChange={e => setNewInstructions(e.target.value)}
                placeholder="How to do it (optional — helps other users)"
                rows={2}
                className="w-full px-4 py-3 rounded-xl outline-none resize-none"
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 16, minWidth: 0 }}
              />
              {addFeedback && (
                <p className="text-xs text-center font-medium" style={{ color: 'var(--accent)' }}>{addFeedback}</p>
              )}
              <div className="flex gap-2">
                <button onClick={() => { setAdding(false); setNewName(''); setNewInstructions(''); setAddFeedback('') }}
                  className="flex-1 py-3 rounded-xl text-sm"
                  style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Cancel</button>
                <button onClick={handleAdd} disabled={addLoading || !newName.trim()}
                  className="flex-1 py-3 rounded-xl text-sm font-bold text-on-accent"
                  style={{ background: newName.trim() ? 'var(--accent)' : 'var(--bg-input)', opacity: addLoading ? 0.6 : 1 }}>
                  {addLoading ? 'Adding...' : 'Add Exercise'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
