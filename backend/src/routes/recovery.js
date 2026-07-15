const router = require('express').Router();
const { dbAll, dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');
const auth = require('../middleware/auth');
const { requirePremium } = require('../middleware/premiumGate');
const { buildHealthSignals, buildReadinessBand } = require('../lib/healthSignals');
const { analyzeRunHistory } = require('../lib/runHistory');
const { getHrProfile } = require('../lib/hrZones');
const { runActivitySql } = require('../lib/runActivity');

// ── Score normalization helpers ──────────────────────────────────────────────
// Each provider has different scales. We normalize everything to 0-100.

function clamp(val, min = 0, max = 100) {
  return Math.max(min, Math.min(max, val));
}

function normalizeGarminBodyBattery(bodyBattery) {
  // Garmin Body Battery is already 0-100
  return clamp(Number(bodyBattery || 0));
}

function normalizeWhoopRecovery(recoveryScore) {
  // WHOOP recovery is already 0-100
  return clamp(Number(recoveryScore || 0));
}

function normalizeOuraReadiness(readinessScore) {
  // Oura readiness is already 0-100
  return clamp(Number(readinessScore || 0));
}

function normalizeSleepScore(totalSleepSeconds) {
  // Normalize sleep duration: 7-9 hours = 80-100, <5h = 0-40
  const hours = Number(totalSleepSeconds || 0) / 3600;
  if (hours >= 9) return 100;
  if (hours >= 7) return 80 + ((hours - 7) / 2) * 20;
  if (hours >= 5) return 40 + ((hours - 5) / 2) * 40;
  return clamp(hours / 5 * 40);
}

// Source weights for unified score (higher = more trusted for recovery)
const SOURCE_WEIGHTS = {
  whoop_recovery: 1.0,
  oura_readiness: 1.0,
  garmin_body_battery: 0.8,
  garmin_sleep: 0.5,
  whoop_sleep: 0.5,
  oura_sleep: 0.5,
  apple_health_sleep: 0.4,
};
const FLAG_SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

function logReadinessQueryFailure(query, err, fallback) {
  console.warn('[recovery/readiness] query failed:', query, err?.message || err);
  return fallback;
}

// ── GET /recovery/unified ────────────────────────────────────────────────────
// Full unified recovery dashboard (Premium only)
router.get('/unified', auth, requirePremium('Full recovery dashboard'), async (req, res) => {
  try {
    const days = Math.min(Number(req.query?.days || 7), 30);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const userId = req.user.id;

    // Fetch data from all sources in parallel
    const [garminSleep, whoopData, ouraData, healthSleep] = await Promise.all([
      fetchGarminData(userId, startDate),
      fetchWhoopData(userId, startDate),
      fetchOuraData(userId, startDate),
      fetchAppleHealthSleep(userId, startDate),
    ]);

    // Build per-day aggregated data
    const dateMap = {};

    // Process Garmin sleep data
    for (const row of garminSleep) {
      const date = row.calendar_date;
      if (!dateMap[date]) dateMap[date] = { date, sources: [], scores: [] };
      const totalSleepSec = (Number(row.deep_sleep_seconds || 0) + Number(row.light_sleep_seconds || 0) + Number(row.rem_sleep_seconds || 0));
      const score = normalizeSleepScore(totalSleepSec);
      dateMap[date].sources.push({
        provider: 'garmin',
        type: 'sleep',
        score: Math.round(score),
        details: {
          deep_sleep_seconds: row.deep_sleep_seconds,
          light_sleep_seconds: row.light_sleep_seconds,
          rem_sleep_seconds: row.rem_sleep_seconds,
          awake_seconds: row.awake_seconds,
        },
      });
      dateMap[date].scores.push({ score, weight: SOURCE_WEIGHTS.garmin_sleep });
    }

    // Process WHOOP data
    for (const row of whoopData) {
      const date = row.date;
      if (!dateMap[date]) dateMap[date] = { date, sources: [], scores: [] };

      if (row.data_type === 'recovery' && row.recovery_score) {
        const score = normalizeWhoopRecovery(row.recovery_score);
        dateMap[date].sources.push({
          provider: 'whoop',
          type: 'recovery',
          score: Math.round(score),
          details: {
            recovery_score: row.recovery_score,
            hrv_rmssd: row.hrv_rmssd,
            resting_heart_rate: row.resting_heart_rate,
            spo2_pct: row.spo2_pct,
          },
        });
        dateMap[date].scores.push({ score, weight: SOURCE_WEIGHTS.whoop_recovery });
      }

      if (row.data_type === 'strain') {
        dateMap[date].sources.push({
          provider: 'whoop',
          type: 'strain',
          score: null,
          details: {
            strain_score: row.strain_score,
            kilojoules: row.kilojoules,
            avg_heart_rate: row.avg_heart_rate,
            max_heart_rate: row.max_heart_rate,
          },
        });
      }

      if (row.data_type === 'sleep' && row.sleep_performance_pct) {
        const score = clamp(Number(row.sleep_performance_pct));
        dateMap[date].sources.push({
          provider: 'whoop',
          type: 'sleep',
          score: Math.round(score),
          details: {
            sleep_performance_pct: row.sleep_performance_pct,
            sleep_efficiency_pct: row.sleep_efficiency_pct,
            total_sleep_seconds: row.total_sleep_seconds,
            deep_sleep_seconds: row.deep_sleep_seconds,
            rem_sleep_seconds: row.rem_sleep_seconds,
          },
        });
        dateMap[date].scores.push({ score, weight: SOURCE_WEIGHTS.whoop_sleep });
      }
    }

    // Process Oura data
    for (const row of ouraData) {
      const date = row.date;
      if (!dateMap[date]) dateMap[date] = { date, sources: [], scores: [] };

      if (row.data_type === 'readiness' && row.readiness_score) {
        const score = normalizeOuraReadiness(row.readiness_score);
        dateMap[date].sources.push({
          provider: 'oura',
          type: 'readiness',
          score: Math.round(score),
          details: {
            readiness_score: row.readiness_score,
            temperature_deviation: row.readiness_temperature_deviation,
            hrv_balance: row.readiness_hrv_balance,
            resting_heart_rate: row.readiness_resting_heart_rate,
          },
        });
        dateMap[date].scores.push({ score, weight: SOURCE_WEIGHTS.oura_readiness });
      }

      if (row.data_type === 'sleep' && row.sleep_score) {
        dateMap[date].sources.push({
          provider: 'oura',
          type: 'sleep',
          score: row.sleep_score,
          details: {
            sleep_score: row.sleep_score,
            total_sleep_seconds: row.total_sleep_seconds,
            deep_sleep_seconds: row.deep_sleep_seconds,
            sleep_efficiency: row.sleep_efficiency,
          },
        });
        dateMap[date].scores.push({ score: clamp(Number(row.sleep_score)), weight: SOURCE_WEIGHTS.oura_sleep });
      }

      if (row.data_type === 'heartrate') {
        dateMap[date].sources.push({
          provider: 'oura',
          type: 'hrv',
          score: null,
          details: {
            hrv_avg: row.hrv_avg,
            hrv_max: row.hrv_max,
            hrv_min: row.hrv_min,
          },
        });
      }
    }

    // Process Apple Health sleep data (from watch_sync)
    for (const row of healthSleep) {
      const date = row.date;
      if (!dateMap[date]) dateMap[date] = { date, sources: [], scores: [] };

      const durationSec = Number(row.duration_seconds || 0);
      if (durationSec > 0) {
        const score = normalizeSleepScore(durationSec);
        dateMap[date].sources.push({
          provider: 'apple_health',
          type: 'sleep',
          score: Math.round(score),
          details: {
            duration_seconds: durationSec,
            activity_name: row.activity_name,
          },
        });
        dateMap[date].scores.push({ score, weight: SOURCE_WEIGHTS.apple_health_sleep });
      }
    }

    // Calculate unified score per day (weighted average)
    const dailyData = Object.values(dateMap)
      .map((day) => {
        let unifiedScore = null;
        if (day.scores.length > 0) {
          const totalWeight = day.scores.reduce((sum, s) => sum + s.weight, 0);
          const weightedSum = day.scores.reduce((sum, s) => sum + s.score * s.weight, 0);
          unifiedScore = Math.round(weightedSum / totalWeight);
        }

        return {
          date: day.date,
          unified_score: unifiedScore,
          source_count: day.sources.length,
          sources: day.sources,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    // Build connected sources summary
    const connectedSources = [];
    const [garminRow, whoopRow, ouraRow] = await Promise.all([
      dbGet("SELECT value FROM user_settings WHERE user_id = ? AND key = 'garmin_credentials'", [userId]).catch(() => null),
      dbGet('SELECT display_name FROM whoop_tokens WHERE user_id = ?', [userId]).catch(() => null),
      dbGet('SELECT display_name FROM oura_tokens WHERE user_id = ?', [userId]).catch(() => null),
    ]);

    if (garminRow?.value) connectedSources.push('garmin');
    if (whoopRow) connectedSources.push('whoop');
    if (ouraRow) connectedSources.push('oura');
    // Apple Health is present only when imported watch_sync rows exist.
    if (healthSleep.length > 0) connectedSources.push('apple_health');

    // Latest unified score
    const latest = dailyData.find((d) => d.unified_score !== null);

    return res.json({
      unified_score: latest?.unified_score || null,
      connected_sources: connectedSources,
      days: dailyData,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch unified recovery data' });
  }
});

// ── GET /recovery/readiness ─────────────────────────────────────────────────
// Compact dashboard readiness card (Premium only)
router.get('/readiness', auth, requirePremium('Recovery readiness'), async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date();
    const start7d = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const start28d = new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const start42d = new Date(today.getTime() - 42 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [healthRow, load7d, load28d, userRow, hrProfile, recentRuns] = await Promise.all([
      dbGet('SELECT * FROM health_sync WHERE user_id = ?', [userId])
        .catch((err) => logReadinessQueryFailure('SELECT * FROM health_sync WHERE user_id = ?', err, null)),
      dbGet(
        `SELECT COALESCE(SUM(distance_miles), 0) as miles
         FROM runs
         WHERE user_id = ? AND date >= ? AND ${runActivitySql()}`,
        [userId, start7d]
      ).catch((err) => logReadinessQueryFailure('SELECT COALESCE(SUM(distance_miles), 0) as miles FROM runs WHERE user_id = ? AND date >= ?', err, { miles: 0 })),
      dbGet(
        `SELECT COALESCE(SUM(distance_miles), 0) as miles
         FROM runs
         WHERE user_id = ? AND date >= ? AND ${runActivitySql()}`,
        [userId, start28d]
      ).catch((err) => logReadinessQueryFailure('SELECT COALESCE(SUM(distance_miles), 0) as miles FROM runs WHERE user_id = ? AND date >= ?', err, { miles: 0 })),
      dbGet('SELECT max_heart_rate FROM users WHERE id = ?', [userId])
        .catch((err) => logReadinessQueryFailure('SELECT max_heart_rate FROM users WHERE id = ?', err, null)),
      getHrProfile(userId, dbGet),
      dbAll(
        `SELECT avg_heart_rate, max_heart_rate, heart_rate_zones, pace_avg, distance_miles, date, created_at,
                type, watch_activity_type, watch_normalized_type
         FROM runs
         WHERE user_id = ? AND date >= ? AND ${runActivitySql()}
         ORDER BY date DESC, created_at DESC`,
        [userId, start42d]
      ).catch((err) => logReadinessQueryFailure('SELECT avg_heart_rate, max_heart_rate, heart_rate_zones, pace_avg, distance_miles, date, created_at, type, watch_activity_type, watch_normalized_type FROM runs WHERE user_id = ? AND date >= ? ORDER BY date DESC, created_at DESC', err, [])),
    ]);

    const runHistory = analyzeRunHistory(recentRuns || [], userRow?.max_heart_rate, { now: today, hrProfile });
    const signals = buildHealthSignals({
      ...(healthRow || {}),
      acute_load_7d: load7d?.miles,
      chronic_load_28d: load28d?.miles,
      run_zone_drift_count: runHistory?.available ? runHistory.driftCount : null,
      run_zone_drift_intent_known: runHistory?.available ? runHistory.hasRunIntent : null,
    });

    if (!signals.available) {
      return res.json({
        available: false,
        score: null,
        band: null,
        verdict: null,
        drivers: [],
        runHistory,
      });
    }

    const { band, verdict } = buildReadinessBand(signals.readinessScore);
    const topFlags = [...signals.flags]
      .sort((a, b) => (FLAG_SEVERITY_RANK[b.severity] || 0) - (FLAG_SEVERITY_RANK[a.severity] || 0))
      .slice(0, 2);
    const drivers = topFlags.map((flag) => flag.reason).filter(Boolean);
    await dbRun(
      `INSERT INTO readiness_scores (id, user_id, score_date, score, band, drivers)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, score_date) DO UPDATE SET
         score = EXCLUDED.score,
         band = EXCLUDED.band,
         drivers = EXCLUDED.drivers`,
      [uuidv4(), userId, today.toISOString().slice(0, 10), signals.readinessScore, band, JSON.stringify(drivers)]
    );
    return res.json({
      available: true,
      score: signals.readinessScore,
      band,
      verdict,
      drivers,
      runHistory,
    });
  } catch (err) {
    console.error('[recovery/readiness] failed:', err);
    return res.status(500).json({ error: 'Failed to fetch recovery readiness' });
  }
});

router.get('/readiness/history', auth, requirePremium('Recovery readiness'), async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query?.days || 14)));
    const rows = await dbAll(
      `SELECT score_date, score, band, drivers
       FROM readiness_scores
       WHERE user_id = ?
       ORDER BY score_date DESC
       LIMIT ?`,
      [req.user.id, days]
    );
    res.json({
      days: rows.map((row) => ({
        date: row.score_date,
        score: Number(row.score),
        band: row.band,
        drivers: Array.isArray(row.drivers) ? row.drivers : (() => {
          try { return JSON.parse(row.drivers || '[]'); } catch { return []; }
        })(),
      })),
    });
  } catch (err) {
    console.error('[recovery/readiness/history] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch readiness history' });
  }
});

