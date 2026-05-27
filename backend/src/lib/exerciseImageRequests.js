const { dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');

const LOCAL_FORM_IMAGE_MATCHERS = [
  (name) => name.includes('dumbbell bench press'),
  (name) => name.includes('squat') || name.includes('leg press'),
  (name) => name.includes('deadlift') || name.includes('romanian deadlift'),
  (name) => name.includes('barbell row') || name.includes('dumbbell row') || name.includes('cable row') || name.includes('single-arm dumbbell row'),
  (name) => name.includes('overhead press') || name.includes('arnold press') || name.includes('shoulder press'),
  (name) => name.includes('push-up') || name.includes('push up'),
  (name) => name.includes('plank'),
  (name) => name.includes('barbell curl') || name.includes('hammer curl') || name.includes('preacher curl') || name.includes('curl'),
  (name) => name.includes('tricep pushdown') || name.includes('tricep') || name.includes('skull crusher'),
  (name) => name.includes('pull-up') || name.includes('pull up'),
  (name) => name.includes('lat pulldown') || name.includes('pulldown'),
  (name) => name.includes('leg swing'),
  (name) => name.includes('hip flexor'),
  (name) => name.includes('hip circle'),
  (name) => name.includes('high knee'),
  (name) => name.includes('butt kick'),
  (name) => name.includes('ankle roll'),
  (name) => name.includes('walking lunge') || name === 'lunges' || name.includes('lunge'),
  (name) => name.includes('standing quad') || name.includes('quad stretch'),
  (name) => name.includes('hamstring stretch'),
  (name) => name.includes('calf stretch'),
  (name) => name.includes('figure four') || name.includes('figure-4') || name.includes('piriformis'),
  (name) => name.includes("child's pose") || name.includes('childs pose'),
];

function normalizeExerciseName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function hasLocalFormImage(name) {
  const normalized = normalizeExerciseName(name).toLowerCase();
  return LOCAL_FORM_IMAGE_MATCHERS.some((matcher) => matcher(normalized));
}

async function requestExerciseImageIfMissing({ userId, exerciseName, source = 'workout' }) {
  const name = normalizeExerciseName(exerciseName);
  if (!userId || !name || name.toLowerCase() === 'unknown') return;

  try {
    const exercise = await dbGet(
      'SELECT id FROM exercises WHERE LOWER(name)=LOWER(?) AND approved=1 LIMIT 1',
      [name]
    );
    const hasFormImage = hasLocalFormImage(name);
    if (hasFormImage) return;

    const reason = exercise
      ? 'known exercise missing AI form image'
      : 'new exercise missing catalog entry and AI form image';
    const message = `Exercise image needed: ${name} (${reason}; source=${source})`;
    const existing = await dbGet(
      `SELECT id FROM app_feedback
       WHERE user_id=? AND type=? AND category=? AND message=?
       LIMIT 1`,
      [userId, 'exercise_image_request', 'missing_exercise_image', message]
    );
    if (existing) return;

    await dbRun(
      `INSERT INTO app_feedback (id, user_id, type, message, page, severity, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), userId, 'exercise_image_request', message, source, 'low', 'missing_exercise_image']
    );
  } catch (err) {
    console.error('[exercise-image-request]', err.message);
  }
}

async function requestImagesForWorkoutItems({ userId, items, source }) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const exerciseName = typeof item === 'string' ? item : item?.name || item?.exercise_name;
    await requestExerciseImageIfMissing({ userId, exerciseName, source });
  }
}

module.exports = {
  requestExerciseImageIfMissing,
  requestImagesForWorkoutItems,
};
