const { dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');

const LOCAL_FORM_IMAGE_MATCHERS = [
  (name) => name.includes('dumbbell bench press'),
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
