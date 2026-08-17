const PHASE_LABELS = Object.freeze({
  FOUNDATION: 'Foundation',
  DEVELOPMENT: 'Development',
  EVENT_SPECIFIC_DEVELOPMENT: 'Event-specific development',
  SHARPENING: 'Sharpening',
  TAPER_RACE_WEEK: 'Race-week taper',
  POST_RACE_TRANSITION: 'Post-race transition',
  base: 'Base',
  build: 'Build',
  deload: 'Deload',
  peak: 'Peak',
  taper: 'Taper',
  race: 'Race',
  foundation: 'Foundation',
  development: 'Development',
  specific: 'Event-specific training',
  orientation_assessment: 'Orientation and assessment',
  peak_partial_simulation: 'Peak partial simulation',
  sharpen_reduce: 'Sharpen and reduce',
  taper_race: 'Race taper',
  post_hyrox_recovery: 'Post-HYROX recovery',
  running_specific: 'Running-specific training',
  readiness_bridge: 'Readiness bridge',
  consolidate: 'Consolidation',
})

const SESSION_ROLE_LABELS = Object.freeze({
  PRIMARY_KEY: 'Main workout',
  SUPPORTING: 'Supporting session',
  RECOVERY: 'Recovery session',
  REST: 'Rest day',
  ASSESSMENT: 'Fitness assessment',
})

const CAPABILITY_LABELS = Object.freeze({
  FULLY_STRUCTURED: 'Fully supported',
  PARTIALLY_STRUCTURED: 'Partially supported',
  MANUAL_COMPONENTS_REQUIRED: 'Manual setup required',
  NOT_EXPORTABLE: 'Export unavailable',
})

const EXECUTABILITY_LABELS = Object.freeze({
  EXECUTABLE: 'Ready to start and export',
  RESTRICTED: 'Restricted by safety guidance',
  NOT_EXECUTABLE: 'Cannot be started or exported',
})

const SAFETY_ACTION_LABELS = Object.freeze({
  NORMAL: 'No added restriction',
  MONITOR: 'Monitor and continue with care',
  MODIFY_IMPACT: 'Reduce impact',
  NO_RUNNING: 'No running',
  NO_LOWER_BODY: 'No lower-body training',
  NO_HIGH_INTENSITY: 'No high-intensity training',
  MODIFIED_SESSION_ONLY: 'Modified session only',
  FULL_REST: 'Full rest',
  PROFESSIONAL_ASSESSMENT_RECOMMENDED: 'Professional assessment recommended',
})

const SAFETY_SCOPE_LABELS = Object.freeze({
  ALL: 'All training',
  RUN: 'Running',
  IMPACT: 'Impact activity',
  LOWER_BODY: 'Lower-body training',
  HIGH_INTENSITY: 'High-intensity training',
  running_impact: 'Running impact',
})

