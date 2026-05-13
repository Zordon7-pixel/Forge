import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, ChevronRight, HeartPulse, Moon, RefreshCw, Shield, Watch } from 'lucide-react'
import api from '../lib/api'
import HealthService from '../services/HealthService'

const HEALTH_SYNC_RESULT_KEY = 'forge_last_health_sync_result'

function numberText(value, fallback = '--') {
  const num = Number(value)
  return Number.isFinite(num) ? num.toLocaleString() : fallback
}

function decimalText(value, digits = 1, fallback = '--') {
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(digits) : fallback
}

function dateText(value) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Never'
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function durationText(seconds) {
  const total = Number(seconds || 0)
  if (!Number.isFinite(total) || total <= 0) return '--'
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins ? `${hours}h ${mins}m` : `${hours}h`
}

function getLastSyncResult() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HEALTH_SYNC_RESULT_KEY) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function saveLastSyncResult(result) {
  try {
    localStorage.setItem(HEALTH_SYNC_RESULT_KEY, JSON.stringify({
      imported: Number(result?.imported || 0),
      skipped: Number(result?.skipped || 0),
      errors: Array.isArray(result?.errors) ? result.errors : [],
      syncedAt: new Date().toISOString(),
    }))
  } catch {}
}

function MetricCard({ label, value, detail, icon: Icon }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p>
        {Icon && <Icon size={16} color="#EAB308" />}
      </div>
      <p className="mt-2 text-xl font-black" style={{ color: 'var(--text-primary)' }}>{value}</p>
      {detail && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{detail}</p>}
    </div>
  )
}

