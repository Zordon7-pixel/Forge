const router = require('express').Router();
const { dbGet, dbAll, dbRun, withTransaction } = require('../db');
const auth = require('../middleware/auth');
const { requirePremium } = require('../middleware/premiumGate');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { generateRaceAdjustment } = require('../services/ai');
const { buildHealthSignals } = require('../lib/healthSignals');
const { applyOverride } = require('../lib/checkinOverride');
const planSchema = require('../lib/planSchema');
const concurrentPlan = require('../lib/concurrentPlan');
const adaptationEngine = require('../lib/adaptationEngine');
const dailyExecution = require('../lib/dailyExecution');
const { getHrProfile } = require('../lib/hrZones');
const { summarizeRecentRunLoad } = require('../lib/recentRunLoad');
const { repairPlanPrescriptions } = require('../lib/prescriptionIntegrity');
const { summarizeRecentExercises } = require('../lib/strengthPrescription');
const { runActivitySql } = require('../lib/runActivity');

const ADAPTATION_POLICY_VERSION = 'training-gap-v1';

function getDayShort() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

function normalizeTodayEntry(planJson) {
  if (!planJson?.weeks?.length) return null;
  const today = getDayShort();
  for (const week of planJson.weeks) {
    const days = planSchema.getDayEntries(week);
    const hit = days.find(d => d?.day === today);
    // Session-aware (H1): a schema-v2 day is flattened to the legacy single-day
    // shape; legacy days pass through unchanged (byte-identical).
    if (hit) return planSchema.flattenDayForConsumer(hit);
  }
  return null;
}

function getMonday(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function getPlanStartMonday(date = new Date()) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  const daysUntilMonday = day === 1 ? 0 : (8 - day) % 7;
  d.setDate(d.getDate() + daysUntilMonday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayISO(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getPlanningDateFromRequest(req) {
  const serverDate = getTodayISO();
  const requested = String(req.query?.date || '').trim();
  if (!requested) return serverDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return null;
  const offsetDays = daysBetween(requested, serverDate);
  return offsetDays !== null && Math.abs(offsetDays) <= 1 ? requested : null;
}

function parsePlan(plan) {
  try {
    let parsed;
    if (plan?.plan_data) {
      parsed = typeof plan.plan_data === 'string' ? JSON.parse(plan.plan_data) : plan.plan_data;
    } else {
      parsed = typeof plan?.plan_json === 'string' ? JSON.parse(plan.plan_json) : plan?.plan_json;
    }
    return repairPlanPrescriptions(parsed);
  } catch (err) {
    console.error('[plans/parsePlan] invalid plan JSON:', err.message);
    return null;
  }
}

function parseJsonValue(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[plans/parseJsonValue] invalid JSON:', err.message);
    return fallback;
  }
}

function planVersionFor(active, parsedPlan) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      adaptationPolicyVersion: ADAPTATION_POLICY_VERSION,
      source: active?.source || null,
      planId: active?.row?.id || null,
      userPlanId: active?.row?.user_plan_id || null,
      plan: parsedPlan || null,
    }))
    .digest('hex')
    .slice(0, 32);
}

function daysBetween(leftISO, rightISO) {
  const left = adaptationEngine.parseISODate(leftISO);
  const right = adaptationEngine.parseISODate(rightISO);
  if (!left || !right) return null;
  return Math.round((left.getTime() - right.getTime()) / 86400000);
}

function freshnessForAsOf(asOf, planningDateISO, valuePresent, suspect = false) {
  if (suspect) return 'suspect';
  if (!valuePresent) return 'no_data';
  const asOfDate = String(asOf || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return 'unknown';
  const diff = daysBetween(planningDateISO, asOfDate);
  return diff !== null && diff >= -1 && diff <= 2 ? 'fresh' : 'stale';
}

function adaptationMetric(value, source, asOf, planningDateISO, suspect = false) {
  const valuePresent = value !== null && value !== undefined && value !== '';
  return {
    value: valuePresent ? value : null,
    source: source || 'apple_health',
    asOf: asOf || null,
    freshness: freshnessForAsOf(asOf, planningDateISO, valuePresent, suspect),
    suspect: Boolean(suspect),
  };
}

function buildAdaptationHealthSignals(healthRow, planningDateISO) {
  const row = healthRow || {};
  const derived = buildHealthSignals(row);
  const asOf = row.synced_at || row.updated_at || null;
  const rawSleep = row.sleep_hours_last_night === null || row.sleep_hours_last_night === undefined
    ? null
    : Number(row.sleep_hours_last_night);
  const suspectSleep = Number.isFinite(rawSleep) && rawSleep > 12;
  const source = row.health_source || 'apple_health';
  return {
    recoveryState: derived.recoveryState,
    shouldReduceIntensity: Boolean(derived.shouldReduceIntensity),
    shouldRest: Boolean(derived.shouldRest),
    metrics: {
      readinessScore: adaptationMetric(derived.readinessScore, source, asOf, planningDateISO, false),
      sleepHoursLastNight: adaptationMetric(
        suspectSleep ? rawSleep : derived.metrics?.sleepHoursLastNight,
        source,
        derived.metrics?.sleepEndAt || asOf,
        planningDateISO,
        suspectSleep
      ),
      hrvMs: adaptationMetric(derived.metrics?.hrvMs, source, derived.metrics?.hrvRecordedAt || asOf, planningDateISO, false),
      restingHeartRate: adaptationMetric(derived.metrics?.restingHeartRate, source, derived.metrics?.restingHeartRateRecordedAt || asOf, planningDateISO, false),
      acuteChronicLoadRatio: adaptationMetric(derived.metrics?.acuteChronicLoadRatio, source, asOf, planningDateISO, false),
    },
  };
}

function plannedSessionsBetween(plan, startISO, endISO) {
  const rows = [];
  const weeks = Array.isArray(plan?.weeks) ? plan.weeks : [];
  for (const week of weeks) {
    const days = planSchema.getDayEntries(week);
    days.forEach((day, dayIndex) => {
      const date = day?.date;
      if (!date || date < startISO || date > endISO) return;
      planSchema.daySessions(day).forEach((session, sessionIndex) => {
        const kind = planSchema.kindFromSession(session);
        if (kind !== 'run' && kind !== 'lift') return;
        rows.push({
          sessionId: planSchema.sessionIdentifier(day, session, sessionIndex, dayIndex),
          date,
          kind,
        });
      });
    });
  }
  return rows;
}

function dateWithinOneDay(actualISO, targetISO) {
  const diff = daysBetween(String(actualISO || '').slice(0, 10), targetISO);
  return diff !== null && Math.abs(diff) <= 1;
}

async function buildCompletionSummaryForAdaptation(userId, plan, active, planningDateISO) {
  const since = adaptationEngine.addDays(planningDateISO, -7);
  const planned = plannedSessionsBetween(plan, since, adaptationEngine.addDays(planningDateISO, -1));
  const progress = parseJsonValue(active?.row?.progress_json, {});
  const completedIds = new Set((Array.isArray(progress?.completedSessionIds) ? progress.completedSessionIds : []).map(String));
  const [runs, lifts, workouts, lastRun, lastLift, lastWorkout] = await Promise.all([
    dbAll(`SELECT id, date FROM runs WHERE user_id=? AND date>=? AND date<=? AND ${runActivitySql()}`, [userId, since, planningDateISO]),
    dbAll('SELECT id, date FROM lifts WHERE user_id=? AND date>=? AND date<=?', [userId, since, planningDateISO]),
    dbAll(
      'SELECT id, started_at FROM workout_sessions WHERE user_id=? AND started_at>=? AND started_at<=? AND ended_at IS NOT NULL',
      [userId, `${since}T00:00:00`, `${planningDateISO}T23:59:59`]
    ),
    dbGet(`SELECT MAX(date) AS last_date FROM runs WHERE user_id=? AND date<=? AND ${runActivitySql()}`, [userId, planningDateISO]),
    dbGet('SELECT MAX(date) AS last_date FROM lifts WHERE user_id=? AND date<=?', [userId, planningDateISO]),
    dbGet(
      'SELECT MAX(substr(started_at, 1, 10)) AS last_date FROM workout_sessions WHERE user_id=? AND started_at<=? AND ended_at IS NOT NULL',
      [userId, `${planningDateISO}T23:59:59`]
    ),
  ]);

  const runDates = (runs || []).map((row) => String(row.date || '').slice(0, 10)).filter(Boolean);
  const liftDates = [
    ...(lifts || []).map((row) => String(row.date || '').slice(0, 10)),
    ...(workouts || []).map((row) => String(row.started_at || '').slice(0, 10)),
  ].filter(Boolean);

  let completed = 0;
  let missedRuns = 0;
  let missedLifts = 0;
  for (const item of planned) {
    const completedByProgress = completedIds.has(String(item.sessionId));
    const completedByLog = item.kind === 'run'
      ? runDates.some((date) => dateWithinOneDay(date, item.date))
      : liftDates.some((date) => dateWithinOneDay(date, item.date));
    if (completedByProgress || completedByLog) completed += 1;
    else {
      if (item.kind === 'run') missedRuns += 1;
      else missedLifts += 1;
    }
  }

  const lastActivityDate = [lastRun?.last_date, lastLift?.last_date, lastWorkout?.last_date]
    .map((value) => String(value || '').slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= planningDateISO)
    .sort()
    .pop() || null;
  const daysInactive = lastActivityDate === null
    ? null
    : Math.max(0, daysBetween(planningDateISO, lastActivityDate));
  const planStartDate = (Array.isArray(plan?.weeks) ? plan.weeks : [])
    .flatMap((week) => planSchema.getDayEntries(week))
    .map((day) => String(day?.date || '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()[0] || null;

  return {
    planned: planned.length,
    completed,
    missedRuns,
    missedLifts,
    missedWorkouts: missedRuns + missedLifts,
    adherenceRate: planned.length ? completed / planned.length : null,
    freshness: `${since} to ${planningDateISO}`,
    lastActivityDate,
    daysInactive,
    planStartDate,
    isPlanStartWindow: Boolean(planStartDate && planningDateISO <= planStartDate),
  };
}

async function buildAdaptationInputs(userId, plan, active, planningDateISO) {
  const recentRunSince = adaptationEngine.addDays(planningDateISO, -34);
  const [healthRow, checkin, injuries, completion, recentRuns, profile] = await Promise.all([
    dbGet('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch((err) => {
      console.error('[plans/adaptation] health sync lookup failed:', err.message);
      return null;
    }),
    dbGet(
      'SELECT feeling, legs, drive, sleep_hours, time_available, life_flags, checkin_date FROM daily_checkins WHERE user_id=? AND checkin_date=?',
      [userId, planningDateISO]
    ),
    dbAll(
      'SELECT id, date, body_part, pain_level, notes FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC LIMIT 3',
      [userId]
    ),
    buildCompletionSummaryForAdaptation(userId, plan, active, planningDateISO).catch((err) => {
      console.error('[plans/adaptation] completion summary failed:', err.message);
      return {};
    }),
    dbAll(
      `SELECT date, distance_miles, duration_seconds, perceived_effort, avg_heart_rate,
              pain_level, post_energy, pace_avg, health_source, created_at,
              heart_rate_zones, workout_metrics_json, watch_mode, notes,
              type, watch_activity_type, watch_normalized_type
       FROM runs
       WHERE user_id=? AND date>=? AND date<=? AND ${runActivitySql()}
       ORDER BY date ASC, created_at ASC`,
      [userId, recentRunSince, planningDateISO]
    ).catch((err) => {
      console.error('[plans/adaptation] recent run lookup failed:', err.message);
      return [];
    }),
    dbGet('SELECT schedule_type, missed_workout_pref FROM users WHERE id=?', [userId]).catch((err) => {
      console.error('[plans/adaptation] preference lookup failed:', err.message);
      return null;
    }),
  ]);
  const openInjuries = (Array.isArray(injuries) ? injuries : []).map((injury) => ({
    id: injury.id,
    date: injury.date,
    bodyPart: injury.body_part,
    body_part: injury.body_part,
    painLevel: injury.pain_level,
    pain_level: injury.pain_level,
    severity: injury.pain_level,
    notes: injury.notes,
    active: true,
  }));
  const activeInjury = openInjuries.length ? openInjuries[0] : null;
  const healthSignals = buildAdaptationHealthSignals(healthRow, planningDateISO);
  const scheduleType = String(profile?.schedule_type || 'adaptive').toLowerCase();
  const missedWorkoutPref = String(profile?.missed_workout_pref || 'adjust_week').toLowerCase();
  return {
    healthSignals,
    checkin: checkin || null,
    completion: {
      ...(completion || {}),
      gapPromptEnabled: ['adaptive', 'flexible'].includes(scheduleType) && missedWorkoutPref !== 'skip',
    },
    recentRunLoad: summarizeRecentRunLoad(recentRuns, {
      todayISO: planningDateISO,
      weeklyBaseline: Number(plan?.inputSummary?.weeklyMileageBaseline || 0),
      recoveryState: healthSignals.recoveryState,
    }),
    injuryState: activeInjury ? {
      active: true,
      bodyPart: activeInjury.bodyPart,
      body_part: activeInjury.body_part,
      painLevel: activeInjury.painLevel,
      pain_level: activeInjury.pain_level,
      severity: activeInjury.severity,
      notes: activeInjury.notes,
      openInjuries,
      reason: [activeInjury.bodyPart, activeInjury.notes].filter(Boolean).join(': ') || 'active injury log',
      freshness: activeInjury.date || 'current',
    } : { active: false, openInjuries: [] },
  };
}

function encodeProposalReason(proposal) {
  return JSON.stringify({
    headline: proposal.headline,
    reason: proposal.reason,
  });
}

function decodeProposalReason(raw) {
  if (!raw) return { headline: null, reason: '' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && (parsed.headline || parsed.reason)) {
      return { headline: parsed.headline || null, reason: parsed.reason || '' };
    }
  } catch (err) {
    console.error('[plans/adaptation] legacy reason parse skipped:', err.message);
  }
  return { headline: null, reason: String(raw) };
}

function proposalFromRow(row) {
  if (!row) return null;
  const changes = parseJsonValue(row.changes_json, []);
  const evidence = parseJsonValue(row.evidence_json, []);
  const meta = decodeProposalReason(row.reason);
  return {
    id: row.id,
    status: Array.isArray(changes) && changes.length ? 'proposal' : 'keep',
    decisionStatus: row.status,
    planningDate: row.planning_date,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    safetyException: Number(row.safety_exception || 0) === 1,
    evidence: Array.isArray(evidence) ? evidence : [],
    changes: Array.isArray(changes) ? changes : [],
    headline: meta.headline || (Array.isArray(changes) && changes.length ? 'Calendar adjustment pending' : 'Keep the calendar as planned'),
    choices: ['accept', 'keep_original'],
    reason: meta.reason,
    planVersion: row.plan_version || null,
    planId: row.plan_id || null,
    userPlanId: row.user_plan_id || null,
  };
}

async function findPendingAdaptation(userId, planningDateISO, planVersion, tx = null) {
  const get = tx?.get || dbGet;
  return get(
    `SELECT *
     FROM plan_adjustment_proposals
     WHERE user_id=? AND planning_date=? AND plan_version=? AND status='pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, planningDateISO, planVersion]
  );
}

async function findLatestAdaptation(userId, planningDateISO, planVersion) {
  return dbGet(
    `SELECT *
     FROM plan_adjustment_proposals
     WHERE user_id=? AND planning_date=? AND plan_version=?
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, planningDateISO, planVersion]
  );
}