const REASON_CODE_LABELS = Object.freeze({
  EVIDENCE_UNKNOWN: 'Evidence is unavailable',
  EVIDENCE_MISSING: 'Required evidence is missing',
  FAILED_SYNC: 'Training data could not be synced',
  PARTIAL_SYNC: 'Some training data could not be synced',
  EVIDENCE_CONFLICT_UNRESOLVED: 'Conflicting training evidence needs review',
  MANUAL_CORRECTION_APPLIED: 'A manual correction was applied',
  VALID_ZERO_CONFIRMED: 'A valid zero value was confirmed',
  EVIDENCE_STALE: 'Training evidence is out of date',
  RECENT_LOAD_MAINTAIN: 'Maintain the recent training load',
  TAPER_VOLUME_REDUCTION: 'Reduce volume for the taper',
  RECOVERY_VOLUME_REDUCTION: 'Reduce volume to support recovery',
  TRAINING_GAP_REBUILD: 'Rebuild gradually after a training gap',
  SCHEDULE_CONSTRAINT: 'The schedule limits this placement',
  CROSS_MODAL_FATIGUE_LIMIT: 'Keep combined training fatigue within the accepted limit',
  PHASE_SPECIFIC_OVERLOAD: 'Apply the progression for this training phase',
  RECENT_NORMAL_INSUFFICIENT: 'Not enough recent normal training is available',
  MATERIAL_UNDERTRAINING: 'The proposed week reduces training too far without a qualifying reason',
  HARD_DAY_STACK_TO_PROTECT_RECOVERY: 'Combine hard work to protect a recovery day',
  FOUNDATION_ENTRY: 'Begin the foundation phase',
  DEVELOPMENT_ENTRY: 'Begin the development phase',
  EVENT_SPECIFIC_ENTRY: 'Begin event-specific development',
  SHARPENING_ENTRY: 'Begin the sharpening phase',
  TAPER_ENTRY: 'Begin the race taper',
  POST_RACE_TRANSITION: 'Transition after the race',
  REQUIRED_EXPOSURE_UNPLACEABLE: 'A required training exposure cannot be scheduled safely',
  PREMATURE_TAPER_PREVENTED: 'Keep building before the taper begins',
  LATE_BUILD_PREVENTED: 'Avoid adding build work too close to the event',
  KEY_SESSION_COMPLETED_ON_TARGET: 'The key session was completed on target',
  EXCESSIVE_STRAIN: 'Recent strain is too high',
  MISSED_SESSION_SKIP: 'Skip the missed session',
  MISSED_SESSION_RESCHEDULE: 'Reschedule the missed session',
  NO_WORKOUT_DEBT: 'Do not make up missed workout volume',
  ADAPTATION_REJECTED: 'The proposed adjustment was not accepted',
  IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED: 'A previously rejected identical plan was not proposed again',
  PAIN_MONITOR: 'Monitor pain symptoms',
  MODIFY_IMPACT: 'Reduce impact',
  NO_RUNNING: 'No running',
  NO_LOWER_BODY: 'No lower-body training',
  NO_HIGH_INTENSITY: 'No high-intensity training',
  FULL_REST: 'Full rest',
  ILLNESS_RECOVERY: 'Recover from illness',
  PROFESSIONAL_ASSESSMENT_RECOMMENDED: 'A professional assessment is recommended',
  ILLNESS_STATUS_NEEDS_UPDATE: 'Update the current illness status',
  INJURY_SCOPE: 'Follow the accepted injury restrictions',
  BELOW_PRESENTATION_FLOOR_EXCEPTION: 'This session is below the usual presentation minimum',
  PACE_EVIDENCE_STALE: 'Pace evidence is out of date',
  PACE_EVIDENCE_MISSING: 'Pace evidence is unavailable',
  HR_RPE_FALLBACK: 'Use heart rate and perceived effort',
  ASSESSMENT_REQUIRED: 'A fitness assessment is required',
  STATION_BENCHMARK_MISSING: 'A station benchmark is unavailable',
  TRANSITION_BENCHMARK_MISSING: 'A transition benchmark is unavailable',
  DIVISION_UNKNOWN: 'The event division is unknown',
  RULESET_UNSUPPORTED: 'The event ruleset is not supported',
  TEAM_INDIVIDUAL_BURDEN_UNKNOWN: "The athlete's individual team workload is unknown",
  ENVIRONMENT_EFFORT_OVERRIDE: 'Use effort because of environmental conditions',
  UNKNOWN_INVENTORY: 'Equipment availability is unknown',
  PARTIAL_SHOE_MILEAGE: 'Shoe mileage history is incomplete',
  MATERIAL_CHANGE_REVIEW_REQUIRED: 'Review required because the plan changed materially',
  ATHLETE_LOCK_CONFLICT: 'An athlete-locked session conflicts with this change',
  ATHLETE_EDIT_PRESERVED: "The athlete's edit was preserved",
  STALE_PLAN_REVISION: 'The plan changed before this update could be applied',
  STALE_ATHLETE_STATE: 'Athlete status changed before this update could be applied',
  RACE_REVISION_CHANGED: 'The race details changed before this update could be applied',
  DUPLICATE_APPLY_IDEMPOTENT: 'This plan change was already applied',
  DERIVED_TOTAL_MISMATCH: 'Calculated workout totals do not match',
  SESSION_ROLE_UNJUSTIFIED: 'The session role needs review',
  WORKOUT_FAMILY_UNRESOLVED: 'The workout type could not be resolved',
  EXPORT_CAPABILITY_PARTIAL: 'Some workout details require manual setup',
  EXPORT_MANUAL_COMPONENT_REQUIRED: 'Manual setup is required for export',
  SURFACE_REVISION_MISMATCH: 'Plan details are out of date',
  NO_IMPACT: 'Reduce impact',
  MONITOR_RECOVERY: 'Monitor recovery',
  KEY_STIMULUS_REQUIRED: 'This key training stimulus is required',
  LIMITER_THRESHOLD: 'Develop the current threshold limiter',
  GOAL_EXPOSURES_SUPPORTED: 'The required goal-specific training is supported',
  SESSION_NOT_EXECUTABLE: 'Cannot be started or exported',
  NO_PERFORMANCE_ANCHOR: 'No recent performance anchor is available',
  ANCHOR_EXPIRED: 'The performance anchor is too old to support the target',
  BROAD_EQUIVALENCY_ONLY: 'Current performance evidence gives only a broad pace estimate',
  PACE_EQUIVALENCY_USED: 'Goal pace uses an equivalent recorded performance',
  QUALITY_EXPOSURE_MISSING: 'The block needs another race-specific quality exposure',
  PEAK_DEMAND_UNREACHABLE: 'The available weeks cannot safely reach the required peak load',
  CHECKPOINT_UNPLACEABLE: 'There is not enough calendar space for a safe checkpoint',
  RACE_SPACING_CONFLICT: 'Protected races are close enough to constrain recovery and sharpening',
})

