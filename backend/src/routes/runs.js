const router = require('express').Router();
const { dbGet, dbAll, dbRun, withTransaction } = require('../db');
const auth   = require('../middleware/auth');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');
const { generateRunFeedback, generateLoadWarning, generateRunBrief } = require('../services/ai');
const autoUpdatePRs = require('../services/prAuto');
const { buildTcxWorkout } = require('../utils/tcxBuilder');
const { applyInterference } = require('../services/interference');
const { getWeather } = require('../services/weather');
const { classifyRunZone } = require('../lib/runHistory');
const { assessHeatDrift } = require('../lib/heatDrift');
const { getHrProfile, zoneForHr } = require('../lib/hrZones');
const { buildRunImportKeys } = require('../lib/runImportKey');
const { aiUsageWindows, canUseAiFeedback, resolveEntitlement } = require('../lib/betaAccess');
const {
  DISTANCE_CONFIG,
  normalizeSex,
  getAgeBracket,
  equivalentRaceSeconds,
  computeAgeGradedScore,
  getCompetitiveTier,
} = require('../lib/ageGrading');
const { buildHealthSignals } = require('../lib/healthSignals');
const { activityKind, isRunActivity, runActivitySql } = require('../lib/runActivity');
const { resolveRunEffort, withCalculatedEffort } = require('../lib/runEffort');
const { findPlannedRunForDate, hasMeaningfulPlannedRun } = require('../lib/plannedRunMatch');
const {
  classifyRouteIntegrity,
  normalizeDistanceEvidence,
  normalizePlanSessionId,
  normalizePlannedSession,
  normalizePostRunCheckIn,
  normalizeRouteCoords,
  shouldInvalidateRunFeedback,
} = require('../lib/runPostRun');

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeekMonday(d) {
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + mondayOffset);
  return startOfDay(monday);
}

function paceFromSeconds(distanceMiles, seconds) {
  if (!distanceMiles || !seconds) return '--';
  const paceSec = Math.round(seconds / distanceMiles);
  const m = Math.floor(paceSec / 60);
  const s = paceSec % 60;
  return `${m}:${String(s).padStart(2, '0')}/mi`;
}

function firstRoutePoint(routeCoords) {
  if (!Array.isArray(routeCoords) || routeCoords.length === 0) return null;
  const point = routeCoords[0];
  if (Array.isArray(point)) {
    const lat = Number(point[0]);
    const lon = Number(point[1]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }
  const lat = Number(point?.lat);
  const lon = Number(point?.lon ?? point?.lng);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function optionalBoundedNumber(value, maximum) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= maximum ? number : null;
}

function optionalIsoDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function generateStoredRunFeedback(run, userId) {
  if (run?.ai_feedback) return { feedback: run.ai_feedback, status: 'existing' };
  let claimed = false;
  const claimAt = new Date().toISOString();
  try {
    const claim = await dbRun(
      `UPDATE runs
       SET ai_feedback_requested_at=?
       WHERE id=? AND user_id=? AND ai_feedback IS NULL
         AND (
           ai_feedback_requested_at IS NULL
           OR ai_feedback_requested_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'
         )`,
      [claimAt, run.id, userId]
    );
    claimed = claim.changes > 0;
    if (!claimed) {
      const current = await dbGet(
        'SELECT ai_feedback FROM runs WHERE id=? AND user_id=?',
        [run.id, userId]
      );
      return current?.ai_feedback
        ? { feedback: current.ai_feedback, status: 'existing' }
        : { feedback: null, status: 'pending' };
    }

    const windows = aiUsageWindows();
    const [dailyRow, monthlyRow, profile] = await Promise.all([
      dbGet('SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id=? AND created_at>=?', [userId, windows.dailyStart]),
      dbGet('SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id=? AND created_at>=?', [userId, windows.monthlyStart]),
      dbGet('SELECT * FROM users WHERE id=?', [userId]),
    ]);
    const canCallAI = canUseAiFeedback(resolveEntitlement(profile), {
      dailyUsed: dailyRow?.cnt,
      monthlyUsed: monthlyRow?.cnt,
    });
    if (!canCallAI) {
      await dbRun(
        `UPDATE runs SET ai_feedback_requested_at=NULL
         WHERE id=? AND user_id=? AND ai_feedback IS NULL AND ai_feedback_requested_at=?`,
        [run.id, userId, claimAt]
      );
      return { feedback: null, status: 'limit' };
    }

    await dbRun('INSERT INTO ai_usage (id, user_id, call_type) VALUES (?,?,?)', [uuidv4(), userId, 'run_feedback']);
    const claimedRun = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [run.id, userId]);
    if (!claimedRun) return { feedback: null, status: 'unavailable' };
    const feedback = await generateRunFeedback(claimedRun, profile || {});
    if (!feedback) {
      await dbRun(
        `UPDATE runs SET ai_feedback_requested_at=NULL
         WHERE id=? AND user_id=? AND ai_feedback IS NULL AND ai_feedback_requested_at=?`,
        [run.id, userId, claimAt]
      );
      return { feedback: null, status: 'unavailable' };
    }

    const storedResult = await dbRun(
      `UPDATE runs SET ai_feedback=?
       WHERE id=? AND user_id=? AND ai_feedback IS NULL AND ai_feedback_requested_at=?`,
      [feedback, run.id, userId, claimAt]
    );
    const stored = await dbGet('SELECT ai_feedback FROM runs WHERE id=? AND user_id=?', [run.id, userId]);
    if (storedResult.changes === 0 && !stored?.ai_feedback) return { feedback: null, status: 'pending' };
    return { feedback: stored?.ai_feedback || feedback, status: storedResult.changes > 0 ? 'generated' : 'existing' };
  } catch (err) {
    console.error('[runs/feedback] generation failed:', err.message);
    if (claimed) {
      try {
        await dbRun(
          `UPDATE runs SET ai_feedback_requested_at=NULL
           WHERE id=? AND user_id=? AND ai_feedback IS NULL AND ai_feedback_requested_at=?`,
          [run.id, userId, claimAt]
        );
      } catch (releaseErr) {
        console.error('[runs/feedback] claim release failed:', releaseErr.message);
      }
    }
    return { feedback: null, status: 'unavailable' };
  }
}