async function persistAdaptationProposal(userId, active, planVersion, originalPlan, proposal) {
  const existing = await findPendingAdaptation(userId, proposal.planningDate, planVersion);
  if (existing) return proposalFromRow(existing);
  const id = uuidv4();
  const inserted = await dbRun(
    `INSERT INTO plan_adjustment_proposals (
      id, user_id, user_plan_id, plan_id, plan_version, window_start, window_end,
      planning_date, status, safety_exception, original_json, proposed_json,
      changes_json, evidence_json, reason
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT DO NOTHING`,
    [
      id,
      userId,
      active?.row?.user_plan_id || null,
      active?.row?.id || null,
      planVersion,
      proposal.windowStart,
      proposal.windowEnd,
      proposal.planningDate,
      'pending',
      proposal.safetyException ? 1 : 0,
      JSON.stringify(originalPlan || null),
      JSON.stringify(proposal.proposedPlan || originalPlan || null),
      JSON.stringify(proposal.changes || []),
      JSON.stringify(proposal.evidence || []),
      encodeProposalReason(proposal),
    ]
  );
  if (inserted.changes === 0) {
    const concurrent = await findPendingAdaptation(userId, proposal.planningDate, planVersion);
    if (!concurrent) throw new Error('Pending adaptation proposal conflict could not be resolved');
    return proposalFromRow(concurrent);
  }
  return Object.assign({}, proposal, {
    id,
    decisionStatus: 'pending',
    planVersion,
    planId: active?.row?.id || null,
    userPlanId: active?.row?.user_plan_id || null,
  });
}

function courseTargetFromRace(race = {}) {
  return {
    raceId: race.id || null,
    elevation_gain_ft: race.elevation_gain_ft,
    max_altitude_ft: race.max_altitude_ft,
    terrain: race.terrain || null,
    course_profile_json: race.course_profile_json || null,
    source: race.source || null,
    url: race.url || null,
    courseProvenance: race.source || race.url ? 'curated' : 'unknown',
  };
}

const CLIENT_COURSE_KEYS = [
  'elevation_gain_ft', 'elevationGainFt', 'max_altitude_ft', 'maxAltitudeFt',
  'terrain', 'courseTerrain', 'course_profile_json', 'courseProfile',
  'source', 'courseSource', 'url', 'courseUrl', 'provenance', 'courseProvenance',
  'nowISO', 'todayISO',
];

// Course facts may only enter plan generation from an owned race row. A generic
// client target can choose distance/date/preferences, but cannot self-assert a
// trusted course envelope or manipulate freshness evaluation.
function stripClientCourseFacts(target = {}) {
  const safe = { ...target };
  for (const key of CLIENT_COURSE_KEYS) delete safe[key];
  return safe;
}

function mapType(day = {}) {
  const t = String(day.workout_type || day.type || '').toLowerCase();
  if (t.includes('rest')) return 'rest';
  if (t.includes('strength') || t.includes('lift') || t.includes('cross')) return 'lift';
  return 'run';
}

function dayToDate(weekStart, dayLabel) {
  const map = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const idx = map[String(dayLabel || '').slice(0, 3).toLowerCase()];
  if (idx === undefined) return null;
  const d = new Date(`${weekStart}T12:00:00`);
  d.setDate(d.getDate() + idx);
  return d.toISOString().slice(0, 10);
}

