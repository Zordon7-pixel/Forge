const { canonicalHash } = require('./racePlanPolicy');
const VERSION = 'running-prescribed-dose-v1';
// Existing constructor fallback: six miles, 12:00/mi base effort, 1.08 easy
// duration factor. This is a WEEKLY engineering reference, not a safe dose or
// a new session minimum. Requested frequency cannot change the denominator.
const REFERENCE = Object.freeze({ id: 'concurrent-six-mile-easy-week-v1', version: 1,
  distance_m: Math.round(6 * 1609.344), duration_s: Math.round(6 * 720 * 1.08),
  rpe_maximum: 4 });
const REFERENCE_HASH = canonicalHash(REFERENCE);
const FAMILIES = new Set(['easy_run', 'recovery_run']);
const prescription = session => {
  const steps = JSON.parse(JSON.stringify(session.steps));
  const unbindDecision = value => {
    if (!value || typeof value !== 'object') return;
    delete value.decision_id;
    Object.values(value).forEach(unbindDecision);
  };
  unbindDecision(steps);
  return { family: session.workout_family, steps };
};

function canonicalRunDose(session, { allowEffortOnly = false } = {}) {
  if (!FAMILIES.has(session.workout_family) || !Array.isArray(session.steps) || !session.steps.length) return null;
  let duration = 0, distance = 0, distanceUnspecified = false;
  for (const step of session.steps) {
    const target = step.target;
    if (!['run','recovery','warmup','cooldown'].includes(step.type)
      || (step.workout_family && !FAMILIES.has(step.workout_family))
      || !Number.isFinite(target?.duration_s) || target.duration_s <= 0
      || (target?.distance_m === undefined ? !allowEffortOnly : !Number.isFinite(target.distance_m) || target.distance_m < 0)
      || !Number.isFinite(target?.rpe_range?.minimum) || !Number.isFinite(target?.rpe_range?.maximum)
      || target.rpe_range.minimum < 1 || target.rpe_range.maximum > REFERENCE.rpe_maximum
      || target.rpe_range.minimum > target.rpe_range.maximum
      || !Array.isArray(step.provenance) || !step.provenance.some(entry => entry.canonical_units?.includes('rpe'))
      || (target.hr_zone !== undefined && (!Number.isInteger(target.hr_zone) || target.hr_zone < 1 || target.hr_zone > 2))
      // Numeric HR/pace prescriptions need an independent capacity/zone
      // authority; an easy label and low RPE cannot authenticate them.
      || target.heart_rate_range_bpm !== undefined
      || target.pace_range_s_per_km !== undefined || target.pace_range !== undefined) return null;
    duration += target.duration_s;
    if (target.distance_m === undefined) distanceUnspecified = true;
    else distance += target.distance_m;
  }
  return { duration_s: duration, distance_m: distance,
    distance_basis: distanceUnspecified ? 'DURATION_ONLY_NO_DISTANCE_PRESCRIPTION' : 'CANONICAL_DISTANCE_PRESCRIPTION' };
}

