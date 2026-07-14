const router = require('express').Router();
const { dbAll, dbGet } = require('../db');
const { buildHealthSignals } = require('../lib/healthSignals');
const auth = require('../middleware/auth');

function isoDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function formatSleep(hours) {
  const totalMinutes = Math.round(Number(hours || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function avg(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function validSleepHours(value) {
  if (value === null || value === undefined || value === '') return null;
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 && hours <= 12 ? hours : null;
}

function parseFlags(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[body/drivers] check-in flags parse failed:', err.message);
    return [];
  }
}

function buildSleepDriver(checkins, healthSignals) {
  const sleepRows = checkins
    .map((row) => ({ ...row, sleep_hours: validSleepHours(row.sleep_hours) }))
    .filter((row) => row.sleep_hours !== null);
  const syncedSleep = validSleepHours(healthSignals?.metrics?.sleepHoursLastNight);
  if (!sleepRows.length && syncedSleep === null) return null;
  const current = sleepRows.length ? Number(sleepRows[0].sleep_hours) : syncedSleep;
  const baseline = sleepRows.length
    ? avg(sleepRows.slice(1).map((row) => row.sleep_hours))
    : validSleepHours(healthSignals?.metrics?.sleepHours7dBaseline);
  const delta = baseline === null ? 0 : current - baseline;
  const impact = current < 6.5 ? 'negative' : current >= 7.5 ? 'positive' : 'neutral';
  const trend = delta <= -0.5 ? 'down' : delta >= 0.5 ? 'up' : 'flat';
  const points = current < 5.5 ? 16 : current < 6.5 ? 12 : current >= 8 ? 5 : 0;
  return {
    key: 'sleep',
    label: 'Sleep',
    value: formatSleep(current),
    trend,
    impact,
    severity: impact === 'negative' ? points : 0,
    plainEnglish: impact === 'negative'
      ? `Last night's ${formatSleep(current)} pulled readiness down about ${points} points.`
      : `Last night's ${formatSleep(current)} supports today's readiness.`,
    suggestion: impact === 'negative' ? 'Z2 only today — give your nervous system a break.' : 'Train as planned, but keep the first 10 minutes honest.',
  };
}

function buildHrvDriver(healthSignals) {
  const hrv = Number(healthSignals?.metrics?.hrvMs);
  if (!Number.isFinite(hrv) || hrv <= 0) return null;
  const baseline = Number(healthSignals?.metrics?.hrvMsBaseline);
  const deltaPct = Number.isFinite(baseline) && baseline > 0 ? (hrv - baseline) / baseline : null;
  const impact = deltaPct !== null ? (deltaPct <= -0.15 ? 'negative' : deltaPct >= 0.1 ? 'positive' : 'neutral') : hrv < 40 ? 'negative' : hrv >= 60 ? 'positive' : 'neutral';
  return {
    key: 'hrv',
    label: 'HRV',
    value: `${Math.round(hrv)}ms`,
    trend: deltaPct === null ? 'flat' : deltaPct <= -0.08 ? 'down' : deltaPct >= 0.08 ? 'up' : 'flat',
    impact,
    severity: impact === 'negative' ? 10 : 0,
    plainEnglish: impact === 'negative'
      ? `HRV is ${Math.round(hrv)}ms${deltaPct === null ? '' : `, ${Math.abs(Math.round(deltaPct * 100))}% below your baseline`}.`
      : `HRV is ${Math.round(hrv)}ms${deltaPct === null ? '' : ` versus a ${Math.round(baseline)}ms baseline`}.`,
    suggestion: impact === 'negative' ? 'Keep intensity controlled and skip all-out intervals.' : 'Use effort, not ego, to decide if you can push.',
  };
}

function buildRestingHrDriver(healthSignals) {
  const restingHr = Number(healthSignals?.metrics?.restingHeartRate);
  const baseline = Number(healthSignals?.metrics?.restingHeartRateBaseline);
  if (!Number.isFinite(restingHr) || restingHr <= 0 || !Number.isFinite(baseline) || baseline <= 0) return null;
  const delta = restingHr - baseline;
  const impact = delta >= 8 ? 'negative' : delta <= -3 ? 'positive' : 'neutral';
  return {
    key: 'restingHr',
    label: 'Resting HR',
    value: `${Math.round(restingHr)} bpm`,
    trend: delta >= 3 ? 'up' : delta <= -3 ? 'down' : 'flat',
    impact,
    severity: impact === 'negative' ? 10 : 0,
    plainEnglish: `Resting heart rate is ${Math.abs(Math.round(delta))} bpm ${delta >= 0 ? 'above' : 'below'} your baseline.`,
    suggestion: impact === 'negative' ? 'Keep today controlled and pair this with sleep, soreness, and how you feel.' : 'No unusual resting-heart-rate strain is showing.',
  };
}

function lookupFallback(label, fallback) {
  return (err) => {
    console.error(`[body/drivers] ${label} lookup failed:`, err.message);
    return fallback;
  };
}

function buildStrainDriver(currentMiles, priorMiles, liftCount) {
  if (currentMiles <= 0 && priorMiles <= 0 && liftCount <= 0) return null;
  const ratio = priorMiles > 0 ? (currentMiles - priorMiles) / priorMiles : (currentMiles > 0 ? 1 : 0);
  const impact = ratio >= 0.3 ? 'negative' : ratio <= -0.3 ? 'positive' : 'neutral';
  const trend = ratio >= 0.1 ? 'up' : ratio <= -0.1 ? 'down' : 'flat';
  const value = `${Number(currentMiles.toFixed(1))} mi/wk`;
  return {
    key: 'strain',
    label: 'Strain',
    value,
    trend,
    impact,
    severity: impact === 'negative' ? Math.round(Math.min(18, ratio * 40)) : 0,
    plainEnglish: impact === 'negative'
      ? `Training load is up ${Math.round(ratio * 100)}% versus the prior week.`
      : impact === 'positive'
        ? `Training load is down ${Math.abs(Math.round(ratio * 100))}% versus the prior week, so you look fresher.`
        : `Training load is balanced with ${value} and ${liftCount} lift ${liftCount === 1 ? 'session' : 'sessions'}.`,
    suggestion: impact === 'negative' ? 'Avoid stacking another hard day on top of this load.' : 'You can follow the plan if sleep and soreness agree.',
  };
}

function buildSorenessDriver(checkin) {
  const flags = parseFlags(checkin?.life_flags);
  if (!flags.includes('sore')) return null;
  return {
    key: 'soreness',
    label: 'Soreness',
    value: '7/10',
    trend: 'down',
    impact: 'negative',
    severity: 9,
    plainEnglish: 'Your check-in flagged soreness, so readiness is limited by tissue stress today.',
    suggestion: 'Choose easy running, mobility, or upper-body work unless soreness improves.',
  };
}

router.get('/drivers', auth, async (req, res) => {
  try {
    const since7 = isoDaysAgo(7);
    const since14 = isoDaysAgo(14);
    const [checkins, health, currentRun, priorRun, currentLifts] = await Promise.all([
      dbAll('SELECT sleep_hours, life_flags, checkin_date, created_at FROM daily_checkins WHERE user_id=? AND checkin_date>=? ORDER BY checkin_date DESC, created_at DESC', [req.user.id, since7]).catch(lookupFallback('check-in', [])),
      dbGet('SELECT * FROM health_sync WHERE user_id=?', [req.user.id]).catch(lookupFallback('health sync', null)),
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=?', [req.user.id, since7]).catch(lookupFallback('current run load', { miles: 0 })),
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?', [req.user.id, since14, since7]).catch(lookupFallback('prior run load', { miles: 0 })),
      dbGet("SELECT COUNT(*) as count FROM workout_sessions WHERE user_id=? AND started_at>=? AND ended_at IS NOT NULL", [req.user.id, `${since7}T00:00:00`]).catch(lookupFallback('lift count', { count: 0 })),
    ]);
    const healthSignals = buildHealthSignals(health || {});

    const driversWithSeverity = [
      buildSleepDriver(checkins, healthSignals),
      buildHrvDriver(healthSignals),
      buildRestingHrDriver(healthSignals),
      buildStrainDriver(Number(currentRun?.miles || 0), Number(priorRun?.miles || 0), Number(currentLifts?.count || 0)),
      buildSorenessDriver(checkins[0]),
    ].filter(Boolean);
    const drivers = driversWithSeverity.map(({ severity, ...driver }) => driver);

    const candidates = driversWithSeverity.filter((driver) => driver.impact === 'negative');
    candidates.sort((a, b) => {
      if (a.trend === 'down' && b.trend !== 'down') return -1;
      if (b.trend === 'down' && a.trend !== 'down') return 1;
      return (b.severity || 0) - (a.severity || 0);
    });
    const limiter = candidates[0] || null;
    const summary = limiter
      ? `${limiter.label} is the limiter today — ${limiter.plainEnglish}`
      : drivers.length
        ? 'All recent inputs look good — train as planned'
        : 'Not enough recent data yet — sync Apple Health or complete today\'s check-in.';

    res.json({
      summary,
      limiter: limiter?.key || null,
      drivers,
    });
  } catch (err) {
    console.error('[body/drivers] failed:', err.message);
    res.status(500).json({ error: 'Body drivers failed' });
  }
});

module.exports = router;
