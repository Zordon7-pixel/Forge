const {
  CANONICAL_EXPORT_CAPABILITIES,
  CANONICAL_SESSION_ROLES,
  CANONICAL_STEP_TYPES,
  CANONICAL_TARGET_FIELDS,
  CANONICAL_WORKOUT_FAMILIES,
  CANONICAL_WORKOUT_SCHEMA_VERSION,
  CANONICAL_WORKOUT_UNITS,
  CONFIDENCE_CLASSES,
  PLANNING_PHASES,
  STRESS_TAXONOMY_VERSION,
  normalizeReasonCode,
} = require('./goalBackwardContracts');
const { resolveStressVector } = require('./goalBackwardLoad');
const { buildCanonicalMaterialTarget } = require('./goalBackwardTargets');
const { canonicalStringify, canonicalHash } = require('./racePlanPolicy');
const {
  REGISTRY: HYROX_REGISTRY,
  STATION_ORDER: HYROX_STATION_ORDER,
  normalizeHyroxCategory,
  normalizeHyroxFormat,
  resolveHyroxStandard,
} = require('./hyroxStandards');
const planSchema = require('./planSchema');

const SESSION_ROLE_SET = new Set(CANONICAL_SESSION_ROLES);
const WORKOUT_FAMILY_SET = new Set(CANONICAL_WORKOUT_FAMILIES);
const STEP_TYPE_SET = new Set(CANONICAL_STEP_TYPES);
const WORKOUT_UNIT_SET = new Set(CANONICAL_WORKOUT_UNITS);
const CAPABILITY_SET = new Set(CANONICAL_EXPORT_CAPABILITIES);
const CONFIDENCE_SET = new Set(CONFIDENCE_CLASSES);
const PHASE_SET = new Set(PLANNING_PHASES);

const STEP_FIELDS = new Set([
  'step_id', 'type', 'order', 'target', 'provenance', 'children', 'repeat_count',
  'workout_family', 'step_role', 'capability', 'station_id', 'exercise_id',
]);
const TARGET_FIELD_UNITS = Object.freeze({
  distance_m: 'm',
  duration_s: 's',
  pace_range_s_per_km: 's/km',
  reference_pace_range_s_per_km: 's/km',
  heart_rate_range_bpm: 'bpm',
  rpe_range: 'rpe',
  cadence_range_spm: 'spm',
  load_kg: 'kg',
  repetitions: 'count',
  sets: 'count',
  rest_s: 's',
  rir: 'rir',
  stop_ceiling: 'ordinal',
});
const TARGET_FIELDS = new Set(CANONICAL_TARGET_FIELDS);
const RANGE_FIELDS = Object.freeze({
  pace_range_s_per_km: { integer: true, minimum: 1 },
  reference_pace_range_s_per_km: { integer: true, minimum: 1 },
  heart_rate_range_bpm: { integer: true, minimum: 1 },
  rpe_range: { integer: false, minimum: 1, maximum: 10 },
  cadence_range_spm: { integer: true, minimum: 1 },
});
const INTEGER_TARGET_FIELDS = new Set(['distance_m', 'duration_s', 'repetitions', 'sets', 'rest_s', 'rir']);
const STOP_CEILING_FIELDS = new Set([
  'heart_rate_bpm', 'rpe', 'duration_s', 'pace_s_per_km',
  'maximum_heart_rate_bpm', 'maximum_rpe', 'maximum_duration_s', 'maximum_pace_s_per_km',
]);
const STEP_TARGET_ALLOWED_FIELDS = Object.freeze({
  warmup: new Set(['distance_m', 'duration_s', 'pace_range_s_per_km', 'reference_pace_range_s_per_km', 'heart_rate_range_bpm', 'rpe_range', 'cadence_range_spm', 'stop_ceiling']),
  run: new Set(['distance_m', 'duration_s', 'pace_range_s_per_km', 'reference_pace_range_s_per_km', 'heart_rate_range_bpm', 'rpe_range', 'cadence_range_spm', 'rest_s', 'stop_ceiling']),
  interval: new Set(['distance_m', 'duration_s', 'pace_range_s_per_km', 'reference_pace_range_s_per_km', 'heart_rate_range_bpm', 'rpe_range', 'cadence_range_spm', 'rest_s', 'stop_ceiling']),
  repeat: new Set(),
  recovery: new Set(['distance_m', 'duration_s', 'pace_range_s_per_km', 'reference_pace_range_s_per_km', 'heart_rate_range_bpm', 'rpe_range', 'cadence_range_spm', 'rest_s', 'stop_ceiling']),
  station: new Set(['distance_m', 'duration_s', 'heart_rate_range_bpm', 'rpe_range', 'load_kg', 'repetitions', 'sets', 'rest_s', 'stop_ceiling']),
  strength_exercise: new Set(['duration_s', 'heart_rate_range_bpm', 'rpe_range', 'load_kg', 'repetitions', 'sets', 'rest_s', 'rir', 'stop_ceiling']),
  transition: new Set(['distance_m', 'duration_s', 'heart_rate_range_bpm', 'rpe_range', 'stop_ceiling']),
  cooldown: new Set(['distance_m', 'duration_s', 'pace_range_s_per_km', 'reference_pace_range_s_per_km', 'heart_rate_range_bpm', 'rpe_range', 'cadence_range_spm', 'stop_ceiling']),
  mobility: new Set(['duration_s', 'rpe_range', 'repetitions', 'sets', 'rest_s', 'stop_ceiling']),
  manual_instruction: new Set(['duration_s', 'rpe_range', 'load_kg', 'repetitions', 'sets', 'rest_s', 'stop_ceiling']),
});
const NON_CONTRIBUTING_TYPES = new Set(['warmup', 'recovery', 'cooldown', 'mobility', 'manual_instruction']);
const STRUCTURED_STEP_TYPES = new Set(['warmup', 'run', 'interval', 'repeat', 'recovery', 'transition', 'cooldown']);
const MANUAL_STEP_TYPES = new Set(['station', 'strength_exercise', 'mobility', 'manual_instruction']);
const RUN_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
  'interval_run', 'race_rhythm_run',
]);
const STRENGTH_FAMILIES = new Set(['strength_lower', 'strength_upper', 'strength_full_body']);
const HYROX_STATION_FAMILIES = new Set(['hyrox_station_skill', 'hyrox_station_strength']);
const HYROX_MIXED_FAMILIES = new Set([
  'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
]);
const HASH_OMITTED_FIELDS = new Set([
  'content_hash', 'title', 'display_name', 'displayName', 'description', 'explanation',
  'athlete_explanation', 'copy', 'why', 'why_today', 'whyToday',
]);
const TOP_LEVEL_ADAPTER_FIELDS = new Set([
  'id', 'kind', 'type', 'workout_type', 'distance_miles', 'duration_min', 'pace_target',
  'target_zone', 'intensity', 'description', 'prescriptionIntegrityAdjusted',
  'workout_id', 'prescription_basis', 'durationIsEstimated', 'duration_is_estimate',
  'distance_is_estimate', 'warmup', 'main', 'exercises', 'recovery', 'cooldown',
  'progression', 'structure', 'focus', 'purpose', 'evidence_refs',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function positiveRevision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTimestamp(value) {
  const raw = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
    && Number.isFinite(Date.parse(raw));
}

function validTimeZone(value) {
  if (!nonEmptyString(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch (_error) {
    return false;
  }
}

function targetUnits(target = {}) {
  const units = Object.keys(target).filter((field) => field !== 'stop_ceiling' && target[field] !== null)
    .map((field) => TARGET_FIELD_UNITS[field]).filter(Boolean);
  if (isPlainObject(target.stop_ceiling)) {
    for (const field of Object.keys(target.stop_ceiling)) {
      if (field.includes('heart_rate')) units.push('bpm');
      else if (field.includes('rpe')) units.push('rpe');
      else if (field.includes('duration')) units.push('s');
      else if (field.includes('pace')) units.push('s/km');
    }
  }
  return [...new Set(units)];
}

function validateRange(range, rules) {
  if (!isPlainObject(range) || !Object.hasOwn(range, 'minimum') || !Object.hasOwn(range, 'maximum')) return false;
  if (Object.keys(range).some((key) => !['minimum', 'maximum'].includes(key))) return false;
  const minimum = range.minimum;
  const maximum = range.maximum;
  if (typeof minimum !== 'number' || !Number.isFinite(minimum)
    || typeof maximum !== 'number' || !Number.isFinite(maximum)
    || minimum < rules.minimum || maximum < minimum) return false;
  if (rules.maximum !== undefined && maximum > rules.maximum) return false;
  return rules.integer !== true || (Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum));
}

function validateStopCeiling(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return false;
  for (const [field, amount] of Object.entries(value)) {
    if (!STOP_CEILING_FIELDS.has(field) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      return false;
    }
  }
  return true;
}

function validateTarget(target, path, violations) {
  if (!isPlainObject(target)) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path, reason: 'TARGET_NOT_OBJECT' });
    return;
  }
  for (const field of Object.keys(target)) {
    if (!TARGET_FIELDS.has(field)) {
      violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${path}.${field}`, reason: 'TARGET_FIELD_UNSUPPORTED' });
      continue;
    }
    const value = target[field];
    if (value === null) continue;
    if (RANGE_FIELDS[field]) {
      if (!validateRange(value, RANGE_FIELDS[field])) {
        violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${path}.${field}`, reason: 'TARGET_RANGE_INVALID' });
      }
    } else if (field === 'stop_ceiling') {
      if (!validateStopCeiling(value)) {
        violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${path}.${field}`, reason: 'STOP_CEILING_INVALID' });
      }
    } else if (field === 'load_kg') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
        || Math.abs(value * 10 - Math.round(value * 10)) > Number.EPSILON * 10) {
        violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${path}.${field}`, reason: 'LOAD_KG_INVALID' });
      }
    } else if (INTEGER_TARGET_FIELDS.has(field)
      && (!Number.isSafeInteger(value) || value < 0 || (field === 'rir' && value > 10))) {
      violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${path}.${field}`, reason: 'TARGET_INTEGER_INVALID' });
    }
  }
}

function validateProvenanceEntry(entry, path, violations) {
  if (!isPlainObject(entry)) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path, reason: 'PROVENANCE_NOT_OBJECT' });
    return [];
  }
  const evidenceIds = entry.source_evidence_ids;
  if (!Array.isArray(evidenceIds) || evidenceIds.some((id) => !nonEmptyString(id))) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: `${path}.source_evidence_ids`, reason: 'EVIDENCE_IDS_INVALID' });
  }
  if (!nonEmptyString(entry.derived_athlete_state_field)) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: `${path}.derived_athlete_state_field`, reason: 'ATHLETE_STATE_FIELD_REQUIRED' });
  }
  if (Array.isArray(evidenceIds) && evidenceIds.length === 0
    && !String(entry.derived_athlete_state_field || '').startsWith('UNKNOWN_')) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path, reason: 'SOURCE_OR_UNKNOWN_REQUIRED' });
  }
  const hasPolicy = nonEmptyString(entry.policy_id)
    && (positiveRevision(entry.policy_version) || nonEmptyString(entry.policy_version));
  const hasRuleset = nonEmptyString(entry.ruleset_id)
    && (positiveRevision(entry.ruleset_version) || nonEmptyString(entry.ruleset_version));
  if (!hasPolicy && !hasRuleset) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: `${path}.policy_id`, reason: 'POLICY_REFERENCE_INVALID' });
  }
  if (!CONFIDENCE_SET.has(entry.confidence)) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: `${path}.confidence`, reason: 'CONFIDENCE_INVALID' });
  }
  if (!validTimestamp(entry.derived_at)) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: `${path}.derived_at`, reason: 'DERIVATION_TIME_INVALID' });
  }
  if (!nonEmptyString(entry.decision_id)) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: `${path}.decision_id`, reason: 'DECISION_ID_REQUIRED' });
  }
  const units = entry.canonical_units;
  if (!Array.isArray(units) || units.some((unit) => !WORKOUT_UNIT_SET.has(unit))) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: `${path}.canonical_units`, reason: 'CANONICAL_UNITS_INVALID' });
    return [];
  }
  return units;
}

function validateStepCollection(steps, path, violations, seenIds) {
  if (!Array.isArray(steps)) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path, reason: 'STEPS_NOT_ARRAY' });
    return;
  }
  const orders = [];
  steps.forEach((step, index) => {
    const stepPath = `${path}[${index}]`;
    if (!isPlainObject(step)) {
      violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: stepPath, reason: 'STEP_NOT_OBJECT' });
      return;
    }
    for (const field of Object.keys(step)) {
      if (!STEP_FIELDS.has(field)) {
        violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${stepPath}.${field}`, reason: 'STEP_FIELD_UNSUPPORTED' });
      }
    }
    if (!nonEmptyString(step.step_id) || seenIds.has(step.step_id)) {
      violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${stepPath}.step_id`, reason: 'STEP_ID_INVALID_OR_DUPLICATE' });
    } else seenIds.add(step.step_id);
    if (!STEP_TYPE_SET.has(step.type)) {
      violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${stepPath}.type`, reason: 'STEP_TYPE_UNSUPPORTED' });
    }
    if (!Number.isSafeInteger(step.order) || step.order < 1) {
      violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${stepPath}.order`, reason: 'STEP_ORDER_INVALID' });
    } else orders.push(step.order);
    validateTarget(step.target, `${stepPath}.target`, violations);
    if (isPlainObject(step.target) && STEP_TYPE_SET.has(step.type)) {
      const allowedFields = STEP_TARGET_ALLOWED_FIELDS[step.type];
      for (const field of Object.keys(step.target).filter((key) => step.target[key] !== null)) {
        if (!allowedFields.has(field)) {
          violations.push({
            code: 'CANONICAL_SCHEMA_INVALID',
            path: `${stepPath}.target.${field}`,
            reason: 'TARGET_COMBINATION_UNSUPPORTED',
          });
        }
      }
    }
    if (!Array.isArray(step.provenance)) {
      violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: `${stepPath}.provenance`, reason: 'PROVENANCE_NOT_ARRAY' });
    } else {
      const coveredUnits = new Set(step.provenance.flatMap((entry, provenanceIndex) => (
        validateProvenanceEntry(entry, `${stepPath}.provenance[${provenanceIndex}]`, violations)
      )));
      const requiredUnits = targetUnits(step.target);
      if (requiredUnits.length && (!step.provenance.length || requiredUnits.some((unit) => !coveredUnits.has(unit)))) {
        violations.push({
          code: 'TARGET_PROVENANCE_INVALID',
          path: `${stepPath}.provenance`,
          reason: 'NUMERICAL_TARGET_PROVENANCE_MISSING',
          required_units: requiredUnits,
        });
      }
    }
    if (step.workout_family !== undefined && !WORKOUT_FAMILY_SET.has(step.workout_family)) {
      violations.push({ code: 'WORKOUT_FAMILY_UNRESOLVED', path: `${stepPath}.workout_family` });
    }
    if (step.type === 'repeat') {
      if (!Number.isSafeInteger(step.repeat_count) || step.repeat_count < 1) {
        violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${stepPath}.repeat_count`, reason: 'REPEAT_COUNT_INVALID' });
      }
      if (isPlainObject(step.target) && Object.keys(step.target).length) {
        violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${stepPath}.target`, reason: 'REPEAT_TARGET_MUST_BE_EMPTY' });
      }
      if (!Array.isArray(step.children) || !step.children.length) {
        violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${stepPath}.children`, reason: 'REPEAT_CHILDREN_REQUIRED' });
      } else validateStepCollection(step.children, `${stepPath}.children`, violations, seenIds);
    } else if (step.children !== undefined) {
      violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: `${stepPath}.children`, reason: 'CHILDREN_ONLY_ALLOWED_ON_REPEAT' });
    }
  });
  if (orders.length === steps.length) {
    const expected = steps.map((_, index) => index + 1);
    if (orders.some((order, index) => order !== expected[index])) {
      violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path, reason: 'STEP_ORDER_NOT_CONTIGUOUS' });
    }
  }
}

