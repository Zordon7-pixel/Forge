const router = require('express').Router();
const { dbGet, dbAll, dbRun, withTransaction } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { generateExerciseSubstitutions, generateRecoveryAdjustment, generateNextGoalSuggestions, sanitize } = require('../services/ai');
const { requirePremium } = require('../middleware/premiumGate');
const { checkAiLimit } = require('../middleware/aiLimit');
const { buildHealthSignals } = require('../lib/healthSignals');
const { applyInterference } = require('../services/interference');
const { isRunActivity, runActivitySql } = require('../lib/runActivity');

// GET /warning — check if dangerous training combo exists
router.get('/warning', auth, async (req, res) => {
  try {
    const recentWorkouts = await dbAll(
      'SELECT started_at, muscle_groups, total_seconds FROM workout_sessions WHERE user_id=? ORDER BY started_at DESC, created_at DESC LIMIT 10',
      [req.user.id]
    );
    const result = applyInterference({ type: 'tempo', structure: [] }, recentWorkouts);

    if (!result.interference?.adjusted) return res.json({ warning: false });

    res.json({
      warning: true,
      message: result.interference.reason
    });
  } catch (err) {
    console.error('Coach warning check failed:', err);
    res.status(500).json({ error: 'Warning check failed' });
  }
});

// GET /feedback/:run_id — return AI feedback for a run (generate if missing)
router.get('/feedback/:run_id', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id = ? AND user_id = ?', [req.params.run_id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!isRunActivity(run)) return res.status(400).json({ error: 'Coaching feedback is only available for running activities' });

    if (run.ai_feedback) return res.json({ feedback: run.ai_feedback });

    // Not generated yet — return empty (frontend polls)
    res.json({ feedback: null, pending: true });
  } catch (err) { res.status(500).json({ error: 'Feedback fetch failed' }); }
});

