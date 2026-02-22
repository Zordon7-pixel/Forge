import { useState } from 'react'
import api from '../lib/api'

const FEEDBACK_TYPES = [
  { value: 'bug', label: 'Bug', icon: '🐛' },
  { value: 'suggestion', label: 'Suggestion', icon: '💡' },
  { value: 'praise', label: 'Praise', icon: '⭐' }
]

export default function FeedbackButton() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [type, setType] = useState('bug')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')

  async function submitFeedback(e) {
    e.preventDefault()
    if (!message.trim()) {
      setStatus("Couldn't send — try again")
      return
    }

    setLoading(true)
    setStatus('')

    try {
      await api.post('/feedback', {
        type,
        message: message.trim(),
        page: window.location.pathname
      })

      setStatus("Thanks! We'll look into it 🙌")
      setTimeout(() => {
        setOpen(false)
        setMessage('')
        setType('bug')
        setStatus('')
      }, 2000)
    } catch (e2) {
      setStatus("Couldn't send — try again")
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-24 left-6 z-50 flex h-12 w-12 items-center justify-center rounded-full text-xl text-white shadow-lg"
        style={{ background: '#f97316' }}
        aria-label="Send Feedback"
      >
        💬
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={submitFeedback}
            className="w-full max-w-md rounded-xl border p-5 text-white shadow-2xl"
            style={{ background: '#1a1d2e', borderColor: '#2a2d3e' }}
          >
            <h2 className="mb-4 text-lg font-bold">Send Feedback</h2>

            <label className="mb-2 block text-sm text-gray-300">Type</label>
            <div className="mb-4 flex flex-wrap gap-2">
              {FEEDBACK_TYPES.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setType(option.value)}
                  className="rounded-lg border px-3 py-2 text-sm"
                  style={{
                    borderColor: type === option.value ? '#f97316' : '#2a2d3e',
                    background: type === option.value ? 'rgba(249, 115, 22, 0.2)' : '#111425'
                  }}
                >
                  {option.label} {option.icon}
                </button>
              ))}
            </div>

            <label className="mb-2 block text-sm text-gray-300">What happened? What were you trying to do?</label>
            <textarea
              rows={5}
              value={message}
              onChange={e => setMessage(e.target.value)}
              className="mb-3 w-full rounded-lg border bg-[#111425] px-3 py-2 text-sm"
              style={{ borderColor: '#2a2d3e' }}
              placeholder="Tell us what happened..."
              required
            />

            {status && (
              <p className={`mb-3 text-sm ${status.startsWith('Thanks') ? 'text-green-300' : 'text-violet-300'}`}>{status}</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setStatus('')
                }}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{ borderColor: '#2a2d3e' }}
              >
                Close
              </button>
              <button
                type="submit"
                disabled={loading}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ background: '#f97316' }}
              >
                {loading ? 'Sending…' : 'Submit'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
