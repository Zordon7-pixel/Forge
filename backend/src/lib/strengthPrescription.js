const DEFAULT_EQUIPMENT = ['barbell', 'dumbbell', 'rack', 'bench'];

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeExerciseName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(db|dumbbell)\b/g, 'dumbbell')
    .replace(/\b(bb|barbell)\b/g, 'barbell')
    .replace(/\bone[- ]arm\b/g, 'single arm')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function summarizeRecentExercises(rows = []) {
  const ordered = [...rows].sort((left, right) => String(right.logged_at || '').localeCompare(String(left.logged_at || '')));
  const groups = new Map();
  for (const row of ordered) {
    const name = String(row.exercise_name || '').trim().slice(0, 80);
    const key = normalizeExerciseName(name);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        name,
        normalizedName: key,
        sets: 0,
        reps: 0,
        maxWeightLbs: 0,
        latestWeightLbs: null,
        latestReps: null,
        latestLoggedAt: null,
        estimatedOneRepMaxLbs: null,
      });
    }
    const summary = groups.get(key);
    const reps = numberOrNull(row.reps);
    const weight = numberOrNull(row.weight_lbs);
    summary.sets += 1;
    if (reps !== null && reps > 0 && reps <= 100) summary.reps += reps;
    if (weight !== null && weight > summary.maxWeightLbs) summary.maxWeightLbs = weight;
    if (summary.latestWeightLbs === null && weight !== null && weight > 0 && reps !== null && reps > 0) {
      summary.latestWeightLbs = weight;
      summary.latestReps = reps;
      summary.latestLoggedAt = row.logged_at || null;
      if (reps <= 12) summary.estimatedOneRepMaxLbs = weight * (1 + reps / 30);
    }
  }
  return [...groups.values()]
    .sort((left, right) => right.sets - left.sets || left.name.localeCompare(right.name))
    .slice(0, 24)
    .map((summary) => ({
      ...summary,
      maxWeightLbs: Math.round(summary.maxWeightLbs * 10) / 10,
      latestWeightLbs: summary.latestWeightLbs === null ? null : Math.round(summary.latestWeightLbs * 10) / 10,
      estimatedOneRepMaxLbs: summary.estimatedOneRepMaxLbs === null ? null : Math.round(summary.estimatedOneRepMaxLbs),
    }));
}

function normalizeEquipment(values) {
  const source = Array.isArray(values) && values.length ? values : DEFAULT_EQUIPMENT;
  return [...new Set(source.map((value) => String(value || '').toLowerCase().replace(/\s+/g, '_')).filter(Boolean))];
}

function hasEquipment(equipment, ...wanted) {
  return wanted.some((item) => equipment.includes(item));
}