function emptyTotals() {
  return {
    distance_m: 0,
    duration_s: 0,
    work_distance_m: 0,
    work_duration_s: 0,
    repetitions: 0,
    sets: 0,
    station_distance_m: 0,
  };
}

function addTotals(target, source, multiplier = 1) {
  for (const key of Object.keys(target)) target[key] += source[key] * multiplier;
}

function deriveCanonicalTotals(steps = []) {
  const totals = emptyTotals();
  if (!Array.isArray(steps)) return totals;
  for (const step of steps) {
    if (!isPlainObject(step)) continue;
    if (step.type === 'repeat') {
      const repeatCount = Number.isSafeInteger(step.repeat_count) && step.repeat_count > 0 ? step.repeat_count : 0;
      addTotals(totals, deriveCanonicalTotals(step.children), repeatCount);
      totals.repetitions += repeatCount;
      continue;
    }
    const target = isPlainObject(step.target) ? step.target : {};
    const distance = Number.isSafeInteger(target.distance_m) && target.distance_m >= 0 ? target.distance_m : 0;
    const duration = Number.isSafeInteger(target.duration_s) && target.duration_s >= 0 ? target.duration_s : 0;
    totals.distance_m += distance;
    totals.duration_s += duration;
    totals.repetitions += Number.isSafeInteger(target.repetitions) && target.repetitions >= 0 ? target.repetitions : 0;
    totals.sets += Number.isSafeInteger(target.sets) && target.sets >= 0 ? target.sets : 0;
    if (!NON_CONTRIBUTING_TYPES.has(step.type)) {
      totals.work_distance_m += distance;
      totals.work_duration_s += duration;
    }
    if (step.type === 'station') totals.station_distance_m += distance;
  }
  return totals;
}

function flattenSteps(steps = [], output = []) {
  if (!Array.isArray(steps)) return output;
  for (const step of steps) {
    if (!isPlainObject(step)) continue;
    output.push(step);
    if (Array.isArray(step.children)) flattenSteps(step.children, output);
  }
  return output;
}

function familyCompatibleWithShape(family, steps) {
  const flat = flattenSteps(steps, []);
  const types = new Set(flat.map((step) => step.type));
  const hasRun = types.has('run') || types.has('interval');
  const hasStation = types.has('station');
  const hasStrength = types.has('strength_exercise');
  if (family === 'rest') return flat.length === 0 || flat.every((step) => step.type === 'manual_instruction');
  if (family === 'mobility') return types.has('mobility') && !hasRun && !hasStation && !hasStrength;
  if (family === 'manual_recovery') return !hasRun && !hasStation && !hasStrength;
  if (RUN_FAMILIES.has(family)) return hasRun && !hasStation && !hasStrength;
  if (STRENGTH_FAMILIES.has(family)) return hasStrength && !hasRun && !hasStation;
  if (HYROX_STATION_FAMILIES.has(family)) return (hasStation || hasStrength) && !hasRun;
  if (HYROX_MIXED_FAMILIES.has(family)) return hasRun && hasStation;
  if (family === 'race') return hasRun || hasStation;
  if (family === 'assessment') return flat.some((step) => (
    !NON_CONTRIBUTING_TYPES.has(step.type) && WORKOUT_FAMILY_SET.has(step.workout_family)
  ));
  return false;
}

function contributingFamilies(steps) {
  return flattenSteps(steps, []).filter((step) => !NON_CONTRIBUTING_TYPES.has(step.type))
    .map((step) => step.workout_family)
    .filter(Boolean);
}

function deriveWorkoutFamily(session = {}) {
  const declared = session.workout_family;
  if (!WORKOUT_FAMILY_SET.has(declared) || !familyCompatibleWithShape(declared, session.steps)) return null;
  const contributors = contributingFamilies(session.steps);
  if (declared === 'assessment') {
    return contributors.length && contributors.every((family) => (
      WORKOUT_FAMILY_SET.has(family)
      && !['rest', 'mobility', 'manual_recovery', 'assessment'].includes(family)
    )) ? declared : null;
  }
  if (HYROX_MIXED_FAMILIES.has(declared) || declared === 'race') return declared;
  return contributors.every((family) => family === declared) ? declared : null;
}

function deriveStressVector(session = {}) {
  const family = deriveWorkoutFamily(session);
  if (!family) return null;
  if (family === 'assessment') {
    return resolveStressVector('assessment', { contributing_work_families: contributingFamilies(session.steps) });
  }
  return resolveStressVector(family, { event_kind: session.event_kind });
}

function deriveCapability(steps = []) {
  const flat = flattenSteps(steps, []);
  const manualStepIds = flat.filter((step) => MANUAL_STEP_TYPES.has(step.type)).map((step) => step.step_id);
  const structuredCount = flat.filter((step) => STRUCTURED_STEP_TYPES.has(step.type) && step.type !== 'repeat').length;
  let classification = 'FULLY_STRUCTURED';
  if (manualStepIds.length && structuredCount) classification = 'PARTIALLY_STRUCTURED';
  else if (manualStepIds.length) classification = 'MANUAL_COMPONENTS_REQUIRED';
  else if (!structuredCount) classification = 'NOT_EXPORTABLE';
  return {
    classification,
    manual_step_ids: manualStepIds,
    unsupported_step_ids: [],
  };
}

function comparableCapability(actual, expected) {
  return isPlainObject(actual)
    && CAPABILITY_SET.has(actual.classification)
    && canonicalStringify(actual) === canonicalStringify(expected);
}

function targetProvenanceFromSteps(steps = []) {
  const entries = flattenSteps(steps, []).flatMap((step) => Array.isArray(step.provenance) ? step.provenance : []);
  return [...new Map(entries.map((entry) => [canonicalStringify(entry), clone(entry)])).values()];
}