const FEASIBILITY_LABELS = Object.freeze({
  supported: 'On track',
  unvalidated: 'Target needs evidence',
  at_risk: 'At risk',
  not_currently_supported: 'Not currently supported',
  stretch: 'Stretch target',
  unsafe: 'Goal needs adjustment',
  not_applicable: 'Completion goal',
})

const CONFIDENCE_LABELS = Object.freeze({
  HIGH: 'High confidence',
  MEDIUM: 'Medium confidence',
  LOW: 'Low confidence',
  INSUFFICIENT: 'Not enough evidence',
  UNKNOWN: 'Confidence unavailable',
})

const CANONICAL_UNIT_LABELS = Object.freeze({
  m: 'Meters',
  s: 'Seconds',
  bpm: 'Beats per minute',
  kg: 'Kilograms',
  count: 'Count',
  ordinal: 'Ordinal scale',
  's/km': 'Seconds per kilometer',
  s_per_km: 'Seconds per kilometer',
  rpe: 'Perceived exertion',
  spm: 'Steps per minute',
  rir: 'Reps in reserve',
  metric: 'Metric units',
})

const POLICY_LABELS = Object.freeze({
  goal_backward_target_hierarchy_v1: 'Goal-based target selection',
  'target-policy-v1': 'Goal-based target selection',
})

const ACRONYMS = Object.freeze({
  api: 'API',
  bpm: 'BPM',
  fit: 'FIT',
  hr: 'heart rate',
  hyrox: 'HYROX',
  id: 'ID',
  pr: 'PR',
  rir: 'RIR',
  rpe: 'RPE',
})

function lookupLabel(labels, value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (Object.hasOwn(labels, raw)) return labels[raw]
  const upper = raw.toUpperCase()
  if (Object.hasOwn(labels, upper)) return labels[upper]
  const lower = raw.toLowerCase()
  return Object.hasOwn(labels, lower) ? labels[lower] : null
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}

function sentencePunctuation(value) {
  return value && !/[.!?]$/.test(value) ? `${value}.` : value
}

export function humanizeMachineValue(value, { casing = 'sentence', fallback = 'Unavailable' } = {}) {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  if (!words) return fallback
  const humanWords = words.split(' ').map((word) => ACRONYMS[word] || word)
  if (casing === 'title') {
    return humanWords.map((word) => (/^[A-Z0-9]+$/.test(word)
      ? word
      : word.split(' ').map(capitalize).join(' '))).join(' ')
  }
  return capitalize(humanWords.join(' '))
}

export function technicalFactLabel(value, { fallback = 'Unavailable' } = {}) {
  const raw = String(value ?? '').trim()
  return raw && !raw.includes('_') ? raw : fallback
}

export function phaseLabel(value) {
  return lookupLabel(PHASE_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Training phase unavailable' })
}

export function sessionRoleLabel(value) {
  return lookupLabel(SESSION_ROLE_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Session role unavailable' })
}

export function capabilityLabel(value) {
  return lookupLabel(CAPABILITY_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Export support unavailable' })
}

export function executabilityLabel(value) {
  return lookupLabel(EXECUTABILITY_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Workout availability unavailable' })
}

export function safetyActionLabel(value) {
  return lookupLabel(SAFETY_ACTION_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Safety guidance unavailable' })
}

export function safetyScopeLabel(value) {
  return lookupLabel(SAFETY_SCOPE_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Safety scope unavailable' })
}

export function safetyScopeList(values, { separator = ', ', emptyLabel = 'No scoped restriction' } = {}) {
  if (!Array.isArray(values) || values.length === 0) return emptyLabel
  const labels = values.filter((value) => String(value ?? '').trim()).map(safetyScopeLabel)
  return labels.length ? labels.join(separator) : emptyLabel
}

export function reasonCodeLabel(value, { sentence = false } = {}) {
  const label = lookupLabel(REASON_CODE_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Reason unavailable' })
  return sentence ? sentencePunctuation(label) : label
}

export function feasibilityLabel(value) {
  return lookupLabel(FEASIBILITY_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Feasibility unavailable' })
}

export function confidenceLabel(value) {
  return lookupLabel(CONFIDENCE_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Confidence unavailable' })
}

export function canonicalUnitLabel(value) {
  return lookupLabel(CANONICAL_UNIT_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Unit unavailable' })
}

export function policyLabel(value) {
  return lookupLabel(POLICY_LABELS, value)
    || humanizeMachineValue(value, { fallback: 'Policy details unavailable' })
}

export const goalBackwardPresentationMappings = Object.freeze({
  phases: PHASE_LABELS,
  sessionRoles: SESSION_ROLE_LABELS,
  capabilities: CAPABILITY_LABELS,
  executability: EXECUTABILITY_LABELS,
  safetyActions: SAFETY_ACTION_LABELS,
  safetyScopes: SAFETY_SCOPE_LABELS,
  reasonCodes: REASON_CODE_LABELS,
  feasibility: FEASIBILITY_LABELS,
  confidence: CONFIDENCE_LABELS,
  canonicalUnits: CANONICAL_UNIT_LABELS,
  policies: POLICY_LABELS,
})
