const router = require('express').Router();
const { dbGet, dbAll, dbRun, withTransaction } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { generateWorkoutFeedback } = require('../services/ai');
const { requestExerciseImageIfMissing } = require('../lib/exerciseImageRequests');

router.post('/strength', auth, async (req, res) => {
  try {
    const { name, exercises, sets, total_volume, exercises_completed, personal_records_hit, completed_at } = req.body;
    const id = uuidv4();
    const started_at = completed_at || new Date().toISOString();
    const muscleGroups = [];
    const exerciseImageNames = [];

    await withTransaction(async (tx) => {
      await tx.run(
        'INSERT INTO workout_sessions (id, user_id, started_at, ended_at, muscle_groups, notes, total_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, req.user.id, started_at, started_at, JSON.stringify(muscleGroups), name || 'Strength Session', 0]
      );

      if (Array.isArray(sets)) {
        for (const s of sets) {
          const mg = s.muscle_group || null;
          if (mg && !muscleGroups.includes(mg)) muscleGroups.push(mg);
          await tx.run(
            'INSERT INTO workout_sets (id, session_id, user_id, exercise_name, muscle_group, set_number, reps, weight_lbs) VALUES (?,?,?,?,?,?,?,?)',
            [uuidv4(), id, req.user.id, s.exercise_name || 'Unknown', mg, s.set_number || 1, s.reps || null, s.weight_lbs || null]
          );
          if (s.exercise_name) exerciseImageNames.push(s.exercise_name);
        }
        if (muscleGroups.length) {
          await tx.run('UPDATE workout_sessions SET muscle_groups=? WHERE id=? AND user_id=?', [JSON.stringify(muscleGroups), id, req.user.id]);
        }
      }
    });

    for (const exerciseName of exerciseImageNames) {
      await requestExerciseImageIfMissing({ userId: req.user.id, exerciseName, source: 'strength_workout_import' });
    }

    const profile = await dbGet('SELECT weight_lbs FROM users WHERE id=?', [req.user.id]);
    const weightKg = (profile?.weight_lbs || 154.35) / 2.205;
    const MET_STRENGTH = 5.0;
    const durationHours = 45 / 60;
    const calories_burned = Math.round(MET_STRENGTH * weightKg * durationHours);
    if (calories_burned > 0) {
      await dbRun('UPDATE workout_sessions SET calories_burned=? WHERE id=? AND user_id=?', [calories_burned, id, req.user.id]);
    }

    res.status(201).json({
      session: { id, name, total_volume, exercises_completed, personal_records_hit },
    });
  } catch (err) {
    console.error('[workouts/strength] Error:', err.message);
    res.status(500).json({ error: 'Could not save strength workout.' });
  }
});

router.post('/start', auth, async (req, res) => {
  try {
    const { muscle_groups } = req.body;
    const id = uuidv4();
    const started_at = new Date().toISOString();
    await dbRun('INSERT INTO workout_sessions (id, user_id, started_at, muscle_groups) VALUES (?, ?, ?, ?)',
      [id, req.user.id, started_at, JSON.stringify(muscle_groups || [])]);
    res.status(201).json({ session: { id, started_at, muscle_groups: muscle_groups || [] } });
  } catch (err) {
    if (err.message && err.message.includes('FOREIGN KEY')) {
      console.error('[workouts/start] FOREIGN KEY error — user may not exist in DB:', req.user.id);
      return res.status(400).json({ error: 'Account not found. Please log out and re-register.' });
    }
    res.status(500).json({ error: 'Could not start workout.' });
  }
});

