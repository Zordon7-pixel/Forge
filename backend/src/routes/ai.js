const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { generateRunBrief, generateLiftPlan, generateWorkoutRecommendation, generateSessionFeedback, generateBodyPartWorkout, generatePostSessionInsight, sanitize } = require('../services/ai');
const { requestExerciseImageIfMissing, requestImagesForWorkoutItems } = require('../lib/exerciseImageRequests');
const { isRunActivity, runActivitySql } = require('../lib/runActivity');

const FALLBACK_ACCESSORIES = {
  chest: ['Incline Dumbbell Press', 'Push-Up'],
  back: ['Chest-Supported Row', 'Lat Pulldown'],
  legs: ['Rear-Foot-Elevated Split Squat', 'Romanian Deadlift'],
  shoulders: ['Half-Kneeling Landmine Press', 'Cable Face Pull'],
  arms: ['Close-Grip Bench Press', 'Hammer Curl'],
  core: ['Pallof Press', 'Dead Bug'],
  full: ['Rear-Foot-Elevated Split Squat', 'Single-Leg Romanian Deadlift'],
};

function normalizeGuidance(items, fallback) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => sanitize(typeof item === 'string' ? item : item?.name, 100))
    .filter(Boolean)
    .slice(0, 6);
  return normalized.length ? normalized : fallback;
}

