import { useEffect, useRef, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { createNotificationSetup } from '../lib/notifications'
import { requestServiceWorkerUpdate } from '../lib/serviceWorkerUpdate.js'
import { subscribeAuthSession, subscribePushSetupEpoch } from '../lib/tokenStore.js'

const copy = {
  checking: 'Checking notification setup…',
  unsupported: 'In-app sync alerts remain available on this device.',
  'browser-subscription-present-server-unverified': 'This browser has a notification subscription. Forge must verify server setup before showing it as on.',
  'browser-subscription-absent-server-unverified': 'This browser is not subscribed. Previous server setup, if any, cannot be verified here.',
  'confirmed-current-controllable': 'Notification setup is verified for this browser.',
  'confirmed-current-reverification-required': 'Setup is verified. Verify again to turn notifications off.',
  'setup-pending': 'Setup is pending. Open the setup notice, then continue here to verify it.',
  'transport-unknown': 'Setup delivery is unverified. If the setup notice arrived, continue here.',
  'verification-required': 'Forge could not verify current setup. Verify again before changing it.',
  conflict: 'Setup changed. Verify again before changing it.',
  expired: 'Setup expired. Start a new verification to continue.',
  cancelled: 'This setup attempt was cancelled. Previous notification settings are not verified here.',
  'permission-denied': 'Notifications were not allowed. You can change this in device settings.',
  'subscription-gesture-required': 'Press Continue to subscribe in this browser.',
  'update-required': 'Update Forge to finish enabling notifications. Your notification settings have not changed.',
  'server-revoked-known': 'Server notifications are off for this verified subscription.',
  'server-revoked-cleanup-incomplete': 'Server notifications are off; browser cleanup is incomplete.',
  'revoke-outcome-unknown': 'Revoke outcome unknown. Browser subscription has not been removed.',
}

export default function WorkoutNotificationControl() {
  const flow = useRef(null)
  const [state, setState] = useState({ state: 'checking', busy: false, supported: true, configured: false })
  useEffect(() => {
    let mounted = true, scheduled = false
    const replace = () => {
      if (!mounted) return
      const previous = flow.current
      flow.current = null // Disposal/old asynchronous callbacks cannot render a successor.
      previous?.dispose()
      setState({ state: 'checking', busy: false, supported: true, configured: false })
      const current = createNotificationSetup(value => { if (mounted && flow.current === current) setState(value) })
      flow.current = current
      void current.init() // Read-only; only a later explicit gesture may issue/create.
    }
    const invalidate = () => {
      if (!mounted || scheduled) return
      scheduled = true
      // Authentication emits epoch before generation and iterates live listener
      // sets. Register the successor only after the entire dispatch has ended.
      queueMicrotask(() => { scheduled = false; if (mounted) replace() })
    }
    replace()
    const offAuth = subscribeAuthSession(invalidate), offEpoch = subscribePushSetupEpoch(invalidate)
    return () => {
      mounted = false; offAuth(); offEpoch()
      const previous = flow.current; flow.current = null; previous?.dispose()
    }
  }, [])
  const active = state.state.startsWith('confirmed-current')
  const pending = ['setup-pending', 'transport-unknown'].includes(state.state)
  const update = state.state === 'update-required'
  const protectedFlow = state.busy || pending || active
  return (
    <section data-forge-reload-protected={protectedFlow ? 'true' : undefined} className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
          {active ? <Bell size={20} /> : <BellOff size={20} />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Activity alerts</h3>
          <p role="status" className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{copy[state.state] || copy['verification-required']}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Setup verification does not confirm that background activity delivery is available.</p>
        </div>
      </div>
      {state.supported && (state.configured || update) && (
        <div className="mt-3 flex flex-col gap-2">
          <button type="button" disabled={state.busy || state.state === 'checking'} onClick={() => {
            if (update) requestServiceWorkerUpdate()
            else if (state.state === 'confirmed-current-controllable') void flow.current?.revoke()
            else if (pending) void flow.current?.continueSetup()
            else void flow.current?.enable()
          }} className="pressable min-h-11 rounded-lg text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            {state.busy ? 'Checking…' : update ? 'Update Forge safely' : state.state === 'confirmed-current-controllable' ? 'Turn off alerts' : pending ? 'Continue enabling notifications' : state.state === 'subscription-gesture-required' ? 'Continue' : 'Enable notifications'}
          </button>
          {!update && !pending && state.state !== 'confirmed-current-controllable' && <button type="button" disabled={state.busy} onClick={() => void flow.current?.enable({ turnOff: true })} className="pressable min-h-11 text-sm">Verify and turn off</button>}
          {pending && <button type="button" disabled={state.busy} onClick={() => void flow.current?.cancel()} className="pressable min-h-11 text-sm">Cancel this setup</button>}
        </div>
      )}
    </section>
  )
}
