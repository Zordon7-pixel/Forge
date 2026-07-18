import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ChevronRight, Copy, FileDown, Watch, X } from 'lucide-react'
import track from '../lib/track'
import WatchDeliveryService from '../services/WatchDeliveryService'
import { athleteWatchAvailabilityMessage, isInternalWatchDiagnostic } from '../services/watchWorkoutAvailability'

function logAvailabilityDiagnostic(reason = '') {
  if (isInternalWatchDiagnostic(reason)) {
    console.error('[watch-delivery] unavailable:', reason)
  }
}

function workoutGoalLabel(workout = {}) {
  const goal = workout.goal || {}
  if (goal.type === 'distance' && Number(goal.value) > 0) {
    return `${goal.value} ${goal.unit || 'mi'}`
  }
  if (goal.type === 'time' && Number(goal.value) > 0) {
    return `${goal.value} ${goal.unit || 'min'}`
  }
  return 'Open goal'
}

export default function WatchWorkoutSendButton({ workout, label = 'Send to Watch', className = '', compact = false }) {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [fitSending, setFitSending] = useState(false)
  const [fitExportOpen, setFitExportOpen] = useState(false)
  const [availability, setAvailability] = useState({ checked: false, available: false, reason: '' })
  const fitDialogRef = useRef(null)
  const structuredWorkout = useMemo(() => (workout ? WatchDeliveryService.buildStructuredWorkout(workout) : null), [workout])
  const workoutText = useMemo(() => WatchDeliveryService.formatFallbackText(workout || {}), [workout])
  const fitStepCount = structuredWorkout?.steps?.length || 0
  const fitGoal = workoutGoalLabel(structuredWorkout)

  useEffect(() => {
    let active = true
    WatchDeliveryService.getAvailability()
      .then((result) => {
        if (!result?.canAutoSend && result?.reason) logAvailabilityDiagnostic(result.reason)
        if (active) setAvailability({ checked: true, available: Boolean(result?.canAutoSend), reason: result?.reason || '' })
      })
      .catch((err) => {
        console.error('[watch-delivery] availability check failed:', err?.message || err)
        if (active) setAvailability({ checked: true, available: false, reason: err?.message || 'Watch delivery is unavailable.' })
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!fitExportOpen) return undefined
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement
    const dialog = fitDialogRef.current
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setFitExportOpen(false)
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    dialog?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [fitExportOpen])

  const openFitExport = () => {
    setStatus('')
    setError('')
    setFitExportOpen(true)
  }

  const copyWorkout = async () => {
    try {
      await navigator.clipboard.writeText(workoutText)
      setStatus('Copied workout details.')
      setError('')
    } catch {
      setError('Could not copy workout details.')
      setStatus('')
    }
  }

  const sendWorkout = async () => {
    if (!workout) return
    if (availability.checked && !availability.available) {
      setError(athleteWatchAvailabilityMessage(availability.reason))
      setStatus('')
      return
    }
    setSending(true)
    setError('')
    setStatus('')
    try {
      await WatchDeliveryService.send(workout)
      track('recommendation_followed', { via: 'watch' })
      setStatus('Sent to watch.')
    } catch (err) {
      console.error('[watch-delivery] send failed:', err?.message || err)
      setError('Could not send this workout to Apple Watch. Manual entry still works.')
    } finally {
      setSending(false)
    }
  }

  const sendFitWorkout = async () => {
    if (!structuredWorkout) return
    setFitSending(true)
    setError('')
    setStatus('')
    try {
      const result = await WatchDeliveryService.exportWorkoutFitFile(structuredWorkout)
      if (result?.cancelled) return
      track('recommendation_followed', { via: 'fit_export' })
      setStatus(result?.shared ? 'Workout .FIT file shared.' : 'Workout .FIT file downloaded.')
      setFitExportOpen(false)
    } catch (err) {
      console.error('[watch-fit-export] send failed:', err?.message || err)
      setError('Could not export this workout as a .FIT file.')
    } finally {
      setFitSending(false)
    }
  }

  const canSend = availability.checked && availability.available
  const showSendButton = !availability.checked || canSend

  return (
    <div className={className}>
      {showSendButton && (
        <button
          type="button"
          onClick={sendWorkout}
          disabled={sending || !workout || !availability.checked}
          className="w-full rounded-xl py-3 font-bold flex items-center justify-center gap-2 disabled:opacity-60"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: sending ? 'wait' : 'pointer' }}
        >
          <Watch size={17} />
          {sending ? 'Sending...' : !availability.checked ? 'Checking Apple Watch...' : label}
        </button>
      )}
      <button
        type="button"
        onClick={openFitExport}
        disabled={fitSending || !structuredWorkout}
        aria-haspopup="dialog"
        className={`w-full ${showSendButton ? 'mt-2' : ''}`}
        style={{
          minHeight: 64,
          padding: '10px 12px',
          display: 'grid',
          gridTemplateColumns: '42px minmax(0, 1fr) 20px',
          alignItems: 'center',
          gap: 11,
          borderRadius: 12,
          background: 'var(--bg-input)',
          color: 'var(--text-primary)',
          border: '1px solid var(--card-border-strong)',
          cursor: fitSending ? 'wait' : 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ width: 42, height: 42, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--accent-dim)', color: 'var(--accent)' }}>
          <FileDown size={21} aria-hidden="true" />
        </span>
        <span style={{ minWidth: 0, display: 'grid', gap: 3 }}>
          <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7, fontSize: 14, lineHeight: 1.2, fontWeight: 850 }}>
            Export watch workout
            <span style={{ padding: '3px 6px', borderRadius: 5, background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>.FIT</span>
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.35 }}>Garmin-compatible manual transfer</span>
        </span>
        <ChevronRight size={19} color="var(--text-muted)" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={copyWorkout}
        className="w-full rounded-xl py-2 text-sm font-semibold mt-2 flex items-center justify-center gap-2"
        style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
      >
        <Copy size={15} aria-hidden="true" />
        {canSend ? 'Copy workout details' : 'Copy workout for manual entry'}
      </button>
      {status && <p className="mt-2 text-xs flex items-center gap-1.5" style={{ color: 'var(--success)' }} aria-live="polite"><CheckCircle2 size={14} aria-hidden="true" />{status}</p>}
      {error && !fitExportOpen && (
        <p className="mt-2 text-xs" style={{ color: 'var(--warning)' }} aria-live="polite">
          {error}
        </p>
      )}
      {fitExportOpen && (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFitExportOpen(false)
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            padding: '12px 12px max(12px, env(safe-area-inset-bottom))',
            background: 'rgba(0, 0, 0, 0.72)',
          }}
        >
          <section
            ref={fitDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="fit-export-title"
            aria-describedby="fit-export-description"
            tabIndex={-1}
            style={{
              width: 'min(100%, 430px)',
              maxHeight: 'calc(100dvh - 24px)',
              overflowY: 'auto',
              borderRadius: 16,
              padding: 18,
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--card-border-strong)',
              boxShadow: 'var(--shadow-raised)',
            }}
          >
            <header style={{ display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr) 38px', alignItems: 'center', gap: 11 }}>
              <span style={{ width: 42, height: 42, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--accent-dim)', color: 'var(--accent)' }}>
                <Watch size={22} aria-hidden="true" />
              </span>
              <div style={{ minWidth: 0 }}>
                <h2 id="fit-export-title" style={{ margin: 0, fontSize: 19, lineHeight: 1.2, fontWeight: 900 }}>Export to your watch</h2>
                <p id="fit-export-description" style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>Structured Garmin-compatible workout file</p>
              </div>
              <button
                type="button"
                onClick={() => setFitExportOpen(false)}
                aria-label="Close watch export"
                style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', borderRadius: 9, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </header>

            <div style={{ marginTop: 16, padding: 14, borderRadius: 10, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 850, overflowWrap: 'anywhere' }}>{structuredWorkout?.title || 'Forged Hybrid workout'}</p>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {[structuredWorkout?.kind === 'strength' ? 'Strength' : 'Run', fitGoal, `${fitStepCount} ${fitStepCount === 1 ? 'step' : 'steps'}`].map((item) => (
                  <span key={item} style={{ padding: '5px 8px', borderRadius: 7, background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', fontSize: 11, fontWeight: 750 }}>{item}</span>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 850 }}>Garmin manual transfer</p>
              <ol style={{ margin: '9px 0 0', paddingLeft: 20, color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.55 }}>
                <li>Create and save the .FIT file.</li>
                <li>On a compatible computer, copy it to the watch&apos;s <strong style={{ color: 'var(--text-primary)' }}>Garmin/NewFiles</strong> folder.</li>
                <li>Safely disconnect, then open Workouts on the watch.</li>
              </ol>
              <p style={{ margin: '10px 0 0', padding: '9px 10px', borderLeft: '3px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>
                Automatic Garmin Connect delivery requires official Garmin Training API access. Forged Hybrid does not pair to Garmin watches over Bluetooth.
              </p>
            </div>

            {error && (
              <p style={{ margin: '12px 0 0', color: 'var(--warning)', fontSize: 12, lineHeight: 1.45 }} aria-live="polite">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={sendFitWorkout}
              disabled={fitSending || !structuredWorkout}
              className="w-full rounded-xl py-3 font-bold flex items-center justify-center gap-2"
              style={{ marginTop: 16, minHeight: 48, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: fitSending ? 'wait' : 'pointer' }}
            >
              <FileDown size={18} aria-hidden="true" />
              {fitSending ? 'Creating .FIT file...' : 'Create .FIT file'}
            </button>
          </section>
        </div>
      )}
    </div>
  )
}
