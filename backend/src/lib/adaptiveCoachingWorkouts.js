const { buildCanonicalMaterialTarget } = require('./goalBackwardTargets');
const { canonicalStrengthExercise } = require('./strengthDoseAccounting');
const { isStrength } = require('./adaptiveCoachingSelection');

function buildAdaptiveWorkoutMaterial(entry, decision, planningInstant) {
  const id = entry.selection_id, family = entry.workout_family;
  const provenance = units => [{ source_evidence_ids: entry.dose_basis.source_evidence_ids,
    derived_athlete_state_field: entry.dose_basis.source_evidence_ids.length ? entry.dose_basis.authority : 'UNKNOWN_RAW_EVIDENCE_REFS_STATE_WEEKLY_AGGREGATE', policy_id: entry.dose_basis.policy_id,
    policy_version: 1, confidence: entry.dose_basis.confidence ?? (entry.dose_basis.source_evidence_ids.length ? 'MEDIUM' : 'LOW'),
    derived_at: planningInstant, decision_id: decision.decision_id, canonical_units: units }];
  const target = (f, seconds, distance) => {
    // RPE is the conservative canonical resolver fallback. Requested goal pace
    // and unverified context zones are never fed into numerical target authority.
    const result = buildCanonicalMaterialTarget({ ...(f === family ? entry.target_inputs || {} : {}), workout_family: f, duration_s: seconds,
      ...(distance !== null ? { distance_m: distance } : {}),
      decision_id: decision.decision_id, planning_instant: planningInstant,
      source_evidence_ids: entry.dose_basis.source_evidence_ids,
      derived_athlete_state_field: entry.dose_basis.source_evidence_ids.length ? entry.dose_basis.authority : 'UNKNOWN_RAW_EVIDENCE_REFS_STATE_WEEKLY_AGGREGATE' });
    if (!result.valid) throw new Error(`Adaptive target unavailable: ${f}`);
    const resolved = { ...result.target };
    if (['easy_run', 'recovery_run', 'long_aerobic'].includes(f) && resolved.pace_range_s_per_km) {
      resolved.reference_pace_range_s_per_km = resolved.pace_range_s_per_km;
      delete resolved.pace_range_s_per_km;
      resolved.rpe_range = buildCanonicalMaterialTarget({ workout_family: f,
        decision_id: decision.decision_id, planning_instant: planningInstant }).target.rpe_range;
      return { target: resolved, provenance: [...result.provenance, ...provenance(['rpe'])] };
    }
    return { target: resolved, provenance: result.provenance };
  };
  const steps = [];
  const add = (type, seconds, distance, f, work = false) => steps.push({
    step_id: `${id}-${steps.length + 1}`, type, order: steps.length + 1,
    ...target(f, seconds, distance), ...(work ? { step_role: 'WORK', workout_family: family } : {}),
  });
  if (entry.canonical_steps) {
    const rebind = (list, prefix) => list.map((step, i) => ({ ...step, step_id: `${prefix}-${i + 1}`,
      provenance: step.provenance.map(p => ({ ...p, decision_id: decision.decision_id, derived_at: planningInstant })),
      ...(step.children ? { children: rebind(step.children, `${prefix}-${i + 1}`) } : {}) }));
    steps.push(...rebind(entry.canonical_steps, id));
  } else if (entry.completed_prescription_structure) {
    let allocatedDistance = 0;
    const rebuild = (list, prefix, multiplier = 1) => list.map((step, i) => {
      const stepId = `${prefix}-${i + 1}`;
      if (step.type === 'repeat') return { ...step, step_id: stepId, children: rebuild(step.children, stepId, multiplier * step.repeat_count) };
      const seconds = step.step_role === 'WORK' ? Math.floor(step.target.duration_s * entry.structure_work_scale) : step.target.duration_s;
      const f = step.step_role === 'WORK' ? family : step.type === 'recovery' ? 'recovery_run' : 'easy_run';
      const distance = entry.distance_m === null ? null : Math.floor(entry.distance_m * seconds / entry.duration_s);
      if (distance !== null) allocatedDistance += distance * multiplier;
      return { step_id: stepId, type: step.type, order: step.order, ...target(f, seconds, distance),
        ...(step.step_role === 'WORK' ? { step_role: 'WORK', workout_family: family } : {}) };
    });
    steps.push(...rebuild(entry.completed_prescription_structure, id));
    if (entry.distance_m !== null && allocatedDistance !== entry.distance_m) {
      const bookend = steps.find(s => s.type === 'warmup' || s.type === 'cooldown');
      if (!bookend) throw new Error('Timed structure requires a top-level warmup or cooldown for metric rounding');
      bookend.target.distance_m += entry.distance_m - allocatedDistance;
    }
  } else if (isStrength(family)) {
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
  return { material_id: id, source_session: { ...(entry.canonical_metadata || {}), id, workout_family: family,
    ...(entry.event_identity ? { event_identity: entry.event_identity } : {}),
    title: family === 'race' ? 'Race' : isStrength(family) ? 'Strength maintenance' : family === 'long_aerobic' ? 'Long aerobic run'
      : family === 'interval_run' ? 'Intervals' : family === 'threshold_run' ? 'Threshold intervals'
        : family === 'recovery_run' ? 'Recovery run' : family === 'race_rhythm_run' ? 'Race rhythm' : 'Aerobic run',
    purpose: 'Complete the adaptation selected from this week’s objectives.',
    ...(isStrength(family) ? { main: entry.exercises, exercises: entry.exercises } : {}),
    reason_codes: entry.reason_codes,
    adaptive_prescription: { version: 'adaptive-prescription-v1', steps,
      objective_ids: entry.objective_ids, progression_family: entry.progression_family, dose_basis: entry.dose_basis } } };
}
module.exports = { buildAdaptiveWorkoutMaterial };
