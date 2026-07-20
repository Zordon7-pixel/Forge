import { useEffect, useMemo, useState } from 'react'
import api from '../lib/api'
import { flushQueue, queueRequest } from '../lib/offlineQueue'
import {
  clearPostRunCheckInDraft,
  loadPostRunCheckInDraft,
  savePostRunCheckInDraft,
} from '../lib/postRunCheckInDraft'
import { getRecurringInjuryWarning, validateInjuryLog } from '../utils/validation'

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

const INJURY_BODY_PARTS = ['knee', 'hip', 'ankle', 'shin', 'calf', 'hamstring', 'lower back', 'shoulder', 'other']
const POST_RUN_PAIN_TO_INJURY_SEVERITY = {
  moderate: 5,
  severe: 10,
}

function formatBodyPart(part) {
  return String(part || '').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

export default function PostRunCheckIn({ runId, heatDrift, onDone, onCancel }) {
  const [initialDraft] = useState(() => loadPostRunCheckInDraft(runId))
  const [step, setStep] = useState(initialDraft?.step || 0)
  const [effort, setEffort] = useState(initialDraft?.effort || null)
  const [pain, setPain] = useState(initialDraft?.pain || null)
  const [energy, setEnergy] = useState(initialDraft?.energy || null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState({})
  const [warning, setWarning] = useState(null)
  const [pendingStep, setPendingStep] = useState(null)
  const [submitError, setSubmitError] = useState('')
  const [injuryLogDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [injuryBodyPart, setInjuryBodyPart] = useState('')
  const [injuryErrors, setInjuryErrors] = useState({})
  const [injurySubmitError, setInjurySubmitError] = useState('')
  const [injuryMessage, setInjuryMessage] = useState('')
  const [injurySubmitting, setInjurySubmitting] = useState(false)
  const [allInjuries, setAllInjuries] = useState([])
  const [injuriesLoaded, setInjuriesLoaded] = useState(false)
  const [loggedInjury, setLoggedInjury] = useState(null)

  useEffect(() => {
    savePostRunCheckInDraft({
      runId,
      runQueued: Boolean(initialDraft?.runQueued),
      heatDrift: heatDrift || initialDraft?.heatDrift || null,
      step,
      effort,
      pain,
      energy,
    })
  }, [energy, effort, heatDrift, initialDraft, pain, runId, step])

  const completion = useMemo(() => ({
    0: effort !== null,
    1: Boolean(pain),
    2: Boolean(energy),
    3: effort !== null && Boolean(pain),
  }), [effort, pain, energy])

  const firstIncomplete = useMemo(() => {
    if (!completion[0]) return 0
    if (!completion[1]) return 1
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
  const injurySeverity = POST_RUN_PAIN_TO_INJURY_SEVERITY[pain] || null
  const recurringInjuryWarning = useMemo(() => (
    getRecurringInjuryWarning({ bodyPart: injuryBodyPart, injuries: allInjuries })
  ), [allInjuries, injuryBodyPart])
  const selectedInjuryLogged = Boolean(
    loggedInjury
    && loggedInjury.bodyPart === injuryBodyPart
    && loggedInjury.severity === injurySeverity
  )

  useEffect(() => {
    if (!injurySeverity) {
      setInjuryBodyPart('')
      setInjuryErrors({})
      setInjurySubmitError('')
      setInjuryMessage('')
      setLoggedInjury(null)
      return
    }

    let cancelled = false
    if (!injuriesLoaded) {
      api.get('/injury')
        .then((response) => {
          if (!cancelled) setAllInjuries(response.data?.injuries || [])
        })
        .catch((error) => {
          console.error('[post-run/check-in] injury history load failed:', error?.message || error)
        })
        .finally(() => {
          if (!cancelled) setInjuriesLoaded(true)
        })
    }

    return () => { cancelled = true }
  }, [injuriesLoaded, injurySeverity])

  useEffect(() => {
    setInjuryErrors({})
    setInjurySubmitError('')
    setInjuryMessage('')
    setLoggedInjury(null)
  }, [pain])

  const submitInjuryLog = async () => {
    const { errors: nextErrors } = validateInjuryLog({ bodyPart: injuryBodyPart, severity: injurySeverity })
    setInjuryErrors(nextErrors)
    setInjurySubmitError('')
    setInjuryMessage('')
    if (Object.keys(nextErrors).length) return

    setInjurySubmitting(true)
    try {
      const response = await api.post('/injury', {
        body_part: injuryBodyPart,
        pain_level: injurySeverity,
        notes: `Post-run check-in reported ${pain} pain after run ${runId}.`,
        date: injuryLogDate,
      })
      const injury = response.data?.injury
      if (injury) setAllInjuries(prev => [injury, ...prev])
      setLoggedInjury({ bodyPart: injuryBodyPart, severity: injurySeverity })
      setInjuryMessage('Logged to injury log')
    } catch (error) {
      console.error('[post-run/check-in] injury log failed:', error?.message || error)
      setInjurySubmitError(error?.response?.data?.error || 'Could not log this injury right now.')
    } finally {
      setInjurySubmitting(false)
    }
  }

  const submit = async () => {
    const payload = {
      perceived_effort: effort,
      pain_level: pain,
      post_energy: energy,
    }
    const queueCheckIn = async () => {
      await queueRequest(`/api/runs/${runId}/check-in`, 'PATCH', payload)
      if (navigator.onLine) {
        try {
          await flushQueue()
        } catch (error) {
          console.error('[post-run/check-in] immediate queue flush failed:', error?.message || error)
        }
      }
      clearPostRunCheckInDraft(runId)
      onDone({ queued: true, feedback: null, feedbackStatus: 'queued' })
    }

    setSaving(true)
    setSubmitError('')
    try {
      if (!navigator.onLine || initialDraft?.runQueued) {
        await queueCheckIn()
        return
      }
      const response = await api.patch(`/runs/${runId}/check-in`, payload)
      clearPostRunCheckInDraft(runId)
      onDone({
        queued: false,
        feedback: response.data?.feedback || null,
        feedbackStatus: response.data?.feedbackStatus || 'pending',
        run: response.data?.run || null,
      })
    } catch (error) {
      const status = Number(error?.response?.status || 0)
      const canQueue = !error?.response || status >= 500 || (status === 404 && initialDraft?.runQueued)
      if (canQueue) {
        try {
          await queueCheckIn()
          return
        } catch (queueError) {
          console.error('[post-run/check-in] queue failed:', queueError?.message || queueError)
        }
      }
      console.error('[post-run/check-in] save failed:', error?.message || error)
      setSubmitError(error?.response?.data?.error || 'Could not save your check-in. Your answers are still here; try again.')
    } finally {
      setSaving(false)
    }
  }

  const validateCurrentStep = () => {
    const nextErrors = {}
    if (step === 0 && effort === null) nextErrors.effort = 'Select an effort score before continuing.'
    if (step === 1 && !pain) nextErrors.pain = 'Select a pain/discomfort level before continuing.'
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
    if (step === 1) {
      setStep(3)
      return
    }
    if (step < 3) {
      setStep(step + 1)
      return
    }
    submit()
  }

  const renderInjuryPrompt = () => {
    if (!injurySeverity) return null

    return (
      <div style={{ marginBottom: 18, borderRadius: 14, border: '1px solid rgba(239,68,68,0.35)', background: 'var(--danger-dim)', padding: 14 }}>
        <p style={{ margin: '0 0 4px', color: 'var(--text-primary)', fontSize: 13, fontWeight: 900 }}>
          Log this to the injury log
        </p>
        <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>
          Carry {pain} pain as {injurySeverity}/10 and choose the body part that felt off.
        </p>
        <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
          Body part
        </label>
        <select
          value={injuryBodyPart}
          onChange={(event) => {
            setInjuryBodyPart(event.target.value)
            setInjuryErrors(prev => ({ ...prev, body_part: null }))
            setInjurySubmitError('')
            setInjuryMessage('')
          }}
          style={{ width: '100%', borderRadius: 12, border: `1px solid ${injuryErrors.body_part ? 'var(--danger)' : 'var(--border-subtle)'}`, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '12px 10px', fontWeight: 700 }}
        >
          <option value="">Select body part</option>
          {INJURY_BODY_PARTS.map(part => (
            <option key={part} value={part}>{formatBodyPart(part)}</option>
          ))}
        </select>
        {injuryErrors.body_part && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '6px 0 0' }}>{injuryErrors.body_part}</p>}
        {injuryErrors.pain_level && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '6px 0 0' }}>{injuryErrors.pain_level}</p>}
        {recurringInjuryWarning && <p style={{ color: 'var(--warning)', fontSize: 12, margin: '8px 0 0', fontWeight: 700 }}>{recurringInjuryWarning}</p>}
        {injuryMessage && <p style={{ color: 'var(--success)', fontSize: 12, margin: '8px 0 0', fontWeight: 700 }}>{injuryMessage}</p>}
        {injurySubmitError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '8px 0 0' }}>{injurySubmitError}</p>}
        <button
          type="button"
          onClick={submitInjuryLog}
          disabled={injurySubmitting || selectedInjuryLogged}
          style={{ width: '100%', marginTop: 12, padding: 12, borderRadius: 12, border: 'none', background: selectedInjuryLogged ? 'var(--bg-input)' : 'var(--danger)', color: selectedInjuryLogged ? 'var(--success)' : '#fff', fontWeight: 900, cursor: injurySubmitting || selectedInjuryLogged ? 'default' : 'pointer', opacity: injurySubmitting ? 0.65 : 1 }}
        >
          {selectedInjuryLogged ? 'Logged to Injury Log' : injurySubmitting ? 'Logging...' : 'Log to Injury Log'}
        </button>
      </div>
    )
  }

  return (
    <div className="sheet-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 50, padding: 16 }}>
      <div className="sheet-panel" style={{ background: 'var(--bg-card)', borderRadius: '24px 24px 16px 16px', padding: 24, width: '100%', maxWidth: 480 }}>

        {onCancel && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <p style={{ margin: 0, color: 'var(--text-primary)', fontWeight: 900, fontSize: 18 }}>Post-run check-in</p>
            <button type="button" onClick={onCancel} style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '8px 10px', background: 'var(--bg-input)', color: 'var(--text-muted)', fontWeight: 800, cursor: 'pointer' }}>Not now</button>
          </div>
        )}

        {heatDrift?.drifted && (
          <div style={{ marginBottom: 16, borderRadius: 12, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', padding: '10px 12px' }}>
            <p style={{ margin: '0 0 4px', color: 'var(--accent)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0 }}>
              {heatDrift.label}
            </p>
            <p style={{ margin: 0, color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.45 }}>
              {heatDrift.reason}
            </p>
          </div>
        )}

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
                  background: complete ? 'var(--accent-dim)' : current ? 'var(--accent-dim)' : 'var(--bg-input)',
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
          <div style={{ marginBottom: 16, borderRadius: 12, border: '1px solid var(--border-subtle)', background: 'var(--accent-dim)', padding: '10px 12px' }}>
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
            {errors.effort && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 12px' }}>{errors.effort}</p>}
            <button type="button" onClick={next}
              style={{ width: '100%', padding: 16, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 15, transition: 'transform 0.16s ease' }}>
              Next
            </button>
          </div>
        )}

        {step === 1 && (
          <div style={{ animation: 'checkinFade 180ms ease' }}>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>Any pain or discomfort?</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>Be honest — Forged Hybrid adjusts your next session.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              {PAIN_OPTIONS.map(([val, label]) => (
                <button key={val} type="button" onClick={() => selectStepValue(1, setPain, val, pain)}
                  style={{ padding: '14px 16px', borderRadius: 14, border: `2px solid ${pain === val ? 'var(--accent)' : 'var(--border-subtle)'}`, background: pain === val ? 'var(--accent-dim)' : 'var(--bg-input)', color: pain === val ? 'var(--accent)' : 'var(--text-primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer', textAlign: 'left' }}>
                  {label}
                </button>
              ))}
            </div>
            {errors.pain && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 12px' }}>{errors.pain}</p>}
            {renderInjuryPrompt()}
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => requestStepChange(0)}
                style={{ flex: 1, padding: 14, background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 800, borderRadius: 14, border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
                Back
              </button>
              <button type="button" onClick={next}
                style={{ flex: 2, padding: 14, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 15 }}>
                Next
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ animation: 'checkinFade 180ms ease' }}>
            <p style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', marginBottom: 6 }}>Energy level after?</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>Optional — add it if it feels useful today.</p>
            <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              {ENERGY_OPTIONS.map(([val, label]) => (
                <button key={val} type="button" onClick={() => selectStepValue(2, setEnergy, val, energy)}
                  style={{ flex: 1, padding: '16px 8px', borderRadius: 14, border: `2px solid ${energy === val ? 'var(--accent)' : 'var(--border-subtle)'}`, background: energy === val ? 'var(--accent-dim)' : 'var(--bg-input)', color: energy === val ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  {label}
                </button>
              ))}
            </div>
            {errors.energy && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 12px' }}>{errors.energy}</p>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => requestStepChange(1)}
                style={{ flex: 1, padding: 14, background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 800, borderRadius: 14, border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
                Back
              </button>
              <button type="button" onClick={next}
                style={{ flex: 2, padding: 14, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 15 }}>
                {energy ? 'Review' : 'Skip to Review'}
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div>
                    <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>Energy optional</p>
                    <p style={{ margin: '4px 0 0', color: 'var(--text-primary)', fontWeight: 800 }}>{energy ? energyLabel : 'Not set'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => requestStepChange(2)}
                    style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '8px 10px', background: 'var(--bg-card)', color: 'var(--accent)', fontSize: 12, fontWeight: 900, cursor: 'pointer' }}
                  >
                    {energy ? 'Change' : 'Add'}
                  </button>
                </div>
              </div>
            </div>
            {renderInjuryPrompt()}
            {submitError && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 12px' }}>{submitError}</p>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => requestStepChange(1)}
                style={{ flex: 1, padding: 14, background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 800, borderRadius: 14, border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
                Back
              </button>
              <button type="button" onClick={next} disabled={saving}
                style={{ flex: 2, padding: 14, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, borderRadius: 14, border: 'none', cursor: saving ? 'default' : 'pointer', fontSize: 15, opacity: saving ? 0.55 : 1 }}>
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
