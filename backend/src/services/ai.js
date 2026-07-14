const crypto = require('crypto');
const { trustedCourseFacts } = require('../lib/concurrentPlan');

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_RESPONSES_TIMEOUT_MS = 75_000;
const AI_MODELS = {
  frequent: process.env.OPENAI_MODEL_FREQUENT || 'gpt-5.4-mini',
  complex: process.env.OPENAI_MODEL_COMPLEX || 'gpt-5.5',
};

function mapLegacyModel(model = '') {
  const key = String(model || '').toLowerCase();
  return key === 'complex' || key.includes('sonnet') ? AI_MODELS.complex : AI_MODELS.frequent;
}

function extractOutputText(data = {}) {
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

async function createOpenAIResponse({ model, max_tokens, messages }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const input = Array.isArray(messages)
    ? messages.map((message) => ({
      role: message.role === 'user' ? 'user' : 'developer',
      content: String(message.content || ''),
    }))
    : [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_RESPONSES_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: mapLegacyModel(model),
        input,
        max_output_tokens: max_tokens,
        store: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI response failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const data = await response.json();
    return { content: [{ text: extractOutputText(data) }] };
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      const timeoutError = new Error(`OpenAI Responses request timed out after ${OPENAI_RESPONSES_TIMEOUT_MS / 1000} seconds`);
      timeoutError.code = 'OPENAI_RESPONSES_TIMEOUT';
      console.error('[AI/OpenAI] request aborted:', timeoutError.message);
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

let client;
function getClient() {
  if (!client) {
    client = {
      messages: {
        create: createOpenAIResponse,
      },
    };
  }
  return client;
}

// Strip newlines and limit length to prevent prompt injection via user-controlled fields
function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

// Deep-sanitize all string values in an object/array before prompt interpolation
function sanitizeObj(obj, maxLen = 200) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitize(obj, maxLen);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(item => sanitizeObj(item, maxLen));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitizeObj(v, maxLen);
    return out;
  }
  return obj;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function resolvePlanFrequency(profile = {}, target = null) {
  const profileRunDays = clampInt(profile.run_days_per_week, 1, 7, 3);
  const profileLiftDays = clampInt(profile.lift_days_per_week, 0, 7, 2);
  const hasRunOverride = target && Object.prototype.hasOwnProperty.call(target, 'runDaysPerWeek') && target.runDaysPerWeek !== undefined;
  const hasLiftOverride = target && Object.prototype.hasOwnProperty.call(target, 'liftDaysPerWeek') && target.liftDaysPerWeek !== undefined;
  const liftingExplicitlyDisabled = target?.liftingEnabled === false;
  const liftingEnabled = liftingExplicitlyDisabled ? false : (target?.liftingEnabled === true || profileLiftDays > 0);

  return {
    runDaysPerWeek: hasRunOverride ? clampInt(target.runDaysPerWeek, 1, 7, profileRunDays) : profileRunDays,
    liftDaysPerWeek: liftingEnabled
      ? (hasLiftOverride ? clampInt(target.liftDaysPerWeek, 0, 7, profileLiftDays) : profileLiftDays)
      : 0,
    liftingEnabled,
    liftingExplicitlyDisabled,
  };
}

function normalizeTrainingDays(raw) {
  if (!Array.isArray(raw)) return [];
  const byKey = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
  return [...new Set(raw
    .map((day) => byKey[String(day || '').trim().slice(0, 3).toLowerCase()])
    .filter(Boolean))];
}

const aiCache = new Map();
const TTL = {
  runBrief: 4 * 60 * 60 * 1000,
  workoutRecommendation: 4 * 60 * 60 * 1000,
  liftPlan: 60 * 60 * 1000,
  sessionFeedback: Infinity,
  loadWarning: 2 * 60 * 60 * 1000,
  weeklyInsight: 6 * 60 * 60 * 1000,
  substitute: 4 * 60 * 60 * 1000,
  recoveryAdjustment: 24 * 60 * 60 * 1000,
};

function makeCacheKey(prefix, payload) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
  return `${prefix}:${hash}`;
}

function getCached(cacheKey) {
  const hit = aiCache.get(cacheKey);
  if (!hit) return null;
  if (hit.expiresAt !== Infinity && Date.now() > hit.expiresAt) {
    aiCache.delete(cacheKey);
    return null;
  }
  console.log('[AI Cache] hit for', cacheKey);
  return hit.value;
}

function setCached(cacheKey, value, ttlMs) {
  aiCache.set(cacheKey, {
    value,
    expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs,
  });
}

async function generateTrainingPlan(profile, target = null, trainingContext = null) {
  const minimumWeeks = target?.raceDate ? 1 : 4;
  const weeks = Math.max(minimumWeeks, Math.min(20, Number(target?.weeks) || 4));
  const frequency = resolvePlanFrequency(profile, target);
  const requestedMode = String(target?.planMode || '').toLowerCase();
  const planMode = ['run_only', 'hybrid_maintain', 'hybrid_build'].includes(requestedMode)
    ? requestedMode
    : frequency.liftingExplicitlyDisabled ? 'run_only' : 'hybrid_maintain';
  const trainingDays = normalizeTrainingDays(target?.trainingDays);
  const trainingDaysLine = trainingDays.length
    ? `\n- Actual available training weekdays: ${trainingDays.join(', ')}. Schedule non-rest sessions only on these weekdays unless unavoidable for race-week taper.`
    : '';
  const equipment = Array.isArray(target?.equipment)
    ? [...new Set(target.equipment
      .slice(0, 8)
      .map((item) => sanitize(item, 30).replace(/_/g, ' '))
      .filter(Boolean))]
    : [];
  const equipmentLine = equipment.length ? equipment.join(', ') : 'barbell, dumbbell, rack, bench';
  const sessionCountRule = trainingDays.length
    ? '- Schedule non-rest sessions only on the listed available training weekdays; do not add sessions on other days to satisfy a minimum session count.'
    : '- Include at least 6 training sessions each week (non-rest days)';
  const liftingRules = planMode === 'run_only'
    ? `- This is a RUN-ONLY plan: include zero lifting, strength, weighted circuit, kettlebell, rucking, sled, or hybrid cross-training sessions.
- Use only running workouts and rest/recovery days.`
    : `- Include ${Math.max(1, frequency.liftDaysPerWeek)} real strength sessions per week using only this available equipment: ${equipmentLine}. Do not prescribe equipment outside this list; do not use circuits, rucking, sleds, cross_train, or generic injury-prevention sessions.
- Every strength session requires focus, warmup, main exercises, recovery, and progression. Every exercise requires name, sets, reps, rest, load, rpe or rir, cue, and progression.
- Use whole-number working sets from 1-6. Default to 2-3 minutes of rest for compound lifts and 60-90 seconds for accessories unless the exercise has a specific reason to differ.
- A numeric pound load is allowed only when the recent lifting detail contains a matching exercise with a usable load/reps pair. Otherwise prescribe load by RPE/RIR and say that the athlete must calibrate it. Apple Health may adjust volume and effort, but it cannot estimate a barbell or dumbbell load.
- ${planMode === 'hybrid_build' ? 'Use meaningful hypertrophy/strength volume while preserving run quality.' : 'Use submaximal volume that maintains strength and size.'}`;
  const schedulingRule = planMode === 'run_only'
    ? '- Keep run scheduling sensible and preserve recovery days.'
    : '- Never place lower-body strength on the same day as or one day before/after a hard, long, hill, interval, threshold, or race run. A same-day easy run plus strength requires orderGuidance.';
  const goalDesc = {
    comeback:      'returning from injury, needs conservative build-up',
    race:          `training for a ${profile.goal_race_distance || 'race'} on ${profile.goal_race_date || 'an upcoming date'}`,
    fitness:       'building general running fitness',
    base_building: 'building aerobic base mileage',
  }[profile.goal_type] || 'building fitness';

  const scheduleInfo = profile.schedule_type ? `
- Schedule style: ${sanitize(profile.schedule_type, 30)} (flexible/structured/adaptive)
- Lifestyle: ${sanitize(profile.lifestyle, 30) || 'works_fulltime'}
- Preferred workout time: ${sanitize(profile.preferred_workout_time, 30) || 'evening'}
- Preferred workout days per week: ${Number(profile.weekly_workout_days) || 4}
- If missed workout: ${sanitize(profile.missed_workout_pref, 30) || 'adjust_week'}` : '';

  const raceGoalTime = target?.goalTimeSeconds
    ? `, goal finish ${Math.floor(target.goalTimeSeconds/3600)}h${String(Math.floor((target.goalTimeSeconds%3600)/60)).padStart(2,'0')}m`
    : '';
  const raceTargetLine = target?.raceDate || target?.distanceMiles
    ? `- Race target override: ${target.distanceMiles ? `${target.distanceMiles} miles` : 'race'} on ${target.raceDate || 'upcoming date'}${raceGoalTime}`
    : '';
  const courseTrust = trustedCourseFacts(target || {});
  const elevationGainFt = courseTrust.trusted ? Number(courseTrust.facts.elevationGainFt) : NaN;
  const distanceMiles = Number(target?.distanceMiles ?? target?.distance_miles);
  const maxAltitudeFt = courseTrust.trusted ? Number(courseTrust.facts.maxAltitudeFt) : NaN;
  const courseHilly = Number.isFinite(elevationGainFt) && elevationGainFt > 0
    ? (Number.isFinite(distanceMiles) && distanceMiles > 0 ? (elevationGainFt / distanceMiles) >= 30 : elevationGainFt >= 800)
    : false;
  const courseHighAltitude = Number.isFinite(maxAltitudeFt) && maxAltitudeFt >= 5000;
  const courseInstructions = [
    courseHilly ? `- Course is hilly (~${Math.round(elevationGainFt)}ft gain) — include weekly hill repeats / strength-endurance work and hill-specific long runs.` : '',
    courseHighAltitude ? `- Race is at altitude (~${Math.round(maxAltitudeFt)}ft) — add an altitude-prep note and advise arriving early / adjusting pace expectations.` : '',
    !courseTrust.trusted ? '- Course details are unverified or stale. Use distance-only programming; do not infer course elevation, terrain, altitude, or course-specific demands from the race name.' : '',
  ].filter(Boolean).join('\n');

  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(target?.startDate || '')) ? target.startDate : '';
  const raceName = sanitize(target?.raceName || 'Training target', 80);
  const observed = trainingContext?.history || {};
  const observedMileage = Number(observed.weeklyMileageBaseline);
  const adherence = Number(observed.adherenceRate);
  const recentRunLoad = observed.acuteRunLoad || {};
  const latestRun = recentRunLoad.latestRun || null;
  const recentRunLine = latestRun
    ? `${Number(latestRun.distanceMiles || 0).toFixed(1)} miles on ${sanitize(latestRun.date, 10)}${latestRun.durationMinutes ? ` in ${Math.round(Number(latestRun.durationMinutes))} min` : ''}${latestRun.paceLabel ? ` (${sanitize(latestRun.paceLabel, 20)})` : ''}${latestRun.avgHeartRate ? `, avg HR ${Math.round(Number(latestRun.avgHeartRate))}` : ''}${latestRun.perceivedEffort ? `, RPE ${Number(latestRun.perceivedEffort)}` : ''}`
    : 'none available';
  const protection = recentRunLoad.protection || {};
  const healthMetrics = trainingContext?.recovery?.metrics || {};
  const checkin = trainingContext?.checkin || null;
  const numericMetric = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;
  const readinessMetric = numericMetric(trainingContext?.recovery?.readinessScore);
  const sleepMetric = numericMetric(healthMetrics.sleepHoursLastNight);
  const sleepBaselineMetric = numericMetric(healthMetrics.sleepHours7dBaseline);
  const hrvMetric = numericMetric(healthMetrics.hrvMs);
  const hrvBaselineMetric = numericMetric(healthMetrics.hrvMsBaseline);
  const restingHrMetric = numericMetric(healthMetrics.restingHeartRate);
  const restingHrBaselineMetric = numericMetric(healthMetrics.restingHeartRateBaseline);
  const healthFreshness = healthMetrics.freshness || {};
  const freshMetric = (key, value) => healthFreshness[key] === false ? null : numericMetric(value);
  const cardioFitnessLine = [
    ['VO2 max', freshMetric('vo2Max', healthMetrics.vo2Max), 'ml/kg/min'],
    ['1-min HR recovery', freshMetric('heartRateRecovery', healthMetrics.heartRateRecoveryOneMinute), 'bpm'],
    ['respiratory rate', freshMetric('respiratoryRate', healthMetrics.respiratoryRate), '/min'],
  ].filter(([, value]) => value !== null).map(([label, value, unit]) => `${label} ${value}${unit}`).join(', ') || 'not available';
  const activityLine = [
    ['active minutes', freshMetric('activity', healthMetrics.activeMinutesThisWeek)],
    ['exercise minutes', freshMetric('activity', healthMetrics.exerciseMinutesThisWeek)],
    ['workouts', freshMetric('activity', healthMetrics.workoutCountThisWeek)],
  ].filter(([, value]) => value !== null).map(([label, value]) => `${label} ${value}`).join(', ') || 'not available';
  const runningFormLine = [
    ['power', freshMetric('runningDynamics', healthMetrics.runningPowerWatts), 'W'],
    ['speed', freshMetric('runningDynamics', healthMetrics.runningSpeedMps), 'm/s'],
    ['stride', freshMetric('runningDynamics', healthMetrics.runningStrideLengthM), 'm'],
    ['vertical oscillation', freshMetric('runningDynamics', healthMetrics.runningVerticalOscillationCm), 'cm'],
    ['ground contact', freshMetric('runningDynamics', healthMetrics.runningGroundContactTimeMs), 'ms'],
  ].filter(([, value]) => value !== null).map(([label, value, unit]) => `${label} ${value}${unit}`).join(', ') || 'not available';
  const recentRunSafetyRule = protection.active
    ? `- A run is already logged on ${sanitize(protection.noAdditionalRunOnDate, 10) || 'the protected date'}. Do not schedule another run that day. Do not schedule demanding running through ${sanitize(protection.hardRunsThrough, 10)} or lower-body strength through ${sanitize(protection.lowerBodyThrough, 10)}; preserve these recent-run safety windows exactly.`
    : '- No recent-run protection window is active.';
  const checkinLine = checkin
    ? `feeling ${Number(checkin.feeling || 0) || 'unknown'}/5, legs ${Number(checkin.legs || 0) || 'unknown'}/3, drive ${Number(checkin.drive || 0) || 'unknown'}/3${checkin.sleepHours ? `, ${Number(checkin.sleepHours)}h subjective sleep` : ''}${Array.isArray(checkin.lifeFlags) && checkin.lifeFlags.length ? `, flags: ${checkin.lifeFlags.map((flag) => sanitize(flag, 24)).join(', ')}` : ''}`
    : 'none recorded today';
  const recentExerciseLine = Array.isArray(observed.recentExercises) && observed.recentExercises.length
    ? observed.recentExercises.slice(0, 8).map((exercise) => {
      const name = sanitize(exercise?.name, 60) || 'exercise';
      const latestWeight = Number(exercise?.latestWeightLbs);
      const latestReps = Number(exercise?.latestReps);
      const latestDate = sanitize(exercise?.latestLoggedAt, 10);
      const recentSet = Number.isFinite(latestWeight) && latestWeight > 0 && Number.isFinite(latestReps) && latestReps > 0
        ? `latest usable set ${latestWeight} lb x ${latestReps}${latestDate ? ` on ${latestDate}` : ''}`
        : 'no usable load/reps pair';
      return `${name}: ${Math.max(0, Number(exercise?.sets || 0))} logged sets, ${recentSet}`;
    }).join('; ')
    : 'no recent logged exercise-set detail';
  const prompt = `You are an expert hybrid runner/lifter coach who specializes in concurrent training (runners who also lift). Create a ${weeks}-week PERIODIZED canonical plan for this athlete:
- Name: ${sanitize(profile.name, 50)}
- Current weekly miles: ${Number(profile.weekly_miles_current) || 0}
- Goal: ${goalDesc}
- Required plan mode: ${planMode}
- First week starts Monday: ${startDate || 'derive from the supplied target'}
- Run days per week: ${frequency.runDaysPerWeek}
- Lift days per week: ${frequency.liftDaysPerWeek}${trainingDaysLine}
- Observed weekly mileage from recent activity: ${Number.isFinite(observedMileage) ? observedMileage.toFixed(1) : 'unknown'}
- Recent completed runs/lifts: ${Math.max(0, Number(observed.recentRunCount || 0))}/${Math.max(0, Number(observed.recentLiftCount || 0))}
- Latest meaningful run: ${recentRunLine}; trailing 7-day miles: ${Number(recentRunLoad.sevenDayMiles || 0).toFixed(1)}
- Recent adherence: ${Number.isFinite(adherence) ? `${Math.round(adherence * 100)}%` : 'unknown'}; missed sessions estimate: ${Math.max(0, Number(observed.missedWorkouts || 0))}
- Current recovery state: ${sanitize(trainingContext?.recovery?.state || 'unknown', 20)}
- Apple Health recovery: readiness ${readinessMetric ?? 'unknown'}, sleep ${sleepMetric === null ? 'unknown' : `${sleepMetric}h`}${sleepBaselineMetric === null ? '' : ` vs ${sleepBaselineMetric}h baseline`}, HRV ${hrvMetric === null ? 'unknown' : `${hrvMetric}ms`}${hrvBaselineMetric === null ? '' : ` vs ${hrvBaselineMetric}ms baseline`}, resting HR ${restingHrMetric ?? 'unknown'}${restingHrBaselineMetric === null ? '' : ` vs ${restingHrBaselineMetric} baseline`}
- Apple Health activity this week: ${activityLine}
- Apple Health cardio context: ${cardioFitnessLine}
- Latest Apple Watch running-form context: ${runningFormLine}
- Today's check-in: ${checkinLine}
- Recent lifting detail: ${recentExerciseLine}
- Injury notes: ${sanitize(profile.injury_notes) || 'none'}
- Comeback mode: ${profile.comeback_mode ? 'YES — be very conservative, no speed work for first 2 weeks' : 'no'}
${raceTargetLine}${courseInstructions ? `\n${courseInstructions}` : ''}${scheduleInfo}

Return ONLY valid JSON in this exact format, no other text:
{
  "schemaVersion": 2,
  "planMode": "${planMode}",
  "goal": {"kind":"${target?.raceDate ? 'race' : 'training_block'}","name":${JSON.stringify(raceName)},"date":${target?.raceDate ? JSON.stringify(sanitize(target.raceDate, 10)) : 'null'},"distanceMiles":${Number(target?.distanceMiles) || 6.2},"goalType":"${target?.goalTimeSeconds ? 'pr' : 'completion'}","goalTimeSeconds":${Number(target?.goalTimeSeconds) || 'null'}},
  "strengthPolicy": {"enabled":${planMode !== 'run_only'},"goal":"${planMode === 'hybrid_build' ? 'build' : planMode === 'hybrid_maintain' ? 'maintain' : 'none'}","sessionsPerWeek":${planMode === 'run_only' ? 0 : Math.max(1, frequency.liftDaysPerWeek)},"minimumSessionsPerWeek":${planMode === 'run_only' ? 0 : Math.min(2, Math.max(1, frequency.liftDaysPerWeek))}},
  "weeks": [{"week":1,"phase":"base","startDate":"${startDate || 'YYYY-MM-DD'}","totalMiles":0,"days":[{"date":"${startDate || 'YYYY-MM-DD'}","day":"Mon","sessions":[{"id":"w1-mon-run","kind":"run","type":"easy","workout_type":"run","title":"Easy aerobic run","distance_miles":3,"pace_target":"Conversational effort","target_zone":"Zone 2","intensity":"Easy","warmup":["5 min easy"],"steps":["Hold conversational effort"],"cooldown":["5 min walk"],"progression":"Add time before pace","description":"Aerobic development"}],"status":"planned"}]}]
}
Rules:
${sessionCountRule}
${liftingRules}
- Each week has exactly seven dated Mon-Sun day objects and each day has zero, one, or two sessions. Empty sessions means rest.
- Every session id is stable and globally unique. Run fields must be complete like the example.
- Keep at least 1 full rest day each week
${schedulingRule}
${recentRunSafetyRule}
- Use Apple Health recovery and recent completed-workout history to adjust workload conservatively. VO2 max and running-form metrics are trend context only; never use one wearable metric by itself to prescribe unsafe volume, pace, or intensity.
- PERIODIZATION over ${weeks} weeks: early weeks = BASE (aerobic volume), middle = BUILD (add tempo/intervals + peak long runs), final 1-2 weeks = TAPER (cut volume 30-50%, keep some intensity, race week is lightest).
- Every 3rd-4th week is a DOWN/recovery week (reduce volume ~20%).
- Increase weekly mileage no more than ~10% week-over-week.
- Distance-appropriate structure: full marathon builds a 18-22mi peak long run; half marathon peaks ~10-12mi; 10-miler/10K peaks ~8-10mi; 5K emphasizes speed over volume.
- Use phases base, build, deload, peak, taper, race. Race date and distance must be preserved exactly.
- The plan MUST contain exactly ${weeks} week objects in the weeks array, numbered 1..${weeks}.`;

  try {
    const res = await getClient().messages.create({
      model: 'complex',
      max_tokens: Math.min(16000, Math.max(4000, weeks * 550)),
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.error('AI plan error:', e.message);
    return null;
  }
}

async function generateRunFeedback(run, profile) {
  const durationMin = Math.round((run.duration_seconds || 0) / 60);
  const pace = run.distance_miles > 0 && durationMin > 0
    ? `${Math.floor(durationMin / run.distance_miles)}:${String(Math.round((durationMin / run.distance_miles % 1) * 60)).padStart(2, '0')}/mi`
    : 'unknown pace';

  const injuryCtx = sanitize(profile.injury_notes) ? `, currently managing: ${sanitize(profile.injury_notes)}` : '';
  const notesCtx = sanitize(run.notes) ? `\nAthlete note: "${sanitize(run.notes)}"` : '';

  const prompt = `You are a sharp, experienced hybrid runner/lifter coach who specializes in concurrent training (runners who also lift) reviewing a training log entry. Write 2-3 sentences of feedback. Sound like a knowledgeable training partner — direct, specific to the numbers, no fluff. Don't open with praise like "Great job" or "Well done". Don't mention weight or BMI. Reference the actual pace and effort.

${run.type} run — ${run.distance_miles} miles in ${durationMin} min (${pace}), effort ${run.perceived_effort}/10${notesCtx}
Context: ${Number(profile.weekly_miles_current) || 0} mi/week base, goal: ${sanitize(profile.goal_type, 30) || 'fitness'}${injuryCtx}

Under 60 words. No headers. No bullet points. If the athlete's recent lifts are heavy (lower body), mention CNS load or leg fatigue when relevant. Talk like someone who lifts AND runs.`;

  try {
    const res = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    return res.content[0].text.trim();
  } catch (e) {
    console.error('AI feedback error:', e.message);
    return null;
  }
}

async function generateWorkoutFeedback(session, sets, profile) {
  try {
    const exerciseMap = {};
    for (const s of sets) {
      if (!exerciseMap[s.exercise_name]) exerciseMap[s.exercise_name] = [];
      exerciseMap[s.exercise_name].push(s);
    }
    const exerciseSummary = Object.entries(exerciseMap)
      .map(([name, exSets]) => `${name}: ${exSets.map(s => `Set ${s.set_number}: ${s.reps} reps @ ${s.weight_lbs} lbs`).join(', ')}`)
      .join('\n');

    const durationMin = session.total_seconds ? Math.round(session.total_seconds / 60) : null;
    const muscleGroups = Array.isArray(session.muscle_groups) ? session.muscle_groups.join(', ') : session.muscle_groups;
    const notesCtx = sanitize(session.notes) ? `\nNotes: ${sanitize(session.notes)}` : '';

    const prompt = `You are an expert hybrid runner/lifter coach who specializes in concurrent training (runners who also lift) reviewing a completed strength session. Write 2-3 sentences of feedback — specific to the exercises and numbers, not generic. End with one concrete suggestion for next time. Sound like a coach who actually looked at the data, not a bot. Don't open with "Great work" or similar.

${durationMin ? `${durationMin} min session` : 'Session'} — ${muscleGroups || 'not specified'}
Exercises: ${exerciseSummary}
Goal: ${sanitize(profile?.goal_type, 30) || 'general fitness'}${notesCtx}

Under 80 words. No headers. No bullet points. Acknowledge how this session affects their running plan over the next 24–48h.`;

    const msg = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text || null;
  } catch (e) {
    console.error('generateWorkoutFeedback error:', e.message);
    return null;
  }
}

async function generateRunBrief({ run, profile, recentRuns, recentLifts, userId }) {
  try {
    const cacheKey = makeCacheKey('run-brief', { userId, run, recentRuns: (recentRuns || []).slice(0, 5), recentLifts: (recentLifts || []).slice(0, 3) });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with keys: why, effort, bpmRange, cadence. Athlete ${sanitize(profile?.name, 50) || 'athlete'} goal ${sanitize(profile?.goal_type, 30) || 'fitness'}. Latest planned/session run: ${JSON.stringify(sanitizeObj(run || {}))}. Recent runs: ${JSON.stringify(sanitizeObj((recentRuns || []).slice(0,5)))}. Recent workouts: ${JSON.stringify(sanitizeObj((recentLifts || []).slice(0,3)))}.`;
    const msg = await getClient().messages.create({ model: 'frequent', max_tokens: 220, messages: [{ role: 'user', content: prompt }] });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.runBrief);
    return result;
  } catch (e) {
    console.error('generateRunBrief error:', e.message);
    return null;
  }
}

async function generateLiftPlan({ bodyPart, timeAvailable, profile, recentSets, recentRuns, userId }) {
  try {
    const cacheKey = makeCacheKey('lift-plan', { userId, bodyPart, timeAvailable, recentSets: (recentSets || []).slice(0, 12), recentRuns: (recentRuns || []).slice(0, 4) });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with keys: workoutName, exercises(array of {name,sets,reps,rest,focus,cue}), estimatedTime.
Build a complete, executable hybrid-athlete lifting session for strength, power, running economy, and speed. Do not return a synopsis in place of exercises.
- Include 4-6 exercises that fit the available time.
- Put the primary strength or power movement first, then unilateral/posterior-chain work, runner-specific accessory work, and trunk stability when appropriate.
- Use practical strength/power prescriptions: low reps for power, moderate reps for strength, higher reps only for accessories.
- Every exercise must have a specific name, numeric sets, reps, rest, a short focus label, and one concise form cue.
- Respect fatigue visible in the recent running and lifting data; do not force lower-body power work when the athlete is not recovered.
Body part: ${sanitize(bodyPart, 50)}. Time available: ${sanitize(timeAvailable, 20)}. Athlete: ${sanitize(profile?.name, 50) || 'athlete'}. Recent sets: ${JSON.stringify(sanitizeObj((recentSets || []).slice(0,12)))}. Recent runs: ${JSON.stringify(sanitizeObj((recentRuns || []).slice(0,4)))}.`;
    const msg = await getClient().messages.create({ model: 'frequent', max_tokens: 650, messages: [{ role: 'user', content: prompt }] });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.liftPlan);
    return result;
  } catch (e) {
    console.error('generateLiftPlan error:', e.message);
    return null;
  }
}

async function generateSessionFeedback({ sessionType, sessionData, profile, userId }) {
  try {
    const cacheKey = makeCacheKey('session-feedback', { userId, sessionType, sessionData });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with these exact keys: analysis, didWell, suggestion, recovery.

Session: ${sanitize(sessionType, 30)}
Goal: ${sanitize(profile?.goal_type, 30) || 'fitness'}
Data: ${JSON.stringify(sessionData || {})}

Rules:
- analysis: 2 sentences — what actually happened in this session and what it means for training. Be specific to the numbers. Sound like a coach, not an app.
- didWell: 1 sentence — call out one specific thing from the data that was genuinely good.
- suggestion: 1 sentence — one concrete, actionable thing for the next session.
- recovery: exactly one of: "easy day", "rest", "can train hard tomorrow"`;
    const msg = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 260,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.sessionFeedback);
    return result;
  } catch (e) {
    console.error('generateSessionFeedback error:', e.message);
    return null;
  }
}

async function generateWorkoutRecommendation({ profile, recentRuns, recentWorkouts, userId }) {
  try {
    const cacheKey = makeCacheKey('workout-recommendation', { userId, recentRuns: (recentRuns || []).slice(0, 5), recentWorkouts: (recentWorkouts || []).slice(0, 5), goal: profile?.goal_type });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with keys: workoutName,target,warmup(array),main(array of {name,sets,reps,rest,focus,cue}),recovery(array),explanation,restExplanation.
Create a complete hybrid-athlete strength and speed session, not a summary of what the athlete should do.
- main must contain 4-6 executable exercises with a specific name, numeric sets, reps, rest, short focus label, and one concise form cue.
- Build strength, force production, running economy, and speed using an appropriate mix of compound strength, unilateral/posterior-chain work, power or plyometrics, calf/ankle work, and trunk stability.
- If recent running or lifting shows lower-body fatigue, reduce impact and shift emphasis instead of forcing jumps or heavy leg work.
- warmup must contain 3 specific movements. recovery must contain 2 specific actions.
- explanation is a separate 1-2 sentence coach rationale based on the athlete's data. Do not place rationale inside main.
- restExplanation briefly explains how to use the listed rest periods.
Athlete: ${sanitize(profile?.name, 50) || 'athlete'}. Goal: ${sanitize(profile?.goal_type, 30) || 'fitness'}. Recent runs: ${JSON.stringify(sanitizeObj((recentRuns || []).slice(0,5)))}. Recent workouts: ${JSON.stringify(sanitizeObj((recentWorkouts || []).slice(0,5)))}.`;
    const msg = await getClient().messages.create({ model: 'frequent', max_tokens: 750, messages: [{ role: 'user', content: prompt }] });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.workoutRecommendation);
    return result;
  } catch (e) {
    console.error('generateWorkoutRecommendation error:', e.message);
    return null;
  }
}

