const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const { checkAiLimit } = require('../middleware/aiLimit');
const { v4: uuidv4 } = require('uuid');
const { generateTrainingPlan } = require('../services/ai');

router.get('/current', auth, (req, res) => {
  const plan = db.prepare('SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
  if (!plan) return res.json({ plan: null });
  res.json({ plan: { ...plan, plan_json: JSON.parse(plan.plan_json) } });
});

router.post('/generate', auth, checkAiLimit('plan_generate'), async (req, res) => {
  const profile = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!profile) return res.status(404).json({ error: 'User not found' });

  const planData = await generateTrainingPlan(profile);
  if (!planData) {
    // Fallback: generate a simple static plan
    const fallback = generateFallbackPlan(profile);
    const id = uuidv4();
    const weekStart = getMonday();
    db.prepare('INSERT INTO training_plans (id, user_id, week_start, plan_json) VALUES (?, ?, ?, ?)')
      .run(id, req.user.id, weekStart, JSON.stringify(fallback));
    return res.json({ plan: { id, user_id: req.user.id, week_start: weekStart, plan_json: fallback } });
  }

  const id = uuidv4();
  const weekStart = getMonday();
  db.prepare('INSERT INTO training_plans (id, user_id, week_start, plan_json) VALUES (?, ?, ?, ?)')
    .run(id, req.user.id, weekStart, JSON.stringify(planData));
  res.json({ plan: { id, user_id: req.user.id, week_start: weekStart, plan_json: planData } });
});

function getMonday() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function generateFallbackPlan(profile) {
  const base = profile.weekly_miles_current || 10;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weeks = [1, 2, 3, 4].map(w => ({
    week: w,
    theme: w === 4 ? 'Recovery Week' : w === 1 ? 'Foundation' : w === 2 ? 'Build' : 'Peak',
    total_miles: w === 4 ? Math.round(base * 0.8) : Math.round(base * (1 + (w - 1) * 0.1)),
    days: days.map(day => {
      const isRest = ['Tue', 'Thu', 'Sun'].includes(day);
      const isLong = day === 'Sat';
      if (isRest) return { day, type: 'rest', distance_miles: 0, duration_min: 0, description: 'Rest and recovery', rest: true };
      if (isLong) return { day, type: 'long', distance_miles: Math.round(base * 0.35 * (w === 4 ? 0.8 : 1) * 10) / 10, duration_min: 0, description: 'Long easy run — conversational pace', rest: false };
      return { day, type: 'easy', distance_miles: Math.round(base * 0.2 * (w === 4 ? 0.8 : 1) * 10) / 10, duration_min: 0, description: 'Easy effort run', rest: false };
    }),
  }));
  return { weeks };
}

module.exports = router;
