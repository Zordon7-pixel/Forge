import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'

const FEELINGS = [
  { value: 1, label: 'Exhausted', img: '/checkin/exhausted.png' },
  { value: 2, label: 'Tired',     img: '/checkin/tired.png' },
  { value: 3, label: 'Okay',      img: '/checkin/okay.png' },
  { value: 4, label: 'Good',      img: '/checkin/good.png' },
  { value: 5, label: 'Great',     img: '/checkin/great.png' },
]

const TIME_OPTIONS = [
  { value: 20, label: '20 min' },
  { value: 45, label: '45 min' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '1.5 hrs' },
  { value: 120, label: '2+ hrs' },
]

const LIFE_FLAGS = [
  { value: 'long_shift', label: 'Long shift' },
  { value: 'sore', label: 'Sore' },
  { value: 'traveling', label: 'Traveling' },
  { value: 'sick', label: 'Not well' },
  { value: 'stressed', label: 'Stressed' },
  { value: 'all_good', label: 'All good' },
]

export default function DailyCheckIn({ onComplete }) {
  const navigate = useNavigate()
  const [feeling, setFeeling] = useState(null)
  const [timeAvailable, setTimeAvailable] = useState(null)
  const [lifeFlags, setLifeFlags] = useState([])
  const [saving, setSaving] = useState(false)
  const [adjustment, setAdjustment] = useState(null)
  const [alreadyDone, setAlreadyDone] = useState(false)

  useEffect(() => {
    api.get('/checkin/today').then(r => {
      if (r.data) setAlreadyDone(true)
    }).catch(() => {})
  }, [])

  const toggleFlag = (val) => {
    if (val === 'all_good') { setLifeFlags(['all_good']); return }
    setLifeFlags(prev => {
      const without = prev.filter(f => f !== 'all_good')
      return prev.includes(val) ? without.filter(f => f !== val) : [...without, val]
    })
  }

  const submit = async () => {
    if (!feeling || !timeAvailable) return
    setSaving(true)
    try {
      const res = await api.post('/checkin', { feeling, time_available: timeAvailable, life_flags: lifeFlags })
      if (res.data.adjustment) setAdjustment(res.data.adjustment)
      else { onComplete?.(); navigate('/') }
    } finally { setSaving(false) }
  }

  if (alreadyDone) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center' }}>You've already checked in today</p>
        <button onClick={() => navigate('/')}
          style={{ background: 'var(--accent)', color: '#000', fontWeight: 700, borderRadius: 14, padding: '16px 32px', border: 'none', cursor: 'pointer' }}>
          Go to Dashboard
        </button>
      </div>
    )
  }

  if (adjustment) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 20, textAlign: 'center', maxWidth: 480, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--text-primary)', maxWidth: 320 }}>{adjustment}</p>
        <button onClick={() => { onComplete?.(); navigate('/') }}
          style={{ background: 'var(--accent)', color: '#000', fontWeight: 900, borderRadius: 14, padding: '18px 48px', border: 'none', cursor: 'pointer', fontSize: 16 }}>
          Let's go
        </button>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', padding: '24px 20px', paddingBottom: 100, maxWidth: 480, margin: '0 auto', boxSizing: 'border-box', width: '100%' }}>
      <h1 style={{ fontWeight: 900, fontSize: 26, color: 'var(--text-primary)', marginBottom: 4 }}>Morning Check-In</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 28 }}>3 taps — I'll adjust your plan around your day.</p>

      <div style={{ marginBottom: 24 }}>
        <p style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>How are you feeling?</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {FEELINGS.map(f => (
            <button key={f.value} onClick={() => setFeeling(f.value)}
              style={{
                flex: '1 1 calc(20% - 8px)', minWidth: 60,
                padding: '12px 8px', borderRadius: 12,
                border: `2px solid ${feeling === f.value ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: feeling === f.value ? 'var(--accent-dim)' : 'var(--bg-card)',
                color: feeling === f.value ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 13, cursor: 'pointer', textAlign: 'center',
                transition: 'border-color 0.2s, background 0.2s, color 0.2s',
              }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <p style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>How much time do you have to workout?</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {TIME_OPTIONS.map(t => (
            <button key={t.value} onClick={() => setTimeAvailable(t.value)}
              style={{
                padding: '10px 16px', borderRadius: 12, border: `2px solid ${timeAvailable === t.value ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: timeAvailable === t.value ? 'var(--accent-dim)' : 'var(--bg-card)',
                color: timeAvailable === t.value ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <p style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>Anything going on?</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {LIFE_FLAGS.map(f => (
            <button key={f.value} onClick={() => toggleFlag(f.value)}
              style={{
                padding: '10px 16px', borderRadius: 12, border: `2px solid ${lifeFlags.includes(f.value) ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: lifeFlags.includes(f.value) ? 'var(--accent-dim)' : 'var(--bg-card)',
                color: lifeFlags.includes(f.value) ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <button onClick={submit} disabled={!feeling || !timeAvailable || saving}
        style={{
          width: '100%', background: feeling && timeAvailable ? 'var(--accent)' : 'var(--bg-input)',
          color: '#000', fontWeight: 900, fontSize: 17, borderRadius: 16, padding: '18px', border: 'none', cursor: 'pointer',
          opacity: saving ? 0.6 : 1
        }}>
        {saving ? 'Adjusting your plan...' : 'Done'}
      </button>
    </div>
  )
}
