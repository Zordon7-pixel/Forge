import { useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { disablePushNotifications, enablePushNotifications, getPushStatus } from '../lib/notifications'

export default function WorkoutNotificationControl() {
  const [state, setState] = useState({ loading: true, supported: true, configured: false, subscribed: false, permission: 'default' })
  const [message, setMessage] = useState('')

  useEffect(() => {
    getPushStatus()
      .then((status) => setState({ ...status, loading: false }))
      .catch((error) => {
        console.error('[WorkoutNotificationControl] status failed:', error?.message || error)
        setState((current) => ({ ...current, loading: false }))
      })
  }, [])

  const toggle = async () => {
    setState((current) => ({ ...current, loading: true }))
    setMessage('')
    try {
      if (state.subscribed) await disablePushNotifications()
      else await enablePushNotifications()
      const status = await getPushStatus()
      setState({ ...status, loading: false })
      setMessage(status.subscribed ? 'Activity alerts enabled.' : 'Activity alerts disabled.')
    } catch (error) {
      console.error('[WorkoutNotificationControl] toggle failed:', error?.message || error)
      setMessage(error?.message || 'Could not update activity alerts.')
      setState((current) => ({ ...current, loading: false }))
    }
  }

  const unavailable = !state.supported || !state.configured
  return (
    <section className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
          {state.subscribed ? <Bell size={20} /> : <BellOff size={20} />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Activity alerts</h3>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {unavailable ? 'In-app sync alerts remain available on this device.' : 'Get an alert when a connected activity is ready to review.'}
          </p>
        </div>
      </div>
      {!unavailable && (
        <button type="button" onClick={toggle} disabled={state.loading} className="pressable mt-3 min-h-11 w-full rounded-lg text-sm font-black" style={{ background: state.subscribed ? 'var(--bg-input)' : 'var(--accent)', color: state.subscribed ? 'var(--text-primary)' : 'var(--on-accent)' }}>
          {state.loading ? 'Checking...' : state.subscribed ? 'Turn off alerts' : 'Enable activity alerts'}
        </button>
      )}
      {message && <p role="status" className="mt-2 text-xs" style={{ color: message.includes('enabled') ? 'var(--success)' : 'var(--text-muted)' }}>{message}</p>}
    </section>
  )
}
