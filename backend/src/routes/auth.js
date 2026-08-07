const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { dbGet, dbAll, dbRun, withTransaction, withUserMutation } = require('../db');
const auth    = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { isMailConfigured, sendPasswordResetEmail } = require('../services/mail');
const {
  ACCOUNT_DELETE_QUERIES,
  ACCOUNT_EXPORT_TABLES,
  ACCOUNT_SOCIAL_DELETE_QUERIES,
  bindUserId,
  buildExportSql,
} = require('../lib/accountDataCoverage');
const { computeStreak, serverUtcAnchorCandidates } = require('../lib/streak');
const backendPackage = require('../../package.json');
const { WAIVER_VERSION } = require('../lib/waiverText');
const { runActivitySql } = require('../lib/runActivity');
const { cleanupOwnedSocialChallenges } = require('../lib/challengeOwnership');
const { aiUsageWindows, resolveEntitlement } = require('../lib/betaAccess');
const { normalizeTrainingDays } = require('../lib/runSchedule');

const sign = (user) => jwt.sign(
  { id: user.id, name: user.name, email: user.email, onboarded: user.onboarded, coach_personality: user.coach_personality },
  process.env.JWT_SECRET,
  { expiresIn: '30d' }
);

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const forgotPasswordResponses = {
  emailSent: {
    ok: true,
    status: 'email_sent',
    message: 'If an account exists for that email, a password reset link has been sent.'
  },
  emailUnavailable: {
    ok: false,
    status: 'email_unavailable',
    message: 'Password reset email is currently unavailable. Please try again later.'
  }
};

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
    const { name, email, password, accepted_waiver_version } = req.body;
    if (!name?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'Name, email, and password required' });
    if (accepted_waiver_version !== WAIVER_VERSION)
      return res.status(400).json({ error: 'You must accept the medical disclaimer to register.' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const emailNorm = email.trim().toLowerCase();
    if (!emailRegex.test(emailNorm))
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (await dbGet('SELECT id FROM users WHERE email = ?', [emailNorm]))
      return res.status(409).json({ error: 'Email already in use' });
    const id = uuidv4();
    await dbRun(`INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)`,
      [id, name.trim(), emailNorm, bcrypt.hashSync(password, 10)]);
    await dbRun(
      `INSERT INTO user_consents (id, user_id, consent_type, version, ip)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, consent_type, version) DO NOTHING`,
      [uuidv4(), id, 'medical_waiver', WAIVER_VERSION, req.ip]
    );
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
    res.status(201).json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email, onboarded: 0 } });
  } catch (err) { res.status(500).json({ error: 'Registration failed' }); }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const emailNorm = email?.trim().toLowerCase();

    if (!emailNorm) return res.status(400).json({ error: 'Email is required.' });
    if (!emailRegex.test(emailNorm)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    if (!isMailConfigured()) {
      return res.status(503).json(forgotPasswordResponses.emailUnavailable);
    }

    const user = await dbGet('SELECT id, email FROM users WHERE LOWER(email) = ?', [emailNorm]);

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      try {
        await withUserMutation(user.id, (tx) => tx.run(
          'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)',
          [uuidv4(), user.id, token, expiresAt]
        ));
      } catch (err) {
        if (err.code === 'AUTH_ACCOUNT_DELETED') return res.json(forgotPasswordResponses.emailSent);
        throw err;
      }

      try {
        await sendPasswordResetEmail({ to: user.email, token });
      } catch (mailErr) {
        console.error('[auth/forgot-password] email failed:', mailErr.message);
        return res.status(503).json(forgotPasswordResponses.emailUnavailable);
      }
    }

    return res.json(forgotPasswordResponses.emailSent);
  } catch (err) {
    console.error('Forgot password failed:', err);
    return res.status(500).json({
      ok: false,
      status: 'error',
      error: 'Unable to process password reset right now.'
    });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const record = await dbGet('SELECT user_id FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?',
      [token, new Date().toISOString()]);
    if (!record) return res.status(400).json({ error: 'Reset link is invalid or expired.' });
    const passwordHash = bcrypt.hashSync(password, 10);
    const reset = await withUserMutation(record.user_id, async (tx) => {
      const activeRecord = await tx.get(
        `SELECT id FROM password_reset_tokens
         WHERE token = ? AND user_id = ? AND used = 0 AND expires_at > ?
         FOR UPDATE`,
        [token, record.user_id, new Date().toISOString()]
      );
      if (!activeRecord) return false;
      const updated = await tx.run(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [passwordHash, record.user_id]
      );
      if (updated.changes !== 1) return false;
      const consumed = await tx.run(
        'UPDATE password_reset_tokens SET used = 1 WHERE id = ? AND user_id = ? AND used = 0',
        [activeRecord.id, record.user_id]
      );
      return consumed.changes === 1;
    });
    if (!reset) return res.status(400).json({ error: 'Reset link is invalid or expired.' });
    return res.json({ ok: true });
  } catch (err) {
    if (err.code === 'AUTH_ACCOUNT_DELETED') {
      return res.status(400).json({ error: 'Reset link is invalid or expired.' });
    }
    console.error('[auth/reset-password] failed:', err.message);
    return res.status(500).json({ error: 'Reset failed' });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await dbGet(
      `SELECT id, name, email, sex, age, weight_lbs, max_heart_rate, weekly_miles_current, goal_type,
       goal_race_date, goal_race_distance, injury_notes, comeback_mode, onboarded, coach_personality,
       run_days_per_week, lift_days_per_week, injury_mode, injury_description, injury_date,
       injury_limitations, units, is_pro, subscription_status, subscription_ends_at FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    const waiver = await dbGet(
      `SELECT id FROM user_consents
       WHERE user_id = ? AND consent_type = ? AND version = ?
       LIMIT 1`,
      [req.user.id, 'medical_waiver', WAIVER_VERSION]
    );
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
      injury_limitations: user.injury_limitations || '',
      is_pro: !!user.is_pro,
      subscription_status: user.subscription_status || 'free',
      entitlement: resolveEntitlement(user),
      waiver_current: !!waiver
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

    if (age !== undefined && age !== null && (Number(age) < 10 || Number(age) > 110)) {
      return res.status(400).json({ error: 'Age must be between 10 and 110.' });
    }
    if (weight_lbs !== undefined && weight_lbs !== null && (Number(weight_lbs) < 50 || Number(weight_lbs) > 700)) {
      return res.status(400).json({ error: 'Weight must be between 50 and 700 lbs.' });
    }
    if (max_heart_rate !== undefined && max_heart_rate !== null && (Number(max_heart_rate) < 100 || Number(max_heart_rate) > 220)) {
      return res.status(400).json({ error: 'Max heart rate must be between 100 and 220 bpm.' });
    }
    const hasRunFrequency = run_days_per_week !== undefined && run_days_per_week !== null;
    const normalizedRunFrequency = hasRunFrequency ? Number(run_days_per_week) : null;
    if (hasRunFrequency && (!Number.isInteger(normalizedRunFrequency) || normalizedRunFrequency < 1 || normalizedRunFrequency > 6)) {
      return res.status(400).json({ error: 'Run days per week must be a whole number from 1 to 6.' });
    }
    const hasPreferredDays = preferred_workout_days !== undefined && preferred_workout_days !== null;
    const normalizedPreferredDays = hasPreferredDays ? normalizeTrainingDays(preferred_workout_days) : null;
    if (hasPreferredDays && (!Array.isArray(preferred_workout_days)
      || normalizedPreferredDays.length !== new Set(preferred_workout_days.map((day) => String(day || '').trim().slice(0, 3).toLowerCase())).size)) {
      return res.status(400).json({ error: 'Preferred workout days must contain valid weekdays.' });
    }

    const mappedWeekly = weekly_miles ?? weekly_miles_current;
    if (mappedWeekly !== undefined && mappedWeekly !== null) {
      const normalizedWeeklyMiles = Number(mappedWeekly);
      if ((typeof mappedWeekly === 'string' && !mappedWeekly.trim())
        || !Number.isFinite(normalizedWeeklyMiles)
        || normalizedWeeklyMiles < 0
        || normalizedWeeklyMiles > 300) {
        return res.status(400).json({ error: 'Weekly miles must be between 0 and 300.' });
      }
    }
    const mappedGoal = primary_goal ?? goal_type;
    const mappedInjury = injury_detail ?? injury_notes;
    const mappedComeback = comeback_mode ?? (injury_status && injury_status !== 'none' ? 1 : null);

    const mutation = await withUserMutation(req.user.id, async (tx) => {
      const previous = await tx.get(
        'SELECT run_days_per_week, preferred_workout_days FROM users WHERE id=? FOR UPDATE',
        [req.user.id]
      );
      if (!previous) return { notFound: true };
      const previousPreferredDays = normalizeTrainingDays(previous.preferred_workout_days);
      const nextRunFrequency = hasRunFrequency ? normalizedRunFrequency : Number(previous.run_days_per_week || 3);
      const nextPreferredDays = hasPreferredDays ? normalizedPreferredDays : previousPreferredDays;
      if (nextPreferredDays.length > 0 && nextRunFrequency > nextPreferredDays.length) {
        return { validationError: 'Run days per week cannot exceed the selected preferred workout days.' };
      }

      const updateResult = await tx.run(`UPDATE users SET
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
        hasRunFrequency ? normalizedRunFrequency : null,
        lift_days_per_week ?? null,
        sex ?? null,
        schedule_type ?? null,
        lifestyle ?? null,
        preferred_workout_time ?? null,
        hasPreferredDays ? JSON.stringify(normalizedPreferredDays) : null,
        missed_workout_pref ?? null,
        weekly_workout_days ?? null,
        age ?? null,
        weight_lbs ?? null,
        max_heart_rate ?? null,
        units ?? null,
        req.user.id
      ]);
      if (updateResult.changes !== 1) throw new Error('Profile owner update failed');

      const frequencyChanged = hasRunFrequency && Number(previous.run_days_per_week) !== normalizedRunFrequency;
      const weekdaysChanged = hasPreferredDays
        && JSON.stringify(previousPreferredDays) !== JSON.stringify(normalizedPreferredDays);
      if (frequencyChanged || weekdaysChanged) {
        const reviewRequired = {
          reason: frequencyChanged ? 'run_frequency_changed' : 'training_days_changed',
          previousRunDaysPerWeek: Number(previous.run_days_per_week || 3),
          requestedRunDaysPerWeek: nextRunFrequency,
          previousWeekdayCount: previousPreferredDays.length,
          requestedWeekdayCount: hasPreferredDays ? normalizedPreferredDays.length : previousPreferredDays.length,
          changedAt: new Date().toISOString(),
        };
        const activePlan = await tx.get(
          `SELECT id, progress_json FROM user_plans
           WHERE user_id=? AND status='active'
           ORDER BY created_at DESC LIMIT 1
           FOR UPDATE`,
          [req.user.id]
        );
        if (activePlan) {
          let progress = {};
          try {
            progress = JSON.parse(activePlan.progress_json || '{}');
          } catch (err) {
            console.error('[auth/profile] invalid active plan progress JSON:', err.message);
          }
          progress.planReviewRequired = reviewRequired;
          const reviewResult = await tx.run(
            `UPDATE user_plans SET progress_json=?
             WHERE id=? AND user_id=? AND status='active'`,
            [JSON.stringify(progress), activePlan.id, req.user.id]
          );
          if (reviewResult.changes !== 1) throw new Error('Active plan review marker update failed');
        } else {
          const legacyPlan = await tx.get(
            `SELECT id, plan_json, plan_data FROM training_plans
             WHERE user_id=? ORDER BY created_at DESC LIMIT 1
             FOR UPDATE`,
            [req.user.id]
          );
          if (legacyPlan) {
            let planData = {};
            try {
              planData = JSON.parse(legacyPlan.plan_data || legacyPlan.plan_json || '{}');
            } catch (err) {
              console.error('[auth/profile] invalid legacy plan JSON:', err.message);
            }
            planData.planReviewRequired = reviewRequired;
            const serialized = JSON.stringify(planData);
            const reviewResult = legacyPlan.plan_data
              ? await tx.run(
                'UPDATE training_plans SET plan_data=? WHERE id=? AND user_id=?',
                [serialized, legacyPlan.id, req.user.id]
              )
              : await tx.run(
                'UPDATE training_plans SET plan_json=? WHERE id=? AND user_id=?',
                [serialized, legacyPlan.id, req.user.id]
              );
            if (reviewResult.changes !== 1) throw new Error('Legacy plan review marker update failed');
          }
        }
      }

      const user = await tx.get(
        `SELECT id, name, email, onboarded, coach_personality, age, weight_lbs, max_heart_rate,
         weekly_miles_current, goal_type, goal_race_date, goal_race_distance, injury_notes,
         comeback_mode, run_days_per_week, lift_days_per_week, sex, schedule_type, lifestyle,
         preferred_workout_time, preferred_workout_days, missed_workout_pref,
         weekly_workout_days, units, is_pro, subscription_status
         FROM users WHERE id = ?`,
        [req.user.id]
      );
      return { user };
    });
    if (mutation.notFound) return res.status(404).json({ error: 'User not found' });
    if (mutation.validationError) return res.status(400).json({ error: mutation.validationError });
    const user = mutation.user;
    res.json({ token: sign(user), user });
  } catch (err) {
    console.error('[auth/profile] update failed:', err.message);
    res.status(500).json({ error: 'Profile update failed' });
  }
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
    const today = now.toISOString().slice(0, 10);

    const getRuns = async (daysBack) => {
      const since = new Date(now - daysBack * 86400000).toISOString().slice(0, 10);
      return dbAll(`SELECT * FROM runs WHERE user_id=? AND date >= ? AND ${runActivitySql()} ORDER BY date DESC`, [userId, since]);
    };

    const [dayRuns, weekRuns, monthRuns, yearRuns, allRuns] = await Promise.all([
      dbAll(`SELECT * FROM runs WHERE user_id=? AND date >= ? AND ${runActivitySql()} ORDER BY date DESC`, [userId, today]),
      getRuns(7), getRuns(30), getRuns(365),
      dbAll(`SELECT * FROM runs WHERE user_id=? AND ${runActivitySql()} ORDER BY date DESC`, [userId])
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
        dbAll(`SELECT distance_miles FROM runs WHERE user_id=? AND date >= ? AND date < ? AND ${runActivitySql()}`, [userId, wStart, wEnd])
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

    const { current: streak } = computeStreak(allDates, serverUtcAnchorCandidates(now));

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
      dbAll(`SELECT date, created_at FROM runs WHERE user_id=? AND ${runActivitySql()}`, [userId]),
      dbAll("SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL", [userId])
    ]);
    const runDates = runRows.map(r => (r.date || r.created_at || '').slice(0, 10)).filter(Boolean);
    const liftDates = liftRows.map(s => (s.started_at || '').slice(0, 10)).filter(Boolean);
    const uniqueDates = [...new Set([...runDates, ...liftDates])].sort();

    const now = new Date();
    const { current: currentStreak, best: bestStreak } = computeStreak(uniqueDates, serverUtcAnchorCandidates(now));

    res.json({ currentStreak, bestStreak });
  } catch (err) { res.status(500).json({ error: 'Streak fetch failed' }); }
});