function canonicalHashValue(value, depth = 0) {
  if (Array.isArray(value)) return value.map((entry) => canonicalHashValue(entry, depth + 1));
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    const adapterField = depth === 0 && TOP_LEVEL_ADAPTER_FIELDS.has(key);
    if (!HASH_OMITTED_FIELDS.has(key) && !adapterField && value[key] !== undefined) {
      result[key] = canonicalHashValue(value[key], depth + 1);
    }
    return result;
  }, {});
}

function canonicalWorkoutHash(session = {}) {
  return canonicalHash(canonicalHashValue(session));
}

function totalMismatches(stored, derived) {
  if (!isPlainObject(stored)) return [{ field: 'derived_totals', stored: null, derived }];
  const tolerances = { distance_m: 2, duration_s: 1, work_distance_m: 2, work_duration_s: 1, repetitions: 0, sets: 0, station_distance_m: 2 };
  return Object.keys(derived).filter((field) => (
    typeof stored[field] !== 'number' || !Number.isFinite(stored[field])
    || Math.abs(stored[field] - derived[field]) > tolerances[field]
  )).map((field) => ({ field, stored: stored[field] ?? null, derived: derived[field], tolerance: tolerances[field] }));
}

function validateDerivedTotals(session = {}) {
  const derived = deriveCanonicalTotals(session.steps);
  const mismatches = totalMismatches(session.derived_totals, derived);
  return deepFreeze({
    valid: mismatches.length === 0,
    derived_totals: derived,
    mismatches,
    reason_codes: mismatches.length ? ['DERIVED_TOTAL_MISMATCH'] : [],
  });
}

function validCriteria(value) {
  return Array.isArray(value) && value.every((entry) => (
    nonEmptyString(entry) || (isPlainObject(entry) && Object.keys(entry).length > 0)
  ));
}

function validateCanonicalSession(session = {}) {
  const violations = [];
  if (!isPlainObject(session)) {
    return deepFreeze({ valid: false, violations: [{ code: 'CANONICAL_SCHEMA_INVALID', path: 'session' }], reason_codes: ['CANONICAL_SCHEMA_INVALID'] });
  }
  if (session.canonical_workout_schema_version !== CANONICAL_WORKOUT_SCHEMA_VERSION) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'canonical_workout_schema_version', reason: 'SCHEMA_VERSION_INVALID' });
  }
  for (const field of ['session_id', 'plan_id', 'decision_id', 'title']) {
    if (!nonEmptyString(session[field])) violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: field, reason: 'REQUIRED_STRING_INVALID' });
  }
  if (!validTimeZone(session.timezone)) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'timezone', reason: 'TIMEZONE_INVALID' });
  }
  if (session.stress_taxonomy_version !== STRESS_TAXONOMY_VERSION) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'stress_taxonomy_version', reason: 'STRESS_TAXONOMY_VERSION_INVALID' });
  }
  for (const field of ['session_revision', 'plan_revision']) {
    if (!positiveRevision(session[field])) violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: field, reason: 'REVISION_INVALID' });
  }
  if (!Array.isArray(session.goal_ids) || session.goal_ids.some((id) => !nonEmptyString(id))) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'goal_ids', reason: 'GOAL_IDS_INVALID' });
  } else if (new Set(session.goal_ids).size !== session.goal_ids.length) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'goal_ids', reason: 'GOAL_IDS_DUPLICATE' });
  }
  if (!PHASE_SET.has(session.phase)) violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'phase', reason: 'PHASE_INVALID' });
  if (!SESSION_ROLE_SET.has(session.role)) violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'role', reason: 'ROLE_INVALID' });
  if (!WORKOUT_FAMILY_SET.has(session.workout_family)) violations.push({ code: 'WORKOUT_FAMILY_UNRESOLVED', path: 'workout_family' });
  if (!validDate(session.scheduled_local_date)) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'scheduled_local_date', reason: 'DATE_INVALID' });
  }
  if (!Array.isArray(session.purpose_reason_codes)
    || session.purpose_reason_codes.some((code) => normalizeReasonCode(code) !== code)) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'purpose_reason_codes', reason: 'REASON_CODES_INVALID' });
  }
  for (const field of ['success_criteria', 'adjustment_criteria', 'stop_criteria']) {
    if (!validCriteria(session[field])) violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: field, reason: 'CRITERIA_INVALID' });
  }
  validateStepCollection(session.steps, 'steps', violations, new Set());
  for (const [index, entry] of targetProvenanceFromSteps(session.steps).entries()) {
    if (entry.decision_id !== session.decision_id) {
      violations.push({
        code: 'TARGET_PROVENANCE_INVALID',
        path: `target_provenance[${index}].decision_id`,
        reason: 'DECISION_ID_MISMATCH',
      });
    }
  }

  const resolvedFamily = deriveWorkoutFamily(session);
  if (!resolvedFamily || resolvedFamily !== session.workout_family) {
    violations.push({ code: 'WORKOUT_FAMILY_UNRESOLVED', path: 'workout_family', declared: session.workout_family ?? null });
  }
  const expectedVector = deriveStressVector(session);
  if (!expectedVector || !Array.isArray(session.stress_vector)
    || canonicalStringify(session.stress_vector) !== canonicalStringify(expectedVector)) {
    violations.push({ code: resolvedFamily ? 'CANONICAL_SCHEMA_INVALID' : 'WORKOUT_FAMILY_UNRESOLVED', path: 'stress_vector', reason: 'STRESS_VECTOR_MISMATCH' });
  }
  const derivedTotals = deriveCanonicalTotals(session.steps);
  const mismatches = totalMismatches(session.derived_totals, derivedTotals);
  if (mismatches.length) {
    violations.push({ code: 'DERIVED_TOTAL_MISMATCH', path: 'derived_totals', mismatches });
  }
  const expectedProvenance = targetProvenanceFromSteps(session.steps);
  if (!Array.isArray(session.target_provenance)
    || canonicalStringify(session.target_provenance) !== canonicalStringify(expectedProvenance)) {
    violations.push({ code: 'TARGET_PROVENANCE_INVALID', path: 'target_provenance', reason: 'SESSION_PROVENANCE_MISMATCH' });
  }
  const expectedCapability = deriveCapability(session.steps);
  if (!comparableCapability(session.capability, expectedCapability)) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'capability', reason: 'CAPABILITY_MISMATCH', expected: expectedCapability });
  }
  if (!/^[a-f0-9]{64}$/.test(String(session.content_hash || ''))
    || session.content_hash !== canonicalWorkoutHash(session)) {
    violations.push({ code: 'CANONICAL_SCHEMA_INVALID', path: 'content_hash', reason: 'CONTENT_HASH_MISMATCH' });
  }
  const reasonCodes = [...new Set(violations.map((violation) => violation.code))];
  return deepFreeze({ valid: violations.length === 0, violations, reason_codes: reasonCodes });
}

function assertCanonicalSession(session) {
  const result = validateCanonicalSession(session);
  if (!result.valid) {
    const error = new Error(`Canonical workout failed validation: ${result.violations[0].code}`);
    error.code = 'INVALID_CANONICAL_WORKOUT';
    error.status = 422;
    error.details = result.violations;
    throw error;
  }
  return session;
}

function buildCanonicalSession(input = {}) {
  const source = clone(input) || {};
  const assessmentContributors = source.workout_family === 'assessment'
    ? contributingFamilies(source.steps) : null;
  const session = {
    ...source,
    ...(assessmentContributors ? { contributing_work_families: assessmentContributors } : {}),
    canonical_workout_schema_version: CANONICAL_WORKOUT_SCHEMA_VERSION,
    stress_taxonomy_version: STRESS_TAXONOMY_VERSION,
    stress_vector: deriveStressVector(source),
    derived_totals: deriveCanonicalTotals(source.steps),
    target_provenance: targetProvenanceFromSteps(source.steps),
    capability: deriveCapability(source.steps),
  };
  session.content_hash = canonicalWorkoutHash(session);
  assertCanonicalSession(session);
  return deepFreeze(session);
}

function canonicalClusterNumber(value, minimum = 0) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum ? numeric : null;
}

function canonicalClusterRange(value, fallback = null) {
  if (!isPlainObject(value)) return fallback;
  const minimum = Number(value.minimum);
  const maximum = Number(value.maximum);
  return Number.isFinite(minimum) && Number.isFinite(maximum) && minimum >= 1 && maximum >= minimum
    ? { minimum, maximum } : fallback;
}

function clusterDerivedAt(input = {}) {
  const supplied = input.planning_instant ?? input.derived_at;
  if (validTimestamp(supplied)) return new Date(supplied).toISOString();
  const date = input.scheduled_local_date;
  return validDate(date) ? `${date}T12:00:00.000Z` : '1970-01-01T00:00:00.000Z';
}

function clusterProvenance(input, units, field, { ruleset = false, confidence = 'HIGH', sourceId = null } = {}) {
  const rulesetId = input.hyrox_event_state?.ruleset_id ?? input.ruleset_id;
  const rulesetVersion = input.hyrox_event_state?.ruleset_version ?? input.ruleset_version;
  const provenance = {
    source_evidence_ids: [String(sourceId || (ruleset
      ? `ruleset:${rulesetId || 'unknown'}:${rulesetVersion || 'unknown'}`
      : `prescription:${input.session_id || 'hyrox-cluster'}`))],
    derived_athlete_state_field: field,
    confidence,
    derived_at: clusterDerivedAt(input),
    decision_id: String(input.decision_id || 'hyrox-cluster-decision'),
    canonical_units: [...new Set(units)],
  };
  if (ruleset && nonEmptyString(rulesetId) && nonEmptyString(rulesetVersion)) {
    provenance.ruleset_id = rulesetId;
    provenance.ruleset_version = rulesetVersion;
  } else {
    provenance.policy_id = GOAL_BACKWARD_PLANNING_POLICY_ID;
    provenance.policy_version = 1;
  }
  return provenance;
}

const GOAL_BACKWARD_PLANNING_POLICY_ID = 'goal-backward-planning-policy-v1';

function stationLoadKg(standard = {}) {
  const raw = standard.loadKgIncludingSled ?? standard.loadKg ?? standard.loadKgPerImplement ?? standard.ballKg;
  const numeric = Number(raw);
  return raw !== null && raw !== undefined && Number.isFinite(numeric) && numeric >= 0
    ? Math.round(numeric * 10) / 10 : null;
}

function stationContributionAmount(value = {}) {
  if (!isPlainObject(value)) return { unit: null, amount: null };
  const distance = canonicalClusterNumber(value.distance_m ?? value.distanceMeters);
  if (distance !== null) return { unit: 'm', amount: distance };
  const repetitions = canonicalClusterNumber(value.repetitions ?? value.reps);
  if (repetitions !== null) return { unit: 'count', amount: repetitions };
  return { unit: null, amount: null };
}

