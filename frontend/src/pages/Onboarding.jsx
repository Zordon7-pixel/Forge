import { useMemo, useState } from 'react'
import api from '../lib/api'

const personalityOptions = [
  { key: 'mentor', label: 'Mentor 🎓' },
  { key: 'hype_coach', label: 'Hype Coach ⚡' },
  { key: 'drill_sergeant', label: 'Drill Sergeant 💪' },
  { key: 'training_partner', label: 'Training Partner 🤝' }
]

export default function Onboarding() {
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    age: '',
    weightLbs: '',
    heightFt: 5,
    heightIn: 8,
    weeklyMiles: 10,
    fitnessLevel: 'beginner',
    primaryGoal: 'general_fitness',
    injuryStatus: 'none',
    injuryDetail: '',
    coachPersonality: 'mentor'
  })

  const progress = useMemo(() => `${(step / 5) * 100}%`, [step])

  const next = () => setStep(s => Math.min(5, s + 1))
  const back = () => setStep(s => Math.max(1, s - 1))

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const submit = async () => {
    setError('')
    setSaving(true)
    try {
      await api.put('/api/auth/me/profile', {
        age: Number(form.age),
        weight_lbs: Number(form.weightLbs),
        height_ft: Number(form.heightFt),
        height_in: Number(form.heightIn),
        weekly_miles: Number(form.weeklyMiles),
        fitness_level: form.fitnessLevel,
        primary_goal: form.primaryGoal,
        injury_status: form.injuryStatus,
        injury_detail: form.injuryDetail,
        coach_personality: form.coachPersonality
      })

      await api.post('/api/plans/generate')
      window.location.href = '/'
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not finish onboarding. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#09090f] px-4 py-6 text-white">
      <div className="mx-auto w-full max-w-[480px]">
        <div className="mb-6 h-2 w-full overflow-hidden rounded-full bg-[#111318]">
          <div className="h-full bg-orange-500 transition-all" style={{ width: progress }} />
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#111318] p-5">
          <p className="mb-1 text-xs uppercase tracking-widest text-gray-400">Step {step} of 5</p>

          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Your baseline</h2>
              <input
                type="number"
                min="1"
                placeholder="Age"
                className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
                value={form.age}
                onChange={e => update('age', e.target.value)}
              />
              <input
                type="number"
                min="1"
                placeholder="Weight (lbs)"
                className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
                value={form.weightLbs}
                onChange={e => update('weightLbs', e.target.value)}
              />
              <div className="grid grid-cols-2 gap-3">
                <select
                  className="rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
                  value={form.heightFt}
                  onChange={e => update('heightFt', e.target.value)}
                >
                  {[4, 5, 6, 7].map(ft => (
                    <option key={ft} value={ft}>
                      {ft} ft
                    </option>
                  ))}
                </select>
                <select
                  className="rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
                  value={form.heightIn}
                  onChange={e => update('heightIn', e.target.value)}
                >
                  {Array.from({ length: 12 }).map((_, inch) => (
                    <option key={inch} value={inch}>
                      {inch} in
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Training profile</h2>
              <div>
                <label className="mb-2 block text-sm text-gray-300">Weekly miles: {form.weeklyMiles}</label>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={form.weeklyMiles}
                  onChange={e => update('weeklyMiles', e.target.value)}
                  className="w-full accent-orange-500"
                />
              </div>
              <div className="space-y-2">
                {['beginner', 'intermediate', 'advanced'].map(level => (
                  <label key={level} className="flex items-center gap-2 capitalize text-gray-200">
                    <input
                      type="radio"
                      name="fitnessLevel"
                      value={level}
                      checked={form.fitnessLevel === level}
                      onChange={e => update('fitnessLevel', e.target.value)}
                    />
                    {level}
                  </label>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Primary goal</h2>
              {[
                ['get_faster', 'Get Faster'],
                ['run_longer', 'Run Longer'],
                ['lose_fat', 'Lose Fat'],
                ['general_fitness', 'General Fitness']
              ].map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-gray-200">
                  <input
                    type="radio"
                    name="primaryGoal"
                    value={value}
                    checked={form.primaryGoal === value}
                    onChange={e => update('primaryGoal', e.target.value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Injury status</h2>
              {['none', 'recovering', 'chronic'].map(status => (
                <label key={status} className="flex items-center gap-2 capitalize text-gray-200">
                  <input
                    type="radio"
                    name="injuryStatus"
                    value={status}
                    checked={form.injuryStatus === status}
                    onChange={e => update('injuryStatus', e.target.value)}
                  />
                  {status}
                </label>
              ))}

              {form.injuryStatus !== 'none' && (
                <textarea
                  rows={4}
                  placeholder="Tell us more about your injury"
                  className="w-full rounded-xl border border-white/10 bg-[#09090f] px-4 py-3"
                  value={form.injuryDetail}
                  onChange={e => update('injuryDetail', e.target.value)}
                />
              )}
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Coach personality</h2>
              <div className="grid grid-cols-2 gap-3">
                {personalityOptions.map(option => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => update('coachPersonality', option.key)}
                    className={`rounded-xl border p-4 text-left text-sm transition ${
                      form.coachPersonality === option.key
                        ? 'border-orange-500 bg-orange-500/10 text-white'
                        : 'border-white/10 bg-[#09090f] text-gray-300'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              onClick={back}
              disabled={step === 1 || saving}
              className="rounded-xl border border-white/10 px-4 py-2 text-gray-300 disabled:opacity-40"
            >
              Back
            </button>

            {step < 5 ? (
              <button
                type="button"
                onClick={next}
                className="rounded-xl bg-orange-500 px-5 py-2 font-semibold text-white"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={saving}
                className="rounded-xl bg-orange-500 px-5 py-2 font-semibold text-white disabled:opacity-70"
              >
                Finish
              </button>
            )}
          </div>
        </div>
      </div>

      {saving && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#09090f]/95 text-white">
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-orange-500 border-t-transparent" />
          <p className="text-lg font-semibold">🔥 Building your plan...</p>
        </div>
      )}
    </div>
  )
}
