// Engineering accounting contract, not an injury-risk model. Reference: the
// existing hybrid_maintain constructor's 3+3+2 working sets at RPE 7–8.
// Neither the candidate nor its display adapters can change this denominator.
const VERSION = 'strength-prescribed-dose-v2';
const REFERENCE = Object.freeze({ id: 'hybrid-maintain-eight-working-sets-rpe8-v1', sets: 8, maximumRpe: 8 });
const KNOWN_EXERCISES = Object.freeze({
  'Dumbbell bench press': ['upper', 6], 'Barbell bench press': ['upper', 4],
  'Machine chest press': ['upper', 8], 'Push-up': ['upper', 8],
  'One-arm dumbbell row': ['upper', 16], 'Seated cable row': ['upper', 8],
  'Machine row': ['upper', 8], 'Resistance-band row': ['upper', 8], 'Inverted row': ['upper', 8],
  'Standing dumbbell overhead press': ['upper', 6], 'Standing overhead press': ['upper', 6],
  'Resistance-band overhead press': ['upper', 8], 'Pike push-up': ['upper', 8],
  'Lat pulldown': ['upper', 6], 'Resistance-band pulldown': ['upper', 10], 'Pull-up': ['upper', 4],
  'Barbell back squat': ['lower', 4], 'Goblet squat': ['lower', 6], 'Leg press': ['lower', 8],
  'Tempo bodyweight squat': ['lower', 10], 'Romanian deadlift': ['lower', 6],
  'Dumbbell Romanian deadlift': ['lower', 6], 'Banded good morning': ['lower', 10],
  'Single-leg hip bridge': ['lower', 16], 'Rear-foot elevated split squat': ['lower', 16],
  'Split squat': ['lower', 16], 'Standing calf raise': ['lower', 10],
});
const EXERCISES_BY_ID = Object.freeze(Object.fromEntries(Object.entries(KNOWN_EXERCISES).map(([name, reference]) => [
  `strength-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, Object.freeze({ name, region: reference[0], repetitions: reference[1] }),
])));

function canonicalStrengthExercise(exercise) {
  const id = `strength-${String(exercise.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const known = EXERCISES_BY_ID[id];
  const reps = String(exercise.reps || '').match(/^(\d+)(?:\s*[-–]\s*\d+)?( each side)?$/);
  const effort = String(exercise.rpe || '').match(/^(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?/);
  const rest = String(exercise.rest || '').match(/^(\d+)(?:\s*[-–]\s*(\d+))?\s*(min|sec)/i);
  if (!known || !Number.isInteger(exercise.sets) || exercise.sets < 1 || !reps || !effort || !rest) throw new Error('Canonical strength source prescription is incomplete or unrecognized');
  const target = { sets: exercise.sets, repetitions: Number(reps[1]) * (reps[2] ? 2 : 1),
    rest_s: Number(rest[2] || rest[1]) * (rest[3].toLowerCase() === 'min' ? 60 : 1),
    rpe_range: { minimum: Number(effort[1]), maximum: Number(effort[2] || effort[1]) } };
  const knownLoad = String(exercise.load || '').match(/^(\d+(?:\.\d+)?) (lb|kg) starting load$/);
  if (knownLoad && String(exercise.loadSource || '').startsWith('Conservative estimate from a recent ')) {
    const kilograms = Number(knownLoad[1]) * (knownLoad[2] === 'lb' ? 0.45359237 : 1);
    if (!Number.isFinite(kilograms) || kilograms <= 0) throw new Error('Known strength load must be positive and finite');
    target.load_kg = Math.round(kilograms * 10) / 10;
  }
  return { exercise_id: id, region: known.region, target };
}

function strengthPrescribedDose(session, familyVector) {
  const fallback = { valid: !session?.canonical_workout_schema_version,
    version: VERSION, reference_id: REFERENCE.id, state: session?.canonical_workout_schema_version
      ? 'INVALID_OR_UNCOMPARABLE_CANONICAL_DOSE' : 'CONSERVATIVE_FAMILY_DEFAULT',
    vector: familyVector && [...familyVector] };
  if (!String(session?.workout_family).startsWith('strength_')) return { ...fallback, valid: true, state: 'FAMILY_REFERENCE' };
  if (!familyVector) return { ...fallback, valid: false };
  if (session.strength_dose_accounting_version !== VERSION) {
    const canonicalV2Ids = session.canonical_workout_schema_version && (session.steps || []).some(step => String(step.exercise_id).startsWith('strength-'));
    return canonicalV2Ids ? { ...fallback, valid: false, state: 'CANONICAL_DOSE_VERSION_MISSING_OR_INVALID' }
      : { ...fallback, valid: true, state: 'LEGACY_FAMILY_REFERENCE' };
  }
  if (session.canonical_workout_schema_version && (!session.content_hash
    || require('./canonicalWorkout').canonicalWorkoutHash(session) !== session.content_hash)) return fallback;
  // Only canonical, content-hashed execution targets are authoritative.
  const steps = session.steps;
  if (!Array.isArray(steps) || !steps.length) return fallback;
  if (session.strength_distribution && !require('./distributedStrength').validateDistributedSession(session, null)) return fallback;
  const expectedRegion = session.workout_family === 'strength_upper' ? 'upper'
    : session.workout_family === 'strength_lower' ? 'lower' : null;
  if (!expectedRegion) return fallback;
  let equivalentSets = 0;
  for (const step of steps) {
    const target = step?.target;
    const reference = EXERCISES_BY_ID[step?.exercise_id];
    if (step?.type !== 'strength_exercise' || step.step_role !== 'WORK' || !reference || reference.region !== expectedRegion
      || !Number.isInteger(target?.sets) || target.sets < 1
      || !Number.isInteger(target.repetitions) || target.repetitions < 1
      || !Number.isFinite(target.rest_s) || target.rest_s <= 0
      || !Number.isFinite(target.rpe_range?.minimum) || !Number.isFinite(target.rpe_range?.maximum)
      || target.rpe_range.minimum < 1 || target.rpe_range.maximum > 10 || target.rpe_range.maximum < target.rpe_range.minimum
      || (target.load_kg !== undefined && (!Number.isFinite(target.load_kg) || target.load_kg < 0))) return fallback;
    // Absolute kg is not comparable across exercises/athletes without a measured
    // capacity denominator. Effort is explicit; kg changes cannot lower stress.
    equivalentSets += target.sets * Math.max(1, target.repetitions / reference.repetitions)
      * Math.max(1, target.rpe_range.maximum / REFERENCE.maximumRpe);
  }
  const factor = equivalentSets / REFERENCE.sets;
  return { valid: true, version: VERSION, reference_id: REFERENCE.id, state: 'KNOWN_PRESCRIPTION',
    equivalent_working_sets: equivalentSets,
    vector: familyVector.map((value) => Math.ceil(value * factor * 1000000) / 1000000) };
}

function sourceStrengthDose(session, siblings = []) {
  const family = session?.focus === 'Lower body' ? 'strength_lower' : session?.focus === 'Upper body' ? 'strength_upper' : 'strength_full_body';
  const vector = require('./goalBackwardLoad').resolveStressVector(family);
  const conservative = { valid: false, vector };
  if (!session.strength_distribution || !require('./distributedStrength').validateDistributedSession(session, siblings, { source: true })) return conservative;
  try {
    const steps = session.main.map(exercise => ({ ...canonicalStrengthExercise(exercise), type: 'strength_exercise', step_role: 'WORK' }));
    return strengthPrescribedDose({ workout_family: family, strength_dose_accounting_version: VERSION, steps }, vector);
  } catch { return conservative; }
}

module.exports = { VERSION, REFERENCE, strengthPrescribedDose, sourceStrengthDose, canonicalStrengthExercise, EXERCISES_BY_ID };
