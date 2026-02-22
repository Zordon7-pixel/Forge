const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// Start a workout session
router.post('/start', auth, (req, res) => {
  const { muscle_groups } = req.body;
  const id = uuidv4();
  const started_at = new Date().toISOString();
  db.prepare('INSERT INTO workout_sessions (id, user_id, started_at, muscle_groups) VALUES (?, ?, ?, ?)')
    .run(id, req.user.id, started_at, JSON.stringify(muscle_groups || []));
  res.status(201).json({ session: { id, started_at, muscle_groups: muscle_groups || [] } });
});

// End a workout session
router.put('/:id/end', auth, (req, res) => {
  const { notes } = req.body;
  const session = db.prepare('SELECT * FROM workout_sessions WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const ended_at = new Date().toISOString();
  const total_seconds = Math.round((new Date(ended_at) - new Date(session.started_at)) / 1000);
  db.prepare('UPDATE workout_sessions SET ended_at=?, notes=?, total_seconds=? WHERE id=?')
    .run(ended_at, notes || null, total_seconds, req.params.id);
  res.json({ ok: true, total_seconds });
});

// Log a set during workout
router.post('/:id/sets', auth, (req, res) => {
  const { exercise_name, muscle_group, reps, weight_lbs, set_number } = req.body;
  if (!exercise_name) return res.status(400).json({ error: 'exercise_name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO workout_sets (id, session_id, user_id, exercise_name, muscle_group, set_number, reps, weight_lbs) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.params.id, req.user.id, exercise_name, muscle_group || null, set_number || 1, reps || null, weight_lbs || null);

  // Update muscle_groups on the session
  const session = db.prepare('SELECT muscle_groups FROM workout_sessions WHERE id=?').get(req.params.id);
  let groups = [];
  try { groups = JSON.parse(session?.muscle_groups || '[]'); } catch {}
  if (muscle_group && !groups.includes(muscle_group)) {
    groups.push(muscle_group);
    db.prepare('UPDATE workout_sessions SET muscle_groups=? WHERE id=?').run(JSON.stringify(groups), req.params.id);
  }

  const set = db.prepare('SELECT * FROM workout_sets WHERE id=?').get(id);
  res.status(201).json({ set });
});

// Get sets for a session
router.get('/:id/sets', auth, (req, res) => {
  const sets = db.prepare('SELECT * FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY logged_at ASC').all(req.params.id, req.user.id);
  res.json({ sets });
});

// Get workout summary
router.get('/:id', auth, (req, res) => {
  const session = db.prepare('SELECT * FROM workout_sessions WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const sets = db.prepare('SELECT * FROM workout_sets WHERE session_id=? ORDER BY logged_at ASC').all(req.params.id);
  res.json({
    session: { ...session, muscle_groups: JSON.parse(session.muscle_groups || '[]') },
    sets,
  });
});

// Get recent workouts
router.get('/', auth, (req, res) => {
  const sessions = db.prepare('SELECT * FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 20').all(req.user.id);
  res.json({ sessions: sessions.map(s => ({ ...s, muscle_groups: JSON.parse(s.muscle_groups || '[]') })) });
});

module.exports = router;
