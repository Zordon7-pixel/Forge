const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth   = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { generateRunFeedback, generateLoadWarning } = require('../services/ai');
const autoUpdatePRs = require('../services/prAuto');

router.get('/', auth, async (req, res) => {
  try {
    const runs = await dbAll('SELECT * FROM runs WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 50', [req.user.id]);
    res.json({ runs });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch runs' }); }
});

router.get('/load-analysis', auth, async (req, res) => {
  try {
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    const lastMonday = new Date(monday); lastMonday.setDate(monday.getDate() - 7);
    const nextMonday = new Date(monday); nextMonday.setDate(monday.getDate() + 7);
    const thisWeekStart = monday.toISOString().slice(0, 10);
    const thisWeekEnd = nextMonday.toISOString().slice(0, 10);
    const lastWeekStart = lastMonday.toISOString().slice(0, 10);

    const [twRow, lwRow, runs] = await Promise.all([
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?', [req.user.id, thisWeekStart, thisWeekEnd]),
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?', [req.user.id, lastWeekStart, thisWeekStart]),
      dbAll('SELECT date, perceived_effort FROM runs WHERE user_id=? AND date>=? AND date<? ORDER BY date ASC', [req.user.id, thisWeekStart, thisWeekEnd])
    ]);

    const thisWeekMiles = Number(twRow?.miles || 0);
    const lastWeekMiles = Number(lwRow?.miles || 0);
    const increasePercent = lastWeekMiles > 0 ? ((thisWeekMiles - lastWeekMiles) / lastWeekMiles) * 100 : (thisWeekMiles > 0 ? 100 : 0);

    let hardStreak = 0, maxHardStreak = 0;
    for (const r of runs) {
      if (Number(r.perceived_effort || 0) >= 7) { hardStreak++; maxHardStreak = Math.max(maxHardStreak, hardStreak); }
      else { hardStreak = 0; }
    }

    let loadStatus = 'optimal';
    if (increasePercent > 30 || maxHardStreak >= 4) loadStatus = 'danger';
    else if (maxHardStreak >= 3) loadStatus = 'danger';
    else if (increasePercent > 20) loadStatus = 'high';
    else if (increasePercent > 10) loadStatus = 'elevated';

    const baselineRecommendation = loadStatus === 'danger'
      ? 'Recovery day recommended immediately to prevent overtraining.'
      : loadStatus === 'high' ? 'Reduce next 2 sessions and keep effort easy.'
      : loadStatus === 'elevated' ? 'Keep easy days easy and monitor fatigue.'
      : 'Load progression looks healthy.';

    const ai = (loadStatus === 'optimal') ? null : await generateLoadWarning({ thisWeekMiles, lastWeekMiles, increasePercent, loadStatus, maxHardStreak }, req.user.id);

    res.json({
      thisWeekMiles: Number(thisWeekMiles.toFixed(2)),
      lastWeekMiles: Number(lastWeekMiles.toFixed(2)),
      increasePercent: Number(increasePercent.toFixed(1)),
      loadStatus,
      warning: ai?.warning || null,
      recommendation: ai?.recommendation || baselineRecommendation,
      suggestedAction: ai?.suggestedAction || (loadStatus === 'optimal' ? 'ok' : 'easy_day'),
    });
  } catch (err) { res.status(500).json({ error: 'Load analysis failed' }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const {
      date, type, distance_miles, duration_seconds, perceived_effort, notes, run_surface, surface,
      incline_pct, treadmill_speed, route_coords, watch_mode,
      avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones, cadence_spm,
      elevation_gain, elevation_loss, pace_avg, pace_splits,
      vo2_max, training_effect_aerobic, training_effect_anaerobic, recovery_time_hours,
      detected_surface_type, temperature_f, calories, treadmill_brand, treadmill_model,
      watch_sync_id, watch_activity_type, watch_normalized_type, gps_available
    } = req.body;
    if (!date || !type) return res.status(400).json({ error: 'date and type required' });

    const id = uuidv4();
    const resolvedSurface = surface || run_surface || 'road';
    await dbRun(`INSERT INTO runs (
      id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes,
      run_surface, surface, incline_pct, treadmill_speed, route_coords, watch_mode,
      avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones,
      cadence_spm, elevation_gain, elevation_loss, pace_avg, pace_splits,
      vo2_max, training_effect_aerobic, training_effect_anaerobic, recovery_time_hours,
      detected_surface_type, temperature_f, calories, treadmill_brand, treadmill_model,
      watch_sync_id, watch_activity_type, watch_normalized_type, gps_available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, req.user.id, date, type, distance_miles || 0, duration_seconds || 0, perceived_effort || 5, notes || null,
      resolvedSurface, resolvedSurface, incline_pct || 0, treadmill_speed || 0, JSON.stringify(route_coords || []), watch_mode || null,
      avg_heart_rate || null, max_heart_rate || null, min_heart_rate || null, JSON.stringify(heart_rate_zones || []),
      cadence_spm || null, elevation_gain || null, elevation_loss || null, pace_avg || null, JSON.stringify(pace_splits || []),
      vo2_max || null, training_effect_aerobic || null, training_effect_anaerobic || null, recovery_time_hours || null,
      detected_surface_type || null, temperature_f || null, calories || 0, treadmill_brand || null, treadmill_model || null,
      watch_sync_id || null, watch_activity_type || null, watch_normalized_type || null, gps_available === false ? 0 : 1
    ]);

    const userProfile = await dbGet('SELECT weight_lbs FROM users WHERE id=?', [req.user.id]);
    const weightLbs = userProfile?.weight_lbs || 185;
    const computedCalories = Math.round(0.75 * weightLbs * (distance_miles || 0));
    const resolvedCalories = Number(calories || 0) > 0 ? Number(calories) : computedCalories;
    if (resolvedCalories > 0) {
      await dbRun('UPDATE runs SET calories=? WHERE id=?', [resolvedCalories, id]);
    }

    if ((duration_seconds || 0) > 0 && (distance_miles || 0) > 0) {
      const durationHours = (duration_seconds || 0) / 3600;
      const paceMinsPerMile = ((duration_seconds || 0) / 60) / (distance_miles || 1);
      const met = paceMinsPerMile < 8 ? 12.0 : paceMinsPerMile <= 10 ? 10.0 : 8.0;
      const weightKg = weightLbs / 2.205;
      const calories_burned = Math.round(met * weightKg * durationHours);
      if (calories_burned > 0) {
        await dbRun('UPDATE runs SET calories_burned=? WHERE id=?', [calories_burned, id]);
      }
    }

    const run = await dbGet('SELECT * FROM runs WHERE id = ?', [id]);

    let prResult = { newPRs: [], discrepancies: [] };
    try { prResult = await autoUpdatePRs(req.user.id, run) || prResult; } catch (e) { console.error('PR auto-detect:', e); }

    res.status(201).json({ run, newPRs: prResult.newPRs, discrepancies: prResult.discrepancies });

    // Fire and forget AI feedback
    try {
      const today = new Date().toISOString().slice(0, 10);
      const month = new Date().toISOString().slice(0, 7);
      const [dailyRow, userRow] = await Promise.all([
        dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?", [req.user.id, today + 'T00:00:00']),
        dbGet("SELECT is_pro FROM users WHERE id = ?", [req.user.id])
      ]);
      const dailyCount = Number(dailyRow?.cnt || 0);
      const monthlyRow = !userRow?.is_pro
        ? await dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?", [req.user.id, month + '-01T00:00:00'])
        : null;
      const monthlyCount = Number(monthlyRow?.cnt || 0);
      const canCallAI = dailyCount < 10 && (userRow?.is_pro || monthlyCount < 5);
      if (canCallAI) {
        await dbRun("INSERT INTO ai_usage (id, user_id, call_type) VALUES (?, ?, ?)", [uuidv4(), req.user.id, 'run_feedback']);
        const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
        generateRunFeedback(run, profile).then(async feedback => {
          if (feedback) await dbRun('UPDATE runs SET ai_feedback = ? WHERE id = ?', [feedback, id]);
        }).catch(() => {});
      }
    } catch (e) {}
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Failed to save run' });
  }
});

async function updateRunHandler(req, res) {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const { date, distance_miles, duration_seconds, notes, perceived_effort, type, run_surface, incline_pct, treadmill_speed } = req.body;

    const userProfile = await dbGet('SELECT weight_lbs FROM users WHERE id=?', [req.user.id]);
    const weightLbs = userProfile?.weight_lbs || 185;
    const newDist = distance_miles !== undefined ? Number(distance_miles) : run.distance_miles;
    const calories = Math.round(0.75 * weightLbs * newDist);

    await dbRun(`UPDATE runs SET
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
      WHERE id=? AND user_id=?`, [
      date ?? null, distance_miles ?? null, duration_seconds ?? null,
      notes ?? null, perceived_effort ?? null, type ?? null,
      run_surface ?? null, incline_pct ?? null, treadmill_speed ?? null,
      calories, req.params.id, req.user.id
    ]);

    const updated = await dbGet('SELECT * FROM runs WHERE id=?', [req.params.id]);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
}

router.put('/:id', auth, updateRunHandler);
router.patch('/:id', auth, updateRunHandler);

router.post('/:id/feedback', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (run.ai_feedback) return res.json({ feedback: run.ai_feedback });

    const profile = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const [dailyRow, monthlyRow] = await Promise.all([
      dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id=? AND created_at>=?", [req.user.id, today]),
      dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id=? AND created_at>=?", [req.user.id, monthStart])
    ]);
    const canCallAI = Number(dailyRow?.cnt || 0) < 10 && (profile?.is_pro || Number(monthlyRow?.cnt || 0) < 5);
    if (!canCallAI) return res.status(429).json({ error: 'AI limit reached for today.' });

    await dbRun('INSERT INTO ai_usage (id, user_id, call_type) VALUES (?,?,?)', [uuidv4(), req.user.id, 'run_feedback']);
    const feedback = await generateRunFeedback(run, profile);
    if (feedback) await dbRun('UPDATE runs SET ai_feedback=? WHERE id=?', [feedback, run.id]);
    res.json({ feedback: feedback || 'Could not generate feedback right now.' });
  } catch (err) { res.status(500).json({ error: 'Feedback failed' }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM runs WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

router.post('/missed', auth, async (req, res) => {
  const { reason } = req.body;
  const adjustments = {
    tired: "Logged. Your body needed rest today — that IS training. I've moved the session to tomorrow and lightened your week.",
    no_time: "Got it. Moved to tomorrow. Your weekly volume stays on track.",
    didnt_feel_like_it: "Happens to everyone. No judgment — I've rescheduled it. Show up tomorrow.",
    something_came_up: "Life happens. Adjusted your week. You're still on track for your goal.",
    weather: "Pushed to tomorrow. Check the forecast — might be a treadmill day.",
    sick: "Rest up. I've cleared your schedule for 2 days. Nothing to worry about — health first."
  };
  res.json({ ok: true, message: adjustments[reason] || "Got it — adjusted your plan. Keep moving forward.", reason });
});

module.exports = router;