async function getActivePlanForUser(userId, tx = null) {
  const get = tx?.get || dbGet;
  const assigned = await get(`
    SELECT up.id as user_plan_id, up.current_week, up.started_at, up.status, up.progress_json,
           tp.*
    FROM user_plans up
    JOIN training_plans tp ON tp.id = up.plan_id
    WHERE up.user_id = ? AND up.status = 'active'
    ORDER BY up.created_at DESC
    LIMIT 1
  `, [userId]);
  if (assigned) return { source: 'assigned', row: assigned };

  const legacy = await get('SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  if (legacy) return { source: 'legacy', row: legacy };
  return null;
}

async function ensureWritablePlan(active, userId, tx) {
  if (active.source === 'assigned' && !active.row.user_id) {
    const cloneId = uuidv4();
    const cloneResult = await tx.run(
      `INSERT INTO training_plans (
        id, user_id, week_start, plan_json, name, type, weeks, description, plan_data
      )
      SELECT ?, ?, week_start, plan_json, name, type, weeks, description, plan_data
      FROM training_plans WHERE id=?`,
      [cloneId, userId, active.row.id]
    );
    if (cloneResult.changes === 0) throw new Error('Active plan clone failed');
    const repointResult = await tx.run(
      'UPDATE user_plans SET plan_id=? WHERE id=? AND user_id=?',
      [cloneId, active.row.user_plan_id, userId]
    );
    if (repointResult.changes === 0) throw new Error('Active plan repoint failed');
    active.row.id = cloneId;
    active.row.user_id = userId;
  }
  return active.row.id;
}

async function updateActivePlanData(active, userId, planJson, tx) {
  const planId = await ensureWritablePlan(active, userId, tx);
  const serialized = JSON.stringify(planJson);
  const result = active.source === 'assigned'
    ? await tx.run('UPDATE training_plans SET plan_data=? WHERE id=? AND user_id=?', [serialized, planId, userId])
    : await tx.run('UPDATE training_plans SET plan_json=? WHERE id=? AND user_id=?', [serialized, planId, userId]);
  if (result.changes === 0) throw new Error('Active plan update failed');
  return planId;
}

function defaultWeeksForDistance(distanceMiles) {
  const distance = Number(distanceMiles || 0);
  if (distance >= 20) return 16;
  if (distance >= 11) return 12;
  if (distance >= 5.5) return 10;
  return 8;
}

async function buildConcurrentContext(userId, profile, target) {
  const planningDateISO = /^\d{4}-\d{2}-\d{2}$/.test(String(target.todayISO || '')) ? target.todayISO : getTodayISO();
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - 55);
  const sinceDate = start.toISOString().slice(0, 10);
  const [runs, lifts, recentExercises, healthRow, activeInjury, dailyCheckin] = await Promise.all([
    dbAll(
      `SELECT date, distance_miles, duration_seconds, perceived_effort, avg_heart_rate,
              pain_level, post_energy, pace_avg, health_source, created_at,
              heart_rate_zones, workout_metrics_json, watch_mode, notes,
              type, watch_activity_type, watch_normalized_type
       FROM runs
       WHERE user_id=? AND date>=? AND date<=? AND ${runActivitySql()}
       ORDER BY date ASC, created_at ASC`,
      [userId, sinceDate, planningDateISO]
    ),
    dbAll('SELECT started_at FROM workout_sessions WHERE user_id=? AND started_at>=? AND ended_at IS NOT NULL ORDER BY started_at ASC', [userId, `${sinceDate}T00:00:00`]),
    dbAll(
      `SELECT exercise_name, session_id, reps, weight_lbs, logged_at
       FROM workout_sets
       WHERE user_id=? AND logged_at>=?
       ORDER BY logged_at DESC
       LIMIT 200`,
      [userId, `${sinceDate}T00:00:00`]
    ).catch((err) => {
      console.error('[plans/generate] recent exercise lookup failed:', err.message);
      return [];
    }),
    dbGet('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch((err) => {
      console.error('[plans/generate] health sync lookup failed:', err.message);
      return null;
    }),
    dbGet('SELECT id FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC LIMIT 1', [userId]).catch((err) => {
      console.error('[plans/generate] injury lookup failed:', err.message);
      return null;
    }),
    dbGet(
      'SELECT feeling, legs, drive, sleep_hours, time_available, life_flags, checkin_date FROM daily_checkins WHERE user_id=? AND checkin_date=?',
      [userId, planningDateISO]
    ).catch((err) => {
      console.error('[plans/generate] daily check-in lookup failed:', err.message);
      return null;
    }),
  ]);
  const activityDates = [
    ...(runs || []).map((run) => String(run.date || '').slice(0, 10)),
    ...(lifts || []).map((lift) => String(lift.started_at || '').slice(0, 10)),
  ].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const weeksObserved = activityDates.length
    ? clamp(Math.ceil((Date.now() - new Date(`${activityDates[0]}T12:00:00`).getTime()) / (7 * 86400000)) || 1, 1, 8)
    : 0;
  const expectedPerWeek = clampInt(profile.run_days_per_week, 1, 6, 3) + clampInt(profile.lift_days_per_week, 0, 4, 0);
  const expectedSessions = weeksObserved * expectedPerWeek;
  const completedSessions = (runs || []).length + (lifts || []).length;
  const healthSignals = buildHealthSignals(healthRow || {});
  const healthMetrics = healthSignals.metrics || {};
  const healthFreshness = healthMetrics.freshness || {};
  const hasMetric = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
  const hasTrainingRelevantHealthData = Boolean(healthSignals.available
    || (healthFreshness.activity !== false && [healthMetrics.activeMinutesThisWeek, healthMetrics.workoutCountThisWeek].some(hasMetric))
    || (healthFreshness.exerciseMinutes !== false && hasMetric(healthMetrics.exerciseMinutesThisWeek))
    || (healthFreshness.vo2Max !== false && hasMetric(healthMetrics.vo2Max))
    || (healthFreshness.heartRateRecovery !== false && hasMetric(healthMetrics.heartRateRecoveryOneMinute))
    || (healthFreshness.respiratoryRate !== false && hasMetric(healthMetrics.respiratoryRate))
    || (healthFreshness.runningDynamics !== false && [healthMetrics.runningPowerWatts, healthMetrics.runningSpeedMps, healthMetrics.runningStrideLengthM, healthMetrics.runningVerticalOscillationCm, healthMetrics.runningGroundContactTimeMs].some(hasMetric)));
  let recoveryState = healthSignals.available ? healthSignals.recoveryState : 'unknown';
  const checkinFlags = parseLifeFlags(dailyCheckin?.life_flags);
  const checkinFeeling = Number(dailyCheckin?.feeling || 0);
  const checkinSleep = dailyCheckin?.sleep_hours === null || dailyCheckin?.sleep_hours === undefined
    ? null
    : Number(dailyCheckin.sleep_hours);
  const severeCheckin = checkinFeeling === 1
    || (Number.isFinite(checkinSleep) && checkinSleep < 4.5)
    || checkinFlags.some((flag) => ['sick', 'not_well', 'injured'].includes(flag));
  const cautionCheckin = checkinFeeling === 2
    || Number(dailyCheckin?.legs || 0) === 1
    || Number(dailyCheckin?.drive || 0) === 1
    || (Number.isFinite(checkinSleep) && checkinSleep < 6)
    || checkinFlags.includes('stressed');
  if (severeCheckin) recoveryState = 'low';
  else if (cautionCheckin && !['low', 'recovery'].includes(recoveryState)) recoveryState = 'caution';
  if (activeInjury || profile.comeback_mode || String(profile.injury_notes || '').trim()) recoveryState = 'low';
  const mileageBaseline = concurrentPlan.estimateWeeklyMileageBaseline(runs, {
    planningDateISO,
    profileWeeklyMiles: profile.weekly_miles_current,
  });
  const weeklyMileageBaseline = mileageBaseline.weeklyMiles;
  const acuteRunLoad = summarizeRecentRunLoad(runs, {
    todayISO: planningDateISO,
    weeklyBaseline: weeklyMileageBaseline,
    recoveryState,
  });
  return {
    profile,
    target,
    todayISO: planningDateISO,
    history: {
      weeklyMileageBaseline,
      mileageBaseline,
      recentRunCount: (runs || []).length,
      recentLiftCount: (lifts || []).length,
      acuteRunLoad,
      recentExercises: summarizeRecentExercises(recentExercises || []),
      adherenceRate: expectedSessions ? clamp(completedSessions / expectedSessions, 0, 1) : null,
      missedWorkouts: expectedSessions ? Math.max(0, expectedSessions - completedSessions) : 0,
    },
    recovery: {
      state: recoveryState,
      available: Boolean(healthSignals.available),
      dataAvailable: hasTrainingRelevantHealthData,
      readinessScore: healthSignals.readinessScore ?? null,
      syncedAt: healthRow?.synced_at || null,
      metrics: healthSignals.metrics || {},
    },
    checkin: dailyCheckin ? {
      date: dailyCheckin.checkin_date,
      feeling: Number(dailyCheckin.feeling || 0) || null,
      legs: Number(dailyCheckin.legs || 0) || null,
      drive: Number(dailyCheckin.drive || 0) || null,
      sleepHours: Number.isFinite(checkinSleep) ? checkinSleep : null,
      timeAvailable: Number(dailyCheckin.time_available || 0) || null,
      lifeFlags: checkinFlags,
    } : null,
  };
}

