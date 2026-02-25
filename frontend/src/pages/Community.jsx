import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Heart } from 'lucide-react'
import api from '../lib/api'

const QUOTES = [
  'The body achieves what the mind believes.',
  'Small daily progress creates big race-day results.',
  'Discipline beats motivation on hard days.',
  'One workout does not define you. Consistency does.',
  'Show up today. Future you is watching.',
]

export default function Community() {
  const [activeTab, setActiveTab] = useState('feed')

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Community</h2>
      <div className="flex gap-2 flex-wrap">
        {[
          { key: 'feed', label: 'Feed' },
          { key: 'workouts', label: 'Workouts' },
          { key: 'routes', label: 'Routes' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="rounded-full px-3 py-1 text-xs font-semibold"
            style={{ background: activeTab === tab.key ? 'var(--accent)' : 'var(--bg-input)', color: activeTab === tab.key ? '#000' : 'var(--text-muted)' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'feed' ? <FeedTab /> : activeTab === 'workouts' ? <WorkoutsTab /> : <RoutesTab />}
    </div>
  )
}

function FeedTab() {
  const navigate = useNavigate()
  const [posts, setPosts] = useState([])
  const [highlights, setHighlights] = useState([])

  useEffect(() => {
    api.get('/community/posts').then((r) => setPosts(r.data?.posts || [])).catch(() => setPosts([]))
    Promise.all([
      api.get('/runs').catch(() => ({ data: { runs: [] } })),
      api.get('/workouts').catch(() => ({ data: { sessions: [] } })),
    ]).then(([runsRes, workoutsRes]) => {
      const runs = (runsRes.data?.runs || []).slice(0, 3).map((r) => ({
        id: `run-${r.id}`,
        title: `Run · ${Number(r.distance_miles || 0).toFixed(2)} mi`,
        sub: r.date || r.created_at,
      }))
      const lifts = (workoutsRes.data?.sessions || []).slice(0, 2).map((s) => ({
        id: `lift-${s.id}`,
        title: `Lift · ${Math.round((s.total_seconds || 0) / 60)} min`,
        sub: s.started_at,
      }))
      setHighlights([...runs, ...lifts])
    }).catch(() => setHighlights([]))
  }, [])

  if (posts.length === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl p-4" style={{ background: '#1a1d2e', border: '1px solid #2a2d3e' }}>
          <p className="text-sm font-semibold" style={{ color: '#EAB308' }}>Inspiration Mode</p>
          <div className="space-y-2 mt-3">
            {QUOTES.slice(0, 4).map((q, idx) => (
              <p key={idx} className="text-sm" style={{ color: 'var(--text-primary)' }}>&quot;{q}&quot;</p>
            ))}
          </div>
          <button
            onClick={() => navigate('/log-run')}
            className="mt-4 rounded-lg px-3 py-2 text-xs font-bold"
            style={{ background: '#EAB308', color: '#0f1117' }}
          >
            Be the first to share
          </button>
        </div>

        <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Your Highlights</p>
          <div className="space-y-2 mt-3">
            {highlights.map((h) => (
              <div key={h.id} className="rounded-lg p-2" style={{ background: 'var(--bg-input)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{h.title}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(h.sub).toLocaleDateString()}</p>
              </div>
            ))}
            {highlights.length === 0 && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No recent workouts yet.</p>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {posts.map((p) => (
        <div key={p.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{p.title}</p>
          {p.body && <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{p.body}</p>}
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            by {p.user_name || 'Athlete'} · {new Date(p.created_at).toLocaleDateString()}
          </p>
        </div>
      ))}
    </div>
  )
}

function WorkoutsTab() {
  const [sort, setSort] = useState('popular')
  const [target, setTarget] = useState('')
  const [items, setItems] = useState([])

  useEffect(() => {
    api
      .get('/community/workouts', { params: { sort, target: target || undefined } })
      .then(r => setItems(r.data?.workouts || []))
      .catch(() => setItems([]))
  }, [sort, target])

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {['popular', 'newest'].map(s => (
          <button
            key={s}
            onClick={() => setSort(s)}
            className="rounded-full px-3 py-1 text-xs font-semibold"
            style={{ background: sort === s ? 'var(--accent)' : 'var(--bg-input)', color: sort === s ? '#000' : 'var(--text-muted)' }}
          >
            {s === 'popular' ? 'Popular' : 'Newest'}
          </button>
        ))}
        <input
          value={target}
          onChange={e => setTarget(e.target.value)}
          placeholder="By body part"
          className="rounded-full px-3 py-1 text-xs"
          style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
        />
      </div>
      {items.map(w => (
        <div key={w.id} className="rounded-xl p-3" style={{ background: 'var(--bg-card)' }}>
          <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{w.workout_name}</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{w.target} · Used {w.usage_count || 0} times</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{(w.main || []).slice(0, 2).map(m => m.name || m).join(' · ')}</p>
          <button
            onClick={() => api.post(`/community/workouts/${w.id}/save`).catch(() => {})}
            className="mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold"
            style={{ background: 'var(--accent)', color: '#000' }}
          >
            Save to My Plan
          </button>
        </div>
      ))}
      {items.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No workouts found yet.</p>
      )}
    </div>
  )
}

function RoutesTab() {
  const [routes, setRoutes] = useState([])
  const [sort, setSort] = useState('newest')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    api
      .get('/routes', { params: { sort: sort === 'popular' ? 'popular' : 'newest' } })
      .then(r => setRoutes(r.data?.routes || []))
      .catch(() => setRoutes([]))
      .finally(() => setLoading(false))
  }, [sort])

  const handleLike = async (routeId) => {
    try {
      const res = await api.post(`/routes/${routeId}/like`)
      setRoutes(prev => prev.map(route => route.id === routeId ? { ...route, liked: res.data?.liked, likes_count: res.data?.likes_count ?? route.likes_count } : route))
    } catch (err) {
      console.error('Failed to toggle like', err)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {['newest', 'popular'].map(option => (
          <button
            key={option}
            onClick={() => setSort(option)}
            className="rounded-full px-3 py-1 text-xs font-semibold"
            style={{ background: sort === option ? 'var(--accent)' : 'var(--bg-input)', color: sort === option ? '#000' : 'var(--text-muted)' }}
          >
            {option === 'newest' ? 'Newest' : 'Popular'}
          </button>
        ))}
      </div>
      {loading && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading routes...</p>}
      {!loading && routes.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No shared routes yet. Be the first to post one!</p>}
      {routes.map(route => (
        <RouteCard key={route.id} route={route} onLike={handleLike} />
      ))}
    </div>
  )
}

function RouteCard({ route, onLike }) {
  const fmtPace = (secs) => {
    if (!secs) return '--'
    const mins = Math.floor(secs / 60)
    const s = Math.round(secs % 60)
    return `${mins}:${String(s).padStart(2, '0')} /mi`
  }

  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 16, padding: 16,
      border: '1px solid var(--border-subtle)', marginBottom: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{route.title}</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0' }}>
            by {route.runner_name || 'Athlete'} {route.city ? `· ${route.city}` : ''}
          </p>
        </div>
        <button
          onClick={() => onLike(route.id)}
          style={{
            background: route.liked ? 'rgba(234,179,8,0.15)' : 'var(--bg-input)',
            border: `1px solid ${route.liked ? '#EAB308' : 'var(--border-subtle)'}`,
            borderRadius: 8, padding: '4px 10px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <Heart size={14} color={route.liked ? '#EAB308' : 'var(--text-muted)'} fill={route.liked ? '#EAB308' : 'none'} />
          <span style={{ fontSize: 12, color: route.liked ? '#EAB308' : 'var(--text-muted)' }}>{route.likes_count}</span>
        </button>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
        <div>
          <p style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>{Number(route.distance_miles || 0).toFixed(2)}</p>
          <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: 0 }}>miles</p>
        </div>
        {route.avg_pace && (
          <div>
            <p style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>{fmtPace(route.avg_pace)}</p>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: 0 }}>avg pace</p>
          </div>
        )}
        {route.surface && (
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', margin: '4px 0 0', textTransform: 'capitalize' }}>{route.surface}</p>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: 0 }}>surface</p>
          </div>
        )}
      </div>

      {route.route_coords && route.route_coords.length >= 2 && (
        <RouteMapPreview coords={route.route_coords} />
      )}
    </div>
  )
}

function RouteMapPreview({ coords }) {
  if (!coords || coords.length === 0) return null
  const normalized = coords.map((c) => {
    if (Array.isArray(c)) return { lat: c[0], lon: c[1] }
    return { lat: Number(c.lat), lon: Number(c.lon) }
  })
  const lats = normalized.map(c => c.lat)
  const lons = normalized.map(c => c.lon)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const pad = 10
  const w = 280, h = 100

  const toX = lon => pad + ((lon - minLon) / (maxLon - minLon || 1)) * (w - pad * 2)
  const toY = lat => pad + ((maxLat - lat) / (maxLat - minLat || 1)) * (h - pad * 2)

  const pathD = normalized.map((c, i) => `${i === 0 ? 'M' : 'L'}${toX(c.lon).toFixed(1)},${toY(c.lat).toFixed(1)}`).join(' ')

  return (
    <div style={{ borderRadius: 10, overflow: 'hidden', background: '#111', marginTop: 8 }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 100, display: 'block' }}>
        <path d={pathD} fill="none" stroke="#EAB308" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={toX(normalized[0].lon)} cy={toY(normalized[0].lat)} r="4" fill="#22c55e" />
        <circle cx={toX(normalized[normalized.length - 1].lon)} cy={toY(normalized[normalized.length - 1].lat)} r="4" fill="#ef4444" />
      </svg>
    </div>
  )
}
