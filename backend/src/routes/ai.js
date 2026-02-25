const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { generateRunBrief, generateLiftPlan, generateWorkoutRecommendation, generateSessionFeedback, generateBodyPartWorkout } = require('../services/ai');

router.post('/session-feedback', auth, async (req, res) => {
  const { sessionType, sessionId, userId } = req.body || {};
  const athleteId = userId || req.user.id;
  if (!sessionType || !sessionId) return res.status(400).json({ error: 'sessionType and sessionId are required' });

  const profile = await dbGet('SELECT * FROM users WHERE id=?', [athleteId]);
  let sessionData = null;

  if (sessionType === 'run') {
    sessionData = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [sessionId, athleteId]);
  } else if (sessionType === 'lift') {
    const session = await dbGet('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [sessionId, athleteId]);
    const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? ORDER BY logged_at ASC', [sessionId]);
    sessionData = session ? { ...session, sets } : null;
  } else {
    return res.status(400).json({ error: 'sessionType must be run or lift' });
  }

  if (!sessionData) return res.status(404).json({ error: 'Session not found' });

  const feedback = await generateSessionFeedback({ sessionType, sessionData, profile, userId: athleteId });
  if (!feedback) {
    return res.json({
      feedback: {
        analysis: 'Solid work getting this session done. Consistency is the biggest long-term driver of progress.',
        didWell: 'You showed up and completed your planned work.',
        suggestion: 'Aim for smooth pacing and controlled effort in your next session.',
        recovery: 'easy day'
      }
    });
  }

  res.json({ feedback });
});

router.get('/run-brief', auth, async (req, res) => {
  const { sessionId } = req.query;
  const [run, profile, recentRuns, recentLifts] = await Promise.all([
    sessionId ? dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [sessionId, req.user.id]) : Promise.resolve(null),
    dbGet('SELECT * FROM users WHERE id=?', [req.user.id]),
    dbAll('SELECT * FROM runs WHERE user_id=? ORDER BY date DESC, created_at DESC LIMIT 8', [req.user.id]),
    dbAll('SELECT * FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 5', [req.user.id])
  ]);

  const fallback = {
    why: 'This run supports your weekly progression while managing fatigue.',
    effort: 'Easy',
    bpmRange: '135–150 BPM',
    cadence: '170–175 spm'
  };

  const brief = await generateRunBrief({ run, profile, recentRuns, recentLifts, userId: req.user.id }) || fallback;
  res.json(brief);
});

router.post('/lift-plan', auth, async (req, res) => {
  const { bodyPart, timeAvailable, userId } = req.body || {};
  const athleteId = userId || req.user.id;
  const [profile, recentSets, recentRuns] = await Promise.all([
    dbGet('SELECT * FROM users WHERE id=?', [athleteId]),
    dbAll('SELECT * FROM workout_sets WHERE user_id=? ORDER BY logged_at DESC LIMIT 40', [athleteId]),
    dbAll('SELECT * FROM runs WHERE user_id=? ORDER BY date DESC, created_at DESC LIMIT 10', [athleteId])
  ]);

  const plan = await generateLiftPlan({ bodyPart, timeAvailable, profile, recentSets, recentRuns, userId: athleteId }) || {
    workoutName: `${bodyPart || 'Full Body'} Focus`,
    exercises: [
      { name: 'Compound Movement', sets: 3, reps: '8-10', rest: '90s' },
      { name: 'Accessory Movement', sets: 3, reps: '10-12', rest: '60s' },
      { name: 'Core Finisher', sets: 2, reps: '12-15', rest: '45s' }
    ],
    estimatedTime: `${timeAvailable || 30} min`
  };

  res.json({ plan });
});

router.get('/workout-recommendation', auth, async (req, res) => {
  const userId = req.query.userId || req.user.id;
  const [profile, recentRuns, recentWorkouts] = await Promise.all([
    dbGet('SELECT * FROM users WHERE id=?', [userId]),
    dbAll('SELECT * FROM runs WHERE user_id=? ORDER BY date DESC, created_at DESC LIMIT 10', [userId]),
    dbAll('SELECT * FROM workout_sessions WHERE user_id=? ORDER BY started_at DESC LIMIT 8', [userId])
  ]);

  const recommendation = await generateWorkoutRecommendation({ profile, recentRuns, recentWorkouts, userId }) || {
    workoutName: 'Upper Body and Core — Recovery Focus',
    target: 'Upper Body and Core',
    warmup: ['Band pull-aparts x 20', 'Shoulder circles x 30s'],
    main: [{ name: 'Dumbbell Bench Press', sets: 4, reps: '8-10', rest: '90s' }],
    recovery: ['Child\'s pose 60s', 'Thoracic rotations 8/side'],
    explanation: 'Lower body fatigue is high, so this session keeps leg stress low.',
    restExplanation: 'Longer rest on compounds to preserve quality sets.'
  };

  res.json({ recommendation });
});

router.post('/workout', auth, async (req, res) => {
  const { bodyPart, exercise, userId } = req.body || {};
  if (!bodyPart || !exercise) return res.status(400).json({ error: 'bodyPart and exercise are required' });
  const athleteId = userId || req.user.id;

  const profile = await dbGet('SELECT * FROM users WHERE id=?', [athleteId]);
  const recommendation = await generateBodyPartWorkout({ bodyPart, exercise, profile, userId: athleteId }) || {
    workoutName: `${String(bodyPart)} Builder`,
    target: String(bodyPart),
    warmup: ['Dynamic mobility x 5 min'],
    main: [
      { name: String(exercise), sets: 4, reps: '8-10', rest: '90s' },
      { name: `${String(bodyPart)} Accessory`, sets: 3, reps: '10-12', rest: '60s' },
      { name: 'Stability Finisher', sets: 2, reps: '12-15', rest: '45s' },
      { name: 'Core Hold', sets: 2, reps: '30-45s', rest: '45s' }
    ],
    recovery: ['Light stretch 5 min'],
    explanation: 'Focused session generated from your selected body part and exercise.',
    restExplanation: 'Longer rests on heavier sets, shorter rests on accessories.'
  };

  res.json({ recommendation });
});

router.post('/community-share', auth, async (req, res) => {
  const { workoutData } = req.body || {};
  if (!workoutData) return res.status(400).json({ error: 'workoutData is required' });

  const id = uuidv4();
  try {
    await dbRun(
      `INSERT INTO community_workouts
        (id, user_id, workout_name, target, warmup_json, main_json, recovery_json, explanation, rest_notes)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id, req.user.id,
        workoutData.workoutName || 'AI Workout',
        workoutData.target || '',
        JSON.stringify(workoutData.warmup || []),
        JSON.stringify(workoutData.main || []),
        JSON.stringify(workoutData.recovery || []),
        workoutData.explanation || '',
        workoutData.restExplanation || ''
      ]
    );
    res.status(201).json({ id, success: true });
  } catch (err) {
    console.error('Error sharing workout:', err);
    res.status(500).json({ error: 'Failed to share workout' });
  }
});

module.exports = router;
