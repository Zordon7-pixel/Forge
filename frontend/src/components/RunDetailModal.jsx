import { useState } from 'react'
import { X, Brain, Trash2 } from 'lucide-react'
import api from '../lib/api'
import { useUnits } from '../context/UnitsContext'
import AiGuidanceNote from './AiGuidanceNote'
import { Link } from 'react-router-dom'
import { activityLabel, isRunningActivity } from '../lib/activityType'

function fmtDuration(totalSeconds = 0) {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0 && s > 0) return `${m}m ${s}s`
  return `${m}m`
}

function formatActivityDate(value) {
  const raw = String(value || '')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw)
  if (Number.isNaN(date.getTime())) return 'Date unavailable'
  return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

function fmtPace(durationSeconds, distance) {
  if (!durationSeconds || !distance) return '--'
  const pace = durationSeconds / 60 / distance
  const mins = Math.floor(pace)
  const secs = Math.round((pace - mins) * 60)
  return `${mins}:${String(secs).padStart(2, '0')} /mi`
}

const EFFORT_LABELS = ['', 'Very Easy', 'Easy', 'Easy-Moderate', 'Moderate', 'Moderate-Hard', 'Hard', 'Hard', 'Very Hard', 'Very Hard', 'Max']
// hex required: consumed by `${color}XX` alpha templates — do not tokenize
const ZONE_COLORS = ['#6B7280', '#3B82F6', '#22C55E', '#EAB308', '#EF4444']
const ZONE_LABELS = ['Recovery', 'Easy', 'Aerobic', 'Threshold', 'Maximum']
const ZONE_MODEL_LABELS = { custom: 'Watch zones', hrr: 'HR Reserve', maxhr: 'Max-HR %', lthr: 'LTHR' }

function parseObject(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    console.error('[RunDetailModal] workout metrics parse failed:', error?.message || error)
    return {}
  }
}

function findZone(hr, zones) {
  if (!Number.isFinite(Number(hr)) || !Array.isArray(zones) || zones.length !== 5) return null
  const value = Number(hr)
  const index = zones.findIndex((entry, zoneIndex) => (
    value >= Number(entry.minBpm) && (zoneIndex === zones.length - 1 || value < Number(zones[zoneIndex + 1].minBpm))
  ))
  if (index < 0) return value < Number(zones[0]?.minBpm) ? { ...zones[0], zone: 1, below: true, color: ZONE_COLORS[0] } : null
  return { ...zones[index], zone: index + 1, color: ZONE_COLORS[index] }
}

function zoneTimeline(value, durationSeconds) {
  const parsed = parseObject(value)
  const seconds = ['z1', 'z2', 'z3', 'z4', 'z5'].map((key) => Math.max(0, Number(parsed[key] ?? parsed[key.toUpperCase()] ?? 0) || 0))
  const total = seconds.reduce((sum, item) => sum + item, 0)
  const duration = Number(durationSeconds || 0)
  return {
    seconds,
    total,
    coverage: duration > 0 && total > 0 ? Math.min(100, (total / duration) * 100) : null,
  }
}

function formatSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return fmtDuration(Math.round(seconds))
}

