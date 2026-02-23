import { useState } from 'react'
import { X, Brain } from 'lucide-react'
import api from '../lib/api'

function fmtDuration(totalSeconds = 0) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0 && s > 0) return `${m}m ${s}s`
  return `${m}m`
}

function fmtPace(durationSeconds, distance) {
  if (!durationSeconds || !distance) return '--'
  const pace = durationSeconds / 60 / distance
  const mins = Math.floor(pace)
  const secs = Math.round((pace - mins) * 60)
  return `${mins}:${String(secs).padStart(2, '0')} /mi`
}

const EFFORT_LABELS = ['', 'Very Easy', 'Easy', 'Easy-Moderate', 'Moderate', 'Moderate-Hard', 'Hard', 'Hard', 'Very Hard', 'Very Hard', 'Max']
const ZONES = [
  { key: 'Z1', min: 0.5, max: 0.6, name: 'Recovery', color: '#6B7280' },
  { key: 'Z2', min: 0.6, max: 0.7, name: 'Aerobic Base', color: '#3B82F6' },
  { key: 'Z3', min: 0.7, max: 0.8, name: 'Tempo', color: '#22C55E' },
  { key: 'Z4', min: 0.8, max: 0.9, name: 'Threshold', color: '#EAB308' },
  { key: 'Z5', min: 0.9, max: 1.01, name: 'Max Effort', color: '#EF4444' },
]

export default function RunDetailModal({ run, onClose, onFeedbackGenerated }) {
  const [feedback, setFeedback] = useState(run.ai_feedback || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const generateFeedback = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.post(`/runs/${run.id}/feedback`)
      setFeedback(res.data.feedback)
      if (onFeedbackGenerated) onFeedbackGenerated(run.id, res.data.feedback)
    } catch (e) {
      setError(e.response?.data?.error || 'Could not generate feedback.')
    } finally {
      setLoading(false)
    }
  }

  const date = new Date(run.date || run.created_at).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const hr = run.avg_hr || run.avg_heart_rate || null
  const maxHr = run.max_heart_rate || 190
  const hrPct = hr && maxHr ? hr / maxHr : null
  const zone = hrPct ? (ZONES.find(z => hrPct >= z.min && hrPct < z.max) || ZONES[4]) : null

  const stats = [
    { label: 'Distance', value: run.distance_miles ? `${Number(run.distance_miles).toFixed(2)} mi` : '--' },
    { label: 'Duration', value: run.duration_seconds ? fmtDuration(run.duration_seconds) : '--' },
    { label: 'Pace', value: fmtPace(run.duration_seconds, run.distance_miles) },
    { label: 'Calories', value: run.calories ? `${run.calories} cal` : '--' },
    { label: 'Effort', value: run.perceived_effort ? `${run.perceived_effort}/10 - ${EFFORT_LABELS[run.perceived_effort] || ''}` : '--' },
    { label: 'Surface', value: run.surface || run.run_type || '--' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={onClose}>
      <div className="w-full rounded-t-2xl p-6 pb-10 max-h-[85vh] overflow-y-auto" style={{ background: 'var(--bg-card)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Run Detail</h2>
          <button onClick={onClose}><X size={20} style={{ color: 'var(--text-muted)' }} /></button>
        </div>
        <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>{date}</p>

        <div className="grid grid-cols-2 gap-3 mb-5">
          {stats.map(({ label, value }) => (
            <div key={label} className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
              <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{value}</p>
            </div>
          ))}
        </div>

        {zone && (
          <div className="rounded-xl p-3 mb-5" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Heart Rate Zone</p>
            <div className="flex items-center gap-2"><p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{hr} bpm</p><span className="rounded-full px-2 py-1 text-xs" style={{ background: `${zone.color}22`, color: zone.color }}>{zone.key} · {zone.name}</span></div>
            <div className="mt-2 h-1.5 rounded-full" style={{ background: 'var(--bg-base)' }}><div className="h-full rounded-full" style={{ width: `${Math.min(100, hrPct * 100)}%`, background: zone.color }} /></div>
          </div>
        )}

        {run.notes && (
          <div className="rounded-xl p-3 mb-5" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Notes</p>
            <p className="text-sm italic" style={{ color: 'var(--text-primary)' }}>&quot;{run.notes}&quot;</p>
          </div>
        )}

        <div className="rounded-xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Brain size={16} style={{ color: 'var(--accent)' }} />
            <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>AI Coach Feedback</span>
          </div>

          {feedback ? (
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{feedback}</p>
          ) : (
            <>
              {error && <p className="text-xs mb-2" style={{ color: '#ef4444' }}>{error}</p>}
              <button
                onClick={generateFeedback}
                disabled={loading}
                className="w-full py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'var(--accent)', color: '#000' }}
              >
                {loading ? 'Analyzing your run...' : 'Get AI Feedback'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
