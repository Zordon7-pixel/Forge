import { useEffect, useState } from 'react'
import { ArrowLeft, X, Brain, Gauge, MapPin, Share2, Trash2 } from 'lucide-react'
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet'
import api from '../lib/api'
import { useUnits } from '../context/UnitsContext'
import AiGuidanceNote from './AiGuidanceNote'
import { Link } from 'react-router-dom'
import { activityLabel, isRunningActivity } from '../lib/activityType'
import { buildRunComparison, formatPlannedPaceTarget, normalizeRunSplits, parseRunRoute, parseZoneTimeline, resolveRunHeartRateZone } from '../lib/runRecap'
import { providerSourcePresentation } from '../lib/deviceSourcePresentation'
import ActivityShareStudio from './ActivityShareStudio'
import { ZONE_HEAT_PALETTE } from '../lib/athleteLanguage'

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

const EFFORT_LABELS = ['', 'Very Easy', 'Easy', 'Easy-Moderate', 'Moderate', 'Moderate-Hard', 'Hard', 'Hard', 'Very Hard', 'Very Hard', 'Max']
const ZONE_COLORS = ZONE_HEAT_PALETTE.map(({ color }) => color)
const ZONE_TEXT_COLORS = ZONE_HEAT_PALETTE.map(({ textColor }) => textColor)
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

function formatSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return fmtDuration(Math.round(seconds))
}

function formatPaceSeconds(value, fmt) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return '--'
  return fmt.pace(seconds)
}

function comparisonNote(actual, planned, { unit = '', precision = 1, tolerance = 0 } = {}) {
  if (!Number.isFinite(Number(actual)) || !Number.isFinite(Number(planned))) return null
  const delta = Number(actual) - Number(planned)
  const allowed = Math.max(tolerance, Math.abs(Number(planned)) * 0.05)
  if (Math.abs(delta) <= allowed) return 'On target'
  return `${Math.abs(delta).toFixed(precision)}${unit ? ` ${unit}` : ''} ${delta > 0 ? 'over' : 'under'}`
}

function FitRouteBounds({ positions }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length >= 2) map.fitBounds(positions, { padding: [24, 24] })
  }, [map, positions])
  return null
}

