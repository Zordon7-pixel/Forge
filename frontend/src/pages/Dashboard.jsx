import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Flame } from 'lucide-react'
import api from '../lib/api'

function fmtPace(durationSeconds, distance) {
  if (!durationSeconds || !distance) return '--'
  const pace = durationSeconds / 60 / distance
  const mins = Math.floor(pace)
  const secs = Math.round((pace - mins) * 60)
  return `${mins}:${String(secs).padStart(2,'0')} /mi`
}

function fmtDuration(s) {
  if (!s) return '0:00'
  const m = Math.floor(s / 60), sec = s % 60
  return `${m}:${String(sec).padStart(2,'0')}`
}

function fmtHours(s) {
  if (!s) return '0m'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function useCountUp(target, duration = 900) {
  const [count, setCount] = React.useState(0)
  React.useEffect(() => {
    if (!target) { setCount(0); return }
    let start = 0; const step = target / (duration / 16)
    const timer = setInterval(() => {
      start += step
      if (start >= target) { setCount(target); clearInterval(timer) }
      else setCount(Math.floor(start))
    }, 16)
    return () => clearInterval(timer)
  }, [target, duration])
  return count
}

// Mini SVG line chart
function TrendChart({ data = [] }) {
  if (!data.length) return null
  const maxMiles = Math.max(...data.map(d => d.miles), 1)
  const w = 100, h = 40
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (d.miles / maxMiles) * h
    return `${x},${y}`
  }).join(' ')
  const areaPoints = `0,${h} ` + points + ` ${w},${h}`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16" preserveAspectRatio="none">
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.4"/>
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#trendGrad)" />
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => {
        const x = (i / (data.length - 1)) * w
        const y = h - (d.miles / maxMiles) * h
        return d.miles > 0 ? <circle key={i} cx={x} cy={y} r="1.5" fill="var(--accent)" /> : null
      })}
    </svg>
  )
}