function exerciseCatalog(focus, equipment) {
  const hasBarbell = hasEquipment(equipment, 'barbell') && hasEquipment(equipment, 'rack');
  const hasDumbbell = hasEquipment(equipment, 'dumbbell', 'dumbbells');
  const hasBench = hasEquipment(equipment, 'bench');
  const hasCable = hasEquipment(equipment, 'cable', 'cables');
  const hasMachines = hasEquipment(equipment, 'machine', 'machines');
  const hasBands = hasEquipment(equipment, 'resistance_bands', 'bands');

  if (/lower/i.test(String(focus || ''))) {
    return [
      hasBarbell
        ? { name: 'Barbell back squat', aliases: ['back squat', 'barbell squat'], role: 'primary', reps: '4-6', cue: 'Brace before descending and drive through the full foot.' }
        : hasDumbbell
          ? { name: 'Goblet squat', aliases: ['dumbbell goblet squat'], role: 'primary', reps: '6-8', cue: 'Keep the weight close and drive through the full foot.' }
          : hasMachines
            ? { name: 'Leg press', aliases: ['machine leg press'], role: 'primary', reps: '8-10', cue: 'Control the depth and keep the full foot planted.' }
            : { name: 'Tempo bodyweight squat', aliases: ['bodyweight squat'], role: 'primary', reps: '10-12', cue: 'Lower for three seconds and stand with control.' },
      hasBarbell
        ? { name: 'Romanian deadlift', aliases: ['barbell romanian deadlift', 'rdl'], role: 'primary', reps: '6-8', cue: 'Push the hips back while keeping the bar close.' }
        : hasDumbbell
          ? { name: 'Dumbbell Romanian deadlift', aliases: ['dumbbell rdl'], role: 'primary', reps: '6-8', cue: 'Push the hips back while keeping the dumbbells close.' }
          : hasBands
            ? { name: 'Banded good morning', aliases: ['good morning'], role: 'primary', reps: '10-12', cue: 'Keep the spine neutral and hinge from the hips.' }
            : { name: 'Single-leg hip bridge', aliases: ['hip bridge', 'glute bridge'], role: 'primary', reps: '8 each side', cue: 'Keep the pelvis level and finish through the glute.' },
      { name: hasDumbbell ? 'Rear-foot elevated split squat' : 'Split squat', aliases: ['bulgarian split squat', 'rear foot elevated split squat', 'split squat'], role: 'accessory', reps: '8 each side', cue: 'Keep the front knee tracking over the toes.' },
      { name: 'Standing calf raise', aliases: ['calf raise'], role: 'accessory', reps: '10-12', cue: 'Pause at the top and lower through full range.' },
    ];
  }

  return [
    hasDumbbell && hasBench
      ? { name: 'Dumbbell bench press', aliases: ['dumbbell chest press', 'dumbbell flat bench press'], role: 'primary', reps: '6-8', cue: 'Keep the shoulder blades set on the bench.' }
      : hasBarbell && hasBench
        ? { name: 'Barbell bench press', aliases: ['bench press'], role: 'primary', reps: '4-6', cue: 'Keep the shoulder blades set and feet planted.' }
        : hasMachines
          ? { name: 'Machine chest press', aliases: ['chest press'], role: 'primary', reps: '8-10', cue: 'Keep the shoulders down and control the return.' }
          : { name: 'Push-up', aliases: ['push up'], role: 'primary', reps: '8-15', cue: 'Keep a straight line from shoulders through heels.' },
    hasDumbbell
      ? { name: 'One-arm dumbbell row', aliases: ['single arm dumbbell row', 'dumbbell row'], role: 'primary', reps: '8 each side', cue: 'Drive the elbow toward the hip without twisting.' }
      : hasCable
        ? { name: 'Seated cable row', aliases: ['cable row'], role: 'primary', reps: '8-10', cue: 'Pull the elbows back without shrugging.' }
        : hasMachines
          ? { name: 'Machine row', aliases: ['seated row'], role: 'primary', reps: '8-10', cue: 'Keep the chest set and control the return.' }
          : { name: hasBands ? 'Resistance-band row' : 'Inverted row', aliases: ['band row', 'inverted row'], role: 'primary', reps: '8-12', cue: 'Keep the torso rigid and pull without shrugging.' },
    hasDumbbell
      ? { name: 'Standing dumbbell overhead press', aliases: ['dumbbell overhead press', 'dumbbell shoulder press'], role: 'accessory', reps: '6-8', cue: 'Stack ribs over hips and finish overhead.' }
      : hasBarbell
        ? { name: 'Standing overhead press', aliases: ['barbell overhead press', 'military press'], role: 'accessory', reps: '6-8', cue: 'Stack ribs over hips and finish overhead.' }
        : { name: hasBands ? 'Resistance-band overhead press' : 'Pike push-up', aliases: ['band overhead press', 'pike push up'], role: 'accessory', reps: '8-10', cue: 'Keep the ribs stacked and finish with control.' },
    hasCable || hasMachines
      ? { name: 'Lat pulldown', aliases: ['pull down', 'pulldown'], role: 'accessory', reps: '6-10', cue: 'Pull the elbows down without shrugging.' }
      : hasBands
        ? { name: 'Resistance-band pulldown', aliases: ['band pulldown', 'band pull down'], role: 'accessory', reps: '10-12', cue: 'Pull the elbows down without shrugging.' }
        : { name: 'Pull-up', aliases: ['pull up', 'chin up'], role: 'accessory', reps: '4-8', cue: 'Pull the elbows down without shrugging.' },
  ];
}

