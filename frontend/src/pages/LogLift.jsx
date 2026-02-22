import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'

const MUSCLES = ['legs','chest','back','shoulders','arms','core']
const INTENSITY = ['light','moderate','heavy']

export default function LogLift() {
  const navigate = useNavigate()
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState({ date: today, muscle_groups: [], intensity: 'moderate', notes: '' })
  const [saving, setSaving] = useState(false)
  const f = v => setForm(p => ({...p, ...v}))

  function toggleMuscle(m) {
    setForm(p => ({
      ...p,
      muscle_groups: p.muscle_groups.includes(m)
        ? p.muscle_groups.filter(x => x !== m)
        : [...p.muscle_groups, m]
    }))
  }

  const heavyLegs = form.intensity === 'heavy' && form.muscle_groups.includes('legs')

  async function submit(e) {
    e.preventDefault()
    if (!form.muscle_groups.length) { alert('Select at least one muscle group'); return }
    setSaving(true)
    try {
      await api.post('/lifts', form)
      navigate('/')
    } catch { setSaving(false) }
  }

  const inp = 'w-full bg-[#09090f] border border-[#2a2d3e] rounded-xl px-4 py-3 text-white text-sm placeholder-slate-700 focus:outline-none focus:border-orange-500 transition-colors'
  const lbl = 'block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider'

  return (
    <div className="space-y-5 pb-4">
      <div>
        <h1 className="text-2xl font-black text-white">Log a Lift</h1>
        <p className="text-slate-500 text-sm">FORGE tracks gym work to protect your running.</p>
      </div>

      <form onSubmit={submit} className="space-y-5">
        <div>
          <label className={lbl}>Date</label>
          <input type="date" className={inp} value={form.date} onChange={e => f({date: e.target.value})} />
        </div>

        {/* Muscle groups */}
        <div>
          <label className={lbl}>Muscle groups</label>
          <div className="flex flex-wrap gap-2">
            {MUSCLES.map(m => (
              <button key={m} type="button" onClick={() => toggleMuscle(m)}
                className={`px-4 py-2 rounded-xl text-sm font-bold transition-colors border capitalize ${form.muscle_groups.includes(m) ? 'bg-orange-500 border-orange-500 text-white' : 'bg-[#111318] border-[#2a2d3e] text-slate-400'}`}>
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Intensity */}
        <div>
          <label className={lbl}>Intensity</label>
          <div className="grid grid-cols-3 gap-3">
            {INTENSITY.map(i => (
              <button key={i} type="button" onClick={() => f({intensity: i})}
                className={`py-3 rounded-xl text-sm font-bold transition-colors border capitalize ${form.intensity === i ? 'bg-orange-500 border-orange-500 text-white' : 'bg-[#111318] border-[#2a2d3e] text-slate-400'}`}>
                {i}
              </button>
            ))}
          </div>
        </div>

        {/* Heavy legs warning */}
        {heavyLegs && (
          <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-4">
            <p className="text-xs text-amber-300 font-semibold">⚠️ Heavy leg day logged</p>
            <p className="text-xs text-amber-300/70 mt-1">FORGE will warn you before scheduling a hard run in the next 48 hours. Your recovery window matters.</p>
          </div>
        )}

        {/* Notes */}
        <div>
          <label className={lbl}>Notes (optional)</label>
          <textarea className={`${inp} resize-none`} rows={3} placeholder="Exercises, sets, anything notable..." value={form.notes} onChange={e => f({notes: e.target.value})} />
        </div>

        <button type="submit" disabled={saving}
          className="w-full bg-orange-500 hover:bg-orange-400 text-white font-bold rounded-xl py-3.5 text-sm transition-colors disabled:opacity-50">
          {saving ? 'Saving...' : 'Log Lift 💪'}
        </button>
        <button type="button" onClick={() => navigate('/')} className="w-full text-slate-600 text-sm py-2">Cancel</button>
      </form>
    </div>
  )
}
