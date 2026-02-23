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
  const user = db.prepare('SELECT id, name, email, sex, weekly_miles_current, goal_type, goal_race_date, goal_race_distance, injury_notes, comeback_mode, onboarded, coach_personality, run_days_per_week, lift_days_per_week, injury_mode, injury_description, injury_date, injury_limitations FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const normalized = {
    ...user,
    weekly_miles: user.weekly_miles_current,
    primary_goal: user.goal_type,
    injury_status: user.injury_notes ? 'recovering' : 'none',
    injury_detail: user.injury_notes,
    fitness_level: user.comeback_mode ? 'intermediate' : 'beginner',
    age: null,
    weight_lbs: null,
    injury_mode: !!user.injury_mode,
    injury_description: user.injury_description || '',
    injury_date: user.injury_date || '',
    injury_limitations: user.injury_limitations || ''
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
    lift_days_per_week,
    sex,
    schedule_type,
    lifestyle,
    preferred_workout_time,
    preferred_workout_days,
    missed_workout_pref,
    weekly_workout_days
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
    sex = COALESCE(?, sex),
    schedule_type = COALESCE(?, schedule_type),
    lifestyle = COALESCE(?, lifestyle),
    preferred_workout_time = COALESCE(?, preferred_workout_time),
    preferred_workout_days = COALESCE(?, preferred_workout_days),
    missed_workout_pref = COALESCE(?, missed_workout_pref),
    weekly_workout_days = COALESCE(?, weekly_workout_days),
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
    sex ?? null,
    schedule_type ?? null,
    lifestyle ?? null,
    preferred_workout_time ?? null,
    preferred_workout_days ? JSON.stringify(preferred_workout_days) : null,
    missed_workout_pref ?? null,
    weekly_workout_days ?? null,
    req.user.id
  );
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ token: sign(user), user });
});


router.post('/injury', auth, (req, res) => {
  const { injury_mode, injury_description, injury_date, injury_limitations } = req.body;
  db.prepare(`UPDATE users SET injury_mode=?, injury_description=?, injury_date=?, injury_limitations=? WHERE id=?`)
    .run(injury_mode ? 1 : 0, injury_description || '', injury_date || '', injury_limitations || '', req.user.id);
  res.json({ ok: true });
});

// GET /api/auth/me/stats — summary stats for various time periods
router.get('/me/stats', auth, (req, res) => {
  const userId = req.user.id;
  const now = new Date();

  // Helper: get runs for a time window
  const getRuns = (daysBack) => {
    const since = new Date(now - daysBack * 86400000).toISOString().slice(0, 10);
    return db.prepare('SELECT * FROM runs WHERE user_id=? AND date >= ? ORDER BY date DESC').all(userId, since);
  };

  const getWorkouts = (daysBack) => {
    const since = new Date(now - daysBack * 86400000).toISOString();
    return db.prepare('SELECT * FROM workout_sessions WHERE user_id=? AND started_at >= ? AND ended_at IS NOT NULL').all(userId, since);
  };

  const weekRuns = getRuns(7);
  const monthRuns = getRuns(30);
  const yearRuns = getRuns(365);
  const allRuns = db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY date DESC').all(userId);

  const summarize = (runs) => {
    const miles = runs.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
    const seconds = runs.reduce((s, r) => s + Number(r.duration_seconds || 0), 0);
    const calsBurned = runs.reduce((s, r) => s + Math.round(0.75 * 185 * Number(r.distance_miles || 0)), 0); // ~185lb default
    return { count: runs.length, miles: Math.round(miles * 100) / 100, seconds, calories: calsBurned };
  };

  // Weekly mileage for past 12 weeks (for trend chart)
  const weeklyTrend = [];
  for (let w = 11; w >= 0; w--) {
    const wStart = new Date(now - (w + 1) * 7 * 86400000).toISOString().slice(0, 10);
    const wEnd = new Date(now - w * 7 * 86400000).toISOString().slice(0, 10);
    const wRuns = db.prepare('SELECT distance_miles FROM runs WHERE user_id=? AND date >= ? AND date < ?').all(userId, wStart, wEnd);
    const wMiles = wRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
    weeklyTrend.push({ week: wStart, miles: Math.round(wMiles * 100) / 100 });
  }

  // Activity streak (consecutive days with any run OR workout_session)
  const allDates = new Set([
    ...allRuns.map(r => r.date?.slice(0, 10) || r.created_at?.slice(0, 10)),
    ...db.prepare('SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL').all(userId).map(s => s.started_at.slice(0, 10))
  ]);

  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
  let streak = 0;
  if (allDates.has(today) || allDates.has(yesterday)) {
    let check = allDates.has(today) ? today : yesterday;
    while (allDates.has(check)) {
      streak++;
      const d = new Date(check);
      d.setDate(d.getDate() - 1);
      check = d.toISOString().slice(0, 10);
    }
  }

  // Last 7 days activity calendar
  const calendarDays = [];
  for (let d = 6; d >= 0; d--) {
    const dateStr = new Date(now - d * 86400000).toISOString().slice(0, 10);
    const dayName = new Date(now - d * 86400000).toLocaleDateString('en-US', { weekday: 'short' });
    calendarDays.push({
      date: dateStr,
      day: dayName,
      hasRun: allRuns.some(r => (r.date || r.created_at || '').slice(0, 10) === dateStr),
      hasLift: allDates.has(dateStr),
      isToday: dateStr === today
    });
  }

  res.json({
    week: summarize(weekRuns),
    month: summarize(monthRuns),
    year: summarize(yearRuns),
    all: summarize(allRuns),
    weeklyTrend,
    streak,
    calendarDays
  });
});

router.get('/me/ai-usage', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  const user = db.prepare("SELECT is_pro FROM users WHERE id = ?").get(req.user.id);
  
  const daily = db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?"
  ).get(req.user.id, today + 'T00:00:00').cnt;
  
  const monthly = db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?"
  ).get(req.user.id, month + '-01T00:00:00').cnt;

  res.json({
    is_pro: !!user?.is_pro,
    daily: { used: daily, limit: 10 },
    monthly: { used: monthly, limit: user?.is_pro ? null : 5 }
  });
});

module.exports = router;
