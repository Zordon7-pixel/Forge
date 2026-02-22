import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'

const personalityOptions = [
  { key: 'mentor', label: 'Mentor 🎓' },
  { key: 'hype_coach', label: 'Hype Coach ⚡' },
  { key: 'drill_sergeant', label: 'Drill Sergeant 💪' },
  { key: 'training_partner', label: 'Training Partner 🤝' }
]

export default function Profile() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    name: '',
    email: '',
    age: '',
    weight_lbs: '',
    fitness_level: 'beginner',
    primary_goal: 'general_fitness',
    injury_status: 'none',
    injury_detail: '',
    coach_personality: 'mentor',
    weekly_miles: ''
  })

  useEffect(() => {
    ;(async () => {
      try {
        const res = await api.get('/auth/me')
        const user = res.data?.user || res.data || {}
        setForm({
          name: user.name || '',
          email: user.email || '',
          age: user.age ?? '',
          weight_lbs: user.weight_lbs ?? '',
          fitness_level: user.fitness_level || (user.comeback_mode ? 'intermediate' : 'beginner'),
          primary_goal: user.primary_goal || user.goal_type || 'general_fitness',
          injury_status: user.injury_status || (user.injury_notes ? 'recovering' : 'none'),
          injury_detail: user.injury_detail || user.injury_notes || '',
          coach_personality: user.coach_personality || 'mentor',
          weekly_miles: user.weekly_miles ?? user.weekly_miles_current ?? ''
        })
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const save = async e => {
    e.preventDefault()
    setError('')
    setSaving(true)
    setSaved(false)
    try {
      await api.put('/auth/me/profile', {
        name: form.name,
        age: form.age === '' ? null : Number(form.age),
        weight_lbs: form.weight_lbs === '' ? null : Number(form.weight_lbs),
        fitness_level: form.fitness_level,
        primary_goal: form.primary_goal,
        injury_status: form.injury_status,
        injury_detail: form.injury_detail,
        coach_personality: form.coach_personality,
        weekly_miles: form.weekly_miles === '' ? null : Number(form.weekly_miles),
        // legacy compatibility
        weekly_miles_current: form.weekly_miles === '' ? null : Number(form.weekly_miles),
        goal_type: form.primary_goal,
        injury_notes: form.injury_detail,
        comeback_mode: form.injury_status !== 'none' ? 1 : 0
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save profile changes.')
    } finally {
      setSaving(false)
    }
  }

  const logout = () => {
    localStorage.removeItem('forge_token')
    navigate('/login')
  }

  if (loading) return <div className="rounded-xl bg-[#111318] p-4 text-gray-300">Loading profile...</div>

  return (
    <div className="rounded-2xl bg-[#111318] p-4">
      <h2 className="mb-4 text-xl font-bold text-white">Profile</h2>

      <form onSubmit={save} className="space-y-3">
        <input
          type="text"
          placeholder="Name"
          value={form.name}
          onChange={e => update('name', e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3 text-white"
        />

        <input
          type="email"
          value={form.email}
          readOnly
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3 text-gray-400"
        />

        <div className="grid grid-cols-3 gap-3">
          <input
            type="number"
            min="0"
            placeholder="Age"
            value={form.age}
            onChange={e => update('age', e.target.value)}
            className="rounded-xl border border-white/10 bg-[#09090f] px-3 py-3 text-white"
          />
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder="Weight"
            value={form.weight_lbs}
            onChange={e => update('weight_lbs', e.target.value)}
            className="rounded-xl border border-white/10 bg-[#09090f] px-3 py-3 text-white"
          />
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder="Weekly mi"
            value={form.weekly_miles}
            onChange={e => update('weekly_miles', e.target.value)}
            className="rounded-xl border border-white/10 bg-[#09090f] px-3 py-3 text-white"
          />
        </div>

        <select
          value={form.fitness_level}
          onChange={e => update('fitness_level', e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3 text-white"
        >
          <option value="beginner">Beginner</option>
          <option value="intermediate">Intermediate</option>
          <option value="advanced">Advanced</option>
        </select>

        <select
          value={form.primary_goal}
          onChange={e => update('primary_goal', e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3 text-white"
        >
          <option value="get_faster">Get Faster</option>
          <option value="run_longer">Run Longer</option>
          <option value="lose_fat">Lose Fat</option>
          <option value="general_fitness">General Fitness</option>
        </select>

        <div className="space-y-2">
          {['none', 'recovering', 'chronic'].map(status => (
            <label key={status} className="flex items-center gap-2 text-sm capitalize text-gray-200">
              <input
                type="radio"
                name="injury_status"
                value={status}
                checked={form.injury_status === status}
                onChange={e => update('injury_status', e.target.value)}
              />
              {status}
            </label>
          ))}
        </div>

        {form.injury_status !== 'none' && (
          <textarea
            rows={3}
            placeholder="Injury details"
            value={form.injury_detail}
            onChange={e => update('injury_detail', e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3 text-white"
          />
        )}

        <div className="grid grid-cols-2 gap-3">
          {personalityOptions.map(option => (
            <button
              key={option.key}
              type="button"
              onClick={() => update('coach_personality', option.key)}
              className={`rounded-xl border p-3 text-left text-sm transition ${
                form.coach_personality === option.key
                  ? 'border-orange-500 bg-orange-500/10 text-white'
                  : 'border-white/10 bg-[#09090f] text-gray-300'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {saved && <p className="text-sm text-green-400">Saved! ✅</p>}

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-orange-500 py-3 font-semibold text-white disabled:opacity-70"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>

        <button
          type="button"
          onClick={logout}
          className="w-full rounded-xl border border-white/20 bg-transparent py-3 font-semibold text-gray-100"
        >
          Log Out
        </button>
      </form>
    </div>
  )
}