async function persistConcurrentPlan(userId, plan, meta = {}) {
  const planId = uuidv4();
  const userPlanId = uuidv4();
  const weekStart = plan.weeks?.[0]?.startDate || getMonday();
  const serialized = JSON.stringify(plan);
  await withTransaction(async (tx) => {
    await tx.run("UPDATE user_plans SET status='inactive' WHERE user_id=? AND status='active'", [userId]);
    await tx.run(
      `INSERT INTO training_plans (id, user_id, week_start, plan_json, name, type, weeks, description, plan_data)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [planId, userId, weekStart, serialized, meta.name, meta.type, plan.weeks.length, meta.description, serialized]
    );
    await tx.run(
      `INSERT INTO user_plans (id, user_id, plan_id, started_at, current_week, status, progress_json)
       VALUES (?,?,?,?,?,?,?)`,
      [userPlanId, userId, planId, weekStart, 1, 'active', JSON.stringify({ completedSessionIds: [] })]
    );
  });
  return { planId, userPlanId, weekStart };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(Math.round(n), min, max);
}

function parsePositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getPlanTargetOptions(target = null) {
  const dayByKey = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
  const trainingDays = Array.isArray(target?.trainingDays)
    ? [...new Set(target.trainingDays
      .map((day) => dayByKey[String(day || '').trim().slice(0, 3).toLowerCase()])
      .filter(Boolean))]
    : [];
  const courseTrust = concurrentPlan.trustedCourseFacts(target || {});
  const elevationGainFt = courseTrust.trusted ? parsePositiveNumber(courseTrust.facts.elevationGainFt) : null;
  const distanceMiles = parsePositiveNumber(target?.distanceMiles ?? target?.distance_miles);
  const maxAltitudeFt = courseTrust.trusted ? parsePositiveNumber(courseTrust.facts.maxAltitudeFt) : null;
  const courseHilly = elevationGainFt
    ? (distanceMiles ? (elevationGainFt / distanceMiles) >= 30 : elevationGainFt >= 800)
    : false;
  return {
    liftingEnabled: target?.liftingEnabled === false ? false : true,
    trainingDays,
    courseHilly,
    courseHighAltitude: maxAltitudeFt ? maxAltitudeFt >= 5000 : false,
    courseTerrain: courseTrust.trusted ? (courseTrust.facts.terrain || null) : null,
  };
}

function defaultPrefillFromProfile(profile = {}) {
  const runDaysPerWeek = clampInt(profile.run_days_per_week, 1, 7, 3);
  const liftDaysPerWeek = clampInt(profile.lift_days_per_week, 0, 7, 2);
  return {
    inferredTrainingDays: [],
    runDaysPerWeek,
    liftDaysPerWeek,
    liftingEnabled: liftDaysPerWeek > 0,
  };
}

function weekdayFromDateString(dateString) {
  const datePart = String(dateString || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const date = new Date(`${datePart}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
}

function parseLifeFlags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[plans/parseLifeFlags] invalid JSON:', err.message);
    return [];
  }
}

function normalizeGoalType(goalType = '') {
  const g = String(goalType || '').toLowerCase();
  if (g.includes('5k')) return '5k';
  if (g.includes('10k')) return '10k';
  if (g.includes('half')) return 'half';
  if (g.includes('marathon')) return 'marathon';
  if (g.includes('run_longer')) return '10k';
  if (g.includes('get_faster')) return '5k';
  return 'fitness';
}

function getBaseDistances(goalType) {
  switch (normalizeGoalType(goalType)) {
    case '5k': return [2.0, 2.5, 3.0, 1.5, 2.2];
    case '10k': return [3.0, 3.8, 5.0, 2.2, 3.1];
    case 'half': return [4.0, 5.0, 7.5, 3.0, 4.5];
    case 'marathon': return [5.0, 6.0, 10.0, 3.5, 5.5];
    default: return [2.2, 2.8, 4.0, 1.8, 2.5];
  }
}

function getIntensityMultiplier(intensity) {
  if (intensity === 'recovery') return 0.6;
  if (intensity === 'reduced') return 0.85;
  if (intensity === 'increased') return 1.1;
  return 1;
}

function runDetailsForTemplate(title = '', intensity = 'normal') {
  const label = String(title || '').toLowerCase();
  if (label.includes('quality')) {
    return {
      pace_target: intensity === 'reduced' ? '10:00-10:45/mi' : '9:15-10:00/mi',
      target_zone: 'Zone 3',
      intensity: 'Comfortably hard',
      progression: 'Start easy, settle into steady work, and finish controlled.',
      description: 'Progression run — do not sprint the finish.',
      steps: ['10 min easy warm-up', 'Steady middle miles', '5 min controlled finish', '5 min easy cool-down'],
    };
  }
  if (label.includes('long')) {
    return {
      pace_target: '10:30-11:45/mi',
      target_zone: 'Zone 2',
      intensity: 'Easy aerobic',
      progression: 'Keep it conversational so the distance builds endurance without draining the week.',
      description: 'Long aerobic run — steady breathing, no pace chasing.',
      steps: ['First mile relaxed', 'Hold even effort through the middle', 'Last mile smooth and easy'],
    };
  }
  if (label.includes('recovery')) {
    return {
      pace_target: '11:00-12:30/mi',
      target_zone: 'Zone 1-2',
      intensity: 'Recovery',
      progression: 'Run slower than normal and stop if soreness changes your stride.',
      description: 'Recovery run — the win is finishing fresher than you started.',
      steps: ['5 min very easy', 'Hold relaxed effort', 'Walk 2-3 min if breathing climbs'],
    };
  }
  return {
    pace_target: intensity === 'increased' ? '9:45-10:45/mi' : '10:15-11:15/mi',
    target_zone: 'Zone 2',
    intensity: 'Conversational aerobic',
    progression: 'Easy aerobic run — build consistency without forcing speed.',
    description: 'Easy run — conversational pace from start to finish.',
    steps: ['5-10 min relaxed warm-up', 'Hold steady conversational pace', 'Cool down easy'],
  };
}

function generateSessions(intensity, user = {}) {
  const runDays = clamp(Number(user.run_days_per_week || 3), 2, 6);
  const liftDays = clamp(Number(user.lift_days_per_week || 2), 0, 4);
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const preferredRunDays = parsePreferredDays(user.preferred_run_days);
  const fallbackRunDayOrder = [1, 3, 5, 6, 2, 0, 4];
  const runDayOrder = [
    ...preferredRunDays,
    ...fallbackRunDayOrder.filter((idx) => !preferredRunDays.includes(idx)),
  ];
  const liftDayOrder = [0, 2, 4, 6, 1, 3, 5];

  const sessions = dayLabels.map((day) => ({
    id: `adaptive-${day.toLowerCase()}`,
    day,
    type: 'rest',
    title: 'Recovery / Rest',
    distance_miles: 0,
  }));

  const selectedRunDays = runDayOrder.slice(0, runDays);
  const selectedLiftDays = [];
  for (const idx of liftDayOrder) {
    if (selectedLiftDays.length >= liftDays) break;
    if (selectedRunDays.includes(idx)) continue;
    selectedLiftDays.push(idx);
  }

  const runTemplates = [
    { title: 'Easy run', type: 'run' },
    { title: 'Quality run', type: 'run' },
    { title: 'Long run', type: 'run' },
    { title: 'Recovery run', type: 'run' },
    { title: 'Steady run', type: 'run' },
    { title: 'Easy run', type: 'run' },
  ];
  const baseDistances = getBaseDistances(user.goal_type);
  const intensityFactor = getIntensityMultiplier(intensity);

  for (let i = 0; i < selectedRunDays.length; i += 1) {
    const dayIdx = selectedRunDays[i];
    const template = runTemplates[i] || runTemplates[runTemplates.length - 1];
    const base = baseDistances[Math.min(i, baseDistances.length - 1)];
    const details = runDetailsForTemplate(template.title, intensity);
    sessions[dayIdx] = {
      id: `adaptive-run-${dayLabels[dayIdx].toLowerCase()}`,
      day: dayLabels[dayIdx],
      type: template.type,
      title: template.title,
      distance_miles: Math.max(1, Math.round(base * intensityFactor * 10) / 10),
      ...details,
    };
  }

  for (const dayIdx of selectedLiftDays) {
    sessions[dayIdx] = {
      id: `adaptive-lift-${dayLabels[dayIdx].toLowerCase()}`,
      day: dayLabels[dayIdx],
      type: 'strength',
      // H1: neutral strength framing (no "injury-prevention-only" wording).
      title: planSchema.STRENGTH_MAINTAIN_TITLE,
      distance_miles: 0,
    };
  }

  return sessions;
}

function parsePreferredDays(raw) {
  const dayIndex = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const values = Array.isArray(raw)
    ? raw
    : String(raw || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return [...new Set(values
    .map((day) => dayIndex[String(day || '').slice(0, 3).toLowerCase()])
    .filter((idx) => idx !== undefined))];
}

function normalizeAdaptivePreferences(input = {}) {
  const runDays = Number(input.run_days_per_week);
  const preferred = parsePreferredDays(input.preferred_run_days);
  return {
    run_days_per_week: Number.isFinite(runDays) ? clamp(runDays, 2, 6) : null,
    preferred_run_days: preferred.length ? preferred.map((idx) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][idx]) : null,
  };
}

function getAdaptiveWeek(user, recentRuns, recentLifts, checkins, activeInjuries, healthRow = null) {
  const avgFeeling = checkins.length
    ? checkins.reduce((s, c) => s + Number(c.feeling || 3), 0) / checkins.length
    : 3;
  const avgSleep = checkins.length
    ? checkins.reduce((s, c) => s + Number(c.sleep_hours || 7), 0) / checkins.length
    : 7;
  const hasInjury = activeInjuries.length > 0;
  const recentVolume = recentRuns.length;

  let intensity = 'normal';
  if (avgFeeling < 2.5 || avgSleep < 6) intensity = 'reduced';
  if (avgFeeling >= 4 && avgSleep >= 7.5 && recentVolume < 3) intensity = 'increased';
  if (hasInjury) intensity = 'recovery';

  const healthSignals = buildHealthSignals(healthRow || {});
  if (!hasInjury && healthSignals.available) {
    if (healthSignals.shouldRest) intensity = 'recovery';
    else if (healthSignals.shouldReduceIntensity && intensity !== 'recovery') intensity = 'reduced';
    else if (healthSignals.recoveryState === 'strong' && intensity === 'normal' && recentVolume < 3) intensity = 'increased';
  }

  const lowSleepNights = checkins.filter((c) => Number(c.sleep_hours || 7) < 6).length;
  const lowFeelingDays = checkins.filter((c) => Number(c.feeling || 3) <= 2).length;
  const lifeFlags = checkins.flatMap((c) => parseLifeFlags(c.life_flags));
  const uniqueFlags = [...new Set(lifeFlags)];
  const flagsLabel = uniqueFlags.slice(0, 2).join(', ');

  let reason = 'Balanced check-ins and load support a normal week.';
  let recommendation = 'Keep consistency and execute this week as planned.';
  if (intensity === 'recovery') {
    reason = `Active injury logged — shifting to recovery week with lighter work.`;
    recommendation = 'Protect recovery and avoid intensity until pain settles.';
    if (!hasInjury && healthSignals.shouldRest) {
      reason = `${healthSignals.summary} Shifting this week to recovery even without an injury log.`;
      recommendation = 'Prioritize mobility, easy aerobic work, and one fewer hard session.';
    }
  } else if (intensity === 'reduced') {
    reason = `${lowSleepNights || lowFeelingDays} recovery signal(s) detected${flagsLabel ? ` (${flagsLabel})` : ''} — lighter week recommended.`;
    recommendation = "You've had low readiness markers, so this week reduces stress.";
    if (healthSignals.shouldReduceIntensity) {
      reason = `${healthSignals.summary} Lighter week recommended.`;
      recommendation = "Apple Health is showing recovery stress, so this week backs off intensity.";
    }
  } else if (intensity === 'increased') {
    reason = "You've been sleeping well and feeling great with room to build load.";
    recommendation = "You're ready for a controlled mileage bump this week.";
    if (healthSignals.recoveryState === 'strong') {
      reason = `${healthSignals.summary} You have room for a controlled mileage bump.`;
    }
  }

  return {
    intensity,
    recommendation,
    sessions: generateSessions(intensity, user),
    reason,
    stats: {
      avgFeeling: Math.round(avgFeeling * 10) / 10,
      avgSleep: Math.round(avgSleep * 10) / 10,
      recentRuns: recentRuns.length,
      recentLifts: recentLifts.length,
      activeInjuries: activeInjuries.length,
      health: healthSignals,
    },
    healthSignals,
  };
}

async function buildAdaptiveRecommendation(userId, preferences = {}) {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const startDate = start.toISOString().slice(0, 10);

  const [user, checkins, activeInjuries, recentRuns, recentLifts, healthRow] = await Promise.all([
    dbGet('SELECT id, goal_type, goal_race_date, run_days_per_week, lift_days_per_week FROM users WHERE id=?', [userId]),
    dbAll(
      'SELECT feeling, sleep_hours, life_flags, checkin_date FROM daily_checkins WHERE user_id=? AND checkin_date >= ? ORDER BY checkin_date DESC LIMIT 7',
      [userId, startDate]
    ),
    dbAll('SELECT * FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC', [userId]),
    dbAll(`SELECT id, date FROM runs WHERE user_id=? AND date >= ? AND ${runActivitySql()} ORDER BY date DESC`, [userId, startDate]),
    dbAll(
      "SELECT id, started_at, ended_at FROM workout_sessions WHERE user_id=? AND started_at >= ? AND ended_at IS NOT NULL ORDER BY started_at DESC",
      [userId, `${startDate}T00:00:00`]
    ),
    dbGet('SELECT * FROM health_sync WHERE user_id=?', [userId]).catch((err) => {
      console.error('[plans/adaptive] health sync lookup failed:', err.message);
      return null;
    }),
  ]);

  if (!user) return null;
  const normalizedPreferences = normalizeAdaptivePreferences(preferences);
  return getAdaptiveWeek({
    ...user,
    run_days_per_week: normalizedPreferences.run_days_per_week || user.run_days_per_week,
    preferred_run_days: normalizedPreferences.preferred_run_days,
  }, recentRuns || [], recentLifts || [], checkins || [], activeInjuries || [], healthRow);
}

router.get('/', auth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT id, name, type, weeks, description, plan_data, created_at
      FROM training_plans
      WHERE user_id IS NULL AND plan_data IS NOT NULL
      ORDER BY created_at ASC
    `);
    const plans = rows.map((row) => ({ ...row, plan_data: parsePlan(row) || { weeks: [] } }));
    res.json({ plans });
  } catch (err) {
    console.error('[plans/list] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

router.get('/adaptive/recommend', auth, async (req, res) => {
  try {
    const adaptive = await buildAdaptiveRecommendation(req.user.id, req.query || {});
    if (!adaptive) return res.status(404).json({ error: 'User not found' });
    res.json(adaptive);
  } catch (err) {
    console.error('[plans/adaptive/recommend] failed:', err.message);
    res.status(500).json({ error: 'Failed to build adaptive recommendation' });
  }
});

function publicProposal(proposal) {
  if (!proposal) return null;
  const { proposedPlan, plan, ...rest } = proposal;
  return rest;
}

router.get('/adaptation/current', auth, async (req, res) => {
  try {
    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ proposal: null, reason: 'No active plan is assigned yet.' });
    const parsed = parsePlan(active.row);
    if (!parsed || !planSchema.isSchemaV2(parsed)) {
      return res.json({ proposal: null, reason: 'Transparent adaptation is available for schema-v2 dated calendars only.' });
    }

    const planningDateISO = getPlanningDateFromRequest(req);
    if (!planningDateISO) return res.status(400).json({ error: 'date must be the phone local date in YYYY-MM-DD format' });
    const planVersion = planVersionFor(active, parsed);
    const existing = await findLatestAdaptation(req.user.id, planningDateISO, planVersion);
    if (existing) return res.json({ proposal: publicProposal(proposalFromRow(existing)) });

    const inputs = await buildAdaptationInputs(req.user.id, parsed, active, planningDateISO);
    const proposal = adaptationEngine.buildAdaptationProposal({
      plan: parsed,
      planningDateISO,
      planVersion,
      healthSignals: inputs.healthSignals,
      checkin: inputs.checkin,
      completion: inputs.completion,
      recentRunLoad: inputs.recentRunLoad,
      injuryState: inputs.injuryState,
    });
    const persisted = await persistAdaptationProposal(req.user.id, active, planVersion, parsed, proposal);
    res.json({ proposal: publicProposal(persisted) });
  } catch (err) {
    console.error('[plans/adaptation/current] failed:', err.message);
    res.status(500).json({ error: 'Failed to compute transparent adaptation' });
  }
});

router.post('/adaptation/:proposalId/accept', auth, async (req, res) => {
  try {
    const result = await withTransaction(async (tx) => {
      const row = await tx.get('SELECT * FROM plan_adjustment_proposals WHERE id=? AND user_id=?', [req.params.proposalId, req.user.id]);
      if (!row) return { notFound: true };
      if (row.status === 'accepted') return { ok: true, status: 'accepted', proposal: proposalFromRow(row), idempotent: true };
      if (row.status !== 'pending') return { conflict: true, reason: 'Proposal is no longer pending.' };

      const active = await getActivePlanForUser(req.user.id, tx);
      if (!active) return { conflict: true, reason: 'No active plan is assigned.' };
      const parsed = parsePlan(active.row);
      const currentVersion = planVersionFor(active, parsed);
      if (String(currentVersion) !== String(row.plan_version || '')) {
        return { conflict: true, reason: 'The active plan changed after this proposal was computed.' };
      }

      const proposedPlan = parseJsonValue(row.proposed_json, null);
      if (!proposedPlan || typeof proposedPlan !== 'object') throw new Error('Stored proposed plan JSON is invalid');
      await updateActivePlanData(active, req.user.id, proposedPlan, tx);
      const update = await tx.run(
        "UPDATE plan_adjustment_proposals SET status='accepted', decided_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='pending'",
        [row.id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Proposal accept status update failed');
      return { ok: true, status: 'accepted', proposal: proposalFromRow({ ...row, status: 'accepted' }) };
    });

    if (result.notFound) return res.status(404).json({ error: 'Proposal not found' });
    if (result.conflict) return res.status(409).json({ error: result.reason });
    res.json({ ok: true, status: 'accepted', proposal: publicProposal(result.proposal), idempotent: Boolean(result.idempotent) });
  } catch (err) {
    console.error('[plans/adaptation/accept] failed:', err.message);
    res.status(500).json({ error: 'Failed to accept transparent adaptation' });
  }
});

router.post('/adaptation/:proposalId/keep', auth, async (req, res) => {
  try {
    const result = await withTransaction(async (tx) => {
      const row = await tx.get('SELECT * FROM plan_adjustment_proposals WHERE id=? AND user_id=?', [req.params.proposalId, req.user.id]);
      if (!row) return { notFound: true };
      if (row.status === 'kept') return { ok: true, status: 'kept', proposal: proposalFromRow(row), idempotent: true };
      if (row.status !== 'pending') return { conflict: true, reason: 'Proposal is no longer pending.' };
      const active = await getActivePlanForUser(req.user.id, tx);
      if (!active) return { conflict: true, reason: 'No active plan is assigned.' };
      const parsed = parsePlan(active.row);
      const currentVersion = planVersionFor(active, parsed);
      if (String(currentVersion) !== String(row.plan_version || '')) {
        return { conflict: true, reason: 'The active plan changed after this proposal was computed.' };
      }
      const update = await tx.run(
        "UPDATE plan_adjustment_proposals SET status='kept', decided_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND status='pending'",
        [row.id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Proposal keep status update failed');
      return { ok: true, status: 'kept', proposal: proposalFromRow({ ...row, status: 'kept' }) };
    });

    if (result.notFound) return res.status(404).json({ error: 'Proposal not found' });
    if (result.conflict) return res.status(409).json({ error: result.reason });
    res.json({ ok: true, status: 'kept', proposal: publicProposal(result.proposal), idempotent: Boolean(result.idempotent) });
  } catch (err) {
    console.error('[plans/adaptation/keep] failed:', err.message);
    res.status(500).json({ error: 'Failed to keep original plan' });
  }
});

router.get('/prefill', auth, async (req, res) => {
  let fallback = defaultPrefillFromProfile();
  try {
    const profile = await dbGet('SELECT run_days_per_week, lift_days_per_week FROM users WHERE id=?', [req.user.id]);
    fallback = defaultPrefillFromProfile(profile || {});

    const since = new Date();
    since.setDate(since.getDate() - 56);
    const sinceDate = since.toISOString().slice(0, 10);
    const rows = await dbAll(
      `SELECT date FROM runs WHERE user_id=? AND date >= ? AND ${runActivitySql()} ORDER BY date ASC`,
      [req.user.id, sinceDate]
    );
    const inferredTrainingDays = [...new Set((rows || [])
      .map((row) => weekdayFromDateString(row.date))
      .filter(Boolean))];

    res.json({ ...fallback, inferredTrainingDays });
  } catch (err) {
    console.error('[plans/prefill] failed soft:', err.message);
    res.json(fallback);
  }
});

router.post('/adaptive/accept', auth, async (req, res) => {
  try {
    const adaptive = await buildAdaptiveRecommendation(req.user.id, req.body || {});
    if (!adaptive) return res.status(404).json({ error: 'User not found' });

    const weekStart = getMonday();
    const planId = uuidv4();
    const userPlanId = uuidv4();
    const planData = { weeks: [{ week: 1, sessions: adaptive.sessions }] };
    const intensityLabel = adaptive.intensity.charAt(0).toUpperCase() + adaptive.intensity.slice(1);
    const planName = `Adaptive Week - ${weekStart}`;

    await withTransaction(async (tx) => {
      await tx.run("UPDATE user_plans SET status = 'inactive' WHERE user_id = ? AND status = 'active'", [req.user.id]);
      await tx.run(
        `INSERT INTO training_plans (id, user_id, week_start, plan_json, name, type, weeks, description, plan_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          planId,
          req.user.id,
          weekStart,
          JSON.stringify(planData),
          planName,
          'Adaptive',
          1,
          `${intensityLabel} intensity recommendation for this week.`,
          JSON.stringify(planData),
        ]
      );
      await tx.run(
        `INSERT INTO user_plans (id, user_id, plan_id, started_at, current_week, status, progress_json)
         VALUES (?,?,?,?,?,?,?)`,
        [userPlanId, req.user.id, planId, weekStart, 1, 'active', JSON.stringify({ completedSessionIds: [] })]
      );
    });

    res.status(201).json({ ok: true, user_plan_id: userPlanId, plan_id: planId, ...adaptive });
  } catch (err) {
    console.error('[plans/adaptive/accept] failed:', err.message);
    res.status(500).json({ error: 'Failed to accept adaptive plan' });
  }
});