// Readiness score circular gauge
function ReadinessGauge({ score }) {
  const r = 28, cx = 36, cy = 36
  const circumference = 2 * Math.PI * r
  const dash = (score / 100) * circumference
  const color = score >= 75 ? '#22c55e' : score >= 50 ? 'var(--accent)' : '#ef4444'
  const label = score >= 80 ? 'Optimal' : score >= 60 ? 'Good' : score >= 40 ? 'Moderate' : 'Low'

  return (
    <div className="flex items-center gap-4">
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-subtle)" strokeWidth="5" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="5"
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`} />
        <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle"
          fontSize="13" fontWeight="bold" fill={color}>{score}</text>
      </svg>
      <div>
        <p className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{label}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Training readiness</p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
          {score >= 75 ? 'Go hard today.' : score >= 50 ? 'Moderate effort.' : 'Take it easy today.'}
        </p>
      </div>
    </div>
  )
}

const PERIOD_LABELS = { day: 'Today', week: 'This Week', month: 'This Month', year: 'This Year', all: 'All Time' }

// Watch Sync Widget
function WatchSyncWidget() {
  const [syncing, setSyncing] = useState(true)
  const [done, setDone] = useState(false)

  useEffect(() => {
    // Simulate sync completing after 3 seconds
    const t = setTimeout(() => {
      setSyncing(false)
      setDone(true)
      // Ring disappears after 1s fade
      setTimeout(() => setDone(false), 1000)
    }, 3000)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="relative flex items-center justify-center" style={{ width: 56, height: 56 }}>
      {/* Spinning sync ring — visible while syncing */}
      {syncing && (
        <svg
          className="absolute inset-0"
          width="56" height="56"
          viewBox="0 0 56 56"
          style={{ animation: 'spin 1.2s linear infinite' }}
        >
          <circle
            cx="28" cy="28" r="25"
            fill="none"
            stroke="#EAB308"
            strokeWidth="2.5"
            strokeDasharray="100 58"
            strokeLinecap="round"
          />
        </svg>
      )}
      {/* Closing ring — shown when sync completes */}
      {done && !syncing && (
        <svg
          className="absolute inset-0"
          width="56" height="56"
          viewBox="0 0 56 56"
          style={{ animation: 'ringClose 0.8s ease-out forwards' }}
        >
          <circle
            cx="28" cy="28" r="25"
            fill="none"
            stroke="#22c55e"
            strokeWidth="2.5"
            strokeDasharray="157 0"
            strokeLinecap="round"
          />
        </svg>
      )}
      {/* Watch face image */}
      <img
        src="/fenix7x.png"
        alt="Garmin Fenix 7X"
        style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover' }}
      />
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [runs, setRuns] = useState([])
  const [lifts, setLifts] = useState([])
  const [warning, setWarning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState('week')
  const [coachLabel, setCoachLabel] = useState('')
  const [firstName, setFirstName] = useState('')
  const [checkedInToday, setCheckedInToday] = useState(false)
  const [goalMode, setGoalMode] = useState('auto') // 'auto' | 'manual'
  const [manualGoalMiles, setManualGoalMiles] = useState(null)
  const [editingGoal, setEditingGoal] = useState(false)
  const [goalInput, setGoalInput] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const [statsRes, runsRes, liftsRes, warningRes, meRes, checkinRes, goalRes] = await Promise.all([
          api.get('/auth/me/stats'),
          api.get('/runs', { params: { limit: 5 } }),
          api.get('/lifts'),
          api.get('/coach/warning'),
          api.get('/auth/me'),
          api.get('/checkin/today').catch(() => ({ data: null })),
          api.get('/users/goal').catch(() => ({ data: null })),
        ])
        setStats(statsRes.data)
        setRuns(Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || [])
        setLifts(Array.isArray(liftsRes.data) ? liftsRes.data : liftsRes.data?.lifts || [])
        setWarning(warningRes.data?.warning === true)
        const coaches = { mentor: 'Mentor', hype_coach: 'Hype Coach', drill_sergeant: 'Drill Sergeant', training_partner: 'Training Partner' }
        const cp = meRes.data?.user?.coach_personality
        setCoachLabel(coaches[cp] || cp || '')
        const name = meRes.data?.user?.name || ''
        setFirstName(name.split(' ')[0])
        if (checkinRes.data) setCheckedInToday(true)
        if (goalRes.data) {
          setGoalMode(goalRes.data.mode || 'auto')
          setManualGoalMiles(goalRes.data.miles || null)
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning,'
    if (h < 18) return 'Good afternoon,'
    return 'Good evening,'
  }, [])

  // Compute readiness from stats
  const readiness = useMemo(() => {
    if (!stats) return 50
    const { streak, week, all } = stats
    let score = 50
    // Streak bonus (up to +20)
    score += Math.min(streak * 4, 20)
    // Volume: if this week is reasonable vs average
    const avgWeekly = all.miles / Math.max(stats.weeklyTrend?.filter(w => w.miles > 0).length, 1)
    const weekRatio = avgWeekly > 0 ? week.miles / avgWeekly : 0
    if (weekRatio < 0.5) score += 15 // low week = well rested
    else if (weekRatio > 1.3) score -= 15 // high week = tired
    // Cap 1-99
    return Math.max(1, Math.min(99, Math.round(score)))
  }, [stats])

  // Monthly challenge
  const monthlyGoal = useMemo(() => {
    if (!stats) return null
    const monthMiles = stats.month?.miles || 0
    let goal
    if (goalMode === 'manual' && manualGoalMiles) {
      goal = manualGoalMiles
    } else {
      // Auto: round up to next 25-mile milestone
      goal = Math.max(25, Math.ceil(monthMiles / 25) * 25 + (monthMiles >= 25 ? 25 : 0))
    }
    const pct = Math.min((monthMiles / goal) * 100, 100)
    return { miles: monthMiles, goal, pct }
  }, [stats, goalMode, manualGoalMiles])

  const periodStats = stats?.[period] || {}
  const milesCount = useCountUp(Math.round((periodStats.miles || 0) * 10), 900)
  const runsCount = useCountUp(periodStats.count || 0, 900)

  // Combined recent activity
  const recentActivity = useMemo(() => {
    const runItems = runs.slice(0, 3).map(r => ({ ...r, _type: 'run' }))
    const liftItems = (lifts || []).slice(0, 3).map(l => ({ ...l, _type: 'lift' }))
    const combined = [...runItems, ...liftItems]
      .sort((a, b) => {
        const da = a.date || a.started_at || a.created_at || ''
        const db2 = b.date || b.started_at || b.created_at || ''
        return db2.localeCompare(da)
      })
    return combined.slice(0, 4)
  }, [runs, lifts])

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="space-y-4">
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes ringClose {
          0% { opacity: 1; stroke-dasharray: 157 0; }
          80% { opacity: 1; stroke-dasharray: 157 0; }
          100% { opacity: 0; stroke-dasharray: 157 0; }
        }
      `}</style>

      {!checkedInToday && (
        <a href="/checkin"
          style={{ display: 'block', background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 14, padding: '12px 16px', marginBottom: 12, textDecoration: 'none' }}>
          <p style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 14, margin: 0 }}>Quick check-in — 3 taps</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '2px 0 0' }}>Help me adjust today's plan around your day</p>
        </a>
      )}

      {/* Greeting */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{greeting}{firstName ? ` ${firstName}` : ''}</p>
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {stats?.streak > 1 ? `${stats.streak}-day streak` : 'Ready to forge today?'}
          </h2>
          {coachLabel && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Coach: {coachLabel}</p>}
        </div>
        <WatchSyncWidget />
      </div>

      {/* Ready to Run CTA */}
      <div className="rounded-2xl p-6 flex flex-col items-center" style={{ background: 'var(--bg-card)' }}>
        <h2 className="text-2xl font-black mb-1" style={{ color: 'var(--text-primary)' }}>Ready to Run?</h2>
        <p className="text-sm mb-10 text-center" style={{ color: 'var(--text-muted)' }}>Dynamic warm-up reduces injury risk and improves performance.</p>
        <button
          onClick={() => navigate('/log-run?warmup=true')}
          className="rounded-full w-28 h-28 mb-6 font-black flex flex-col items-center justify-center"
          style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer' }}
        >
          <Flame className="mb-1" />
          <span className="text-xs font-black">Start Warm-Up</span>
        </button>
        <button
          onClick={() => navigate('/log-run')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: '8px 0' }}
        >
          Skip warm-up
        </button>
      </div>

      {/* Training Readiness */}
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <ReadinessGauge score={readiness} />
      </div>

      {/* 7-day calendar */}
      {stats?.calendarDays && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
          <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>This Week</p>
          <div className="grid grid-cols-7 gap-1">
            {stats.calendarDays.map((day) => (
              <div key={day.date} className="flex flex-col items-center gap-1">
                <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>{day.day}</span>
                <div className="w-8 h-8 rounded-full flex items-center justify-center border"
                  style={{
                    background: day.hasRun || day.hasLift ? 'var(--accent)' : 'var(--bg-input)',
                    borderColor: day.isToday ? 'var(--accent)' : 'transparent',
                    borderWidth: day.isToday ? 2 : 1
                  }}>
                  {day.hasRun && day.hasLift ? (
                    <span className="text-xs font-bold text-black">R+L</span>
                  ) : day.hasRun ? (
                    <span className="text-xs font-bold text-black">R</span>
                  ) : day.hasLift ? (
                    <span className="text-xs font-bold text-black">L</span>
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.4 }}>·</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats with period selector */}
      <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-card)' }}>
        {/* Period tabs — pill-style: All | D | W | M */}
        <div className="flex gap-2">
          {[
            { key: 'all', label: 'All' },
            { key: 'day',   label: 'D'   },
            { key: 'week',  label: 'W'   },
            { key: 'month', label: 'M'   },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setPeriod(key)}
              className="px-4 py-1.5 rounded-full text-xs font-semibold transition-all"
              style={period === key
                ? { background: 'var(--accent)', color: '#000' }
                : { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
              {label}
            </button>
          ))}
        </div>

        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{PERIOD_LABELS[period]}</p>

        {/* Hero number */}
        <div>
          <p className="text-5xl font-black tabular-nums" style={{ color: 'var(--text-primary)' }}>
            {(milesCount / 10).toFixed(1)}
          </p>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Miles</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{runsCount}</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Runs</p>
          </div>
          <div>
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{fmtHours(periodStats.seconds)}</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Time</p>
          </div>
          <div>
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{(periodStats.calories || 0).toLocaleString()}</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Cal</p>
          </div>
        </div>
      </div>

      {/* 12-week trend chart */}
      {stats?.weeklyTrend && stats.weeklyTrend.some(w => w.miles > 0) && (
        <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Past 12 Weeks</p>
            <p className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
              {stats.weeklyTrend[stats.weeklyTrend.length - 1]?.miles.toFixed(1)} mi last week
            </p>
          </div>
          <TrendChart data={stats.weeklyTrend} />
          <div className="flex justify-between mt-1">
            <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
              {new Date(stats.weeklyTrend[0]?.week).toLocaleDateString('en-US', { month: 'short' })}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>Now</span>
          </div>
        </div>
      )}

      {/* Monthly Challenge */}
      {monthlyGoal && (
        <div className="rounded-2xl p-5 mb-4" style={{ background: 'var(--bg-card)' }}>
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Monthly Challenge</p>
            {/* Auto / Manual toggle */}
            <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
              {['auto', 'manual'].map(m => (
                <button key={m} onClick={() => {
                  setGoalMode(m)
                  api.put('/users/goal', { miles: manualGoalMiles, mode: m }).catch(() => {})
                  if (m === 'manual' && !manualGoalMiles) setEditingGoal(true)
                }}
                  style={{
                    padding: '4px 12px', fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer',
                    background: goalMode === m ? 'var(--accent)' : 'var(--bg-input)',
                    color: goalMode === m ? '#000' : 'var(--text-muted)',
                    textTransform: 'capitalize',
                  }}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Goal display / edit */}
          {editingGoal ? (
            <div className="flex gap-2 mb-3 items-center">
              <input
                type="number"
                value={goalInput}
                onChange={e => setGoalInput(e.target.value)}
                placeholder="e.g. 100"
                autoFocus
                style={{
                  flex: 1, background: 'var(--bg-input)', border: '1px solid var(--accent)',
                  borderRadius: 8, padding: '8px 12px', color: 'var(--text-primary)',
                  fontSize: 14, outline: 'none',
                }}
              />
              <button onClick={async () => {
                const miles = parseFloat(goalInput)
                if (!miles || miles <= 0) return
                setManualGoalMiles(miles)
                setEditingGoal(false)
                await api.put('/users/goal', { miles, mode: 'manual' }).catch(() => {})
              }}
                style={{
                  background: 'var(--accent)', color: '#000', fontWeight: 700,
                  borderRadius: 8, padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 13,
                }}>
                Set
              </button>
              <button onClick={() => setEditingGoal(false)}
                style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-baseline gap-2">
                <p className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{monthlyGoal.miles.toFixed(1)}</p>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>/ {monthlyGoal.goal} mi</p>
              </div>
              {goalMode === 'manual' && (
                <button onClick={() => { setGoalInput(String(manualGoalMiles || '')); setEditingGoal(true) }}
                  style={{ color: 'var(--text-muted)', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer' }}>
                  Edit goal
                </button>
              )}
            </div>
          )}

          {/* Progress bar */}
          <div className="rounded-full overflow-hidden mb-2" style={{ height: 8, background: 'var(--bg-input)' }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${monthlyGoal.pct}%`, background: 'var(--accent)' }} />
          </div>

          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {monthlyGoal.miles >= monthlyGoal.goal
              ? 'Challenge complete!'
              : `${(monthlyGoal.goal - monthlyGoal.miles).toFixed(1)} mi to go`}
            {goalMode === 'auto' && <span style={{ opacity: 0.5 }}> · Auto goal</span>}
          </p>
        </div>
      )}

      {/* AI Warning */}
      {warning && (
        <div className="rounded-xl border p-3 text-sm" style={{ borderColor: 'rgba(234,179,8,0.3)', background: 'rgba(234,179,8,0.08)', color: 'var(--accent)' }}>
          Heavy legs detected — consider a rest day or easy run today
        </div>
      )}

      {/* Recent Activity */}
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Recent Activity</h3>
        <div className="space-y-3">
          {recentActivity.map(item => item._type === 'run' ? (
            <div key={item.id} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>Run</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {new Date(item.date || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <div className="flex gap-4 mt-1">
                <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{Number(item.distance_miles || 0).toFixed(2)} mi</p></div>
                <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmtPace(item.duration_seconds, item.distance_miles)}</p></div>
                <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmtDuration(item.duration_seconds)}</p></div>
                {item.calories > 0 && <div><p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{item.calories} cal</p></div>}
              </div>
            </div>
          ) : (
            <div key={item.id} className="rounded-xl p-3 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa' }}>Lift</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {new Date(item.date || item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <p className="text-sm font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                {item.exercise_name || (Array.isArray(item.muscle_groups) ? item.muscle_groups.join(', ') : 'Workout')}
              </p>
              {item.sets && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{item.sets} sets · {item.reps} reps · {item.weight_lbs} lbs</p>}
            </div>
          ))}
          {recentActivity.length === 0 && (
            <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>No activity yet. Start moving!</p>
          )}
        </div>
      </section>
    </div>
  )
}