router.put('/:id/end', auth, async (req, res) => {
  try {
    const { notes } = req.body;
    const session = await dbGet('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let total_seconds = session.total_seconds;
    let ended_at = session.ended_at;
    if (!session.ended_at) {
      ended_at = new Date().toISOString();
      total_seconds = Math.round((new Date(ended_at) - new Date(session.started_at)) / 1000);
    }

    await dbRun('UPDATE workout_sessions SET ended_at=?, notes=?, total_seconds=? WHERE id=? AND user_id=?',
      [ended_at, notes || null, total_seconds, req.params.id, req.user.id]);

    const userProfile = await dbGet('SELECT weight_lbs FROM users WHERE id=?', [req.user.id]);
    const weightKg = (userProfile?.weight_lbs || 154.35) / 2.205;
    const MET_STRENGTH = 5.0;
    const durationHours = (total_seconds > 0 ? total_seconds : 45 * 60) / 3600;
    const calories_burned = Math.round(MET_STRENGTH * weightKg * durationHours);
    if (calories_burned > 0) {
      await dbRun('UPDATE workout_sessions SET calories_burned=? WHERE id=? AND user_id=?', [calories_burned, req.params.id, req.user.id]);
    }

    res.json({ ok: true, total_seconds, calories_burned });
  } catch (err) { res.status(500).json({ error: 'End workout failed' }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const session = await dbGet('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { exercise_name, sets, reps, weight_lbs, date } = req.body || {};
    const setCount = Math.max(0, Number(sets || 0));
    const repsValue = Number(reps || 0);
    const weightValue = Number(weight_lbs || 0);
    const exerciseName = String(exercise_name || '').trim();

    const nextStartedAt = date
      ? `${date}T${(session.started_at || '').split('T')[1] || '12:00:00'}`
      : session.started_at;
    let shouldRequestExerciseImage = false;

    const refreshed = await withTransaction(async (tx) => {
      await tx.run('UPDATE workout_sessions SET started_at=? WHERE id=? AND user_id=?', [nextStartedAt, req.params.id, req.user.id]);

      const existingSets = await tx.all(
        'SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY set_number ASC, logged_at ASC',
        [req.params.id, req.user.id]
      );

      if (setCount > 0 && exerciseName) {
        shouldRequestExerciseImage = true;
        if (!existingSets.length) {
          for (let i = 1; i <= setCount; i++) {
            await tx.run(
              'INSERT INTO workout_sets (id, session_id, user_id, exercise_name, set_number, reps, weight_lbs) VALUES (?,?,?,?,?,?,?)',
              [uuidv4(), req.params.id, req.user.id, exerciseName, i, repsValue > 0 ? repsValue : null, weightValue >= 0 ? weightValue : null]
            );
          }
        } else {
          const firstSet = existingSets[0];
          await tx.run(
            'UPDATE workout_sets SET exercise_name=?, reps=?, weight_lbs=? WHERE id=? AND user_id=?',
            [exerciseName, repsValue > 0 ? repsValue : firstSet.reps, weightValue >= 0 ? weightValue : firstSet.weight_lbs, firstSet.id, req.user.id]
          );
          if (setCount > existingSets.length) {
            for (let i = existingSets.length + 1; i <= setCount; i++) {
              await tx.run(
                'INSERT INTO workout_sets (id, session_id, user_id, exercise_name, set_number, reps, weight_lbs) VALUES (?,?,?,?,?,?,?)',
                [uuidv4(), req.params.id, req.user.id, exerciseName, i, repsValue > 0 ? repsValue : null, weightValue >= 0 ? weightValue : null]
              );
            }
          } else if (setCount < existingSets.length) {
            const idsToDelete = existingSets.slice(setCount).map((setRow) => setRow.id);
            for (const setId of idsToDelete) {
              await tx.run('DELETE FROM workout_sets WHERE id=? AND user_id=?', [setId, req.user.id]);
            }
          }
        }
      }

      const refreshedSession = await tx.get('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      const refreshedSets = await tx.all('SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY set_number ASC, logged_at ASC', [req.params.id, req.user.id]);
      return { session: refreshedSession, sets: refreshedSets };
    });

    if (shouldRequestExerciseImage) {
      await requestExerciseImageIfMissing({ userId: req.user.id, exerciseName, source: 'workout_update' });
    }
    res.json(refreshed);
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

router.post('/:id/sets', auth, async (req, res) => {
  try {
    const { exercise_name, muscle_group, reps, weight_lbs, set_number } = req.body;
    if (!exercise_name) return res.status(400).json({ error: 'exercise_name required' });
    const id = uuidv4();
    const set = await withTransaction(async (tx) => {
      const session = await tx.get('SELECT muscle_groups FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      if (!session) {
        const notFound = new Error('Session not found');
        notFound.status = 404;
        throw notFound;
      }

      await tx.run('INSERT INTO workout_sets (id, session_id, user_id, exercise_name, muscle_group, set_number, reps, weight_lbs) VALUES (?,?,?,?,?,?,?,?)',
        [id, req.params.id, req.user.id, exercise_name, muscle_group || null, set_number || 1, reps || null, weight_lbs || null]);

      let groups = [];
      try {
        groups = JSON.parse(session?.muscle_groups || '[]');
      } catch (err) {
        console.error('[workouts/sets] Failed to parse muscle groups:', err.message);
      }
      if (muscle_group && !groups.includes(muscle_group)) {
        groups.push(muscle_group);
        await tx.run('UPDATE workout_sessions SET muscle_groups=? WHERE id=? AND user_id=?', [JSON.stringify(groups), req.params.id, req.user.id]);
      }

      return tx.get('SELECT * FROM workout_sets WHERE id=? AND user_id=?', [id, req.user.id]);
    });
    await requestExerciseImageIfMissing({ userId: req.user.id, exerciseName: exercise_name, source: 'workout_set' });
    res.status(201).json({ set });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Session not found' });
    res.status(500).json({ error: 'Failed to log set' });
  }
});

router.get('/:id/sets', auth, async (req, res) => {
  try {
    const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY logged_at ASC', [req.params.id, req.user.id]);
    res.json({ sets });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch sets' }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const deleted = await withTransaction(async (tx) => {
      const session = await tx.get('SELECT id FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      if (!session) return false;
      await tx.run('DELETE FROM workout_sets WHERE session_id=? AND user_id=?', [req.params.id, req.user.id]);
      await tx.run('DELETE FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[workouts/delete] failed:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

router.post('/:id/feedback', auth, async (req, res) => {
  try {
    const session = await dbGet('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.ai_feedback) return res.json({ feedback: session.ai_feedback });

    const profile = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const [dailyRow, monthlyRow] = await Promise.all([
      dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id=? AND created_at>=?", [req.user.id, today]),
      dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id=? AND created_at>=?", [req.user.id, monthStart])
    ]);
    const canCallAI = Number(dailyRow?.cnt || 0) < 10 && (profile?.is_pro || Number(monthlyRow?.cnt || 0) < 5);
    if (!canCallAI) return res.status(429).json({ error: 'AI limit reached for today. Try again tomorrow.' });

    const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY logged_at ASC', [req.params.id, req.user.id]);
    const sessionData = { ...session, muscle_groups: JSON.parse(session.muscle_groups || '[]') };
    await dbRun('INSERT INTO ai_usage (id, user_id, call_type) VALUES (?,?,?)', [uuidv4(), req.user.id, 'workout_feedback']);

    const feedback = await generateWorkoutFeedback(sessionData, sets, profile);
    if (feedback) await dbRun('UPDATE workout_sessions SET ai_feedback=? WHERE id=? AND user_id=?', [feedback, req.params.id, req.user.id]);
    res.json({ feedback: feedback || 'Could not generate feedback right now.' });
  } catch (err) { res.status(500).json({ error: 'Feedback failed' }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const session = await dbGet('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!session) return res.status(404).json({ error: 'Not found' });
    const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY logged_at ASC', [req.params.id, req.user.id]);
    res.json({ session: { ...session, muscle_groups: JSON.parse(session.muscle_groups || '[]') }, sets });
  } catch (err) { res.status(500).json({ error: 'Fetch failed' }); }
});

router.get('/', auth, async (req, res) => {
  try {
    const sessions = await dbAll('SELECT * FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 20', [req.user.id]);
    res.json({ sessions: sessions.map(s => ({ ...s, muscle_groups: JSON.parse(s.muscle_groups || '[]') })) });
  } catch (err) { res.status(500).json({ error: 'Fetch failed' }); }
});

module.exports = router;