function officialStationContribution(standard = {}) {
  const distance = canonicalClusterNumber(standard.distanceMeters);
  if (distance !== null) return { unit: 'm', amount: distance };
  const repetitions = canonicalClusterNumber(standard.repetitions);
  if (repetitions !== null) return { unit: 'count', amount: repetitions };
  return { unit: null, amount: null };
}

function resolvedClusterRuleset(input = {}) {
  const state = input.hyrox_event_state || {};
  const rulesetId = state.ruleset_id ?? input.ruleset_id;
  const rulesetVersion = state.ruleset_version ?? input.ruleset_version;
  const eventFormat = state.event_format ?? (state.format === 'doubles' ? 'doubles' : input.event_format);
  const division = state.registered_division ?? input.registered_division;
  if (!nonEmptyString(rulesetId) || !nonEmptyString(rulesetVersion)) return null;
  const resolved = resolveHyroxStandard({
    rulesetId,
    rulesetVersion,
    format: eventFormat,
    category: division,
  });
  return resolved.status === 'exact' ? resolved : null;
}

function clusterStationIds(input = {}, pairCount = 0) {
  if (Array.isArray(input.station_ids)) return input.station_ids.slice(0, pairCount).map(String);
  const start = canonicalClusterNumber(input.station_start_index) ?? 0;
  return HYROX_STATION_ORDER.slice(start, start + pairCount);
}

function clusterStationContributions(input, stationIds, resolved) {
  const state = input.hyrox_event_state || {};
  const doubles = String(state.format ?? input.format ?? '').toLowerCase() === 'doubles';
  const dose = Number(input.station_dose_fraction ?? 0.5);
  const doseFraction = Number.isFinite(dose) ? dose : 0.5;
  const standards = new Map((resolved?.stations || []).map((standard) => [standard.id, standard]));
  return stationIds.map((stationId) => {
    const standard = standards.get(stationId) || {};
    const explicit = stationContributionAmount(state.planned_athlete_station_contribution?.[stationId]);
    const official = officialStationContribution(standard);
    const basis = doubles ? explicit : official;
    const prescribed = basis.amount === null ? null : Math.ceil(basis.amount * doseFraction);
    return {
      station_id: stationId,
      contribution_basis: doubles
        ? 'EXPLICIT_DOUBLES_PLANNED_CONTRIBUTION' : 'OFFICIAL_SINGLES_VOLUME',
      explicit_doubles_contribution: doubles ? explicit.amount !== null : null,
      basis_unit: basis.unit,
      basis_amount: basis.amount,
      prescribed_amount: prescribed,
      dose_fraction: basis.amount === null || prescribed === null ? null : prescribed / basis.amount,
      official_load_kg: resolved ? stationLoadKg(standard) : null,
      load_basis: standard.loadKgPerImplement !== undefined ? 'PER_IMPLEMENT'
        : standard.ballKg !== undefined ? 'BALL' : stationLoadKg(standard) !== null ? 'REGISTERED_TOTAL' : null,
    };
  });
}

function distributedDurations(total, count) {
  const safeTotal = canonicalClusterNumber(total) ?? 0;
  if (!count) return [];
  const base = Math.floor(safeTotal / count);
  let remainder = safeTotal - base * count;
  return Array.from({ length: count }, () => {
    const value = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return value;
  });
}

function compactTarget(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function partialClusterInput(input, key, fallback, parse, valid) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return fallback;
  const parsed = parse(input[key]);
  if (!valid(parsed)) throw new Error(`invalid_partial_cluster_input:${key}`);
  return parsed;
}

function buildPartialRaceOrderCluster(input = {}) {
  const pairCount = partialClusterInput(
    input, 'pair_count', 3, (value) => canonicalClusterNumber(value, 1),
    (value) => value !== null && value >= 2 && value <= 4,
  );
  const runDistance = partialClusterInput(
    input, 'run_distance_m', 750, (value) => canonicalClusterNumber(value, 1),
    (value) => value !== null && value >= 750 && value <= 1000,
  );
  const mainWorkDuration = partialClusterInput(
    input, 'main_work_duration_s', 36 * 60, (value) => canonicalClusterNumber(value, 1),
    (value) => value !== null && value >= 20 * 60 && value <= 40 * 60,
  );
  const rpe = partialClusterInput(
    input, 'main_set_rpe_range', { minimum: 6, maximum: 8 },
    (value) => canonicalClusterRange(value),
    (value) => Boolean(value && value.minimum >= 6 && value.maximum <= 8),
  );
  const stationDoseFraction = partialClusterInput(
    input, 'station_dose_fraction', 0.5,
    (value) => (value === null || value === undefined || (typeof value === 'string' && !value.trim())
      ? null : Number(value)),
    (value) => Number.isFinite(value) && value >= 0.5 && value <= 1,
  );
  const warmupDistance = partialClusterInput(
    input, 'warmup_running_m', 0, (value) => canonicalClusterNumber(value), (value) => value !== null,
  );
  const cooldownDistance = partialClusterInput(
    input, 'cooldown_running_m', 0, (value) => canonicalClusterNumber(value), (value) => value !== null,
  );
  const stationStartIndex = partialClusterInput(
    input, 'station_start_index', 0, (value) => canonicalClusterNumber(value),
    (value) => value !== null && value + pairCount <= HYROX_STATION_ORDER.length,
  );
  const normalizedInput = {
    ...input,
    pair_count: pairCount,
    run_distance_m: runDistance,
    main_work_duration_s: mainWorkDuration,
    main_set_rpe_range: rpe,
    station_dose_fraction: stationDoseFraction,
    warmup_running_m: warmupDistance,
    cooldown_running_m: cooldownDistance,
    station_start_index: stationStartIndex,
  };
  const stationIds = clusterStationIds(normalizedInput, pairCount);
  const resolved = resolvedClusterRuleset(normalizedInput);
  const contributions = clusterStationContributions(normalizedInput, stationIds, resolved);
  const workDurations = distributedDurations(mainWorkDuration, pairCount * 2);
  const steps = [];
  if (warmupDistance > 0) {
    steps.push(step(`${input.session_id}-warmup`, 'warmup', steps.length + 1, {
      target: { distance_m: warmupDistance, rpe_range: { minimum: 2, maximum: 4 } },
      provenance: [clusterProvenance(normalizedInput, ['m', 'rpe'], 'hyrox_cluster.warmup')],
    }));
  }
  stationIds.forEach((stationId, index) => {
    steps.push(step(`${input.session_id}-pair-${index + 1}-run`, 'run', steps.length + 1, {
      target: { distance_m: runDistance, duration_s: workDurations[index * 2], rpe_range: rpe },
      provenance: [clusterProvenance(normalizedInput, ['m', 's', 'rpe'], 'hyrox_cluster.run_prescription')],
    }, { workout_family: 'hyrox_partial_simulation', step_role: 'WORK' }));
    const contribution = contributions[index];
    const target = compactTarget({
      distance_m: contribution.basis_unit === 'm' ? contribution.prescribed_amount : null,
      repetitions: contribution.basis_unit === 'count' ? contribution.prescribed_amount : null,
      duration_s: workDurations[index * 2 + 1],
      load_kg: contribution.official_load_kg,
      rpe_range: rpe,
    });
    const units = [contribution.basis_unit, 's', contribution.official_load_kg === null ? null : 'kg', 'rpe'].filter(Boolean);
    steps.push(step(`${input.session_id}-pair-${index + 1}-station`, 'station', steps.length + 1, {
      target,
      provenance: [clusterProvenance(normalizedInput, units, contribution.contribution_basis === 'OFFICIAL_SINGLES_VOLUME'
        ? 'hyrox_ruleset.official_station_requirements'
        : 'hyrox_event_state.planned_station_split', {
        ruleset: true,
        confidence: contribution.prescribed_amount === null ? 'INSUFFICIENT' : 'HIGH',
        sourceId: contribution.contribution_basis === 'OFFICIAL_SINGLES_VOLUME'
          ? null : `planned-split:${stationId}`,
      })],
    }, { workout_family: 'hyrox_partial_simulation', step_role: 'WORK', station_id: stationId }));
  });
  if (cooldownDistance > 0) {
    steps.push(step(`${input.session_id}-cooldown`, 'cooldown', steps.length + 1, {
      target: { distance_m: cooldownDistance, rpe_range: { minimum: 2, maximum: 4 } },
      provenance: [clusterProvenance(normalizedInput, ['m', 'rpe'], 'hyrox_cluster.cooldown')],
    }));
  }
  const mainSetRunning = pairCount * runDistance;
  const runningDistance = mainSetRunning + warmupDistance + cooldownDistance;
  const cluster = {
    subtype: 'PartialRaceOrderCluster',
    station_ids: stationIds,
    official_pair_orders: stationIds.map((stationId) => HYROX_STATION_ORDER.indexOf(stationId) + 1),
    run_distances_m: Array(pairCount).fill(runDistance),
    station_contributions: contributions,
    main_work_duration_s: mainWorkDuration,
    main_set_rpe_range: rpe,
    warmup_running_m: warmupDistance,
    cooldown_running_m: cooldownDistance,
    completion: clone(input.completion ?? {
      status: 'PLANNED', completed_step_ids: [], stop_criteria_breach: false,
    }),
  };
  return buildCanonicalSession({
    ...clone(normalizedInput),
    id: String(input.id || input.session_id || 'hyrox-partial-cluster'),
    session_id: String(input.session_id || 'hyrox-partial-cluster'),
    session_revision: positiveRevision(input.session_revision) ? input.session_revision : 1,
    plan_id: String(input.plan_id || 'hyrox-plan-preview'),
    plan_revision: positiveRevision(input.plan_revision) ? input.plan_revision : 1,
    decision_id: String(input.decision_id || 'hyrox-cluster-decision'),
    goal_ids: Array.isArray(input.goal_ids) ? input.goal_ids.map(String) : [],
    phase: PHASE_SET.has(input.phase) ? input.phase : 'EVENT_SPECIFIC_DEVELOPMENT',
    role: SESSION_ROLE_SET.has(input.role) ? input.role : 'PRIMARY_KEY',
    workout_family: 'hyrox_partial_simulation',
    title: String(input.title || 'HYROX partial race-order cluster'),
    purpose_reason_codes: Array.isArray(input.purpose_reason_codes) ? input.purpose_reason_codes : ['EVENT_SPECIFIC_ENTRY'],
    scheduled_local_date: input.scheduled_local_date,
    timezone: String(input.timezone || 'UTC'),
    steps,
    success_criteria: clone(input.success_criteria || [{
      code: 'PAIRS_COMPLETED_IN_ORDER', station_ids: stationIds, stop_criteria_breach: false,
    }]),
    adjustment_criteria: clone(input.adjustment_criteria || ['Reduce station volume within the prescribed contribution gate when control is lost.']),
    stop_criteria: clone(input.stop_criteria || ['Stop for sharp pain, dizziness, or altered running mechanics.']),
    partial_race_order_cluster: cluster,
    run_station_pair_count: pairCount,
    main_work_duration_s: mainWorkDuration,
    main_work_duration_min: mainWorkDuration / 60,
    main_set_rpe_range: rpe,
    main_set_running_m: mainSetRunning,
    warmup_cooldown_running_m: warmupDistance + cooldownDistance,
    running_distance_m: runningDistance,
    distance_miles: Math.round((runningDistance / 1609.344) * 100) / 100,
    sessionType: 'hyrox_partial_simulation',
    kind: 'hyrox',
    includesRun: true,
    runningStress: 'hard',
    hardLowerBody: true,
    heavyStationWork: false,
    replacesQualityRun: true,
    runSequenceMeters: Array(pairCount).fill(runDistance),
    stationSequence: contributions.map((entry) => ({
      id: entry.station_id,
      prescribedAmount: entry.prescribed_amount,
      basisAmount: entry.basis_amount,
      unit: entry.basis_unit,
      doseFraction: entry.dose_fraction,
      prescribedLoadKg: entry.official_load_kg,
    })),
  });
}

