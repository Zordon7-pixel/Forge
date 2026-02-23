import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { parseDuration, formatDurationDisplay } from '../lib/parseDuration'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

export default function LogRun() {
  const navigate = useNavigate()
  const [countdown, setCountdown] = useState(3)
  const [surface, setSurface] = useState('outdoor')

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
      const runRes = await api.post('/runs', {
        date,
        type: surface === 'outdoor' ? 'easy' : surface,
        run_surface: surface,
        distance_miles: Number(distance),
        duration_seconds: seconds,
        notes,
        perceived_effort: Number(effort)
      })

      const runId = runRes.data?.id || runRes.data?.run?.id
      if (!runId) {
        setFeedback('Feedback coming soon...')
        setShowRecoveryPrompt(true)
        return
      }

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

  return (
    <>
      <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
        <div className="mb-4 rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3">
          <p className="text-sm font-semibold text-yellow-400">Pre-run = dynamic only.</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            FORGE never recommends static stretching before a run — it can hurt performance.
          </p>
          <Link to="/stretches/session?type=pre" className="mt-2 inline-block text-sm font-semibold text-yellow-400">
            Warm up first →
          </Link>
        </div>

        {/* Run surface selector */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
          {[
            { value: 'outdoor', label: 'Road', img: '/terrain/road.jpg' },
            { value: 'treadmill', label: 'Treadmill', img: '/terrain/treadmill.jpg' },
            { value: 'track', label: 'Track', img: '/terrain/track.jpg' },
            { value: 'trail', label: 'Trail', img: '/terrain/trail.jpg' },
          ].map(opt => (
            <button key={opt.value} onClick={() => setSurface(opt.value)}
              style={{
                padding: 0,
                borderRadius: 12,
                border: `2px solid ${surface === opt.value ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: 'var(--bg-input)',
                color: surface === opt.value ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 11, cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0,
                overflow: 'hidden',
              }}>
              <div style={{ width: '100%', height: 64, overflow: 'hidden', position: 'relative' }}>
                <img src={opt.img} alt={opt.label}
                  style={{ width: '100%', height: '100%', objectFit: 'cover',
                    filter: surface === opt.value ? 'brightness(1)' : 'brightness(0.55)',
                    transition: 'filter 0.2s' }} />
              </div>
              <span style={{ padding: '5px 4px', display: 'block', width: '100%', textAlign: 'center' }}>{opt.label}</span>
            </button>
          ))}
        </div>

        {surface === 'treadmill' ? (
          <button onClick={() => navigate('/run/treadmill')}
            style={{ background: 'var(--accent)', color: '#000', fontWeight: 900, fontSize: 18, borderRadius: 16, padding: '20px', border: 'none', cursor: 'pointer', width: '100%', marginBottom: 20 }}>
            Start Treadmill Run
            <div style={{ fontSize: 13, fontWeight: 400, opacity: 0.7, marginTop: 4 }}>Timer + speed/incline tracking</div>
          </button>
        ) : (
          <div className="rounded-2xl p-5 mb-6" style={{ background: 'var(--accent)' }}>
            <h2 className="text-2xl font-black text-black mb-1">Start Live Run</h2>
            <p className="text-sm text-black opacity-70 mb-4">GPS tracking · live pace · auto-saved</p>

            <div className="flex gap-2 mb-4 items-center flex-wrap">
              <span className="text-xs text-black opacity-60 self-center">Countdown:</span>
              {[0, 3, 5, 10].map(n => (
                <button
                  key={n}
                  onClick={() => setCountdown(n)}
                  className="px-3 py-1 rounded-lg text-xs font-bold"
                  style={{ background: countdown === n ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.1)', color: '#000' }}
                >
                  {n === 0 ? 'Off' : `${n}s`}
                </button>
              ))}
            </div>

            <button
              onClick={() => navigate('/run/active', { state: { countdown } })}
              className="w-full py-4 rounded-xl bg-black text-white font-black text-lg"
            >
              Go
            </button>
          </div>
        )}

        <div className="opacity-70">
          <p className="text-xs text-center mb-3 font-medium" style={{ color: 'var(--text-muted)' }}>
            For when your watch dies, app glitched, or you forgot to start — log manually below.
          </p>

          <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>Manual Log</h3>
          <form onSubmit={onSubmit} className="space-y-4">
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
            <input type="number" step="0.01" min="0" required placeholder="Distance (miles)" value={distance} onChange={e => setDistance(e.target.value)} className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
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
            <p className="-mt-2 text-xs" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>Try: 45, 45:30, 1:23:45, 90 minutes, 1hr 30min</p>
            <textarea rows={4} placeholder="Route / notes" value={notes} onChange={e => setNotes(e.target.value)} className="w-full rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />

            <div>
              <label className="mb-2 block text-sm" style={{ color: 'var(--text-muted)' }}>Effort: {effort}/10</label>
              <input type="range" min="1" max="10" value={effort} onChange={e => setEffort(e.target.value)} className="w-full accent-yellow-500" />
            </div>

            <button type="submit" disabled={loading || polling} className="w-full rounded-xl py-3 font-semibold disabled:opacity-70" style={{ background: 'var(--accent)', color: 'black' }}>
              {loading ? 'Logging run...' : 'Save Run'}
            </button>
          </form>
        </div>

        {(loading || polling) && (
          <div className="mt-4 flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
            Getting AI feedback...
          </div>
        )}

        {feedback && <div className="mt-4 rounded-xl p-3" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{feedback}</div>}
        {error && <p className="mt-3 text-sm" style={{ color: 'var(--accent)' }}>{error}</p>}

        <Link to="/" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>← Back</Link>
      </div>

      {showRecoveryPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#2a2d3e] bg-[#151823] p-5 text-white">
            <h3 className="text-xl font-black">Great run! Time to recover.</h3>
            <p className="mt-2 text-sm text-slate-300">
              Post-run recovery uses static holds. Hold each stretch for the full duration to target the muscles you just used.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  setShowRecoveryPrompt(false)
                  navigate('/stretches/session?type=post')
                }}
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