// ── Data fetchers ────────────────────────────────────────────────────────────

async function fetchGarminData(userId, startDate) {
  try {
    return await dbAll(
      `SELECT calendar_date, deep_sleep_seconds, light_sleep_seconds, rem_sleep_seconds, awake_seconds
       FROM garmin_sleep
       WHERE user_id = ? AND calendar_date >= ?
       ORDER BY calendar_date DESC`,
      [userId, startDate]
    ) || [];
  } catch {
    return [];
  }
}

async function fetchWhoopData(userId, startDate) {
  try {
    return await dbAll(
      `SELECT date, data_type,
              recovery_score, resting_heart_rate, hrv_rmssd, spo2_pct, skin_temp_celsius,
              strain_score, kilojoules, avg_heart_rate, max_heart_rate,
              sleep_performance_pct, sleep_consistency_pct, sleep_efficiency_pct,
              total_sleep_seconds, rem_sleep_seconds, deep_sleep_seconds, light_sleep_seconds, awake_seconds
       FROM whoop_data
       WHERE user_id = ? AND date >= ?
       ORDER BY date DESC`,
      [userId, startDate]
    ) || [];
  } catch {
    return [];
  }
}

async function fetchOuraData(userId, startDate) {
  try {
    return await dbAll(
      `SELECT date, data_type,
              sleep_score, total_sleep_seconds, rem_sleep_seconds, deep_sleep_seconds,
              light_sleep_seconds, awake_seconds, sleep_efficiency, sleep_latency_seconds,
              readiness_score, readiness_temperature_deviation, readiness_hrv_balance,
              readiness_body_temperature, readiness_resting_heart_rate,
              hrv_avg, hrv_max, hrv_min, body_temperature_deviation
       FROM oura_data
       WHERE user_id = ? AND date >= ?
       ORDER BY date DESC`,
      [userId, startDate]
    ) || [];
  } catch {
    return [];
  }
}

async function fetchAppleHealthSleep(userId, startDate) {
  try {
    return await dbAll(
      `SELECT synced_at, activity_name, duration_seconds,
              SUBSTR(synced_at, 1, 10) as date
       FROM watch_sync
       WHERE user_id = ? AND synced_at >= ?
         AND (LOWER(normalized_type) LIKE '%sleep%' OR LOWER(activity_type) LIKE '%sleep%')
       ORDER BY synced_at DESC`,
      [userId, startDate]
    ) || [];
  } catch {
    return [];
  }
}

module.exports = router;
