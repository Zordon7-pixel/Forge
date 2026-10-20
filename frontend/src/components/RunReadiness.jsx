import { useEffect, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'
import { createRunReadiness } from '../lib/runReadiness'

export const runReadiness = createRunReadiness({
  nativeIOS: Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios',
  plugin: registerPlugin('ForgeRunReadiness'), app: App,
})

export function RunReadinessLifecycle() {
  useEffect(() => runReadiness.mount(), [])
  return null
}

export function useRunReadiness() {
  const [status, setStatus] = useState(() => runReadiness.snapshot())
  useEffect(() => {
    const unsubscribe = runReadiness.subscribe(setStatus)
    void runReadiness.refresh()
    return unsubscribe
  }, [])
  return status
}

// Inline, dismissible and nonmodal: Start and onboarding remain usable throughout.
export function RunReadinessExplainer({ observe = true, eligible = true } = {}) {
  const [shown, setShown] = useState(false)
  const [settingsFailed, setSettingsFailed] = useState(false)
  useEffect(() => {
    if (!eligible) return undefined
    if (observe) void runReadiness.refresh()
    return runReadiness.presentExplainer(() => setShown(true))
  }, [observe, eligible])
  if (!shown) return null
  return <section aria-label="iPhone run settings" data-testid="run-readiness-explainer" className="mb-4 rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
    <h2 className="text-sm font-bold">Keep your route recording</h2>
    <p className="mt-2 text-sm">For iPhone runs, turn on Background App Refresh, choose Location Always, and turn on Precise Location in Forge’s settings. If refresh is restricted, iOS manages it and you cannot change it here. You can start with any setting; your route may be incomplete.</p>
    <p className="mt-2 text-xs">We show this explanation once. Later checks stay silent. Opening Settings does not enable anything.</p>
    <div className="mt-3 flex gap-3">
      <button type="button" className="pressable rounded-lg border px-3" style={{ minHeight: 44 }} onClick={async () => {
        const opened = await runReadiness.openSettings()
        if (opened) setShown(false)
        else setSettingsFailed(true)
      }}>Open Settings</button>
      <button type="button" className="pressable rounded-lg border px-3" style={{ minHeight: 44 }} onClick={() => setShown(false)}>Continue</button>
    </div>
    {settingsFailed && <p role="status" className="mt-2 text-xs">Settings could not open. You can continue running.</p>}
  </section>
}
