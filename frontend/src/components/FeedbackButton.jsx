import { useEffect, useState } from 'react'
import api from '../lib/api'

const FEEDBACK_TYPES = [
  { value: 'bug', label: 'Bug', icon: 'B' },
  { value: 'suggestion', label: 'Suggestion', icon: 'S' },
  { value: 'praise', label: 'Praise', icon: 'P' }
]

export default function FeedbackButton({ externalOpen, onClose }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [type, setType] = useState('bug')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => { if (externalOpen) setOpen(true) }, [externalOpen])

  function handleClose() {
    setOpen(false)
    setStatus('')
    onClose?.()
  }

  async function submitFeedback(e) {
    e.preventDefault()
    if (!message.trim()) { setStatus("Couldn't send — try again"); return }
    setLoading(true); setStatus('')
    try {
      await api.post('/feedback', { type, message: message.trim(), page: window.location.pathname })
      setStatus("Thanks! We'll look into it.")
      setTimeout(() => { setMessage(''); setType('bug'); handleClose() }, 2000)
    } catch { setStatus("Couldn't send — try again") }
    finally { setLoading(false) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={submitFeedback} className="w-full max-w-md rounded-xl border p-5 shadow-2xl" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
        <h2 className="mb-4 text-lg font-bold">Send Feedback</h2>

        <div className="mb-4 flex flex-wrap gap-2">
          {FEEDBACK_TYPES.map(option => (
            <button key={option.value} type="button" onClick={() => setType(option.value)} className="rounded-lg border px-3 py-2 text-sm"
              style={type === option.value ? { borderColor: 'var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)' } : { borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
              {option.label} {option.icon}
            </button>
          ))}
        </div>

        <textarea rows={5} value={message} onChange={e => setMessage(e.target.value)} className="mb-3 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} placeholder="What happened? What were you trying to do?" required />

        {status && <p className="mb-3 text-sm" style={{ color: status.startsWith('Thanks') ? '#86efac' : 'var(--accent)' }}>{status}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={handleClose} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>Close</button>
          <button type="submit" disabled={loading} className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'black' }}>{loading ? 'Sending…' : 'Submit'}</button>
        </div>
      </form>
    </div>
  )
}