function validatePartialRaceOrderCluster(session = {}, options = {}) {
  const violations = [];
  const cluster = session.partial_race_order_cluster;
  if (session.workout_family !== 'hyrox_partial_simulation' || !isPlainObject(cluster)
    || cluster.subtype !== 'PartialRaceOrderCluster') {
    violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'CLOSED_SUBTYPE_REQUIRED' });
    return deepFreeze({ valid: false, completed_successfully: false, violations, reason_codes: ['REQUIRED_EXPOSURE_UNPLACEABLE'] });
  }
  if (session.canonical_workout_schema_version === CANONICAL_WORKOUT_SCHEMA_VERSION) {
    const canonical = validateCanonicalSession(session);
    violations.push(...canonical.violations.map((violation) => ({ ...clone(violation), cluster_reason: 'CANONICAL_SESSION_INVALID' })));
  }
  const stationIds = Array.isArray(cluster.station_ids) ? cluster.station_ids.map(String) : [];
  const pairCount = canonicalClusterNumber(session.run_station_pair_count);
  if (pairCount === null || pairCount < 2 || pairCount > 4 || stationIds.length !== pairCount) {
    violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'PAIR_COUNT_OUT_OF_RANGE' });
  }
  const officialIndexes = stationIds.map((stationId) => HYROX_STATION_ORDER.indexOf(stationId));
  if (officialIndexes.some((index) => index < 0)
    || officialIndexes.some((index, position) => position > 0 && index !== officialIndexes[position - 1] + 1)) {
    violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'OFFICIAL_ORDER_NOT_CONTIGUOUS' });
  }
  if (canonicalStringify(cluster.official_pair_orders) !== canonicalStringify(
    officialIndexes.map((index) => index + 1),
  )) violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'OFFICIAL_PAIR_ORDER_MISMATCH' });
  const runDistances = Array.isArray(cluster.run_distances_m) ? cluster.run_distances_m.map(Number) : [];
  if (runDistances.length !== pairCount || runDistances.some((distance) => (
    !Number.isSafeInteger(distance) || distance < 750 || distance > 1000 || distance !== runDistances[0]
  ))) violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'RUN_DISTANCE_GATE' });
  const workSteps = flattenSteps(session.steps, []).filter((entry) => entry.step_role === 'WORK');
  const runSteps = workSteps.filter((entry) => entry.type === 'run');
  const stationSteps = workSteps.filter((entry) => entry.type === 'station');
  const alternatingKinds = Array.from({ length: Number(pairCount || 0) * 2 }, (_, index) => (
    index % 2 === 0 ? 'run' : 'station'
  ));
  if (runSteps.length !== pairCount || stationSteps.length !== pairCount
    || canonicalStringify(workSteps.map((entry) => entry.type)) !== canonicalStringify(alternatingKinds)
    || runSteps.some((entry, index) => entry.target?.distance_m !== runDistances[index])
    || stationSteps.some((entry, index) => entry.station_id !== stationIds[index])) {
    violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'PAIR_STEP_GRAPH_MISMATCH' });
  }
  const mainDuration = canonicalClusterNumber(cluster.main_work_duration_s);
  const stepDuration = workSteps.reduce((sum, entry) => sum + Number(entry.target?.duration_s || 0), 0);
  if (mainDuration === null || mainDuration < 20 * 60 || mainDuration > 40 * 60 || stepDuration !== mainDuration) {
    violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'MAIN_SET_DURATION_GATE' });
  }
  const rpe = canonicalClusterRange(cluster.main_set_rpe_range);
  if (!rpe || rpe.minimum < 6 || rpe.maximum > 8 || workSteps.some((entry) => (
    canonicalStringify(entry.target?.rpe_range) !== canonicalStringify(rpe)
  ))) violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'CONTROLLED_RPE_GATE' });
  const age = String(options.training_age_class ?? options.trainingAgeClass ?? inputTrainingAge(session) ?? '').toUpperCase();
  const safetyModified = options.safety_modified === true || session.safety_modified === true;
  if ((['BEGINNER', 'RETURNING'].includes(age) || safetyModified) && pairCount !== 2) {
    violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'MODIFIED_ATHLETE_PAIR_COUNT' });
  } else if (['DEVELOPING', 'ESTABLISHED', 'ADVANCED'].includes(age) && !safetyModified && (pairCount < 3 || pairCount > 4)) {
    violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'ESTABLISHED_PEAK_PAIR_COUNT' });
  }
  const resolved = resolvedClusterRuleset(session);
  if (!resolved) violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'RULESET_OR_DIVISION_UNSUPPORTED' });
  const state = session.hyrox_event_state || {};
  const doubles = String(state.format ?? session.format ?? '').toLowerCase() === 'doubles';
  const contributions = Array.isArray(cluster.station_contributions) ? cluster.station_contributions : [];
  if (contributions.length !== pairCount) {
    violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'STATION_CONTRIBUTION_COUNT' });
  } else contributions.forEach((contribution, index) => {
    if (contribution.station_id !== stationIds[index]) {
      violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'STATION_CONTRIBUTION_ORDER', station_id: stationIds[index] });
      return;
    }
    if (doubles && (contribution.contribution_basis !== 'EXPLICIT_DOUBLES_PLANNED_CONTRIBUTION'
      || contribution.explicit_doubles_contribution !== true || contribution.basis_amount === null
      || contribution.prescribed_amount === null)) {
      violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'DOUBLES_CONTRIBUTION_UNKNOWN', station_id: contribution.station_id });
    }
    const standard = resolved?.stations?.find((entry) => entry.id === contribution.station_id);
    const expectedBasis = doubles
      ? stationContributionAmount(state.planned_athlete_station_contribution?.[contribution.station_id])
      : officialStationContribution(standard);
    const stationStepAmount = contribution.basis_unit === 'm'
      ? stationSteps[index]?.target?.distance_m
      : contribution.basis_unit === 'count' ? stationSteps[index]?.target?.repetitions : null;
    if (expectedBasis.amount === null
      || contribution.basis_unit !== expectedBasis.unit
      || contribution.basis_amount !== expectedBasis.amount
      || stationStepAmount !== contribution.prescribed_amount) {
      violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'STATION_VOLUME_BASIS_MISMATCH', station_id: contribution.station_id });
    }
    const ratio = Number(contribution.dose_fraction);
    const derivedRatio = Number(contribution.prescribed_amount) / Number(contribution.basis_amount);
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 1
      || !Number.isFinite(derivedRatio) || Math.abs(derivedRatio - ratio) > 1e-9) {
      violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'STATION_VOLUME_GATE', station_id: contribution.station_id });
    }
    const expectedLoad = resolved ? stationLoadKg(standard) : null;
    const prescribedLoad = stationSteps[index]?.target?.load_kg ?? null;
    if (expectedLoad !== prescribedLoad || expectedLoad !== contribution.official_load_kg) {
      violations.push({ code: 'HYROX_PARTIAL_CLUSTER_INVALID', reason: 'REGISTERED_LOAD_GATE', station_id: contribution.station_id });
    }
  });
  const completion = isPlainObject(cluster.completion) ? cluster.completion : {};
  const completedStepIds = Array.isArray(completion.completed_step_ids)
    ? completion.completed_step_ids.map(String) : [];
  const expectedStepIds = workSteps.map((entry) => String(entry.step_id));
  const completedSuccessfully = String(completion.status || '').toUpperCase() === 'COMPLETED'
    && completion.stop_criteria_breach === false
    && canonicalStringify(completedStepIds) === canonicalStringify(expectedStepIds);
  return deepFreeze({
    valid: violations.length === 0,
    completed_successfully: violations.length === 0 && completedSuccessfully,
    pair_count: pairCount,
    station_ids: stationIds,
    violations,
    reason_codes: violations.length ? ['REQUIRED_EXPOSURE_UNPLACEABLE'] : [],
  });
}

function inputTrainingAge(session = {}) {
  return session.training_age_class ?? session.trainingAgeClass;
}

const ROAD_GENERAL_FAMILIES = new Set([
  'rest', 'mobility', 'manual_recovery', 'recovery_run', 'easy_run', 'long_aerobic',
  'steady_run', 'threshold_run', 'interval_run', 'race_rhythm_run', 'race', 'assessment',
]);
const QUALITY_RUN_FAMILIES = new Set(['threshold_run', 'interval_run', 'race_rhythm_run']);
const PHASE_REASON_CODES = Object.freeze({
  FOUNDATION: 'FOUNDATION_ENTRY',
  DEVELOPMENT: 'DEVELOPMENT_ENTRY',
  EVENT_SPECIFIC_DEVELOPMENT: 'EVENT_SPECIFIC_ENTRY',
  SHARPENING: 'SHARPENING_ENTRY',
  TAPER_RACE_WEEK: 'TAPER_ENTRY',
  POST_RACE_TRANSITION: 'POST_RACE_TRANSITION',
});
const FAMILY_TITLES = Object.freeze({
  rest: 'Rest',
  mobility: 'Mobility',
  manual_recovery: 'Recovery',
  recovery_run: 'Recovery run',
  easy_run: 'Easy aerobic run',
  long_aerobic: 'Long aerobic run',
  steady_run: 'Steady run',
  threshold_run: 'Threshold intervals',
  interval_run: 'Intervals',
  race_rhythm_run: 'Race-rhythm intervals',
  race: 'Race',
  assessment: 'Assessment',
  hyrox_station_skill: 'HYROX station skill',
  hyrox_station_strength: 'HYROX station strength',
  hyrox_compromised: 'Controlled compromised running',
  hyrox_partial_simulation: 'HYROX partial race-order cluster',
  hyrox_full_simulation: 'HYROX full simulation',
});

function boundedInteger(value, minimum = 0) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum ? Math.round(numeric) : null;
}

