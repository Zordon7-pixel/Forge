const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth   = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { generateRunFeedback, generateLoadWarning } = require('../services/ai');
const autoUpdatePRs = require('../services/prAuto');
const {
  DISTANCE_CONFIG,
  normalizeSex,
  getAgeBracket,
  equivalentRaceSeconds,
  computeAgeGradedScore,
  getCompetitiveTier,
} = require('../lib/ageGrading');
const { buildHealthSignals } = require('../lib/healthSignals');

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
  const paceSec = seconds / distanceMiles;
  const m = Math.floor(paceSec / 60);
  const s = Math.round(paceSec % 60);
  return `${m}:${String(s).padStart(2, '0')}/mi`;
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
    res.json({ runs });
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
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?', [req.user.id, thisWeekStart, thisWeekEnd]),
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?', [req.user.id, lastWeekStart, thisWeekStart]),
      dbAll('SELECT date, perceived_effort FROM runs WHERE user_id=? AND date>=? AND date<? ORDER BY date ASC', [req.user.id, thisWeekStart, thisWeekEnd])
    ]);

    const thisWeekMiles = Number(twRow?.miles || 0);
    const lastWeekMiles = Number(lwRow?.miles || 0);
    const increasePercent = lastWeekMiles > 0 ? ((thisWeekMiles - lastWeekMiles) / lastWeekMiles) * 100 : (thisWeekMiles > 0 ? 100 : 0);

    let hardStreak = 0, maxHardStreak = 0;
    for (const r of runs) {
      if (Number(r.perceived_effort || 0) >= 7) { hardStreak++; maxHardStreak = Math.max(maxHardStreak, hardStreak); }
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

router.get('/next-recommendation', auth, async (req, res) => {
  try {
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
    const [recentRuns, thisWeekRow, lastWeekRow, recentPrRow, healthRow, checkinRow] = await Promise.all([
      dbAll('SELECT date, distance_miles, duration_seconds FROM runs WHERE user_id=? AND date>=? AND date<? ORDER BY date DESC, created_at DESC', [req.user.id, fourteenDaysAgoStr, todayExclusiveStr]),
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles, COUNT(*) as count FROM runs WHERE user_id=? AND date>=? AND date<?', [req.user.id, thisWeekStart.toISOString().slice(0, 10), nextWeekStart.toISOString().slice(0, 10)]),
      dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?', [req.user.id, lastWeekStart.toISOString().slice(0, 10), thisWeekStart.toISOString().slice(0, 10)]),
      dbGet('SELECT label, achieved_at FROM personal_records WHERE user_id=? AND achieved_at>=? ORDER BY achieved_at DESC LIMIT 1', [req.user.id, new Date(today.getTime() - (3 * 86400000)).toISOString().slice(0, 10)]),
      dbGet('SELECT * FROM health_sync WHERE user_id=?', [req.user.id]).catch(() => null),
      dbGet('SELECT feeling, time_available, sleep_hours, life_flags FROM daily_checkins WHERE user_id=? AND checkin_date=?', [req.user.id, todayStr]).catch(() => null),
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
      reason = 'You already logged 3+ runs this week. Use today for strength or mobility to support injury prevention.';
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
        reason = `${healthSignals.summary} Forge is switching today to recovery so your next run is higher quality.`;
        suggestedDistance = 0;
        healthAdjusted = true;
      } else if (healthSignals.shouldReduceIntensity && recommendationType !== 'rest' && recommendationType !== 'strength') {
        recommendationType = 'easy_run';
        reason = `${healthSignals.summary} Forge lowered this to an easy aerobic run.`;
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
        reason = `${checkinSignals.summary} Forge is switching today to recovery.`;
        suggestedDistance = 0;
        checkinAdjusted = true;
      } else if (checkinSignals.shouldReduceIntensity && recommendationType !== 'rest' && recommendationType !== 'strength') {
        recommendationType = 'easy_run';
        reason = `${checkinSignals.summary} Forge lowered this to an easy controlled run.`;
        suggestedDistance = Number(Math.max(1, suggestedDistance * 0.75).toFixed(1));
        checkinAdjusted = true;
      }

      if (checkinSignals.timeAvailable !== null && checkinSignals.timeAvailable <= 30 && recommendationType !== 'rest' && recommendationType !== 'strength') {
        const paceSeconds = avgPaceSeconds || 600;
        const maxDistanceByTime = Math.max(1, (checkinSignals.timeAvailable * 60) / paceSeconds);
        if (suggestedDistance > maxDistanceByTime) {
          suggestedDistance = Number(maxDistanceByTime.toFixed(1));
          reason = `${checkinSignals.summary} Forge capped the run to fit your available time.`;
          checkinAdjusted = true;
        }
      }
    }

    if (recommendationType === 'strength' || recommendationType === 'rest') {
      res.json({
        recommendationType,
        reason,
        suggestedDistance: 0,
        suggestedPace: '--',
        targetZone: recommendationType === 'rest' ? 'Recovery' : 'Strength',
        intensity: recommendationType === 'rest' ? 'Rest' : 'Strength support',
        progression: recommendationType === 'rest' ? 'Recovery day — no run target today.' : 'Lift or mobility day to support the next run.',
        steps: recommendationType === 'rest' ? ['Walk or mobility only if it helps you feel better'] : ['Warm up', 'Strength session', 'Mobility cooldown'],
        healthAdjusted,
        healthSignals,
        checkinAdjusted,
        checkinSignals,
      });
      return;
    }

    const details = detailsForRecommendation(recommendationType, suggestedPace);
    res.json({
      recommendationType,
      reason,
      suggestedDistance,
      suggestedPace,
      ...details,
      healthAdjusted,
      healthSignals,
      checkinAdjusted,
      checkinSignals,
    });
  } catch (err) {
    res.status(500).json({ error: 'Recommendation failed' });
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
         WHERE user_id=? AND date>=? AND duration_seconds>0 AND distance_miles>0
         ORDER BY date DESC`,
        [req.user.id, since365]
      ),
      dbAll(
        `SELECT r.user_id, r.date, r.distance_miles, r.duration_seconds, u.age, u.sex
         FROM runs r
         INNER JOIN users u ON u.id = r.user_id
         WHERE u.age>=40 AND r.date>=? AND r.duration_seconds>0 AND r.distance_miles>0`,
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

router.post('/', auth, async (req, res) => {
  try {
    const {
      date, type, distance_miles, duration_seconds, perceived_effort, notes, run_surface, surface,
      incline_pct, treadmill_speed, route_coords, watch_mode,
      avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones, cadence_spm,
      elevation_gain, elevation_loss, pace_avg, pace_splits,
      vo2_max, training_effect_aerobic, training_effect_anaerobic, recovery_time_hours,
      detected_surface_type, temperature_f, calories, treadmill_brand, treadmill_model,
      watch_sync_id, watch_activity_type, watch_normalized_type, gps_available
    } = req.body;
    if (!date || !type) return res.status(400).json({ error: 'date and type required' });
    if (perceived_effort !== undefined && perceived_effort !== null) {
      const pe = Number(perceived_effort);
      if (!Number.isFinite(pe) || pe < 1 || pe > 10) {
        return res.status(400).json({ error: 'perceived_effort must be between 1 and 10' });
      }
    }

    const id = uuidv4();
    const resolvedSurface = surface || run_surface || 'road';
    await dbRun(`INSERT INTO runs (
      id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes,
      run_surface, surface, incline_pct, treadmill_speed, route_coords, watch_mode,
      avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones,
      cadence_spm, elevation_gain, elevation_loss, pace_avg, pace_splits,
      vo2_max, training_effect_aerobic, training_effect_anaerobic, recovery_time_hours,
      detected_surface_type, temperature_f, calories, treadmill_brand, treadmill_model,
      watch_sync_id, watch_activity_type, watch_normalized_type, gps_available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, req.user.id, date, type, distance_miles || 0, duration_seconds || 0, perceived_effort || 5, notes || null,
      resolvedSurface, resolvedSurface, incline_pct || 0, treadmill_speed || 0, JSON.stringify(route_coords || []), watch_mode || null,
      avg_heart_rate || null, max_heart_rate || null, min_heart_rate || null, JSON.stringify(heart_rate_zones || []),
      cadence_spm || null, elevation_gain || null, elevation_loss || null, pace_avg || null, JSON.stringify(pace_splits || []),
      vo2_max || null, training_effect_aerobic || null, training_effect_anaerobic || null, recovery_time_hours || null,
      detected_surface_type || null, temperature_f || null, calories || 0, treadmill_brand || null, treadmill_model || null,
      watch_sync_id || null, watch_activity_type || null, watch_normalized_type || null, gps_available === false ? 0 : 1
    ]);

    const userProfile = await dbGet('SELECT weight_lbs FROM users WHERE id=?', [req.user.id]);
    const weightLbs = userProfile?.weight_lbs || 185;
    const computedCalories = Math.round(0.75 * weightLbs * (distance_miles || 0));
    const resolvedCalories = Number(calories || 0) > 0 ? Number(calories) : computedCalories;
    if (resolvedCalories > 0) {
      await dbRun('UPDATE runs SET calories=? WHERE id=? AND user_id=?', [resolvedCalories, id, req.user.id]);
    }

    if ((duration_seconds || 0) > 0 && (distance_miles || 0) > 0) {
      const durationHours = (duration_seconds || 0) / 3600;
      const paceMinsPerMile = ((duration_seconds || 0) / 60) / (distance_miles || 1);
      const met = paceMinsPerMile < 8 ? 12.0 : paceMinsPerMile <= 10 ? 10.0 : 8.0;
      const weightKg = weightLbs / 2.205;
      const calories_burned = Math.round(met * weightKg * durationHours);
      if (calories_burned > 0) {
        await dbRun('UPDATE runs SET calories_burned=? WHERE id=? AND user_id=?', [calories_burned, id, req.user.id]);
      }
    }

    const run = await dbGet('SELECT * FROM runs WHERE id = ?', [id]);

    let prResult = { newPRs: [], discrepancies: [] };
    try { prResult = await autoUpdatePRs(req.user.id, run) || prResult; } catch (e) { console.error('PR auto-detect:', e); }

    res.status(201).json({ run, newPRs: prResult.newPRs, discrepancies: prResult.discrepancies });

    // Fire and forget AI feedback
    try {
      const today = new Date().toISOString().slice(0, 10);
      const month = new Date().toISOString().slice(0, 7);
      const [dailyRow, userRow] = await Promise.all([
        dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?", [req.user.id, today + 'T00:00:00']),
        dbGet("SELECT is_pro FROM users WHERE id = ?", [req.user.id])
      ]);
      const dailyCount = Number(dailyRow?.cnt || 0);
      const monthlyRow = !userRow?.is_pro
        ? await dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?", [req.user.id, month + '-01T00:00:00'])
        : null;
      const monthlyCount = Number(monthlyRow?.cnt || 0);
      const canCallAI = dailyCount < 10 && (userRow?.is_pro || monthlyCount < 5);
      if (canCallAI) {
        await dbRun("INSERT INTO ai_usage (id, user_id, call_type) VALUES (?, ?, ?)", [uuidv4(), req.user.id, 'run_feedback']);
        const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
        generateRunFeedback(run, profile).then(async feedback => {
          if (feedback) await dbRun('UPDATE runs SET ai_feedback = ? WHERE id = ? AND user_id = ?', [feedback, id, req.user.id]);
        }).catch(() => {});
      }
    } catch (e) { console.error('AI usage tracking failed:', e); }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Failed to save run' });
  }
});

