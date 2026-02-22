import { useEffect, useState } from 'react'
import api from '../lib/api'

export default function HelpDesk({ externalOpen, onClose }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [healing, setHealing] = useState(false)
  const [diagnostics, setDiagnostics] = useState(null)
  const [actions, setActions] = useState([])
  const [error, setError] = useState('')

  useEffect(() => { if (externalOpen) setOpen(true) }, [externalOpen])
  useEffect(() => { if (open) fetchDiagnostics() }, [open])

  function handleClose() { setOpen(false); onClose?.() }

  async function fetchDiagnostics() {
    setLoading(true); setError(''); setActions([])
    try {
      const { data } = await api.get('/diagnostics')
      setDiagnostics(data)
    } catch (e) {
      setDiagnostics(null)
      setError(e?.response?.data?.error || 'Failed to load diagnostics')
    } finally { setLoading(false) }
  }

  async function runAutoFix() {
    setHealing(true); setError('')
    try {
      const { data } = await api.post('/diagnostics/heal')
      setActions(data?.actions || [])
      await fetchDiagnostics()
    } catch (e) {
      setError(e?.response?.data?.error || 'Auto-fix failed')
    } finally { setHealing(false) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-xl border p-5 shadow-2xl" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">System Health</h2>
          {!loading && diagnostics && <span className="text-sm font-medium" style={{ color: diagnostics.ok ? '#22c55e' : '#ef4444' }}>{diagnostics.ok ? 'All systems healthy 🟢' : 'Issues detected 🔴'}</span>}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-transparent" style={{ borderTopColor: 'var(--accent)' }} /></div>
        ) : (
          <>
            {error && <div className="mb-4 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)' }}>{error}</div>}
            <div className="mb-4 grid gap-2">
              {(diagnostics?.checks || []).map(check => (
                <div key={check.name} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
                  <div className="text-sm">
                    <div className="font-medium">{check.name}</div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{check.detail}</div>
                  </div>
                  <div>{check.ok ? '✅' : '❌'}</div>
                </div>
              ))}
            </div>
            {actions.length > 0 && (
              <div className="mb-4 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
                <div className="mb-1 text-sm font-semibold">Actions taken</div>
                <ul className="list-disc space-y-1 pl-5 text-xs" style={{ color: 'var(--text-muted)' }}>{actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={handleClose} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>Close</button>
              <button onClick={runAutoFix} disabled={healing} className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'black' }}>{healing ? 'Running…' : 'Run Auto-Fix'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