function buildRunStructure({ recommendationType, suggestedDistance, suggestedPace }) {
  const distance = Number(suggestedDistance) || 0;
  const pace = String(suggestedPace || '').trim() || null;
  const type = {
    easy_run: 'easy',
    moderate_run: 'tempo',
    long_run: 'long',
  }[recommendationType] || recommendationType;

  const cleanBlock = (block) => Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== null && value !== undefined && value !== '')
  );
  const withDistanceAndPace = (block) => cleanBlock({
    ...block,
    distanceMiles: distance || null,
    paceTarget: pace,
  });

  switch (type) {
    case 'easy':
      return [
        cleanBlock({ phase: 'warmup', label: 'Warmup', durationMinutes: 10, hrZone: 2, description: 'Easy jog or brisk walk, RPE 3/10' }),
        withDistanceAndPace({ phase: 'main', label: 'Main', hrZone: 2, description: 'Conversational pace, Z2 heart rate' }),
        cleanBlock({ phase: 'cooldown', label: 'Cooldown', durationMinutes: 5, hrZone: 1, description: 'Walk + light mobility' }),
      ];
    case 'tempo':
      return [
        cleanBlock({ phase: 'warmup', label: 'Warmup', durationMinutes: 15, hrZone: 2, description: 'Easy 10 min + 4 strides' }),
        withDistanceAndPace({ phase: 'main', label: 'Tempo', hrZone: 4, description: 'Comfortably hard, controlled, Z3–Z4' }),
        cleanBlock({ phase: 'cooldown', label: 'Cooldown', durationMinutes: 10, hrZone: 1, description: 'Easy jog or walk' }),
      ];
    case 'intervals':
      return [
        cleanBlock({ phase: 'warmup', label: 'Warmup', durationMinutes: 15, hrZone: 2, description: 'Easy + 4 strides' }),
        cleanBlock({ phase: 'main', label: 'Intervals', hrZone: 4, description: distance >= 4 ? '6 × 800m @ 5K pace (90s rest)' : '5 × 400m @ 5K pace (60s rest)' }),
        cleanBlock({ phase: 'cooldown', label: 'Cooldown', durationMinutes: 10, hrZone: 1, description: 'Easy jog' }),
      ];
    case 'long':
      return [
        cleanBlock({ phase: 'warmup', label: 'Warmup', durationMinutes: 5, hrZone: 2, description: 'Easy first mile' }),
        withDistanceAndPace({ phase: 'main', label: 'Long run', hrZone: 2, description: 'Conversational, build aerobic base' }),
        cleanBlock({ phase: 'cooldown', label: 'Cooldown', durationMinutes: 5, hrZone: 1, description: 'Walk + hydrate' }),
      ];
    case 'recovery':
      return [
        cleanBlock({ phase: 'main', label: 'Recovery', durationMinutes: 25, hrZone: 1, description: 'Z1 only — easier than easy. Walk if needed.' }),
      ];
    case 'rest':
    case 'strength':
    default:
      return [];
  }
}

function runStructureOverheadMinutes(recommendationType) {
  if (recommendationType === 'moderate_run') return 25;
  if (recommendationType === 'long_run') return 10;
  return 15;
}

function detailsForRecommendation(type = 'easy_run', suggestedPace = '') {
  if (type === 'moderate_run') {
    return {
      targetZone: 'Zone 3',
      intensity: 'Comfortably hard',
      progression: 'Progression run — start easy, settle into steady rhythm, finish controlled.',
      steps: ['8-10 min easy', 'Middle miles steady', 'Last 5 min controlled'],
    };
  }
  if (type === 'long_run') {
    return {
      targetZone: 'Zone 2',
      intensity: 'Easy aerobic',
      progression: 'Long aerobic build — keep it conversational so the distance does the work.',
      steps: ['First mile relaxed', 'Hold even effort', 'Finish smooth'],
    };
  }
  return {
    targetZone: suggestedPace && suggestedPace !== '--' ? 'Zone 2' : 'Easy effort',
    intensity: 'Conversational aerobic',
    progression: 'Easy aerobic run — build consistency without forcing speed.',
    steps: ['5-10 min relaxed warm-up', 'Hold steady conversational pace', 'Cool down easy'],
  };
}

function parseLifeFlags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildCheckinSignals(checkin = null) {
  if (!checkin) {
    return {
      available: false,
      summary: 'No check-in has been completed today.',
      shouldRest: false,
      shouldReduceIntensity: false,
      timeAvailable: null,
      flags: [],
    };
  }

  const feeling = Number(checkin.feeling || 0);
  const sleepHours = checkin.sleep_hours === null || checkin.sleep_hours === undefined ? null : Number(checkin.sleep_hours);
  const timeAvailable = checkin.time_available === null || checkin.time_available === undefined ? null : Number(checkin.time_available);
  const lifeFlags = parseLifeFlags(checkin.life_flags);
  const flagSet = new Set(lifeFlags);
  const flags = [];

  if (feeling > 0 && feeling <= 2) flags.push('low energy');
  if (sleepHours !== null && sleepHours < 6) flags.push(`${sleepHours}h sleep`);
  if (timeAvailable !== null && timeAvailable <= 30) flags.push(`${timeAvailable} min available`);
  if (flagSet.has('sore')) flags.push('sore');
  if (flagSet.has('sick') || flagSet.has('not_well')) flags.push('not well');
  if (flagSet.has('long_shift')) flags.push('long shift');
  if (flagSet.has('traveling')) flags.push('traveling');
  if (flagSet.has('stressed')) flags.push('stressed');

  const shouldRest = feeling <= 1 || flagSet.has('sick') || flagSet.has('not_well') || (sleepHours !== null && sleepHours < 4.5);
  const shouldReduceIntensity = shouldRest
    || feeling <= 2
    || (sleepHours !== null && sleepHours < 6)
    || flagSet.has('sore')
    || flagSet.has('long_shift')
    || flagSet.has('traveling')
    || flagSet.has('stressed')
    || (timeAvailable !== null && timeAvailable <= 30);

  return {
    available: true,
    summary: flags.length ? `Check-in: ${flags.slice(0, 3).join(', ')}.` : 'Check-in supports a normal training day.',
    shouldRest,
    shouldReduceIntensity,
    timeAvailable: Number.isFinite(timeAvailable) ? timeAvailable : null,
    feeling: Number.isFinite(feeling) && feeling > 0 ? feeling : null,
    sleepHours: Number.isFinite(sleepHours) ? sleepHours : null,
    flags,
  };
}

