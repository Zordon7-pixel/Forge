import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Flame, MapPin, Mountain, RefreshCw, Gauge } from 'lucide-react'
import api from '../lib/api'
import { parseDuration, formatDurationDisplay } from '../lib/parseDuration'
import PostRunCheckIn from '../components/PostRunCheckIn'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

const WARM_UP_STEPS = [
  'Leg swings — 10 each side',
  'High knees — 30 seconds',
  'Ankle circles — 10 each side',
  'Hip circles — 10 each direction',
  'Arm swings — 20 reps',
]

const SURFACE_OPTIONS = [
  { value: 'road',      label: 'Road',      icon: MapPin },
  { value: 'trail',     label: 'Trail',     icon: Mountain },
  { value: 'track',     label: 'Track',     icon: RefreshCw },
  { value: 'treadmill', label: 'Treadmill', icon: Gauge },
]

function getEffortColor(level) {
  if (level <= 3) return '#3B82F6'
  if (level <= 6) return '#22C55E'
  if (level <= 8) return '#EAB308'
  return '#EF4444'
}

function getEffortLabel(level) {
  if (level <= 3) return 'Easy'
  if (level <= 6) return 'Moderate'
  if (level <= 8) return 'Hard'
  return 'Max Effort'
}

function EffortBar({ effort, setEffort }) {
  return (
    <div>
      <label className="mb-3 block text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
        Effort Level
      </label>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(level => {
          const isActive = level <= effort
          const color = getEffortColor(level)
          return (
            <button
              key={level}
              type="button"
              onClick={() => setEffort(level)}
              style={{
                flex: 1,
                height: 40,
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                background: isActive ? color : 'rgba(255,255,255,0.08)',
                transition: 'background 0.15s',
              }}
            />
          )
        })}
      </div>
      <div style={{ marginTop: 10, textAlign: 'center' }}>
        <span style={{ fontSize: 36, fontWeight: 900, color: getEffortColor(effort), lineHeight: 1 }}>
          {effort}
        </span>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3, fontWeight: 600 }}>
          {getEffortLabel(effort)}
        </div>
      </div>
    </div>
  )
}

function formatRunDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function LogRun() {
  const navigate = useNavigate()

  // Warm-up gate: 'gate' | 'warmup' | 'done'
  const [warmUpState, setWarmUpState] = useState('gate')

  // Mini-tabs: 'log' | 'gps' | 'history'
  const [activeTab, setActiveTab] = useState('log')

  const [countdown, setCountdown] = useState(3)
  const [surface, setSurface] = useState('road')

  const [date, setDate] = useState(todayISO())
  const [distance, setDistance] = useState('')
  const [duration, setDuration] = useState('30:00')
  const [notes, setNotes] = useState('')
  const [effort, setEffort] = useState(5)
  const [loading, setLoading] = useState(false)
  const [polling, setPolling] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false)
  const [showPostCheckIn, setShowPostCheckIn] = useState(false)
  const [savedRunId, setSavedRunId] = useState(null)
  const [recentRuns, setRecentRuns] = useState([])
  const [runsLoading, setRunsLoading] = useState(false)

  useEffect(() => {
    if (activeTab === 'history' && recentRuns.length === 0) {
      setRunsLoading(true)
      api.get('/runs')
        .then(res => setRecentRuns(res.data?.runs || []))
        .catch(() => {})
        .finally(() => setRunsLoading(false))
    }
  }, [activeTab])

  const onSubmit = async e => {
    e.preventDefault()
    setError('')
    setFeedback('')

    const seconds = parseDuration(duration)
    if (!seconds) {
      setError('Please enter a valid duration.')
      return
    }

    try {
      setLoading(true)
      const runType = surface === 'treadmill' ? 'treadmill' : surface === 'trail' ? 'trail' : 'easy'
      const runRes = await api.post('/runs', {
        date,
        type: runType,
        surface,
        run_surface: surface,
        distance_miles: Number(distance),
        duration_seconds: seconds,
        notes,
        perceived_effort: Number(effort),
      })

      const runId = runRes.data?.id || runRes.data?.run?.id
      if (runId) api.post('/prs/auto-detect', { run_id: runId }).catch(() => {})
      if (!runId) {
        setFeedback('Feedback coming soon...')
        setShowRecoveryPrompt(true)
        return
      }

      setSavedRunId(runId)
      setShowPostCheckIn(true)

      setPolling(true)
      let attempts = 0
      let aiFeedback = ''
      while (attempts < 5 && !aiFeedback) {
        attempts += 1
        await new Promise(resolve => setTimeout(resolve, 2000))
        const feedbackRes = await api.get(`/coach/feedback/${runId}`)
        aiFeedback = feedbackRes.data?.ai_feedback || ''
      }

      setFeedback(aiFeedback || 'Your coach is thinking... check back after your next run.')
      setShowRecoveryPrompt(true)
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save run. Check your connection and try again.')
    } finally {
      setLoading(false)
      setPolling(false)
    }
  }

  // ── Warm-up Gate ──────────────────────────────────────────────────────────
  if (warmUpState === 'gate') {
    return (
      <>
        <style>{`
          @keyframes warmup-pulse {
            0%   { transform: scale(1);    opacity: 0.75; }
            70%  { transform: scale(1.45); opacity: 0; }
            100% { transform: scale(1.45); opacity: 0; }
          }
          .warmup-ring {
            position: absolute; inset: 0;
            border-radius: 50%;
            border: 3px solid #EAB308;
            animation: warmup-pulse 2s ease-out infinite;
            pointer-events: none;
          }
          .warmup-ring-2 {
            position: absolute; inset: 0;
            border-radius: 50%;
            border: 3px solid #F97316;
            animation: warmup-pulse 2s ease-out 0.7s infinite;
            pointer-events: none;
          }
        `}</style>

        <div className="rounded-2xl p-6 flex flex-col items-center" style={{ background: 'var(--bg-card)' }}>
          <h2 className="text-2xl font-black mb-1" style={{ color: 'var(--text-primary)' }}>Ready to Run?</h2>
          <p className="text-sm mb-10 text-center" style={{ color: 'var(--text-muted)' }}>
            Dynamic warm-up reduces injury risk and improves performance.
          </p>

          {/* Pulsing circle button */}
          <div style={{ position: 'relative', width: 128, height: 128, marginBottom: 28 }}>
            <div className="warmup-ring" />
            <div className="warmup-ring-2" />
            <button
              onClick={() => setWarmUpState('warmup')}
              style={{
                position: 'absolute', inset: 0,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #EAB308 0%, #F97316 100%)',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                color: '#000',
                fontWeight: 900,
                fontSize: 12,
              }}
            >
              <Flame size={34} />
              <span style={{ fontSize: 11, lineHeight: 1, textAlign: 'center' }}>Start{'\n'}Warm-Up</span>
            </button>
          </div>

          <button
            onClick={() => setWarmUpState('done')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 14, padding: '8px 0',
            }}
          >
            Skip warm-up →
          </button>
        </div>
      </>
    )
  }

  // ── Warm-up Steps ─────────────────────────────────────────────────────────
  if (warmUpState === 'warmup') {
    return (
      <div className="rounded-2xl p-6" style={{ background: 'var(--bg-card)' }}>
        <h2 className="text-xl font-black mb-1" style={{ color: 'var(--text-primary)' }}>Dynamic Warm-Up</h2>
        <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
          Complete each movement before you run.
        </p>

        <div className="space-y-3 mb-6">
          {WARM_UP_STEPS.map((step, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl p-3"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
            >
              <div style={{
                width: 30, height: 30, borderRadius: '50%',
                background: 'var(--accent)', color: '#000',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 900, fontSize: 13, flexShrink: 0,
              }}>
                {i + 1}
              </div>
              <span style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 500 }}>{step}</span>
            </div>
          ))}
        </div>

        <button
          onClick={() => setWarmUpState('done')}
          className="w-full rounded-xl py-3 font-bold"
          style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer', fontSize: 16 }}
        >
          Done — Start Run
        </button>
      </div>
    )
  }

  // ── Main Tabbed Content (warmUpState === 'done') ──────────────────────────
  return (
    <>
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>

        {/* Mini-tabs */}
        <div className="flex gap-2 mb-5">
          {[
            { key: 'log',     label: 'Log' },
            { key: 'gps',     label: 'GPS' },
            { key: 'history', label: 'History' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: '5px 18px',
                borderRadius: 999,
                border: activeTab === tab.key
                  ? '1.5px solid var(--accent)'
                  : '1.5px solid var(--border-subtle)',
                background: activeTab === tab.key ? 'var(--accent)' : 'transparent',
                color: activeTab === tab.key ? '#000' : 'var(--text-muted)',
                fontWeight: 700,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Log Tab ─────────────────────────────────────────────────────── */}
        {activeTab === 'log' && (
          <div>
            <p className="text-xs text-center mb-4" style={{ color: 'var(--text-muted)', opacity: 0.75 }}>
              For when your watch dies, app glitched, or you forgot to start — log manually below.
            </p>

            <form onSubmit={onSubmit} className="space-y-4">

              {/* Surface Picker */}
              <div>
                <label className="mb-2 block text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
                  Surface
                </label>
                <div className="flex gap-2">
                  {SURFACE_OPTIONS.map(opt => {
                    const Icon = opt.icon
                    const selected = surface === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setSurface(opt.value)}
                        style={{
                          flex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 5,
                          padding: '10px 4px',
                          borderRadius: 12,
                          border: selected ? '2px solid #EAB308' : '2px solid var(--border-subtle)',
                          background: selected ? 'rgba(234,179,8,0.1)' : 'var(--bg-input)',
                          color: selected ? '#EAB308' : 'var(--text-muted)',
                          cursor: 'pointer',
                          fontSize: 11,
                          fontWeight: 700,
                          transition: 'border-color 0.15s, background 0.15s',
                        }}
                      >
                        <Icon size={20} />
                        <span>{opt.label}</span>
                      </button>
                    )
                  })}
                </div>
                {surface === 'treadmill' && (
                  <p className="mt-2 text-xs font-semibold" style={{ color: '#F97316' }}>
                    GPS disabled for treadmill — enter distance manually.
                  </p>
                )}
              </div>

              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full rounded-xl border px-4 py-3"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />

              <input
                type="number"
                step="0.01"
                min="0"
                required
                placeholder="Distance (miles)"
                value={distance}
                onChange={e => setDistance(e.target.value)}
                className="w-full rounded-xl border px-4 py-3"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />

              <div>
                <input
                  type="text"
                  required
                  placeholder="Duration (e.g. 2 hours 45 minutes, 45:30, 1h30m)"
                  value={duration}
                  onChange={e => setDuration(e.target.value)}
                  onBlur={() => {
                    const sec = parseDuration(duration)
                    if (sec) setDuration(formatDurationDisplay(sec))
                  }}
                  className="w-full rounded-xl border px-4 py-3"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                />
                <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)', opacity: 0.65 }}>
                  Try: 45, 45:30, 1:23:45, 90 minutes, 1hr 30min
                </p>
              </div>

              <textarea
                rows={3}
                placeholder="Route / notes"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="w-full rounded-xl border px-4 py-3"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />

              {/* Creative Effort Bar */}
              <EffortBar effort={effort} setEffort={setEffort} />

              <button
                type="submit"
                disabled={loading || polling}
                className="w-full rounded-xl py-3 font-semibold disabled:opacity-70"
                style={{ background: 'var(--accent)', color: 'black', border: 'none', cursor: 'pointer' }}
              >
                {loading ? 'Logging run...' : 'Save Run'}
              </button>
            </form>

            {(loading || polling) && (
              <div className="mt-4 flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                <div
                  className="h-4 w-4 animate-spin rounded-full border-2"
                  style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
                />
                Getting AI feedback...
              </div>
            )}

            {feedback && (
              <div className="mt-4 rounded-xl p-3" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
                {feedback}
              </div>
            )}
            {error && (
              <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>
            )}
          </div>
        )}

        {/* ── GPS Tab ─────────────────────────────────────────────────────── */}
        {activeTab === 'gps' && (
          <div>
            <div className="rounded-2xl p-5" style={{ background: 'var(--accent)' }}>
              <h2 className="text-2xl font-black text-black mb-1">Start Live Run</h2>
              <p className="text-sm text-black mb-4" style={{ opacity: 0.7 }}>GPS tracking · live pace · auto-saved</p>

              <div className="flex gap-2 mb-4 items-center flex-wrap">
                <span className="text-xs text-black self-center" style={{ opacity: 0.6 }}>Countdown:</span>
                {[0, 3, 5, 10].map(n => (
                  <button
                    key={n}
                    onClick={() => setCountdown(n)}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 8,
                      background: countdown === n ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.1)',
                      color: '#000',
                      fontWeight: 700,
                      fontSize: 12,
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {n === 0 ? 'Off' : `${n}s`}
                  </button>
                ))}
              </div>

              <button
                onClick={() => navigate('/run/active', { state: { countdown } })}
                className="w-full py-4 rounded-xl font-black text-lg"
                style={{ background: '#000', color: '#fff', border: 'none', cursor: 'pointer' }}
              >
                Go
              </button>
            </div>

            <button
              onClick={() => navigate('/run/treadmill')}
              className="w-full mt-3 rounded-xl py-3 font-semibold text-sm"
              style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}
            >
              Treadmill Run instead
            </button>
          </div>
        )}

        {/* ── History Tab ─────────────────────────────────────────────────── */}
        {activeTab === 'history' && (
          <div>
            {runsLoading ? (
              <div className="flex items-center justify-center py-10 gap-2" style={{ color: 'var(--text-muted)' }}>
                <div
                  className="h-4 w-4 animate-spin rounded-full border-2"
                  style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
                />
                Loading runs...
              </div>
            ) : recentRuns.length === 0 ? (
              <p className="text-center py-10 text-sm" style={{ color: 'var(--text-muted)' }}>
                No runs logged yet.
              </p>
            ) : (
              <div className="space-y-2">
                {recentRuns.slice(0, 20).map(run => (
                  <div
                    key={run.id}
                    className="rounded-xl p-3"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>
                          {run.date}
                        </span>
                        <span className="ml-2 text-xs capitalize" style={{ color: 'var(--text-muted)' }}>
                          {run.surface || run.run_surface || run.type || ''}
                        </span>
                      </div>
                      <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>
                        {run.distance_miles ? `${run.distance_miles} mi` : '—'}
                      </span>
                    </div>
                    <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {run.duration_seconds ? formatRunDuration(run.duration_seconds) : ''}
                      {run.perceived_effort ? ` · Effort ${run.perceived_effort}/10` : ''}
                    </div>
                    {run.notes && (
                      <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)', opacity: 0.65 }}>
                        {run.notes}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <Link to="/" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>
          ← Back
        </Link>
      </div>

      {showPostCheckIn && savedRunId && (
        <PostRunCheckIn
          runId={savedRunId}
          onDone={() => { setShowPostCheckIn(false); navigate('/') }}
        />
      )}

      {showRecoveryPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#2a2d3e] bg-[#151823] p-5 text-white">
            <h3 className="text-xl font-black">Great run! Time to recover.</h3>
            <p className="mt-2 text-sm text-slate-300">
              Post-run recovery uses static holds. Hold each stretch for the full duration to target the muscles you just used.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => { setShowRecoveryPrompt(false); navigate('/stretches/session?type=post') }}
                className="flex-1 rounded-xl bg-yellow-500 px-4 py-2 font-bold text-black"
              >
                Start Recovery
              </button>
              <button
                onClick={() => setShowRecoveryPrompt(false)}
                className="flex-1 rounded-xl border border-[#2a2d3e] px-4 py-2 text-slate-300"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
