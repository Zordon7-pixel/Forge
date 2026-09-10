// A reduction authority, not a source of new training capacity. The route must
// authenticate the predecessor and fresh evidence again before accepting it.
const { canonicalHash } = require('./racePlanPolicy');
const VERSION = 'activity-aware-adaptation-v1';
const WITHHOLDING_VERSION = 'distributed-strength-withholding-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const equal = (a, b) => canonicalHash(a) === canonicalHash(b);
const BODY_KEYS = ['version', 'owner_id', 'assignment_id', 'parent_plan_id', 'parent_plan_revision',
  'parent_canonical_set_hash', 'planning_input_revision', 'activity_fingerprint', 'evidence_ids',
  'safety_state_hash', 'observed_at', 'planning_date', 'timezone', 'window_start', 'window_end',
  'expires_at', 'reason_code', 'affected_session_ids', 'parent_goals_hash', 'parent_horizon', 'missed_outcome_fingerprint',
  'observation_hash', 'recent_run_load_hash'];

function validateContext(context) {
  if (!context || Object.keys(context).sort().join('|') !== BODY_KEYS.slice().sort().join('|')
    || context.version !== VERSION || !String(context.owner_id || '') || !String(context.assignment_id || '')
    || !String(context.parent_plan_id || '') || !Number.isSafeInteger(context.parent_plan_revision)
    || context.parent_plan_revision < 1 || !Number.isSafeInteger(context.planning_input_revision)
    || context.planning_input_revision < 0 || !digest(context.parent_canonical_set_hash)
    || !digest(context.activity_fingerprint) || !digest(context.safety_state_hash)
    || !digest(context.observation_hash) || !digest(context.recent_run_load_hash)
    || !Array.isArray(context.evidence_ids) || !context.evidence_ids.length
    || context.evidence_ids.some(id => typeof id !== 'string' || !id)
    || new Set(context.evidence_ids).size !== context.evidence_ids.length
    || !Array.isArray(context.affected_session_ids) || !context.affected_session_ids.length
    || context.affected_session_ids.some(id => typeof id !== 'string' || !id)
    || new Set(context.affected_session_ids).size !== context.affected_session_ids.length
    || !digest(context.parent_goals_hash) || !digest(context.missed_outcome_fingerprint)
    || !date(context.parent_horizon?.start_date) || !date(context.parent_horizon?.end_date)
    || context.parent_horizon.start_date > context.parent_horizon.end_date
    || !date(context.planning_date) || !date(context.window_start) || !date(context.window_end)
    || context.window_start > context.window_end || context.window_start < context.planning_date
    || !Number.isFinite(Date.parse(context.observed_at)) || !Number.isFinite(Date.parse(context.expires_at))
    || Date.parse(context.expires_at) <= Date.parse(context.observed_at)
    || !['RECENT_RUN_PROTECTION', 'RECOVERY_PROTECTION', 'INJURY_PROTECTION'].includes(context.reason_code)) return false;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: context.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(context.observed_at))
      .map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` !== context.planning_date) return false;
  } catch { return false; }
  return true;
}

function originalMatchesContext(original, context) {
  const canonical = require('./canonicalWorkout');
  return validateContext(context) && canonical.validateCanonicalSession(original).valid
    && original.plan_id === context.parent_plan_id && original.plan_revision === context.parent_plan_revision
    && context.affected_session_ids.includes(original.session_id)
    && original.timezone === context.timezone && original.scheduled_local_date >= context.window_start
    && original.scheduled_local_date <= context.window_end;
}

// A subtotal or pace-derived estimate is not a physical duration. Repetition
// containers are counted exactly; any unresolved active segment fails closed.
function physicalRunDose(original) {
  let duration = 0, distance = 0, unknownDistance = false;
  function visit(steps, multiplier = 1) {
    if (!Array.isArray(steps) || !steps.length) return false;
    return steps.every(step => {
      if (step.type === 'repeat') {
        const repeats = step.repeat_count;
        return Number.isInteger(repeats) && repeats > 0 && visit(step.children, multiplier * repeats);
      }
      if (!['run', 'recovery', 'warmup', 'cooldown'].includes(step.type)
        || !Number.isFinite(step.target?.duration_s) || step.target.duration_s <= 0) return false;
      duration += step.target.duration_s * multiplier;
      if (step.target.distance_m === undefined) unknownDistance = true;
      else if (!Number.isFinite(step.target.distance_m) || step.target.distance_m < 0) return false;
      else distance += step.target.distance_m * multiplier;
      return true;
    });
  }
  if (!visit(original.steps)) return null;
  return { duration_s: duration, distance_m: unknownDistance ? 0 : distance,
    distance_basis: unknownDistance ? 'DURATION_ONLY_NO_DISTANCE_PRESCRIPTION' : 'CANONICAL_DISTANCE_PRESCRIPTION' };
}

function originalEffortEnvelope(original) {
  const leaves = require('./canonicalWorkout').flattenSteps(original.steps).filter(step => step.type !== 'repeat');
  if (!leaves.length || leaves.some(step => !Number.isFinite(step.target?.rpe_range?.minimum)
    || !Number.isFinite(step.target?.rpe_range?.maximum))) return null;
  return { minimum: Math.min(...leaves.map(step => step.target.rpe_range.minimum)),
    maximum: Math.max(...leaves.map(step => step.target.rpe_range.maximum)),
    ...(leaves.some(step => step.target.heart_rate_range_bpm !== undefined)
      ? { heart_rate_range_bpm: {
        minimum: Math.min(...leaves.filter(step => step.target.heart_rate_range_bpm).map(step => step.target.heart_rate_range_bpm.minimum)),
        maximum: Math.min(...leaves.filter(step => step.target.heart_rate_range_bpm).map(step => step.target.heart_rate_range_bpm.maximum)),
      } } : {}) };
}

function effortDoesNotIncrease(original, child) {
  const envelope = originalEffortEnvelope(original);
  return envelope && require('./canonicalWorkout').flattenSteps(child.steps).filter(step => step.type !== 'repeat').every(step =>
    Number.isFinite(step.target?.rpe_range?.minimum) && Number.isFinite(step.target?.rpe_range?.maximum)
    && step.target.rpe_range.minimum <= envelope.minimum && step.target.rpe_range.maximum <= envelope.maximum
    && (envelope.heart_rate_range_bpm === undefined || step.target.heart_rate_range_bpm
      && step.target.heart_rate_range_bpm.minimum <= envelope.heart_rate_range_bpm.minimum
      && step.target.heart_rate_range_bpm.maximum <= envelope.heart_rate_range_bpm.maximum));
}

function buildRecoveryRegistry(original, context) {
  if (!originalMatchesContext(original, context)
    || !['long_aerobic', 'steady_run', 'threshold_run', 'interval_run', 'race_rhythm_run', 'assessment'].includes(original.workout_family)) {
    throw new Error('ACTIVITY_RECOVERY_ORIGINAL_INVALID');
  }
  const dose = physicalRunDose(original);
  const stress = require('./goalBackwardLoad').resolveSessionStress(original);
  if (!dose || !stress.valid) throw new Error('ACTIVITY_RECOVERY_ORIGINAL_DOSE_UNKNOWN');
  const reference = require('./runningDoseAccounting').REFERENCE;
  const body = { version: VERSION, context: clone(context), original: clone(original), original_dose: dose,
    original_vector: stress.vector, coefficient: Math.max(dose.duration_s / reference.duration_s,
      dose.distance_m / reference.distance_m) / dose.duration_s };
  return { ...body, registry_hash: canonicalHash(body) };
}

function validateRecoveryRegistry(registry) {
  try {
    if (!registry || Object.keys(registry).sort().join('|') !== ['version', 'context', 'original', 'original_dose',
      'original_vector', 'coefficient', 'registry_hash'].sort().join('|')) return false;
    return equal(buildRecoveryRegistry(registry.original, registry.context), registry);
  } catch { return false; }
}

function recoverySource(registry) {
  if (!validateRecoveryRegistry(registry)) throw new Error('ACTIVITY_RECOVERY_REGISTRY_INVALID');
  const running = require('./runningDoseAccounting');
  const normalization = { policy_version: running.VERSION, primary_basis: 'SOURCE_BOUND_ACTIVE_DURATION',
    duration_s: registry.original_dose.duration_s, distance_m: registry.original_dose.distance_m,
    prescriptions: [{ prescription_id: registry.original.session_id, dose: registry.original_dose }],
    exposure_per_second: registry.coefficient };
  return { policy_version: running.VERSION, authority: VERSION, allow_effort_only: true,
    activity_recovery_registry: registry, normalization, normalization_hash: canonicalHash(normalization) };
}

function validateRecoverySource(source) {
  try { return equal(recoverySource(source.activity_recovery_registry), source); } catch { return false; }
}

function validateRecoveryChild(child, registry) {
  if (!validateRecoveryRegistry(registry) || !['easy_run', 'recovery_run'].includes(child.workout_family)) return false;
  const original = registry.original;
  const dose = require('./runningDoseAccounting').canonicalRunDose(child, { allowEffortOnly: true });
  if (!dose || child.session_id !== original.session_id || child.plan_id !== original.plan_id
    || !validReductionRevision(child, original) || child.session_revision !== original.session_revision + 1
    || child.scheduled_local_date !== original.scheduled_local_date || child.timezone !== original.timezone
    || !equal(child.goal_ids, original.goal_ids) || !effortDoesNotIncrease(original, child)
    || dose.distance_basis !== registry.original_dose.distance_basis
    || dose.duration_s > registry.original_dose.duration_s || dose.distance_m > registry.original_dose.distance_m
    || dose.distance_m * registry.original_dose.duration_s > registry.original_dose.distance_m * dose.duration_s) return false;
  return [2, 2, 1, 0, 0, 1, 1, 0].every((value, index) => value * registry.coefficient * dose.duration_s <= registry.original_vector[index] + 1e-6);
}

function exerciseCore(step) { return { exercise_id: step.exercise_id, target: clone(step.target) }; }
function withoutSets(value) { const result = clone(value); delete result.target.sets; return result; }

function buildWithholdingLedger(original, retainedSteps, context) {
  const distribution = require('./distributedStrength');
  if (!originalMatchesContext(original, context) || !String(original.workout_family).startsWith('strength_')
    || !distribution.validateDistributedSession(original, null)) throw new Error('ACTIVITY_STRENGTH_ORIGINAL_INVALID');
  const retained = retainedSteps.map(exerciseCore);
  if (new Set(retained.map(step => step.exercise_id)).size !== retained.length) throw new Error('ACTIVITY_STRENGTH_ALLOCATION_DUPLICATE');
  const allocations = original.steps.map(step => {
    const next = retained.find(entry => entry.exercise_id === step.exercise_id);
    if (next && (!equal(withoutSets(exerciseCore(step)), withoutSets(next))
      || !Number.isInteger(next.target.sets) || next.target.sets < 1 || next.target.sets > step.target.sets)) {
      throw new Error('ACTIVITY_STRENGTH_TARGET_INCREASE_OR_SUBSTITUTION');
    }
    return { exercise_id: step.exercise_id, original_sets: step.target.sets,
      retained_sets: next?.target.sets || 0, withheld_sets: step.target.sets - (next?.target.sets || 0) };
  });
  if (retained.some(step => !allocations.some(entry => entry.exercise_id === step.exercise_id))) {
    throw new Error('ACTIVITY_STRENGTH_NEW_EXERCISE');
  }
  const body = { version: WITHHOLDING_VERSION, context: clone(context), original: clone(original),
    allocation_hash: original.strength_distribution.allocation_hash, group_id: original.strength_distribution.group_id,
    allocations, disposition: 'WITHHELD_NOT_COMPLETED_OR_DEFERRED' };
  return { ...body, ledger_hash: canonicalHash(body) };
}

function validateWithholdingChild(child) {
  const ledger = child?.strength_withholding;
  try {
    if (!ledger || Object.keys(ledger).sort().join('|') !== ['version', 'context', 'original', 'allocation_hash',
      'group_id', 'allocations', 'disposition', 'ledger_hash'].sort().join('|')) return false;
    const original = ledger.original;
    const rest = child.workout_family === 'rest';
    if ((!rest && child.workout_family !== original.workout_family) || child.session_id !== original.session_id
      || child.plan_id !== original.plan_id || !validReductionRevision(child, original)
      || child.session_revision !== original.session_revision + 1 || child.timezone !== original.timezone
      || child.scheduled_local_date !== original.scheduled_local_date || !equal(child.goal_ids, original.goal_ids)
      || !equal(child.strength_distribution, original.strength_distribution) || rest && child.steps.length !== 0) return false;
    return equal(buildWithholdingLedger(original, child.steps, ledger.context), ledger);
  } catch { return false; }
}

function validReductionRevision(child, original) {
  const first = original.plan_revision + 1;
  if (child.plan_revision === first) return child.activity_plan_lineage === undefined;
  const lineage = child.activity_plan_lineage;
  return Number.isSafeInteger(child.plan_revision) && child.plan_revision > first && Array.isArray(lineage)
    && lineage.length === child.plan_revision - first && lineage.every((entry, index) =>
      entry && Object.keys(entry).sort().join('|') === 'parent_set_hash|plan_revision'
      && entry.plan_revision === first + index + 1 && digest(entry.parent_set_hash));
}

function buildSessionReduction(original, context, disposition) {
  if (!originalMatchesContext(original, context) || original.workout_family === 'race'
    || !['RECOVERY_CONVERSION', 'STRENGTH_WITHHOLDING', 'REST_WITHHOLDING'].includes(disposition)) {
    throw new Error('ACTIVITY_REDUCTION_ORIGINAL_INVALID');
  }
  const body = { version: VERSION, context: clone(context), original: clone(original), disposition };
  return { ...body, reduction_hash: canonicalHash(body) };
}

function validateSessionReduction(child) {
  const receipt = child?.activity_reduction;
  try {
    if (!receipt || !equal(buildSessionReduction(receipt.original, receipt.context, receipt.disposition), receipt)) return false;
    const original = receipt.original;
    if (child.session_id !== original.session_id || child.plan_id !== original.plan_id
      || !validReductionRevision(child, original) || child.session_revision !== original.session_revision + 1
      || child.scheduled_local_date !== original.scheduled_local_date || child.timezone !== original.timezone
      || child.phase !== original.phase || !equal(child.goal_ids, original.goal_ids)) return false;
    if (child.workout_family === 'rest') return receipt.disposition === 'REST_WITHHOLDING' && child.kind === 'rest'
      && Array.isArray(child.steps) && !child.steps.length
      && (!String(original.workout_family).startsWith('strength_') || validateWithholdingChild(child));
    if (receipt.disposition === 'STRENGTH_WITHHOLDING') return child.kind === 'lift' && validateWithholdingChild(child);
    if (receipt.disposition !== 'RECOVERY_CONVERSION' || child.kind !== 'run') return false;
    const running = require('./runningDoseAccounting');
    if (!running.FAMILIES.has(original.workout_family)) {
      return validateRecoveryChild(child, child.running_dose?.source?.activity_recovery_registry)
        && equal(child.running_dose.source.activity_recovery_registry.original, original)
        && equal(child.running_dose.source.activity_recovery_registry.context, receipt.context);
    }
    if (!running.runningPrescribedDose(original, [2, 2, 1, 0, 0, 1, 1, 0]).valid
      || !equal(child.running_dose, original.running_dose)) return false;
    const before = running.canonicalRunDose(original, { allowEffortOnly: true });
    const after = running.canonicalRunDose(child, { allowEffortOnly: true });
    return before && after && effortDoesNotIncrease(original, child) && after.distance_basis === before.distance_basis
      && after.duration_s <= before.duration_s && after.distance_m <= before.distance_m
      && after.distance_m * before.duration_s <= before.distance_m * after.duration_s;
  } catch { return false; }
}

function retainedRunningDose(child) {
  if (!validateSessionReduction(child)) return null;
  const original = child.activity_reduction.original;
  const running = require('./runningDoseAccounting');
  if (!running.FAMILIES.has(original.workout_family) || !running.FAMILIES.has(child.workout_family)) return null;
  const before = running.runningPrescribedDose(original, [2, 2, 1, 0, 0, 1, 1, 0]);
  const oldDose = running.canonicalRunDose(original, { allowEffortOnly: true });
  const newDose = running.canonicalRunDose(child, { allowEffortOnly: true });
  return { valid: true, vector: before.vector.map(value => value * newDose.duration_s / oldDose.duration_s),
    state: 'ACTIVITY_RETAINED_ORIGINAL_SOURCE_DOSE', version: running.VERSION, actual_dose: newDose };
}

function dispositionModality(session) {
  if (session?.workout_family === 'rest' && validateSessionReduction(session)) {
    return String(session.activity_reduction.original.workout_family).startsWith('strength_') ? 'lift' : 'run';
  }
  return String(session?.workout_family).startsWith('strength_') ? 'lift' : 'run';
}

module.exports = { VERSION, WITHHOLDING_VERSION, validateContext, originalMatchesContext,
  physicalRunDose, buildRecoveryRegistry, validateRecoveryRegistry, recoverySource, validateRecoverySource,
  validateRecoveryChild, buildWithholdingLedger, validateWithholdingChild,
  buildSessionReduction, validateSessionReduction, retainedRunningDose, dispositionModality, originalEffortEnvelope };
