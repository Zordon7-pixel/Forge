const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

async function generateTrainingPlan(profile, target = null) {
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

  const raceTargetLine = target?.raceDate || target?.distanceMiles
    ? `- Race target override: ${target.distanceMiles ? `${target.distanceMiles} miles` : 'race'} on ${target.raceDate || 'upcoming date'}`
    : '';

  const prompt = `You are an expert running coach. Create a 4-week training plan for this athlete:
- Name: ${sanitize(profile.name, 50)}
- Current weekly miles: ${Number(profile.weekly_miles_current) || 0}
- Goal: ${goalDesc}
- Run days per week: ${Number(profile.run_days_per_week) || 3}
- Lift days per week: ${Number(profile.lift_days_per_week) || 2}
- Injury notes: ${sanitize(profile.injury_notes) || 'none'}
- Comeback mode: ${profile.comeback_mode ? 'YES — be very conservative, no speed work for first 2 weeks' : 'no'}
${raceTargetLine}${scheduleInfo}

Return ONLY valid JSON in this exact format, no other text:
{
  "weeks": [{"week":1,"theme":"short theme name","total_miles":0,"days":[{"day":"Mon","type":"easy","distance_miles":0,"duration_min":0,"description":"brief description","rest":false}]}]
}
Types can be: easy, tempo, long, intervals, recovery, rest, cross_train
Rules:
- Include at least 6 training sessions each week (non-rest days)
- Include 1-2 hybrid cardio + weight sessions weekly, marked as type "cross_train" with titles like Weighted Circuit, Kettlebell Cardio, Rucking, or Sled Push Intervals
- Keep at least 1 full rest day each week
- Increase mileage ~10% per week max. Week 4 should be a recovery week (reduce ~20%).`;

  try {
    const res = await getClient().messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4000,
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

  const prompt = `You are a sharp, experienced running coach reviewing a training log entry. Write 2-3 sentences of feedback. Sound like a knowledgeable training partner — direct, specific to the numbers, no fluff. Don't open with praise like "Great job" or "Well done". Don't mention weight or BMI. Reference the actual pace and effort.

${run.type} run — ${run.distance_miles} miles in ${durationMin} min (${pace}), effort ${run.perceived_effort}/10${notesCtx}
Context: ${Number(profile.weekly_miles_current) || 0} mi/week base, goal: ${sanitize(profile.goal_type, 30) || 'fitness'}${injuryCtx}

Under 60 words. No headers. No bullet points.`;

  try {
    const res = await getClient().messages.create({
      model: 'claude-haiku-4-5',
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

    const prompt = `You are a strength coach reviewing a completed session. Write 2-3 sentences of feedback — specific to the exercises and numbers, not generic. End with one concrete suggestion for next time. Sound like a coach who actually looked at the data, not a bot. Don't open with "Great work" or similar.

${durationMin ? `${durationMin} min session` : 'Session'} — ${muscleGroups || 'not specified'}
Exercises: ${exerciseSummary}
Goal: ${sanitize(profile?.goal_type, 30) || 'general fitness'}${notesCtx}

Under 80 words. No headers. No bullet points.`;

    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5',
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
    const msg = await getClient().messages.create({ model: 'claude-haiku-4-5', max_tokens: 220, messages: [{ role: 'user', content: prompt }] });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.runBrief);
    return result;
  } catch { return null; }
}

async function generateLiftPlan({ bodyPart, timeAvailable, profile, recentSets, recentRuns, userId }) {
  try {
    const cacheKey = makeCacheKey('lift-plan', { userId, bodyPart, timeAvailable, recentSets: (recentSets || []).slice(0, 12), recentRuns: (recentRuns || []).slice(0, 4) });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with keys: workoutName, exercises(array of {name,sets,reps,rest}), estimatedTime. Body part: ${sanitize(bodyPart, 50)}. Time available: ${sanitize(timeAvailable, 20)}. Athlete: ${sanitize(profile?.name, 50) || 'athlete'}. Recent sets: ${JSON.stringify(sanitizeObj((recentSets || []).slice(0,12)))}. Recent runs: ${JSON.stringify(sanitizeObj((recentRuns || []).slice(0,4)))}.`;
    const msg = await getClient().messages.create({ model: 'claude-haiku-4-5', max_tokens: 320, messages: [{ role: 'user', content: prompt }] });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.liftPlan);
    return result;
  } catch { return null; }
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
      model: 'claude-haiku-4-5',
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

    const prompt = `Return JSON only with keys: workoutName,target,warmup(array),main(array of {name,sets,reps,rest}),recovery(array),explanation,restExplanation. Athlete:${sanitize(profile?.name, 50) || 'athlete'} goal ${sanitize(profile?.goal_type, 30) || 'fitness'}. recent runs ${JSON.stringify(sanitizeObj((recentRuns || []).slice(0,5)))}. recent workouts ${JSON.stringify(sanitizeObj((recentWorkouts || []).slice(0,5)))}.`;
    const msg = await getClient().messages.create({ model: 'claude-haiku-4-5', max_tokens: 420, messages: [{ role: 'user', content: prompt }] });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.workoutRecommendation);
    return result;
  } catch { return null; }
}

async function generateBodyPartWorkout({ bodyPart, exercise, profile, userId }) {
  try {
    const cacheKey = makeCacheKey('body-part-workout', { userId, bodyPart, exercise, goal: profile?.goal_type });
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const prompt = `Return JSON only with keys: workoutName,target,warmup(array),main(array of {name,sets,reps,rest}),recovery(array),explanation,restExplanation. Build a focused lifting workout with 4-6 exercises. Body part: ${sanitize(bodyPart, 50)}. Anchor exercise: ${sanitize(exercise, 50)}. Athlete: ${sanitize(profile?.name, 50) || 'athlete'} goal ${sanitize(profile?.goal_type, 30) || 'fitness'}.`;
    const msg = await getClient().messages.create({ model: 'claude-haiku-4-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (result) setCached(cacheKey, result, TTL.liftPlan);
    return result;
  } catch {
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
      model: 'claude-haiku-4-5',
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
    const prompt = `Return JSON only with key weeks (array). Athlete profile: ${JSON.stringify(sanitizeObj({ goal: profile?.goal_type, weekly: profile?.weekly_miles_current, runDays: profile?.run_days_per_week }))}. Race: ${JSON.stringify(sanitizeObj(race))}. Current plan: ${JSON.stringify(sanitizeObj(currentPlan))}. Rebalance with taper starting 2 weeks out when race <= 60 days.`;
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    return null;
  }
}

async function generateWeeklyInsight({ userId, weekLabel, summary }) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
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
      model: 'claude-haiku-4-5',
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
      model: 'claude-haiku-4-5',
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
      model: 'claude-haiku-4-5',
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
      model: 'claude-sonnet-4-6',
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
      model: 'claude-haiku-4-5',
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
      model: 'claude-sonnet-4-6',
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
