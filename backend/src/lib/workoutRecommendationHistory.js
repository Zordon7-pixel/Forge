const LOWER_BODY_MARKER = /(leg|lower|glute|quad|hamstring|calf|hip)/i;
const REPEAT_EXCLUSION_WINDOW_MS = 72 * 60 * 60 * 1000;
const SPECIALIZED_EQUIPMENT_MARKERS = Object.freeze([
  ['dumbbell', /\bdumbbell\b/i],
  ['barbell', /\b(?:barbell|trap bar)\b/i],
  ['kettlebell', /\bkettlebell\b/i],
  ['cable', /\b(?:cable|pulldown|pressdown|pallof)\b/i],
  ['machine', /\bmachine\b/i],
  ['landmine', /\blandmine\b/i],
  ['band', /\b(?:band|bands|banded)\b/i],
  ['sled', /\bsled\b/i],
  ['suspension trainer', /\b(?:trx|suspension)\b/i],
  ['medicine ball', /\b(?:medicine|med) ball\b/i],
]);
const COMMON_GYM_FIXTURE_MARKERS = Object.freeze([
  ['bench', /\b(?:bench|chest-supported)\b/i],
  ['box', /\bbox\b/i],
  ['pull-up bar', /\b(?:pull[ -]?up|chin[ -]?up|hanging)\b/i],
]);
const GYM_PROFILE_SIGNALS = Object.freeze(['barbell', 'dumbbell', 'kettlebell', 'cable', 'machine']);

