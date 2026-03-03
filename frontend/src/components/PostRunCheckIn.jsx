import { useMemo, useState } from 'react'
import api from '../lib/api'

const STEPS = [
  { key: 'effort', label: 'Effort' },
  { key: 'pain', label: 'Pain' },
  { key: 'energy', label: 'Energy' },
  { key: 'summary', label: 'Confirm' },
]

const PAIN_OPTIONS = [
  ['none', 'None - felt great'],
  ['mild', 'Mild - manageable'],
  ['moderate', 'Moderate - noticeable'],
  ['severe', 'Severe - need rest'],
]

const ENERGY_OPTIONS = [
  ['low', 'Drained'],
  ['medium', 'Okay'],
  ['high', 'Energized'],
]

export default function PostRunCheckIn({ runId, onDone }) {
  const [step, setStep] = useState(0)
  const [effort, setEffort] = useState(null)
  const [pain, setPain] = useState(null)
  const [energy, setEnergy] = useState(null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState({})
  const [warning, setWarning] = useState(null)
  const [pendingStep, setPendingStep] = useState(null)

  const completion = useMemo(() => ({
    0: effort !== null,
    1: Boolean(pain),
    2: Boolean(energy),
    3: effort !== null && Boolean(pain) && Boolean(energy),
  }), [effort, pain, energy])

  const firstIncomplete = useMemo(() => {
    if (!completion[0]) return 0
    if (!completion[1]) return 1
    if (!completion[2]) return 2
    return 3
  }, [completion])

  const isLocked = (idx) => idx > firstIncomplete
  const hasCompletedAfter = (idx) => {
    if (idx <= 0) return completion[1] || completion[2]
    if (idx === 1) return completion[2]
    return false
  }

  const painLabel = PAIN_OPTIONS.find(([value]) => value === pain)?.[1] || '--'
  const energyLabel = ENERGY_OPTIONS.find(([value]) => value === energy)?.[1] || '--'

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

  const validateCurrentStep = () => {
    const nextErrors = {}
    if (step === 0 && effort === null) nextErrors.effort = 'Select an effort score before continuing.'
    if (step === 1 && !pain) nextErrors.pain = 'Select a pain/discomfort level before continuing.'
    if (step === 2 && !energy) nextErrors.energy = 'Select your post-run energy before continuing.'
    setErrors(prev => ({ ...prev, ...nextErrors }))
    return Object.keys(nextErrors).length === 0
  }

  const resetDownstream = (stepIndex) => {
    if (stepIndex === 0) {
      setPain(null)
      setEnergy(null)
      setErrors(prev => ({ ...prev, pain: null, energy: null }))
    }
    if (stepIndex === 1) {
      setEnergy(null)
      setErrors(prev => ({ ...prev, energy: null }))
    }
  }

  const requestStepChange = (targetStep) => {
    if (targetStep < 0 || targetStep > 3 || isLocked(targetStep)) return
    if (targetStep < step && hasCompletedAfter(targetStep)) {
      setPendingStep(targetStep)
      setWarning('If you change this answer, later steps may need to be re-confirmed.')
      return
    }
    setWarning(null)
    setStep(targetStep)
  }

  const selectStepValue = (stepIndex, updater, value, currentValue) => {
    if (currentValue === value) return
    if (hasCompletedAfter(stepIndex) && currentValue !== null) {
      setWarning('Answer updated. Please re-confirm the later steps.')
      resetDownstream(stepIndex)
    }
    updater(value)
    if (stepIndex === 0) setErrors(prev => ({ ...prev, effort: null }))
    if (stepIndex === 1) setErrors(prev => ({ ...prev, pain: null }))
    if (stepIndex === 2) setErrors(prev => ({ ...prev, energy: null }))
  }

  const next = () => {
    if (!validateCurrentStep()) return
    setWarning(null)
    if (step < 3) {
      setStep(step + 1)
      return
    }
    submit()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 50, padding: 16 }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: '24px 24px 16px 16px', padding: 24, width: '100%', maxWidth: 480 }}>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {STEPS.map((item, idx) => {
            const locked = isLocked(idx)
            const complete = completion[idx] && idx !== step
            const current = idx === step
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => requestStepChange(idx)}
                disabled={locked}
                style={{
                  flex: 1,
                  borderRadius: 12,
                  border: `1px solid ${current ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  background: complete ? 'var(--accent-dim)' : current ? 'rgba(234,179,8,0.12)' : 'var(--bg-input)',
                  color: locked ? 'var(--text-muted)' : complete || current ? 'var(--accent)' : 'var(--text-primary)',
                  opacity: locked ? 0.45 : 1,
                  padding: '8px 6px',
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: locked ? 'default' : 'pointer',
                  transition: 'all 0.2s ease',
                }}
              >
                <span style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
                  {complete ? '✓' : locked ? '•' : String(idx + 1)}
                </span>
                {item.label}
              </button>
            )
          })}
        </div>

        {warning && (
          <div style={{ marginBottom: 16, borderRadius: 12, border: '1px solid rgba(234,179,8,0.35)', background: 'rgba(234,179,8,0.1)', padding: '10px 12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <p style={{ color: 'var(--text-primary)', fontSize: 12, margin: 0 }}>{warning}</p>
              {pendingStep === null && (
                <button
                  type="button"
                  onClick={() => setWarning(null)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, cursor: 'pointer', fontSize: 12 }}
                >
                  Dismiss
                </button>
              )}
            </div>
            {pendingStep !== null && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => {
                    setStep(pendingStep)
                    setPendingStep(null)
                    setWarning(null)
                  }}
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)', fontWeight: 700, cursor: 'pointer' }}
                >
                  Continue
                </button>
                <button
                  type="button"
                  onClick={() => { setPendingStep(null); setWarning(null) }}
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontWeight: 700, cursor: 'pointer' }}
                >
                  Stay Here
                </button>
              </div>
            )}
          </div>
        )}

        {step === 0 && (
          <div style={{ animation: 'checkinFade 180ms ease' }}>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>How hard was that?</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>Rate your effort — 1 easy, 10 all out.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 20 }}>
              {[1,2,3,4,5,6,7,8,9,10].map(n => (
                <button key={n} type="button" onClick={() => selectStepValue(0, setEffort, n, effort)}
                  style={{ padding: '12px 4px', borderRadius: 12, border: `2px solid ${effort === n ? 'var(--accent)' : 'var(--border-subtle)'}`, background: effort === n ? 'var(--accent-dim)' : 'var(--bg-input)', color: effort === n ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
                  {n}
                </button>
              ))}
            </div>
            {errors.effort && <p style={{ color: '#ef4444', fontSize: 12, margin: '0 0 12px' }}>{errors.effort}</p>}
            <button type="button" onClick={next}
              style={{ width: '100%', padding: 16, background: 'var(--accent)', color: '#000', fontWeight: 900, borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 15, transition: 'transform 0.16s ease' }}>
              Next
            </button>
          </div>
        )}

        {step === 1 && (
          <div style={{ animation: 'checkinFade 180ms ease' }}>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>Any pain or discomfort?</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>Be honest — FORGE adjusts your next session.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              {PAIN_OPTIONS.map(([val, label]) => (
                <button key={val} type="button" onClick={() => selectStepValue(1, setPain, val, pain)}
                  style={{ padding: '14px 16px', borderRadius: 14, border: `2px solid ${pain === val ? 'var(--accent)' : 'var(--border-subtle)'}`, background: pain === val ? 'var(--accent-dim)' : 'var(--bg-input)', color: pain === val ? 'var(--accent)' : 'var(--text-primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer', textAlign: 'left' }}>
                  {label}
                </button>
              ))}
            </div>
            {errors.pain && <p style={{ color: '#ef4444', fontSize: 12, margin: '0 0 12px' }}>{errors.pain}</p>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => requestStepChange(0)}
                style={{ flex: 1, padding: 14, background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 800, borderRadius: 14, border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
                Back
              </button>
              <button type="button" onClick={next}
                style={{ flex: 2, padding: 14, background: 'var(--accent)', color: '#000', fontWeight: 900, borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 15 }}>
                Next
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ animation: 'checkinFade 180ms ease' }}>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>Energy level after?</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>This helps FORGE plan your recovery time.</p>
            <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              {ENERGY_OPTIONS.map(([val, label]) => (
                <button key={val} type="button" onClick={() => selectStepValue(2, setEnergy, val, energy)}
                  style={{ flex: 1, padding: '16px 8px', borderRadius: 14, border: `2px solid ${energy === val ? 'var(--accent)' : 'var(--border-subtle)'}`, background: energy === val ? 'var(--accent-dim)' : 'var(--bg-input)', color: energy === val ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  {label}
                </button>
              ))}
            </div>
            {errors.energy && <p style={{ color: '#ef4444', fontSize: 12, margin: '0 0 12px' }}>{errors.energy}</p>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => requestStepChange(1)}
                style={{ flex: 1, padding: 14, background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 800, borderRadius: 14, border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
                Back
              </button>
              <button type="button" onClick={next}
                style={{ flex: 2, padding: 14, background: 'var(--accent)', color: '#000', fontWeight: 900, borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 15 }}>
                Review
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ animation: 'checkinFade 180ms ease' }}>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 8 }}>Confirm your check-in</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>Review what was logged before saving.</p>
            <div style={{ display: 'grid', gap: 10, marginBottom: 20 }}>
              <div style={{ padding: 12, borderRadius: 12, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>Effort</p>
                <p style={{ margin: '4px 0 0', color: 'var(--text-primary)', fontWeight: 800 }}>{effort}/10</p>
              </div>
              <div style={{ padding: 12, borderRadius: 12, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>Pain / Discomfort</p>
                <p style={{ margin: '4px 0 0', color: 'var(--text-primary)', fontWeight: 800 }}>{painLabel}</p>
              </div>
              <div style={{ padding: 12, borderRadius: 12, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>Energy</p>
                <p style={{ margin: '4px 0 0', color: 'var(--text-primary)', fontWeight: 800 }}>{energyLabel}</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => requestStepChange(2)}
                style={{ flex: 1, padding: 14, background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 800, borderRadius: 14, border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
                Back
              </button>
              <button type="button" onClick={next} disabled={saving}
                style={{ flex: 2, padding: 14, background: 'var(--accent)', color: '#000', fontWeight: 900, borderRadius: 14, border: 'none', cursor: saving ? 'default' : 'pointer', fontSize: 15, opacity: saving ? 0.55 : 1 }}>
                {saving ? 'Saving...' : 'Confirm & Save'}
              </button>
            </div>
          </div>
        )}

        <style>{`
          @keyframes checkinFade {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>
      </div>
    </div>
  )
}
