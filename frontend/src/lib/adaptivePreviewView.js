import { validateSurfaceManifest } from './dailyExecutionCore.js'

const hash = value => String(value || '').replace(/^sha256:/, '')
const labels = {
  PRIMARY_KEY: 'Primary session', SECONDARY_KEY: 'Secondary session', SUPPORTING: 'Supporting session',
  OPTIONAL: 'Optional session', REST: 'Recovery day',
  FOUNDATION_ENTRY: 'Build a consistent foundation before adding harder training.',
  WEEKLY_OBJECTIVE_REQUIRED: 'This session supports the current weekly training objective.',
  STATE_LED_PHASE: 'Training reflects the available evidence about your current capacity.',
  REST_DAY_REQUIRED: 'Recovery leaves room to absorb the training work.',
  warmup: 'Warm-up', cooldown: 'Cool-down', run: 'Run', strength: 'Strength',
  mobility: 'Mobility', strength_exercise: 'Strength exercise', interval: 'Interval',
  rest: 'Rest', repeat: 'Repeat', recovery: 'Recovery',
}
export const previewLabel = (code, fallback = 'Training reflects current capacity and recovery constraints.') => labels[code] || fallback

// Reuse the existing identity/session validator strictly for a read-only projection.
// The temporary validation envelope is never returned or given to execution consumers.
export function adaptivePreviewSessions(preview, now = Date.now()) {
  const manifest = preview?.surface_manifest
  const plan = preview?.plan || { plan_data: preview?.candidate?.plan_data }
  const binding = preview?.apply_bindings
  const identity = manifest?.identity
  const expires = Date.parse(preview?.candidate?.expires_at)
  if (manifest?.status !== 'preview' || manifest.feature_mode !== 'preview'
    || manifest.authoritative_engine !== 'adaptive-joint-solver-v1'
    || manifest.surface_capability !== 'PREVIEW_ONLY' || manifest.apply_disabled !== true
    || !['supported', 'stretch', 'unvalidated', 'at_risk'].includes(plan?.plan_data?.overall_feasibility)
    || !binding || binding.candidate_id !== preview.candidate_id
    || hash(binding.candidate_hash) !== hash(preview.candidate_hash)
    || binding.decision_id !== identity?.decision_id
    || hash(binding.decision_hash) !== hash(identity?.decision_hash)
    || binding.candidate_revision !== identity?.candidate_revision
    || binding.athlete_state_revision !== identity?.athlete_state_revision
    || hash(binding.safety_state_hash) !== hash(identity?.safety_state_hash)
    || binding.surface_revision !== manifest.surface_revision
    || !Number.isFinite(expires) || expires <= now
    || !hash(preview?.candidate_hash) || hash(preview.candidate_hash) !== hash(manifest.identity?.candidate_hash)
    || validateSurfaceManifest({ plan, manifest: { ...manifest, status: 'accepted' } }).status !== 'accepted') return []
  const dates = [...new Set(manifest.sessions.map(session => session.scheduled_local_date))].sort()
  if (dates.length !== 7 || dates.some((date, index) => !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Date.parse(date) !== Date.parse(dates[0]) + index * 86400000)) return []
  return [...manifest.sessions].sort((a, b) => a.scheduled_local_date.localeCompare(b.scheduled_local_date))
}

const targetLabels = { sets: 'Sets', repetitions: 'Repetitions', load_kg: 'Load (kg)',
  rpe_range: 'Effort (RPE)', pace_range_s_per_km: 'Pace (seconds/km)', heart_rate_range_bpm: 'Heart rate (bpm)' }
function canonicalTargetValue(target = {}) {
  return Object.entries(target || {}).flatMap(([key, value]) => {
    if (['duration_s', 'rest_s'].includes(key) && Number.isFinite(value))
      return [`${key === 'rest_s' ? 'Rest: ' : ''}${Math.floor(value / 60)} min${value % 60 ? ` ${value % 60} sec` : ''}`]
    if (key === 'distance_m' && Number.isFinite(value)) return [`${value} m`]
    if (!targetLabels[key]) return []
    if (Number.isFinite(value)) return [`${targetLabels[key]}: ${value}`]
    if (Number.isFinite(value?.minimum) && Number.isFinite(value?.maximum))
      return [`${targetLabels[key]}: ${value.minimum}–${value.maximum}`]
    return []
  }).join(' · ')
}

export function previewSteps(steps = [], depth = 0) {
  if (depth > 8) return []
  return steps.flatMap(step => [
    `${previewLabel(step.type, 'Training step')}${step.repeat_count ? ` × ${step.repeat_count}` : ''}${canonicalTargetValue(step.target) ? ` · ${canonicalTargetValue(step.target)}` : ''}`,
    ...previewSteps(step.children || [], depth + 1),
  ])
}