function cleanText(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function normalizeExerciseName(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function exerciseItems(workout = {}) {
  if (Array.isArray(workout.main)) return workout.main;
  if (Array.isArray(workout.exercises)) return workout.exercises;
  return [];
}

function exerciseName(item) {
  return typeof item === 'string'
    ? cleanText(item)
    : cleanText(item?.name || item?.exercise_name || item?.exercise);
}

function workoutFingerprint(workout) {
  const names = [...new Set(exerciseItems(workout).map(exerciseName).map(normalizeExerciseName).filter(Boolean))];
  return names.sort().join('|');
}

function sameSubstantiveWorkout(left, right) {
  const leftFingerprint = workoutFingerprint(left);
  const rightFingerprint = workoutFingerprint(right);
  return Boolean(leftFingerprint && rightFingerprint && leftFingerprint === rightFingerprint);
}

function muscleGroupsFromValue(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '')
      .replace(/^\s*\[/, '')
      .replace(/\]\s*$/, '')
      .split(',')
      .map((item) => item.replace(/^\s*["']|["']\s*$/g, ''));
  return [...new Set(values.map((item) => cleanText(item).toLowerCase()).filter(Boolean))];
}

function buildCompletedWorkoutHistory(sessions = [], sets = []) {
  const setsBySession = new Map();
  for (const set of Array.isArray(sets) ? sets : []) {
    const sessionId = cleanText(set?.session_id);
    const name = exerciseName(set);
    if (!sessionId || !name) continue;
    const sessionSets = setsBySession.get(sessionId) || [];
    sessionSets.push(set);
    setsBySession.set(sessionId, sessionSets);
  }

  return (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session?.id && session?.ended_at)
    .slice(0, 8)
    .map((session) => {
      const sessionSets = setsBySession.get(String(session.id)) || [];
      const exercisesByName = new Map();
      for (const set of sessionSets) {
        const name = exerciseName(set);
        const key = normalizeExerciseName(name);
        if (!key) continue;
        const existing = exercisesByName.get(key) || {
          name,
          muscleGroup: cleanText(set.muscle_group) || null,
          sets: [],
        };
        existing.sets.push({
          setNumber: Number(set.set_number || existing.sets.length + 1),
          reps: Number(set.reps || 0) || null,
          weightLbs: Number(set.weight_lbs || 0) || null,
        });
        exercisesByName.set(key, existing);
      }
      const exercises = [...exercisesByName.values()];
      const muscleGroups = [...new Set([
        ...muscleGroupsFromValue(session.muscle_groups),
        ...exercises.map((exercise) => cleanText(exercise.muscleGroup).toLowerCase()).filter(Boolean),
      ])];
      return {
        id: String(session.id),
        startedAt: session.started_at || null,
        endedAt: session.ended_at || null,
        durationSeconds: Number(session.total_seconds || 0) || null,
        muscleGroups,
        exercises,
      };
    });
}

function movement(name, focus, cue, sets = 3, reps = '8', rest = '75s') {
  return { name, sets, reps, rest, focus, cue };
}

// Last-resort choices are deliberately bodyweight-only and low-fatigue. The
// route first prefers extra model candidates, which retain profile/injury and
// equipment personalization; these exist only when every personalized choice
// is an exact immediate-recovery repeat.
const SAFE_BODYWEIGHT_ALTERNATIVES = Object.freeze([
  {
    workoutName: 'Bodyweight Trunk and Shoulder Control',
    target: 'Core and Upper Body Stability',
    runCompatible: true,
    warmup: ['Crocodile breathing x 5 slow breaths', 'Open-book rotation x 6/side', 'Wall slide x 8'],
    main: [
      movement('Dead Bug', 'Trunk control', 'Keep the low back gently anchored as opposite limbs extend.', 3, '6/side', '45s'),
      movement('Bird Dog', 'Cross-body stability', 'Reach long without shifting the pelvis.', 3, '6/side', '45s'),
      movement('Side Plank', 'Lateral trunk', 'Keep the head, ribs, and hips stacked.', 3, '20-30s/side', '45s'),
      movement('Scapular Push-Up', 'Shoulder control', 'Keep the elbows straight and move only the shoulder blades.', 3, '8', '45s'),
      movement('Prone Y Raise', 'Scapular control', 'Lift through the shoulder blades without arching the low back.', 3, '8', '45s'),
      movement('Bear Plank Shoulder Tap', 'Anti-rotation', 'Keep the hips quiet as each hand lifts.', 3, '6/side', '45s'),
    ],
    recovery: ['Easy walk x 3 min', 'Child’s pose breathing x 5 slow breaths'],
    explanation: 'This minimal-equipment control session avoids an immediate exact repeat without adding lower-body fatigue.',
    restExplanation: 'Keep the rests easy and prioritize controlled positions over fatigue.',
  },
  {
    workoutName: 'Bodyweight Posture and Trunk Session',
    target: 'Core and Postural Control',
    runCompatible: true,
    warmup: ['Cat-cow x 6', 'Half-kneeling thoracic rotation x 6/side', 'Shoulder circle x 8/side'],
    main: [
      movement('Hollow Body Hold', 'Anterior trunk', 'Use a bent-knee position if the low back lifts.', 3, '20s', '45s'),
      movement('Quadruped Shoulder Tap', 'Anti-rotation', 'Press the floor away and keep the pelvis level.', 3, '6/side', '45s'),
      movement('Forearm Side Plank', 'Lateral trunk', 'Stack the ribs and hips without shrugging.', 3, '20s/side', '45s'),
      movement('Wall Slide', 'Shoulder mobility', 'Keep the ribs down as the arms travel upward.', 3, '8', '45s'),
      movement('Prone W Raise', 'Upper-back control', 'Draw the shoulder blades down and back gently.', 3, '8', '45s'),
      movement('Dead Bug Heel Tap', 'Trunk control', 'Move slowly without letting the low back arch.', 3, '8/side', '45s'),
    ],
    recovery: ['Easy walk x 3 min', 'Open-book rotation x 5/side'],
    explanation: 'This bodyweight session changes the exercise lineup while preserving recovery for scheduled running.',
    restExplanation: 'Stop each set while positions remain crisp; this is not a fatigue test.',
  },
]);

function cloneRecommendation(recommendation) {
  return {
    ...recommendation,
    warmup: [...(recommendation.warmup || [])],
    main: (recommendation.main || []).map((item) => ({ ...item })),
    recovery: [...(recommendation.recovery || [])],
  };
}

function workoutCompletedAt(workout) {
  const value = workout?.endedAt || workout?.ended_at || workout?.startedAt || workout?.started_at;
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function workoutsWithinRecoveryWindow(history, now = new Date()) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return [];
  return (Array.isArray(history) ? history : []).filter((workout) => {
    const completedAt = workoutCompletedAt(workout);
    if (completedAt === null) return false;
    const ageMs = nowMs - completedAt;
    return ageMs >= 0 && ageMs <= REPEAT_EXCLUSION_WINDOW_MS;
  });
}

function distinctFromHistory(candidate, history) {
  return !(history || []).some((workout) => sameSubstantiveWorkout(candidate, workout));
}

function runCompatible(candidate) {
  if (candidate?.runCompatible === true) return true;
  return !LOWER_BODY_MARKER.test([
    candidate?.target,
    ...(Array.isArray(candidate?.muscleGroups) ? candidate.muscleGroups : []),
  ].filter(Boolean).join(' '));
}

function equipmentCompatible(candidate, availableEquipment) {
  const available = (Array.isArray(availableEquipment) ? availableEquipment : [])
    .map((item) => cleanText(item).toLowerCase())
    .filter(Boolean);
  if (available.some((item) => /^(?:all|all equipment|full gym|commercial gym)$/.test(item))) return true;
  const exerciseText = [
    ...exerciseItems(candidate).map(exerciseName),
    ...(Array.isArray(candidate?.warmup) ? candidate.warmup.map(cleanText) : []),
  ].join(' ');
  const explicitlyAvailable = ([equipment, marker]) => available.some((item) => (
    marker.test(item) || item.includes(equipment)
  ));
  const supportsSpecializedEquipment = SPECIALIZED_EQUIPMENT_MARKERS.every((equipmentMarker) => (
    !equipmentMarker[1].test(exerciseText) || explicitlyAvailable(equipmentMarker)
  ));
  if (!supportsSpecializedEquipment) return false;

  const gymProfileSignalCount = GYM_PROFILE_SIGNALS
    .filter((signal) => available.some((item) => item.includes(signal)))
    .length;
  const impliesCommonFixtures = available.some((item) => /\bgym\b/.test(item))
    || gymProfileSignalCount >= 2;
  return COMMON_GYM_FIXTURE_MARKERS.every((equipmentMarker) => (
    !equipmentMarker[1].test(exerciseText)
    || impliesCommonFixtures
    || explicitlyAvailable(equipmentMarker)
  ));
}

function selectDistinctRecommendation({
  recommendation,
  recommendations = null,
  recentCompletedWorkouts = [],
  todayRun = null,
  availableEquipment = null,
  now = new Date(),
} = {}) {
  const history = workoutsWithinRecoveryWindow(recentCompletedWorkouts, now);
  if (!recommendation || !history.some((workout) => sameSubstantiveWorkout(recommendation, workout))) {
    return recommendation;
  }

  const personalizedCandidates = (Array.isArray(recommendations) ? recommendations : [])
    .filter((candidate) => candidate && candidate !== recommendation);
  for (const candidate of personalizedCandidates) {
    if (
      (!todayRun || runCompatible(candidate))
      && equipmentCompatible(candidate, availableEquipment)
      && distinctFromHistory(candidate, history)
    ) return candidate;
  }

  for (const fallback of SAFE_BODYWEIGHT_ALTERNATIVES) {
    if (distinctFromHistory(fallback, history)) return cloneRecommendation(fallback);
  }
  return cloneRecommendation(SAFE_BODYWEIGHT_ALTERNATIVES[0]);
}

module.exports = {
  buildCompletedWorkoutHistory,
  normalizeExerciseName,
  sameSubstantiveWorkout,
  selectDistinctRecommendation,
  workoutsWithinRecoveryWindow,
  workoutFingerprint,
};