function parseDurationSeconds(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  if (Number.isFinite(Number(value))) return Math.max(0, Math.round(Number(value)));
  const raw = String(value || '').toLowerCase();
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m)(?:\b|\s)/);
  if (!match) return null;
  const amount = Number(match[1]);
  const seconds = match[2].startsWith('m') ? amount * 60 : amount;
  const multiplier = raw.match(/(\d+)\s*[x×]\s*\d/)?.[1];
  return Math.round(seconds * (multiplier ? Number(multiplier) : 1));
}

function durationMinutesToSeconds(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes * 60) : null;
}

function prescribedDurationSeconds(source = {}) {
  const direct = boundedInteger(source.duration_s);
  return direct !== null ? direct : durationMinutesToSeconds(source.duration_min);
}

function sumDurationSeconds(values) {
  return (Array.isArray(values) ? values : [values]).reduce((sum, value) => (
    sum + (parseDurationSeconds(value) || 0)
  ), 0);
}

function evidenceIdsForMaterial(source, decision) {
  const entries = [source?.evidence_refs, source?.evidence_ids, decision?.evidence_used]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .map((entry) => typeof entry === 'string' ? entry : entry?.evidence_id ?? entry?.id)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return [...new Set(entries)].sort();
}

function targetForStep({ family, durationS = null, distanceM = null, repetitions = null, input, source }) {
  const targetFamily = family === 'assessment' ? 'interval_run' : family;
  const sourceEvidenceIds = evidenceIdsForMaterial(source, input.decision);
  const result = buildCanonicalMaterialTarget({
    ...(input.target_context || {}),
    workout_family: targetFamily,
    duration_s: boundedInteger(durationS),
    distance_m: boundedInteger(distanceM),
    repetitions: boundedInteger(repetitions),
    decision_id: input.decision.decision_id,
    planning_instant: input.planning_instant,
    source_evidence_ids: sourceEvidenceIds,
    derived_athlete_state_field: sourceEvidenceIds.length
      ? 'candidate_material.prescribed_dosage'
      : 'UNKNOWN_LEGACY_CANDIDATE_DOSAGE',
  });
  if (!result.valid) {
    const error = new Error(`Canonical target failed for ${family}`);
    error.code = 'CANONICAL_TARGET_UNAVAILABLE';
    error.details = result.violations || result.reason_codes;
    throw error;
  }
  return { target: result.target, provenance: result.provenance };
}

function step(id, type, order, targetResult, extra = {}) {
  return {
    step_id: id,
    type,
    order,
    target: targetResult?.target || {},
    provenance: targetResult?.provenance || [],
    ...extra,
  };
}

function minimumRunDurationSeconds(family, input) {
  const age = String(input.training_age_class || '').toUpperCase();
  if (family === 'recovery_run') {
    return age === 'BEGINNER' || Number(input.recent_normal_running_minutes_per_week) < 60 ? 15 * 60 : 20 * 60;
  }
  if (family === 'easy_run') return ['BEGINNER', 'RETURNING'].includes(age) ? 20 * 60 : 25 * 60;
  if (family === 'long_aerobic') {
    return Math.max(30 * 60, Math.round(Number(input.median_ordinary_easy_duration_min || 30) * 1.5 * 60));
  }
  return 20 * 60;
}

function prescribedDistanceMeters(source = {}) {
  const canonicalPrescribed = boundedInteger(source.canonical_prescribed_distance_m);
  if (canonicalPrescribed !== null
    && source.canonical_distance_derivation === 'observed_pace_conservative_110_percent_v1'
    && String(source.prescription_basis || '').toLowerCase() === 'time'
    && source.distance_is_estimate === true) return canonicalPrescribed;
  const direct = boundedInteger(source.distance_m);
  if (direct !== null && source.distance_is_estimate !== true) return direct;
  if (source.distance_miles === null || source.distance_miles === undefined
    || (typeof source.distance_miles === 'string' && source.distance_miles.trim() === '')) return null;
  const miles = Number(source.distance_miles);
  if (Number.isFinite(miles) && miles >= 0 && source.distance_is_estimate !== true) return Math.round(miles * 1609.344);
  return null;
}

function materializeQualityRunSteps(family, source, input) {
  const quality = source.quality_prescription || {};
  const repetitions = Math.max(1, boundedInteger(quality.repetitions ?? source.repetitions, 1) || 1);
  const qualityWorkDuration = durationMinutesToSeconds(source.quality_work_duration_min);
  const workSeconds = parseDurationSeconds(quality.work)
    || boundedInteger(qualityWorkDuration !== null ? qualityWorkDuration / repetitions : null)
    || (8 * 60);
  const recoverySeconds = parseDurationSeconds(quality.recovery?.duration ?? quality.recovery) || 0;
  const warmupSeconds = sumDurationSeconds(source.warmup) || (10 * 60);
  const parsedCooldown = sumDurationSeconds(source.cooldown) || (10 * 60);
  const totalDuration = prescribedDurationSeconds(source);
  const repeatBodySeconds = repetitions > 1 ? ((repetitions - 1) * (workSeconds + recoverySeconds)) : 0;
  const beforeCooldown = warmupSeconds + repeatBodySeconds + workSeconds;
  const cooldownSeconds = totalDuration !== null && totalDuration >= beforeCooldown
    ? totalDuration - beforeCooldown
    : parsedCooldown;
  const steps = [];
  steps.push(step(
    `${input.session_id}-warmup`,
    'warmup',
    steps.length + 1,
    targetForStep({ family: 'easy_run', durationS: warmupSeconds, input, source }),
  ));
  if (repetitions > 1) {
    const children = [step(
      `${input.session_id}-work-repeat`,
      'interval',
      1,
      targetForStep({ family, durationS: workSeconds, input, source }),
      { workout_family: family, step_role: 'WORK' },
    )];
    if (recoverySeconds > 0) children.push(step(
      `${input.session_id}-recovery-repeat`,
      'recovery',
      2,
      targetForStep({ family: 'recovery_run', durationS: recoverySeconds, input, source }),
    ));
    steps.push(step(`${input.session_id}-repeat`, 'repeat', steps.length + 1, null, {
      repeat_count: repetitions - 1,
      children,
    }));
  }
  steps.push(step(
    `${input.session_id}-work-final`,
    'interval',
    steps.length + 1,
    targetForStep({ family, durationS: workSeconds, input, source }),
    { workout_family: family, step_role: 'WORK' },
  ));
  if (cooldownSeconds > 0) steps.push(step(
    `${input.session_id}-cooldown`,
    'cooldown',
    steps.length + 1,
    targetForStep({ family: 'easy_run', durationS: cooldownSeconds, input, source }),
  ));
  return steps;
}

function materializeRoadGeneralSteps(family, source, input) {
  if (!ROAD_GENERAL_FAMILIES.has(family)) {
    const error = new Error(`Workout family ${family} is not materialized in Phase 2B-2`);
    error.code = 'WORKOUT_FAMILY_UNRESOLVED';
    throw error;
  }
  if (family === 'rest') return [];
  const duration = prescribedDurationSeconds(source);
  if (family === 'mobility') {
    return [step(`${input.session_id}-mobility`, 'mobility', 1, targetForStep({
      family: 'easy_run', durationS: duration ?? 20 * 60, input, source,
    }))];
  }
  if (family === 'manual_recovery') {
    return [step(`${input.session_id}-manual-recovery`, 'manual_instruction', 1, targetForStep({
      family: 'recovery_run', durationS: duration ?? 20 * 60, input, source,
    }))];
  }
  if (QUALITY_RUN_FAMILIES.has(family)) return materializeQualityRunSteps(family, source, input);
  const contributorFamily = family === 'assessment' ? 'interval_run' : family;
  const distance = prescribedDistanceMeters(source);
  const effectiveDuration = duration ?? (distance === null ? minimumRunDurationSeconds(family, input) : null);
  const target = targetForStep({
    family: contributorFamily,
    durationS: effectiveDuration,
    distanceM: distance,
    input,
    source,
  });
  return [step(`${input.session_id}-work`, 'run', 1, target, {
    workout_family: contributorFamily,
    step_role: 'WORK',
  })];
}

function materializeHyroxStationSteps(family, source, input) {
  const sequence = Array.isArray(source.stationSequence) ? source.stationSequence
    : Array.isArray(source.station_sequence) ? source.station_sequence : [];
  const stations = sequence.length ? sequence : [{ id: 'manual_station_skill' }];
  const totalDuration = prescribedDurationSeconds(source) ?? 35 * 60;
  const durations = distributedDurations(totalDuration, stations.length);
  return stations.map((station, index) => {
    const distance = canonicalClusterNumber(station.distance_m ?? station.distanceMeters ?? station.prescribedAmount);
    const repetitions = canonicalClusterNumber(station.repetitions ?? station.reps);
    const load = Number(station.prescribedLoadKg ?? station.load_kg);
    const loadKg = Number.isFinite(load) && load >= 0 ? Math.round(load * 10) / 10 : null;
    const rpe = family === 'hyrox_station_strength'
      ? { minimum: 7, maximum: 8 } : { minimum: 5, maximum: 6 };
    const target = compactTarget({
      distance_m: distance,
      duration_s: durations[index],
      repetitions,
      load_kg: loadKg,
      rpe_range: rpe,
    });
    const units = [distance === null ? null : 'm', 's', repetitions === null ? null : 'count', loadKg === null ? null : 'kg', 'rpe']
      .filter(Boolean);
    return step(`${input.session_id}-station-${index + 1}`, 'station', index + 1, {
      target,
      provenance: [clusterProvenance({ ...source, ...input }, units, 'hyrox_station_prescription')],
    }, {
      workout_family: family,
      step_role: 'WORK',
      station_id: String(station.id ?? station.station_id ?? `manual-station-${index + 1}`),
    });
  });
}

function sourceMaterialFor(candidate, skeleton) {
  const materials = Array.isArray(candidate.candidate_material) ? candidate.candidate_material : [];
  const material = materials.find((entry) => String(entry.material_id) === String(skeleton.candidate_material_id));
  return clone(material?.source_session || material || skeleton) || {};
}

function nextSessionRevision(input, skeleton) {
  if (typeof input.session_revision === 'function') return input.session_revision(skeleton);
  if (positiveRevision(input.session_revision)) return input.session_revision;
  const activeSessions = Array.isArray(input.active_applied_plan?.sessions)
    ? input.active_applied_plan.sessions
    : (input.active_applied_plan?.weeks || []).flatMap((week) => (
      (week.days || week.sessions || []).flatMap((day) => Array.isArray(day.sessions) ? day.sessions : [day])
    ));
  const active = activeSessions.find((session) => String(session.session_id ?? session.id) === String(skeleton.session_id));
  return active && positiveRevision(active.session_revision) ? active.session_revision + 1 : 1;
}