export default function RunDetailModal({ run, hrZones = [], hrProfile = null, onClose, onDelete, onAddCheckIn, onFeedbackGenerated, standalone = false }) {
  const { units, fmt } = useUnits()
  const [feedback, setFeedback] = useState(run.ai_feedback || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [shareOpen, setShareOpen] = useState(false)

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
  const workoutMetrics = parseObject(run.workout_metrics_json)
  const rawSource = run.health_source || workoutMetrics.metric_source
  const sourcePresentation = providerSourcePresentation({
    source: rawSource,
    upstreamProvider: workoutMetrics.upstream_provider,
  })
  const sourceLabel = rawSource ? sourcePresentation.label : null
  const isAppleHealthSource = sourcePresentation.kind === 'apple_health'
    || sourcePresentation.kind === 'garmin_via_apple_health'
  const enrichedByStrava = workoutMetrics.route_enriched_from_strava === 1
    || workoutMetrics.elevation_enriched_from_strava === 1
  const displayedSourceLabel = isAppleHealthSource && enrichedByStrava
    ? 'Apple Health + Strava'
    : sourceLabel
  const calorieLabel = sourceLabel === 'Apple Health'
    ? 'Active calories'
    : sourceLabel === 'Garmin file'
      ? 'Garmin calories'
      : 'Calories'
  const timeline = parseZoneTimeline(run.heart_rate_zones, run.duration_seconds)
  const zoneEvidence = resolveRunHeartRateZone(run, hrZones)
  const hrCoverage = zoneEvidence?.coveragePct ?? timeline.coveragePct
  const hasTrustedHrCoverage = zoneEvidence?.source === 'timeline'
  const dominantZonePct = zoneEvidence?.dominantPct
  const zone = zoneEvidence
    ? { ...(hrZones[zoneEvidence.zone - 1] || {}), ...zoneEvidence }
    : null
  const zoneModelLabel = ZONE_MODEL_LABELS[hrProfile?.zoneModel] || 'saved profile'
  const backendEffortSource = String(run.effort_source || '')
  const importedLegacyEffort = run.watch_mode === 'import' && run.notes === 'Imported workout'
  const hasTrustedEffort = backendEffortSource
    ? backendEffortSource === 'user_rated'
    : run.perceived_effort != null && (
      !importedLegacyEffort
      || workoutMetrics.workout_effort_user_rated === 1
      || Boolean(run.pain_level)
      || Boolean(run.post_energy)
    )
  const calculatedEffort = Number(run.calculated_effort)
  const hasCalculatedEffort = !hasTrustedEffort && Number.isFinite(calculatedEffort) && calculatedEffort >= 1 && calculatedEffort <= 10
  const calculatedEffortCoverage = Number(run.calculated_effort_coverage_pct)
  const effortLabel = hasTrustedEffort
    ? `${run.perceived_effort}/10 - ${EFFORT_LABELS[Math.round(Number(run.perceived_effort))] || 'Rated'}`
    : hasCalculatedEffort
      ? `${calculatedEffort}/10 - Calculated`
      : isAppleHealthSource ? 'Not enough HR data' : '--'
  const elevationGain = run.elevation_gain === null || run.elevation_gain === undefined || run.elevation_gain === ''
    ? Number.NaN
    : Number(run.elevation_gain)
  const elevationLabel = Number.isFinite(elevationGain)
    ? units === 'metric' ? `${Math.round(elevationGain * 0.3048)} m` : `${Math.round(elevationGain)} ft`
    : isAppleHealthSource ? 'Not shared' : '--'

  const stats = [
    { label: 'Distance', value: run.distance_miles ? fmt.distance(Number(run.distance_miles), 2) : '--' },
    { label: 'Duration', value: run.duration_seconds ? fmtDuration(run.duration_seconds) : '--' },
    { label: 'Pace', value: run.distance_miles && run.duration_seconds ? fmt.pace(run.duration_seconds / run.distance_miles) : '--' },
    { label: calorieLabel, value: run.calories ? `${run.calories} cal` : '--' },
    { label: 'Effort', value: effortLabel },
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
  const comparison = buildRunComparison(run)
  const inferredPlanMatch = comparison.planned?.matchSource === 'scheduled_date' || run.planned_match_source === 'scheduled_date'
  const splits = normalizeRunSplits(run.pace_splits)
  const routePositions = parseRunRoute(run.route_coords)
  const checkInAvailable = hasTrustedEffort || run.pain_level || run.post_energy
  const checkInComplete = hasTrustedEffort && Boolean(run.pain_level)
  const missingAppleRoute = isRun && isAppleHealthSource && routePositions.length < 2
  const missingAppleElevation = isRun && isAppleHealthSource && !Number.isFinite(elevationGain)
  const comparisonRows = comparison.hasPlan ? [
    comparison.plannedDistanceMiles != null ? {
      label: 'Distance',
      planned: fmt.distance(comparison.plannedDistanceMiles, 2),
      actual: comparison.actualDistanceMiles > 0 ? fmt.distance(comparison.actualDistanceMiles, 2) : '--',
      note: comparison.actualDistanceMiles > 0
        ? comparisonNote(fmt.distanceValue(comparison.actualDistanceMiles), fmt.distanceValue(comparison.plannedDistanceMiles), { unit: fmt.distanceLabel, precision: 2, tolerance: units === 'metric' ? 0.16 : 0.1 })
        : null,
    } : null,
    comparison.plannedDurationSeconds != null ? {
      label: 'Time',
      planned: fmtDuration(comparison.plannedDurationSeconds),
      actual: comparison.actualDurationSeconds > 0 ? fmtDuration(comparison.actualDurationSeconds) : '--',
      note: comparison.actualDurationSeconds > 0
        ? comparisonNote(comparison.actualDurationSeconds / 60, comparison.plannedDurationSeconds / 60, { unit: 'min', precision: 0, tolerance: 1 })
        : null,
    } : null,
    comparison.plannedPaceTarget ? {
      label: 'Pace',
      planned: formatPlannedPaceTarget(comparison.plannedPaceTarget, units),
      actual: formatPaceSeconds(comparison.actualPaceSeconds, fmt),
      note: null,
    } : null,
    comparison.plannedZoneTarget ? {
      label: 'Heart rate',
      planned: comparison.plannedZoneTarget,
      actual: comparison.zoneAdherencePct != null
        ? `${comparison.zoneAdherencePct.toFixed(0)}% in target`
        : comparison.timeline.trusted && comparison.timeline.dominantZone
          ? `Dominant Z${comparison.timeline.dominantZone}`
          : 'Not enough HR coverage',
      note: comparison.zoneAdherencePct != null ? `${comparison.zoneAdherencePct.toFixed(0)}% adherence` : null,
    } : null,
  ].filter(Boolean) : []

  return (
    <div
      className={standalone ? 'min-h-full' : 'fixed inset-0 z-50 flex items-end'}
      style={{ background: standalone ? 'transparent' : 'rgba(0,0,0,0.7)' }}
      onClick={standalone ? undefined : onClose}
    >
      <div
        className={standalone
          ? 'mx-auto w-full max-w-2xl pb-8'
          : 'mx-auto max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl p-6 pb-10'}
        style={{ background: standalone ? 'transparent' : 'var(--bg-card)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center mb-1">
          {standalone && (
            <button type="button" onClick={onClose} aria-label="Back from run recap" className="mr-3 rounded-lg p-2" style={{ color: 'var(--text-muted)', background: 'var(--bg-input)' }}>
              <ArrowLeft size={20} />
            </button>
          )}
          <div className="flex-1">
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{isRun ? 'Run Recap' : `${kind} Detail`}</h2>
            {displayedSourceLabel && <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>Source: {displayedSourceLabel}</p>}
          </div>
          {!standalone && <button type="button" onClick={onClose} aria-label="Close activity detail" className="ml-auto"><X size={20} style={{ color: 'var(--text-muted)' }} /></button>}
        </div>
        <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>{date}</p>

        {isRun && routePositions.length >= 2 && (
          <div className="mb-5 overflow-hidden rounded-xl" style={{ height: 220, border: '1px solid var(--border-subtle)' }}>
            <MapContainer key={run.id} center={routePositions[0]} zoom={14} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
              <FitRouteBounds positions={routePositions} />
              <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Polyline positions={routePositions} pathOptions={{ color: '#EAB308', weight: 5 }} />
              <CircleMarker center={routePositions[0]} radius={7} pathOptions={{ color: '#FFFFFF', fillColor: '#22C55E', fillOpacity: 1, weight: 2 }} />
              <CircleMarker center={routePositions.at(-1)} radius={7} pathOptions={{ color: '#FFFFFF', fillColor: '#EF4444', fillOpacity: 1, weight: 2 }} />
            </MapContainer>
          </div>
        )}

        {(missingAppleRoute || missingAppleElevation) && (
          <div className="mb-5 rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-start gap-2">
              <MapPin size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Recording details not shared</p>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  The app or watch that saved this workout to Apple Health did not include {missingAppleRoute && missingAppleElevation ? 'a GPS route or elevation gain' : missingAppleRoute ? 'a GPS route' : 'elevation gain'}. Past activity details cannot be recreated after the recording source omits them.
                </p>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>Runs started in Forged Hybrid record iPhone GPS and altitude when location access is granted. A matching Strava activity can also fill supported route and elevation fields without duplicating the run.</p>
                <Link to="/settings" className="mt-2 inline-flex text-xs font-bold" style={{ color: 'var(--accent)' }}>Open connected sources</Link>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mb-5">
          {stats.map(({ label, value }) => (
            <div key={label} className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
              <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{value}</p>
            </div>
          ))}
        </div>

        {isRun && (
          <button type="button" onClick={() => setShareOpen(true)} className="pressable mb-5 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            <Share2 size={18} /> Share run recap
          </button>
        )}

        {isRun && hasCalculatedEffort && (
          <div className="mb-5 rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-start gap-2">
              <Gauge size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Calculated training effort</p>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Based on workout duration and time in heart-rate zones{Number.isFinite(calculatedEffortCoverage) ? ` with ${calculatedEffortCoverage.toFixed(0)}% timeline coverage` : ''}. This is an objective load estimate, not your personal RPE.
                </p>
              </div>
            </div>
          </div>
        )}

        {isRun && (
          <div className="rounded-xl p-4 mb-5" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.6 }}>Workout match</p>
            {comparison.hasPlan ? (
              <>
                <p className="mt-1 text-base font-bold" style={{ color: 'var(--text-primary)' }}>{comparison.planned.title || comparison.planned.workoutType || comparison.planned.type || 'Saved workout prescription'}</p>
                {inferredPlanMatch && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Matched to the single run scheduled on this date.</p>}
                {comparison.adherenceScore != null && (
                  <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-bold" style={{ color: comparison.adherenceScore >= 85 ? 'var(--success)' : comparison.adherenceScore >= 65 ? 'var(--warning)' : 'var(--text-primary)' }}>{comparison.adherenceLabel}</p>
                      <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>{comparison.adherenceScore}%</p>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{comparison.adherenceCue}</p>
                  </div>
                )}
                {comparisonRows.length > 0 ? (
                  <div className="mt-3 overflow-hidden rounded-lg" style={{ border: '1px solid var(--border-subtle)' }}>
                    <div className="grid grid-cols-[minmax(80px,0.8fr)_1fr_1fr] gap-2 px-3 py-2 text-[11px] font-bold uppercase" style={{ color: 'var(--text-muted)', background: 'var(--bg-base)' }}>
                      <span>Metric</span><span>Target</span><span>Recorded</span>
                    </div>
                    {comparisonRows.map((row) => (
                      <div key={row.label} className="grid grid-cols-[minmax(80px,0.8fr)_1fr_1fr] gap-2 px-3 py-2 text-xs" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{row.label}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{row.planned}</span>
                        <span style={{ color: 'var(--text-primary)' }}>{row.actual}{row.note ? <small className="block mt-0.5" style={{ color: row.note === 'On target' ? 'var(--success)' : 'var(--text-muted)' }}>{row.note}</small> : null}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>This saved prescription has no distance, time, pace, or zone target to compare.</p>
                )}
                {comparison.planned.steps?.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Prescription</p>
                    <ol className="mt-1 list-decimal space-y-1 pl-5 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {comparison.planned.steps.map((step, index) => <li key={`${step}-${index}`}>{step}</li>)}
                    </ol>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>No plan target was saved for this activity. This recap shows recorded data only and does not invent a prescription.</p>
            )}
          </div>
        )}

        {hr && zone && (
          <div className="rounded-xl p-3 mb-5" style={{ background: 'var(--bg-input)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Heart-rate evidence</p>
            <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{hasTrustedHrCoverage ? `Dominant Z${zone.zone}` : `${hr} bpm average`}</p><span className="rounded-full px-2 py-1 text-xs" style={{ background: `${zone.color}22`, color: zone.textColor || ZONE_TEXT_COLORS[zone.zone - 1] }}>{zone.label}</span></div>
            {hasTrustedHrCoverage && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{Number.isFinite(dominantZonePct) ? `${dominantZonePct.toFixed(0)}% of recorded HR time` : 'Dominant recorded zone'} · {hr} bpm average</p>}
            <div className="mt-2 h-1.5 rounded-full" style={{ background: 'var(--bg-base)' }}><div className="h-full rounded-full" style={{ width: `${zone.zone * 20}%`, background: zone.color }} /></div>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>{hasTrustedHrCoverage ? `Heart-rate samples cover ${hrCoverage.toFixed(0)}% of this workout.` : `Average classified with your ${zoneModelLabel} profile.`}</p>
            {hasTrustedHrCoverage && (
              <div className="mt-3 space-y-2" aria-label="Heart-rate zone time distribution">
                {timeline.seconds.map((seconds, index) => (
                  <div key={`zone-time-${index + 1}`} className="grid grid-cols-[70px_1fr_72px] items-center gap-2 text-xs">
                    <span className="font-semibold" style={{ color: ZONE_TEXT_COLORS[index] }}>Z{index + 1} {ZONE_LABELS[index]}</span>
                    <div style={{ height: 6, borderRadius: 999, background: 'var(--bg-base)' }}><div style={{ width: `${Math.round((seconds / timeline.totalSeconds) * 100)}%`, height: '100%', borderRadius: 999, background: ZONE_COLORS[index], opacity: seconds > 0 ? 1 : 0.25 }} /></div>
                    <span className="text-right" style={{ color: 'var(--text-muted)' }}>{formatSeconds(seconds) || '0m'} · {Math.round((seconds / timeline.totalSeconds) * 100)}%</span>
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

        {isRun && splits.length > 0 && (
          <div className="mb-5 rounded-xl p-4" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.6 }}>Splits</p>
            <div className="mt-2 overflow-hidden rounded-lg" style={{ border: '1px solid var(--border-subtle)' }}>
              {splits.slice(0, 8).map((split) => (
                <div key={`${split.label}-${split.index}`} className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 text-xs" style={{ borderTop: split.index === 1 ? 'none' : '1px solid var(--border-subtle)' }}>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{split.label}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{split.distanceMiles ? fmt.distance(split.distanceMiles, 2) : split.durationSeconds ? fmtDuration(split.durationSeconds) : ''}</span>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{split.paceSeconds ? formatPaceSeconds(split.paceSeconds, fmt) : '--'}</span>
                </div>
              ))}
            </div>
            {splits.length > 8 && (
              <details className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                <summary className="cursor-pointer font-semibold" style={{ color: 'var(--accent)' }}>Show {splits.length - 8} more splits</summary>
                <div className="mt-2 overflow-hidden rounded-lg" style={{ border: '1px solid var(--border-subtle)' }}>
                  {splits.slice(8).map((split) => (
                    <div key={`${split.label}-${split.index}`} className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2" style={{ borderTop: split.index === 9 ? 'none' : '1px solid var(--border-subtle)' }}>
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{split.label}</span>
                      <span>{split.distanceMiles ? fmt.distance(split.distanceMiles, 2) : split.durationSeconds ? fmtDuration(split.durationSeconds) : ''}</span>
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{split.paceSeconds ? formatPaceSeconds(split.paceSeconds, fmt) : '--'}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {isRun && checkInAvailable && (
          <div className="mb-5 rounded-xl p-4" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.6 }}>Post-run check-in</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div><p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Effort</p><p className="mt-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{hasTrustedEffort ? `${run.perceived_effort}/10` : '--'}</p></div>
              <div><p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Pain</p><p className="mt-1 text-sm font-semibold capitalize" style={{ color: run.pain_level === 'moderate' || run.pain_level === 'severe' ? 'var(--danger)' : 'var(--text-primary)' }}>{run.pain_level || '--'}</p></div>
              <div><p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Energy</p><p className="mt-1 text-sm font-semibold capitalize" style={{ color: run.post_energy === 'low' ? 'var(--warning)' : 'var(--text-primary)' }}>{run.post_energy || '--'}</p></div>
            </div>
            {!checkInComplete && onAddCheckIn && (
              <button type="button" onClick={onAddCheckIn} className="mt-3 w-full rounded-lg py-2.5 text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Complete check-in</button>
            )}
          </div>
        )}

        {isRun && !checkInAvailable && onAddCheckIn && (
          <div className="mb-5 rounded-xl p-4" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-xs font-bold uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0.6 }}>How did it feel?</p>
            <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{hasCalculatedEffort ? 'Forged Hybrid calculated training effort from reliable heart-rate data, but only you can rate how it felt.' : 'Apple Health did not include enough reliable data for a rated or calculated effort.'} Add your effort and pain so future training can adapt to what the run actually cost you. Post-run energy is optional.</p>
            <button type="button" onClick={onAddCheckIn} className="mt-3 w-full rounded-lg py-2.5 text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Rate this run</button>
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
            <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Coach evaluation</span>
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
      {shareOpen && <ActivityShareStudio run={run} onClose={() => setShareOpen(false)} />}
    </div>
  )
}