export default function HealthData() {
  const [health, setHealth] = useState(null)
  const [runs, setRuns] = useState([])
  const [lifts, setLifts] = useState([])
  const [lastSyncResult, setLastSyncResult] = useState(() => getLastSyncResult())
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState('')

  const loadData = async () => {
    setLoading(true)
    try {
      const [healthRes, runsRes, liftsRes] = await Promise.all([
        api.get('/health/sync').catch(() => ({ data: null })),
        api.get('/runs').catch(() => ({ data: { runs: [] } })),
        api.get('/lifts').catch(() => ({ data: { lifts: [] } })),
      ])
      setHealth(healthRes.data || null)
      setRuns(Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || [])
      setLifts(liftsRes.data?.lifts || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const importedActivities = useMemo(() => {
    const importedRuns = runs
      .filter((run) => run.watch_mode === 'import' || run.watch_normalized_type === 'imported')
      .map((run) => ({
        id: run.id,
        type: run.type || 'run',
        date: run.date,
        title: `${run.type || 'Run'} · ${decimalText(run.distance_miles, 2)} mi`,
        detail: durationText(run.duration_seconds),
      }))
    const importedLifts = lifts
      .filter((lift) => lift.watch_normalized_type === 'imported' || String(lift.notes || '').includes('Imported workout'))
      .map((lift) => ({
        id: lift.id,
        type: 'strength',
        date: lift.date,
        title: lift.exercise_name || 'Imported Strength Session',
        detail: durationText(lift.workout_duration_seconds),
      }))
    return [...importedRuns, ...importedLifts]
      .sort((a, b) => new Date(`${b.date}T12:00:00`).getTime() - new Date(`${a.date}T12:00:00`).getTime())
      .slice(0, 8)
  }, [runs, lifts])

  const syncAppleHealth = async () => {
    setSyncing(true)
    setNotice('')
    try {
      const result = await HealthService.syncNativeData({ requestPermission: true })
      saveLastSyncResult(result)
      setLastSyncResult(getLastSyncResult())
      setNotice(`Apple Health synced: ${result.imported} imported, ${result.skipped} skipped.`)
      await loadData()
    } catch (err) {
      setNotice(err?.message || 'Unable to sync Apple Health on this device.')
    } finally {
      setSyncing(false)
    }
  }

  const skippedText = lastSyncResult
    ? `${numberText(lastSyncResult.skipped, '0')} skipped`
    : 'No import report yet'
  const skippedDetail = lastSyncResult?.skipped
    ? 'Skipped usually means those workouts already exist in Forge.'
    : 'Sync from this screen to see imported and skipped counts.'

  return (
    <div className="space-y-4 pb-16">
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: '#EAB308' }}>Apple Health</p>
            <h1 className="mt-1 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>Health Data Center</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Everything Forge has synced from your iPhone so far.</p>
          </div>
          <Shield size={22} color="#EAB308" />
        </div>
        <button
          type="button"
          onClick={syncAppleHealth}
          disabled={syncing}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-black disabled:opacity-60"
          style={{ background: 'var(--accent)', color: '#000', border: 'none', cursor: syncing ? 'wait' : 'pointer' }}
        >
          <RefreshCw size={16} />
          {syncing ? 'Syncing Apple Health...' : 'Sync Apple Health'}
        </button>
        {notice && <p className="mt-3 text-xs" style={{ color: notice.includes('synced') ? '#22C55E' : '#F97316' }}>{notice}</p>}
      </section>

      <section className="grid grid-cols-2 gap-3">
        <MetricCard label="Last sync" value={dateText(health?.synced_at)} detail={lastSyncResult ? `Import report: ${dateText(lastSyncResult.syncedAt)}` : 'No sync report on this device'} icon={RefreshCw} />
        <MetricCard label="Import result" value={lastSyncResult ? `${numberText(lastSyncResult.imported, '0')} imported` : 'Unknown'} detail={skippedText} icon={Activity} />
        <MetricCard label="Steps today" value={numberText(health?.steps_today, '0')} detail="From Apple Health step count" icon={Activity} />
        <MetricCard label="Calories today" value={numberText(health?.calories_today, '0')} detail="Active energy burned" icon={Activity} />
        <MetricCard label="Miles this week" value={`${decimalText(health?.total_miles_this_week, 2, '0.00')} mi`} detail="Walking/running distance" icon={Activity} />
        <MetricCard label="Workouts this week" value={numberText(health?.workout_count_this_week, '0')} detail={`${numberText(health?.active_minutes_this_week, '0')} active minutes`} icon={Watch} />
        <MetricCard label="Sleep last night" value={`${decimalText(health?.sleep_hours_last_night, 1)}h`} detail="Only appears if Health has sleep data" icon={Moon} />
        <MetricCard label="Resting HR" value={health?.resting_heart_rate ? `${health.resting_heart_rate} bpm` : '--'} detail={health?.hrv_ms ? `HRV ${health.hrv_ms} ms` : 'HRV appears when available'} icon={HeartPulse} />
      </section>

      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Last Workout From Health</p>
        <div className="mt-3 rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-lg font-black capitalize" style={{ color: 'var(--text-primary)' }}>{health?.last_workout_type || '--'}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {durationText(health?.last_workout_duration_seconds)}
            {health?.last_workout_calories ? ` · ${numberText(health.last_workout_calories)} cal` : ''}
            {health?.avg_heart_rate_last_run ? ` · last run avg ${health.avg_heart_rate_last_run} bpm` : ''}
          </p>
        </div>
      </section>

      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Import Report</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{skippedDetail}</p>
          </div>
          <p className="text-xs font-bold" style={{ color: '#EAB308' }}>{skippedText}</p>
        </div>
        {lastSyncResult?.errors?.length > 0 && (
          <div className="mt-3 rounded-xl p-3" style={{ background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.35)' }}>
            <p className="text-xs font-bold" style={{ color: '#F97316' }}>Some rows could not import.</p>
          </div>
        )}
      </section>

      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Recent Imported Activity</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Runs and strength sessions Forge created from Apple Health imports.</p>
          </div>
          <Link to="/history" className="flex items-center gap-1 text-xs font-bold" style={{ color: '#EAB308', textDecoration: 'none' }}>
            History <ChevronRight size={14} />
          </Link>
        </div>
        <div className="mt-3 space-y-2">
          {loading && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading health data...</p>}
          {!loading && importedActivities.length === 0 && (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No imported Apple Health workouts are visible yet. Sync Apple Health to import workouts.</p>
          )}
          {importedActivities.map((item) => (
            <div key={`${item.type}-${item.id}`} className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
              <p className="text-sm font-bold capitalize" style={{ color: 'var(--text-primary)' }}>{item.title}</p>
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{item.date || 'No date'} · {item.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
