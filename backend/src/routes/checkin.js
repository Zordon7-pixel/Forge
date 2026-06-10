const router = require('express').Router();
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { deriveAction, buildPatch } = require('../lib/checkinOverride');

function getDayShort() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

function parsePlan(plan) {
  try {
    if (plan?.plan_data) {
      return typeof plan.plan_data === 'string' ? JSON.parse(plan.plan_data) : plan.plan_data;
    }
    return typeof plan?.plan_json === 'string' ? JSON.parse(plan.plan_json) : plan?.plan_json;
  } catch (err) {
    console.error('[checkin] Failed to parse active plan:', err);
    return null;
  }
}

function normalizeTodayEntry(planJson) {
  if (!planJson?.weeks?.length) return null;
  const today = getDayShort();
  for (const week of planJson.weeks) {
    const days = Array.isArray(week.days) ? week.days : Array.isArray(week.sessions) ? week.sessions : [];
    const hit = days.find(d => d?.day === today);
    if (hit) return hit;
  }
  return null;
}

async function getActivePlanForUser(userId) {
  const assigned = await dbGet(`
    SELECT up.id as user_plan_id, up.current_week, up.started_at, up.status, up.progress_json,
           tp.*
    FROM user_plans up
    JOIN training_plans tp ON tp.id = up.plan_id
    WHERE up.user_id = ? AND up.status = 'active'
    ORDER BY up.created_at DESC
    LIMIT 1
  `, [userId]);
  if (assigned) return assigned;

  return dbGet('SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
}

function describeAdjustment(action, patch) {
  if (!patch || Object.keys(patch).length === 0) {
    return action === 'keep'
      ? 'Check-in saved. Today\'s workout stays as planned.'
      : 'Check-in saved. No active workout was found to override today.';
  }
  if (action === 'rest') return 'Check-in saved. Today\'s workout is now a rest day.';
  if (action === 'recovery_swap') return 'Check-in saved. Today\'s workout is now a recovery session.';
  if (action === 'shorten') return 'Check-in saved. Today\'s workout has been shortened.';
  return 'Check-in saved. Today\'s workout stays as planned.';
}

// POST /api/checkin — daily life check-in
router.post('/', auth, async (req, res) => {
  try {
    const { feeling, time_available, life_flags = [], sleep_hours } = req.body;
    const today = new Date().toISOString().slice(0,10);
    const parsedSleep = sleep_hours === null || sleep_hours === undefined || sleep_hours === '' ? null : Number(sleep_hours);

    const existing = await dbGet('SELECT id FROM daily_checkins WHERE user_id=? AND checkin_date=?', [req.user.id, today]);
    if (existing) {
      await dbRun('UPDATE daily_checkins SET feeling=?, time_available=?, sleep_hours=?, life_flags=? WHERE id=?',
        [feeling, time_available, parsedSleep, JSON.stringify(life_flags), existing.id]);
    } else {
      const id = require('crypto').randomBytes(8).toString('hex');
      await dbRun(
        'INSERT INTO daily_checkins (id, user_id, checkin_date, feeling, time_available, sleep_hours, life_flags) VALUES (?,?,?,?,?,?,?)',
        [id, req.user.id, today, feeling, time_available, parsedSleep, JSON.stringify(life_flags)]
      );
    }

    const checkin = { feeling, time_available, sleep_hours: parsedSleep, life_flags };
    const action = deriveAction(checkin);
    const activePlan = await getActivePlanForUser(req.user.id);
    const todayDay = activePlan ? normalizeTodayEntry(parsePlan(activePlan)) : null;
    const patch = buildPatch(action, todayDay);
    const overrideId = require('crypto').randomBytes(8).toString('hex');

    await dbRun(
      `INSERT INTO checkin_overrides (id, user_id, date, action, patch_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET
         action = excluded.action,
         patch_json = excluded.patch_json`,
      [overrideId, req.user.id, today, action, JSON.stringify(patch)]
    );

    const feelingLabels = ['', 'Exhausted', 'Tired', 'Okay', 'Good', 'Great'];
    const adjustment = describeAdjustment(action, patch);

    const readiness_delta = parsedSleep !== null
      ? parsedSleep < 6 ? -12 : parsedSleep >= 8 ? 5 : 0
      : 0;

    res.json({ ok: true, adjustment, action, feeling: feelingLabels[feeling] || 'Noted', readiness_delta });
  } catch (err) {
    console.error('[checkin] POST failed:', err);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

router.get('/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const checkin = await dbGet('SELECT * FROM daily_checkins WHERE user_id=? AND checkin_date=?', [req.user.id, today]);
    res.json(checkin || null);
  } catch(err) {
    console.error('[checkin] GET today failed:', err);
    res.status(500).json({ error: 'Failed to fetch check-in' });
  }
});

module.exports = router;
