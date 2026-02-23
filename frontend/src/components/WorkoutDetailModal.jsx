import { useState, useEffect } from 'react'
import { X, Brain } from 'lucide-react'
import api from '../lib/api'

function fmtDuration(totalSeconds = 0) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function WorkoutDetailModal({ session, onClose, onFeedbackGenerated }) {
  const [sets, setSets] = useState([])
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState(session.ai_feedback || '')
  const [aiLoading, setAiLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get(`/workouts/${session.id}/sets`).then(res => {
      setSets(res.data.sets || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [session.id])

  const generateFeedback = async () => {
    setAiLoading(true)
    setError('')
    try {
      const res = await api.post(`/workouts/${session.id}/feedback`)
      setFeedback(res.data.feedback)
      if (onFeedbackGenerated) onFeedbackGenerated(session.id, res.data.feedback)
    } catch (e) {
      setError(e.response?.data?.error || 'Could not generate feedback.')
    } finally {
      setAiLoading(false)
    }
  }

  const grouped = {}
  for (const s of sets) {
    if (!grouped[s.exercise_name]) grouped[s.exercise_name] = []
    grouped[s.exercise_name].push(s)
  }

  const date = new Date(session.started_at || session.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const muscleGroups = Array.isArray(session.muscle_groups) ? session.muscle_groups : []

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={onClose}>
      <div className="w-full rounded-t-2xl p-6 pb-10 max-h-[85vh] overflow-y-auto" style={{ background: 'var(--bg-card)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Workout Detail</h2>
          <button onClick={onClose}><X size={20} style={{ color: 'var(--text-muted)' }} /></button>
        </div>
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{date}</p>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Duration</p>
            <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{session.total_seconds ? fmtDuration(session.total_seconds) : '--'}</p>
          </div>
          <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Total Sets</p>
            <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{sets.length}</p>
          </div>
        </div>

        {muscleGroups.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-5">
            {muscleGroups.map(m => (
              <span key={m} className="rounded-full px-3 py-1 text-xs font-semibold capitalize" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{m}</span>
            ))}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>Loading sets...</p>
        ) : Object.keys(grouped).length > 0 ? (
          <div className="space-y-4 mb-5">
            {Object.entries(grouped).map(([exerciseName, exSets]) => (
              <div key={exerciseName} className="rounded-xl p-4" style={{ background: 'var(--bg-input)' }}>
                <p className="font-semibold text-sm mb-3" style={{ color: 'var(--text-primary)' }}>{exerciseName}</p>
                <div className="space-y-2">
                  {exSets.map((s, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Set {s.set_number || i + 1}</span>
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {s.reps ? `${s.reps} reps` : '--'}
                        {s.weight_lbs ? ` @ ${s.weight_lbs} lbs` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>No set data recorded for this session.</p>
        )}

        {session.notes && (
          <div className="rounded-xl p-3 mb-5" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Notes</p>
            <p className="text-sm italic" style={{ color: 'var(--text-primary)' }}>&quot;{session.notes}&quot;</p>
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
                disabled={aiLoading}
                className="w-full py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'var(--accent)', color: '#000' }}
              >
                {aiLoading ? 'Analyzing your workout...' : 'Get AI Feedback'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