function formatSourceLabel(healthSource, metricSource) {
  const source = String(healthSource || metricSource || '').toLowerCase()
  if (!source) return null
  if (source === 'apple_health') return 'Apple Health'
  if (source === 'garmin_csv' || source === 'garmin') return 'Garmin file'
  return source.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export default function RunDetailModal({ run, hrZones = [], hrProfile = null, onClose, onDelete, onFeedbackGenerated }) {
  const { units } = useUnits()
  const [feedback, setFeedback] = useState(run.ai_feedback || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const generateFeedback = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.post(`/runs/${run.id}/feedback`)
      setFeedback(res.data.feedback)
      if (onFeedbackGenerated) onFeedbackGenerated(run.id, res.data.feedback)
    } catch (e) {
      setError(e.response?.data?.error || 'Could not generate feedback.')
    } finally {
      setLoading(false)
    }
  }

  const date = formatActivityDate(run.date || run.created_at)
  const isRun = isRunningActivity(run)
  const kind = activityLabel(run)
  const hr = run.avg_hr || run.avg_heart_rate || null
  const averageZone = findZone(hr, hrZones)
  const workoutMetrics = parseObject(run.workout_metrics_json)
  const sourceLabel = formatSourceLabel(run.health_source, workoutMetrics.metric_source)
  const timeline = zoneTimeline(run.heart_rate_zones, run.duration_seconds)
  const metricCoverage = Number(workoutMetrics.hr_sample_coverage_pct)
  const hrCoverage = Number.isFinite(metricCoverage) ? metricCoverage : timeline.coverage
  const hasTrustedHrCoverage = Number.isFinite(hrCoverage) && hrCoverage >= 70
  const dominantZoneIndex = hasTrustedHrCoverage && timeline.total > 0
    ? timeline.seconds.indexOf(Math.max(...timeline.seconds))
    : -1
  const zone = dominantZoneIndex >= 0
    ? { label: ZONE_LABELS[dominantZoneIndex], ...(hrZones[dominantZoneIndex] || {}), zone: dominantZoneIndex + 1, color: ZONE_COLORS[dominantZoneIndex] }
    : averageZone
  const zoneModelLabel = ZONE_MODEL_LABELS[hrProfile?.zoneModel] || 'saved profile'
  const hasTrustedEffort = !(run.watch_mode === 'import' && run.notes === 'Imported workout')
  const elevationGain = run.elevation_gain === null || run.elevation_gain === undefined || run.elevation_gain === ''
    ? Number.NaN
    : Number(run.elevation_gain)
  const elevationLabel = Number.isFinite(elevationGain)
    ? units === 'metric' ? `${Math.round(elevationGain * 0.3048)} m` : `${Math.round(elevationGain)} ft`
    : '--'

  const stats = [
    { label: 'Distance', value: run.distance_miles ? `${Number(run.distance_miles).toFixed(2)} mi` : '--' },
    { label: 'Duration', value: run.duration_seconds ? fmtDuration(run.duration_seconds) : '--' },
    { label: 'Pace', value: fmtPace(run.duration_seconds, run.distance_miles) },
    { label: sourceLabel === 'Apple Health' ? 'Active calories' : 'Calories', value: run.calories ? `${run.calories} cal` : '--' },
    { label: 'Effort', value: run.perceived_effort && hasTrustedEffort ? `${run.perceived_effort}/10 - ${EFFORT_LABELS[run.perceived_effort] || ''}` : '--' },
    { label: 'Surface', value: run.surface || run.run_type || '--' },
    { label: 'Elevation Gain', value: elevationLabel },
  ]
  const advancedStats = [
    { label: 'Cadence', value: run.cadence_spm ? `${Math.round(Number(run.cadence_spm))} spm` : null },
    { label: 'Running power', value: workoutMetrics.running_power_watts != null ? `${Math.round(Number(workoutMetrics.running_power_watts))} W` : null },
    { label: 'Stride length', value: workoutMetrics.running_stride_length_m != null ? `${Number(workoutMetrics.running_stride_length_m).toFixed(2)} m` : null },
    { label: 'Vertical oscillation', value: workoutMetrics.running_vertical_oscillation_cm != null ? `${Number(workoutMetrics.running_vertical_oscillation_cm).toFixed(1)} cm` : null },
    { label: 'Ground contact', value: workoutMetrics.running_ground_contact_time_ms != null ? `${Math.round(Number(workoutMetrics.running_ground_contact_time_ms))} ms` : null },
    { label: 'Vertical ratio', value: workoutMetrics.running_vertical_ratio_pct != null ? `${Number(workoutMetrics.running_vertical_ratio_pct).toFixed(1)}%` : null },
    { label: 'GCT balance', value: workoutMetrics.ground_contact_balance_left_pct != null && workoutMetrics.ground_contact_balance_right_pct != null ? `${Number(workoutMetrics.ground_contact_balance_left_pct).toFixed(1)}% L / ${Number(workoutMetrics.ground_contact_balance_right_pct).toFixed(1)}% R` : null },
    { label: 'Respiration', value: workoutMetrics.respiratory_rate_avg != null ? `${Number(workoutMetrics.respiratory_rate_avg).toFixed(0)} brpm avg${workoutMetrics.respiratory_rate_max != null ? ` · ${Number(workoutMetrics.respiratory_rate_max).toFixed(0)} max` : ''}` : null },
    { label: 'Run / walk', value: workoutMetrics.run_time_seconds || workoutMetrics.walk_time_seconds ? `${formatSeconds(workoutMetrics.run_time_seconds) || '0m'} / ${formatSeconds(workoutMetrics.walk_time_seconds) || '0m'}` : null },
    { label: 'Performance condition', value: workoutMetrics.performance_condition != null ? `${Number(workoutMetrics.performance_condition) > 0 ? '+' : ''}${Number(workoutMetrics.performance_condition)}` : null },
    { label: 'Temperature', value: run.temperature_f != null ? `${Math.round(Number(run.temperature_f))}°F` : null },
    { label: 'Aerobic / anaerobic TE', value: run.training_effect_aerobic != null || run.training_effect_anaerobic != null ? `${run.training_effect_aerobic ?? '--'} / ${run.training_effect_anaerobic ?? '--'}` : null },
  ].filter((item) => item.value)
  const hasPartialHrCoverage = Number.isFinite(hrCoverage) && hrCoverage > 0 && hrCoverage < 70

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={onClose}>
      <div className="w-full rounded-t-2xl p-6 pb-10 max-h-[85vh] overflow-y-auto" style={{ background: 'var(--bg-card)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{kind} Detail</h2>
            {sourceLabel && <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>Synced from {sourceLabel}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close activity detail"><X size={20} style={{ color: 'var(--text-muted)' }} /></button>
        </div>
        <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>{date}</p>

        <div className="grid grid-cols-2 gap-3 mb-5">
          {stats.map(({ label, value }) => (
            <div key={label} className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
              <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{value}</p>
            </div>
          ))}
        </div>

        {hr && zone && (
          <div className="rounded-xl p-3 mb-5" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{sourceLabel === 'Apple Health' ? 'Apple Health average' : 'Average heart rate'}</p>
            <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{hr} bpm</p><span className="rounded-full px-2 py-1 text-xs" style={{ background: `${zone.color}22`, color: zone.color }}>Z{zone.zone} · {zone.label}</span></div>
            <div className="mt-2 h-1.5 rounded-full" style={{ background: 'var(--bg-base)' }}><div className="h-full rounded-full" style={{ width: `${zone.zone * 20}%`, background: zone.color }} /></div>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>{hasTrustedHrCoverage ? `Dominant zone from ${hrCoverage.toFixed(0)}% of the workout timeline.` : `Classified with your ${zoneModelLabel} profile.`}</p>
            {hasTrustedHrCoverage && (
              <div className="mt-2 grid grid-cols-5 gap-1" aria-label="Heart-rate zone time distribution">
                {timeline.seconds.map((seconds, index) => (
                  <div key={`zone-time-${index + 1}`} className="text-center">
                    <div style={{ height: 4, borderRadius: 999, background: ZONE_COLORS[index], opacity: seconds > 0 ? 1 : 0.25 }} />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Z{index + 1} {Math.round((seconds / timeline.total) * 100)}%</span>
                  </div>
                ))}
              </div>
            )}
            {hasPartialHrCoverage && <p className="mt-2 text-xs" style={{ color: 'var(--warning)' }}>Apple Health supplied only {hrCoverage.toFixed(0)}% of this workout's heart-rate timeline. Partial zone time is not used to judge intensity.</p>}
            <Link to="/hr-zones" onClick={onClose} className="mt-2 inline-flex text-xs font-bold" style={{ color: 'var(--accent)' }}>Review or match watch zones</Link>
          </div>
        )}

        {hr && !zone && (
          <div className="rounded-xl p-3 mb-5" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Average heart rate</p>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{hr} bpm</p>
            <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>No zone is guessed from this workout's maximum. Add your watch boundaries to classify it correctly.</p>
            <Link to="/hr-zones" onClick={onClose} className="mt-2 inline-flex text-xs font-bold" style={{ color: 'var(--accent)' }}>Calibrate HR zones</Link>
          </div>
        )}

        {advancedStats.length > 0 && (
          <div className="mb-5">
            <p className="mb-2 text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.6 }}>Training metrics</p>
            <div className="grid grid-cols-2 gap-3">
              {advancedStats.map(({ label, value }) => (
                <div key={label} className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
                  <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
                  <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {!isRun && (
          <div className="rounded-xl p-3 mb-5" style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)' }}>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--success)' }}>This walk stays in your activity and recovery history, but it does not count toward running mileage, pace trends, PRs, or plan load.</p>
          </div>
        )}

        {run.notes && (
          <div className="rounded-xl p-3 mb-5" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Notes</p>
            <p className="text-sm italic" style={{ color: 'var(--text-primary)' }}>&quot;{run.notes}&quot;</p>
          </div>
        )}

        {isRun && <div className="rounded-xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Brain size={16} style={{ color: 'var(--accent)' }} />
            <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>AI Coach Feedback</span>
          </div>

          {feedback ? (
            <>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{feedback}</p>
              <AiGuidanceNote />
            </>
          ) : (
            <>
              {error && <p className="text-xs mb-2" style={{ color: 'var(--danger)' }}>{error}</p>}
              <button
                onClick={generateFeedback}
                disabled={loading}
                className="w-full py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                {loading ? 'Analyzing your run...' : 'Get AI Feedback'}
              </button>
            </>
          )}
        </div>}

        {onDelete && (
          <button type="button" onClick={onDelete} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border py-3 text-sm font-semibold" style={{ borderColor: 'rgba(239,68,68,0.45)', color: 'var(--danger)', background: 'var(--danger-dim)' }}>
            <Trash2 size={16} /> Delete this {isRun ? 'run' : 'activity'}
          </button>
        )}
      </div>
    </div>
  )
}
