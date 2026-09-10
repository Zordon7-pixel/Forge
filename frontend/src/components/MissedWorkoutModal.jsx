import React, { useEffect, useState } from 'react'
import api from '../lib/api'
import { phonePlanningClock } from '../lib/planCandidates'
import { useNavigate } from 'react-router'
import { ensureRecordedMissedSession } from '../lib/missedSessionDecision'

const REASONS = [
  { value: 'tired', label: 'Tired / needed rest' },
  { value: 'no_time', label: 'No time' },
  { value: 'didnt_feel_like_it', label: "Didn't feel like it" },
  { value: 'something_came_up', label: 'Something came up' },
  { value: 'weather', label: 'Weather' },
  { value: 'sick', label: 'Sick / injured' },
]

export default function MissedWorkoutModal({ onClose }) {
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const [response, setResponse] = useState('')
  const [loading, setLoading] = useState(false)
  const [options, setOptions] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    api.get('/plans/missed-sessions', { params: phonePlanningClock() }).then(res => {
      if (!cancelled) setOptions(res.data)
    }).catch(err => {
      if (!cancelled) setError(err?.response?.data?.error || 'Unable to load scheduled sessions. Your plan has not changed.')
    })
    return () => { cancelled = true }
  }, [])
  const selected = options?.sessions?.find(item => `${item.date}:${item.sessionId}` === selectedId)
  const retryLoad = async () => {
    setError('')
    try {
      const loaded = await api.get('/plans/missed-sessions', { params: phonePlanningClock() })
      setOptions(loaded.data)
    } catch (err) {
      setError(err?.response?.data?.error || 'Unable to load scheduled sessions. Your plan has not changed.')
    }
  }

  const submit = async () => {
    if (!reason || !selected || !selected.eligible) return
    setLoading(true)
    setError('')
    try {
      const res = await api.post('/runs/missed', { ...phonePlanningClock(), reason,
        scheduled_date: selected.date, session_id: selected.sessionId, session_content_hash: selected.contentHash,
        plan_version: options.plan_version, plan_id: options.plan_id, user_plan_id: options.user_plan_id })
      setResponse(ensureRecordedMissedSession(res).message)
    } catch (error) {
      setError(error?.response?.data?.error || error.message || 'Unable to record this session. Your plan has not changed.')
      if (error?.response?.status === 409) {
        try {
          const refreshed = await api.get('/plans/missed-sessions', { params: phonePlanningClock() })
          setOptions(refreshed.data)
          setSelectedId('')
        } catch (refreshError) {
          setError(refreshError?.response?.data?.error || 'Reconnect to refresh the scheduled sessions. Your plan has not changed.')
        }
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70"
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Record a missed session"
        className="w-full max-w-lg rounded-t-2xl p-5 space-y-3 overflow-y-auto" style={{ background: 'var(--bg-card)', maxHeight: '90dvh' }}>
        <button onClick={onClose} className="ml-auto block p-2 text-sm" aria-label="Close missed session">Close</button>
        {!response ? (
          <>
            <h3 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>Record a missed session</h3>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Choose the session you missed. Recording it does not move workouts or create make-up work.</p>
            <label className="block text-sm">Scheduled session
              <select aria-label="Scheduled session" value={selectedId} onChange={event => setSelectedId(event.target.value)}
                className="w-full p-3 rounded-xl mt-1" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                <option value="">{options ? 'Choose a session' : 'Loading sessions…'}</option>
                {(options?.sessions || []).filter(item => item.eligible).map(item => (
                  <option key={`${item.date}:${item.sessionId}`} value={`${item.date}:${item.sessionId}`}>{item.date} · {item.title}</option>
                ))}
              </select>
            </label>
            {options && !options.sessions?.some(item => item.eligible) && <p className="text-sm">No eligible missed sessions. Completed, future, locked and already-recorded sessions are not changed.</p>}
            {error && <p role="alert" className="text-sm">{error}</p>}
            {error && !options && <button onClick={retryLoad} className="w-full py-3 border rounded-xl">Retry loading sessions</button>}
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
            <button onClick={submit} disabled={!reason || !selected?.eligible || loading}
              className="w-full py-4 rounded-xl font-black text-on-accent"
              style={{ background: reason ? 'var(--accent)' : 'var(--bg-input)', opacity: loading ? 0.6 : 1 }}>
              {loading ? 'Saving…' : 'Mark Session Missed'}
            </button>
          </>
        ) : (
          <>
            <p className="text-base leading-relaxed" style={{ color: 'var(--text-primary)' }}>{response}</p>
            <button onClick={() => { onClose(); navigate('/plan') }} className="w-full py-3 rounded-xl border">
              Review current coaching
            </button>
            <button onClick={onClose} className="w-full py-4 rounded-xl font-black text-on-accent"
              style={{ background: 'var(--accent)' }}>Got it</button>
          </>
        )}
      </div>
    </div>
  )
}
