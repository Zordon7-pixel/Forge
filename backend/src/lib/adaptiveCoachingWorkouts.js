const { buildCanonicalMaterialTarget } = require('./goalBackwardTargets');
const { canonicalStrengthExercise } = require('./strengthDoseAccounting');
const { isStrength } = require('./adaptiveCoachingSelection');

function buildAdaptiveWorkoutMaterial(entry, decision, planningInstant) {
  const id = entry.selection_id, family = entry.workout_family;
  const provenance = units => [{ source_evidence_ids: entry.dose_basis.source_evidence_ids,
    derived_athlete_state_field: entry.dose_basis.source_evidence_ids.length ? entry.dose_basis.authority : 'UNKNOWN_RAW_EVIDENCE_REFS_STATE_WEEKLY_AGGREGATE', policy_id: entry.dose_basis.policy_id,
    policy_version: 1, confidence: entry.dose_basis.source_evidence_ids.length ? 'MEDIUM' : 'LOW',
    derived_at: planningInstant, decision_id: decision.decision_id, canonical_units: units }];
  const target = (f, seconds, distance) => {
    // RPE is the conservative canonical resolver fallback. Requested goal pace
    // and unverified context zones are never fed into numerical target authority.
    const result = buildCanonicalMaterialTarget({ workout_family: f, duration_s: seconds,
      ...(distance !== null ? { distance_m: distance } : {}),
      decision_id: decision.decision_id, planning_instant: planningInstant,
      source_evidence_ids: entry.dose_basis.source_evidence_ids,
      derived_athlete_state_field: entry.dose_basis.source_evidence_ids.length ? entry.dose_basis.authority : 'UNKNOWN_RAW_EVIDENCE_REFS_STATE_WEEKLY_AGGREGATE' });
    if (!result.valid) throw new Error(`Adaptive target unavailable: ${f}`);
    return { target: result.target, provenance: result.provenance };
  };
  const steps = [];
  const add = (type, seconds, distance, f, work = false) => steps.push({
    step_id: `${id}-${steps.length + 1}`, type, order: steps.length + 1,
    ...target(f, seconds, distance), ...(work ? { step_role: 'WORK', workout_family: family } : {}),
  });
  if (isStrength(family)) {
    steps.push({ step_id: `${id}-warmup`, type: 'mobility', order: 1,
      target: { duration_s: 300, rpe_range: { minimum: 1, maximum: 2 } }, provenance: provenance(['s', 'rpe']) });
    for (const exercise of entry.exercises) {
      const canonical = canonicalStrengthExercise(exercise);
      // Explicit three-second repetition tempo and between-set rest budget.
      // This is a scheduled duration, not an assertion about observed lift time.
      const t = canonical.target;
      steps.push({ step_id: `${id}-exercise-${steps.length}`, type: 'strength_exercise', order: steps.length + 1,
        exercise_id: canonical.exercise_id, workout_family: family, step_role: 'WORK',
        target: { ...t, duration_s: t.sets * t.repetitions * 3 + (t.sets - 1) * t.rest_s },
        provenance: provenance(['s', 'count', 'rpe', ...(t.load_kg === undefined ? [] : ['kg'])]) });
    }
    steps.push({ step_id: `${id}-cooldown`, type: 'mobility', order: steps.length + 1,
      target: { duration_s: 180, rpe_range: { minimum: 1, maximum: 2 } }, provenance: provenance(['s', 'rpe']) });
  } else {
    let remainingDistance = entry.distance_m;
    const apportioned = seconds => entry.distance_m === null ? null : Math.floor(entry.distance_m * seconds / entry.duration_s);
    const runStep = (type, seconds, f, work = false, final = false) => {
      const distance = final ? remainingDistance : apportioned(seconds);
      add(type, seconds, distance, f, work);
      if (distance !== null) remainingDistance -= distance;
    };
    if (entry.quality_work_s !== null) {
      runStep('warmup', 600, 'easy_run');
      // Same-family quality: two work bouts, one genuine recovery, and cooldown.
      // Recovery stays inside the 20-minute non-work budget.
      const first = Math.floor(entry.quality_work_s / 2);
      runStep('interval', first, family, true);
      runStep('recovery', 120, 'recovery_run');
      runStep('interval', entry.quality_work_s - first, family, true);
      runStep('cooldown', entry.duration_s - entry.quality_work_s - 720, 'easy_run', false, true);
    } else {
      runStep('warmup', 300, 'easy_run');
      runStep('run', entry.duration_s - 600, family, true);
      runStep('cooldown', 300, 'recovery_run', false, true);
    }
  }
  return { material_id: id, source_session: { id, workout_family: family,
    title: isStrength(family) ? 'Strength maintenance' : family === 'long_aerobic' ? 'Long aerobic run'
      : family === 'interval_run' ? 'Intervals' : family === 'threshold_run' ? 'Threshold intervals'
        : family === 'recovery_run' ? 'Recovery run' : family === 'race_rhythm_run' ? 'Race rhythm' : 'Aerobic run',
    purpose: 'Complete the adaptation selected from this week’s objectives.',
    ...(isStrength(family) ? { main: entry.exercises, exercises: entry.exercises } : {}),
    reason_codes: entry.reason_codes,
    adaptive_prescription: { version: 'adaptive-prescription-v1', steps,
      objective_ids: entry.objective_ids, progression_family: entry.progression_family, dose_basis: entry.dose_basis } } };
}
module.exports = { buildAdaptiveWorkoutMaterial };