async function generateBodyPartWorkout({ bodyPart, exercise, profile, userId }) {
  try {
    const cacheKey = makeCacheKey('body-part-workout', { userId, bodyPart, exercise, goal: profile?.goal_type });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with keys: workoutName,target,warmup(array),main(array of {name,sets,reps,rest,focus,cue}),recovery(array),explanation,restExplanation.
Build a complete 4-6 exercise hybrid-athlete lifting workout, not a synopsis. Use the selected anchor exercise, then add movements that develop strength, force production, running economy, and speed without redundant volume. Every main exercise needs a specific name, numeric sets, reps, rest, short focus label, and one concise form cue. Keep the 1-2 sentence coaching rationale only in explanation and rest guidance only in restExplanation.
Body part: ${sanitize(bodyPart, 50)}. Anchor exercise: ${sanitize(exercise, 50)}. Athlete: ${sanitize(profile?.name, 50) || 'athlete'}. Goal: ${sanitize(profile?.goal_type, 30) || 'fitness'}.`;
    const msg = await getClient().messages.create({ model: 'frequent', max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.liftPlan);
    return result;
  } catch (e) {
    console.error('generateBodyPartWorkout error:', e.message);
    return null;
  }
}

async function generateLoadWarning(loadData, userId) {
  try {
    const cacheKey = makeCacheKey('load-warning', { userId, loadData });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with keys: warning, recommendation, suggestedAction.
Data: ${JSON.stringify(loadData)}
- warning: 1 sentence, plain language — say what the actual risk is, not just that there is one
- recommendation: 1 sentence — tell them exactly what to do next, not generic advice
- suggestedAction: one of rest|easy_day|reduce_miles|ok`;

    const msg = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 220,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.loadWarning);
    return result;
  } catch (e) {
    console.error('generateLoadWarning error:', e.message);
    return null;
  }
}

