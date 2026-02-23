import { useEffect, useState } from 'react'
import api from '../lib/api'

export default function Community() {
  const [sort, setSort] = useState('popular')
  const [target, setTarget] = useState('')
  const [items, setItems] = useState([])

  useEffect(() => {
    api.get('/community/workouts', { params: { sort, target: target || undefined } }).then(r => setItems(r.data?.workouts || [])).catch(() => setItems([]))
  }, [sort, target])

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Community Workouts</h2>
      <div className="flex gap-2">
        {['popular', 'newest'].map(s => <button key={s} onClick={() => setSort(s)} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: sort === s ? 'var(--accent)' : 'var(--bg-input)', color: sort === s ? '#000' : 'var(--text-muted)' }}>{s === 'popular' ? 'Popular' : 'Newest'}</button>)}
        <input value={target} onChange={e => setTarget(e.target.value)} placeholder="By body part" className="rounded-full px-3 py-1 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} />
      </div>
      {items.map(w => (
        <div key={w.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)' }}>
          <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{w.workout_name}</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{w.target} · Used {w.usage_count || 0} times</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{(w.main || []).slice(0,2).map(m => m.name || m).join(' · ')}</p>
          <button onClick={() => api.post(`/community/workouts/${w.id}/save`).catch(() => {})} className="mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--accent)', color: '#000' }}>Save to My Plan</button>
        </div>
      ))}
    </div>
  )
}
