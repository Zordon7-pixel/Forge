const router = require('express').Router();
const { dbGet, withPlanningInputMutation } = require('../db');
const auth = require('../middleware/auth');
const { deriveAction, buildPatch, buildDirective, estimateWorkoutMinutes } = require('../lib/checkinOverride');
const dailyExecution = require('../lib/dailyExecution');
const planSchema = require('../lib/planSchema');
const { resolveActivePlanForDate } = require('../lib/planAssignmentLifecycle');
const { isPlanningDateAllowed, requestPlanningDate } = require('../lib/requestPlanningDate');

const ALLOWED_LIFE_FLAGS = new Set(['long_shift', 'sore', 'traveling', 'sick', 'injured', 'stressed', 'all_good']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deriveFeelingFromAxes(legs, drive) {
  return clamp(Math.round(((legs + drive) / 6) * 4 + 1), 1, 5);
}

function isInt13(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && !/^[1-3]$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3;
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

function resolveTodayPlanState(planJson, planningDateLocal) {
  const selected = dailyExecution.selectDayForDate(planJson, planningDateLocal);
  if (!selected) return { hasPlannedDay: false, isRestDay: false, day: null };
  const sessions = planSchema.daySessions(selected.entry);
  if (sessions.length === 0) return { hasPlannedDay: true, isRestDay: true, day: null };
  return {
    hasPlannedDay: true,
    isRestDay: false,
    day: planSchema.flattenDayForConsumer(selected.entry),
  };
}

function normalizeTodayEntry(planJson, planningDateLocal) {
  return resolveTodayPlanState(planJson, planningDateLocal).day;
}

function visibleActivePlan(activePlan) {
  const parsed = parsePlan(activePlan?.row);
  return parsed ? planSchema.visiblePlanForAssignment(parsed, activePlan.row) : null;
}

function activePlanViews(activePlan) {
  const parsed = parsePlan(activePlan?.row);
  if (!parsed) return { storedPlan: null, visiblePlan: null, progress: {} };
  return planSchema.planViewsForAssignment(parsed, activePlan.row);
}

async function getActivePlanForUser(userId, database = { get: dbGet }, options = {}) {
  return resolveActivePlanForDate(userId, database.get, options);
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

function validateCheckinPayload(body = {}, options = {}) {
  const partial = Boolean(options.partial);
  const hasValue = (value) => value !== null && value !== undefined && value !== '';
  const legsProvided = hasValue(body.legs);
  const driveProvided = hasValue(body.drive);
  const hasLegs = isInt13(body.legs);
  const hasDrive = isInt13(body.drive);
  const legs = hasLegs ? Number(body.legs) : null;
  const drive = hasDrive ? Number(body.drive) : null;

  const hasFeeling = body.feeling !== null && body.feeling !== undefined && body.feeling !== '';
  let feeling = hasFeeling ? Number(body.feeling) : null;
  const hasValidFeeling = Number.isInteger(feeling) && feeling >= 1 && feeling <= 5;
  let incomplete = false;

  if (legsProvided || driveProvided) {
    if (!hasLegs) {
      if (partial && !legsProvided) incomplete = true;
      else return { error: 'Legs must be a whole number from 1 to 3.' };
    }
    if (driveProvided && !hasDrive) {
      return { error: 'Drive must be a whole number from 1 to 3.' };
    }
    if (!incomplete) {
      if (hasDrive) feeling = deriveFeelingFromAxes(legs, drive);
      else if (!hasValidFeeling) feeling = null;
    }
  } else if (!hasValidFeeling) {
    if (partial && !hasFeeling) incomplete = true;
    else {
      return { error: 'Check-in requires legs and drive from 1 to 3, or a legacy feeling from 1 to 5.' };
    }
  }

  const hasTimeAvailable = body.time_available !== null && body.time_available !== undefined && body.time_available !== '';
  const timeAvailable = hasTimeAvailable ? Number(body.time_available) : 60;
  if (hasTimeAvailable) {
    if (!Number.isInteger(timeAvailable) || timeAvailable <= 0) {
      return { error: 'Time available must be a positive whole number of minutes.' };
    }
    if (timeAvailable > 1440) {
      return { error: 'Time available must be no more than 1440 minutes.' };
    }
  } else if (!partial) {
    return { error: 'Time available must be a positive whole number of minutes.' };
  }

  if (incomplete) return { incomplete: true };

  return {
    value: {
      feeling,
      legs: hasLegs ? legs : null,
      drive: hasDrive ? drive : null,
      time_available: timeAvailable,
      sleep_hours: null,
      life_flags: Array.isArray(body.life_flags) ? body.life_flags.filter(flag => ALLOWED_LIFE_FLAGS.has(flag)) : [],
    },
  };
}

async function computeCheckinDirective(userId, checkinInput, database, options = {}) {
  const checkin = {
    feeling: checkinInput.feeling,
    legs: checkinInput.legs,
    drive: checkinInput.drive,
    time_available: checkinInput.time_available,
    life_flags: checkinInput.life_flags,
  };
  let action = deriveAction(checkin);
  const planningDateLocal = options.planningDateLocal || requestPlanningDate({});
  const activePlan = await getActivePlanForUser(userId, database, { planningDateLocal });
  const missingPlanState = { hasPlannedDay: false, isRestDay: false, day: null };
  const planViews = activePlan ? activePlanViews(activePlan) : null;
  const storedPlanState = planViews
    ? resolveTodayPlanState(planViews.storedPlan, planningDateLocal)
    : missingPlanState;
  const todayPlanState = planViews
    ? resolveTodayPlanState(planViews.visiblePlan, planningDateLocal)
    : missingPlanState;
  // A removed session also leaves the served day empty. Only call it a planned
  // rest day when the immutable assigned plan was already empty/rest; otherwise
  // preserve the existing "no active workout" removal truth.
  const plannedRestDay = todayPlanState.isRestDay && storedPlanState.isRestDay;
  const todayDay = todayPlanState.day;
  const plannedMinutes = estimateWorkoutMinutes(todayDay || {});
  if (action === 'keep' && plannedMinutes && checkin.time_available < plannedMinutes) {
    action = 'shorten';
  }
  const patch = buildPatch(action, todayDay, checkin);
  const readiness_delta = 0;
  const directive = buildDirective(checkin, action, patch, Boolean(todayDay), readiness_delta);
  const feelingLabels = ['', 'Exhausted', 'Tired', 'Okay', 'Good', 'Great'];
  const hasWorkoutToday = Boolean(todayDay);
  const adjustment = plannedRestDay
    ? 'Check-in saved. Rest was already scheduled, so Forged Hybrid did not add an unplanned workout. Use the rest-day run options to move a missed session or intentionally start an extra run.'
    : hasWorkoutToday
      ? (directive.headline || describeAdjustment(action, patch, true))
      : describeAdjustment(action, patch, false);
  const headline = plannedRestDay
    ? 'Rest day stays scheduled'
    : hasWorkoutToday
      ? directive.headline
      : 'No active workout to adjust';

  return {
    adjustment,
    headline,
    drivers: directive.drivers,
    action,
    patch,
    feeling: feelingLabels[checkin.feeling] || 'Noted',
    readiness_delta,
    hasWorkoutToday,
    plannedRestDay,
  };
}

// POST /api/checkin — daily life check-in
router.post('/', auth, async (req, res) => {
  try {
    const validation = validateCheckinPayload(req.body);
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const { feeling, legs, drive, time_available, life_flags } = validation.value;
    const parsedSleep = null;
    if (req.body?.date !== undefined && req.body?.date !== null && !isPlanningDateAllowed(req.body.date)) {
      return res.status(400).json({ error: 'date must be the current phone date' });
    }
    const today = requestPlanningDate(req, { bodyKeys: ['date'], queryKeys: [] });

    const directive = await withPlanningInputMutation(req.user.id, async (tx) => {
      const existing = await tx.get(
        'SELECT id FROM daily_checkins WHERE user_id=? AND checkin_date=? FOR UPDATE',
        [req.user.id, today]
      );
      if (existing) {
        await tx.run(
          'UPDATE daily_checkins SET feeling=?, legs=?, drive=?, time_available=?, sleep_hours=?, life_flags=? WHERE id=? AND user_id=?',
          [feeling, legs, drive, time_available, parsedSleep, JSON.stringify(life_flags), existing.id, req.user.id]
        );
      } else {
        const id = require('crypto').randomBytes(8).toString('hex');
        await tx.run(
          'INSERT INTO daily_checkins (id, user_id, checkin_date, feeling, legs, drive, time_available, sleep_hours, life_flags) VALUES (?,?,?,?,?,?,?,?,?)',
          [id, req.user.id, today, feeling, legs, drive, time_available, parsedSleep, JSON.stringify(life_flags)]
        );
      }

      const nextDirective = await computeCheckinDirective(req.user.id, {
        feeling,
        legs,
        drive,
        time_available,
        life_flags,
      }, tx, { planningDateLocal: today });
      const overrideId = require('crypto').randomBytes(8).toString('hex');

      if (nextDirective.hasWorkoutToday) {
        await tx.run(
          `INSERT INTO checkin_overrides (id, user_id, date, action, patch_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, date) DO UPDATE SET
             action = excluded.action,
             patch_json = excluded.patch_json`,
          [overrideId, req.user.id, today, nextDirective.action, JSON.stringify(nextDirective.patch)]
        );
      } else {
        await tx.run('DELETE FROM checkin_overrides WHERE user_id=? AND date=?', [req.user.id, today]);
      }
      return nextDirective;
    });

    res.json({
      ok: true,
      adjustment: directive.adjustment,
      headline: directive.headline,
      drivers: directive.drivers,
      action: directive.action,
      feeling: directive.feeling,
      readiness_delta: directive.readiness_delta,
    });
  } catch (err) {
    console.error('[checkin] POST failed:', err);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

router.post('/preview', auth, async (req, res) => {
  try {
    const validation = validateCheckinPayload(req.body, { partial: true });
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }
    if (validation.incomplete) {
      return res.json({ headline: null, adjustment: null, drivers: [] });
    }

    if (req.body?.date !== undefined && req.body?.date !== null && !isPlanningDateAllowed(req.body.date)) {
      return res.status(400).json({ error: 'date must be the current phone date' });
    }
    const planningDateLocal = requestPlanningDate(req, { bodyKeys: ['date'], queryKeys: [] });
    const directive = await computeCheckinDirective(
      req.user.id,
      validation.value,
      undefined,
      { planningDateLocal }
    );

    res.json({
      headline: directive.headline,
      adjustment: directive.adjustment,
      drivers: directive.drivers,
    });
  } catch (err) {
    console.error('[checkin] PREVIEW failed:', err);
    res.status(500).json({ error: 'Check-in preview failed' });
  }
});

router.get('/today', auth, async (req, res) => {
  try {
    if (req.query?.date !== undefined && req.query?.date !== null && !isPlanningDateAllowed(req.query.date)) {
      return res.status(400).json({ error: 'date must be the current phone date' });
    }
    const today = requestPlanningDate(req, { bodyKeys: [], queryKeys: ['date'] });
    const checkin = await dbGet('SELECT * FROM daily_checkins WHERE user_id=? AND checkin_date=?', [req.user.id, today]);
    res.json(checkin || null);
  } catch(err) {
    console.error('[checkin] GET today failed:', err);
    res.status(500).json({ error: 'Failed to fetch check-in' });
  }
});

router._test = {
  computeCheckinDirective,
  getActivePlanForUser,
  normalizeTodayEntry,
  resolveTodayPlanState,
  activePlanViews,
  visibleActivePlan,
};

module.exports = router;
