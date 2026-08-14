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
const { canonicalStringify, canonicalHash } = require('./racePlanPolicy');

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
  const session = {
    ...source,
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

module.exports = {
  TARGET_FIELD_UNITS,
  assertCanonicalSession,
  buildCanonicalSession,
  canonicalWorkoutHash,
  deriveAssessmentStressVector: (steps) => resolveStressVector('assessment', {
    contributing_work_families: contributingFamilies(steps),
  }),
  deriveCanonicalTotals,
  deriveCapability,
  deriveStressVector,
  deriveWorkoutFamily,
  flattenSteps,
  targetProvenanceFromSteps,
  validateCanonicalSession,
  validateCanonicalWorkoutSession: validateCanonicalSession,
  validateCanonicalWorkout: validateCanonicalSession,
  validateDerivedTotals,
  deriveStepTotals: deriveCanonicalTotals,
  hashCanonicalWorkout: canonicalWorkoutHash,
  materializeCanonicalWorkout: buildCanonicalSession,
};
