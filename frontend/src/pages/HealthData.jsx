import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, ChevronRight, HeartPulse, Moon, RefreshCw, Shield, Watch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import HealthService from '../services/HealthService'

const HEALTH_SYNC_RESULT_KEY = 'forge_last_health_sync_result'

function dateText(value) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Never'
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function getLastSyncResult() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HEALTH_SYNC_RESULT_KEY) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    console.warn('[body] sync result parse failed:', err.message)
    return null
  }
}

function saveLastSyncResult(result) {
  try {
    const scanned = Array.isArray(result?.workouts) ? result.workouts.length : Number(result?.scanned || result?.total || 0)
    localStorage.setItem(HEALTH_SYNC_RESULT_KEY, JSON.stringify({
      scanned: Number(scanned || 0),
      imported: Number(result?.imported || 0),
      skipped: Number(result?.skipped || 0),
      errors: Array.isArray(result?.errors) ? result.errors : [],
      syncedAt: new Date().toISOString(),
    }))
  } catch (err) {
    console.warn('[body] sync result save failed:', err.message)
  }
}

function trendMeta(trend) {
  if (trend === 'up') return { arrow: '↑', color: '#22C55E' }
  if (trend === 'down') return { arrow: '↓', color: '#EF4444' }
  return { arrow: '→', color: 'var(--text-muted)' }
}

function DriverCard({ driver, trendLabels }) {
  const trend = trendMeta(driver.trend)
  return (
    <article className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <p className="text-xs font-black uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{driver.label}</p>
      <div className="mt-2 flex items-end gap-2">
        <p className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{driver.value}</p>
        <span className="pb-1 text-lg font-black" style={{ color: trend.color }} aria-label={trendLabels[driver.trend] || trendLabels.flat}>
          {trend.arrow}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{driver.plainEnglish}</p>
      <p className="mt-3 text-xs italic" style={{ color: driver.impact === 'negative' ? '#F97316' : 'var(--text-muted)' }}>{driver.suggestion}</p>
    </article>
  )
}

function SourcePill({ icon: Icon, label, detail }) {
  return (
    <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
      <Icon size={15} color="#EAB308" />
      <div>
        <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{label}</p>
        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{detail}</p>
      </div>
    </div>
  )
}

export default function HealthData() {
  const { t } = useTranslation()
  const [driversData, setDriversData] = useState(null)
  const [health, setHealth] = useState(null)
  const [runs, setRuns] = useState([])
  const [lastSyncResult, setLastSyncResult] = useState(() => getLastSyncResult())
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState('')

  const loadData = async () => {
    setLoading(true)
    try {
      const [driversRes, healthRes, runsRes] = await Promise.all([
        api.get('/body/drivers').catch(() => ({ data: null })),
        api.get('/health/sync').catch(() => ({ data: null })),
        api.get('/runs').catch(() => ({ data: { runs: [] } })),
      ])
      setDriversData(driversRes.data || { summary: t('body.allGood'), limiter: null, drivers: [] })
      setHealth(healthRes.data || null)
      setRuns(Array.isArray(runsRes.data) ? runsRes.data : runsRes.data?.runs || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const syncAppleHealth = async () => {
    setSyncing(true)
    setNotice('')
    try {
      const result = await HealthService.syncNativeData({ requestPermission: true })
      saveLastSyncResult(result)
      setLastSyncResult(getLastSyncResult())
      const scanned = Array.isArray(result?.workouts) ? result.workouts.length : Number(result?.scanned || 0)
      setNotice(`Apple Health synced: ${scanned} scanned, ${result.imported} imported, ${result.skipped} already in Forge.`)
      await loadData()
    } catch (err) {
      setNotice(err?.message || 'Unable to sync Apple Health on this device.')
    } finally {
      setSyncing(false)
    }
  }

  const drivers = Array.isArray(driversData?.drivers) ? driversData.drivers : []
  const limiterDriver = drivers.find((driver) => driver.key === driversData?.limiter)
  const connectedSources = useMemo(() => {
    const sources = []
    if (health?.synced_at || lastSyncResult?.syncedAt) sources.push({ key: 'apple', label: 'Apple Health', detail: dateText(health?.synced_at || lastSyncResult?.syncedAt), icon: Watch })
    if (runs.some((run) => run.garmin_activity_id || String(run.watch_activity_type || '').toLowerCase().includes('garmin'))) sources.push({ key: 'garmin', label: 'Garmin', detail: 'Imported activity present', icon: Activity })
    return sources
  }, [health, lastSyncResult, runs])
  const trendLabels = { up: t('body.trendUp'), down: t('body.trendDown'), flat: t('body.trendFlat') }

  return (
    <div className="space-y-4 pb-16">
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: '#EAB308' }}>Apple Health</p>
            <h1 className="mt-1 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>Body</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Your readiness, recovery, and how it shapes today's training.</p>
          </div>
          <Shield size={22} color="#EAB308" />
        </div>
      </section>

      <section className="rounded-2xl p-4" style={{ background: driversData?.limiter ? 'var(--accent)' : 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-xs font-black uppercase tracking-wide" style={{ color: driversData?.limiter ? '#000' : '#EAB308' }}>
          {driversData?.limiter ? `${limiterDriver?.label || 'Readiness'} ${t('body.limiterPrefix')}` : 'Readiness'}
        </p>
        <h2 className="mt-2 text-xl font-black leading-tight" style={{ color: driversData?.limiter ? '#000' : 'var(--text-primary)' }}>
          {loading ? 'Reading your body signals...' : driversData?.summary || t('body.allGood')}
        </h2>
        <p className="mt-2 text-sm" style={{ color: driversData?.limiter ? '#111827' : 'var(--text-muted)' }}>
          {limiterDriver?.suggestion || t('body.allGood')}
        </p>
      </section>

      {drivers.length === 0 && !loading ? (
        <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('body.noData')}</p>
          <Link
            to="/settings"
            className="mt-3 inline-flex rounded-xl px-4 py-2 text-sm font-black"
            style={{ background: 'var(--accent)', color: '#000', textDecoration: 'none' }}
          >
            {t('body.noDataCta')}
          </Link>
        </section>
      ) : (
        <section className="grid grid-cols-2 gap-3">
          {drivers.map((driver) => (
            <DriverCard key={driver.key} driver={driver} trendLabels={trendLabels} />
          ))}
        </section>
      )}

      {connectedSources.length > 0 && (
        <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Connected sources</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {connectedSources.map((source) => (
              <SourcePill key={source.key} icon={source.icon} label={source.label} detail={source.detail} />
            ))}
          </div>
        </section>
      )}

      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Sync controls</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              {lastSyncResult ? `${lastSyncResult.imported || 0} imported · ${lastSyncResult.skipped || 0} already saved · ${dateText(lastSyncResult.syncedAt)}` : 'Sync Apple Health to refresh readiness drivers.'}
            </p>
          </div>
          <HeartPulse size={18} color="#EAB308" />
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
        <Link to="/history" className="mt-3 flex items-center gap-1 text-xs font-bold" style={{ color: '#EAB308', textDecoration: 'none' }}>
          Review imported activity <ChevronRight size={14} />
        </Link>
      </section>
    </div>
  )
}
