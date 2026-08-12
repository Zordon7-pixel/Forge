const LOWER_BODY_MARKER = /(leg|lower|glute|quad|hamstring|calf|hip)/i;

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

const ALTERNATIVES = Object.freeze([
  {
    workoutName: 'Upper Pull and Trunk Strength',
    target: 'Back, Arms, and Core',
    muscleGroups: ['back', 'arms', 'core'],
    runCompatible: true,
    warmup: ['Band pull-apart x 15', 'Half-kneeling thoracic rotation x 6/side', 'Scapular pull-up x 8'],
    main: [
      movement('Chest-Supported Dumbbell Row', 'Upper-back strength', 'Keep the chest supported and finish with the shoulder blades.'),
      movement('Neutral-Grip Lat Pulldown', 'Vertical pull', 'Drive the elbows toward the ribs without leaning back.'),
      movement('Half-Kneeling Single-Arm Cable Row', 'Trunk-controlled pull', 'Stay tall and resist rotation.', 3, '8/side'),
      movement('Hammer Curl', 'Arm strength', 'Keep the elbows quiet and lower under control.', 3, '10'),
      movement('Pallof Press', 'Anti-rotation', 'Keep ribs stacked and do not let the cable turn you.', 3, '10/side', '45s'),
      movement('Dead Bug', 'Trunk stability', 'Keep the low back gently anchored as the limbs move.', 3, '6/side', '45s'),
    ],
    recovery: ['Easy walk x 3 min', 'Lat stretch x 45s/side'],
    explanation: 'This upper-body and trunk session avoids duplicating the recent lift and leaves the legs available for today’s run.',
    restExplanation: 'Use full rest on rows and pulldowns, then shorter rests for the arm and trunk work.',
  },
  {
    workoutName: 'Upper Push and Trunk Strength',
    target: 'Chest, Shoulders, and Core',
    muscleGroups: ['chest', 'shoulders', 'arms', 'core'],
    runCompatible: true,
    warmup: ['Wall slide x 10', 'Band external rotation x 10/side', 'Incline push-up x 8'],
    main: [
      movement('Incline Dumbbell Press', 'Upper-body strength', 'Keep the shoulder blades set and press without shrugging.'),
      movement('Half-Kneeling Landmine Press', 'Shoulder strength', 'Stay tall and finish each press without rotating.', 3, '8/side'),
      movement('Push-Up', 'Horizontal push', 'Move the torso as one unit and stop before the hips sag.', 3, '8-12'),
      movement('Cable Triceps Pressdown', 'Arm strength', 'Keep the elbows pinned and control the return.', 3, '10'),
      movement('Side Plank', 'Lateral trunk', 'Stack the ribs and hips in one line.', 3, '30s/side', '45s'),
      movement('Dead Bug', 'Trunk stability', 'Exhale as the opposite arm and leg extend.', 3, '6/side', '45s'),
    ],
    recovery: ['Easy walk x 3 min', 'Doorway chest stretch x 45s/side'],
    explanation: 'This push-and-trunk session changes the recent training stimulus while preserving the lower body for the scheduled run.',
    restExplanation: 'Take enough rest to keep pressing mechanics clean, then move steadily through trunk work.',
  },
  {
    workoutName: 'Low-Fatigue Stability Session',
    target: 'Core and Stability',
    muscleGroups: ['core'],
    runCompatible: true,
    warmup: ['Cat-cow x 6', 'Open-book rotation x 6/side', 'Marching glute bridge x 6/side'],
    main: [
      movement('Bird Dog', 'Cross-body stability', 'Reach long without shifting the pelvis.', 3, '6/side', '45s'),
      movement('Side Plank', 'Lateral trunk', 'Keep the head, ribs, and hips stacked.', 3, '30s/side', '45s'),
      movement('Tall-Kneeling Pallof Press', 'Anti-rotation', 'Squeeze the glutes and resist cable rotation.', 3, '10/side', '45s'),
      movement('Bear Plank Shoulder Tap', 'Anterior trunk', 'Minimize hip movement as each hand lifts.', 3, '6/side', '45s'),
      movement('Suitcase Carry', 'Loaded trunk stability', 'Walk tall without leaning toward the weight.', 3, '30s/side', '60s'),
      movement('Prone Y Raise', 'Scapular control', 'Lift with the shoulder blades, not the low back.', 3, '8', '45s'),
    ],
    recovery: ['Crocodile breathing x 5 slow breaths', 'Child’s pose x 45s'],
    explanation: 'This low-fatigue stability session supplies a distinct stimulus without repeating yesterday’s work or competing with today’s run.',
    restExplanation: 'Keep rests short but never rush the positions; clean control is the training goal.',
  },
  {
    workoutName: 'Posterior Chain Strength',
    target: 'Back, Legs, and Core',
    muscleGroups: ['back', 'legs', 'core'],
    runCompatible: false,
    warmup: ['Hip hinge drill x 10', 'Glute bridge x 10', 'Bodyweight reverse lunge x 6/side'],
    main: [
      movement('Romanian Deadlift', 'Posterior-chain strength', 'Push the hips back and keep the load close.', 4, '6', '2 min'),
      movement('Rear-Foot-Elevated Split Squat', 'Single-leg strength', 'Stay balanced through the whole front foot.', 3, '6/side', '90s'),
      movement('Chest-Supported Row', 'Upper-back strength', 'Pause briefly with the shoulder blades together.'),
      movement('Hamstring Slider Curl', 'Hamstring strength', 'Keep the hips lifted as the heels move.', 3, '8', '75s'),
      movement('Standing Calf Raise', 'Ankle strength', 'Pause at the top and lower slowly.', 3, '10', '60s'),
      movement('Pallof Press', 'Anti-rotation', 'Keep ribs stacked and resist rotation.', 3, '10/side', '45s'),
    ],
    recovery: ['Easy walk x 3 min', 'Hip flexor stretch x 45s/side'],
    explanation: 'This posterior-chain session provides a different strength stimulus from the recent completed workout.',
    restExplanation: 'Use full rest for the hinge and split squat so fatigue does not change technique.',
  },
]);