function normalizeStrengthRecommendation(value) {
  if (!value || typeof value !== 'object') return null;
  const main = (Array.isArray(value.main) ? value.main : [])
    .map((exercise) => {
      if (!exercise || typeof exercise !== 'object') return null;
      const name = sanitize(exercise.name, 80);
      if (!name) return null;
      const parsedSets = Number(exercise.sets);
      return {
        name,
        sets: Number.isFinite(parsedSets) ? Math.max(1, Math.min(8, Math.round(parsedSets))) : 3,
        reps: sanitize(exercise.reps, 20) || '6-8',
        rest: sanitize(exercise.rest, 20) || '90s',
        focus: sanitize(exercise.focus, 30) || 'Strength',
        cue: sanitize(exercise.cue, 140) || 'Use controlled form and stop the set before technique breaks down.',
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  if (main.length < 4) return null;

  return {
    workoutName: sanitize(value.workoutName, 100) || 'Hybrid Strength and Speed',
    target: sanitize(value.target, 80) || 'Full Body',
    warmup: normalizeGuidance(value.warmup, ['Easy movement x 3 min', 'Dynamic leg swings x 8/side', 'Bodyweight squat x 10']),
    main,
    recovery: normalizeGuidance(value.recovery, ['Easy walk x 3 min', 'Hip flexor stretch x 45s/side']),
    explanation: sanitize(value.explanation, 400),
    restExplanation: sanitize(value.restExplanation, 240),
  };
}

function fallbackStrengthRecommendation({ bodyPart = 'full', exercise = '' } = {}) {
  const normalizedPart = sanitize(bodyPart, 30).toLowerCase();
  const accessories = FALLBACK_ACCESSORIES[normalizedPart] || FALLBACK_ACCESSORIES.full;
  const anchor = sanitize(exercise, 80) || 'Trap Bar Deadlift';
  return {
    workoutName: 'Hybrid Strength and Speed',
    target: normalizedPart === 'full' ? 'Full Body' : sanitize(bodyPart, 50),
    warmup: ['Easy movement x 3 min', 'Dynamic leg swings x 8/side', 'Pogo hops x 20'],
    main: [
      { name: anchor, sets: 4, reps: '4-6', rest: '2-3 min', focus: 'Strength', cue: 'Move each rep with control and stop before form slows.' },
      { name: accessories[0], sets: 3, reps: '6/side', rest: '90s', focus: 'Single-leg strength', cue: 'Keep the working knee tracking over the middle toes.' },
      { name: accessories[1], sets: 3, reps: '8', rest: '75s', focus: 'Force production', cue: 'Brace first, then drive through the full range.' },
      { name: 'Low Box Jump', sets: 4, reps: '3', rest: '90s', focus: 'Power', cue: 'Use a low box, land quietly, and reset before every rep.' },
      { name: 'Standing Calf Raise', sets: 3, reps: '10', rest: '60s', focus: 'Ankle stiffness', cue: 'Pause at the top and lower under control.' },
      { name: 'Pallof Press', sets: 3, reps: '10/side', rest: '45s', focus: 'Trunk stability', cue: 'Keep ribs stacked and resist rotation.' },
    ],
    recovery: ['Easy walk x 3 min', 'Hip flexor stretch x 45s/side'],
    explanation: 'This session develops usable strength and force production while covering the single-leg, calf, and trunk qualities that support faster running.',
    restExplanation: 'Take the full rest on strength and power work so every set stays crisp; shorten rest only on the final accessories.',
  };
}

router.post('/session-feedback', auth, async (req, res) => {
  try {
    const { sessionType, sessionId } = req.body || {};
    const athleteId = req.user.id;
    if (!sessionType || !sessionId) return res.status(400).json({ error: 'sessionType and sessionId are required' });

    const profile = await dbGet('SELECT * FROM users WHERE id=?', [athleteId]);
    let sessionData = null;

    if (sessionType === 'run') {
      return res.status(410).json({ error: 'Run feedback is generated once after the post-run check-in.' });
    } else if (sessionType === 'lift') {
      const session = await dbGet('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [sessionId, athleteId]);
      const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY logged_at ASC', [sessionId, athleteId]);
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
  } catch (err) {
    console.error('Error generating session feedback:', err.message);
    res.status(500).json({ error: 'Failed to generate session feedback' });
  }
});

router.post('/post-session-insight', auth, async (req, res) => {
  try {
    const { sessionType, sessionId } = req.body || {};
    const athleteId = req.user.id;
    if (!sessionType || !sessionId) return res.status(400).json({ error: 'sessionType and sessionId are required' });

    const profile = await dbGet('SELECT * FROM users WHERE id=?', [athleteId]);
    let comparisons = null;

    if (sessionType === 'run') {
      const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [sessionId, athleteId]);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      if (!isRunActivity(run)) return res.status(400).json({ error: 'Run analysis is only available for running activities' });

      const recentRuns = await dbAll(
        `SELECT distance_miles, duration_seconds, perceived_effort, date FROM runs WHERE user_id=? AND id!=? AND ${runActivitySql()} ORDER BY date DESC, created_at DESC LIMIT 5`,
        [athleteId, sessionId]
      );

      const durationMin = Math.round((run.duration_seconds || 0) / 60);
      const distMiles = Number(run.distance_miles || 0);
      const pace = distMiles > 0 && durationMin > 0
        ? `${Math.floor(durationMin / distMiles)}:${String(Math.round((durationMin / distMiles % 1) * 60)).padStart(2, '0')}`
        : 'n/a';

      const validRecent = recentRuns.filter(r => Number(r.distance_miles) > 0 && Number(r.duration_seconds) > 0);
      const recentPaces = validRecent.map(r => (Number(r.duration_seconds) / 60) / Number(r.distance_miles));
      const recentAvgPace = recentPaces.length > 0
        ? (() => { const avg = recentPaces.reduce((a, b) => a + b, 0) / recentPaces.length; return `${Math.floor(avg)}:${String(Math.round((avg % 1) * 60)).padStart(2, '0')}`; })()
        : null;
      const recentAvgDistance = validRecent.length > 0
        ? (validRecent.reduce((s, r) => s + Number(r.distance_miles), 0) / validRecent.length).toFixed(1)
        : null;

      let paceTrend = 'not enough data';
      if (recentPaces.length >= 2) {
        const currentPace = distMiles > 0 ? durationMin / distMiles : 0;
        const avgPace = recentPaces.reduce((a, b) => a + b, 0) / recentPaces.length;
        const diff = Math.round((avgPace - currentPace) * 60);
        paceTrend = diff > 0 ? `${diff}s/mi faster than recent avg` : diff < 0 ? `${Math.abs(diff)}s/mi slower than recent avg` : 'matching recent avg';
      }

      const recentDistances = validRecent.map(r => Number(r.distance_miles));
      let distanceTrend = 'not enough data';
      if (recentDistances.length >= 2) {
        const avgDist = recentDistances.reduce((a, b) => a + b, 0) / recentDistances.length;
        const diff = ((distMiles - avgDist) / avgDist * 100).toFixed(0);
        distanceTrend = Number(diff) > 0 ? `${diff}% longer than recent avg` : Number(diff) < 0 ? `${Math.abs(diff)}% shorter than recent avg` : 'matching recent avg';
      }

      const prRow = await dbGet(
        'SELECT label FROM personal_records WHERE user_id=? AND run_id=?',
        [athleteId, sessionId]
      );

      const now = new Date();
      const weekStart = new Date(now);
      const day = weekStart.getDay();
      weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1));
      weekStart.setHours(0, 0, 0, 0);
      const weekRow = await dbGet(
        `SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND ${runActivitySql()}`,
        [athleteId, weekStart.toISOString().slice(0, 10)]
      );

      comparisons = {
        distance: distMiles,
        durationMin,
        pace,
        effort: run.perceived_effort || 5,
        recentAvgPace,
        recentAvgDistance,
        paceTrend,
        distanceTrend,
        isPR: Boolean(prRow?.label),
        prLabel: prRow?.label || null,
        weeklyMileage: Number(weekRow?.miles || 0).toFixed(1),
      };
    } else if (sessionType === 'lift') {
      const session = await dbGet('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [sessionId, athleteId]);
      if (!session) return res.status(404).json({ error: 'Workout session not found' });

      const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY logged_at ASC', [sessionId, athleteId]);
      const exerciseMap = {};
      for (const s of sets) {
        const name = s.exercise_name || 'Unknown';
        if (!exerciseMap[name]) exerciseMap[name] = [];
        exerciseMap[name].push(s);
      }

      const totalVolume = sets.reduce((sum, s) => sum + (Number(s.weight_lbs || 0) * Number(s.reps || 0)), 0);
      const exerciseComparisons = [];
      const progressiveOverloads = [];

      for (const [name, exSets] of Object.entries(exerciseMap)) {
        const currentVolume = exSets.reduce((sum, s) => sum + (Number(s.weight_lbs || 0) * Number(s.reps || 0)), 0);
        const currentMaxWeight = Math.max(...exSets.map(s => Number(s.weight_lbs || 0)));

        const prevSets = await dbAll(
          `SELECT ws.weight_lbs, ws.reps FROM workout_sets ws
           JOIN workout_sessions wsess ON ws.session_id = wsess.id
           WHERE ws.user_id=? AND ws.exercise_name=? AND ws.session_id!=?
           ORDER BY wsess.started_at DESC LIMIT 30`,
          [athleteId, name, sessionId]
        );

        const prevSessionVolumes = [];
        let sessionVol = 0;
        let count = 0;
        for (const ps of prevSets) {
          sessionVol += Number(ps.weight_lbs || 0) * Number(ps.reps || 0);
          count++;
          if (count % exSets.length === 0 || count === prevSets.length) {
            prevSessionVolumes.push(sessionVol);
            sessionVol = 0;
            if (prevSessionVolumes.length >= 3) break;
          }
        }

        const prevAvgVolume = prevSessionVolumes.length > 0
          ? Math.round(prevSessionVolumes.reduce((a, b) => a + b, 0) / prevSessionVolumes.length)
          : 0;

        const changePercent = prevAvgVolume > 0
          ? ((currentVolume - prevAvgVolume) / prevAvgVolume * 100).toFixed(0)
          : null;
        const volumeChange = changePercent !== null
          ? (Number(changePercent) > 0 ? `+${changePercent}%` : `${changePercent}%`)
          : 'no prior data';

        if (prevAvgVolume > 0 && currentVolume > prevAvgVolume) {
          progressiveOverloads.push(name);
        }

        exerciseComparisons.push({
          name,
          currentVolume: Math.round(currentVolume),
          prevAvgVolume,
          volumeChange,
        });
      }

      comparisons = {
        exerciseCount: Object.keys(exerciseMap).length,
        totalVolume: Math.round(totalVolume),
        exerciseComparisons,
        progressiveOverloads,
      };
    } else {
      return res.status(400).json({ error: 'sessionType must be run or lift' });
    }

    const insight = await generatePostSessionInsight({ sessionType, comparisons, profile, userId: athleteId });
    res.json({
      insight: insight || 'Session logged. Keep stacking consistent work.',
      comparisons,
    });
  } catch (err) {
    console.error('Error generating post-session insight:', err.message);
    res.status(500).json({ error: 'Failed to generate post-session insight' });
  }
});

router.get('/run-brief', auth, async (req, res) => {
  try {
    const { sessionId } = req.query;
    const [run, profile, recentRuns, recentLifts] = await Promise.all([
      sessionId ? dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [sessionId, req.user.id]) : Promise.resolve(null),
      dbGet('SELECT * FROM users WHERE id=?', [req.user.id]),
      dbAll(`SELECT * FROM runs WHERE user_id=? AND ${runActivitySql()} ORDER BY date DESC, created_at DESC LIMIT 8`, [req.user.id]),
      dbAll('SELECT * FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 5', [req.user.id])
    ]);

    const fallback = {
      why: 'This run supports your weekly progression while managing fatigue.',
      effort: 'Easy',
      bpmRange: '135–150 BPM',
      cadence: '170–175 spm'
    };

    const brief = await generateRunBrief({ run, profile, recentRuns, recentLifts, userId: req.user.id });
    res.json(brief ? { ...brief, source: 'ai' } : { ...fallback, source: 'fallback' });
  } catch (err) {
    console.error('Error generating run brief:', err.message);
    res.status(500).json({ error: 'Failed to generate run brief' });
  }
});

router.post('/lift-plan', auth, async (req, res) => {
  try {
    const { bodyPart, timeAvailable } = req.body || {};
    const athleteId = req.user.id;
    const [profile, recentSets, recentRuns] = await Promise.all([
      dbGet('SELECT * FROM users WHERE id=?', [athleteId]),
      dbAll('SELECT * FROM workout_sets WHERE user_id=? ORDER BY logged_at DESC LIMIT 40', [athleteId]),
      dbAll(`SELECT * FROM runs WHERE user_id=? AND ${runActivitySql()} ORDER BY date DESC, created_at DESC LIMIT 10`, [athleteId])
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
    await requestImagesForWorkoutItems({ userId: athleteId, items: plan.exercises, source: 'ai_lift_plan' });

    res.json({ plan });
  } catch (err) {
    console.error('Error generating lift plan:', err.message);
    res.status(500).json({ error: 'Failed to generate lift plan' });
  }
});

router.get('/workout-recommendation', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [profile, recentRuns, recentWorkouts] = await Promise.all([
      dbGet('SELECT * FROM users WHERE id=?', [userId]),
      dbAll(`SELECT * FROM runs WHERE user_id=? AND ${runActivitySql()} ORDER BY date DESC, created_at DESC LIMIT 10`, [userId]),
      dbAll('SELECT * FROM workout_sessions WHERE user_id=? ORDER BY started_at DESC LIMIT 8', [userId])
    ]);

    const generated = await generateWorkoutRecommendation({ profile, recentRuns, recentWorkouts, userId });
    const recommendation = normalizeStrengthRecommendation(generated) || fallbackStrengthRecommendation();
    await requestImagesForWorkoutItems({ userId, items: recommendation.main, source: 'ai_workout_recommendation' });
    await requestImagesForWorkoutItems({ userId, items: recommendation.warmup, source: 'ai_workout_recommendation' });
    await requestImagesForWorkoutItems({ userId, items: recommendation.recovery, source: 'ai_workout_recommendation' });

    res.json({ recommendation });
  } catch (err) {
    console.error('Error generating workout recommendation:', err.message);
    res.status(500).json({ error: 'Failed to generate workout recommendation' });
  }
});

router.post('/workout', auth, async (req, res) => {
  try {
    const { bodyPart, exercise } = req.body || {};
    if (!bodyPart || !exercise) return res.status(400).json({ error: 'bodyPart and exercise are required' });
    const athleteId = req.user.id;

    const profile = await dbGet('SELECT * FROM users WHERE id=?', [athleteId]);
    const generated = await generateBodyPartWorkout({ bodyPart, exercise, profile, userId: athleteId });
    const recommendation = normalizeStrengthRecommendation(generated) || fallbackStrengthRecommendation({ bodyPart, exercise });
    await requestExerciseImageIfMissing({ userId: athleteId, exerciseName: exercise, source: 'ai_workout_anchor' });
    await requestImagesForWorkoutItems({ userId: athleteId, items: recommendation.main, source: 'ai_workout' });
    await requestImagesForWorkoutItems({ userId: athleteId, items: recommendation.warmup, source: 'ai_workout' });
    await requestImagesForWorkoutItems({ userId: athleteId, items: recommendation.recovery, source: 'ai_workout' });

    res.json({ recommendation });
  } catch (err) {
    console.error('Error generating workout:', err.message);
    res.status(500).json({ error: 'Failed to generate workout' });
  }
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
