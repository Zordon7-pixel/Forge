const { isRunActivity } = require('./runActivity');
const { dateInTimezone } = require('./challengeRules');

const KM_PER_MILE = 1.609344;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function isInsideWindow(date, challenge) {
  return Boolean(date && date >= challenge.start_date && date <= challenge.end_date);
}

function localActivityDate(activity, timezone, timestampKeys = []) {
  for (const key of timestampKeys) {
    if (!activity?.[key]) continue;
    const localized = dateInTimezone(activity[key], timezone);
    if (localized) return localized;
  }
  const rawDate = String(activity?.date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
}

function isDeviceRecorded(activity = {}) {
  const watchMode = String(activity.watch_mode || '').toLowerCase();
  const normalizedType = String(activity.watch_normalized_type || '').toLowerCase();
  return Boolean(
    activity.watch_sync_id
    || activity.health_source
    || activity.health_source_workout_id
    || ['import', 'watch', 'watch-sync'].includes(watchMode)
    || normalizedType === 'imported'
  );
}

function runDedupKey(run) {
  if (run.health_source && run.health_source_workout_id) {
    return `health:${run.health_source}:${run.health_source_workout_id}`;
  }
  if (run.watch_sync_id) return `watch:${run.watch_sync_id}`;
  return `run:${run.id}`;
}

function liftDedupKey(lift) {
  if (lift.watch_sync_id) return `watch:${lift.watch_sync_id}`;
  // Health/watch ingest rejects replays before insert; preserve distinct device sessions here.
  if (isDeviceRecorded(lift)) return `import:${lift.id}`;
  // Legacy manual lift rows may represent exercises rather than sessions.
  return `legacy-manual:${lift.date}`;
}

function preferMoreComplete(existing, candidate, fields) {
  if (!existing) return candidate;
  const existingTotal = fields.reduce((sum, field) => sum + Number(existing[field] || 0), 0);
  const candidateTotal = fields.reduce((sum, field) => sum + Number(candidate[field] || 0), 0);
  return candidateTotal > existingTotal ? candidate : existing;
}

function scoreChallenge(challenge, rows, userId) {
  const deviceOnly = challenge.verification_policy === 'device_only';
  const runMap = new Map();
  const runContributions = [];
  const runDays = new Set();

  for (const run of rows.runs || []) {
    if (String(run.user_id) !== String(userId) || !isRunActivity(run)) continue;
    const date = localActivityDate(run, challenge.timezone, ['health_start_at']);
    if (!isInsideWindow(date, challenge)) continue;
    const device = isDeviceRecorded(run);
    if (deviceOnly && !device) continue;
    const key = runDedupKey(run);
    runMap.set(key, preferMoreComplete(runMap.get(key), { ...run, _challengeDate: date, _device: device }, ['distance_miles', 'duration_seconds']));
  }

  let distanceMiles = 0;
  let durationSeconds = 0;
  for (const run of runMap.values()) {
    distanceMiles += Math.max(0, Number(run.distance_miles || 0));
    durationSeconds += Math.max(0, Number(run.duration_seconds || 0));
    runDays.add(run._challengeDate);
    runContributions.push({
      date: run._challengeDate,
      category: 'run',
      distance_miles: round(Math.max(0, Number(run.distance_miles || 0)), 3),
      duration_seconds: Math.max(0, Math.round(Number(run.duration_seconds || 0))),
      verification: run._device ? 'device' : 'manual',
    });
  }

  const strengthMap = new Map();
  for (const session of rows.workoutSessions || []) {
    if (String(session.user_id) !== String(userId) || !session.ended_at || deviceOnly) continue;
    const date = localActivityDate(session, challenge.timezone, ['started_at']);
    if (!isInsideWindow(date, challenge)) continue;
    strengthMap.set(`session:${session.id}`, { date, verification: 'manual' });
  }

  for (const lift of rows.lifts || []) {
    if (String(lift.user_id) !== String(userId)) continue;
    const date = localActivityDate(lift, challenge.timezone);
    if (!isInsideWindow(date, challenge)) continue;
    const device = isDeviceRecorded(lift);
    if (deviceOnly && !device) continue;
    strengthMap.set(liftDedupKey(lift), { date, verification: device ? 'device' : 'manual' });
  }

  const strengthContributions = [...strengthMap.values()].map((entry) => ({
    date: entry.date,
    category: 'strength',
    sessions: 1,
    verification: entry.verification,
  }));

  const distanceValue = challenge.run_unit === 'kilometers' ? distanceMiles * KM_PER_MILE : distanceMiles;
  const runMinutes = durationSeconds / 60;
  const runDaysValue = runDays.size;
  const liftSessions = strengthMap.size;

  let runValue = null;
  if (challenge.template_type === 'running_distance' || challenge.template_type === 'hybrid_balance') runValue = distanceValue;
  if (challenge.template_type === 'running_time') runValue = runMinutes;
  if (challenge.template_type === 'running_consistency') runValue = runDaysValue;

  const runRatio = challenge.run_target ? Math.max(0, Number(runValue || 0) / Number(challenge.run_target)) : null;
  const liftRatio = challenge.lift_target ? Math.max(0, liftSessions / Number(challenge.lift_target)) : null;
  let ratio = runRatio ?? liftRatio ?? 0;
  if (challenge.template_type === 'hybrid_balance') ratio = Math.min(runRatio || 0, liftRatio || 0);
  const percent = round(Math.min(1, ratio) * 100);

  const contributions = [...runContributions, ...strengthContributions]
    .sort((first, second) => second.date.localeCompare(first.date) || first.category.localeCompare(second.category))
    .slice(0, 10);

  return {
    user_id: userId,
    score: percent,
    completed: percent >= 100,
    percent,
    run: challenge.run_target ? {
      value: round(runValue),
      target: Number(challenge.run_target),
      unit: challenge.run_unit,
      distance_miles: round(distanceMiles, 3),
      duration_minutes: round(runMinutes),
      active_days: runDaysValue,
    } : null,
    lift: challenge.lift_target ? {
      value: liftSessions,
      target: Number(challenge.lift_target),
      unit: challenge.lift_unit || 'sessions',
    } : null,
    qualifying_counts: {
      runs: runMap.size,
      strength_sessions: liftSessions,
    },
    contributions,
  };
}

function rankChallengeScores(scores) {
  const sorted = [...scores].sort((first, second) => {
    if (second.score !== first.score) return second.score - first.score;
    return String(first.user_id).localeCompare(String(second.user_id));
  });
  let previousScore = null;
  let rank = 0;
  return sorted.map((score, index) => {
    if (previousScore === null || score.score !== previousScore) rank = index + 1;
    previousScore = score.score;
    return { ...score, rank };
  });
}

module.exports = {
  isDeviceRecorded,
  localActivityDate,
  rankChallengeScores,
  scoreChallenge,
};
