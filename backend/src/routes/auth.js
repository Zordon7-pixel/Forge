const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const auth    = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const sign = (user) => jwt.sign(
  { id: user.id, name: user.name, email: user.email, onboarded: user.onboarded, coach_personality: user.coach_personality },
  process.env.JWT_SECRET,
  { expiresIn: '30d' }
);

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email, onboarded: user.onboarded } });
});

router.post('/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.trim() || !password)
    return res.status(400).json({ error: 'Name, email, and password required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const emailNorm = email.trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm))
    return res.status(409).json({ error: 'Email already in use' });
  const id = uuidv4();
  db.prepare(`INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)`)
    .run(id, name.trim(), emailNorm, bcrypt.hashSync(password, 10));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email, onboarded: 0 } });
});

router.get('/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, weekly_miles_current, goal_type, goal_race_date, goal_race_distance, injury_notes, comeback_mode, onboarded, coach_personality, run_days_per_week, lift_days_per_week FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const normalized = {
    ...user,
    weekly_miles: user.weekly_miles_current,
    primary_goal: user.goal_type,
    injury_status: user.injury_notes ? 'recovering' : 'none',
    injury_detail: user.injury_notes,
    fitness_level: user.comeback_mode ? 'intermediate' : 'beginner',
    age: null,
    weight_lbs: null
  };

  res.json({ user: normalized });
});

router.put('/me/profile', auth, (req, res) => {
  const {
    name,
    weekly_miles,
    primary_goal,
    injury_detail,
    injury_status,
    weekly_miles_current,
    goal_type,
    goal_race_date,
    goal_race_distance,
    injury_notes,
    comeback_mode,
    coach_personality,
    run_days_per_week,
    lift_days_per_week
  } = req.body;

  const mappedWeekly = weekly_miles ?? weekly_miles_current;
  const mappedGoal = primary_goal ?? goal_type;
  const mappedInjury = injury_detail ?? injury_notes;
  const mappedComeback = comeback_mode ?? (injury_status && injury_status !== 'none' ? 1 : null);

  db.prepare(`UPDATE users SET
    name = COALESCE(?, name),
    weekly_miles_current = COALESCE(?, weekly_miles_current),
    goal_type = COALESCE(?, goal_type),
    goal_race_date = COALESCE(?, goal_race_date),
    goal_race_distance = COALESCE(?, goal_race_distance),
    injury_notes = COALESCE(?, injury_notes),
    comeback_mode = COALESCE(?, comeback_mode),
    coach_personality = COALESCE(?, coach_personality),
    run_days_per_week = COALESCE(?, run_days_per_week),
    lift_days_per_week = COALESCE(?, lift_days_per_week),
    onboarded = 1
    WHERE id = ?`).run(
    name ?? null,
    mappedWeekly ?? null,
    mappedGoal ?? null,
    goal_race_date ?? null,
    goal_race_distance ?? null,
    mappedInjury ?? null,
    mappedComeback ?? null,
    coach_personality ?? null,
    run_days_per_week ?? null,
    lift_days_per_week ?? null,
    req.user.id
  );
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ token: sign(user), user });
});

module.exports = router;