// POST /substitute — get exercise substitution suggestions (Premium only)
router.post('/substitute', auth, requirePremium('Exercise substitutions'), async (req, res) => {
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

// POST /coach/adjust-today — recovery-informed plan adjustment (AI-limited for free users)
router.post('/adjust-today', auth, checkAiLimit('adjust_today'), async (req, res) => {
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

    const healthRow = await dbGet('SELECT * FROM health_sync WHERE user_id=?', [req.user.id]).catch(() => null);
    const healthSignals = buildHealthSignals(healthRow || {});
    if (healthSignals.available && healthSignals.readinessScore !== null && healthSignals.readinessScore !== undefined) {
      // Passive readiness is already an absolute score; scoreDelta is only an offset from 70.
      readinessScore = healthSignals.readinessScore;
    }

    // Active injury (injury_logs table, cleared=0 means active)
    const activeInjury = await dbGet(
      'SELECT * FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC LIMIT 1',
      [req.user.id]
    ).catch(() => null);

    // Recent training load (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const recentRuns = await dbAll(
      `SELECT date, distance_miles, duration_seconds, perceived_effort, type FROM runs WHERE user_id=? AND date>=? AND ${runActivitySql()} ORDER BY date DESC`,
      [req.user.id, sevenDaysAgo]
    ).catch((err) => {
      console.error('[coach/recovery] recent run lookup failed:', err.message);
      return [];
    });
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

    const ALLOWED_INTENSITIES = ['light', 'moderate', 'hard'];
    const validatedIntensity = ALLOWED_INTENSITIES.includes(result.adjusted_intensity) ? result.adjusted_intensity : 'moderate';

    res.json({
      recommendation: result.recommendation,
      adjusted_intensity: validatedIntensity,
      skip_reason: result.skip_reason || null,
      readiness_score: readinessScore,
      health_summary: healthSignals.available ? healthSignals.summary : null,
      health_signals: healthSignals,
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

// POST /coach/next-goal — AI-generated progression goals (Premium only)
router.post('/next-goal', auth, requirePremium('Goal cascades'), async (req, res) => {
  try {
    const { completed_goal } = req.body;
    if (!completed_goal || typeof completed_goal !== 'string' || !completed_goal.trim()) {
      return res.status(400).json({ error: 'completed_goal is required' });
    }
    if (completed_goal.length > 300) {
      return res.status(400).json({ error: 'completed_goal must be 300 characters or less' });
    }

    const profile = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);

    // Gather recent activity for context
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const [recentRuns, recentLifts] = await Promise.all([
      dbAll(`SELECT date, distance_miles, duration_seconds, type FROM runs WHERE user_id=? AND date>=? AND ${runActivitySql()} ORDER BY date DESC LIMIT 10`, [req.user.id, sevenDaysAgo]),
      dbAll('SELECT started_at, muscle_groups FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 5', [req.user.id])
    ]);

    const result = await generateNextGoalSuggestions({
      completedGoal: sanitize(completed_goal.trim(), 300),
      profile,
      recentActivity: { runs: recentRuns, lifts: recentLifts },
      userId: req.user.id,
    });

    if (!result || !Array.isArray(result.goals)) {
      return res.status(500).json({ error: 'Failed to generate goal suggestions' });
    }

    // Store suggested goals
    for (const goal of result.goals) {
      await dbRun(
        'INSERT INTO suggested_goals (id, user_id, source_milestone, title, description, type, target_value, target_unit, difficulty) VALUES (?,?,?,?,?,?,?,?,?)',
        [uuidv4(), req.user.id, sanitize(completed_goal.trim(), 300), sanitize(goal.title, 100), sanitize(goal.description, 200), sanitize(goal.type, 20), Number(goal.target_value) || 0, sanitize(goal.target_unit, 20), sanitize(goal.difficulty, 20)]
      );
    }

    res.json({ goals: result.goals });
  } catch (err) {
    console.error('Next-goal route error:', err.message);
    res.status(500).json({ error: 'Goal suggestion failed' });
  }
});

// GET /coach/next-goal — fetch pending suggested goals for the user
router.get('/next-goal', auth, async (req, res) => {
  try {
    const goals = await dbAll(
      "SELECT * FROM suggested_goals WHERE user_id=? AND status='suggested' ORDER BY created_at DESC LIMIT 10",
      [req.user.id]
    );
    res.json({ goals });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch suggested goals' });
  }
});

// POST /coach/next-goal/:id/accept — accept a suggested goal (creates a challenge)
router.post('/next-goal/:id/accept', auth, async (req, res) => {
  try {
    const goal = await dbGet('SELECT * FROM suggested_goals WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (goal.status !== 'suggested') {
      return res.status(409).json({ error: 'This goal is no longer available.' });
    }

    const challengeId = `goal-${uuidv4()}`;
    await withTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO challenges (
          id, name, description, type, target_value, unit, badge_color, is_featured,
          sort_order, creator_id, kind, visibility, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 50, ?, 'personal', 'personal', 'active')`,
        [challengeId, goal.title, goal.description, goal.type, goal.target_value || 1, goal.target_unit || 'units', '#EAB308', req.user.id]
      );
      await tx.run(
        `INSERT INTO user_challenges (id, user_id, challenge_id, progress, role, status)
         VALUES (?, ?, ?, 0, 'owner', 'joined')
         ON CONFLICT (user_id, challenge_id) DO NOTHING`,
        [uuidv4(), req.user.id, challengeId]
      );
      const updatedGoal = await tx.run(
        "UPDATE suggested_goals SET status='accepted' WHERE id=? AND user_id=? AND status='suggested'",
        [req.params.id, req.user.id]
      );
      if (updatedGoal.changes !== 1) throw new Error('Goal acceptance lost its user guard');
    });

    res.json({ ok: true, challenge_id: challengeId });
  } catch (err) {
    console.error('Accept goal error:', err.message);
    res.status(500).json({ error: 'Failed to accept goal' });
  }
});

module.exports = router;
