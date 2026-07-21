import { useEffect, useMemo, useState } from 'react'
import { Activity, HeartPulse, RefreshCw, Watch } from 'lucide-react'
import api from '../lib/api'
import { formatFreshness, providerSourcePresentation } from '../lib/deviceSourcePresentation'
import HealthService from '../services/HealthService'
import {
  getLastHealthSyncResult,
  HEALTH_SYNC_RESULT_EVENT,
  healthSyncFailureMessage,
  healthSyncNotice,
} from '../lib/healthSync'

function SourcePill({ icon: Icon, label, detail }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
      <Icon size={15} color="var(--accent)" className="shrink-0" />
      <div className="min-w-0">
        <p className="truncate text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{label}</p>
        <p className="truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{detail}</p>
      </div>
    </div>
  )
}

export default function HealthSourceManager() {
  const [health, setHealth] = useState(null)
  const [runs, setRuns] = useState([])
  const [lastSyncResult, setLastSyncResult] = useState(() => getLastHealthSyncResult())
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState('')
  const isNativeRuntime = typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.())

  const loadSources = async () => {
    const [healthRes, runsRes] = await Promise.all([
      api.get('/health/sync').catch((err) => {
        console.error('[health-sources] health status load failed:', err?.message || err)
        return { data: null }
      }),
      api.get('/runs').catch((err) => {
        console.error('[health-sources] run source load failed:', err?.message || err)
        return { data: { runs: [] } }
      }),
    ])
    setHealth(healthRes.data || null)
    setRuns(Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || [])
  }

  useEffect(() => {
    loadSources()
    const handleSyncResult = () => {
      setLastSyncResult(getLastHealthSyncResult())
      loadSources()
    }
    window.addEventListener(HEALTH_SYNC_RESULT_EVENT, handleSyncResult)
    return () => window.removeEventListener(HEALTH_SYNC_RESULT_EVENT, handleSyncResult)
  }, [])

  const connectedSources = useMemo(() => {
    const sources = []
    const activitySourceKinds = new Set(runs.map((run) => providerSourcePresentation(run.health_source).kind))
    const appleFreshness = formatFreshness(health?.synced_at || lastSyncResult?.syncedAt)
    if (appleFreshness || activitySourceKinds.has('apple_health') || activitySourceKinds.has('garmin_via_apple_health')) {
      sources.push({ key: 'apple', label: 'Apple Health', detail: appleFreshness || 'Imported activity present', icon: Watch })
    }
    if (activitySourceKinds.has('garmin_via_apple_health')) {
      sources.push({ key: 'garmin-via-apple', label: 'Garmin via Apple Health', detail: 'Explicit workout provenance present', icon: Activity })
    }
    if (activitySourceKinds.has('garmin_file')) {
      sources.push({ key: 'garmin', label: 'Garmin file', detail: 'Imported activity present', icon: Activity })
    }
    return sources
  }, [health, lastSyncResult, runs])

  const syncAppleHealth = async () => {
    setSyncing(true)
    setNotice('')
    try {
      const result = await HealthService.syncNativeData({ requestPermission: true })
      setLastSyncResult(getLastHealthSyncResult())
      setNotice(healthSyncNotice(result))
      await loadSources()
    } catch (err) {
      console.error('[health-sources] Apple Health sync failed:', err?.message || err)
      setNotice(healthSyncFailureMessage(err))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Health data & sync</p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {lastSyncResult
              ? `${lastSyncResult.complete === false ? `Partial · ${lastSyncResult.unresolved || 0} unresolved · ` : ''}${lastSyncResult.imported || 0} imported · ${lastSyncResult.skipped || 0} already saved · ${formatFreshness(lastSyncResult.syncedAt) || 'No sync yet'}`
              : 'Manage the data sources that power readiness and training changes.'}
          </p>
        </div>
        <HeartPulse size={18} color="var(--accent)" className="shrink-0" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {connectedSources.length > 0 ? connectedSources.map((source) => (
          <SourcePill key={source.key} icon={source.icon} label={source.label} detail={source.detail} />
        )) : (
          <p className="col-span-2 text-xs" style={{ color: 'var(--text-muted)' }}>No health source has completed a sync yet.</p>
        )}
      </div>

      <button
        type="button"
        onClick={syncAppleHealth}
        disabled={syncing || !isNativeRuntime}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-black disabled:opacity-60"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: syncing ? 'wait' : 'pointer' }}
      >
        <RefreshCw size={16} />
        {syncing ? 'Syncing Apple Health...' : 'Sync Apple Health'}
      </button>
      {!isNativeRuntime && <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>Apple Health sync runs in the iPhone app.</p>}
      {notice && <p className="mt-3 text-xs" style={{ color: notice.includes('synced') ? 'var(--success)' : 'var(--warning)' }}>{notice}</p>}
      {(health?.synced_at || lastSyncResult?.syncedAt) && Number(health?.metrics_schema_version || 0) < 3 && (
        <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--warning)' }}>
          New workout-route and activity-detail imports need the next approved iPhone build. Existing Apple Health sync still works.
        </p>
      )}

      <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <details>
          <summary className="cursor-pointer text-xs font-bold" style={{ color: 'var(--text-primary)' }}>Data coverage</summary>
          <div className="mt-2 space-y-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <p><strong style={{ color: 'var(--text-primary)' }}>Apple Health:</strong> sleep stages, HRV, resting and workout heart rate, activity, calories, VO2 max, recovery HR, respiratory rate, workouts, routes, elevation, weather metadata, and running dynamics when the source writes them.</p>
            <p><strong style={{ color: 'var(--text-primary)' }}>Garmin gaps:</strong> exact Garmin zone totals, ground-contact balance, performance condition, and run/walk segments are not reliably shared through Apple Health.</p>
            <p><strong style={{ color: 'var(--text-primary)' }}>File import:</strong> supported Garmin or Strava exports can fill some gaps. Forged Hybrid leaves unavailable values blank.</p>
          </div>
        </details>
      </div>
    </div>
  )
}