function daysSince(dateString, today = new Date()) {
  const d = new Date(`${dateString}T12:00:00`);
  const a = startOfDay(today);
  const b = startOfDay(d);
  return Math.floor((a.getTime() - b.getTime()) / 86400000);
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

router.get('/', auth, async (req, res) => {
  try {
    const runs = await dbAll('SELECT * FROM runs WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 50', [req.user.id]);
    res.json({ runs: runs.map(withCalculatedEffort) });
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
      dbGet(`SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<? AND ${runActivitySql()}`, [req.user.id, thisWeekStart, thisWeekEnd]),
      dbGet(`SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<? AND ${runActivitySql()}`, [req.user.id, lastWeekStart, thisWeekStart]),
      dbAll(`SELECT date, duration_seconds, perceived_effort, heart_rate_zones,
                    workout_metrics_json, watch_mode, notes, pain_level, post_energy,
                    type, watch_activity_type, watch_normalized_type
             FROM runs
             WHERE user_id=? AND date>=? AND date<? AND ${runActivitySql()}
             ORDER BY date ASC`, [req.user.id, thisWeekStart, thisWeekEnd])
    ]);

    const thisWeekMiles = Number(twRow?.miles || 0);
    const lastWeekMiles = Number(lwRow?.miles || 0);
    const increasePercent = lastWeekMiles > 0 ? ((thisWeekMiles - lastWeekMiles) / lastWeekMiles) * 100 : (thisWeekMiles > 0 ? 100 : 0);

    let hardStreak = 0, maxHardStreak = 0;
    for (const r of runs) {
      if (Number(resolveRunEffort(r).score || 0) >= 7) { hardStreak++; maxHardStreak = Math.max(maxHardStreak, hardStreak); }
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

async function buildNextRecommendation(userId, { includeBrief = false } = {}) {
    const today = new Date();
    const fourteenDaysAgo = new Date(today);
    fourteenDaysAgo.setDate(today.getDate() - 14);
    const fourteenDaysAgoStr = fourteenDaysAgo.toISOString().slice(0, 10);
    const todayExclusive = new Date(today);
    todayExclusive.setDate(today.getDate() + 1);
    const todayExclusiveStr = todayExclusive.toISOString().slice(0, 10);

    const thisWeekStart = startOfWeekMonday(today);
    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(thisWeekStart.getDate() - 7);
    const nextWeekStart = new Date(thisWeekStart);
    nextWeekStart.setDate(thisWeekStart.getDate() + 7);

    const todayStr = today.toISOString().slice(0, 10);
    const [profile, recentRuns, recentWorkouts, thisWeekRow, lastWeekRow, recentPrRow, healthRow, checkinRow] = await Promise.all([
      dbGet('SELECT name, goal_type FROM users WHERE id=?', [userId]).catch(() => null),
      dbAll(`SELECT date, distance_miles, duration_seconds FROM runs WHERE user_id=? AND date>=? AND date<? AND ${runActivitySql()} ORDER BY date DESC, created_at DESC`, [userId, fourteenDaysAgoStr, todayExclusiveStr]),
      dbAll('SELECT started_at, muscle_groups, total_seconds FROM workout_sessions WHERE user_id=? ORDER BY started_at DESC, created_at DESC LIMIT 5', [userId]).catch(() => []),
      dbGet(`SELECT COALESCE(SUM(distance_miles),0) as miles, COUNT(*) as count FROM runs WHERE user_id=? AND date>=? AND date<? AND ${runActivitySql()}`, [userId, thisWeekStart.toISOString().slice(0, 10), nextWeekStart.toISOString().slice(0, 10)]),
      dbGet(`SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<? AND ${runActivitySql()}`, [userId, lastWeekStart.toISOString().slice(0, 10), thisWeekStart.toISOString().slice(0, 10)]),
      dbGet('SELECT label, achieved_at FROM personal_records WHERE user_id=? AND achieved_at>=? ORDER BY achieved_at DESC LIMIT 1', [userId, new Date(today.getTime() - (3 * 86400000)).toISOString().slice(0, 10)]),
      dbGet('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch(() => null),
      dbGet('SELECT feeling, time_available, sleep_hours, life_flags FROM daily_checkins WHERE user_id=? AND checkin_date=?', [userId, todayStr]).catch(() => null),
    ]);

    const avgDistance = recentRuns.length > 0
      ? recentRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0) / recentRuns.length
      : 3;
    const validPaceRuns = recentRuns.filter(r => Number(r.distance_miles || 0) > 0 && Number(r.duration_seconds || 0) > 0);
    const avgPaceSeconds = validPaceRuns.length > 0
      ? validPaceRuns.reduce((acc, r) => acc + (Number(r.duration_seconds) / Number(r.distance_miles)), 0) / validPaceRuns.length
      : 600;
    const suggestedPace = paceFromSeconds(1, avgPaceSeconds || 600);

    const lastRun = recentRuns[0] || null;
    const lastRunDaysAgo = lastRun?.date ? daysSince(lastRun.date, today) : null;
    const thisWeekMileage = Number(thisWeekRow?.miles || 0);
    const thisWeekRunCount = Number(thisWeekRow?.count || 0);
    const lastWeekMileage = Number(lastWeekRow?.miles || 0);
    const recentPrSet = Boolean(recentPrRow?.label);

    let recommendationType = 'easy_run';
    let reason = 'Build consistency with a controlled easy run.';
    let suggestedDistance = Number(Math.max(1.5, avgDistance * 0.7).toFixed(1));

    if (lastRunDaysAgo !== null && lastRunDaysAgo <= 1) {
      recommendationType = 'rest';
      reason = 'You ran today or yesterday. Recovery now will improve your next quality run.';
      suggestedDistance = 0;
    } else if (lastRunDaysAgo !== null && lastRunDaysAgo >= 2) {
      recommendationType = 'easy_run';
      reason = 'You have had at least 2 days off running. Restart with an easy aerobic run at about 70% effort.';
      suggestedDistance = Number(Math.max(1.5, avgDistance * 0.7).toFixed(1));
    } else if (lastWeekMileage > 0 && thisWeekMileage < (lastWeekMileage * 0.5)) {
      recommendationType = 'moderate_run';
      reason = 'This week is under 50% of last week mileage. A moderate run helps you rebuild training rhythm.';
      suggestedDistance = Number(Math.max(2, avgDistance * 0.9).toFixed(1));
    } else if (thisWeekRunCount >= 3) {
      recommendationType = 'strength';
      reason = 'You already logged 3+ runs this week. Use today for strength or mobility while your running load settles.';
      suggestedDistance = 0;
    } else if (recentPrSet) {
      recommendationType = 'easy_run';
      reason = `Recent PR (${recentPrRow.label}) in the last 3 days. Keep this session easy to absorb the work.`;
      suggestedDistance = Number(Math.max(1.5, avgDistance * 0.6).toFixed(1));
    }

    const healthSignals = buildHealthSignals(healthRow || {});
    let healthAdjusted = false;
    if (healthSignals.available) {
      if (healthSignals.shouldRest) {
        recommendationType = 'rest';
        reason = `${healthSignals.summary} Forged Hybrid is switching today to recovery so your next run is higher quality.`;
        suggestedDistance = 0;
        healthAdjusted = true;
      } else if (healthSignals.shouldReduceIntensity && recommendationType !== 'rest' && recommendationType !== 'strength') {
        recommendationType = 'easy_run';
        reason = `${healthSignals.summary} Forged Hybrid lowered this to an easy aerobic run.`;
        suggestedDistance = Number(Math.max(1, suggestedDistance * 0.75).toFixed(1));
        healthAdjusted = true;
      } else if (healthSignals.recoveryState === 'strong' && recommendationType === 'easy_run' && lastRunDaysAgo !== null && lastRunDaysAgo >= 2) {
        reason = `${reason} ${healthSignals.summary} You can keep this controlled, not all-out.`;
        suggestedDistance = Number(Math.max(suggestedDistance, avgDistance * 0.8).toFixed(1));
        healthAdjusted = true;
      }
    }

    const checkinSignals = buildCheckinSignals(checkinRow || null);
    let checkinAdjusted = false;
    if (checkinSignals.available) {
      if (checkinSignals.shouldRest) {
        recommendationType = 'rest';
        reason = `${checkinSignals.summary} Forged Hybrid is switching today to recovery.`;
        suggestedDistance = 0;
        checkinAdjusted = true;
      } else if (checkinSignals.shouldReduceIntensity && recommendationType !== 'rest' && recommendationType !== 'strength') {
        recommendationType = 'easy_run';
        reason = `${checkinSignals.summary} Forged Hybrid lowered this to an easy controlled run.`;
        suggestedDistance = Number(Math.max(1, suggestedDistance * 0.75).toFixed(1));
        checkinAdjusted = true;
      }

      if (checkinSignals.timeAvailable !== null && checkinSignals.timeAvailable > 0 && recommendationType !== 'rest' && recommendationType !== 'strength') {
        const paceSeconds = avgPaceSeconds || 600;
        const runningMinutes = Math.max(5, checkinSignals.timeAvailable - runStructureOverheadMinutes(recommendationType));
        const maxDistanceByTime = Math.max(0.5, (runningMinutes * 60) / paceSeconds);
        if (suggestedDistance > maxDistanceByTime) {
          suggestedDistance = Number(maxDistanceByTime.toFixed(1));
          reason = `${checkinSignals.summary} Forged Hybrid capped the run to fit your available time.`;
          checkinAdjusted = true;
        }
      }
    }

    if (recommendationType === 'strength' || recommendationType === 'rest') {
      const recommendation = {
        recommendationType,
        reason,
        suggestedDistance: 0,
        suggestedPace: '--',
        targetZone: recommendationType === 'rest' ? 'Recovery' : 'Strength',
        intensity: recommendationType === 'rest' ? 'Rest' : 'Strength support',
        progression: recommendationType === 'rest' ? 'Recovery day — no run target today.' : 'Lift or mobility day to support the next run.',
        steps: recommendationType === 'rest' ? ['Walk or mobility only if it helps you feel better'] : ['Warm up', 'Strength session', 'Mobility cooldown'],
        structure: buildRunStructure({ recommendationType, suggestedDistance: 0, suggestedPace: '--' }),
        healthAdjusted,
        healthSignals,
        checkinAdjusted,
        checkinSignals,
      };
      return applyInterference(recommendation, recentWorkouts);
    }

    const details = detailsForRecommendation(recommendationType, suggestedPace);
    let recommendation = {
      recommendationType,
      reason,
      suggestedDistance,
      suggestedPace,
      ...details,
      structure: buildRunStructure({ recommendationType, suggestedDistance, suggestedPace }),
      healthAdjusted,
      healthSignals,
      checkinAdjusted,
      checkinSignals,
    };

    recommendation = applyInterference(recommendation, recentWorkouts);

    if (!includeBrief) return recommendation;

    try {
      const brief = await Promise.race([
        generateRunBrief({ run: recommendation, profile, recentRuns, recentLifts: recentWorkouts, userId }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('brief-timeout')), 3000)),
      ]);
      if (brief && typeof brief === 'object') {
        recommendation.brief = {
          why: brief.why,
          effort: brief.effort,
          bpmRange: brief.bpmRange,
          cadence: brief.cadence,
        };
      } else {
        console.warn('[next-recommendation] brief failed:', 'empty-brief');
      }
    } catch (err) {
      console.warn('[next-recommendation] brief failed:', err.message);
    }

    return recommendation;
}

router.get('/next-recommendation', auth, async (req, res) => {
  try {
    res.json(await buildNextRecommendation(req.user.id, { includeBrief: true }));
  } catch (err) {
    res.status(500).json({ error: 'Recommendation failed' });
  }
});

router.get('/today-workout.tcx', auth, async (req, res) => {
  try {
    const recommendation = await buildNextRecommendation(req.user.id);
    if (!recommendation.structure?.length) {
      res.status(404).json({ error: 'No structured workout for today' });
      return;
    }
    const typeName = String(recommendation.recommendationType || 'forge').replace(/_/g, ' ');
    const tcx = buildTcxWorkout({ name: `${typeName} run`, structure: recommendation.structure });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.garmin.tcx+xml');
    res.setHeader('Content-Disposition', `attachment; filename="forge-workout-${date}.tcx"`);
    res.send(tcx);
  } catch (err) {
    res.status(500).json({ error: 'Workout export failed' });
  }
});

router.get('/age-graded-performance', auth, async (req, res) => {
  try {
    const since365 = isoDateDaysAgo(365);
    const since90 = isoDateDaysAgo(90);

    const [profile, userRuns, seniorRuns] = await Promise.all([
      dbGet('SELECT age, sex FROM users WHERE id=?', [req.user.id]),
      dbAll(
        `SELECT date, distance_miles, duration_seconds
         FROM runs
         WHERE user_id=? AND date>=? AND duration_seconds>0 AND distance_miles>0 AND ${runActivitySql()}
         ORDER BY date DESC`,
        [req.user.id, since365]
      ),
      dbAll(
        `SELECT r.user_id, r.date, r.distance_miles, r.duration_seconds, u.age, u.sex
         FROM runs r
         INNER JOIN users u ON u.id = r.user_id
         WHERE u.age>=40 AND r.date>=? AND r.duration_seconds>0 AND r.distance_miles>0 AND ${runActivitySql('r')}`,
        [since365]
      ),
    ]);

    const userAge = Number(profile?.age);
    const ageProvided = Number.isFinite(userAge) && userAge >= 10 && userAge <= 110;
    const userSex = normalizeSex(profile?.sex);
    const userAgeBracket = ageProvided ? getAgeBracket(userAge) : null;
    const canBenchmarkSeniors = ageProvided && userAge >= 40;

    const peerBestByDistance = { '5k': new Map(), '10k': new Map() };
    const activeSeniorUsers90d = new Set();
    const distanceKeys = Object.keys(DISTANCE_CONFIG);

    for (const row of seniorRuns) {
      const peerAge = Number(row.age);
      if (!Number.isFinite(peerAge) || peerAge < 40) continue;

      const peerSex = normalizeSex(row.sex);
      for (const distanceKey of distanceKeys) {
        const normalizedSeconds = equivalentRaceSeconds(row.duration_seconds, row.distance_miles, distanceKey);
        if (!normalizedSeconds) continue;
        if (String(row.date || '') >= since90) activeSeniorUsers90d.add(row.user_id);

        const score = computeAgeGradedScore(distanceKey, peerSex, peerAge, normalizedSeconds);
        if (!score) continue;

        const previous = peerBestByDistance[distanceKey].get(row.user_id);
        if (!previous || score > previous.score) {
          peerBestByDistance[distanceKey].set(row.user_id, {
            userId: row.user_id,
            score,
            ageBracket: getAgeBracket(peerAge),
          });
        }
      }
    }

    const distances = distanceKeys.map((distanceKey) => {
      const config = DISTANCE_CONFIG[distanceKey];
      let best = null;

      for (const run of userRuns) {
        const normalizedSeconds = equivalentRaceSeconds(run.duration_seconds, run.distance_miles, distanceKey);
        if (!normalizedSeconds) continue;
        if (!best || normalizedSeconds < best.normalizedSeconds) {
          best = {
            date: run.date,
            durationSeconds: Number(run.duration_seconds || 0),
            normalizedSeconds,
          };
        }
      }

      if (!best) {
        return { key: distanceKey, label: config.label, hasResult: false };
      }

      const score = ageProvided
        ? computeAgeGradedScore(distanceKey, userSex, userAge, best.normalizedSeconds)
        : null;
      const tier = score ? getCompetitiveTier(score) : null;

      let percentile = null;
      let rank = null;
      let fieldSize = null;
      let peerGroup = null;
      if (canBenchmarkSeniors && score) {
        const allPeers = Array.from(peerBestByDistance[distanceKey].values());
        const agePeers = allPeers.filter((peer) => peer.ageBracket === userAgeBracket);
        const pool = agePeers.length >= 8 ? agePeers : allPeers;
        const competitors = pool.filter((peer) => peer.userId !== req.user.id);

        const betterCount = competitors.filter((peer) => peer.score > score).length;
        const position = betterCount + 1;
        const participants = competitors.length + 1;

        rank = position;
        fieldSize = participants;
        percentile = participants <= 1
          ? 100
          : Math.max(0, Math.min(100, Math.round(((participants - position) / (participants - 1)) * 100)));
        peerGroup = agePeers.length >= 8 ? userAgeBracket : 'All seniors 40+';
      }

      return {
        key: distanceKey,
        label: config.label,
        hasResult: true,
        bestDate: best.date,
        bestDurationSeconds: Math.round(best.durationSeconds),
        normalizedDurationSeconds: Math.round(best.normalizedSeconds),
        ageGradedScore: score,
        competitiveTier: tier?.label || null,
        competitiveTierKey: tier?.key || null,
        percentile,
        rank,
        fieldSize,
        peerGroup,
      };
    });

    res.json({
      ageProvided,
      seniorEligible: canBenchmarkSeniors,
      athlete: {
        age: ageProvided ? Math.round(userAge) : null,
        sex: userSex,
        ageBracket: userAgeBracket,
      },
      community: {
        activeSeniorRunners90d: activeSeniorUsers90d.size,
      },
      distances,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute age-graded performance' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const enrichedRun = withCalculatedEffort(run);
    if (isRunActivity(run) && !hasMeaningfulPlannedRun(run.planned_session_json)) {
      const planned = await findPlannedRunForDate(req.user.id, String(run.date || '').slice(0, 10));
      if (planned) {
        return res.json({
          run: {
            ...enrichedRun,
            plan_session_id: planned.sessionId || null,
            planned_session_json: JSON.stringify(planned),
            planned_match_source: planned.matchSource,
          },
        });
      }
    }
    res.json({ run: { ...enrichedRun, planned_match_source: hasMeaningfulPlannedRun(run.planned_session_json) ? 'saved' : null } });
  } catch (err) {
    console.error('[runs/detail] fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch run' });
  }
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
      watch_sync_id, watch_activity_type, watch_normalized_type, gps_available,
      target_zone, plan_session_id, planned_session, activity_start_at, activity_end_at,
      id: clientRunId
    } = req.body;
    if (!date || !type) return res.status(400).json({ error: 'date and type required' });
    if (perceived_effort !== undefined && perceived_effort !== null) {
      const pe = Number(perceived_effort);
      if (!Number.isFinite(pe) || pe < 1 || pe > 10) {
        return res.status(400).json({ error: 'perceived_effort must be between 1 and 10' });
      }
    }

    const id = uuidValidate(String(clientRunId || '')) ? clientRunId : uuidv4();
    const resolvedSurface = surface || run_surface || 'road';
    const resolvedElevationGain = optionalBoundedNumber(elevation_gain, 100000);
    const resolvedElevationLoss = optionalBoundedNumber(elevation_loss, 100000);
    const normalizedRouteCoords = normalizeRouteCoords(route_coords);
    const resolvedActivityStart = optionalIsoDate(activity_start_at);
    const candidateActivityEnd = optionalIsoDate(activity_end_at);
    const resolvedActivityEnd = resolvedActivityStart && candidateActivityEnd
      && new Date(candidateActivityEnd).getTime() >= new Date(resolvedActivityStart).getTime()
      ? candidateActivityEnd
      : null;
    const recordingHealthSource = resolvedActivityStart ? 'forged_hybrid' : null;
    const recordingSourceId = recordingHealthSource ? id : null;
    const distanceEvidence = normalizeDistanceEvidence(
      distance_miles === undefined || distance_miles === null || distance_miles === ''
        ? []
        : [{ value: distance_miles, unit: 'miles', source: recordingHealthSource ? 'forged_phone' : 'manual' }]
    );
    if (distanceEvidence.error) return res.status(400).json({ error: distanceEvidence.error });
    const resolvedDistanceMiles = distanceEvidence.miles ?? 0;
    const routeIntegrity = classifyRouteIntegrity({
      routeCoords: normalizedRouteCoords,
      materialGap: typeof notes === 'string' && /^\[gps_gap_notice:/.test(notes),
      coverageIncomplete: gps_available === false,
    });
    const recordingMetrics = {
      ...(distanceEvidence.source ? {
        distance_source: distanceEvidence.source,
        distance_unit: distanceEvidence.unit,
      } : {}),
      route_status: routeIntegrity.status,
      route_point_count: routeIntegrity.pointCount,
      route_status_reason: routeIntegrity.reason,
    };
    let resolvedPlanSessionId = normalizePlanSessionId(plan_session_id);
    let resolvedPlannedSession = normalizePlannedSession(planned_session, resolvedPlanSessionId);
    const planMatchExplicitlyDisabled = Object.prototype.hasOwnProperty.call(req.body || {}, 'plan_session_id')
      && plan_session_id === null;
    if (!planMatchExplicitlyDisabled
      && !hasMeaningfulPlannedRun(resolvedPlannedSession)
      && isRunActivity({ type, watch_activity_type, watch_normalized_type })) {
      const scheduledRun = await findPlannedRunForDate(req.user.id, String(date).slice(0, 10));
      if (scheduledRun) {
        resolvedPlannedSession = scheduledRun;
        resolvedPlanSessionId = scheduledRun.sessionId || resolvedPlanSessionId;
      }
    }
    let prescribedTargetZone = typeof target_zone === 'string' && target_zone.length <= 20 ? target_zone.trim() || null : null;
    if (!prescribedTargetZone) {
      try {
        const recommendation = await buildNextRecommendation(req.user.id, { includeBrief: false });
        prescribedTargetZone = recommendation?.targetZone || null;
      } catch (err) {
        console.error('[runs] heat drift target lookup failed:', err);
      }
    }

    const insertResult = await dbRun(`INSERT INTO runs (
      id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes,
      run_surface, surface, incline_pct, treadmill_speed, route_coords, watch_mode,
      avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones,
      cadence_spm, elevation_gain, elevation_loss, pace_avg, pace_splits,
      vo2_max, training_effect_aerobic, training_effect_anaerobic, recovery_time_hours,
      detected_surface_type, temperature_f, calories, treadmill_brand, treadmill_model,
      watch_sync_id, watch_activity_type, watch_normalized_type, gps_available,
      plan_session_id, planned_session_json, health_source, health_source_workout_id,
      health_start_at, health_end_at, workout_metrics_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING`, [
      id, req.user.id, date, type, resolvedDistanceMiles, duration_seconds || 0, perceived_effort ?? null, notes || null,
      resolvedSurface, resolvedSurface, incline_pct || 0, treadmill_speed || 0, JSON.stringify(normalizedRouteCoords), watch_mode || null,
      avg_heart_rate || null, max_heart_rate || null, min_heart_rate || null, JSON.stringify(heart_rate_zones || []),
      cadence_spm || null, resolvedElevationGain, resolvedElevationLoss, pace_avg || null, JSON.stringify(pace_splits || []),
      vo2_max || null, training_effect_aerobic || null, training_effect_anaerobic || null, recovery_time_hours || null,
      detected_surface_type || null, temperature_f || null, calories || 0, treadmill_brand || null, treadmill_model || null,
      watch_sync_id || null, watch_activity_type || null, watch_normalized_type || null, gps_available === false ? 0 : 1,
      resolvedPlanSessionId, JSON.stringify(resolvedPlannedSession || {}), recordingHealthSource, recordingSourceId,
      resolvedActivityStart, resolvedActivityEnd, JSON.stringify(recordingMetrics)
    ]);
    if (insertResult.changes === 0) {
      const existingRun = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [id, req.user.id]);
      if (!existingRun) return res.status(409).json({ error: 'Run id already exists' });
      return res.status(200).json({
        run: existingRun,
        heatDrift: { drifted: false },
        newPRs: [],
        discrepancies: [],
      });
    }

    const [userProfile, hrProfile] = await Promise.all([
      dbGet('SELECT weight_lbs, max_heart_rate FROM users WHERE id=?', [req.user.id]),
      getHrProfile(req.user.id, dbGet),
    ]);
    const weightLbs = userProfile?.weight_lbs || 185;
    const computedCalories = Math.round(0.75 * weightLbs * resolvedDistanceMiles);
    const resolvedCalories = Number(calories || 0) > 0 ? Number(calories) : computedCalories;
    if (resolvedCalories > 0) {
      await dbRun('UPDATE runs SET calories=? WHERE id=? AND user_id=?', [resolvedCalories, id, req.user.id]);
    }

    if ((duration_seconds || 0) > 0 && resolvedDistanceMiles > 0) {
      const durationHours = (duration_seconds || 0) / 3600;
      const paceMinsPerMile = ((duration_seconds || 0) / 60) / resolvedDistanceMiles;
      const met = paceMinsPerMile < 8 ? 12.0 : paceMinsPerMile <= 10 ? 10.0 : 8.0;
      const weightKg = weightLbs / 2.205;
      const calories_burned = Math.round(met * weightKg * durationHours);
      if (calories_burned > 0) {
        await dbRun('UPDATE runs SET calories_burned=? WHERE id=? AND user_id=?', [calories_burned, id, req.user.id]);
      }
    }

    const run = await dbGet('SELECT * FROM runs WHERE id = ? AND user_id = ?', [id, req.user.id]);
    let heatDrift = { drifted: false };
    try {
      const actualZone = zoneForHr(avg_heart_rate, hrProfile)
        || classifyRunZone(avg_heart_rate, userProfile?.max_heart_rate);
      if (actualZone && prescribedTargetZone) {
        const point = firstRoutePoint(route_coords);
        const weather = point
          ? await getWeather(point.lat, point.lon)
          : { available: false, reason: 'No route start point available' };
        heatDrift = assessHeatDrift({
          actualZone,
          targetZone: prescribedTargetZone,
          weather,
        });
      }
    } catch (err) {
      console.error('[runs] heat drift assessment failed:', err);
      heatDrift = { drifted: false };
    }

    let prResult = { newPRs: [], discrepancies: [] };
    try { prResult = await autoUpdatePRs(req.user.id, run) || prResult; } catch (e) { console.error('PR auto-detect:', e); }

    res.status(201).json({ run, heatDrift, newPRs: prResult.newPRs, discrepancies: prResult.discrepancies });

  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Failed to save run' });
  }
});

