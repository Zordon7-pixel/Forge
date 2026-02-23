import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'

export default function Settings() {
  const navigate = useNavigate()
  const { units, setUnits } = useUnits()
  const [distanceUnit, setDistanceUnit] = useState('miles')
  const [saved, setSaved] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState(null)

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

  const saveUnits = async (newUnits) => {
    await setUnits(newUnits)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const card = { background: 'var(--bg-card)', borderRadius: 16, padding: '20px', marginBottom: 16, border: '1px solid var(--border-subtle)' }
  const label = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 12, display: 'block' }

  return (
    <div>
      <h1 style={{ fontWeight: 900, fontSize: 24, color: 'var(--text-primary)', marginBottom: 24 }}>Settings</h1>

      {/* Units System */}
      <div style={card}>
        <span style={label}>Measurement System</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {[['imperial', 'Imperial'], ['metric', 'Metric']].map(([val, text]) => (
            <button key={val} onClick={() => saveUnits(val)}
              style={{
                flex: 1, padding: '14px', borderRadius: 12, border: `2px solid ${units === val ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: units === val ? 'var(--accent-dim)' : 'var(--bg-input)',
                color: units === val ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>{text}</button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          {units === 'imperial' ? 'Miles, lbs, °F' : 'Kilometers, kg, °C'}
        </p>
        {saved && <p style={{ fontSize: 12, color: '#22c55e', marginTop: 10 }}>Saved</p>}
      </div>

      {/* Distance Units (legacy) */}
      <div style={card}>
        <span style={label}>Distance Units (Legacy)</span>
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

      <div style={card}>
        <span style={label}>Import Activity</span>
        <input
          type="file"
          accept=".gpx,.json"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setUploading(true)
            setUploadStatus(null)
            const form = new FormData()
            form.append('file', file)
            try {
              const res = await api.post('/watch-sync/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } })
              setUploadStatus({ ok: true, text: res.data?.message || 'Activity imported successfully' })
            } catch (err) {
              setUploadStatus({ ok: false, text: "We couldn't parse this file. Supported: GPX, Garmin JSON export" })
            } finally {
              setUploading(false)
            }
          }}
          style={{ width: '100%', fontSize: 13, color: 'var(--text-muted)' }}
        />
        {uploading && <p style={{ fontSize: 12, marginTop: 10, color: 'var(--text-muted)' }}>Uploading...</p>}
        {uploadStatus && (
          <p style={{ fontSize: 12, marginTop: 10, color: uploadStatus.ok ? '#22c55e' : '#ef4444' }}>{uploadStatus.text}</p>
        )}
      </div>

      {/* App version */}
      <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', opacity: 0.5, marginTop: 24 }}>
        FORGE v1.0 · Built to adapt.
      </p>
    </div>
  )
}