function materializeCanonicalSession(input = {}) {
  const decision = input.decision || {};
  const skeleton = input.skeleton || {};
  const source = input.source || sourceMaterialFor(input.candidate || {}, skeleton);
  const family = String(skeleton.workout_family || '');
  const planRevision = positiveRevision(input.plan_revision)
    ? input.plan_revision
    : Math.max(1, Number(decision.plan_revision || 0) + 1);
  const planId = String(input.plan_id || `candidate-plan-${String(decision.decision_hash || canonicalHash(decision)).slice(0, 24)}`);
  const sessionId = String(skeleton.session_id || skeleton.skeleton_session_id || source.session_id || source.id || '');
  const materializationInput = {
    ...input,
    decision,
    decision_id: String(decision.decision_id || ''),
    session_id: sessionId,
  };
  const steps = HYROX_STATION_FAMILIES.has(family)
    ? materializeHyroxStationSteps(family, source, materializationInput)
    : family === 'hyrox_partial_simulation' ? null
      : materializeRoadGeneralSteps(family, source, materializationInput);
  const phaseReason = PHASE_REASON_CODES[decision.phase];
  const sourceReasons = Array.isArray(source.reason_codes) ? source.reason_codes : [];
  const purposeReasonCodes = [...new Set([phaseReason, ...sourceReasons]
    .map((code) => normalizeReasonCode(code)).filter(Boolean))];
  const canonicalInput = {
    session_id: sessionId,
    session_revision: nextSessionRevision(input, skeleton),
    plan_id: planId,
    plan_revision: planRevision,
    decision_id: String(decision.decision_id || ''),
    goal_ids: [...new Set((decision.active_goals || []).map((goal) => String(goal.goal_id)).filter(Boolean))],
    phase: decision.phase,
    role: String(skeleton.role || '').toUpperCase(),
    workout_family: family,
    title: String(source.title || FAMILY_TITLES[family] || family),
    purpose_reason_codes: purposeReasonCodes,
    scheduled_local_date: skeleton.scheduled_local_date,
    timezone: String(input.timezone || decision.timezone || 'UTC'),
    steps,
    success_criteria: ['Complete the canonical work as prescribed.'],
    adjustment_criteria: ['Use the recorded adjustment and safety criteria when needed.'],
    stop_criteria: ['Stop when a recorded safety ceiling is reached.'],
    requirement_id: skeleton.requirement_id,
    supports_requirement_id: skeleton.supports_requirement_id || undefined,
    supports_session_id: skeleton.supports_session_id || undefined,
    limiter_id: skeleton.limiter_id || undefined,
    safety_scope: clone(decision.safety_state?.scope || []),
    executability: ['NORMAL', 'MONITOR'].includes(String(decision.safety_state?.action || 'NORMAL').toUpperCase())
      ? 'EXECUTABLE' : 'RESTRICTED',
    event_kind: decision.active_goals?.[0]?.event_kind,
  };
  const canonical = family === 'hyrox_partial_simulation'
    ? buildPartialRaceOrderCluster({
      ...clone(source),
      ...canonicalInput,
      session_id: sessionId,
      scheduled_local_date: skeleton.scheduled_local_date,
      timezone: String(input.timezone || decision.timezone || 'UTC'),
      training_age_class: input.training_age_class ?? decision.training_age_class,
      planning_instant: input.planning_instant,
    })
    : buildCanonicalSession(canonicalInput);
  const adapted = planSchema.normalizeSession({
    ...canonical,
    workout_id: source.workout_id,
    prescription_basis: source.prescription_basis,
    distance_miles: source.distance_miles === null || source.distance_miles === undefined
      || (typeof source.distance_miles === 'string' && source.distance_miles.trim() === '')
      ? undefined
      : (Number.isFinite(Number(source.distance_miles)) && Number(source.distance_miles) >= 0
        ? Number(source.distance_miles)
        : undefined),
    distance_is_estimate: source.distance_is_estimate,
    durationIsEstimated: source.durationIsEstimated,
    target_zone: source.target_zone,
    pace_target: source.pace_target,
    intensity: source.intensity,
    description: source.description,
  }, sessionId);
  assertCanonicalSession(adapted);
  return deepFreeze(adapted);
}

function aggregateSessionTotals(sessions = []) {
  return sessions.reduce((totals, session) => {
    addTotals(totals, session.derived_totals || emptyTotals());
    return totals;
  }, emptyTotals());
}

function canonicalSessionSetHash(sessionSet = {}) {
  const content = { ...clone(sessionSet) };
  delete content.content_hash;
  // Candidate identity includes this session-set hash. Excluding the reciprocal
  // candidate hash avoids a circular digest while the persisted artifact binds both.
  delete content.candidate_hash;
  return canonicalHash(content);
}

function validateCanonicalSessionSet(sessionSet = {}) {
  const violations = [];
  if (!isPlainObject(sessionSet)) {
    return deepFreeze({ valid: false, violations: [{ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'SET_NOT_OBJECT' }], reason_codes: ['CANONICAL_SESSION_SET_INVALID'] });
  }
  if (sessionSet.canonical_workout_schema_version !== CANONICAL_WORKOUT_SCHEMA_VERSION) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'SCHEMA_VERSION_MISMATCH' });
  }
  for (const field of ['plan_id', 'decision_id', 'candidate_id']) {
    if (!nonEmptyString(sessionSet[field])) violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: `${field.toUpperCase()}_INVALID` });
  }
  if (!positiveRevision(sessionSet.plan_revision)) violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'PLAN_REVISION_INVALID' });
  for (const field of ['decision_hash', 'candidate_hash']) {
    if (!/^[a-f0-9]{64}$/.test(String(sessionSet[field] || ''))) {
      violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: `${field.toUpperCase()}_INVALID` });
    }
  }
  if (!/^[a-f0-9]{64}$/.test(String(sessionSet.candidate_skeleton_hash || ''))) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'CANDIDATE_SKELETON_HASH_INVALID' });
  }
  if (!/^[a-f0-9]{64}$/.test(String(sessionSet.material_change_baseline_binding_hash || ''))) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'MATERIAL_BASELINE_BINDING_HASH_INVALID' });
  }
  const sessions = Array.isArray(sessionSet.sessions) ? sessionSet.sessions : [];
  if (!Array.isArray(sessionSet.sessions) || !sessions.length) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'SESSIONS_REQUIRED' });
  }
  const seenIds = new Set();
  sessions.forEach((session, index) => {
    const id = String(session?.session_id || '');
    if (seenIds.has(id)) violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'DUPLICATE_SESSION_ID', session_id: id });
    seenIds.add(id);
    const result = validateCanonicalSession(session);
    if (!result.valid) violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'SESSION_INVALID', session_index: index, details: result.violations });
    if (session?.plan_id !== sessionSet.plan_id) violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'PLAN_ID_MISMATCH', session_id: id });
    if (session?.plan_revision !== sessionSet.plan_revision) violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'PLAN_REVISION_MISMATCH', session_id: id });
    if (session?.decision_id !== sessionSet.decision_id) violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'DECISION_ID_MISMATCH', session_id: id });
  });
  const totals = aggregateSessionTotals(sessions);
  if (canonicalStringify(sessionSet.derived_totals) !== canonicalStringify(totals)) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'SESSION_SET_TOTAL_MISMATCH', derived_totals: totals });
  }
  const hashes = sessions.map((session) => ({ session_id: session.session_id, content_hash: session.content_hash }));
  if (canonicalStringify(sessionSet.session_content_hashes) !== canonicalStringify(hashes)) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'SESSION_HASH_BINDING_MISMATCH' });
  }
  if (!/^[a-f0-9]{64}$/.test(String(sessionSet.content_hash || ''))
    || sessionSet.content_hash !== canonicalSessionSetHash(sessionSet)) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'CONTENT_HASH_MISMATCH' });
  }
  const expectedCandidateHash = canonicalHash({
    candidate_skeleton_hash: sessionSet.candidate_skeleton_hash,
    canonical_session_set_hash: sessionSet.content_hash,
  });
  if (sessionSet.candidate_hash !== expectedCandidateHash) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'CANDIDATE_HASH_BINDING_MISMATCH' });
  }
  return deepFreeze({
    valid: violations.length === 0,
    violations,
    reason_codes: violations.length ? ['CANONICAL_SESSION_SET_INVALID'] : [],
    derived_totals: totals,
  });
}

function materializeCanonicalSessionSet(input = {}) {
  const decision = input.decision || {};
  const candidate = input.candidate || {};
  const planRevision = positiveRevision(input.plan_revision)
    ? input.plan_revision
    : Math.max(1, Number(decision.plan_revision || 0) + 1);
  const planId = String(input.plan_id || `candidate-plan-${String(decision.decision_hash || canonicalHash(decision)).slice(0, 24)}`);
  const sessions = (candidate.sessions || []).map((skeleton) => materializeCanonicalSession({
    ...input,
    decision,
    candidate,
    skeleton,
    source: sourceMaterialFor(candidate, skeleton),
    plan_id: planId,
    plan_revision: planRevision,
  }));
  const set = {
    canonical_workout_schema_version: CANONICAL_WORKOUT_SCHEMA_VERSION,
    canonical_sessions_materialized: true,
    plan_id: planId,
    plan_revision: planRevision,
    decision_id: String(decision.decision_id || ''),
    decision_hash: String(decision.decision_hash || ''),
    candidate_id: String(candidate.candidate_skeleton_id || candidate.candidate_id || ''),
    candidate_skeleton_hash: String(candidate.candidate_skeleton_hash || candidate.candidate_hash || canonicalHash(candidate)),
    candidate_hash: '',
    material_change_baseline_binding_hash: canonicalHash({
      material_change_baseline: candidate.material_change?.material_change_baseline ?? null,
      baseline_plan_revision: candidate.material_change?.baseline_plan_revision ?? null,
      active_prescription_hash: candidate.material_change?.active_prescription_hash ?? null,
      baseline_session_bindings: candidate.material_change?.baseline_session_bindings ?? [],
    }),
    sessions,
    session_content_hashes: sessions.map((session) => ({ session_id: session.session_id, content_hash: session.content_hash })),
    derived_totals: aggregateSessionTotals(sessions),
  };
  set.content_hash = canonicalSessionSetHash(set);
  set.candidate_hash = canonicalHash({
    candidate_skeleton_hash: set.candidate_skeleton_hash,
    canonical_session_set_hash: set.content_hash,
  });
  const validation = validateCanonicalSessionSet(set);
  if (!validation.valid) {
    const error = new Error(`Canonical session set failed validation: ${validation.violations[0].reason}`);
    error.code = 'INVALID_CANONICAL_SESSION_SET';
    error.status = 422;
    error.details = validation.violations;
    throw error;
  }
  return deepFreeze(set);
}

function canonicalHyroxFormat(input = {}) {
  const raw = String(input.format ?? input.event_format ?? input.eventFormat ?? '').toLowerCase();
  if (raw === 'doubles') return 'doubles';
  if (['singles', 'open', 'pro', 'individual', 'individual_open', 'individual_pro'].includes(raw)) {
    return 'singles';
  }
  const eventFormat = normalizeHyroxFormat(input.event_format ?? input.eventFormat ?? raw);
  if (eventFormat === 'doubles') return 'doubles';
  if (['individual_open', 'individual_pro'].includes(eventFormat)) return 'singles';
  return null;
}

