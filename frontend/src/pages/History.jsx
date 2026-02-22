import { useEffect, useState } from 'react'
import api from '../lib/api'

const TYPE_COLORS = { easy:'bg-emerald-900/30 text-emerald-400', tempo:'bg-orange-900/30 text-orange-400', long:'bg-purple-900/30 text-purple-400', intervals:'bg-red-900/30 text-red-400', recovery:'bg-blue-900/30 text-blue-400', race:'bg-pink-900/30 text-pink-400' }
const TYPE_LABEL = { easy:'Easy', tempo:'Tempo', long:'Long Run', intervals:'Intervals', recovery:'Recovery', race:'Race' }

function minsToReadable(secs) {
  const m = Math.round(secs / 60)
  if (m === 0) return null
  return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`
}

function pace(secs, miles) {
  if (!secs || !miles) return null
  const secPerMile = secs / miles
  const m = Math.floor(secPerMile / 60)
  const s = Math.round(secPerMile % 60)
  return `${m}:${String(s).padStart(2,'0')}/mi`
}

export default function History() {
  const [runs, setRuns] = useState([])
  const [lifts, setLifts] = useState([])
  const [tab, setTab] = useState('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get('/runs').then(r => setRuns(r.data.runs || [])),
      api.get('/lifts').then(r => setLifts(r.data.lifts || [])),
    ]).finally(() => setLoading(false))
  }, [])

  const totalMiles = runs.reduce((s, r) => s + (r.distance_miles || 0), 0)
  const avgEffort = runs.length ? (runs.reduce((s, r) => s + (r.perceived_effort || 0), 0) / runs.length).toFixed(1) : 0

  const items = tab === 'runs' ? runs.map(r => ({...r, kind:'run'}))
    : tab === 'lifts' ? lifts.map(l => ({...l, kind:'lift'}))
    : [...runs.map(r => ({...r, kind:'run'})), ...lifts.map(l => ({...l, kind:'lift'}))].sort((a,b) => b.date.localeCompare(a.date))

  if (loading) return <div className="flex items-center justify-center h-48"><div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin"/></div>

  return (
    <div className="space-y-5 pb-4">
      <div>
        <h1 className="text-2xl font-black text-white">History</h1>
        <p className="text-slate-500 text-sm">Every mile, every lift.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[#111318] border border-[#1f2028] rounded-2xl p-3 text-center">
          <div className="text-2xl font-black text-orange-400">{totalMiles.toFixed(0)}</div>
          <div className="text-[10px] text-slate-600">Total Miles</div>
        </div>
        <div className="bg-[#111318] border border-[#1f2028] rounded-2xl p-3 text-center">
          <div className="text-2xl font-black text-white">{runs.length}</div>
          <div className="text-[10px] text-slate-600">Runs</div>
        </div>
        <div className="bg-[#111318] border border-[#1f2028] rounded-2xl p-3 text-center">
          <div className="text-2xl font-black text-blue-400">{lifts.length}</div>
          <div className="text-[10px] text-slate-600">Lifts</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {['all','runs','lifts'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors capitalize border ${tab === t ? 'bg-orange-500 border-orange-500 text-white' : 'bg-[#111318] border-[#2a2d3e] text-slate-400'}`}>
            {t === 'all' ? 'All' : t === 'runs' ? '🏃 Runs' : '💪 Lifts'}
          </button>
        ))}
      </div>

      {/* List */}
      {items.length === 0 ? (
        <div className="bg-[#111318] border border-[#1f2028] rounded-2xl p-8 text-center">
          <p className="text-slate-600 text-sm">No activity yet. Start logging!</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(item => (
            <div key={item.id} className="bg-[#111318] border border-[#1f2028] rounded-2xl p-4">
              {item.kind === 'run' ? (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${TYPE_COLORS[item.type] || 'bg-slate-900 text-slate-400'}`}>
                        {TYPE_LABEL[item.type] || item.type}
                      </span>
                      <span className="text-xs text-slate-500">{item.date}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-base font-black text-white">{item.distance_miles} mi</span>
                      {minsToReadable(item.duration_seconds) && <span className="text-xs text-slate-500 ml-1.5">{minsToReadable(item.duration_seconds)}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-600">
                    {pace(item.duration_seconds, item.distance_miles) && <span>{pace(item.duration_seconds, item.distance_miles)}</span>}
                    <span>Effort: {item.perceived_effort}/10</span>
                  </div>
                  {item.ai_feedback && (
                    <p className="text-xs text-slate-400 mt-2 leading-relaxed border-t border-[#1f2028] pt-2">{item.ai_feedback}</p>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-900/30 text-blue-400">💪 Lift</span>
                      <span className="text-xs text-slate-500">{item.date}</span>
                    </div>
                    <div className="flex gap-1 flex-wrap">
                      {(item.muscle_groups || []).map(g => (
                        <span key={g} className="text-[10px] bg-[#1f2028] text-slate-400 px-1.5 py-0.5 rounded capitalize">{g}</span>
                      ))}
                    </div>
                  </div>
                  <span className={`text-xs font-bold px-2 py-1 rounded-lg capitalize ${item.intensity === 'heavy' ? 'bg-red-900/30 text-red-400' : item.intensity === 'moderate' ? 'bg-yellow-900/30 text-yellow-400' : 'bg-slate-900/30 text-slate-400'}`}>
                    {item.intensity}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
