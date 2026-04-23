const router = require('express').Router();
const { dbAll, dbGet } = require('../db');
const auth = require('../middleware/auth');
const { requirePremium } = require('../middleware/premiumGate');

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
    // Apple Health is always implicitly available via watch_sync
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