router.post('/assign/:planId', auth, async (req, res) => {
  try {
    const plan = await dbGet('SELECT * FROM training_plans WHERE id = ? AND user_id IS NULL', [req.params.planId]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const id = uuidv4();
    await withTransaction(async (tx) => {
      await tx.run("UPDATE user_plans SET status = 'inactive' WHERE user_id = ? AND status = 'active'", [req.user.id]);
      await tx.run(
        `INSERT INTO user_plans (id, user_id, plan_id, started_at, current_week, status, progress_json)
         VALUES (?,?,?,?,?,?,?)`,
        [id, req.user.id, plan.id, new Date().toISOString().slice(0, 10), 1, 'active', JSON.stringify({ completedSessionIds: [] })]
      );
    });
    res.status(201).json({ ok: true, assignment_id: id });
  } catch (err) {
    console.error('[plans/assign] failed:', err.message);
    res.status(500).json({ error: 'Failed to assign plan' });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const row = await dbGet(`
      SELECT up.*, tp.name, tp.type, tp.weeks, tp.description, tp.plan_data
      FROM user_plans up
      JOIN training_plans tp ON tp.id = up.plan_id
      WHERE up.user_id = ? AND up.status = 'active'
      ORDER BY up.created_at DESC
      LIMIT 1
    `, [req.user.id]);

    if (!row) {
      const legacy = await dbGet(
        'SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        [req.user.id]
      );
      if (!legacy) return res.json({ plan: null });
      const legacyPlan = parsePlan(legacy) || { weeks: [] };
      return res.json({
        source: 'legacy',
        plan: {
          id: legacy.id,
          name: legacy.name,
          type: legacy.type,
          weeks: Number(legacy.weeks || legacyPlan.weeks?.length || 1),
          description: legacy.description,
          plan_data: legacyPlan,
        },
        user_plan: null,
      });
    }
    let progress = {};
    try {
      progress = JSON.parse(row.progress_json || '{}');
    } catch (err) {
      console.error('[plans/my] invalid progress JSON:', err.message);
    }
    res.json({
      plan: {
        id: row.plan_id,
        name: row.name,
        type: row.type,
        weeks: row.weeks,
        description: row.description,
        plan_data: parsePlan(row) || { weeks: [] },
      },
      user_plan: {
        id: row.id,
        started_at: row.started_at,
        current_week: Number(row.current_week || 1),
        status: row.status,
        progress,
      },
    });
  } catch (err) {
    console.error('[plans/my] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch user plan' });
  }
});