function canonicalHyroxEventFormat(input, format) {
  if (format === 'doubles') return 'doubles';
  const explicit = normalizeHyroxFormat(input.event_format ?? input.eventFormat);
  if (['individual_open', 'individual_pro'].includes(explicit)) return explicit;
  const legacy = normalizeHyroxFormat(input.format);
  if (['individual_open', 'individual_pro'].includes(legacy)) return legacy;
  return 'individual_open';
}

function stationMap(value, mapper = (entry) => clone(entry)) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(HYROX_STATION_ORDER.map((stationId) => [
    stationId,
    Object.hasOwn(source, stationId) && source[stationId] !== undefined
      ? mapper(source[stationId], stationId)
      : null,
  ]));
}

function splitContribution(splitMap, owner) {
  return stationMap(splitMap, (entry) => {
    if (!isPlainObject(entry)) return null;
    if (Object.hasOwn(entry, owner) && entry[owner] !== undefined && entry[owner] !== null) {
      return clone(entry[owner]);
    }
    const fraction = entry[`${owner}_fraction`] ?? entry[`${owner}_percentage`];
    return fraction === undefined || fraction === null ? null : { fraction: clone(fraction) };
  });
}

function secondsFrom(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (!isPlainObject(value)) return null;
  const seconds = value.time_s ?? value.projected_time_s ?? value.duration_s;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function exactHyroxLoad(standard = {}) {
  const load = Object.keys(standard).reduce((result, key) => {
    if (/Kg|implements|targetHeightMeters|loadsByAthleteCategory/.test(key)) result[key] = clone(standard[key]);
    return result;
  }, {});
  return load;
}

function officialContribution(standard = {}) {
  const contribution = {};
  if (Number.isSafeInteger(standard.distanceMeters)) contribution.distance_m = standard.distanceMeters;
  if (Number.isSafeInteger(standard.repetitions)) contribution.repetitions = standard.repetitions;
  contribution.ownership = 'athlete_full';
  return contribution;
}

function buildCanonicalHyroxEventState(input = {}) {
  const format = canonicalHyroxFormat(input);
  const eventFormat = canonicalHyroxEventFormat(input, format);
  const rawDivision = input.registered_division ?? input.registeredDivision ?? input.category;
  const registeredDivision = normalizeHyroxCategory(rawDivision) || 'unknown';
  const rulesetId = input.ruleset_id ?? input.rulesetId ?? null;
  const rulesetVersion = input.ruleset_version
    ?? input.rulesetVersion
    ?? input.rulesVersion
    ?? null;
  const resolved = nonEmptyString(rulesetId) && nonEmptyString(rulesetVersion)
    ? resolveHyroxStandard({
      rulesetId,
      rulesetVersion,
      format: eventFormat,
      category: registeredDivision,
    })
    : {
      status: 'incomplete',
      rulesetId,
      rulesetVersion,
      format: eventFormat,
      category: registeredDivision,
      exactLoads: false,
      stations: null,
    };
  const exact = resolved.status === 'exact';
  const standards = exact ? resolved.stations : HYROX_REGISTRY.stations.map((station) => ({
    id: station.id,
    name: station.name,
    equipmentKey: station.equipmentKey,
  }));
  const stationOwnership = format === 'doubles' ? 'team_shared' : 'athlete';
  const runOwnership = format === 'doubles' ? 'athlete_required_with_partner' : 'athlete';
  const officialRunRequirements = HYROX_STATION_ORDER.map((stationId, index) => ({
    order: index + 1,
    station_id_after_run: stationId,
    distance_m: exact ? resolved.stations[index].runBeforeMeters : null,
    ownership: runOwnership,
  }));
  const officialStationRequirements = standards.map((standard, index) => ({
    station_id: standard.id,
    order: index + 1,
    ownership: stationOwnership,
    distance_m: exact && Number.isSafeInteger(standard.distanceMeters) ? standard.distanceMeters : null,
    repetitions: exact && Number.isSafeInteger(standard.repetitions) ? standard.repetitions : null,
    official_standard: exact ? clone(standard) : null,
    exact_load: exact ? exactHyroxLoad(standard) : null,
    load_instruction: exact ? 'official_registered_load' : 'registered_load_or_relative_technique',
  }));
  const plannedStationSplit = stationMap(input.planned_station_split ?? input.plannedStationSplit);
  const actualStationSplit = stationMap(input.actual_station_split ?? input.actualStationSplit);
  const plannedAthleteContribution = splitContribution(plannedStationSplit, 'athlete');
  const plannedPartnerContribution = splitContribution(plannedStationSplit, 'partner');
  const actualAthleteContribution = splitContribution(actualStationSplit, 'athlete');
  const actualPartnerContribution = splitContribution(actualStationSplit, 'partner');
  const explicitAthleteContribution = stationMap(
    input.athlete_station_contribution ?? input.athleteStationContribution,
  );
  const explicitPartnerContribution = stationMap(
    input.partner_station_contribution ?? input.partnerStationContribution,
  );
  const athleteStationContribution = format === 'singles'
    ? Object.fromEntries(resolved.status === 'exact'
      ? resolved.stations.map((standard) => [standard.id, officialContribution(standard)])
      : HYROX_STATION_ORDER.map((stationId) => [stationId, null]))
    : Object.fromEntries(HYROX_STATION_ORDER.map((stationId) => [
      stationId,
      explicitAthleteContribution[stationId] ?? actualAthleteContribution[stationId] ?? null,
    ]));
  const partnerStationContribution = format === 'doubles'
    ? Object.fromEntries(HYROX_STATION_ORDER.map((stationId) => [
      stationId,
      explicitPartnerContribution[stationId] ?? actualPartnerContribution[stationId] ?? null,
    ]))
    : Object.fromEntries(HYROX_STATION_ORDER.map((stationId) => [stationId, null]));
  const teamStationTime = stationMap(
    input.team_station_time ?? input.teamStationTime,
    (entry) => secondsFrom(entry),
  );
  const individualStationTime = Object.fromEntries(HYROX_STATION_ORDER.map((stationId) => [
    stationId,
    format === 'singles'
      ? secondsFrom((input.athlete_station_time ?? input.athleteStationTime)?.[stationId])
      : secondsFrom(athleteStationContribution[stationId]),
  ]));
  const contributionCoherent = format === 'singles' || HYROX_STATION_ORDER.every((stationId) => (
    (athleteStationContribution[stationId] !== null || plannedAthleteContribution[stationId] !== null)
    && (partnerStationContribution[stationId] !== null || plannedPartnerContribution[stationId] !== null)
  ));
  const transitionBehavior = clone(input.transition_behavior ?? input.transitionBehavior ?? {});
  const roxzone = clone(input.roxzone ?? {});
  const teamTransitionTime = secondsFrom(
    transitionBehavior.team_time_s ?? roxzone.team_time_s ?? input.team_transition_roxzone_time_s,
  );
  const athleteTransitionTime = secondsFrom(
    transitionBehavior.athlete_time_s
      ?? transitionBehavior.time_s
      ?? roxzone.athlete_time_s
      ?? input.athlete_transition_roxzone_time_s,
  );
  const runDistance = exact
    ? officialRunRequirements.reduce((sum, run) => sum + run.distance_m, 0)
    : null;
  const partnerId = format === 'doubles'
    ? (input.partner_id ?? input.partnerId ?? null)
    : null;
  const placeholder = format === 'doubles' && partnerId === null
    ? (input.partner_placeholder ?? input.partnerPlaceholder ?? 'Partner TBD')
    : null;
  return deepFreeze({
    format,
    athlete_id: input.athlete_id ?? input.athleteId ?? null,
    partner_id: partnerId,
    partner_placeholder: placeholder,
    registered_division: registeredDivision,
    event_format: eventFormat,
    ruleset_id: rulesetId,
    ruleset_version: rulesetVersion,
    ruleset_status: resolved.status,
    exact_loads_available: exact,
    official_run_requirements: officialRunRequirements,
    official_station_requirements: officialStationRequirements,
    team_station_time: teamStationTime,
    athlete_station_contribution: athleteStationContribution,
    partner_station_contribution: partnerStationContribution,
    planned_station_split: plannedStationSplit,
    actual_station_split: actualStationSplit,
    planned_athlete_station_contribution: plannedAthleteContribution,
    planned_partner_station_contribution: plannedPartnerContribution,
    transition_behavior: transitionBehavior,
    roxzone,
    compromised_running_evidence: clone(input.compromised_running_evidence ?? []),
    station_performance_evidence: clone(input.station_performance_evidence ?? []),
    transition_evidence: clone(input.transition_evidence ?? []),
    team_performance_evidence: clone(input.team_performance_evidence ?? []),
    athlete_specific_fatigue_evidence: clone(input.athlete_specific_fatigue_evidence ?? []),
    team_performance_burden: format === 'doubles' ? {
      run_requirement: 'both_athletes_complete_all_official_runs',
      athlete_run_distance_m: runDistance,
      station_ownership: 'team_shared',
      station_time_s: teamStationTime,
      transition_roxzone_time_s: teamTransitionTime,
    } : null,
    individual_training_burden: {
      run_distance_m: runDistance,
      run_ownership: format === 'doubles' ? 'athlete_required_with_partner' : 'athlete',
      station_ownership: format === 'doubles' ? 'explicit_contribution_only' : 'athlete_full',
      transition_ownership: format === 'doubles' ? 'athlete_specific_only' : 'athlete',
      planned_station_contribution: format === 'doubles'
        ? plannedAthleteContribution
        : athleteStationContribution,
      actual_station_contribution: athleteStationContribution,
      station_time_s: individualStationTime,
      transition_roxzone_time_s: athleteTransitionTime,
      contribution_coherent: contributionCoherent,
    },
  });
}

module.exports = {
  TARGET_FIELD_UNITS,
  assertCanonicalSession,
  buildCanonicalSession,
  buildCanonicalHyroxEventState,
  buildPartialRaceOrderCluster,
  canonicalSessionSetHash,
  canonicalWorkoutHash,
  deriveAssessmentStressVector: (steps) => resolveStressVector('assessment', {
    contributing_work_families: contributingFamilies(steps),
  }),
  deriveCanonicalTotals,
  deriveCapability,
  deriveStressVector,
  deriveWorkoutFamily,
  flattenSteps,
  materializeCanonicalSession,
  materializeCanonicalSessionSet,
  targetProvenanceFromSteps,
  validateCanonicalSession,
  validateCanonicalSessionSet,
  validateCanonicalWorkoutSession: validateCanonicalSession,
  validateCanonicalWorkout: validateCanonicalSession,
  validatePartialRaceOrderCluster,
  validateDerivedTotals,
  deriveStepTotals: deriveCanonicalTotals,
  hashCanonicalWorkout: canonicalWorkoutHash,
  materializeCanonicalWorkout: buildCanonicalSession,
  canonicalizeHyroxEventState: buildCanonicalHyroxEventState,
};
