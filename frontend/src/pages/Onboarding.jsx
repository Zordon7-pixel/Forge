import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'

const PERSONALITIES = [
  { key: 'mentor',          emoji: '🎓', name: 'Mentor',          desc: 'Calm, analytical, and strategic. Coaches with context and data.' },
  { key: 'hype_coach',      emoji: '⚡', name: 'Hype Coach',      desc: 'Energetic and loud. Celebrates every win. Pushes you to go harder.' },
  { key: 'drill_sergeant',  emoji: '💪', name: 'Drill Sergeant',  desc: 'Direct, no excuses, tactically precise. Results over comfort.' },
  { key: 'training_partner',emoji: '🤝', name: 'Training Partner', desc: 'Peer-to-peer and relatable. Like a friend who ran the same route.' },
]

const TOTAL = 5

export default function Onboarding() {
  const [step, setStep] = useState(1)
  const [generating, setGenerating] = useState(false)
  const [form, setForm] = useState({
    weekly_miles_current: '', years_running: '',
    goal_type: 'fitness', goal_race_date: '', goal_race_distance: '',
    injury_notes: '', comeback_mode: 0,
    run_days_per_week: 3, lift_days_per_week: 2,
    coach_personality: 'mentor',
  })
  const f = v => setForm(p => ({...p, ...v}))
  const navigate = useNavigate()

  async function finish() {
    setGenerating(true)
    try {
      const { data } = await api.put('/auth/me/profile', {
        weekly_miles_current: parseFloat(form.weekly_miles_current) || 0,
        goal_type: form.goal_type,
        goal_race_date: form.goal_race_date || null,
        goal_race_distance: form.goal_race_distance || null,
        injury_notes: form.injury_notes || null,
        comeback_mode: form.comeback_mode ? 1 : 0,
        run_days_per_week: form.run_days_per_week,
        lift_days_per_week: form.lift_days_per_week,
        coach_personality: form.coach_personality,
      })
      if (data.token) localStorage.setItem('forge_token', data.token)
      // Generate plan
      await api.post('/plans/generate').catch(() => {})
      navigate('/')
    } catch { setGenerating(false) }
  }

  const inp = 'w-full bg-[#09090f] border border-[#2a2d3e] rounded-xl px-4 py-3 text-white text-sm placeholder-slate-700 focus:outline-none focus:border-orange-500 transition-colors'
  const lbl = 'block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider'

  const pct = Math.round((step / TOTAL) * 100)

  if (generating) return (
    <div className="min-h-screen bg-[#09090f] flex flex-col items-center justify-center gap-6 p-8">
      <div className="w-20 h-20 bg-orange-500 rounded-3xl flex items-center justify-center shadow-2xl shadow-orange-900/60 animate-pulse">
        <span className="text-4xl">🔥</span>
      </div>
      <div className="text-center">
        <h2 className="text-2xl font-black text-white">Building your plan...</h2>
        <p className="text-slate-500 text-sm mt-2">Your AI coach is analyzing your profile and creating a personalized 4-week training plan.</p>
      </div>
      <div className="w-48 h-1 bg-[#1f2028] rounded-full overflow-hidden">
        <div className="h-full bg-orange-500 rounded-full animate-pulse" style={{width:'60%'}}/>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#09090f] flex flex-col p-4">
      {/* Progress */}
      <div className="max-w-sm mx-auto w-full pt-8 pb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-slate-500">Step {step} of {TOTAL}</span>
          <span className="text-xs text-orange-400 font-semibold">{pct}%</span>
        </div>
        <div className="h-1.5 bg-[#1f2028] rounded-full">
          <div className="h-full bg-orange-500 rounded-full transition-all duration-300" style={{width:`${pct}%`}}/>
        </div>
      </div>

      <div className="flex-1 max-w-sm mx-auto w-full space-y-6">
        {/* Step 1 */}
        {step === 1 && (
          <>
            <div>
              <h2 className="text-2xl font-black text-white">Your training</h2>
              <p className="text-slate-500 text-sm mt-1">Tell us where you're starting from.</p>
            </div>
            <div>
              <label className={lbl}>Current weekly miles</label>
              <input type="number" className={inp} placeholder="e.g. 20" value={form.weekly_miles_current} onChange={e => f({weekly_miles_current: e.target.value})} />
              <p className="text-xs text-slate-600 mt-1">Average over the past month</p>
            </div>
            <div>
              <label className={lbl}>Years running</label>
              <input type="number" className={inp} placeholder="e.g. 3" value={form.years_running} onChange={e => f({years_running: e.target.value})} />
            </div>
          </>
        )}

        {/* Step 2 */}
        {step === 2 && (
          <>
            <div>
              <h2 className="text-2xl font-black text-white">Your goal</h2>
              <p className="text-slate-500 text-sm mt-1">What are you training for right now?</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: 'comeback',      label: '🔄 Comeback',       desc: 'Returning from injury' },
                { key: 'race',          label: '🏁 Race',           desc: 'Training for an event' },
                { key: 'fitness',       label: '💪 Fitness',        desc: 'General performance' },
                { key: 'base_building', label: '📈 Base Building',  desc: 'Build aerobic base' },
              ].map(g => (
                <button key={g.key} onClick={() => f({goal_type: g.key})}
                  className={`p-4 rounded-xl border text-left transition-colors ${form.goal_type === g.key ? 'border-orange-500 bg-orange-900/20' : 'border-[#2a2d3e] bg-[#111318]'}`}>
                  <div className="font-bold text-sm text-white">{g.label}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{g.desc}</div>
                </button>
              ))}
            </div>
            {form.goal_type === 'race' && (
              <div className="space-y-3">
                <div>
                  <label className={lbl}>Race Date</label>
                  <input type="date" className={inp} value={form.goal_race_date} onChange={e => f({goal_race_date: e.target.value})} />
                </div>
                <div>
                  <label className={lbl}>Race Distance</label>
                  <select className={inp} value={form.goal_race_distance} onChange={e => f({goal_race_distance: e.target.value})}>
                    <option value="">Select distance</option>
                    {['5K','10K','Half Marathon','Marathon','Ultra 50K','Ultra 50M','Ultra 100M'].map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
            )}
          </>
        )}

        {/* Step 3 */}
        {step === 3 && (
          <>
            <div>
              <h2 className="text-2xl font-black text-white">Injury history</h2>
              <p className="text-slate-500 text-sm mt-1">Your coach needs to know what to protect.</p>
            </div>
            <div>
              <label className={lbl}>Any current or recent injuries?</label>
              <textarea className={`${inp} resize-none`} rows={4} placeholder="e.g. Right knee tendinitis, recovering from December — cleared for easy running only" value={form.injury_notes} onChange={e => f({injury_notes: e.target.value})} />
              <p className="text-xs text-slate-600 mt-1">Leave blank if healthy. This shapes your entire plan.</p>
            </div>
            <button onClick={() => f({comeback_mode: form.comeback_mode ? 0 : 1})}
              className={`w-full p-4 rounded-xl border text-left transition-colors ${form.comeback_mode ? 'border-orange-500 bg-orange-900/20' : 'border-[#2a2d3e] bg-[#111318]'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-bold text-sm text-white">🔄 Comeback Mode</div>
                  <div className="text-xs text-slate-500 mt-0.5">Conservative build-up, no speed work early. For returning from injury or long break.</div>
                </div>
                <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 ${form.comeback_mode ? 'border-orange-500 bg-orange-500' : 'border-slate-600'}`}/>
              </div>
            </button>
          </>
        )}

        {/* Step 4 */}
        {step === 4 && (
          <>
            <div>
              <h2 className="text-2xl font-black text-white">Your schedule</h2>
              <p className="text-slate-500 text-sm mt-1">How many days per week can you train?</p>
            </div>
            <div className="space-y-6">
              <div>
                <div className="flex justify-between items-center mb-3">
                  <label className={lbl}>Run days per week</label>
                  <span className="text-2xl font-black text-orange-400">{form.run_days_per_week}</span>
                </div>
                <input type="range" min="1" max="7" value={form.run_days_per_week} onChange={e => f({run_days_per_week: +e.target.value})}
                  className="w-full accent-orange-500" />
                <div className="flex justify-between text-xs text-slate-600 mt-1"><span>1</span><span>7</span></div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-3">
                  <label className={lbl}>Lift days per week</label>
                  <span className="text-2xl font-black text-orange-400">{form.lift_days_per_week}</span>
                </div>
                <input type="range" min="0" max="6" value={form.lift_days_per_week} onChange={e => f({lift_days_per_week: +e.target.value})}
                  className="w-full accent-orange-500" />
                <div className="flex justify-between text-xs text-slate-600 mt-1"><span>0</span><span>6</span></div>
              </div>
            </div>
          </>
        )}

        {/* Step 5 */}
        {step === 5 && (
          <>
            <div>
              <h2 className="text-2xl font-black text-white">Your coach</h2>
              <p className="text-slate-500 text-sm mt-1">Pick your coaching style. You can change this anytime.</p>
            </div>
            <div className="space-y-3">
              {PERSONALITIES.map(p => (
                <button key={p.key} onClick={() => f({coach_personality: p.key})}
                  className={`w-full p-4 rounded-xl border text-left transition-colors ${form.coach_personality === p.key ? 'border-orange-500 bg-orange-900/20' : 'border-[#2a2d3e] bg-[#111318]'}`}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{p.emoji}</span>
                    <div>
                      <div className="font-bold text-sm text-white">{p.name}</div>
                      <div className="text-xs text-slate-500">{p.desc}</div>
                    </div>
                    <div className={`w-4 h-4 rounded-full border-2 ml-auto flex-shrink-0 ${form.coach_personality === p.key ? 'border-orange-500 bg-orange-500' : 'border-slate-600'}`}/>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Nav buttons */}
      <div className="max-w-sm mx-auto w-full flex gap-3 pt-6 pb-8">
        {step > 1 && (
          <button onClick={() => setStep(s => s - 1)} className="flex-1 bg-[#111318] border border-[#2a2d3e] text-slate-400 font-semibold rounded-xl py-3.5 text-sm">
            Back
          </button>
        )}
        {step < TOTAL ? (
          <button onClick={() => setStep(s => s + 1)} className="flex-1 bg-orange-500 hover:bg-orange-400 text-white font-bold rounded-xl py-3.5 text-sm transition-colors">
            Continue →
          </button>
        ) : (
          <button onClick={finish} className="flex-1 bg-orange-500 hover:bg-orange-400 text-white font-bold rounded-xl py-3.5 text-sm transition-colors">
            Build My Plan 🔥
          </button>
        )}
      </div>
    </div>
  )
}
