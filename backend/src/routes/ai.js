const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const auth = require('../middleware/auth');
const { generateRunBrief, generateLiftPlan, generateWorkoutRecommendation } = require('../services/ai');

router.get('/run-brief', auth, async (req, res) => {
  const { sessionId } = req.query;
  const run = sessionId ? db.prepare('SELECT * FROM runs WHERE id=? AND user_id=?').get(sessionId, req.user.id) : null;
  const profile = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const recentRuns = db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY date DESC, created_at DESC LIMIT 8').all(req.user.id);
  const recentLifts = db.prepare('SELECT * FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 5').all(req.user.id);

  const fallback = {
    why: 'This run supports your weekly progression while managing fatigue.',
    effort: 'Easy',
    bpmRange: '135–150 BPM',
    cadence: '170–175 spm'
  };

  const brief = await generateRunBrief({ run, profile, recentRuns, recentLifts }) || fallback;
  res.json(brief);
});

router.post('/lift-plan', auth, async (req, res) => {
  const { bodyPart, timeAvailable, userId } = req.body || {};
  const athleteId = userId || req.user.id;
  const profile = db.prepare('SELECT * FROM users WHERE id=?').get(athleteId);
  const recentSets = db.prepare('SELECT * FROM workout_sets WHERE user_id=? ORDER BY logged_at DESC LIMIT 40').all(athleteId);
  const recentRuns = db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY date DESC, created_at DESC LIMIT 10').all(athleteId);

  const plan = await generateLiftPlan({ bodyPart, timeAvailable, profile, recentSets, recentRuns }) || {
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
  const profile = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const recentRuns = db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY date DESC, created_at DESC LIMIT 10').all(userId);
  const recentWorkouts = db.prepare('SELECT * FROM workout_sessions WHERE user_id=? ORDER BY started_at DESC LIMIT 8').all(userId);

  const recommendation = await generateWorkoutRecommendation({ profile, recentRuns, recentWorkouts }) || {
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

router.post('/community-share', auth, async (req, res) => {
  const { workoutData } = req.body || {};
  
  if (!workoutData) {
    return res.status(400).json({ error: 'workoutData is required' });
  }

  const id = uuidv4();
  try {
    db.prepare(`INSERT INTO community_workouts
      (id, user_id, workout_name, target, warmup_json, main_json, recovery_json, explanation, rest_notes)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        req.user.id,
        workoutData.workoutName || 'AI Workout',
        workoutData.target || '',
        JSON.stringify(workoutData.warmup || []),
        JSON.stringify(workoutData.main || []),
        JSON.stringify(workoutData.recovery || []),
        workoutData.explanation || '',
        workoutData.restExplanation || ''
      );

    res.status(201).json({ id, success: true });
  } catch (err) {
    console.error('Error sharing workout:', err);
    res.status(500).json({ error: 'Failed to share workout' });
  }
});

module.exports = router;
