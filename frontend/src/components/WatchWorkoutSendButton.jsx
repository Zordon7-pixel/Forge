import { useEffect, useMemo, useState } from 'react'
import { Watch } from 'lucide-react'
import WatchWorkoutService from '../services/WatchWorkoutService'

export default function WatchWorkoutSendButton({ workout, label = 'Send to Apple Watch', className = '' }) {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [availability, setAvailability] = useState({ checked: false, available: false, reason: '' })
  const workoutText = useMemo(() => WatchWorkoutService.formatWorkoutText(workout || {}), [workout])

  useEffect(() => {
    let active = true
    WatchWorkoutService.getAvailability()
      .then((result) => {
        if (active) setAvailability({ checked: true, available: Boolean(result?.available), reason: result?.reason || '' })
      })
      .catch((err) => {
        if (active) setAvailability({ checked: true, available: false, reason: err?.message || 'Apple Watch workout sending is unavailable.' })
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
      setError(availability.reason || 'Apple Watch workout sending is unavailable.')
      setStatus('')
      return
    }
    setSending(true)
    setError('')
    setStatus('')
    try {
      await WatchWorkoutService.sendToAppleWatch(workout)
      setStatus('Sent to Apple Watch.')
    } catch (err) {
      setError(err?.message || 'Could not send this workout to Apple Watch.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={sendWorkout}
        disabled={sending || !workout || (availability.checked && !availability.available)}
        className="w-full rounded-xl py-3 font-bold flex items-center justify-center gap-2 disabled:opacity-60"
        style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: sending ? 'wait' : 'pointer' }}
      >
        <Watch size={17} />
        {sending ? 'Sending...' : availability.checked && !availability.available ? 'Apple Watch unavailable' : label}
      </button>
      <button
        type="button"
        onClick={copyWorkout}
        className="w-full mt-2 rounded-xl py-2 text-sm font-semibold"
        style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
      >
        Copy workout details
      </button>
      {status && <p className="mt-2 text-xs" style={{ color: '#22C55E' }}>{status}</p>}
      {(error || (availability.checked && !availability.available && availability.reason)) && (
        <p className="mt-2 text-xs" style={{ color: '#F97316' }}>
          {error || availability.reason}
        </p>
      )}
    </div>
  )
}
