import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Flame, TrendingUp, Dumbbell, ChevronRight } from 'lucide-react'
import api from '../lib/api'
import { getUser } from '../lib/auth'

const TYPE_COLORS = { easy:'bg-emerald-900/40 text-emerald-400', tempo:'bg-orange-900/40 text-orange-400', long:'bg-purple-900/40 text-purple-400', intervals:'bg-red-900/40 text-red-400', recovery:'bg-blue-900/40 text-blue-400', rest:'bg-[#1f2028] text-slate-600', cross_train:'bg-yellow-900/40 text-yellow-400', race:'bg-pink-900/40 text-pink-400' }
const TYPE_LABEL = { easy:'Easy', tempo:'Tempo', long:'Long', intervals:'Intervals', recovery:'Recovery', rest:'Rest', cross_train:'Cross', race:'Race' }

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

function minsToReadable(secs) {
  const m = Math.round(secs / 60)
  return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`
}

export default function Dashboard() {
  const user = getUser()
  const navigate = useNavigate()
  const [runs,    setRuns]    = useState([])
  const [lifts,   setLifts]   = useState([])
  const [plan,    setPlan]    = useState(null)
  const [warning, setWarning] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get('/runs').then(r => setRuns(r.data.runs || [])),
      api.get('/lifts').then(r => setLifts(r.data.lifts || [])),
      api.get('/plans/current').then(r => setPlan(r.data.plan)),
      api.get('/coach/warning').then(r => setWarning(r.data)),
    ]).finally(() => setLoading(false))
  }, [])

  // Week stats
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay())
  const weekStr = weekStart.toISOString().split('T')[0]
  const weekRuns = runs.filter(r => r.date >= weekStr)
  const weekLifts = lifts.filter(l => l.date >= weekStr)
  const weekMiles = weekRuns.reduce((s, r) => s + (r.distance_miles || 0), 0)

  // Total miles
  const totalMiles = runs.reduce((s, r) => s + (r.distance_miles || 0), 0)

  // This week from plan
  const currentWeek = plan?.plan_json?.weeks?.[0]
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short' }).slice(0,3)

  // Recent activity combined (last 4)
  const activity = [
    ...runs.map(r => ({ ...r, kind: 'run' })),
    ...lifts.map(l => ({ ...l, kind: 'lift' })),
  ].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 4)

  if (loading) return (
    <div className="flex items-center justify-center h-48">
      <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin"/>
    </div>
  )

  return (
    <div className="space-y-5 pb-4">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-black text-white">{greeting()}, {user?.name?.split(' ')[0]} 👋</h1>
        <p className="text-slate-500 text-sm">Let's see where you're at.</p>
      </div>

      {/* Week stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Miles', value: weekMiles.toFixed(1), icon: '🏃', color: 'text-orange-400' },
          { label: 'Runs',  value: weekRuns.length,      icon: '📍', color: 'text-emerald-400' },
          { label: 'Lifts', value: weekLifts.length,     icon: '💪', color: 'text-blue-400' },
        ].map(s => (
          <div key={s.label} className="bg-[#111318] rounded-2xl p-4 border border-[#1f2028] text-center">
            <div className="text-xl mb-1">{s.icon}</div>
            <div className={`text-2xl font-black ${s.color}`}>{s.value}</div>
            <div className="text-xs text-slate-600">{s.label} this week</div>
          </div>
        ))}
      </div>

      {/* Injury warning */}
      {warning?.warning && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-red-400">Injury Risk ⚠️</p>
            <p className="text-xs text-red-300/80 mt-0.5">{warning.message}</p>
          </div>
        </div>
      )}

      {/* CTA buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button onClick={() => navigate('/log-run')}
          className="bg-orange-500 hover:bg-orange-400 text-white font-bold rounded-2xl py-4 text-sm transition-colors shadow-lg shadow-orange-900/40">
          🏃 Log Run
        </button>
        <button onClick={() => navigate('/log-lift')}
          className="bg-[#111318] border border-[#2a2d3e] hover:border-slate-600 text-white font-bold rounded-2xl py-4 text-sm transition-colors">
          💪 Log Lift
        </button>
      </div>

      {/* This week plan */}
      {currentWeek && (
        <div className="bg-[#111318] rounded-2xl border border-[#1f2028] p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-white text-sm">This Week <span className="text-slate-600 font-normal">— {currentWeek.theme}</span></h2>
            <button onClick={() => navigate('/plan')} className="text-xs text-orange-400">View full plan →</button>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map(d => {
              const dayPlan = currentWeek.days?.find(x => x.day === d)
              const isToday = d === today
              const isRest = dayPlan?.rest || dayPlan?.type === 'rest'
              return (
                <div key={d} className={`rounded-xl p-1.5 text-center ${isToday ? 'ring-2 ring-orange-500' : ''} ${isRest ? 'bg-[#0d0d14]' : 'bg-[#1a1d26]'}`}>
                  <div className={`text-[9px] font-semibold mb-1 ${isToday ? 'text-orange-400' : 'text-slate-600'}`}>{d}</div>
                  {isRest ? (
                    <div className="text-[10px] text-slate-700">—</div>
                  ) : (
                    <>
                      <div className={`text-[9px] font-bold px-1 py-0.5 rounded ${TYPE_COLORS[dayPlan?.type] || 'text-slate-500'}`}>
                        {TYPE_LABEL[dayPlan?.type] || '?'}
                      </div>
                      {dayPlan?.distance_miles > 0 && (
                        <div className="text-[9px] text-slate-500 mt-0.5">{dayPlan.distance_miles}mi</div>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-2 text-xs text-slate-600 text-right">Target: {currentWeek.total_miles} miles</div>
        </div>
      )}

      {/* Recent activity */}
      {activity.length > 0 && (
        <div>
          <h2 className="font-bold text-white text-sm mb-3">Recent Activity</h2>
          <div className="space-y-2">
            {activity.map(item => (
              <div key={item.id} className="bg-[#111318] rounded-xl border border-[#1f2028] p-3.5">
                {item.kind === 'run' ? (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${TYPE_COLORS[item.type] || 'text-slate-500 bg-slate-900/40'}`}>
                          {TYPE_LABEL[item.type] || item.type}
                        </span>
                        <span className="text-xs text-slate-500">{item.date}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-sm font-bold text-white">{item.distance_miles}mi</span>
                        {item.duration_seconds > 0 && <span className="text-xs text-slate-600 ml-1.5">{minsToReadable(item.duration_seconds)}</span>}
                      </div>
                    </div>
                    {item.ai_feedback && (
                      <p className="text-xs text-slate-400 mt-1.5 leading-relaxed line-clamp-2">{item.ai_feedback}</p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-400">
                        💪 Lift
                      </span>
                      <span className="text-xs text-slate-500">{item.date}</span>
                    </div>
                    <div className="flex gap-1 flex-wrap justify-end">
                      {(item.muscle_groups || []).map(g => (
                        <span key={g} className="text-[10px] bg-[#1f2028] text-slate-400 px-1.5 py-0.5 rounded capitalize">{g}</span>
                      ))}
                      <span className="text-[10px] text-slate-600 capitalize">{item.intensity}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All-time stats */}
      <div className="bg-[#111318] rounded-2xl border border-[#1f2028] p-4">
        <h2 className="font-bold text-white text-sm mb-3 flex items-center gap-2"><TrendingUp size={14} className="text-orange-400"/> All Time</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="text-center">
            <div className="text-3xl font-black text-orange-400">{totalMiles.toFixed(0)}</div>
            <div className="text-xs text-slate-600">Total Miles</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-black text-white">{runs.length}</div>
            <div className="text-xs text-slate-600">Total Runs</div>
          </div>
        </div>
      </div>
    </div>
  )
}