async function updateRunHandler(req, res) {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const { date, distance_miles, duration_seconds, notes, perceived_effort, type, run_surface, incline_pct, treadmill_speed, pain_level, post_energy } = req.body;
    const validPainLevels = ['none', 'mild', 'moderate', 'severe'];
    const validEnergyLevels = ['low', 'medium', 'high'];

    if (pain_level !== undefined && pain_level !== null && !validPainLevels.includes(String(pain_level))) {
      return res.status(400).json({ error: 'Invalid pain_level' });
    }
    if (post_energy !== undefined && post_energy !== null && !validEnergyLevels.includes(String(post_energy))) {
      return res.status(400).json({ error: 'Invalid post_energy' });
    }

    const userProfile = await dbGet('SELECT weight_lbs FROM users WHERE id=?', [req.user.id]);
    const weightLbs = userProfile?.weight_lbs || 185;
    const newDist = distance_miles !== undefined ? Number(distance_miles) : run.distance_miles;
    const calories = Math.round(0.75 * weightLbs * newDist);

    await dbRun(`UPDATE runs SET
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
      calories = ?
      WHERE id=? AND user_id=?`, [
      date ?? null, distance_miles ?? null, duration_seconds ?? null,
      notes ?? null, perceived_effort ?? null, type ?? null,
      run_surface ?? null, incline_pct ?? null, treadmill_speed ?? null,
      pain_level ?? null, post_energy ?? null,
      calories, req.params.id, req.user.id
    ]);

    const updated = await dbGet('SELECT * FROM runs WHERE id=?', [req.params.id]);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
}

router.put('/:id', auth, updateRunHandler);
router.patch('/:id', auth, updateRunHandler);

router.post('/:id/feedback', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    if (run.ai_feedback) return res.json({ feedback: run.ai_feedback });

    const profile = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const [dailyRow, monthlyRow] = await Promise.all([
      dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id=? AND created_at>=?", [req.user.id, today]),
      dbGet("SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id=? AND created_at>=?", [req.user.id, monthStart])
    ]);
    const canCallAI = Number(dailyRow?.cnt || 0) < 10 && (profile?.is_pro || Number(monthlyRow?.cnt || 0) < 5);
    if (!canCallAI) return res.status(429).json({ error: 'AI limit reached for today.' });

    await dbRun('INSERT INTO ai_usage (id, user_id, call_type) VALUES (?,?,?)', [uuidv4(), req.user.id, 'run_feedback']);
    const feedback = await generateRunFeedback(run, profile);
    if (feedback) await dbRun('UPDATE runs SET ai_feedback=? WHERE id=?', [feedback, run.id]);
    res.json({ feedback: feedback || 'Could not generate feedback right now.' });
  } catch (err) { res.status(500).json({ error: 'Feedback failed' }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
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
