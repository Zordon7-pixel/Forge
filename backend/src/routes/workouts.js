const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { generateWorkoutFeedback } = require('../services/ai');

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
      return res.status(401).json({ error: 'Session expired. Please log out and back in.' });
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

    await dbRun('UPDATE workout_sessions SET ended_at=?, notes=?, total_seconds=? WHERE id=?',
      [ended_at, notes || null, total_seconds, req.params.id]);

    const userProfile = await dbGet('SELECT weight_lbs FROM users WHERE id=?', [req.user.id]);
    const weightKg = (userProfile?.weight_lbs || 154.35) / 2.205;
    const MET_STRENGTH = 5.0;
    const durationHours = (total_seconds > 0 ? total_seconds : 45 * 60) / 3600;
    const calories_burned = Math.round(MET_STRENGTH * weightKg * durationHours);
    if (calories_burned > 0) {
      await dbRun('UPDATE workout_sessions SET calories_burned=? WHERE id=?', [calories_burned, req.params.id]);
    }

    res.json({ ok: true, total_seconds, calories_burned });
  } catch (err) { res.status(500).json({ error: 'End workout failed' }); }
});

router.post('/:id/sets', auth, async (req, res) => {
  try {
    const { exercise_name, muscle_group, reps, weight_lbs, set_number } = req.body;
    if (!exercise_name) return res.status(400).json({ error: 'exercise_name required' });
    const id = uuidv4();
    await dbRun('INSERT INTO workout_sets (id, session_id, user_id, exercise_name, muscle_group, set_number, reps, weight_lbs) VALUES (?,?,?,?,?,?,?,?)',
      [id, req.params.id, req.user.id, exercise_name, muscle_group || null, set_number || 1, reps || null, weight_lbs || null]);

    const session = await dbGet('SELECT muscle_groups FROM workout_sessions WHERE id=?', [req.params.id]);
    let groups = [];
    try { groups = JSON.parse(session?.muscle_groups || '[]'); } catch {}
    if (muscle_group && !groups.includes(muscle_group)) {
      groups.push(muscle_group);
      await dbRun('UPDATE workout_sessions SET muscle_groups=? WHERE id=?', [JSON.stringify(groups), req.params.id]);
    }

    const set = await dbGet('SELECT * FROM workout_sets WHERE id=?', [id]);
    res.status(201).json({ set });
  } catch (err) { res.status(500).json({ error: 'Failed to log set' }); }
});

router.get('/:id/sets', auth, async (req, res) => {
  try {
    const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY logged_at ASC', [req.params.id, req.user.id]);
    res.json({ sets });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch sets' }); }
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

    const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? ORDER BY logged_at ASC', [req.params.id]);
    const sessionData = { ...session, muscle_groups: JSON.parse(session.muscle_groups || '[]') };
    await dbRun('INSERT INTO ai_usage (id, user_id, call_type) VALUES (?,?,?)', [uuidv4(), req.user.id, 'workout_feedback']);

    const feedback = await generateWorkoutFeedback(sessionData, sets, profile);
    if (feedback) await dbRun('UPDATE workout_sessions SET ai_feedback=? WHERE id=?', [feedback, req.params.id]);
    res.json({ feedback: feedback || 'Could not generate feedback right now.' });
  } catch (err) { res.status(500).json({ error: 'Feedback failed' }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const session = await dbGet('SELECT * FROM workout_sessions WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!session) return res.status(404).json({ error: 'Not found' });
    const sets = await dbAll('SELECT * FROM workout_sets WHERE session_id=? ORDER BY logged_at ASC', [req.params.id]);
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
