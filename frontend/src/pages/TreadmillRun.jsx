import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'

const C = { accent: '#EAB308', card: 'var(--bg-card)', input: 'var(--bg-input)', muted: 'var(--text-muted)', primary: 'var(--text-primary)' }

function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

export default function TreadmillRun() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('idle') // idle | running | paused | done
  const [elapsed, setElapsed] = useState(0)
  const [distance, setDistance] = useState('')
  const [speed, setSpeed] = useState('')
  const [incline, setIncline] = useState('0')
  const [effort, setEffort] = useState(5)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const timerRef = useRef(null)

  useEffect(() => () => clearInterval(timerRef.current), [])

  const start = () => {
    setStatus('running')
    timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
  }

  const pause = () => {
    setStatus('paused')
    clearInterval(timerRef.current)
  }

  const resume = () => {
    setStatus('running')
    timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
  }

  const finish = () => {
    clearInterval(timerRef.current)
    setStatus('done')
  }

  const save = async () => {
    if (!distance) return
    setSaving(true)
    try {
      await api.post('/runs', {
        date: new Date().toISOString().slice(0, 10),
        type: 'treadmill',
        run_surface: 'treadmill',
        distance_miles: Number(distance),
        duration_seconds: elapsed,
        notes: notes || `Treadmill run. Speed: ${speed || '?'} mph, Incline: ${incline}%.`,
        perceived_effort: effort,
        treadmill_speed: Number(speed) || 0,
        incline_pct: Number(incline) || 0,
      })
      setFeedback('Run saved!')
      setTimeout(() => navigate('/'), 1500)
    } catch (e) {
      setFeedback('Could not save run.')
    } finally { setSaving(false) }
  }

  const livePace = speed && Number(speed) > 0
    ? (() => { const p = 60 / Number(speed); const m = Math.floor(p); const s = Math.round((p - m) * 60); return `${m}:${String(s).padStart(2, '0')}/mi` })()
    : '--:--/mi'

  const estimatedDist = speed && Number(speed) > 0 && elapsed > 0
    ? ((Number(speed) * elapsed) / 3600).toFixed(2)
    : null

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)', paddingBottom: 100 }}>
      <div style={{ padding: '16px 16px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => navigate(-1)}
          style={{ color: 'var(--text-muted)', background: 'var(--bg-input)', border: 'none', borderRadius: 10, padding: '8px 12px', cursor: 'pointer', fontSize: 14 }}>
          ← Back
        </button>
        <h1 style={{ fontWeight: 900, fontSize: 22, margin: 0 }}>Treadmill Run</h1>
      </div>

      {status === 'idle' && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 16 }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>Set from treadmill display (optional)</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>Speed (mph)</label>
                <input value={speed} onChange={e => setSpeed(e.target.value)} type="number" step="0.1" placeholder="6.5"
                  style={{ width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '12px', fontSize: 16, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>Incline (%)</label>
                <input value={incline} onChange={e => setIncline(e.target.value)} type="number" step="0.5" placeholder="0"
                  style={{ width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '12px', fontSize: 16, boxSizing: 'border-box' }} />
              </div>
            </div>
            {speed && <p style={{ color: C.accent, fontSize: 13, marginTop: 8 }}>Pace: {livePace}</p>}
          </div>

          <button onClick={start}
            style={{ background: C.accent, color: '#000', fontWeight: 900, fontSize: 18, borderRadius: 16, padding: '20px', border: 'none', cursor: 'pointer' }}>
            Start Treadmill Run
          </button>
        </div>
      )}

      {(status === 'running' || status === 'paused') && (
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
          <p style={{ color: C.accent, fontSize: 72, fontWeight: 900, fontFamily: 'monospace', margin: 0 }}>{fmtTime(elapsed)}</p>
          <div style={{ display: 'flex', gap: 40 }}>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>{estimatedDist || distance || '--'}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Miles</p>
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>{speed ? `${speed} mph` : '--'}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Speed</p>
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>{incline}%</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Incline</p>
            </div>
          </div>

          <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: 14, width: '100%', boxSizing: 'border-box' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>Update treadmill settings</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input value={speed} onChange={e => setSpeed(e.target.value)} placeholder="Speed mph" type="number" step="0.1"
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px', fontSize: 14 }} />
              <input value={incline} onChange={e => setIncline(e.target.value)} placeholder="Incline %" type="number" step="0.5"
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px', fontSize: 14 }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, width: '100%' }}>
            {status === 'running' ? (
              <button onClick={pause}
                style={{ flex: 1, background: 'rgba(255,255,255,0.1)', color: '#fff', fontWeight: 700, fontSize: 16, borderRadius: 14, padding: '18px', border: 'none', cursor: 'pointer' }}>
                Pause
              </button>
            ) : (
              <button onClick={resume}
                style={{ flex: 1, background: C.accent, color: '#000', fontWeight: 700, fontSize: 16, borderRadius: 14, padding: '18px', border: 'none', cursor: 'pointer' }}>
                Resume
              </button>
            )}
            <button onClick={finish}
              style={{ flex: 1, background: '#ef4444', color: '#fff', fontWeight: 700, fontSize: 16, borderRadius: 14, padding: '18px', border: 'none', cursor: 'pointer' }}>
              Finish
            </button>
          </div>
        </div>
      )}

      {status === 'done' && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 16 }}>
            <p style={{ fontWeight: 700, fontSize: 18, margin: '0 0 12px' }}>Run complete — {fmtTime(elapsed)}</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ background: 'var(--bg-input)', borderRadius: 10, padding: 12 }}>
                <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Time</p>
                <p style={{ fontWeight: 700 }}>{fmtTime(elapsed)}</p>
              </div>
              <div style={{ background: 'var(--bg-input)', borderRadius: 10, padding: 12 }}>
                <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Speed</p>
                <p style={{ fontWeight: 700 }}>{speed || '--'} mph</p>
              </div>
            </div>
          </div>

          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>
              Distance (check treadmill display)
            </label>
            <input value={distance} onChange={e => setDistance(e.target.value)}
              placeholder={estimatedDist ? `Estimated: ${estimatedDist} mi` : 'Enter miles from treadmill'}
              type="number" step="0.01"
              style={{ width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px', fontSize: 16, boxSizing: 'border-box' }} />
            {estimatedDist && !distance && (
              <button onClick={() => setDistance(estimatedDist)}
                style={{ marginTop: 6, background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer', padding: 0 }}>
                Use estimated: {estimatedDist} mi
              </button>
            )}
          </div>

          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block', marginBottom: 4 }}>Effort: {effort}/10</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                <button key={n} onClick={() => setEffort(n)}
                  style={{ flex: 1, height: 32, borderRadius: 6, background: n <= effort ? C.accent : 'var(--bg-input)', color: n <= effort ? '#000' : 'var(--text-muted)', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 11 }}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)"
            rows={2}
            style={{ width: '100%', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px', fontSize: 14, resize: 'none', boxSizing: 'border-box' }} />

          {feedback && <p style={{ color: C.accent, textAlign: 'center' }}>{feedback}</p>}

          <button onClick={save} disabled={saving || !distance}
            style={{ background: distance ? C.accent : 'var(--bg-input)', color: '#000', fontWeight: 900, fontSize: 16, borderRadius: 14, padding: '18px', border: 'none', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving...' : 'Save Run'}
          </button>
        </div>
      )}
    </div>
  )
}
