const router = require('express').Router();
const { dbGet, dbAll } = require('../db');
const auth = require('../middleware/auth');
const { generateExerciseSubstitutions, generateRecoveryAdjustment, sanitize } = require('../services/ai');

// GET /warning — check if dangerous training combo exists
router.get('/warning', auth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('T')[0];
    const heavyLegs = await dbGet(
      `SELECT id FROM lifts WHERE user_id = ? AND date >= ? AND intensity = 'heavy' AND muscle_groups LIKE '%legs%'`,
      [req.user.id, cutoff]
    );

    if (!heavyLegs) return res.json({ warning: false });

    res.json({
      warning: true,
      message: "You logged a heavy leg day recently. Running tempo or intervals today risks injury — your muscles haven't fully recovered. Consider an easy recovery run instead, or rest."
    });
  } catch (err) { res.status(500).json({ error: 'Warning check failed' }); }
});

// GET /feedback/:run_id — return AI feedback for a run (generate if missing)
router.get('/feedback/:run_id', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id = ? AND user_id = ?', [req.params.run_id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    if (run.ai_feedback) return res.json({ feedback: run.ai_feedback });

    // Not generated yet — return empty (frontend polls)
    res.json({ feedback: null, pending: true });
  } catch (err) { res.status(500).json({ error: 'Feedback fetch failed' }); }
});

// POST /substitute — get exercise substitution suggestions
router.post('/substitute', auth, async (req, res) => {
  try {
    const { exercise_name, reason, equipment_available } = req.body;

    if (!exercise_name || typeof exercise_name !== 'string' || !exercise_name.trim()) {
      return res.status(400).json({ error: 'exercise_name is required' });
    }
    if (exercise_name.length > 100) {
      return res.status(400).json({ error: 'exercise_name must be 100 characters or less' });
    }
    if (reason && typeof reason === 'string' && reason.length > 200) {
      return res.status(400).json({ error: 'reason must be 200 characters or less' });
    }
    if (equipment_available && typeof equipment_available === 'string' && equipment_available.length > 200) {
      return res.status(400).json({ error: 'equipment_available must be 200 characters or less' });
    }

    const result = await generateExerciseSubstitutions(
      exercise_name.trim(),
      reason || '',
      equipment_available || ''
    );

    if (!result) {
      return res.status(500).json({ error: 'Failed to generate substitutions' });
    }

    res.json(result);
  } catch (err) {
    console.error('Substitute route error:', err.message);
    res.status(500).json({ error: 'Substitution failed' });
  }
});

// POST /coach/adjust-today — recovery-informed plan adjustment
router.post('/adjust-today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Today's check-in
    const checkin = await dbGet(
      'SELECT * FROM daily_checkins WHERE user_id=? AND checkin_date=?',
      [req.user.id, today]
    );

    // Readiness score from injury logs (mirrors /api/pt/readiness logic)
    let readinessScore = null;
    const logs = await dbAll(
      'SELECT date, pain_level FROM injury_logs WHERE user_id=? ORDER BY date DESC',
      [req.user.id]
    ).catch(() => []);

    if (logs.length > 0) {
      const latestDate = logs[0]?.date || null;
      const daysSinceInjury = latestDate
        ? Math.max(0, Math.floor((Date.now() - new Date(latestDate).getTime()) / 86400000))
        : 0;
      const last7 = logs.slice(0, 7);
      const last3 = logs.slice(0, 3);
      const avgPain7 = last7.reduce((s, r) => s + Number(r.pain_level || 0), 0) / last7.length;
      const avgPain3 = last3.reduce((s, r) => s + Number(r.pain_level || 0), 0) / last3.length;
      const daysScore = Math.min(daysSinceInjury * 2.2, 40);
      const painScore = Math.max(60 - avgPain7 * 7, 0);
      const trendBonus = avgPain3 <= avgPain7 ? 5 : -5;
      readinessScore = Math.max(0, Math.min(100, Math.round(daysScore + painScore + trendBonus)));
    }

    // If no injury-based readiness, derive from check-in
    if (readinessScore === null && checkin) {
      const feeling = Number(checkin.feeling) || 3;
      const sleepHrs = checkin.sleep_hours != null ? Number(checkin.sleep_hours) : 7;
      const lifeFlags = (() => { try { return JSON.parse(checkin.life_flags || '[]'); } catch { return []; } })();
      let score = feeling * 16; // 1-5 → 16-80
      if (sleepHrs < 6) score -= 15;
      else if (sleepHrs >= 8) score += 10;
      if (lifeFlags.includes('sore')) score -= 10;
      if (lifeFlags.includes('sick')) score -= 20;
      readinessScore = Math.max(0, Math.min(100, Math.round(score)));
    }

    // Active injury (injury_logs table, cleared=0 means active)
    const activeInjury = await dbGet(
      'SELECT * FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC LIMIT 1',
      [req.user.id]
    ).catch(() => null);

    // Recent training load (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const recentRuns = await dbAll(
      'SELECT date, distance_miles, duration_seconds, perceived_effort, type FROM runs WHERE user_id=? AND date>=? ORDER BY date DESC',
      [req.user.id, sevenDaysAgo]
    ).catch(() => []);
    const recentLifts = await dbAll(
      'SELECT date, muscle_groups, intensity FROM lifts WHERE user_id=? AND date>=? ORDER BY date DESC',
      [req.user.id, sevenDaysAgo]
    ).catch(() => []);

    // User profile
    const profile = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);

    const result = await generateRecoveryAdjustment({
      checkin,
      readinessScore,
      activeInjury,
      recentLoad: { runs: recentRuns, lifts: recentLifts },
      profile,
      userId: req.user.id,
    });

    if (!result) {
      return res.status(500).json({ error: 'Failed to generate adjustment' });
    }

    res.json({
      recommendation: result.recommendation,
      adjusted_intensity: result.adjusted_intensity,
      skip_reason: result.skip_reason || null,
      readiness_score: readinessScore,
      checkin_summary: checkin ? {
        feeling: checkin.feeling,
        sleep_hours: checkin.sleep_hours,
        life_flags: (() => { try { return JSON.parse(checkin.life_flags || '[]'); } catch { return []; } })(),
      } : null,
    });
  } catch (err) {
    console.error('Adjust-today route error:', err.message);
    res.status(500).json({ error: 'Plan adjustment failed' });
  }
});

module.exports = router;
