import { useMemo, useState } from 'react'
import api from '../lib/api'

const personalityOptions = [
  { key: 'mentor', label: 'Mentor' },
  { key: 'hype_coach', label: 'Hype Coach' },
  { key: 'drill_sergeant', label: 'Drill Sergeant' },
  { key: 'training_partner', label: 'Training Partner' }
]

export default function Onboarding() {
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ age: '', weightLbs: '', heightFt: 5, heightIn: 8, weeklyMiles: 10, fitnessLevel: 'beginner', primaryGoal: 'general_fitness', injuryStatus: 'none', injuryDetail: '', coachPersonality: 'mentor' })
  const [scheduleType, setScheduleType] = useState('adaptive')
  const [lifestyle, setLifestyle] = useState('works_fulltime')
  const [preferredWorkoutTime, setPreferredWorkoutTime] = useState('evening')
  const [missedWorkoutPref, setMissedWorkoutPref] = useState('adjust_week')

  const progress = useMemo(() => `${(step / 8) * 100}%`, [step])
  const next = () => setStep(s => Math.min(8, s + 1))
  const back = () => setStep(s => Math.max(1, s - 1))
  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const submit = async () => {
    setError(''); setSaving(true)
    if (!form.age || form.age < 10 || form.age > 100) return setError('Please enter a valid age.'), setSaving(false)
    if (!form.weightLbs || form.weightLbs < 50 || form.weightLbs > 500) return setError('Please enter a valid weight.'), setSaving(false)

    try {
      await api.put('/auth/me/profile', {
        age: Number(form.age), weight_lbs: Number(form.weightLbs), height_ft: Number(form.heightFt), height_in: Number(form.heightIn), weekly_miles: Number(form.weeklyMiles),
        fitness_level: form.fitnessLevel, primary_goal: form.primaryGoal, injury_status: form.injuryStatus, injury_detail: form.injuryDetail, coach_personality: form.coachPersonality,
        schedule_type: scheduleType,
        lifestyle,
        preferred_workout_time: preferredWorkoutTime,
        missed_workout_pref: missedWorkoutPref
      })
      await api.post('/plans/generate')
      window.location.href = '/'
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not finish onboarding. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen px-4 py-6" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="mx-auto w-full max-w-[480px]">
        <div className="mb-6 h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-card)' }}>
          <div className="h-full transition-all" style={{ width: progress, background: 'var(--accent)' }} />
        </div>

        <div className="rounded-2xl border p-5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <p className="mb-1 text-xs uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Step {step} of 8</p>

          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Your baseline</h2>
              <input type="number" min="1" placeholder="Age" className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }} value={form.age} onChange={e => update('age', e.target.value)} />
              <input type="number" min="1" placeholder="Weight (lbs)" className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }} value={form.weightLbs} onChange={e => update('weightLbs', e.target.value)} />
              <div className="grid grid-cols-2 gap-3">
                <select className="rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }} value={form.heightFt} onChange={e => update('heightFt', e.target.value)}>{[4,5,6,7].map(ft => <option key={ft} value={ft}>{ft} ft</option>)}</select>
                <select className="rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }} value={form.heightIn} onChange={e => update('heightIn', e.target.value)}>{Array.from({ length: 12 }).map((_, inch) => <option key={inch} value={inch}>{inch} in</option>)}</select>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Training profile</h2>
              <div>
                <label className="mb-2 block text-sm" style={{ color: 'var(--text-muted)' }}>Weekly miles: {form.weeklyMiles}</label>
                <input type="range" min="0" max="50" value={form.weeklyMiles} onChange={e => update('weeklyMiles', e.target.value)} className="w-full accent-yellow-500" />
              </div>
              <div className="space-y-2">{['beginner','intermediate','advanced'].map(level => <label key={level} className="flex items-center gap-2 capitalize" style={{ color: 'var(--text-primary)' }}><input type="radio" name="fitnessLevel" value={level} checked={form.fitnessLevel===level} onChange={e=>update('fitnessLevel',e.target.value)} />{level}</label>)}</div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Primary goal</h2>
              {[['get_faster','Get Faster'],['run_longer','Run Longer'],['lose_fat','Lose Fat'],['general_fitness','General Fitness']].map(([value,label]) => <label key={value} className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}><input type="radio" name="primaryGoal" value={value} checked={form.primaryGoal===value} onChange={e=>update('primaryGoal',e.target.value)} />{label}</label>)}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Injury status</h2>
              {['none','recovering','chronic'].map(status => <label key={status} className="flex items-center gap-2 capitalize" style={{ color: 'var(--text-primary)' }}><input type="radio" name="injuryStatus" value={status} checked={form.injuryStatus===status} onChange={e=>update('injuryStatus',e.target.value)} />{status}</label>)}
              {form.injuryStatus !== 'none' && <textarea rows={4} placeholder="Tell us more about your injury" className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }} value={form.injuryDetail} onChange={e=>update('injuryDetail',e.target.value)} />}
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Coach personality</h2>
              <div className="grid grid-cols-2 gap-3">
                {personalityOptions.map(option => (
                  <button key={option.key} type="button" onClick={() => update('coachPersonality', option.key)} className="rounded-xl border p-4 text-left text-sm transition"
                    style={form.coachPersonality === option.key ? { borderColor: 'var(--accent)', background: 'var(--accent-dim)', color: 'var(--text-primary)' } : { borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>How do you want to train?</h2>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>This shapes how your plan adapts to real life.</p>
              {[
                { value: 'flexible', label: 'Flexible', desc: 'Adjust my plan around my life. I run when I can.' },
                { value: 'adaptive', label: 'Adaptive', desc: 'Give me a plan, but rebuild it when life gets in the way.' },
                { value: 'structured', label: 'Structured', desc: 'Fixed weekly schedule. I commit and I show up.' },
              ].map(opt => (
                <button key={opt.value} onClick={() => setScheduleType(opt.value)}
                  className="w-full p-4 rounded-2xl text-left border transition-all"
                  style={{
                    background: scheduleType === opt.value ? 'var(--accent-dim)' : 'var(--bg-input)',
                    borderColor: scheduleType === opt.value ? 'var(--accent)' : 'var(--border-subtle)',
                  }}>
                  <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{opt.label}</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{opt.desc}</p>
                </button>
              ))}
            </div>
          )}

          {step === 7 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>What's your situation?</h2>
              
              <div className="grid grid-cols-2 gap-3">
                {[
                  { value: 'works_fulltime', label: '9-5 Job' },
                  { value: 'works_shifts', label: 'Shift Work' },
                  { value: 'student', label: 'Student' },
                  { value: 'works_from_home', label: 'Work From Home' },
                  { value: 'self_employed', label: 'Self-Employed' },
                  { value: 'free_schedule', label: 'Free Schedule' },
                ].map(opt => (
                  <button key={opt.value} onClick={() => setLifestyle(opt.value)}
                    className="p-3 rounded-xl text-center font-semibold text-sm border"
                    style={{
                      background: lifestyle === opt.value ? 'var(--accent-dim)' : 'var(--bg-input)',
                      borderColor: lifestyle === opt.value ? 'var(--accent)' : 'var(--border-subtle)',
                      color: 'var(--text-primary)',
                    }}>
                    {opt.label}
                  </button>
                ))}
              </div>

              <div>
                <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>When do you prefer to train?</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { value: 'morning', label: 'Morning', sub: 'Before work' },
                    { value: 'midday', label: 'Midday', sub: 'Lunch break' },
                    { value: 'evening', label: 'Evening', sub: 'After work' },
                    { value: 'varies', label: 'It varies', sub: 'No preference' },
                  ].map(opt => (
                    <button key={opt.value} onClick={() => setPreferredWorkoutTime(opt.value)}
                      className="p-3 rounded-xl text-left border"
                      style={{
                        background: preferredWorkoutTime === opt.value ? 'var(--accent-dim)' : 'var(--bg-input)',
                        borderColor: preferredWorkoutTime === opt.value ? 'var(--accent)' : 'var(--border-subtle)',
                      }}>
                      <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{opt.label}</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{opt.sub}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 8 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>If you miss a workout...</h2>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Life happens. What should I do?</p>
              
              {[
                { value: 'skip', label: 'Skip it, move on', desc: "Don't try to make it up. Keep the week clean." },
                { value: 'move_next', label: 'Move to tomorrow', desc: "Push it 24 hours and carry on." },
                { value: 'adjust_week', label: 'Rebuild my week', desc: "Adjust everything to fit the missed session in." },
              ].map(opt => (
                <button key={opt.value} onClick={() => setMissedWorkoutPref(opt.value)}
                  className="w-full p-4 rounded-2xl text-left border"
                  style={{
                    background: missedWorkoutPref === opt.value ? 'var(--accent-dim)' : 'var(--bg-input)',
                    borderColor: missedWorkoutPref === opt.value ? 'var(--accent)' : 'var(--border-subtle)',
                  }}>
                  <p className="font-bold" style={{ color: 'var(--text-primary)' }}>{opt.label}</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{opt.desc}</p>
                </button>
              ))}
            </div>
          )}

          {error && <p className="mt-4 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}

          <div className="mt-6 flex items-center justify-between">
            <button type="button" onClick={back} disabled={step === 1 || saving} className="rounded-xl border px-4 py-2 disabled:opacity-40" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>Back</button>
            {step < 8 ? (
              <button type="button" onClick={next} className="rounded-xl px-5 py-2 font-semibold" style={{ background: 'var(--accent)', color: 'black' }}>Next</button>
            ) : (
              <button type="button" onClick={submit} disabled={saving} className="rounded-xl px-5 py-2 font-semibold disabled:opacity-70" style={{ background: 'var(--accent)', color: 'black' }}>Finish</button>
            )}
          </div>
        </div>
      </div>

      {saving && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)', color: 'var(--text-primary)' }}>
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-t-transparent" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
          <p className="text-lg font-semibold">Building your plan...</p>
        </div>
      )}
    </div>
  )
}
