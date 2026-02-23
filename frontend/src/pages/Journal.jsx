import { useEffect, useState } from 'react'
import api from '../lib/api'

export default function Journal() {
  const [entries, setEntries] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [content, setContent] = useState('')

  const load = () => api.get('/journal').then(r => setEntries(r.data?.entries || [])).catch(() => setEntries([]))
  useEffect(() => { load() }, [])

  const add = async () => {
    if (!content.trim()) return
    await api.post('/journal', { source: 'manual', content })
    setContent('')
    setShowAdd(false)
    load()
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Journal</h2><button onClick={() => setShowAdd(true)} className="rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--accent)', color: '#000' }}>Add Note</button></div>
      {entries.map(e => <div key={e.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)' }}><p className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(e.created_at).toLocaleString()} · {e.source === 'ai_feedback' ? 'AI Feedback' : 'My Note'}</p><p className="text-sm mt-1 whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{e.content}</p></div>)}
      {showAdd && <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.7)' }}><div className="w-full max-w-md rounded-xl p-4" style={{ background: 'var(--bg-card)' }}><textarea rows={5} value={content} onChange={e => setContent(e.target.value)} className="w-full rounded-lg p-2" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} /><div className="mt-2 flex gap-2"><button onClick={() => setShowAdd(false)} className="flex-1 rounded-lg py-2" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>Cancel</button><button onClick={add} className="flex-1 rounded-lg py-2 font-semibold" style={{ background: 'var(--accent)', color: '#000' }}>Save</button></div></div></div>}
    </div>
  )
}