function findExerciseHistory(exercise, history = []) {
  const names = [exercise.name, ...(exercise.aliases || [])].map(normalizeExerciseName).filter(Boolean);
  return history.find((item) => {
    const candidate = normalizeExerciseName(item.normalizedName || item.name);
    return names.some((name) => candidate === name || (name.length >= 8 && candidate.includes(name)) || (candidate.length >= 8 && name.includes(candidate)));
  }) || null;
}

function formatWeight(value) {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight <= 0) return null;
  return Number.isInteger(weight) ? String(weight) : weight.toFixed(1);
}

function targetRepCount(value) {
  const match = String(value || '').match(/\d+/);
  const reps = match ? Number(match[0]) : null;
  return Number.isFinite(reps) && reps >= 1 && reps <= 20 ? reps : null;
}

function roundedTrainingLoad(exercise, history, effort) {
  const targetReps = targetRepCount(exercise.reps);
  const estimatedMax = Number(history?.estimatedOneRepMaxLbs);
  if (targetReps && Number.isFinite(estimatedMax) && estimatedMax > 0) {
    const effortFactor = effort.reduceSets ? 0.86 : 0.92;
    const unrounded = (estimatedMax / (1 + targetReps / 30)) * effortFactor;
    const increment = /dumbbell|single|split|raise/i.test(exercise.name) ? 2.5 : 5;
    return Math.max(increment, Math.floor(unrounded / increment) * increment);
  }
  const recentWeight = Number(history?.latestWeightLbs);
  const recentReps = Number(history?.latestReps);
  if (targetReps && Number.isFinite(recentWeight) && recentWeight > 0 && Number.isFinite(recentReps) && Math.abs(recentReps - targetReps) <= 2) {
    return recentWeight * (effort.reduceSets ? 0.9 : 1);
  }
  return null;
}

function effortTarget(recoveryState, weekNumber) {
  const state = String(recoveryState || 'unknown').toLowerCase();
  if (weekNumber === 1 && ['low', 'recovery'].includes(state)) return { rpe: '6-7', rir: '3-4 RIR', reduceSets: true };
  if (weekNumber === 1 && state === 'caution') return { rpe: '7', rir: '3 RIR', reduceSets: true };
  return { rpe: '7-8', rir: '2-3 RIR', reduceSets: false };
}

function personalizeExercise(exercise, options = {}) {
  const history = findExerciseHistory(exercise, options.recentExercises || []);
  const effort = options.effort || effortTarget(options.recoveryState, options.weekNumber);
  const trainingWeight = formatWeight(roundedTrainingLoad(exercise, history, effort));
  const load = trainingWeight
    ? `${trainingWeight} lb starting load`
    : `Choose a load that leaves ${effort.rir}`;
  const loadSource = trainingWeight
    ? `Conservative estimate from a recent ${formatWeight(history.latestWeightLbs)} lb x ${Math.max(1, Number(history.latestReps || 0))} set${history.latestLoggedAt ? ` (${String(history.latestLoggedAt).slice(0, 10)})` : ''}`
    : 'Effort calibrated; no matching logged set';
  const increment = /dumbbell|single|split|calf|raise|pull-up|push-up/i.test(exercise.name) ? '2.5-5 lb or one rep' : '5 lb or one rep';
  return {
    ...exercise,
    load,
    loadSource,
    rpe: `${effort.rpe} (${effort.rir})`,
    progression: trainingWeight
      ? `Repeat ${trainingWeight} lb until every set stays at ${effort.rpe} RPE or easier, then add ${increment}.`
      : `Log the completed load. Add ${increment} only after every set stays at ${effort.rpe} RPE or easier.`,
  };
}

