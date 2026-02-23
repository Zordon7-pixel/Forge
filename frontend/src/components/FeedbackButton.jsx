import { useEffect, useState } from 'react'
import api from '../lib/api'

const FEATURE_CATEGORIES = ['Runs', 'Lifting', 'AI Coach', 'Profile', 'Other']

export default function FeedbackButton({ externalOpen, onClose }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('bug')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [featureText, setFeatureText] = useState('')
  const [featureCategory, setFeatureCategory] = useState('Runs')
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
    const isBug = tab === 'bug'
    const payload = isBug
      ? { type: 'bug', message: description.trim(), severity, page: window.location.pathname }
      : { type: 'feature_request', message: featureText.trim(), category: featureCategory, page: window.location.pathname }

    if (!payload.message) {
      setStatus("Couldn't send — try again")
      return
    }

    setLoading(true)
    setStatus('')
    try {
      await api.post('/feedback', payload)
      setStatus("Thanks! We'll look into it.")
      setTimeout(() => {
        setDescription('')
        setFeatureText('')
        setSeverity('medium')
        setFeatureCategory('Runs')
        handleClose()
      }, 1500)
    } catch {
      setStatus("Couldn't send — try again")
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={submitFeedback} className="w-full max-w-md rounded-xl border p-5 shadow-2xl" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
        <h2 className="mb-4 text-lg font-bold">Send Feedback</h2>

        <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg p-1" style={{ background: 'var(--bg-input)' }}>
          <button type="button" onClick={() => setTab('bug')} className="rounded-md px-3 py-2 text-sm font-semibold" style={tab === 'bug' ? { background: 'var(--accent)', color: '#000' } : { color: 'var(--text-muted)' }}>
            Report an Issue
          </button>
          <button type="button" onClick={() => setTab('feature')} className="rounded-md px-3 py-2 text-sm font-semibold" style={tab === 'feature' ? { background: 'var(--accent)', color: '#000' } : { color: 'var(--text-muted)' }}>
            Suggest a Feature
          </button>
        </div>

        {tab === 'bug' ? (
          <>
            <textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} className="mb-3 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} placeholder="Describe the issue" required />
            <select value={severity} onChange={e => setSeverity(e.target.value)} className="mb-3 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
              <option value="low">Low severity</option>
              <option value="medium">Medium severity</option>
              <option value="high">High severity</option>
            </select>
          </>
        ) : (
          <>
            <textarea rows={4} value={featureText} onChange={e => setFeatureText(e.target.value)} className="mb-3 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} placeholder="What would you like to see?" required />
            <select value={featureCategory} onChange={e => setFeatureCategory(e.target.value)} className="mb-3 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
              {FEATURE_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          </>
        )}

        {status && <p className="mb-3 text-sm" style={{ color: status.startsWith('Thanks') ? '#86efac' : 'var(--accent)' }}>{status}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={handleClose} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>Close</button>
          <button type="submit" disabled={loading} className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'black' }}>{loading ? 'Sending…' : 'Submit'}</button>
        </div>
      </form>
    </div>
  )
}
