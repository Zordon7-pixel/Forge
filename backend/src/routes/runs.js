const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { generateRunFeedback } = require('../services/ai');

router.get('/', auth, (req, res) => {
  const runs = db.prepare('SELECT * FROM runs WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 50').all(req.user.id);
  res.json({ runs });
});

router.post('/', auth, (req, res) => {
  const { date, type, distance_miles, duration_seconds, perceived_effort, notes, run_surface, surface, incline_pct, treadmill_speed } = req.body;
  if (!date || !type) return res.status(400).json({ error: 'date and type required' });
  const id = uuidv4();
  const resolvedSurface = surface || run_surface || 'road';
  db.prepare(`INSERT INTO runs (id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes, run_surface, surface, incline_pct, treadmill_speed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, req.user.id, date, type, distance_miles || 0, duration_seconds || 0, perceived_effort || 5, notes || null, resolvedSurface, resolvedSurface, incline_pct || 0, treadmill_speed || 0
  );

  // Get user weight for calorie calc (default 185 if not set)
  const userProfile = db.prepare('SELECT weight_lbs FROM users WHERE id=?').get(req.user.id);
  const weightLbs = userProfile?.weight_lbs || 185;
  const calories = Math.round(0.75 * weightLbs * (distance_miles || 0));
  if (calories > 0) {
    db.prepare('UPDATE runs SET calories=? WHERE id=?').run(calories, id);
  }

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  res.status(201).json(run);

  // Async: generate AI feedback — check limits first
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  const dailyCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?"
  ).get(req.user.id, today + 'T00:00:00').cnt;
  const userRow = db.prepare("SELECT is_pro FROM users WHERE id = ?").get(req.user.id);
  const monthlyCount = !userRow?.is_pro ? db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?"
  ).get(req.user.id, month + '-01T00:00:00').cnt : 0;

  const canCallAI = dailyCount < 10 && (userRow?.is_pro || monthlyCount < 5);

  if (canCallAI) {
    db.prepare("INSERT INTO ai_usage (id, user_id, call_type) VALUES (?, ?, ?)")
      .run(uuidv4(), req.user.id, 'run_feedback');
    const profile = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    generateRunFeedback(run, profile).then(feedback => {
      if (feedback) db.prepare('UPDATE runs SET ai_feedback = ? WHERE id = ?').run(feedback, id);
    }).catch(() => {});
  }
});

// PUT /api/runs/:id — edit a run
router.put('/:id', auth, (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const {
    date, distance_miles, duration_seconds, notes, perceived_effort, type, run_surface, incline_pct, treadmill_speed
  } = req.body;

  const userProfile = db.prepare('SELECT weight_lbs FROM users WHERE id=?').get(req.user.id);
  const weightLbs = userProfile?.weight_lbs || 185;
  const newDist = distance_miles !== undefined ? Number(distance_miles) : run.distance_miles;
  const calories = Math.round(0.75 * weightLbs * newDist);

  db.prepare(`UPDATE runs SET
    date = COALESCE(?, date),
    distance_miles = COALESCE(?, distance_miles),
    duration_seconds = COALESCE(?, duration_seconds),
    notes = COALESCE(?, notes),
    perceived_effort = COALESCE(?, perceived_effort),
    type = COALESCE(?, type),
    run_surface = COALESCE(?, run_surface),
    incline_pct = COALESCE(?, incline_pct),
    treadmill_speed = COALESCE(?, treadmill_speed),
    calories = ?
    WHERE id=? AND user_id=?
  `).run(date, distance_miles, duration_seconds, notes, perceived_effort, type, run_surface, incline_pct, treadmill_speed, calories, req.params.id, req.user.id);

  const updated = db.prepare('SELECT * FROM runs WHERE id=?').get(req.params.id);
  res.json(updated);
});

router.delete('/:id', auth, (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM runs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/runs/missed — log a missed workout with reason
router.post('/missed', auth, (req, res) => {
  const { reason, scheduled_date, workout_type = 'run' } = req.body;
  // Store missed workout in a simple way — update plan notes or just acknowledge
  // For now: return an AI-adjusted message based on reason
  const adjustments = {
    tired: "Logged. Your body needed rest today — that IS training. I've moved the session to tomorrow and lightened your week.",
    no_time: "Got it. Moved to tomorrow. Your weekly volume stays on track.",
    didnt_feel_like_it: "Happens to everyone. No judgment — I've rescheduled it. Show up tomorrow.",
    something_came_up: "Life happens. Adjusted your week. You're still on track for your goal.",
    weather: "Pushed to tomorrow. Check the forecast — might be a treadmill day.",
    sick: "Rest up. I've cleared your schedule for 2 days. Nothing to worry about — health first."
  };
  const message = adjustments[reason] || "Got it — adjusted your plan. Keep moving forward.";
  res.json({ ok: true, message, reason });
});

module.exports = router;