const NOVEL_ACCESSORIES = Object.freeze([
  'Farmer Carry',
  'Half-Kneeling Cable Chop',
  'Reverse Cable Chop',
  'Front-Rack Carry',
  'Plank Dumbbell Drag',
  'Tall-Kneeling Cable Lift',
  'Hollow Body Hold',
  'Band Face Pull',
  'Scapular Push-Up',
  'Cable External Rotation',
]);

function cloneRecommendation(recommendation) {
  return {
    ...recommendation,
    muscleGroups: [...(recommendation.muscleGroups || [])],
    warmup: [...(recommendation.warmup || [])],
    main: (recommendation.main || []).map((item) => ({ ...item })),
    recovery: [...(recommendation.recovery || [])],
  };
}

function recentMuscleGroups(history) {
  return new Set((history[0]?.muscleGroups || []).map((group) => cleanText(group).toLowerCase()));
}

function overlapsRecentMuscles(candidate, recentGroups) {
  return (candidate.muscleGroups || []).filter((group) => recentGroups.has(group)).length;
}

function distinctFromHistory(candidate, history) {
  return !(history || []).some((workout) => sameSubstantiveWorkout(candidate, workout));
}

function selectDistinctRecommendation({ recommendation, recentCompletedWorkouts = [], todayRun = null } = {}) {
  if (!recommendation || !recentCompletedWorkouts.some((workout) => sameSubstantiveWorkout(recommendation, workout))) {
    return recommendation;
  }

  const recentGroups = recentMuscleGroups(recentCompletedWorkouts);
  const hasScheduledRun = Boolean(todayRun);
  const ranked = ALTERNATIVES
    .filter((candidate) => !hasScheduledRun || candidate.runCompatible)
    .map((candidate, index) => ({
      candidate,
      index,
      score: overlapsRecentMuscles(candidate, recentGroups) * 10
        + (LOWER_BODY_MARKER.test(candidate.target) && hasScheduledRun ? 100 : 0),
    }))
    .sort((left, right) => left.score - right.score || left.index - right.index);

  for (const { candidate } of ranked) {
    if (distinctFromHistory(candidate, recentCompletedWorkouts)) return cloneRecommendation(candidate);
  }

  const base = cloneRecommendation(ranked[0]?.candidate || ALTERNATIVES[2]);
  for (const name of NOVEL_ACCESSORIES) {
    const next = cloneRecommendation(base);
    next.main[next.main.length - 1] = movement(name, 'Trunk and posture', 'Move with control and keep a stable trunk.', 3, '8/side', '60s');
    if (distinctFromHistory(next, recentCompletedWorkouts)) return next;
  }
  return base;
}

module.exports = {
  buildCompletedWorkoutHistory,
  normalizeExerciseName,
  sameSubstantiveWorkout,
  selectDistinctRecommendation,
  workoutFingerprint,
};