router.get('/me/ai-usage', auth, async (req, res) => {
  try {
    const windows = aiUsageWindows();
    const user = await dbGet(
      'SELECT is_pro, subscription_status FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    const entitlement = resolveEntitlement(user);

    const [dailyRow, monthlyRow] = await Promise.all([
      dbGet('SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?', [req.user.id, windows.dailyStart]),
      dbGet('SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?', [req.user.id, windows.monthlyStart])
    ]);

    res.json({
      is_pro: entitlement.effectivePremiumAccess,
      effective_premium_access: entitlement.effectivePremiumAccess,
      access_source: entitlement.accessSource,
      paid_tier: entitlement.paidTier,
      entitlement,
      daily: {
        used: Number(dailyRow?.cnt || 0),
        limit: entitlement.dailyAiLimit,
        resets_at: windows.dailyResetAt,
      },
      monthly: {
        used: Number(monthlyRow?.cnt || 0),
        limit: entitlement.monthlyAiLimit,
        resets_at: windows.monthlyResetAt,
      }
    });
  } catch (err) { res.status(500).json({ error: 'AI usage fetch failed' }); }
});

router.get('/me/export', auth, async (req, res) => {
  const userId = req.user.id;
  const safeAll = async (sql, params = [userId]) => {
    try {
      return await dbAll(sql, params);
    } catch {
      return [];
    }
  };

  try {
    const user = await dbGet(
      `SELECT id, name, email, onboarded, sex, age, weight_lbs, max_heart_rate,
        weekly_miles_current, goal_type, fitness_level, injury_mode,
        injury_description, injury_limitations, distance_unit, theme,
        friend_handle, friend_discoverable,
        created_at
       FROM users WHERE id = ?`,
      [userId]
    );

    if (!user) return res.status(404).json({ error: 'Account not found' });

    const exportData = {
      exported_at: new Date().toISOString(),
      metadata: {
        app: 'forge',
        backend_version: backendPackage.version || 'unknown',
        categories_included: ACCOUNT_EXPORT_TABLES.map(({ key }) => key),
        secrets_excluded: [
          'password_hash',
          'password_reset_tokens',
          'garmin_credentials',
          'strava access/refresh tokens',
          'whoop encrypted tokens',
          'oura encrypted tokens',
          'push subscription auth keys',
          'activity media binary data',
        ],
      },
      account: user,
    };

    for (const dataset of ACCOUNT_EXPORT_TABLES) {
      exportData[dataset.key] = await safeAll(buildExportSql(dataset));
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="forge-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export account data' });
  }
});

router.delete('/account', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { password, confirm } = req.body || {};

    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm account deletion.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password confirmation is required.' });
    }

    await withTransaction(async (tx) => {
      const user = await tx.get('SELECT id, password_hash FROM users WHERE id = ?', [userId]);
      if (!user) {
        const err = new Error('Account not found');
        err.code = 'ACCOUNT_NOT_FOUND';
        throw err;
      }
      if (!bcrypt.compareSync(String(password), user.password_hash)) {
        const err = new Error('Password confirmation failed');
        err.code = 'PASSWORD_CONFIRMATION_FAILED';
        throw err;
      }

      await cleanupOwnedSocialChallenges(tx, userId);
      for (const [sql, params] of ACCOUNT_SOCIAL_DELETE_QUERIES) {
        await tx.run(sql, bindUserId(params, userId));
      }

      for (const [sql, params] of ACCOUNT_DELETE_QUERIES) {
        try {
          await tx.run(sql, bindUserId(params, userId));
        } catch (deleteErr) {
          const table = sql.match(/^DELETE FROM\s+([a-zA-Z0-9_]+)/)?.[1] || 'unknown_table';
          console.error(`[auth/delete-account] failed deleting ${table}:`, deleteErr.message);
          throw deleteErr;
        }
      }

      await tx.run('DELETE FROM users WHERE id = ?', [userId]);
    }, { userIds: [userId], userLock: 'update', requireUserIds: [userId] });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ACCOUNT_NOT_FOUND' || err.code === 'AUTH_ACCOUNT_DELETED') {
      return res.status(404).json({ error: 'Account not found' });
    }
    if (err.code === 'PASSWORD_CONFIRMATION_FAILED') {
      return res.status(401).json({ error: 'Password confirmation failed.' });
    }
    console.error('[auth/delete-account] failed:', err.message);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
