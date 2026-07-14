const { computeZones } = require('./hrZones');
const { runActivitySql } = require('./runActivity');

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toHr(value) {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  const rounded = Math.round(parsed);
  return Number.isInteger(rounded) && rounded >= 30 && rounded <= 230 ? rounded : null;
}

function restingHrFromHealth(row) {
  if (!row) return null;
  return toHr(row.resting_heart_rate)
    ?? toHr(row.resting_heart_rate_baseline ?? row.resting_hr_baseline ?? row.avg_resting_heart_rate_7d);
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

async function deriveHrProfileFromHistory(userId, deps) {
  const { dbGet, dbAll } = deps || {};
  if (!dbGet || !dbAll) throw new Error('dbGet and dbAll are required');

  const topHrRows = await dbAll(
    `SELECT max_heart_rate
     FROM runs
     WHERE user_id = ?
       AND date >= to_char(CURRENT_DATE - INTERVAL '180 days', 'YYYY-MM-DD')
       AND max_heart_rate IS NOT NULL
       AND max_heart_rate BETWEEN 30 AND 230
       AND ${runActivitySql()}
     ORDER BY max_heart_rate DESC
     LIMIT 3`,
    [userId]
  );

  const topMaxHrs = topHrRows.map(row => toHr(row.max_heart_rate)).filter(value => value !== null);
  if (!topMaxHrs.length) {
    return { available: false, reason: 'No run heart-rate history available' };
  }

  const observedMax = topMaxHrs[0];
  const stableHighHr = average(topMaxHrs);

  const healthRow = await dbGet(
    `SELECT *
     FROM health_sync
     WHERE user_id = ?
     ORDER BY synced_at DESC
     LIMIT 1`,
    [userId]
  );
  const profileRow = await dbGet(
    `SELECT max_hr, resting_hr
     FROM user_hr_profile
     WHERE user_id = ?`,
    [userId]
  );

  const storedMaxHr = toHr(profileRow?.max_hr);
  const storedRestingHr = toHr(profileRow?.resting_hr);
  const suggestedRestingHr = storedRestingHr ?? restingHrFromHealth(healthRow);
  if (suggestedRestingHr === null) {
    return { available: false, reason: 'No resting heart-rate data available' };
  }

  const suggestedMaxHr = storedMaxHr !== null
    ? Math.max(observedMax, storedMaxHr)
    : stableHighHr;

  return {
    available: true,
    suggestedMaxHr,
    suggestedRestingHr,
    observedMax,
    storedMaxHr,
    maxUnderDetected: observedMax > (storedMaxHr || 0) + 2,
    model: 'hrr',
    zones: computeZones({ maxHr: suggestedMaxHr, restingHr: suggestedRestingHr, model: 'hrr' }).zones,
    note: stableHighHr !== observedMax
      ? `Observed max ${observedMax}; top-3 average ${stableHighHr} used when no stored max is available.`
      : `Observed max ${observedMax} from recent run history.`,
  };
}

function computeFieldTestLthr(avgHr) {
  if (!Number.isInteger(avgHr) || avgHr < 60 || avgHr > 230) {
    return { error: 'avgHr must be 60-230' };
  }

  const lthr = Math.round(0.95 * avgHr);
  return {
    lthr,
    model: 'lthr',
    zones: computeZones({ lthr, model: 'lthr' }).zones,
  };
}

module.exports = { deriveHrProfileFromHistory, computeFieldTestLthr };
