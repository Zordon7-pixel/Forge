import { useState } from 'react'
import api from '../lib/api'

export default function AICoachFeedbackCard({ open, loading, feedback, fallback, sessionId, onClose }) {
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  if (!open) return null

  const saveToJournal = async () => {
    const body = feedback || fallback
    if (!body) return
    const content = [
      body.analysis,
      `Did well: ${body.didWell}`,
      `Next session: ${body.suggestion}`,
      `Recovery: ${body.recovery}`,
    ].filter(Boolean).join('\n')

    setSaving(true)
    setSaveError(null)
    try {
      await api.post('/journal', {
        source: 'ai_feedback',
        content,
        session_id: sessionId || null,
      })
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (err) {
      console.error('Failed to save to journal:', err)
      setSaveError('Could not save — try again')
    } finally {
      setSaving(false)
    }
  }

  const data = feedback || fallback

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full rounded-t-2xl p-5" style={{ background: 'var(--bg-card)', borderTop: '1px solid var(--border-subtle)' }} onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>AI Coach Feedback</h3>
        {loading ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Analyzing your session...</p>
        ) : data ? (
          <div className="space-y-2">
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{data.analysis}</p>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}><strong>Did well:</strong> {data.didWell}</p>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}><strong>Next session:</strong> {data.suggestion}</p>
            <p className="text-sm" style={{ color: 'var(--accent)' }}><strong>Recovery:</strong> {data.recovery}</p>
          </div>
        ) : null}

        {saveError && (
          <p className="text-xs mt-3" style={{ color: '#ef4444' }}>{saveError}</p>
        )}

        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl py-2" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>Dismiss</button>
          <button onClick={saveToJournal} disabled={saving || saveSuccess} className="flex-1 rounded-xl py-2 font-semibold disabled:opacity-50" style={{ background: saveSuccess ? 'var(--bg-input)' : 'var(--accent)', color: saveSuccess ? 'var(--text-muted)' : '#000' }}>
            {saving ? 'Saving...' : saveSuccess ? 'Saved' : 'Save to Journal'}
          </button>
        </div>
      </div>
    </div>
  )
}