async function generateRaceAdjustment({ profile, race, currentPlan }) {
  try {
    const courseTrust = trustedCourseFacts(race || {});
    const safeRace = {
      name: race?.race_name || race?.name || null,
      date: race?.race_date || race?.raceDate || null,
      distanceMiles: Number(race?.distance_miles ?? race?.distanceMiles) || null,
      goalTimeSeconds: Number(race?.goal_time_seconds ?? race?.goalTimeSeconds) || null,
      course: courseTrust.trusted
        ? { state: courseTrust.state, provenance: courseTrust.provenance, ...courseTrust.facts }
        : { state: courseTrust.state, provenance: courseTrust.provenance },
    };
    const courseRule = courseTrust.trusted
      ? 'Use only the supplied structured course facts; do not add new elevation, terrain, or altitude claims.'
      : 'Course details are unverified or stale. Keep this distance-only and do not infer course-specific hills, terrain, elevation, or altitude from the race name.';
    const prompt = `Return JSON only with key weeks (array). Athlete profile: ${JSON.stringify(sanitizeObj({ goal: profile?.goal_type, weekly: profile?.weekly_miles_current, runDays: profile?.run_days_per_week }))}. Race: ${JSON.stringify(sanitizeObj(safeRace))}. Current plan: ${JSON.stringify(sanitizeObj(currentPlan))}. ${courseRule} Rebalance with taper starting 2 weeks out when race <= 60 days.`;
    const msg = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (!courseTrust.trusted && result && /(course-specific|race hills?|course elevation|altitude prep)/i.test(JSON.stringify(result))) {
      console.error('[ai/race-adjustment] rejected unsupported course claim');
      return null;
    }
    return result;
  } catch (err) {
    console.error('[ai/race-adjustment] failed:', err.message);
    return null;
  }
}

