import React, { useState } from 'react'
import api from '../lib/api'
import { parseDuration, formatDurationDisplay } from '../lib/parseDuration'

export default function EditRunModal({ run, onSave, onClose }) {
  const [distance, setDistance] = useState(String(run.distance_miles || ''))
  const [durationInput, setDurationInput] = useState(formatDurationDisplay(run.duration_seconds))
  const [durationSeconds, setDurationSeconds] = useState(run.duration_seconds || 0)
  const [date, setDate] = useState(run.date || run.created_at?.slice(0, 10) || '')
  const [notes, setNotes] = useState(run.notes || '')
  const [effort, setEffort] = useState(run.perceived_effort || 5)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleDurationBlur = () => {
    const secs = parseDuration(durationInput)
    if (secs) {
      setDurationSeconds(secs)
      setDurationInput(formatDurationDisplay(secs))
      setError('')
    } else if (durationInput) {
      setError('Could not understand that duration. Try "45:00" or "1 hour 30 minutes"')
    }
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const updated = await api.put(`/runs/${run.id}`, {
        date,
        distance_miles: Number(distance),
        duration_seconds: durationSeconds,
        notes,
        perceived_effort: effort
      })
      onSave(updated.data)
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg rounded-t-2xl p-5 space-y-3" style={{ background: 'var(--bg-card)' }}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>Edit Run</h3>
          <button onClick={onClose} className="text-sm px-3 py-1 rounded-lg" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Cancel</button>
        </div>

        {[
          ['Distance (miles)', distance, setDistance, 'decimal-pad'],
          ['Date (YYYY-MM-DD)', date, setDate, 'default']
        ].map(([label, val, setter, kbType]) => (
          <div key={label}>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{label}</label>
            <input
              className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
              value={val}
              onChange={e => setter(e.target.value)}
              inputMode={kbType === 'decimal-pad' ? 'decimal' : undefined}
            />
          </div>
        ))}

        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Duration (any format)</label>
          <input
            className="w-full px-4 py-3 rounded-xl text-sm outline-none"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            value={durationInput}
            onChange={e => setDurationInput(e.target.value)}
            onBlur={handleDurationBlur}
            placeholder="e.g. 2 hours 45 minutes, 45:30, 1h30m"
          />
        </div>

        <div>
          <label className="text-xs mb-2 block" style={{ color: 'var(--text-muted)' }}>Effort: {effort}/10</label>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
              <button
                key={n}
                onClick={() => setEffort(n)}
                className="flex-1 h-8 rounded text-xs font-bold"
                style={{ background: n <= effort ? 'var(--accent)' : 'var(--bg-input)', color: n <= effort ? '#000' : 'var(--text-muted)' }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Notes</label>
          <textarea
            className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
          />
        </div>

        {error && <p className="text-xs" style={{ color: '#ef4444' }}>{error}</p>}

        <button
          onClick={save}
          disabled={saving}
          className="w-full py-4 rounded-xl font-black text-black text-base"
          style={{ background: 'var(--accent)', opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
