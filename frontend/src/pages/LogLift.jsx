import { useState } from 'react'
import api from '../lib/api'

const groups = ['legs', 'back', 'chest', 'shoulders', 'arms', 'core']

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

export default function LogLift() {
  const [form, setForm] = useState({
    date: todayISO(),
    exercise_name: '',
    sets: '',
    reps: '',
    weight_lbs: '',
    notes: ''
  })
  const [selectedGroups, setSelectedGroups] = useState([])
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const toggleGroup = group => {
    setSelectedGroups(prev => (prev.includes(group) ? prev.filter(g => g !== group) : [...prev, group]))
  }

  const onSubmit = async e => {
    e.preventDefault()
    setSuccess('')
    setError('')

    try {
      await api.post('/lifts', {
        ...form,
        sets: Number(form.sets),
        reps: Number(form.reps),
        weight_lbs: Number(form.weight_lbs),
        muscle_groups: JSON.stringify(selectedGroups)
      })

      setSuccess('Lift logged!')
      setForm({ date: todayISO(), exercise_name: '', sets: '', reps: '', weight_lbs: '', notes: '' })
      setSelectedGroups([])
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not log lift.')
    }
  }

  return (
    <div className="rounded-2xl bg-[#111318] p-4">
      <h2 className="mb-4 text-xl font-bold">Log Lift</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <input
          type="date"
          value={form.date}
          onChange={e => update('date', e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
        />
        <input
          type="text"
          required
          placeholder="Exercise name"
          value={form.exercise_name}
          onChange={e => update('exercise_name', e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
        />

        <div className="grid grid-cols-3 gap-3">
          <input
            type="number"
            min="1"
            required
            placeholder="Sets"
            value={form.sets}
            onChange={e => update('sets', e.target.value)}
            className="rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
          />
          <input
            type="number"
            min="1"
            required
            placeholder="Reps"
            value={form.reps}
            onChange={e => update('reps', e.target.value)}
            className="rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
          />
          <input
            type="number"
            min="0"
            step="0.5"
            required
            placeholder="Weight"
            value={form.weight_lbs}
            onChange={e => update('weight_lbs', e.target.value)}
            className="rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
          />
        </div>

        <textarea
          rows={3}
          placeholder="Notes"
          value={form.notes}
          onChange={e => update('notes', e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
        />

        <div className="flex flex-wrap gap-2">
          {groups.map(group => {
            const selected = selectedGroups.includes(group)
            return (
              <button
                type="button"
                key={group}
                onClick={() => toggleGroup(group)}
                className={`rounded-full border px-3 py-1 text-sm capitalize ${
                  selected
                    ? 'border-violet-600 bg-violet-600/20 text-violet-300'
                    : 'border-white/10 bg-[#09090f] text-gray-300'
                }`}
              >
                {group}
              </button>
            )
          })}
        </div>

        <button type="submit" className="w-full rounded-xl bg-violet-600 py-3 font-semibold text-white">
          Save Lift
        </button>
      </form>

      {success && <p className="mt-3 text-sm text-green-400">{success}</p>}
      {error && <p className="mt-3 text-sm text-violet-400">{error}</p>}
    </div>
  )
}
