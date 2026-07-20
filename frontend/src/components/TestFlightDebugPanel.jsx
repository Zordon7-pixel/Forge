import { useEffect, useMemo, useState } from 'react'
import { Clipboard, X } from 'lucide-react'
import appConfig from '../../app.json'
import frontendPackage from '../../package.json'
import { getUser } from '../lib/auth'
import api, { API_BASE_URL } from '../lib/api'

function getAllowedEmails() {
  return String(import.meta.env.VITE_DEBUG_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

function isNativeRuntime() {
  return typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.())
}

function isLocalHost() {
  if (typeof window === 'undefined') return false
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatTimestamp(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatClassification(value) {
  return String(value || 'limited').replace(/_/g, ' ')
}

const HEALTH_FIELD_LABELS = {
  steps_today: 'Steps today',
  calories_today: 'Calories today',
  avg_heart_rate_last_run: 'Avg heart rate last run',
  total_miles_this_week: 'Total miles this week',
  resting_heart_rate: 'Resting heart rate',
  hrv_ms: 'HRV',
  sleep_hours_last_night: 'Sleep last night',
  active_minutes_this_week: 'Active minutes this week',
  workout_count_this_week: 'Workout count this week',
  last_workout_type: 'Last workout type',
  last_workout_duration_seconds: 'Last workout duration',
  last_workout_calories: 'Last workout calories',
}

export default function TestFlightDebugPanel({ open, onClose }) {
  const [buildMeta, setBuildMeta] = useState(null)
  const [healthCoverage, setHealthCoverage] = useState(null)
  const [healthCoverageError, setHealthCoverageError] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const user = getUser()

  const access = useMemo(() => {
    const email = String(user?.email || '').toLowerCase()
    const allowedEmails = getAllowedEmails()
    const explicitEnabled = import.meta.env.VITE_ENABLE_TESTFLIGHT_DEBUG === 'true'
    const local = isLocalHost() || import.meta.env.DEV
    const allowed = local || explicitEnabled || (email && allowedEmails.includes(email))
    return { allowed, local, explicitEnabled, allowedEmailsConfigured: allowedEmails.length > 0 }
  }, [user?.email])

  useEffect(() => {
    if (!open || !access.allowed) return
    let active = true
    api.get('/meta/build')
      .then((res) => {
        if (active) setBuildMeta(res.data || null)
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Build metadata unavailable.')
      })
    return () => {
      active = false
    }
  }, [open, access.allowed])

  useEffect(() => {
    if (!open || !access.allowed) return
    let active = true
    setHealthCoverage(null)
    setHealthCoverageError('')
    api.get('/health/coverage')
      .then((res) => {
        if (active) setHealthCoverage(res.data || null)
      })
      .catch((err) => {
        if (active) setHealthCoverageError(err?.response?.data?.error || 'Health coverage unavailable.')
      })
    return () => {
      active = false
    }
  }, [open, access.allowed])

  if (!open) return null

  const healthFieldRows = Object.entries(healthCoverage?.fields || {}).map(([key, field]) => ({
    key,
    label: HEALTH_FIELD_LABELS[key] || key,
    present: Boolean(field?.present),
  }))
  const healthTrainingMetricKeys = healthCoverage?.training_metric_keys || []
  const expo = appConfig.expo || {}
  const ios = expo.ios || {}
  const payload = {
    app: {
      name: expo.name || 'FORGE',
      expoVersion: expo.version || 'unknown',
      frontendVersion: frontendPackage.version || 'unknown',
      buildNumber: ios.buildNumber || 'unknown',
      bundleId: ios.bundleIdentifier || 'unknown',
      nativeRuntime: isNativeRuntime(),
    },
    environment: {
      mode: import.meta.env.MODE,
      host: typeof window !== 'undefined' ? window.location.host : 'unknown',
      origin: typeof window !== 'undefined' ? window.location.origin : 'unknown',
      backendUrl: API_BASE_URL,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    },
    backend: buildMeta,
    user: {
      id: user?.id || null,
      email: user?.email || null,
      onboarded: user?.onboarded ?? null,
    },
    healthCoverage: healthCoverage ? {
      classification: healthCoverage.classification,
      synced_at: healthCoverage.synced_at,
      stale: healthCoverage.stale,
      presentFields: healthFieldRows.filter((field) => field.present).map((field) => field.key),
      trainingMetricKeys: healthTrainingMetricKeys,
    } : null,
    capturedAt: new Date().toISOString(),
  }

  const rows = [
    ['App version', payload.app.expoVersion],
    ['Build number', payload.app.buildNumber],
    ['Bundle ID', payload.app.bundleId],
    ['Frontend version', payload.app.frontendVersion],
    ['Backend URL', payload.environment.backendUrl],
    ['Railway deployment', buildMeta?.railwayDeploymentId],
    ['Railway environment', buildMeta?.railwayEnvironment],
    ['User ID', payload.user.id],
    ['User email', payload.user.email],
    ['Runtime', payload.app.nativeRuntime ? 'Native' : 'Web'],
    ['Mode', payload.environment.mode],
    ['Host', payload.environment.host],
  ]

  const copyDebugInfo = async () => {
    setCopied(false)
    const text = JSON.stringify(payload, null, 2)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        throw new Error('Clipboard API unavailable')
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      } else {
        setError('Clipboard unavailable. Select and copy the debug payload manually.')
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/70">
      <div className="w-full max-h-[82vh] overflow-y-auto rounded-t-2xl border p-5" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--accent)', letterSpacing: 0.8 }}>TestFlight Debug</p>
            <h2 className="mt-1 text-xl font-black">Build diagnostics</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }} aria-label="Close debug panel">
            <X size={16} />
          </button>
        </div>

        {!access.allowed ? (
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--accent-dim)' }}>
            <p className="text-sm font-bold">Debug panel restricted</p>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              Production debug output requires `VITE_ENABLE_TESTFLIGHT_DEBUG=true` or an email in `VITE_DEBUG_ADMIN_EMAILS`.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-2">
              {rows.map(([label, value]) => (
                <div key={label} className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
                  <p className="text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.5 }}>{label}</p>
                  <p className="mt-1 break-words text-sm font-semibold">{formatValue(value)}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.5 }}>Health delivery</p>
                  <p className="mt-1 text-lg font-black capitalize">{healthCoverage ? formatClassification(healthCoverage.classification) : 'Loading'}</p>
                </div>
                <div className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>
                  <p className="font-bold">{healthCoverage ? (healthCoverage.stale ? 'Stale' : 'Fresh') : 'Unknown'}</p>
                  <p>{formatTimestamp(healthCoverage?.synced_at)}</p>
                </div>
              </div>

              {healthCoverageError ? (
                <p className="mt-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--warning-dim)', background: 'rgba(249,115,22,0.1)', color: 'var(--warning)' }}>
                  {healthCoverageError}
                </p>
              ) : healthCoverage ? (
                <>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {healthFieldRows.map((field) => (
                      <div key={field.key} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                        <span className="font-semibold">{field.label}</span>
                        <span className="text-xs font-bold uppercase" style={{ color: field.present ? 'var(--success)' : 'var(--text-muted)', letterSpacing: 0.4 }}>
                          {field.present ? 'Present' : 'Missing'}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                    <p className="text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.5 }}>Training metric keys</p>
                    <p className="mt-1 break-words text-sm font-semibold">
                      {healthTrainingMetricKeys.length ? healthTrainingMetricKeys.join(', ') : 'None'}
                    </p>
                  </div>
                </>
              ) : (
                <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>Loading health coverage...</p>
              )}
            </div>

            {error && (
              <p className="mt-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--warning-dim)', background: 'rgba(249,115,22,0.1)', color: 'var(--warning)' }}>
                {error}
              </p>
            )}

            <button type="button" onClick={copyDebugInfo} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
              <Clipboard size={16} />
              {copied ? 'Copied' : 'Copy debug info'}
            </button>

            <pre className="mt-3 max-h-56 overflow-auto rounded-xl p-3 text-[11px]" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
              {JSON.stringify(payload, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}