async function generateWeeklyInsight({ userId, weekLabel, summary }) {
  try {
    if (!process.env.OPENAI_API_KEY) return null;
    const cacheKey = makeCacheKey('weekly-insight', { userId, weekLabel, summary });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with key insight.

Week: ${sanitize(weekLabel, 30)}
Miles: ${Number(summary?.totalMiles) || 0} across ${Number(summary?.totalRuns) || 0} runs, avg pace ${sanitize(summary?.avgPace, 20) || 'n/a'}, longest ${Number(summary?.longestRun) || 0} mi
Lifts: ${Number(summary?.liftSessions) || 0} sessions, volume ${Number(summary?.totalLiftVolume) || 0} lbs
PRs: ${JSON.stringify(summary?.prsThisWeek || [])}
Mileage vs last week: ${summary?.mileageVsLastWeek ?? 0}%
${summary?.injuryRiskFlag ? `Injury risk: ${sanitize(summary?.injuryRiskReason, 100) || 'flagged'}` : ''}

Write 1-2 sentences. Pick the most meaningful pattern in the data — something they might not have noticed themselves. Don't just summarise numbers they can already see. Sound like a coach who's been watching their training, not an automated report. Under 45 words.`;

    const msg = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    const insight = typeof result?.insight === 'string' ? result.insight.trim() : null;
    if (insight) setCached(cacheKey, insight, TTL.weeklyInsight);
    return insight;
  } catch (e) {
    console.error('generateWeeklyInsight error:', e.message);
    return null;
  }
}

async function generateComebackPlan({ injuryType, weeksOut, ptMilestone, targetRace, targetWeeks, currentFitness }) {
  try {
    const safeInjuryType = sanitize(injuryType, 100);
    const safeWeeksOut = Number(weeksOut) || 0;
    const safePtMilestone = sanitize(ptMilestone, 200);
    const safeTargetRace = sanitize(targetRace, 120);
    const safeTargetWeeks = Number.isInteger(Number(targetWeeks)) ? Number(targetWeeks) : null;
    const safeCurrentFitness = sanitize(currentFitness, 20).toLowerCase();

    const raceContext = safeTargetRace
      ? `- Target race: ${safeTargetRace}${safeTargetWeeks ? ` (in ${safeTargetWeeks} weeks)` : ''}`
      : '- Target race: none specified';

    const prompt = `You are an expert running coach and return-to-running specialist.
Generate a conservative, injury-aware comeback plan as strict JSON only.

Athlete context:
- Injury type: ${safeInjuryType}
- Weeks out from running: ${safeWeeksOut}
- PT milestone reached: ${safePtMilestone}
- Current fitness: ${safeCurrentFitness}
${raceContext}

Return ONLY valid JSON in this exact schema and key order:
{
  "plan_title": "string",
  "summary": "string",
  "weeks": [
    {
      "week": 1,
      "theme": "string",
      "runs": [
        {
          "day": "Mon",
          "type": "walk-run|easy|recovery|cross_train|rest",
          "duration_min": 20,
          "notes": "string"
        }
      ],
      "weekly_mileage_target": 8,
      "milestone_check": "string",
      "warning": "string or null"
    }
  ],
  "general_warnings": ["string"],
  "return_to_full_training_estimate": "string"
}

Rules:
- Provide 4 to 8 weeks depending on risk and current fitness; be conservative.
- Keep progression gradual (around 10% max weekly mileage increase unless warning indicates hold/reduce).
- Include at least 4 entries in runs per week, allowing rest or cross_train entries.
- Make warnings specific and safety-focused; use null when no special warning for a week.
- Reference the PT milestone and injury type in progression logic.
- No markdown, no explanations, JSON only.`;

    const res = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 2600,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content?.[0]?.text?.trim() || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.error('generateComebackPlan error:', e.message);
    return null;
  }
}

async function generateExerciseSubstitutions(exerciseName, reason, equipmentAvailable) {
  try {
    const safeName = sanitize(exerciseName, 100);
    const safeReason = sanitize(reason, 200);
    const safeEquipment = sanitize(equipmentAvailable, 200);

    const cacheKey = makeCacheKey('substitute', { exerciseName: safeName, reason: safeReason, equipmentAvailable: safeEquipment });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const reasonLine = safeReason ? `\nReason for substitution: ${safeReason}` : '';
    const equipmentLine = safeEquipment ? `\nAvailable equipment: ${safeEquipment}` : '';

    const prompt = `Return JSON only with key alternatives (array of 2-3 objects, each with keys: name, target_muscles, why_similar, equipment_needed).

Exercise to substitute: ${safeName}${reasonLine}${equipmentLine}

Find 2-3 alternative exercises that target the same primary muscle groups with a similar training stimulus. Be specific about why each is a good substitute.`;

    const msg = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.substitute);
    return result;
  } catch (e) {
    console.error('generateExerciseSubstitutions error:', e.message);
    return null;
  }
}

async function generateRecoveryAdjustment({ checkin, readinessScore, activeInjury, recentLoad, profile, userId }) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = makeCacheKey('recovery-adjustment', { userId, date: today });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const feelingLabels = ['', 'Exhausted', 'Tired', 'Okay', 'Good', 'Great'];
    const feeling = checkin?.feeling ? feelingLabels[checkin.feeling] || String(checkin.feeling) : 'unknown';
    const sleepHours = checkin?.sleep_hours != null ? Number(checkin.sleep_hours) : null;
    const lifeFlags = (() => {
      try { return JSON.parse(checkin?.life_flags || '[]'); } catch { return []; }
    })();

    const injuryCtx = activeInjury
      ? `Active injury: ${sanitize(activeInjury.body_part, 50)}, pain level ${Number(activeInjury.pain_level) || 'unknown'}/10`
      : 'No active injuries';

    const prompt = `You are an expert running and strength coach. An athlete needs today's training adjusted based on recovery signals. Return JSON only with keys: recommendation, adjusted_intensity, skip_reason.

Recovery signals:
- Feeling: ${feeling}
- Sleep: ${sleepHours != null ? `${sleepHours} hours` : 'not reported'}
- Soreness: ${lifeFlags.includes('sore') ? 'yes' : 'no'}
- Life flags: ${lifeFlags.length ? lifeFlags.join(', ') : 'none'}
- Readiness score: ${Number(readinessScore) || 'unknown'}/100
- ${injuryCtx}
- Recent training load (last 7 days): ${sanitize(JSON.stringify(recentLoad), 500)}
- Goal: ${sanitize(profile?.goal_type, 30) || 'fitness'}

Rules:
- recommendation: 2-3 sentences explaining what to do today and why. Reference specific signals. Sound like a coach, not an app.
- adjusted_intensity: exactly one of "light", "moderate", or "hard"
- skip_reason: if readiness < 30 or feeling is Exhausted AND sore, provide a reason to skip. Otherwise null.
- Be conservative with injuries. Be honest about sleep debt.`;

    const msg = await getClient().messages.create({
      model: 'complex',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.recoveryAdjustment);
    return result;
  } catch (e) {
    console.error('generateRecoveryAdjustment error:', e.message);
    return null;
  }
}

async function generatePostSessionInsight({ sessionType, comparisons, profile, userId }) {
  try {
    const cacheKey = makeCacheKey('post-session-insight', { userId, sessionType, comparisons });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    let dataBlock = '';
    if (sessionType === 'run') {
      const c = comparisons;
      dataBlock = `Run completed: ${c.distance} mi in ${c.durationMin} min (${c.pace}/mi), effort ${c.effort}/10
Recent 5 runs avg pace: ${c.recentAvgPace || 'n/a'}, avg distance: ${c.recentAvgDistance || 'n/a'} mi
Pace trend (last 5): ${c.paceTrend || 'n/a'}
Distance trend: ${c.distanceTrend || 'n/a'}
${c.isPR ? `NEW PR: ${c.prLabel}` : 'No PR this session'}
Weekly mileage so far: ${c.weeklyMileage || 0} mi`;
    } else {
      const c = comparisons;
      dataBlock = `Lift session completed: ${c.exerciseCount} exercises, total volume ${c.totalVolume} lbs
${c.exerciseComparisons.map(e =>
  `${sanitize(e.name, 50)}: ${e.currentVolume} lbs today vs ${e.prevAvgVolume} lbs avg (last 3) → ${e.volumeChange}`
).join('\n')}
${c.progressiveOverloads.length ? `Progressive overload achieved: ${c.progressiveOverloads.map(p => sanitize(p, 50)).join(', ')}` : 'No progressive overload flags'}`;
    }

    const prompt = `You are a sharp, data-driven fitness coach. Write 2-3 sentences of specific, data-driven feedback about this completed session. Reference actual numbers and comparisons. No motivational fluff — sound like a coach who looked at the data.

Session type: ${sanitize(sessionType, 10)}
Athlete goal: ${sanitize(profile?.goal_type, 30) || 'fitness'}
${dataBlock}

Rules:
- Reference specific numbers from the comparisons (pace changes, volume changes, PRs)
- If there's a trend, call it out
- If there's a PR or progressive overload, highlight it
- End with one concrete observation about what to focus on next
- Under 60 words. No headers. No bullet points.`;

    const msg = await getClient().messages.create({
      model: 'frequent',
      max_tokens: 180,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = msg.content?.[0]?.text?.trim() || null;
    if (result) setCached(cacheKey, result, TTL.sessionFeedback);
    return result;
  } catch (e) {
    console.error('generatePostSessionInsight error:', e.message);
    return null;
  }
}

async function generateNextGoalSuggestions({ completedGoal, profile, recentActivity, userId }) {
  try {
    const cacheKey = makeCacheKey('next-goal', { userId, completedGoal });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const safeGoal = sanitize(completedGoal, 300);
    const safeGoalType = sanitize(profile?.goal_type, 30) || 'fitness';
    const safeFitnessLevel = sanitize(profile?.fitness_level, 20) || 'intermediate';

    const prompt = `You are an expert fitness coach. An athlete just completed a goal or milestone. Suggest 2-3 logical progression goals they should pursue next.

Completed goal/milestone: ${safeGoal}
Athlete profile: goal type ${safeGoalType}, fitness level ${safeFitnessLevel}, weekly miles ${Number(profile?.weekly_miles_current) || 0}
Recent activity summary: ${sanitize(JSON.stringify(recentActivity || {}), 500)}

Return ONLY valid JSON with key "goals" — an array of 2-3 objects, each with:
- title: short goal name (under 40 chars)
- description: 1 sentence explaining the goal
- type: one of "strength", "endurance", "speed", "hybrid"
- target_value: numeric target (miles, lbs, minutes, etc.)
- target_unit: the unit for target_value
- difficulty: one of "moderate", "challenging", "ambitious"

Rules:
- Goals must be logical progressions from what was just achieved
- Include variety — don't suggest 3 of the same type
- Be specific with numbers, not vague
- Each goal should be achievable in 4-12 weeks`;

    const msg = await getClient().messages.create({
      model: 'complex',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, 4 * 60 * 60 * 1000);
    return result;
  } catch (e) {
    console.error('generateNextGoalSuggestions error:', e.message);
    return null;
  }
}

module.exports = {
  sanitize,
  generateTrainingPlan,
  generateRunFeedback,
  generateWorkoutFeedback,
  generateRunBrief,
  generateLiftPlan,
  generateWorkoutRecommendation,
  generateSessionFeedback,
  generateBodyPartWorkout,
  generateLoadWarning,
  generateRaceAdjustment,
  generateWeeklyInsight,
  generateComebackPlan,
  generateExerciseSubstitutions,
  generateRecoveryAdjustment,
  generatePostSessionInsight,
  generateNextGoalSuggestions,
};
