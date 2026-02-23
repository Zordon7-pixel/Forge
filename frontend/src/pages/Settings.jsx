import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import api from '../lib/api'

export default function Settings() {
  const navigate = useNavigate()
  const [distanceUnit, setDistanceUnit] = useState('miles')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.get('/users/settings').then(r => {
      setDistanceUnit(r.data.distance_unit || 'miles')
    }).catch(() => {})
  }, [])

  const save = async (unit) => {
    setDistanceUnit(unit)
    await api.put('/users/settings', { distance_unit: unit }).catch(() => {})
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const card = { background: 'var(--bg-card)', borderRadius: 16, padding: '20px', marginBottom: 16, border: '1px solid var(--border-subtle)' }
  const label = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 12, display: 'block' }

  return (
    <div>
      <h1 style={{ fontWeight: 900, fontSize: 24, color: 'var(--text-primary)', marginBottom: 24 }}>Settings</h1>

      {/* Distance Units */}
      <div style={card}>
        <span style={label}>Distance Units</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {[['miles', 'Miles'], ['km', 'Kilometers']].map(([val, text]) => (
            <button key={val} onClick={() => save(val)}
              style={{
                flex: 1, padding: '14px', borderRadius: 12, border: `2px solid ${distanceUnit === val ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: distanceUnit === val ? 'var(--accent-dim)' : 'var(--bg-input)',
                color: distanceUnit === val ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>{text}</button>
          ))}
        </div>
        {saved && <p style={{ fontSize: 12, color: '#22c55e', marginTop: 10 }}>Saved</p>}
      </div>

      {/* Profile link */}
      <div style={card}>
        <span style={label}>Account</span>
        <button onClick={() => navigate('/profile')}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Edit Profile</span>
          <ChevronRight size={18} style={{ color: 'var(--text-muted)' }} />
        </button>
      </div>

      {/* Notifications (placeholder) */}
      <div style={card}>
        <span style={label}>Notifications</span>
        <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Push notifications — coming soon.</p>
      </div>

      {/* Data */}
      <div style={card}>
        <span style={label}>Data & Privacy</span>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Your data lives on FORGE servers. We never sell your information. Import from Strava and Apple Health coming soon.
        </p>
      </div>

      {/* App version */}
      <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', opacity: 0.5, marginTop: 24 }}>
        FORGE v1.0 · Built to adapt.
      </p>
    </div>
  )
}
