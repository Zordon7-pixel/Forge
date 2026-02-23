import { useState } from 'react'
import api from '../lib/api'

export default function PostRunCheckIn({ runId, onDone }) {
  const [step, setStep] = useState(0) // 0=effort, 1=pain, 2=energy
  const [effort, setEffort] = useState(null)   // 1-10
  const [pain, setPain] = useState(null)        // none/mild/moderate/severe
  const [energy, setEnergy] = useState(null)    // low/medium/high
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      await api.patch(`/runs/${runId}`, {
        perceived_effort: effort,
        pain_level: pain,
        post_energy: energy,
      }).catch(() => {})
    } finally {
      setSaving(false)
      onDone()
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 50, padding: 16 }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: '24px 24px 16px 16px', padding: 24, width: '100%', maxWidth: 480 }}>
        
        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 24 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i <= step ? 'var(--accent)' : 'var(--border-subtle)', transition: 'background 0.2s' }} />
          ))}
        </div>

        {step === 0 && (
          <div>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>How hard was that?</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>Rate your effort — 1 easy, 10 all out.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 20 }}>
              {[1,2,3,4,5,6,7,8,9,10].map(n => (
                <button key={n} onClick={() => setEffort(n)}
                  style={{ padding: '12px 4px', borderRadius: 12, border: `2px solid ${effort === n ? 'var(--accent)' : 'var(--border-subtle)'}`, background: effort === n ? 'var(--accent-dim)' : 'var(--bg-input)', color: effort === n ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
                  {n}
                </button>
              ))}
            </div>
            <button onClick={() => effort && setStep(1)} disabled={!effort}
              style={{ width: '100%', padding: 16, background: effort ? 'var(--accent)' : 'var(--bg-input)', color: '#000', fontWeight: 900, borderRadius: 14, border: 'none', cursor: effort ? 'pointer' : 'default', fontSize: 15, opacity: effort ? 1 : 0.5 }}>
              Next
            </button>
          </div>
        )}

        {step === 1 && (
          <div>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>Any pain or discomfort?</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>Be honest — FORGE adjusts your next session.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              {[['none','None — felt great'],['mild','Mild — manageable'],['moderate','Moderate — noticeable'],['severe','Severe — need rest']].map(([val, label]) => (
                <button key={val} onClick={() => setPain(val)}
                  style={{ padding: '14px 16px', borderRadius: 14, border: `2px solid ${pain === val ? 'var(--accent)' : 'var(--border-subtle)'}`, background: pain === val ? 'var(--accent-dim)' : 'var(--bg-input)', color: pain === val ? 'var(--accent)' : 'var(--text-primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer', textAlign: 'left' }}>
                  {label}
                </button>
              ))}
            </div>
            <button onClick={() => pain && setStep(2)} disabled={!pain}
              style={{ width: '100%', padding: 16, background: pain ? 'var(--accent)' : 'var(--bg-input)', color: '#000', fontWeight: 900, borderRadius: 14, border: 'none', cursor: pain ? 'pointer' : 'default', fontSize: 15, opacity: pain ? 1 : 0.5 }}>
              Next
            </button>
          </div>
        )}

        {step === 2 && (
          <div>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>Energy level after?</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>This helps FORGE plan your recovery time.</p>
            <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              {[['low','Drained'],['medium','Okay'],['high','Energized']].map(([val, label]) => (
                <button key={val} onClick={() => setEnergy(val)}
                  style={{ flex: 1, padding: '16px 8px', borderRadius: 14, border: `2px solid ${energy === val ? 'var(--accent)' : 'var(--border-subtle)'}`, background: energy === val ? 'var(--accent-dim)' : 'var(--bg-input)', color: energy === val ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  {label}
                </button>
              ))}
            </div>
            <button onClick={() => energy && submit()} disabled={!energy || saving}
              style={{ width: '100%', padding: 16, background: energy ? 'var(--accent)' : 'var(--bg-input)', color: '#000', fontWeight: 900, borderRadius: 14, border: 'none', cursor: energy ? 'pointer' : 'default', fontSize: 15, opacity: energy && !saving ? 1 : 0.5 }}>
              {saving ? 'Saving...' : 'Done'}
            </button>
          </div>
        )}

        <button onClick={onDone} style={{ width: '100%', marginTop: 12, background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
          Skip
        </button>
      </div>
    </div>
  )
}
