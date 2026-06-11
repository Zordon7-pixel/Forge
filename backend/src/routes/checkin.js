const router = require('express').Router();
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { deriveAction, buildPatch, buildDirective } = require('../lib/checkinOverride');

const ALLOWED_LIFE_FLAGS = new Set(['long_shift', 'sore', 'traveling', 'sick', 'injured', 'stressed', 'all_good']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deriveFeelingFromAxes(legs, drive) {
  return clamp(Math.round(((legs + drive) / 6) * 4 + 1), 1, 5);
}

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

function describeAdjustment(action, patch, hasWorkoutToday = false) {
  if (!patch || Object.keys(patch).length === 0) {
    if (!hasWorkoutToday) return 'Check-in saved. No active workout was found to override today.';
    if (action === 'shorten') return 'Check-in saved. Today\'s workout stays as planned because there was no distance or duration to shorten.';
    return 'Check-in saved. Today\'s workout stays as planned.';
  }
  if (action === 'rest') return 'Check-in saved. Today\'s workout is now a rest day.';
  if (action === 'recovery_swap') return 'Check-in saved. Today\'s workout is now a recovery session.';
  if (action === 'shorten') return 'Check-in saved. Today\'s workout has been shortened.';
  return 'Check-in saved. Today\'s workout stays as planned.';
}

function validateCheckinPayload(body = {}) {
  const hasLegs = body.legs !== null && body.legs !== undefined && body.legs !== '';
  const hasDrive = body.drive !== null && body.drive !== undefined && body.drive !== '';
  const legs = hasLegs ? Number(body.legs) : null;
  const drive = hasDrive ? Number(body.drive) : null;
  const hasValidAxes = Number.isInteger(legs) && legs >= 1 && legs <= 3
    && Number.isInteger(drive) && drive >= 1 && drive <= 3;

  let feeling = Number(body.feeling);
  const hasValidFeeling = Number.isInteger(feeling) && feeling >= 1 && feeling <= 5;

  if (hasLegs || hasDrive) {
    if (!hasValidAxes) {
      return { error: 'Legs and drive must both be whole numbers from 1 to 3.' };
    }
    feeling = deriveFeelingFromAxes(legs, drive);
  } else if (!hasValidFeeling) {
    return { error: 'Check-in requires legs and drive from 1 to 3, or a legacy feeling from 1 to 5.' };
  }

  const timeAvailable = Number(body.time_available);
  if (!Number.isInteger(timeAvailable) || timeAvailable <= 0) {
    return { error: 'Time available must be a positive whole number of minutes.' };
  }
  if (timeAvailable > 1440) {
    return { error: 'Time available must be no more than 1440 minutes.' };
  }

  const sleepHours = body.sleep_hours === null || body.sleep_hours === undefined || body.sleep_hours === ''
    ? null
    : Number(body.sleep_hours);
  if (sleepHours !== null && (!Number.isFinite(sleepHours) || sleepHours < 0 || sleepHours > 24)) {
    return { error: 'Sleep hours must be between 0 and 24, or left blank.' };
  }

  return {
    value: {
      feeling,
      legs: hasValidAxes ? legs : null,
      drive: hasValidAxes ? drive : null,
      time_available: timeAvailable,
      sleep_hours: sleepHours,
      life_flags: Array.isArray(body.life_flags) ? body.life_flags.filter(flag => ALLOWED_LIFE_FLAGS.has(flag)) : [],
    },
  };
}

// POST /api/checkin — daily life check-in
router.post('/', auth, async (req, res) => {
  try {
    const validation = validateCheckinPayload(req.body);
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const { feeling, legs, drive, time_available, life_flags, sleep_hours: parsedSleep } = validation.value;
    const today = new Date().toISOString().slice(0,10);

    const existing = await dbGet('SELECT id FROM daily_checkins WHERE user_id=? AND checkin_date=?', [req.user.id, today]);
    if (existing) {
      await dbRun('UPDATE daily_checkins SET feeling=?, legs=?, drive=?, time_available=?, sleep_hours=?, life_flags=? WHERE id=? AND user_id=?',
        [feeling, legs, drive, time_available, parsedSleep, JSON.stringify(life_flags), existing.id, req.user.id]);
    } else {
      const id = require('crypto').randomBytes(8).toString('hex');
      await dbRun(
        'INSERT INTO daily_checkins (id, user_id, checkin_date, feeling, legs, drive, time_available, sleep_hours, life_flags) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, req.user.id, today, feeling, legs, drive, time_available, parsedSleep, JSON.stringify(life_flags)]
      );
    }

    const checkin = { feeling, legs, drive, time_available, sleep_hours: parsedSleep, life_flags };
    const action = deriveAction(checkin);
    const activePlan = await getActivePlanForUser(req.user.id);
    const todayDay = activePlan ? normalizeTodayEntry(parsePlan(activePlan)) : null;
    const patch = buildPatch(action, todayDay, checkin);
    const overrideId = require('crypto').randomBytes(8).toString('hex');

    await dbRun(
      `INSERT INTO checkin_overrides (id, user_id, date, action, patch_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET
         action = excluded.action,
         patch_json = excluded.patch_json`,
      [overrideId, req.user.id, today, action, JSON.stringify(patch)]
    );

    const readiness_delta = parsedSleep !== null
      ? parsedSleep < 6 ? -12 : parsedSleep >= 8 ? 5 : 0
      : 0;
    const directive = buildDirective(checkin, action, patch, Boolean(todayDay), readiness_delta);
    const feelingLabels = ['', 'Exhausted', 'Tired', 'Okay', 'Good', 'Great'];
    const adjustment = directive.headline || describeAdjustment(action, patch, Boolean(todayDay));

    res.json({
      ok: true,
      adjustment,
      headline: directive.headline,
      drivers: directive.drivers,
      action,
      feeling: feelingLabels[feeling] || 'Noted',
      readiness_delta,
    });
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
