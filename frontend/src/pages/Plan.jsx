import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import api from '../lib/api'

const TYPE_COLORS = { easy:'bg-emerald-900/30 text-emerald-400 border-emerald-800', tempo:'bg-orange-900/30 text-orange-400 border-orange-800', long:'bg-purple-900/30 text-purple-400 border-purple-800', intervals:'bg-red-900/30 text-red-400 border-red-800', recovery:'bg-blue-900/30 text-blue-400 border-blue-800', rest:'bg-[#1f2028] text-slate-600 border-[#1f2028]', cross_train:'bg-yellow-900/30 text-yellow-400 border-yellow-800', race:'bg-pink-900/30 text-pink-400 border-pink-800' }
const TYPE_LABEL = { easy:'Easy', tempo:'Tempo', long:'Long', intervals:'Intervals', recovery:'Recovery', rest:'Rest', cross_train:'Cross', race:'Race' }

export default function Plan() {
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [activeWeek, setActiveWeek] = useState(0)
  const [expanded, setExpanded] = useState(null)

  useEffect(() => { load() }, [])

  function load() {
    setLoading(true)
    api.get('/plans/current').then(r => setPlan(r.data.plan)).finally(() => setLoading(false))
  }

  async function regenerate() {
    setGenerating(true)
    try { const r = await api.post('/plans/generate'); setPlan(r.data.plan); setActiveWeek(0) }
    finally { setGenerating(false) }
  }

  if (loading) return <div className="flex items-center justify-center h-48"><div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin"/></div>

  const weeks = plan?.plan_json?.weeks || []
  const week = weeks[activeWeek]

  return (
    <div className="space-y-5 pb-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-white">Training Plan</h1>
          <p className="text-slate-500 text-sm">Built for you by your AI coach.</p>
        </div>
        <button onClick={regenerate} disabled={generating}
          className="flex items-center gap-1.5 bg-[#111318] border border-[#2a2d3e] text-slate-400 hover:text-white px-3 py-2 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50">
          <RefreshCw size={13} className={generating ? 'animate-spin' : ''}/> {generating ? 'Generating...' : 'Regenerate'}
        </button>
      </div>

      {!plan || weeks.length === 0 ? (
        <div className="bg-[#111318] border border-[#1f2028] rounded-2xl p-8 text-center">
          <p className="text-slate-400 text-sm mb-4">No training plan yet.</p>
          <button onClick={regenerate} disabled={generating}
            className="bg-orange-500 hover:bg-orange-400 text-white font-bold px-6 py-3 rounded-xl text-sm transition-colors">
            {generating ? 'Building plan...' : 'Generate My Plan 🔥'}
          </button>
        </div>
      ) : (
        <>
          {/* Week selector */}
          <div className="flex gap-2">
            {weeks.map((w, i) => (
              <button key={i} onClick={() => { setActiveWeek(i); setExpanded(null) }}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors border ${activeWeek === i ? 'bg-orange-500 border-orange-500 text-white' : 'bg-[#111318] border-[#2a2d3e] text-slate-400'}`}>
                Week {w.week}
              </button>
            ))}
          </div>

          {/* Week theme */}
          {week && (
            <div className="bg-[#111318] border border-[#1f2028] rounded-xl px-4 py-3 flex items-center justify-between">
              <div>
                <span className="text-sm font-bold text-white">{week.theme}</span>
                <span className="text-xs text-slate-500 ml-2">— Week {week.week}</span>
              </div>
              <span className="text-orange-400 font-bold text-sm">{week.total_miles} mi</span>
            </div>
          )}

          {/* Days */}
          {week?.days?.map((day, i) => (
            <div key={i}
              className={`bg-[#111318] border rounded-2xl overflow-hidden transition-colors ${expanded === i ? 'border-orange-500/40' : 'border-[#1f2028]'}`}>
              <button className="w-full flex items-center gap-3 p-4 text-left" onClick={() => setExpanded(expanded === i ? null : i)}>
                <div className="w-10 text-center">
                  <div className="text-xs font-bold text-slate-500">{day.day}</div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${TYPE_COLORS[day.type] || 'text-slate-500 bg-slate-900 border-slate-800'}`}>
                      {TYPE_LABEL[day.type] || day.type}
                    </span>
                    {!day.rest && day.distance_miles > 0 && (
                      <span className="text-sm font-bold text-white">{day.distance_miles} mi</span>
                    )}
                    {!day.rest && day.duration_min > 0 && (
                      <span className="text-xs text-slate-500">{day.duration_min} min</span>
                    )}
                  </div>
                </div>
                {!day.rest && <span className="text-slate-700 text-xs">{expanded === i ? '▲' : '▼'}</span>}
              </button>
              {expanded === i && day.description && (
                <div className="px-4 pb-4 pt-0">
                  <p className="text-sm text-slate-400 leading-relaxed">{day.description}</p>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