router.put('/my/progress', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const hasCurrentWeek = Object.prototype.hasOwnProperty.call(body, 'current_week');
    const completedId = body.completed_session_id === null || body.completed_session_id === undefined
      ? null
      : String(body.completed_session_id).trim();
    const unsetId = body.unset_session_id === null || body.unset_session_id === undefined
      ? null
      : String(body.unset_session_id).trim();
    if (completedId && unsetId) return res.status(400).json({ error: 'Choose one session progress action' });
    if ((completedId && completedId.length > 128) || (unsetId && unsetId.length > 128)) {
      return res.status(400).json({ error: 'Invalid plan session' });
    }

    const result = await withTransaction(async (tx) => {
      const findAssigned = () => tx.get(`
        SELECT up.id, up.progress_json, up.current_week,
               tp.weeks, tp.plan_data, tp.plan_json
        FROM user_plans up
        JOIN training_plans tp ON tp.id = up.plan_id
        WHERE up.user_id = ? AND up.status = 'active'
        ORDER BY up.created_at DESC
        LIMIT 1
        FOR UPDATE OF up
      `, [req.user.id]);
      let row = await findAssigned();
      let legacyPlanId = null;
      if (!row) {
        const legacy = await tx.get(`
          SELECT tp.id AS legacy_plan_id, tp.week_start,
                 tp.weeks, tp.plan_data, tp.plan_json
          FROM training_plans tp
          WHERE tp.user_id = ?
          ORDER BY tp.created_at DESC
          LIMIT 1
          FOR UPDATE OF tp
        `, [req.user.id]);
        if (!legacy) return { notFound: true };

        // The legacy-row lock serializes first completion. Recheck so a
        // concurrent request can reuse the assignment created while waiting.
        row = await findAssigned();
        if (!row) {
          legacyPlanId = legacy.legacy_plan_id;
          row = {
            ...legacy,
            id: uuidv4(),
            current_week: 1,
            progress_json: JSON.stringify({ completedSessionIds: [] }),
          };
        }
      }

      const parsed = parsePlan(row);
      const sessionIds = dailyExecution.collectSessionIds(parsed);
      const requestedId = completedId || unsetId;
      if (requestedId && !sessionIds.has(requestedId)) return { invalidSession: true };

      const rawWeekCount = Number(parsed?.weeks?.length || row.weeks || 1);
      const maxWeek = Number.isInteger(rawWeekCount) && rawWeekCount >= 1 ? rawWeekCount : 1;
      let nextWeek = Number(row.current_week || 1);
      if (hasCurrentWeek) {
        const requestedWeek = Number(body.current_week);
        if (!Number.isInteger(requestedWeek) || requestedWeek < 1 || requestedWeek > maxWeek) {
          return { invalidWeek: true };
        }
        nextWeek = requestedWeek;
      }

      let progress = {};
      try {
        progress = typeof row.progress_json === 'string'
          ? JSON.parse(row.progress_json || '{}')
          : (row.progress_json || {});
      } catch (err) {
        console.error('[plans/my/progress] invalid progress JSON:', err.message);
        progress = {};
      }
      const completed = new Set(Array.isArray(progress.completedSessionIds) ? progress.completedSessionIds.map(String) : []);
      if (completedId) completed.add(completedId);
      if (unsetId) completed.delete(unsetId);

      if (legacyPlanId) {
        const insert = await tx.run(
          `INSERT INTO user_plans (id, user_id, plan_id, started_at, current_week, status, progress_json)
           VALUES (?,?,?,?,?,?,?)`,
          [row.id, req.user.id, legacyPlanId, row.week_start || getTodayISO(), 1, 'active', JSON.stringify({ completedSessionIds: [] })]
        );
        if (insert.changes === 0) throw new Error('Legacy plan assignment migration failed');
      }

      const update = await tx.run(
        'UPDATE user_plans SET current_week = ?, progress_json = ? WHERE id = ? AND user_id = ?',
        [nextWeek, JSON.stringify({ ...progress, completedSessionIds: Array.from(completed) }), row.id, req.user.id]
      );
      if (update.changes === 0) throw new Error('Active plan progress update failed');
      return { ok: true, current_week: nextWeek, completedSessionIds: Array.from(completed) };
    });

    if (result.notFound) return res.status(404).json({ error: 'No assigned plan' });
    if (result.invalidSession) return res.status(400).json({ error: 'Invalid plan session' });
    if (result.invalidWeek) return res.status(400).json({ error: 'Invalid plan week' });
    res.json(result);
  } catch (err) {
    console.error('[plans/my/progress] failed:', err.message);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

router.get('/today', auth, async (req, res) => {
  try {
    // H5: accept a phone-local date (+/-1 day safety, same rule as H4).
    const dateISO = getPlanningDateFromRequest(req);
    if (dateISO === null) return res.status(400).json({ error: 'Invalid date' });

    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ today: null, execution: { hasPlan: false, hasDay: false, date: dateISO } });
    const parsed = parsePlan(active.row);

    // H5: select the EXACT dated schema-v2 day (legacy plans fall back to a
    // weekday match among undated days only). Replaces the old first-weekday
    // scan that could return week 1's Tuesday regardless of the current week.
    const weekdayShort = dailyExecution.weekdayShortForDate(dateISO);
    const selection = dailyExecution.selectDayForDate(parsed, dateISO, weekdayShort);
    const selectedEntry = selection ? selection.entry : null;
    const selectedWeek = selection ? selection.week : null;
    const selectedDayIndex = selection ? selection.dayIndex : null;

    const override = await dbGet(
      'SELECT patch_json FROM checkin_overrides WHERE user_id=? AND date=?',
      [req.user.id, dateISO]
    );
    let patch = null;
    if (override?.patch_json) {
      try {
        patch = typeof override.patch_json === 'string' ? JSON.parse(override.patch_json) : override.patch_json;
      } catch (err) {
        console.error('[plans] Failed to parse check-in override patch:', err);
      }
    }

    // Legacy `today` shape is preserved for existing consumers.
    const baseDay = selectedEntry ? planSchema.flattenDayForConsumer(selectedEntry) : null;
    const legacyToday = baseDay ? (patch ? applyOverride(baseDay, patch) : baseDay) : null;

    // Completion state + calibrated HR profile for the canonical execution object.
    const [progressRow, hrProfile] = await Promise.all([
      dbGet(
        "SELECT progress_json FROM user_plans WHERE user_id=? AND status='active' ORDER BY created_at DESC LIMIT 1",
        [req.user.id]
      ),
      getHrProfile(req.user.id, dbGet),
    ]);
    let completedSessionIds = [];
    if (progressRow?.progress_json) {
      try {
        const p = JSON.parse(progressRow.progress_json);
        if (Array.isArray(p.completedSessionIds)) completedSessionIds = p.completedSessionIds;
      } catch (err) {
        console.error('[plans/today] invalid progress JSON:', err.message);
      }
    }

    const overriddenEntry = (patch && selectedEntry)
      ? planSchema.applyOverrideToDay(selectedEntry, patch)
      : selectedEntry;
    const execution = dailyExecution.buildDailyExecution({
      plan: parsed,
      dateISO,
      weekdayShort,
      selectedEntry: overriddenEntry,
      selectedWeek,
      selectedDayIndex,
      completedSessionIds,
      hrProfile,
    });

    res.json({ today: legacyToday, execution });
  } catch (err) {
    console.error('[plans] GET today failed:', err);
    res.status(500).json({ error: 'Failed to fetch today' });
  }
});