async function updateRunHandler(req, res) {
  try {
    const { date, distance_miles, duration_seconds, notes, perceived_effort, type, run_surface, incline_pct, treadmill_speed, pain_level, post_energy } = req.body;
    const validPainLevels = ['none', 'mild', 'moderate', 'severe'];
    const validEnergyLevels = ['low', 'medium', 'high'];
    const invalidatesFeedback = shouldInvalidateRunFeedback(req.body);

    if (pain_level !== undefined && pain_level !== null && !validPainLevels.includes(String(pain_level))) {
      return res.status(400).json({ error: 'Invalid pain_level' });
    }
    if (post_energy !== undefined && post_energy !== null && !validEnergyLevels.includes(String(post_energy))) {
      return res.status(400).json({ error: 'Invalid post_energy' });
    }

    const updated = await withTransaction(async (tx) => {
      const run = await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      if (!run) {
        const notFound = new Error('Run not found');
        notFound.status = 404;
        throw notFound;
      }

      const userProfile = await tx.get('SELECT weight_lbs FROM users WHERE id=?', [req.user.id]);
      const weightLbs = userProfile?.weight_lbs || 185;
      const newDist = distance_miles !== undefined ? Number(distance_miles) : run.distance_miles;
      const calories = Math.round(0.75 * weightLbs * newDist);
      const activityKindChanged = type !== undefined && activityKind({ ...run, type }) !== activityKind(run);
      const shouldRecomputePrs = (
        distance_miles !== undefined && Number(distance_miles) !== Number(run.distance_miles)
      ) || (
        duration_seconds !== undefined && Number(duration_seconds) !== Number(run.duration_seconds)
      ) || activityKindChanged;
      const existingPrRows = shouldRecomputePrs
        ? await tx.all(
          `SELECT label FROM personal_records WHERE run_id=? AND user_id=? AND category='run' AND source='auto'`,
          [req.params.id, req.user.id]
        )
        : [];

      await tx.run(`UPDATE runs SET
        date = COALESCE(?, date),
        distance_miles = COALESCE(?, distance_miles),
        duration_seconds = COALESCE(?, duration_seconds),
        notes = COALESCE(?, notes),
        perceived_effort = COALESCE(?, perceived_effort),
        type = COALESCE(?, type),
        run_surface = COALESCE(?, run_surface),
        incline_pct = COALESCE(?, incline_pct),
        treadmill_speed = COALESCE(?, treadmill_speed),
        pain_level = COALESCE(?, pain_level),
        post_energy = COALESCE(?, post_energy),
        ai_feedback = CASE WHEN ?=1 THEN NULL ELSE ai_feedback END,
        ai_feedback_requested_at = CASE WHEN ?=1 THEN NULL ELSE ai_feedback_requested_at END,
        calories = ?
        WHERE id=? AND user_id=?`, [
        date ?? null, distance_miles ?? null, duration_seconds ?? null,
        notes ?? null, perceived_effort ?? null, type ?? null,
        run_surface ?? null, incline_pct ?? null, treadmill_speed ?? null,
        pain_level ?? null, post_energy ?? null,
        invalidatesFeedback ? 1 : 0, invalidatesFeedback ? 1 : 0,
        calories, req.params.id, req.user.id
      ]);

      const nextRun = await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      if (shouldRecomputePrs) {
        const labels = existingPrRows.map((row) => row.label);
        await autoUpdatePRs.recomputeRunPrCategories(req.user.id, labels, { tx });
        await autoUpdatePRs(req.user.id, nextRun, { tx });
      }
      return nextRun;
    });
    res.json(withCalculatedEffort(updated));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Run not found' });
    console.error('[runs/update] failed:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
}

router.patch('/:id/check-in', auth, async (req, res) => {
  const normalized = normalizePostRunCheckIn(req.body || {});
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  try {
    const updatedRun = await withTransaction(async (tx) => {
      const run = await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      if (!run) {
        const notFound = new Error('Run not found');
        notFound.status = 404;
        throw notFound;
      }
      if (!isRunActivity(run)) {
        const wrongType = new Error('Post-run check-in is only available for running activities');
        wrongType.status = 400;
        throw wrongType;
      }

      const values = normalized.value;
      const changed = Number(run.perceived_effort) !== values.perceived_effort
        || String(run.pain_level || '') !== values.pain_level
        || String(run.post_energy || '') !== String(values.post_energy || '');
      if (changed) {
        await tx.run(
          `UPDATE runs
           SET perceived_effort=?, pain_level=?, post_energy=?, ai_feedback=NULL,
               ai_feedback_requested_at=NULL
           WHERE id=? AND user_id=?`,
          [values.perceived_effort, values.pain_level, values.post_energy, req.params.id, req.user.id]
        );
      }
      return tx.get('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    });

    const feedbackResult = updatedRun.ai_feedback
      ? { feedback: updatedRun.ai_feedback, status: 'existing' }
      : await generateStoredRunFeedback(updatedRun, req.user.id);
    res.json({
      ok: true,
      run: withCalculatedEffort(updatedRun),
      feedback: feedbackResult.feedback || null,
      feedbackStatus: feedbackResult.status,
    });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Run not found' });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[runs/check-in] failed:', err.message);
    res.status(500).json({ error: 'Post-run check-in failed' });
  }
});

router.put('/:id', auth, updateRunHandler);
router.patch('/:id', auth, updateRunHandler);

router.post('/:id/feedback', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (!isRunActivity(run)) return res.status(400).json({ error: 'Run feedback is only available for running activities' });
    if (run.ai_feedback) return res.json({ feedback: run.ai_feedback });

    const result = await generateStoredRunFeedback(run, req.user.id);
    if (result.status === 'limit') return res.status(429).json({ error: 'AI limit reached for today.' });
    if (result.status === 'pending') return res.status(202).json({ feedback: null, pending: true });
    if (!result.feedback) return res.status(503).json({ error: 'Could not generate feedback right now.' });
    res.json({ feedback: result.feedback });
  } catch (err) {
    console.error('[runs/feedback] failed:', err.message);
    res.status(500).json({ error: 'Feedback failed' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await withTransaction(async (tx) => {
      const run = await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      if (!run) {
        const notFound = new Error('Run not found');
        notFound.status = 404;
        throw notFound;
      }
      const prRows = await tx.all(
        `SELECT label FROM personal_records WHERE run_id=? AND user_id=? AND category='run' AND source='auto'`,
        [req.params.id, req.user.id]
      );
      const importKeys = buildRunImportKeys({
        healthSource: run.health_source,
        sourceWorkoutId: run.health_source_workout_id,
        startDate: run.health_start_at,
        type: run.type,
        watchActivityType: run.watch_activity_type,
        watchNormalizedType: run.watch_normalized_type,
        distanceMiles: run.distance_miles,
        durationSeconds: run.duration_seconds,
      });
      for (const sourceKey of importKeys) {
        await tx.run(
          `INSERT INTO run_import_tombstones (id, user_id, source_key)
           VALUES (?, ?, ?)
           ON CONFLICT (user_id, source_key) DO NOTHING`,
          [uuidv4(), req.user.id, sourceKey]
        );
      }
      await tx.run(
        `DELETE FROM activity_media
         WHERE user_id=? AND activity_type='community_post'
           AND activity_id IN (
             SELECT id FROM community_posts WHERE run_id=? AND user_id=?
           )`,
        [req.user.id, req.params.id, req.user.id]
      );
      await tx.run(
        'DELETE FROM community_posts WHERE run_id=? AND user_id=?',
        [req.params.id, req.user.id]
      );
      await tx.run('DELETE FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
      await autoUpdatePRs.recomputeRunPrCategories(req.user.id, prRows.map((row) => row.label), { tx });
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    console.error('[runs/delete] failed:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
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