function runningPrescribedDose(session, familyVector) {
  const legacy = { valid: Boolean(familyVector), vector: familyVector && [...familyVector],
    state: 'PROTECTED_FAMILY_REFERENCE', version: VERSION, reference_id: REFERENCE.id };
  if (!FAMILIES.has(session?.workout_family)) return legacy;
  if (session.running_dose_accounting_version === undefined) return { ...legacy,
    valid: !session.running_dose, state: session.running_dose ? 'RUNNING_DOSE_POLICY_DOWNGRADE' : 'CONSERVATIVE_LEGACY_FAMILY' };
  const invalid = { ...legacy, valid: false, state: 'INVALID_CANONICAL_RUNNING_DOSE' };
  const receipt = session.running_dose;
  if (session.running_dose_accounting_version !== VERSION || !receipt
    || receipt.reference_id !== REFERENCE.id || receipt.reference_hash !== REFERENCE_HASH
    || receipt.canonical_prescription_hash !== canonicalHash(prescription(session))
    || receipt.source_hash !== canonicalHash(receipt.source)
    || !['COMPATIBLE_SERVER_HISTORY','CONSERVATIVE_TEMPLATE'].includes(receipt.source?.authority)
    || receipt.source?.policy_version !== VERSION
    || receipt.source?.authority === 'COMPATIBLE_SERVER_HISTORY' && !receipt.source.evidence_snapshot_hash
    || session.content_hash && require('./canonicalWorkout').canonicalWorkoutHash(session) !== session.content_hash) return invalid;
  const dose = canonicalRunDose(session, { allowEffortOnly: receipt.source.allow_effort_only === true });
  const pool = receipt.pool;
  if (!dose || canonicalHash(dose) !== canonicalHash(receipt.actual_dose) || !pool
    || receipt.pool_hash !== canonicalHash(pool) || !Array.isArray(pool.allocations) || !pool.allocations.length
    || pool.policy_version !== VERSION || pool.source_hash !== receipt.source_hash || pool.primary_basis !== 'ACTIVE_DURATION'
    || !Number.isInteger(receipt.partition_index) || receipt.partition_index < 0 || receipt.partition_index >= pool.allocations.length
    || receipt.partition_count !== pool.allocations.length
    || pool.allocations.some(entry => !entry || typeof entry.prescription_id !== 'string' || !entry.prescription_id
      || !/^[a-f0-9]{64}$/.test(String(entry.prescription_hash)) || !Number.isFinite(entry.dose?.duration_s)
      || entry.dose.duration_s <= 0 || !Number.isFinite(entry.dose?.distance_m) || entry.dose.distance_m < 0)
    || new Set(pool.allocations.map(entry => entry.prescription_id)).size !== pool.allocations.length) return invalid;
  const allocation = pool.allocations[receipt.partition_index];
  if (!allocation || allocation.prescription_id !== receipt.prescription_id
    || allocation.prescription_hash !== receipt.canonical_prescription_hash
    || canonicalHash(allocation.dose) !== canonicalHash(dose)) return invalid;
  const duration = pool.allocations.reduce((sum, entry) => sum + entry.dose.duration_s, 0);
  const distance = pool.allocations.reduce((sum, entry) => sum + entry.dose.distance_m, 0);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(distance) || distance < 0) return invalid;
  const weeklyExposure = Math.max(duration / REFERENCE.duration_s, distance / REFERENCE.distance_m);
  // Resolve the pool ONCE. Allocate exact micro-units by cumulative duration;
  // per-child maxima cannot manufacture load when a week is partitioned.
  const start = pool.allocations.slice(0, receipt.partition_index).reduce((sum, entry) => sum + entry.dose.duration_s, 0);
  const easyShape = [2,2,1,0,0,1,1,0];
  const vector = easyShape.map(value => {
    const wholePoolUnits = Math.ceil(value * weeklyExposure * 1e6);
    return (Math.round(wholePoolUnits * (start + durationForAllocation(allocation)) / duration)
      - Math.round(wholePoolUnits * start / duration)) / 1e6;
  });
  return { ...legacy, state: 'KNOWN_CANONICAL_EFFORT_DOSE',
    vector,
    actual_dose: dose };
}

function durationForAllocation(allocation) { return allocation.dose.duration_s; }

function bindRunningDosePool(sessions, source) {
  if (!source) return sessions;
  const eligible = sessions.filter(session => FAMILIES.has(session.workout_family));
  if (!eligible.length) return sessions;
  const allocations = eligible.map(session => ({ prescription_id: session.session_id,
    prescription_hash: canonicalHash(prescription(session)), dose: canonicalRunDose(session, { allowEffortOnly: source.allow_effort_only === true }) }));
  if (allocations.some(entry => !entry.dose)) throw new Error('Complete canonical running dose is required for the new source pool');
  const sourceHash = canonicalHash(source);
  const pool = { policy_version: VERSION, primary_basis: 'ACTIVE_DURATION', source_hash: sourceHash, allocations };
  return sessions.map(session => {
    const index = eligible.indexOf(session);
    if (index < 0) return session;
    const clone = JSON.parse(JSON.stringify(session));
    delete clone.content_hash;
    delete clone.canonical_workout_schema_version;
    clone.running_dose_accounting_version = VERSION;
    clone.running_dose = { reference_id: REFERENCE.id, reference_hash: REFERENCE_HASH,
      source, source_hash: sourceHash, actual_dose: allocations[index].dose,
      canonical_prescription_hash: allocations[index].prescription_hash,
      prescription_id: session.session_id, pool, pool_hash: canonicalHash(pool), partition_index: index,
      partition_count: eligible.length };
    return require('./canonicalWorkout').buildCanonicalSession(clone);
  });
}

function validateRunningDosePools(sessions) {
  const groups = new Map();
  for (const session of sessions.filter(entry => FAMILIES.has(entry.workout_family))) {
    const receipt = session.running_dose;
    if (!receipt || !runningPrescribedDose(session, [2,2,1,0,0,1,1,0]).valid) return false;
    const members = groups.get(receipt.pool_hash) || []; members.push(session); groups.set(receipt.pool_hash, members);
  }
  return [...groups.values()].every(members => {
    const receipt = members[0].running_dose;
    return members.length === receipt.pool.allocations.length
      && new Set(members.map(session => session.running_dose.partition_index)).size === members.length;
  });
}

function attachRunningDose(session, source) {
  if (!source || !FAMILIES.has(session.workout_family)) return session;
  return bindRunningDosePool([session], source)[0];
}

module.exports = { VERSION, REFERENCE, REFERENCE_HASH, FAMILIES, canonicalRunDose, runningPrescribedDose,
  attachRunningDose, bindRunningDosePool, validateRunningDosePools };