router.get('/current', auth, async (req, res) => {
  try {
    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ plan: null });
    const parsed = parsePlan(active.row) || { weeks: [] };
    res.json({
      plan: {
        ...active.row,
        plan_json: parsed,
        plan_data: parsed,
        current_week: Number(active.row.current_week || 1),
      },
    });
  } catch (err) {
    console.error('[plans/current] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch current plan' });
  }
});

router.get('/compliance', auth, async (req, res) => {
  try {
    const weekStart = getMonday();
    const weekEndDate = new Date(`${weekStart}T12:00:00`);
    weekEndDate.setDate(weekEndDate.getDate() + 7);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);

    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ week: weekStart, planned: 0, completed: 0, score: 0, missed: [], streak: { current: 0, best: 0 } });

    const parsed = parsePlan(active.row) || { weeks: [] };
    const currentWeek = Number(active.row.current_week || 1);
    const weekBucket = parsed?.weeks?.[Math.max(0, currentWeek - 1)] || parsed?.weeks?.[0] || {};
    const days = planSchema.getDayEntries(weekBucket);
    // Session-aware (H1): each day expands to one planned row per run/lift
    // session. Legacy / run-only days collapse to exactly one row, matching the
    // previous mapType behaviour.
    const plannedSessions = days
      .flatMap((d, idx) => planSchema.plannedSessionsForDay(
        d, idx, dayToDate(active.row.week_start || active.row.started_at || weekStart, d.day)
      ))
      .filter((d) => d.type !== 'rest' && d.date && d.date >= weekStart && d.date < weekEnd);

    const [runs, lifts] = await Promise.all([
      dbAll(`SELECT id, date, distance_miles FROM runs WHERE user_id=? AND date>=? AND date<? AND ${runActivitySql()}`, [req.user.id, weekStart, weekEnd]),
      dbAll('SELECT id, date FROM lifts WHERE user_id=? AND date>=? AND date<?', [req.user.id, weekStart, weekEnd])
    ]);

    const usedRunIds = new Set();
    const usedLiftIds = new Set();

    const statusItems = plannedSessions.map((s) => {
      const target = new Date(`${s.date}T12:00:00`).getTime();
      const bucket = s.type === 'lift' ? lifts : runs;
      const used = s.type === 'lift' ? usedLiftIds : usedRunIds;
      let hit = null;
      for (const item of bucket) {
        if (used.has(item.id)) continue;
        const t = new Date(`${item.date}T12:00:00`).getTime();
        if (Math.abs(t - target) <= 24 * 60 * 60 * 1000) { hit = item; used.add(item.id); break; }
      }
      return { ...s, completed: !!hit };
    });

    const completed = statusItems.filter((s) => s.completed).length;
    const planned = statusItems.length;
    const score = planned > 0 ? Math.round((completed / planned) * 100) : 0;

    let current = 0, best = 0;
    for (const item of statusItems) {
      if (item.completed) { current += 1; best = Math.max(best, current); }
      else { current = 0; }
    }

    const today = new Date().toISOString().slice(0, 10);
    const missed = statusItems
      .filter((s) => !s.completed && s.date < today)
      .map((s) => ({ sessionId: s.sessionId, day: s.day, date: s.date, type: s.type, distance: s.distance }));

    const week = (() => {
      const d = new Date(`${weekStart}T12:00:00`);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((d - yearStart) / 86400000) + yearStart.getUTCDay() + 1) / 7);
      return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    })();

    res.json({ week, planned, completed, score, missed, streak: { current, best }, sessions: statusItems });
  } catch (err) {
    console.error('[plans/compliance] failed:', err.message);
    res.status(500).json({ error: 'Compliance fetch failed' });
  }
});

router.post('/reschedule-missed', auth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.status(404).json({ error: 'No plan found' });

    const parsed = parsePlan(active.row);
    const currentWeek = Math.max(0, Number(active.row.current_week || 1) - 1);
    const week = parsed?.weeks?.[currentWeek];
    if (!planSchema.getDayEntries(week).length) return res.status(400).json({ error: 'Invalid plan format' });

    const result = planSchema.rescheduleSessionInWeek(week, sessionId);
    if (result.error === 'not_found') return res.status(404).json({ error: 'Session not found in plan' });
    if (result.error === 'no_target') return res.status(409).json({ error: 'No later recovery day is available' });
    parsed.weeks[currentWeek] = result.week;

    await withTransaction(async (tx) => {
      await updateActivePlanData(active, req.user.id, parsed, tx);
    });
    res.json({ ok: true, movedFrom: result.movedFrom, movedTo: result.movedTo, plan: parsed, aiSuggestion: 'Week rebalanced after missed session. Keep next run easy and preserve long run.' });
  } catch (err) {
    console.error('[plans/reschedule-missed] failed:', err.message);
    res.status(500).json({ error: 'Reschedule failed' });
  }
});

router.post('/race-adjust', auth, async (req, res) => {
  try {
    const { raceId } = req.body || {};
    if (!raceId) return res.status(400).json({ error: 'raceId required' });

    const [race, plan, profile] = await Promise.all([
      dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [raceId, req.user.id]),
      getActivePlanForUser(req.user.id),
      dbGet('SELECT * FROM users WHERE id=?', [req.user.id])
    ]);

    if (!race) return res.status(404).json({ error: 'Race not found' });
    if (!plan) return res.status(404).json({ error: 'No plan found' });

    const parsed = parsePlan(plan.row) || { weeks: [] };
    const adjusted = await generateRaceAdjustment({ profile, race, currentPlan: parsed });
    if (!Array.isArray(adjusted?.weeks) || adjusted.weeks.length === 0) {
      return res.status(503).json({ error: 'Race adjustment is temporarily unavailable. Your current plan was not changed.' });
    }
    const nextPlan = adjusted;
    await withTransaction(async (tx) => {
      await updateActivePlanData(plan, req.user.id, nextPlan, tx);
    });
    res.json({ ok: true, plan: nextPlan });
  } catch (err) {
    console.error('[plans/race-adjust] failed:', err.message);
    res.status(500).json({ error: 'Race adjust failed' });
  }
});

const HYBRID_SESSION_TEMPLATES = [
  { title: 'Weighted Circuit', description: 'Alternating loaded carries and fast cardio intervals.' },
  { title: 'Kettlebell Cardio', description: 'Kettlebell swings with short aerobic repeats.' },
  { title: 'Rucking', description: 'Brisk weighted walk focused on steady effort.' },
  { title: 'Sled Push Intervals', description: 'Short sled pushes with controlled recovery.' },
];

function isRestDay(day = {}) {
  const type = String(day.type || day.workout_type || '').toLowerCase();
  return day.rest === true || type.includes('rest');
}

function isHybridSession(day = {}) {
  const text = `${day.title || ''} ${day.description || ''} ${day.workout_type || ''} ${day.type || ''}`.toLowerCase();
  return text.includes('weighted circuit')
    || text.includes('kettlebell cardio')
    || text.includes('ruck')
    || text.includes('sled push')
    || text.includes('hybrid');
}

function createHybridSession(dayLabel, index) {
  const template = HYBRID_SESSION_TEMPLATES[index % HYBRID_SESSION_TEMPLATES.length];
  return {
    day: dayLabel,
    type: 'cross_train',
    workout_type: 'hybrid',
    title: template.title,
    distance_miles: 2,
    duration_min: 30,
    description: template.description,
    rest: false,
  };
}

function createEasySession(dayLabel) {
  return {
    day: dayLabel,
    type: 'easy',
    workout_type: 'run',
    title: 'Easy aerobic run',
    distance_miles: 2,
    duration_min: 25,
    description: 'Easy effort run to support consistent weekly frequency.',
    rest: false,
  };
}

function isLongRunSession(day = {}) {
  const text = `${day.title || ''} ${day.description || ''} ${day.workout_type || ''} ${day.type || ''}`.toLowerCase();
  return text.includes('long');
}

function isRunningSession(day = {}) {
  if (isRestDay(day) || isHybridSession(day)) return false;
  const text = `${day.title || ''} ${day.description || ''} ${day.workout_type || ''} ${day.type || ''}`.toLowerCase();
  if (text.includes('strength') || text.includes('lift') || text.includes('cross')) return false;
  return true;
}

function isHillSession(day = {}) {
  const text = `${day.title || ''} ${day.description || ''} ${day.workout_type || ''} ${day.type || ''}`.toLowerCase();
  return text.includes('hill') || text.includes('uphill') || text.includes('climb');
}

function getHillSessionPrescription(week = {}) {
  const theme = String(week.theme || '').toLowerCase();
  const weekNumber = Number(week.week) || 1;
  if (theme.includes('taper') || theme.includes('race')) {
    return {
      title: 'Hill Strides',
      description: 'Easy run with 6 x 20s uphill strides at controlled fast effort; walk/jog back recovery.',
      structure: {
        warmup: '10-15 min easy',
        repeats: '6 x 20s uphill controlled fast',
        recovery: 'Walk/jog downhill between reps',
        cooldown: 'Easy running to finish',
      },
    };
  }
  if (theme.includes('build') || weekNumber >= 5) {
    return {
      title: 'Hill Repeats',
      description: 'Structured hill workout: 8 x 60s uphill hard with jog-down recovery; stay tall and powerful.',
      structure: {
        warmup: '10-15 min easy plus drills',
        repeats: '8 x 60s uphill hard',
        recovery: 'Jog downhill easy between reps',
        cooldown: '10 min easy',
      },
    };
  }
  return {
    title: 'Hill Repeats',
    description: 'Structured hill workout: 6 x 60s uphill hard with jog-down recovery; keep effort strong but controlled.',
    structure: {
      warmup: '10-15 min easy',
      repeats: '6 x 60s uphill hard',
      recovery: 'Jog downhill easy between reps',
      cooldown: '10 min easy',
    },
  };
}

