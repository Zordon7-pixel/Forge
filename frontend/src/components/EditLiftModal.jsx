import React, { useState } from 'react'
import api from '../lib/api'
import { validateWorkoutSet } from '../utils/validation'

export default function EditLiftModal({ lift, onSave, onClose }) {
  const [exerciseName, setExerciseName] = useState(lift.exercise_name || '')
  const [sets, setSets] = useState(String(lift.sets ?? ''))
  const [reps, setReps] = useState(String(lift.reps ?? ''))
  const [weightLbs, setWeightLbs] = useState(String(lift.weight_lbs ?? ''))
  const [date, setDate] = useState(lift.date || lift.created_at?.slice(0, 10) || '')
  const [notes, setNotes] = useState(lift.notes || '')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const { errors } = validateWorkoutSet({ reps, weight: weightLbs })
    if (!Number.isFinite(Number(sets)) || Number(sets) <= 0) errors.sets = 'Sets must be a positive number.'
    setFieldErrors(errors)
    if (Object.keys(errors).length) return

    setSaving(true)
    setError('')
    try {
      const updated = await api.put(`/lifts/${lift.id}`, {
        exercise_name: exerciseName,
        sets: sets === '' ? null : Number(sets),
        reps: reps === '' ? null : Number(reps),
        weight_lbs: weightLbs === '' ? null : Number(weightLbs),
        date,
        notes
      })
      onSave(updated.data)
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg rounded-t-2xl p-5 space-y-3" style={{ background: 'var(--bg-card)' }}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>Edit Lift</h3>
          <button onClick={onClose} className="text-sm px-3 py-1 rounded-lg" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Cancel</button>
        </div>

        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Exercise</label>
          <input className="w-full px-4 py-3 rounded-xl text-sm outline-none" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} value={exerciseName} onChange={e => setExerciseName(e.target.value)} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Sets</label>
            <input className="w-full px-4 py-3 rounded-xl text-sm outline-none" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} value={sets} onChange={e => setSets(e.target.value)} inputMode="numeric" />
            {fieldErrors.sets && <p className="text-xs mt-1" style={{ color: '#ef4444' }}>{fieldErrors.sets}</p>}
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Reps</label>
            <input className="w-full px-4 py-3 rounded-xl text-sm outline-none" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} value={reps} onChange={e => setReps(e.target.value)} inputMode="numeric" />
            {fieldErrors.reps && <p className="text-xs mt-1" style={{ color: '#ef4444' }}>{fieldErrors.reps}</p>}
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Weight</label>
            <input className="w-full px-4 py-3 rounded-xl text-sm outline-none" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} value={weightLbs} onChange={e => setWeightLbs(e.target.value)} inputMode="decimal" />
            {fieldErrors.weight && <p className="text-xs mt-1" style={{ color: '#ef4444' }}>{fieldErrors.weight}</p>}
          </div>
        </div>

        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Date (YYYY-MM-DD)</label>
          <input className="w-full px-4 py-3 rounded-xl text-sm outline-none" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} value={date} onChange={e => setDate(e.target.value)} />
        </div>

        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Notes</label>
          <textarea className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
        </div>

        {error && <p className="text-xs" style={{ color: '#ef4444' }}>{error}</p>}

        <button onClick={save} disabled={saving} className="w-full py-4 rounded-xl font-black text-black text-base" style={{ background: 'var(--accent)', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
