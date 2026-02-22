import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import api from '../lib/api'

const TYPES = ['easy','tempo','long','intervals','recovery','race']
const TYPE_LABEL = { easy:'Easy Run', tempo:'Tempo', long:'Long Run', intervals:'Intervals', recovery:'Recovery', race:'Race' }
const EFFORT_LABELS = { 1:'Very Easy', 2:'Easy', 3:'Easy', 4:'Moderate', 5:'Moderate', 6:'Moderate', 7:'Hard', 8:'Hard', 9:'Very Hard', 10:'All Out' }

export default function LogRun() {
  const navigate = useNavigate()
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState({ date: today, type: 'easy', distance_miles: '', minutes: '', seconds: '', perceived_effort: 5, notes: '' })
  const [warning, setWarning] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(null) // saved run id
  const [feedback, setFeedback] = useState(null)
  const [polling, setPolling] = useState(false)
  const f = v => setForm(p => ({...p, ...v}))

  useEffect(() => {
    api.get('/coach/warning').then(r => setWarning(r.data)).catch(() => {})
  }, [])

  const highIntensity = ['tempo','intervals'].includes(form.type)

  async function submit(e) {
    e.preventDefault(); setSaving(true)
    try {
      const duration_seconds = (parseInt(form.minutes || 0) * 60) + parseInt(form.seconds || 0)
      const run = await api.post('/runs', {
        date: form.date,
        type: form.type,
        distance_miles: parseFloat(form.distance_miles) || 0,
        duration_seconds,
        perceived_effort: form.perceived_effort,
        notes: form.notes,
      })
      setSaved(run.data.id)
      setPolling(true)
      // Poll for AI feedback
      let attempts = 0
      const poll = setInterval(async () => {
        attempts++
        try {
          const { data } = await api.get(`/coach/feedback/${run.data.id}`)
          if (data.feedback) { setFeedback(data.feedback); setPolling(false); clearInterval(poll) }
        } catch { clearInterval(poll); setPolling(false) }
        if (attempts >= 10) { clearInterval(poll); setPolling(false) }
      }, 1500)
    } finally { setSaving(false) }
  }

  const inp = 'w-full bg-[#09090f] border border-[#2a2d3e] rounded-xl px-4 py-3 text-white text-sm placeholder-slate-700 focus:outline-none focus:border-orange-500 transition-colors'
  const lbl = 'block text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider'

  if (saved) return (
    <div className="space-y-5 pb-4">
      <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-2xl p-4">
        <p className="font-bold text-emerald-400 text-sm">✓ Run logged!</p>
        <p className="text-xs text-slate-400 mt-0.5">{form.distance_miles} miles · {form.type}</p>
      </div>

      {/* Coach feedback */}
      <div className="bg-[#111318] border border-[#1f2028] rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">🔥</span>
          <span className="font-bold text-white text-sm">Coach Feedback</span>
        </div>
        {polling && !feedback ? (
          <div className="flex items-center gap-3 text-slate-500 text-sm">
            <div className="w-4 h-4 border-2 border-orange-500 border-t-transparent rounded-full animate-spin flex-shrink-0"/>
            Analyzing your run...
          </div>
        ) : feedback ? (
          <p className="text-slate-300 text-sm leading-relaxed">{feedback}</p>
        ) : (
          <p className="text-slate-600 text-sm italic">Feedback generating in background...</p>
        )}
      </div>

      <button onClick={() => navigate('/')} className="w-full bg-orange-500 hover:bg-orange-400 text-white font-bold rounded-xl py-3.5 text-sm transition-colors">
        Back to Dashboard
      </button>
    </div>
  )

  return (
    <div className="space-y-5 pb-4">
      <div>
        <h1 className="text-2xl font-black text-white">Log a Run</h1>
        <p className="text-slate-500 text-sm">Every mile counts.</p>
      </div>

      {/* Injury warning */}
      {warning?.warning && highIntensity && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5"/>
          <p className="text-xs text-red-300">{warning.message}</p>
        </div>
      )}

      <form onSubmit={submit} className="space-y-5">
        {/* Run type */}
        <div>
          <label className={lbl}>Run type</label>
          <div className="grid grid-cols-3 gap-2">
            {TYPES.map(t => (
              <button key={t} type="button" onClick={() => f({type: t})}
                className={`py-2.5 rounded-xl text-xs font-bold transition-colors border ${form.type === t ? 'bg-orange-500 border-orange-500 text-white' : 'bg-[#111318] border-[#2a2d3e] text-slate-400 hover:border-slate-500'}`}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Date</label>
            <input type="date" className={inp} value={form.date} onChange={e => f({date: e.target.value})} />
          </div>
          <div>
            <label className={lbl}>Distance (mi)</label>
            <input type="number" step="0.01" className={inp} placeholder="3.1" value={form.distance_miles} onChange={e => f({distance_miles: e.target.value})} />
          </div>
        </div>

        {/* Duration */}
        <div>
          <label className={lbl}>Duration</label>
          <div className="flex gap-2 items-center">
            <input type="number" className={`${inp} text-center`} placeholder="28" min="0" value={form.minutes} onChange={e => f({minutes: e.target.value})} />
            <span className="text-slate-500 text-sm font-bold">min</span>
            <input type="number" className={`${inp} text-center`} placeholder="30" min="0" max="59" value={form.seconds} onChange={e => f({seconds: e.target.value})} />
            <span className="text-slate-500 text-sm font-bold">sec</span>
          </div>
        </div>

        {/* Effort */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className={lbl}>Perceived effort</label>
            <div className="text-right">
              <span className="text-2xl font-black text-orange-400">{form.perceived_effort}</span>
              <span className="text-xs text-slate-500 ml-1">/10 · {EFFORT_LABELS[form.perceived_effort]}</span>
            </div>
          </div>
          <input type="range" min="1" max="10" value={form.perceived_effort} onChange={e => f({perceived_effort: +e.target.value})}
            className="w-full accent-orange-500" />
          <div className="flex justify-between text-[10px] text-slate-700 mt-1">
            <span>Easy</span><span>Moderate</span><span>Hard</span><span>All Out</span>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className={lbl}>Notes (optional)</label>
          <textarea className={`${inp} resize-none`} rows={3} placeholder="How did it feel? Anything notable?" value={form.notes} onChange={e => f({notes: e.target.value})} />
        </div>

        <button type="submit" disabled={saving}
          className="w-full bg-orange-500 hover:bg-orange-400 text-white font-bold rounded-xl py-3.5 text-sm transition-colors disabled:opacity-50 shadow-lg shadow-orange-900/40">
          {saving ? 'Saving...' : 'Log Run 🏃'}
        </button>

        <button type="button" onClick={() => navigate('/')} className="w-full text-slate-600 text-sm py-2">
          Cancel
        </button>
      </form>
    </div>
  )
}
