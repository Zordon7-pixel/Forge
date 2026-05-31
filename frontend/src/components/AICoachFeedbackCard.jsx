export default function AICoachFeedbackCard({ open, loading, feedback, fallback, sessionId, onClose }) {
  if (!open) return null
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

        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl py-2" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>Dismiss</button>
        </div>
      </div>
    </div>
  )
}
