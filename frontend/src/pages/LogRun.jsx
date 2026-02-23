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
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save run. Check your connection and try again.')
    } finally {
      setLoading(false)
      setPolling(false)
    }
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      {/* Run surface selector */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { value: 'outdoor', label: 'Outdoor', icon: '🛤' },
          { value: 'treadmill', label: 'Treadmill', icon: '⚙️' },
          { value: 'track', label: 'Track', icon: '🏟' },
          { value: 'trail', label: 'Trail', icon: '🌲' },
        ].map(opt => (
          <button key={opt.value} onClick={() => setSurface(opt.value)}
            style={{
              padding: '10px 4px',
              borderRadius: 12,
              border: `2px solid ${surface === opt.value ? 'var(--accent)' : 'var(--border-subtle)'}`,
              background: surface === opt.value ? 'var(--accent-dim)' : 'var(--bg-input)',
              color: surface === opt.value ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: 700, fontSize: 11, cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            }}>
            <span style={{ fontSize: 18 }}>{opt.icon}</span>
            <span>{opt.label}</span>
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
  )
}
