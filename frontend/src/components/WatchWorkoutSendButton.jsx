import { useEffect, useMemo, useState } from 'react'
import { Watch } from 'lucide-react'
import track from '../lib/track'
import WatchDeliveryService from '../services/WatchDeliveryService'

export default function WatchWorkoutSendButton({ workout, label = 'Send to Watch', className = '', compact = false }) {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [availability, setAvailability] = useState({ checked: false, available: false, reason: '' })
  const workoutText = useMemo(() => WatchDeliveryService.formatFallbackText(workout || {}), [workout])

  useEffect(() => {
    let active = true
    WatchDeliveryService.getAvailability()
      .then((result) => {
        if (active) setAvailability({ checked: true, available: Boolean(result?.canAutoSend), reason: result?.reason || '' })
      })
      .catch((err) => {
        if (active) setAvailability({ checked: true, available: false, reason: err?.message || 'Watch delivery is unavailable.' })
      })
    return () => {
      active = false
    }
  }, [])

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
      setError(availability.reason || 'Watch delivery is unavailable.')
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
      setError(err?.message || 'Could not send this workout to your watch.')
    } finally {
      setSending(false)
    }
  }

  if (compact && !availability.checked) return null

  const canSend = availability.checked && availability.available
  const showSendButton = !compact || canSend

  return (
    <div className={className}>
      {showSendButton && (
        <button
          type="button"
          onClick={sendWorkout}
          disabled={sending || !workout || (availability.checked && !availability.available)}
          className="w-full rounded-xl py-3 font-bold flex items-center justify-center gap-2 disabled:opacity-60"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: sending ? 'wait' : 'pointer' }}
        >
          <Watch size={17} />
          {sending ? 'Sending...' : availability.checked && !availability.available ? 'Watch delivery unavailable' : label}
        </button>
      )}
      <button
        type="button"
        onClick={copyWorkout}
        className={`w-full rounded-xl py-2 text-sm font-semibold ${showSendButton ? 'mt-2' : ''}`}
        style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
      >
        {canSend ? 'Copy workout details' : 'Copy workout for manual entry'}
      </button>
      {status && <p className="mt-2 text-xs" style={{ color: 'var(--success)' }}>{status}</p>}
      {(error || (!compact && availability.checked && !availability.available && availability.reason)) && (
        <p className="mt-2 text-xs" style={{ color: 'var(--warning)' }}>
          {error || availability.reason}
        </p>
      )}
    </div>
  )
}
