import { useState, useEffect, useRef } from 'react'
import { X, Send } from 'lucide-react'
import api from '../lib/api'

export default function CommentSheet({ activityId, activityType, onClose }) {
  const [comments, setComments] = useState([])
  const [input, setInput] = useState('')
  const [posting, setPosting] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    api.get(`/social/${activityType}/${activityId}/comments`).then(r => {
      setComments(r.data.comments || [])
    })
  }, [activityId, activityType])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [comments])

  const post = async () => {
    if (!input.trim()) return
    setPosting(true)
    try {
      const r = await api.post(`/social/${activityType}/${activityId}/comments`, { content: input.trim() })
      setComments(prev => [...prev, r.data.comment])
      setInput('')
    } catch {
      // no-op
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={onClose}>
      <div className="w-full rounded-t-2xl flex flex-col" style={{ background: 'var(--bg-card)', maxHeight: '70vh' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <span className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>Comments</span>
          <button onClick={onClose}><X size={18} style={{ color: 'var(--text-muted)' }} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
          {comments.length === 0 && (
            <p className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>No comments yet. Be the first.</p>
          )}
          {comments.map(c => (
            <div key={c.id} className="flex gap-3">
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 11, color: '#000', flexShrink: 0 }}>
                {(c.user_name || 'A')[0].toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{c.user_name}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(c.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>{c.content}</p>
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="px-4 py-3 border-t flex gap-2 items-center" style={{ borderColor: 'var(--border-subtle)' }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && post()}
            placeholder="Add a comment..."
            maxLength={280}
            className="flex-1 rounded-xl px-3 py-2 text-sm"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
          />
          <button onClick={post} disabled={posting || !input.trim()} style={{ background: 'var(--accent)', border: 'none', borderRadius: 10, padding: '8px 14px', cursor: 'pointer' }}>
            <Send size={14} color="#000" />
          </button>
        </div>
      </div>
    </div>
  )
}
