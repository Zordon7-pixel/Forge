const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { dbGet, dbAll, dbRun } = require('../db');
const auth    = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const sign = (user) => jwt.sign(
  { id: user.id, name: user.name, email: user.email, onboarded: user.onboarded, coach_personality: user.coach_personality },
  process.env.JWT_SECRET,
  { expiresIn: '30d' }
);

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email?.trim().toLowerCase()]);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email, onboarded: user.onboarded } });
  } catch (err) { res.status(500).json({ error: 'Login failed' }); }
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'Name, email, and password required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const emailNorm = email.trim().toLowerCase();
    if (await dbGet('SELECT id FROM users WHERE email = ?', [emailNorm]))
      return res.status(409).json({ error: 'Email already in use' });
    const id = uuidv4();
    await dbRun(`INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)`,
      [id, name.trim(), emailNorm, bcrypt.hashSync(password, 10)]);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
    res.status(201).json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email, onboarded: 0 } });
  } catch (err) { res.status(500).json({ error: 'Registration failed' }); }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required.' });
    const user = await dbGet('SELECT id, email FROM users WHERE LOWER(email) = ?', [email.trim().toLowerCase()]);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      await dbRun('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)',
        [uuidv4(), user.id, token, expiresAt]);
      console.log(`PASSWORD RESET LINK: /reset-password?token=${token}`);
    }
    res.json({ ok: true });
  } catch (err) { res.json({ ok: true }); }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const record = await dbGet('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?',
      [token, new Date().toISOString()]);
    if (!record) return res.status(400).json({ error: 'Reset link is invalid or expired.' });
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), record.user_id]);
    await dbRun('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [record.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Reset failed' }); }
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await dbGet(
      `SELECT id, name, email, sex, age, weight_lbs, max_heart_rate, weekly_miles_current, goal_type,
       goal_race_date, goal_race_distance, injury_notes, comeback_mode, onboarded, coach_personality,
       run_days_per_week, lift_days_per_week, injury_mode, injury_description, injury_date,
       injury_limitations, units FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    const normalized = {
      ...user,
      weekly_miles: user.weekly_miles_current,
      primary_goal: user.goal_type,
      injury_status: user.injury_notes ? 'recovering' : 'none',
      injury_detail: user.injury_notes,
      fitness_level: user.comeback_mode ? 'intermediate' : 'beginner',
      age: user.age ?? null,
      weight_lbs: user.weight_lbs ?? null,
      max_heart_rate: user.max_heart_rate ?? null,
      injury_mode: !!user.injury_mode,
      injury_description: user.injury_description || '',
      injury_date: user.injury_date || '',
      injury_limitations: user.injury_limitations || ''
    };
    res.json({ user: normalized });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch profile' }); }
});

router.put('/me/profile', auth, async (req, res) => {
  try {
    const {
      name, weekly_miles, primary_goal, injury_detail, injury_status,
      weekly_miles_current, goal_type, goal_race_date, goal_race_distance, injury_notes,
      comeback_mode, coach_personality, run_days_per_week, lift_days_per_week, sex,
      schedule_type, lifestyle, preferred_workout_time, preferred_workout_days,
      missed_workout_pref, weekly_workout_days, age, weight_lbs, max_heart_rate, units
    } = req.body;

    const mappedWeekly = weekly_miles ?? weekly_miles_current;
    const mappedGoal = primary_goal ?? goal_type;
    const mappedInjury = injury_detail ?? injury_notes;
    const mappedComeback = comeback_mode ?? (injury_status && injury_status !== 'none' ? 1 : null);

    await dbRun(`UPDATE users SET
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
      age = COALESCE(?, age),
      weight_lbs = COALESCE(?, weight_lbs),
      max_heart_rate = COALESCE(?, max_heart_rate),
      units = COALESCE(?, units),
      onboarded = 1
      WHERE id = ?`, [
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
      age ?? null,
      weight_lbs ?? null,
      max_heart_rate ?? null,
      units ?? null,
      req.user.id
    ]);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json({ token: sign(user), user });
  } catch (err) { res.status(500).json({ error: 'Profile update failed' }); }
});

router.post('/injury', auth, async (req, res) => {
  try {
    const { injury_mode, injury_description, injury_date, injury_limitations } = req.body;
    await dbRun(`UPDATE users SET injury_mode=?, injury_description=?, injury_date=?, injury_limitations=? WHERE id=?`,
      [injury_mode ? 1 : 0, injury_description || '', injury_date || '', injury_limitations || '', req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to update injury' }); }
});

router.get('/me/stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();

    const getRuns = async (daysBack) => {
      const since = new Date(now - daysBack * 86400000).toISOString().slice(0, 10);
      return dbAll('SELECT * FROM runs WHERE user_id=? AND date >= ? ORDER BY date DESC', [userId, since]);
    };

    const [dayRuns, weekRuns, monthRuns, yearRuns, allRuns] = await Promise.all([
      getRuns(1), getRuns(7), getRuns(30), getRuns(365),
      dbAll('SELECT * FROM runs WHERE user_id=? ORDER BY date DESC', [userId])
    ]);

    const summarize = (runs) => {
      const miles = runs.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
      const seconds = runs.reduce((s, r) => s + Number(r.duration_seconds || 0), 0);
      const calsBurned = runs.reduce((s, r) => s + Math.round(0.75 * 185 * Number(r.distance_miles || 0)), 0);
      return { count: runs.length, miles: Math.round(miles * 100) / 100, seconds, calories: calsBurned };
    };

    const weeklyTrendPromises = [];
    for (let w = 11; w >= 0; w--) {
      const wStart = new Date(now - (w + 1) * 7 * 86400000).toISOString().slice(0, 10);
      const wEnd = new Date(now - w * 7 * 86400000).toISOString().slice(0, 10);
      weeklyTrendPromises.push(
        dbAll('SELECT distance_miles FROM runs WHERE user_id=? AND date >= ? AND date < ?', [userId, wStart, wEnd])
          .then(wRuns => ({
            week: wStart,
            miles: Math.round(wRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0) * 100) / 100
          }))
      );
    }
    const weeklyTrend = await Promise.all(weeklyTrendPromises);

    const workoutDates = await dbAll('SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL', [userId]);
    const allDates = new Set([
      ...allRuns.map(r => (r.date || r.created_at || '').slice(0, 10)),
      ...workoutDates.map(s => (s.started_at || '').slice(0, 10))
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

    const calendarDays = [];
    for (let d = 6; d >= 0; d--) {
      const dateStr = new Date(now - d * 86400000).toISOString().slice(0, 10);
      const dayName = new Date(now - d * 86400000).toLocaleDateString('en-US', { weekday: 'short' });
      const dayRun = allRuns.find(r => (r.date || r.created_at || '').slice(0, 10) === dateStr);
      const dayLifts = await dbAll(
        "SELECT id, ended_at, notes FROM workout_sessions WHERE user_id=? AND started_at LIKE ? AND ended_at IS NOT NULL",
        [userId, `${dateStr}%`]
      );
      calendarDays.push({
        date: dateStr, day: dayName,
        hasRun: !!dayRun, hasLift: allDates.has(dateStr), isToday: dateStr === today,
        run: dayRun ? { distance: dayRun.distance_miles, duration: dayRun.duration_seconds, type: dayRun.type || 'run', surface: dayRun.surface, notes: dayRun.notes } : null,
        lifts: dayLifts.length > 0 ? dayLifts.length : null
      });
    }

    res.json({ day: summarize(dayRuns), week: summarize(weekRuns), month: summarize(monthRuns), year: summarize(yearRuns), all: summarize(allRuns), weeklyTrend, streak, calendarDays });
  } catch (err) { res.status(500).json({ error: 'Stats fetch failed' }); }
});

router.get('/me/streak', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [runRows, liftRows] = await Promise.all([
      dbAll("SELECT date, created_at FROM runs WHERE user_id=?", [userId]),
      dbAll("SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL", [userId])
    ]);
    const runDates = runRows.map(r => (r.date || r.created_at || '').slice(0, 10)).filter(Boolean);
    const liftDates = liftRows.map(s => (s.started_at || '').slice(0, 10)).filter(Boolean);
    const uniqueDates = [...new Set([...runDates, ...liftDates])].sort();

    const dateSet = new Set(uniqueDates);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const yesterdayStr = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    let currentStreak = 0;
    let check = dateSet.has(todayStr) ? todayStr : dateSet.has(yesterdayStr) ? yesterdayStr : null;
    while (check && dateSet.has(check)) {
      currentStreak++;
      const d = new Date(check); d.setDate(d.getDate() - 1);
      check = d.toISOString().slice(0, 10);
    }

    let bestStreak = uniqueDates.length ? 1 : 0;
    let cur = 1;
    for (let i = 1; i < uniqueDates.length; i++) {
      const diffDays = Math.round((new Date(uniqueDates[i]) - new Date(uniqueDates[i - 1])) / 86400000);
      cur = diffDays === 1 ? cur + 1 : 1;
      if (cur > bestStreak) bestStreak = cur;
    }

    res.json({ currentStreak, bestStreak });
  } catch (err) { res.status(500).json({ error: 'Streak fetch failed' }); }
});

router.get('/me/ai-usage', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    const user = await dbGet("SELECT is_pro FROM users WHERE id = ?", [req.user.id]);

    const [dailyRow, monthlyRow] = await Promise.all([
      dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?", [req.user.id, today + 'T00:00:00']),
      dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?", [req.user.id, month + '-01T00:00:00'])
    ]);

    res.json({
      is_pro: !!user?.is_pro,
      daily: { used: Number(dailyRow?.cnt || 0), limit: 10 },
      monthly: { used: Number(monthlyRow?.cnt || 0), limit: user?.is_pro ? null : 5 }
    });
  } catch (err) { res.status(500).json({ error: 'AI usage fetch failed' }); }
});

module.exports = router;