function convertToHillSession(day = {}, week = {}) {
  const prescription = getHillSessionPrescription(week);
  return {
    ...day,
    type: 'hill',
    workout_type: 'run',
    title: prescription.title,
    description: prescription.description,
    structure: prescription.structure,
    rest: false,
  };
}

function enforceHillSessionForWeek(week = {}, days = []) {
  if (days.some((day) => !isRestDay(day) && isHillSession(day))) return days;
  const candidateIndex = days.findIndex((day) => isRunningSession(day) && !isLongRunSession(day));
  if (candidateIndex < 0) return days;
  const nextDays = [...days];
  nextDays[candidateIndex] = convertToHillSession(nextDays[candidateIndex], week);
  return nextDays;
}

function enforceWeekSessionRules(week = {}, options = {}) {
  const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const allowedTrainingDays = Array.isArray(options.trainingDays) && options.trainingDays.length
    ? new Set(options.trainingDays)
    : null;
  // Session-aware (H1): schema-v2 days are flattened to the legacy single-day
  // shape before the single-session enforcement logic runs. Legacy days pass
  // through unchanged (identity), so existing plans stay byte-identical.
  const sourceDays = planSchema.getDayEntries(week).map((day) => {
    if (options.liftingEnabled === false && Array.isArray(day?.sessions)) {
      const runSessions = planSchema.daySessions(day).filter((session) => session.kind !== 'lift');
      return planSchema.flattenDayForConsumer(planSchema.toCanonicalDay(day, runSessions));
    }
    return planSchema.flattenDayForConsumer(day);
  });
  const dayByKey = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
  const sourceByDay = new Map(sourceDays
    .map((day) => [dayByKey[String(day?.day || '').trim().slice(0, 3).toLowerCase()], day])
    .filter(([day]) => day));
  const days = dayOrder.map((label, idx) => {
    const existing = allowedTrainingDays ? (sourceByDay.get(label) || {}) : (sourceDays[idx] || {});
    return { ...existing, day: label };
  });

  if (allowedTrainingDays) {
    for (let i = 0; i < days.length; i += 1) {
      if (allowedTrainingDays.has(days[i].day) || isRestDay(days[i])) continue;
      days[i] = { day: days[i].day, type: 'rest', workout_type: 'rest', distance_miles: 0, duration_min: 0, description: 'Rest and recovery', rest: true };
    }
    for (let i = 0; i < days.length; i += 1) {
      const hasType = String(days[i].type || days[i].workout_type || '').trim().length > 0;
      if (allowedTrainingDays.has(days[i].day) && !isRestDay(days[i]) && !hasType) {
        days[i] = createEasySession(days[i].day);
      }
    }
  }

  const nonRestIndexes = [];
  for (let i = 0; i < days.length; i += 1) {
    if (!isRestDay(days[i])) nonRestIndexes.push(i);
  }

  while (nonRestIndexes.length < 6) {
    const restIndex = days.findIndex((d) => isRestDay(d) && (!allowedTrainingDays || allowedTrainingDays.has(d.day)));
    if (restIndex < 0) break;
    days[restIndex] = createEasySession(days[restIndex].day || dayOrder[restIndex]);
    nonRestIndexes.push(restIndex);
  }

  if (options.liftingEnabled === false) {
    const runOnlyDays = days.map((day) => {
      const type = String(day.type || day.workout_type || '').toLowerCase();
      if (type.includes('strength') || type.includes('lift') || type.includes('cross') || isHybridSession(day)) {
        return createEasySession(day.day);
      }
      return day;
    });
    return {
      ...week,
      days: options.courseHilly ? enforceHillSessionForWeek(week, runOnlyDays) : runOnlyDays,
    };
  }

  let hybridIndexes = nonRestIndexes.filter((idx) => isHybridSession(days[idx]));
  if (hybridIndexes.length < 1) {
    const targetIndex = nonRestIndexes[Math.max(0, nonRestIndexes.length - 1)];
    days[targetIndex] = createHybridSession(days[targetIndex].day || dayOrder[targetIndex], 0);
    hybridIndexes = nonRestIndexes.filter((idx) => isHybridSession(days[idx]));
  }
  if (hybridIndexes.length < 2 && nonRestIndexes.length >= 6) {
    const targetIndex = nonRestIndexes.find((idx) => idx !== hybridIndexes[0]);
    if (targetIndex !== undefined) {
      days[targetIndex] = createHybridSession(days[targetIndex].day || dayOrder[targetIndex], 1);
    }
  }

  const finalNonRest = days.filter((d) => !isRestDay(d)).length;
  if (finalNonRest === 7) {
    const sundayIndex = dayOrder.indexOf('Sun');
    days[sundayIndex] = { day: 'Sun', type: 'rest', workout_type: 'rest', distance_miles: 0, duration_min: 0, description: 'Rest and recovery', rest: true };
  }

  return { ...week, days: options.courseHilly ? enforceHillSessionForWeek(week, days) : days };
}

function enforcePlanSessionRules(planData = {}, options = {}) {
  const weeks = Array.isArray(planData.weeks) ? planData.weeks.map((week) => enforceWeekSessionRules(week, options)) : [];
  return { ...planData, weeks };
}

router.post('/generate', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    const requested = stripClientCourseFacts(req.body?.target || {});
    const distanceMiles = clamp(parsePositiveNumber(requested.distanceMiles ?? requested.distance_miles) || 6.2, 1, 100);
    const requestedRaceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(requested.raceDate || ''))
      && !Number.isNaN(new Date(`${requested.raceDate}T12:00:00`).getTime())
      ? requested.raceDate
      : null;
    const raceWindow = requestedRaceDate ? concurrentPlan.racePlanWindow(requestedRaceDate, getTodayISO()) : null;
    if (requestedRaceDate && !raceWindow) return res.status(400).json({ error: 'Race date must be today or later' });
    const startDate = raceWindow?.startDate || getPlanStartMonday();
    const target = {
      ...requested,
      distanceMiles,
      raceDate: requestedRaceDate,
      weeks: raceWindow?.weeks || clampInt(requested.weeks, 4, 20, defaultWeeksForDistance(distanceMiles)),
      startDate,
      planMode: concurrentPlan.resolvePlanMode(profile, requested),
      todayISO: getTodayISO(),
      nowISO: `${getTodayISO()}T12:00:00.000Z`,
    };
    const context = await buildConcurrentContext(req.user.id, profile, target);
    const evidencePlan = concurrentPlan.buildConcurrentPlan(context);
    const validation = concurrentPlan.validateConcurrentPlan(evidencePlan, context);
    if (!validation.valid) throw new Error(`Evidence plan failed validation: ${validation.errors.join('; ')}`);
    const selected = { plan: evidencePlan, source: 'evidence_engine' };
    const name = selected.plan.goal?.name || 'Forged Hybrid training block';
    const persisted = await persistConcurrentPlan(req.user.id, selected.plan, {
      name,
      type: selected.plan.planMode,
      description: `${selected.plan.weeks.length}-week evidence-backed concurrent plan generated from profile and recent training history.`,
    });
    res.status(201).json({
      plan: { id: persisted.planId, user_id: req.user.id, week_start: persisted.weekStart, plan_json: selected.plan, plan_data: selected.plan },
      user_plan_id: persisted.userPlanId,
      generation_source: selected.source,
    });
  } catch (err) { console.error('generate failed:', err.message); res.status(500).json({ error: 'Plan generation failed' }); }
});

router.post('/generate-for-race/:raceId', auth, requirePremium('Race Programs'), async (req, res) => {
  try {
    const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    const race = await dbGet('SELECT * FROM race_events WHERE id = ? AND user_id = ?', [req.params.raceId, req.user.id]);
    if (!race) return res.status(404).json({ error: 'Race not found' });
    // Cover every dated week through race day from the next plan Monday.
    const raceWindow = concurrentPlan.racePlanWindow(race.race_date, getTodayISO());
    if (!raceWindow) return res.status(400).json({ error: 'Race date must be today or later' });
    const { startDate, weeks } = raceWindow;
    const requested = stripClientCourseFacts(req.body?.target || {});
    const target = {
      ...requested,
      raceDate: race.race_date,
      raceName: race.race_name,
      distanceMiles: clamp(Number(race.distance_miles) || 6.2, 1, 100),
      goalTimeSeconds: race.goal_time_seconds ?? null,
      weeks,
      startDate,
      ...courseTargetFromRace(race),
      todayISO: getTodayISO(),
      nowISO: `${getTodayISO()}T12:00:00.000Z`,
    };
    target.planMode = concurrentPlan.resolvePlanMode(profile, target);
    const context = await buildConcurrentContext(req.user.id, profile, target);
    const evidencePlan = concurrentPlan.buildConcurrentPlan(context);
    const validation = concurrentPlan.validateConcurrentPlan(evidencePlan, context);
    if (!validation.valid) throw new Error(`Evidence race plan failed validation: ${validation.errors.join('; ')}`);
    const selected = { plan: evidencePlan, source: 'evidence_engine' };
    const persisted = await persistConcurrentPlan(req.user.id, selected.plan, {
      name: race.race_name,
      type: selected.plan.planMode,
      description: `${weeks}-week course-aware plan for ${race.race_name}.`,
    });
    res.status(201).json({
      plan: { id: persisted.planId, user_id: req.user.id, week_start: persisted.weekStart, plan_json: selected.plan, plan_data: selected.plan },
      user_plan_id: persisted.userPlanId,
      generation_source: selected.source,
      weeks,
      race: { id: race.id, name: race.race_name, date: race.race_date },
    });
  } catch (err) { console.error('generate-for-race failed:', err.message); res.status(500).json({ error: 'Race plan generation failed' }); }
});

module.exports = router;
