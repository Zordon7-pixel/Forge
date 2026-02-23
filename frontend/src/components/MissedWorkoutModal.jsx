import React, { useState } from 'react'
import api from '../lib/api'

const REASONS = [
  { value: 'tired', label: 'Tired / needed rest' },
  { value: 'no_time', label: 'No time' },
  { value: 'didnt_feel_like_it', label: "Didn't feel like it" },
  { value: 'something_came_up', label: 'Something came up' },
  { value: 'weather', label: 'Weather' },
  { value: 'sick', label: 'Sick / injured' },
]

export default function MissedWorkoutModal({ onClose }) {
  const [reason, setReason] = useState('')
  const [response, setResponse] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    if (!reason) return
    setLoading(true)
    try {
      const res = await api.post('/runs/missed', { reason, scheduled_date: new Date().toISOString().slice(0,10) })
      setResponse(res.data.message)
    } catch {} finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70"
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg rounded-t-2xl p-5 space-y-3" style={{ background: 'var(--bg-card)' }}>
        {!response ? (
          <>
            <h3 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>What happened?</h3>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No judgment — I'll adjust your plan.</p>
            <div className="space-y-2">
              {REASONS.map(r => (
                <button key={r.value} onClick={() => setReason(r.value)}
                  className="w-full p-3 rounded-xl text-left border text-sm font-medium"
                  style={{
                    background: reason === r.value ? 'var(--accent-dim)' : 'var(--bg-input)',
                    borderColor: reason === r.value ? 'var(--accent)' : 'var(--border-subtle)',
                    color: 'var(--text-primary)',
                  }}>
                  {r.label}
                </button>
              ))}
            </div>
            <button onClick={submit} disabled={!reason || loading}
              className="w-full py-4 rounded-xl font-black text-black"
              style={{ background: reason ? 'var(--accent)' : 'var(--bg-input)', opacity: loading ? 0.6 : 1 }}>
              {loading ? 'Adjusting...' : 'Update My Plan'}
            </button>
          </>
        ) : (
          <>
            <p className="text-base leading-relaxed" style={{ color: 'var(--text-primary)' }}>{response}</p>
            <button onClick={onClose} className="w-full py-4 rounded-xl font-black text-black"
              style={{ background: 'var(--accent)' }}>Got it</button>
          </>
        )}
      </div>
    </div>
  )
}