function prescriptionBasis(options = {}, exercises = []) {
  const recovery = options.recovery || {};
  const matchedLoads = exercises.filter((exercise) => /recent .* set/i.test(String(exercise.loadSource || ''))).length;
  return {
    athlete: matchedLoads
      ? `${matchedLoads} exercise load${matchedLoads === 1 ? '' : 's'} anchored to recent logged sets`
      : 'Loads use RPE/RIR until matching lift sets are logged',
    recovery: recovery.available
      ? 'Apple Health recovery checked for first-week volume and effort'
      : options.checkin
        ? 'Daily check-in used for first-week volume and effort'
        : 'Current recovery state used for first-week volume and effort',
    program: `${String(options.phase || 'base')} phase; ${options.mode === 'hybrid_build' ? 'build strength/size' : 'maintain strength'}`,
    evidence: 'Evidence-informed sets, reps, and rest intervals',
    watchDataRole: 'Watch data adjusts workload and recovery; it does not estimate lifting loads',
  };
}

function buildStrengthExercises(options = {}) {
  const equipment = normalizeEquipment(options.equipment);
  const templates = exerciseCatalog(options.focus, equipment);
  const build = options.mode === 'hybrid_build';
  const taper = options.phase === 'taper' || options.phase === 'race';
  const effort = effortTarget(options.recovery?.state, options.weekNumber);
  const selected = templates.slice(0, taper ? 2 : build ? 4 : 3);
  return selected.map((template) => {
    const baseSets = taper ? 2 : template.role === 'primary' ? (build ? 4 : 3) : (build ? 3 : 2);
    const sets = effort.reduceSets ? Math.max(2, baseSets - 1) : baseSets;
    const rest = template.role === 'primary' ? '2-3 min' : '60-90 sec';
    const personalized = personalizeExercise({ ...template, sets, rest, recoveryAdjusted: effort.reduceSets }, {
      recentExercises: options.history?.recentExercises,
      recoveryState: options.recovery?.state,
      weekNumber: options.weekNumber,
      effort,
    });
    const { aliases, role, ...prescription } = personalized;
    return prescription;
  });
}

function applyStrengthPrescriptionData(plan, context = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.weeks)) return plan;
  const next = JSON.parse(JSON.stringify(plan));
  for (const week of next.weeks) {
    for (const day of week.days || []) {
      for (const session of day.sessions || []) {
        if (session.kind !== 'lift') continue;
        const exercises = Array.isArray(session.main) ? session.main : Array.isArray(session.exercises) ? session.exercises : [];
        const effort = effortTarget(context.recovery?.state, Number(week.week || 1));
        const personalized = exercises.map((exercise) => {
          const parsedSets = Number(exercise.sets);
          const sets = effort.reduceSets && !exercise.recoveryAdjusted && Number.isInteger(parsedSets) && parsedSets >= 2
            ? Math.max(2, parsedSets - 1)
            : exercise.sets;
          return personalizeExercise({ ...exercise, sets, aliases: [], recoveryAdjusted: Boolean(exercise.recoveryAdjusted || effort.reduceSets) }, {
            recentExercises: context.history?.recentExercises,
            recoveryState: context.recovery?.state,
            weekNumber: Number(week.week || 1),
            effort,
          });
        });
        if (Array.isArray(session.main)) session.main = personalized;
        else session.exercises = personalized;
        session.prescriptionBasis = prescriptionBasis({
          phase: week.phase,
          mode: next.planMode,
          recovery: context.recovery,
          checkin: context.checkin,
        }, personalized);
      }
    }
  }
  return next;
}

module.exports = {
  applyStrengthPrescriptionData,
  buildStrengthExercises,
  normalizeExerciseName,
  prescriptionBasis,
  summarizeRecentExercises,
};
