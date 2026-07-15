import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { HeartPulse, Shield } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import Skeleton from '../components/Skeleton'

function dateText(value) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Never'
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function numberText(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number.toLocaleString() : null
}

function decimalText(value, digits = 1) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number.toFixed(digits) : null
}

function paceFromMetersPerSecond(value) {
  const speed = Number(value)
  if (!Number.isFinite(speed) || speed <= 0) return null
  const totalSeconds = Math.round(1609.344 / speed)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}/mi`
}

function trendMeta(trend) {
  if (trend === 'up') return { arrow: '↑', color: 'var(--success)' }
  if (trend === 'down') return { arrow: '↓', color: 'var(--danger)' }
  return { arrow: '→', color: 'var(--text-muted)' }
}

function DriverCard({ driver, trendLabels }) {
  const trend = trendMeta(driver.trend)
  return (
    <article className="card p-4">
      <p className="t-micro">{driver.label}</p>
      <div className="mt-2 flex items-end gap-2">
        <p className="stat-num" style={{ color: 'var(--text-primary)', fontSize: 24, lineHeight: 1.1 }}>{driver.value}</p>
        <span className="pb-1 text-lg font-black" style={{ color: trend.color }} aria-label={trendLabels[driver.trend] || trendLabels.flat}>
          {trend.arrow}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{driver.plainEnglish}</p>
      <p className="mt-3 text-xs italic" style={{ color: driver.impact === 'negative' ? 'var(--warning)' : 'var(--text-muted)' }}>{driver.suggestion}</p>
    </article>
  )
}

function MetricCell({ cell }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
      <p className="t-micro">{cell.label}</p>
      <p className="stat-num mt-1" style={{ color: 'var(--text-primary)', fontSize: 22, lineHeight: 1.1 }}>{cell.value}</p>
      {cell.detail && <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{cell.detail}</p>}
    </div>
  )
}

function MetricGroup({ title, subtitle, cells }) {
  if (!cells.length) return null
  return (
    <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{title}</p>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {cells.map((cell) => <MetricCell key={cell.key} cell={cell} />)}
      </div>
    </section>
  )
}

export default function HealthData() {
  const { t } = useTranslation()
  const [driversData, setDriversData] = useState(null)
  const [health, setHealth] = useState(null)
  const [readinessHistory, setReadinessHistory] = useState([])
  const [loading, setLoading] = useState(true)

  const loadData = async () => {
    setLoading(true)
    try {
      const [driversRes, healthRes, readinessRes] = await Promise.all([
        api.get('/body/drivers').catch(() => ({ data: null })),
        api.get('/health/sync').catch(() => ({ data: null })),
        api.get('/recovery/readiness/history?days=14').catch(() => ({ data: null })),
      ])
      setDriversData(driversRes.data || { summary: t('body.allGood'), limiter: null, drivers: [] })
      setHealth(healthRes.data || null)
      setReadinessHistory(Array.isArray(readinessRes.data?.days) ? readinessRes.data.days : [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const drivers = Array.isArray(driversData?.drivers) ? driversData.drivers : []
  const limiterDriver = drivers.find((driver) => driver.key === driversData?.limiter)
  const metricCells = useMemo(() => {
    const restingHr = health?.resting_heart_rate_bpm || health?.resting_heart_rate
    const avgWorkoutHr = health?.avg_heart_rate_bpm_last_workout || health?.avg_hr_bpm_last_workout || health?.avg_heart_rate_last_run
    return [
      { key: 'steps', label: 'Steps today', value: numberText(health?.steps_today), detail: null },
      { key: 'miles', label: 'Walk + run', value: decimalText(health?.total_miles_this_week) ? `${decimalText(health.total_miles_this_week)} mi` : null, detail: 'past 7 days' },
      { key: 'activeMin', label: 'Active min', value: numberText(health?.active_minutes_this_week), detail: 'past 7 days' },
      { key: 'exerciseMin', label: 'Exercise min', value: numberText(health?.exercise_minutes_this_week), detail: 'Apple ring · 7 days' },
      { key: 'restingHr', label: 'Resting HR', value: numberText(restingHr) ? `${Math.round(Number(restingHr))} bpm` : null, detail: null },
      { key: 'calories', label: 'Calories', value: numberText(health?.calories_today), detail: 'today' },
      { key: 'workouts', label: 'Workouts', value: numberText(health?.workout_count_this_week), detail: 'past 7 days' },
      { key: 'avgHr', label: 'Avg workout HR', value: numberText(avgWorkoutHr) ? `${Math.round(Number(avgWorkoutHr))} bpm` : null, detail: 'last session' },
    ].filter((cell) => cell.value && cell.value !== '--' && cell.value !== '0')
  }, [health])
  const hasMetricStrip = metricCells.length > 0
  const extendedMetricGroups = useMemo(() => {
    const syncedAt = health?.synced_at
    const detail = (timestamp, context) => `${context} · ${dateText(timestamp || syncedAt)}`
    const sleepBaseline = decimalText(health?.sleep_hours_7d_baseline)
    const rhrBaseline = numberText(health?.resting_heart_rate_baseline)
    const hrvBaseline = numberText(health?.hrv_ms_baseline)
    const speed = decimalText(health?.running_speed_mps, 2)
    return [
      {
        key: 'recovery',
        title: 'Recovery detail',
        subtitle: 'Fresh sleep, HRV, and resting heart rate can adjust today and the next 48-72 hours.',
        cells: [
          { key: 'sleep', label: 'Sleep', value: decimalText(health?.sleep_hours_last_night) ? `${decimalText(health.sleep_hours_last_night)} h` : null, detail: sleepBaseline ? `7-night avg ${sleepBaseline} h` : detail(health?.sleep_end_at, 'latest night') },
          { key: 'deep', label: 'Deep sleep', value: decimalText(health?.sleep_deep_hours) ? `${decimalText(health.sleep_deep_hours)} h` : null, detail: 'latest night' },
          { key: 'rem', label: 'REM sleep', value: decimalText(health?.sleep_rem_hours) ? `${decimalText(health.sleep_rem_hours)} h` : null, detail: 'latest night' },
          { key: 'core', label: 'Core sleep', value: decimalText(health?.sleep_core_hours) ? `${decimalText(health.sleep_core_hours)} h` : null, detail: 'latest night' },
          { key: 'awake', label: 'Awake', value: decimalText(health?.sleep_awake_hours) ? `${decimalText(health.sleep_awake_hours)} h` : null, detail: 'during sleep window' },
          { key: 'hrv', label: 'HRV', value: numberText(health?.hrv_ms) ? `${Math.round(Number(health.hrv_ms))} ms` : null, detail: hrvBaseline ? `baseline ${hrvBaseline} ms` : detail(health?.hrv_recorded_at, 'latest') },
          { key: 'rhr', label: 'Resting HR', value: numberText(health?.resting_heart_rate) ? `${Math.round(Number(health.resting_heart_rate))} bpm` : null, detail: rhrBaseline ? `baseline ${rhrBaseline} bpm` : detail(health?.resting_heart_rate_recorded_at, 'latest') },
          { key: 'respiratory', label: 'Respiratory rate', value: decimalText(health?.respiratory_rate) ? `${decimalText(health.respiratory_rate)} /min` : null, detail: detail(health?.respiratory_rate_recorded_at, 'latest') },
        ].filter((cell) => cell.value),
      },
      {
        key: 'cardio',
        title: 'Cardio fitness',
        subtitle: 'Longer-term fitness and recovery trends add context; no single value sets the plan by itself.',
        cells: [
          { key: 'vo2', label: 'VO2 max', value: decimalText(health?.vo2_max) ? `${decimalText(health.vo2_max)} ml/kg/min` : null, detail: detail(health?.vo2_max_recorded_at, 'latest estimate') },
          { key: 'walkingHr', label: 'Walking HR', value: numberText(health?.walking_heart_rate_average) ? `${Math.round(Number(health.walking_heart_rate_average))} bpm` : null, detail: detail(health?.walking_heart_rate_recorded_at, 'latest average') },
          { key: 'hrRecovery', label: '1-min HR recovery', value: numberText(health?.heart_rate_recovery_one_minute) ? `${Math.round(Number(health.heart_rate_recovery_one_minute))} bpm` : null, detail: detail(health?.heart_rate_recovery_recorded_at, 'latest') },
        ].filter((cell) => cell.value),
      },
      {
        key: 'running',
        title: 'Latest run form',
        subtitle: 'Apple Watch running dynamics help track form trends. They are not used as a medical judgment.',
        cells: [
          { key: 'power', label: 'Running power', value: numberText(health?.running_power_watts) ? `${Math.round(Number(health.running_power_watts))} W` : null, detail: detail(health?.running_dynamics_recorded_at, 'latest run') },
          { key: 'speed', label: 'Running pace', value: paceFromMetersPerSecond(health?.running_speed_mps), detail: speed ? `${speed} m/s` : null },
          { key: 'stride', label: 'Stride length', value: decimalText(health?.running_stride_length_m, 2) ? `${decimalText(health.running_stride_length_m, 2)} m` : null, detail: 'latest run average' },
          { key: 'vertical', label: 'Vertical oscillation', value: decimalText(health?.running_vertical_oscillation_cm) ? `${decimalText(health.running_vertical_oscillation_cm)} cm` : null, detail: 'latest run average' },
          { key: 'contact', label: 'Ground contact', value: numberText(health?.running_ground_contact_time_ms) ? `${Math.round(Number(health.running_ground_contact_time_ms))} ms` : null, detail: 'latest run average' },
        ].filter((cell) => cell.value),
      },
    ]
  }, [health])
  const trendLabels = { up: t('body.trendUp'), down: t('body.trendDown'), flat: t('body.trendFlat') }

  return (
    <div className="space-y-4 pb-16">
      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>Apple Health</p>
            <h1 className="mt-1 text-2xl font-black" style={{ color: 'var(--text-primary)' }}>Body</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Your readiness, recovery, and how it shapes today's training. Plain English.</p>
          </div>
          <Shield size={22} color="var(--accent)" />
        </div>
      </section>

      <section className={driversData?.limiter ? 'card-hero p-4' : 'card p-4'} style={{ background: driversData?.limiter ? 'var(--accent)' : 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-xs font-black uppercase tracking-wide" style={{ color: driversData?.limiter ? '#000' : 'var(--accent)' }}>
          {driversData?.limiter ? `${limiterDriver?.label || 'Readiness'} ${t('body.limiterPrefix')}` : 'Readiness'}
        </p>
        <h2 className="mt-2 text-xl font-black leading-tight" style={{ color: driversData?.limiter ? '#000' : 'var(--text-primary)' }}>
          {loading ? 'Reading your body signals...' : driversData?.summary || t('body.allGood')}
        </h2>
        <p className="mt-2 text-sm" style={{ color: driversData?.limiter ? '#111827' : 'var(--text-muted)' }}>
          {limiterDriver?.suggestion || 'No recovery signal is limiting today\'s training.'}
        </p>
      </section>

      {loading && <Skeleton rows={2} />}

      {drivers.length === 0 && !loading ? (
        <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <HeartPulse size={28} color="var(--accent)" style={{ marginBottom: 12 }} />
          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('body.noData')}</p>
          <Link
            to="/settings"
            className="mt-3 inline-flex rounded-xl px-4 py-2 text-sm font-black"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', textDecoration: 'none' }}
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

      {hasMetricStrip && (
        <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{t('body.last7Days')}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{t('body.last7DaysSubtitle')}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {metricCells.map((cell) => <MetricCell key={cell.key} cell={cell} />)}
          </div>
        </section>
      )}

      {extendedMetricGroups.map((group) => (
        <MetricGroup key={group.key} title={group.title} subtitle={group.subtitle} cells={group.cells} />
      ))}

      {readinessHistory.length > 0 && (
        <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>Readiness history</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Stored from passive Health data; missing days stay missing.</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {readinessHistory.map((entry) => (
              <div key={entry.date} className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-[10px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>{entry.date}</p>
                <p className="mt-1 text-xl font-black" style={{ color: 'var(--text-primary)' }}>{entry.score}</p>
                <p className="text-[10px] font-bold" style={{ color: entry.band === 'GREEN' ? 'var(--accent)' : entry.band === 'RED' ? 'var(--danger)' : 'var(--warning)' }}>{entry.band}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>How your plan uses this data</p>
        <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Completed runs establish mileage, pace, heart-rate, and recent-load history. Fresh sleep, HRV, resting heart rate, and your check-in can reduce or move near-term work. Cardio fitness and running-form values are supporting trends, never the only reason for a harder prescription.
        </p>
      </section>

    </div>
  )
}
