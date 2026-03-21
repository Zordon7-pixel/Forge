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

const aiCache = new Map();
const TTL = {
  runBrief: 4 * 60 * 60 * 1000,
  workoutRecommendation: 4 * 60 * 60 * 1000,
  liftPlan: 60 * 60 * 1000,
  sessionFeedback: Infinity,
  loadWarning: 2 * 60 * 60 * 1000,
  weeklyInsight: 6 * 60 * 60 * 1000,
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
      model: 'claude-sonnet-4-6',
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

    const prompt = `Return JSON only with keys: why, effort, bpmRange, cadence. Athlete ${sanitize(profile?.name, 50) || 'athlete'} goal ${sanitize(profile?.goal_type, 30) || 'fitness'}. Latest planned/session run: ${JSON.stringify(run || {})}. Recent runs: ${JSON.stringify((recentRuns || []).slice(0,5))}. Recent workouts: ${JSON.stringify((recentLifts || []).slice(0,3))}.`;
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

    const prompt = `Return JSON only with keys: workoutName, exercises(array of {name,sets,reps,rest}), estimatedTime. Body part: ${sanitize(bodyPart, 50)}. Time available: ${sanitize(timeAvailable, 20)}. Athlete: ${sanitize(profile?.name, 50) || 'athlete'}. Recent sets: ${JSON.stringify((recentSets || []).slice(0,12))}. Recent runs: ${JSON.stringify((recentRuns || []).slice(0,4))}.`;
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

    const prompt = `Return JSON only with keys: workoutName,target,warmup(array),main(array of {name,sets,reps,rest}),recovery(array),explanation,restExplanation. Athlete:${sanitize(profile?.name, 50) || 'athlete'} goal ${sanitize(profile?.goal_type, 30) || 'fitness'}. recent runs ${JSON.stringify((recentRuns || []).slice(0,5))}. recent workouts ${JSON.stringify((recentWorkouts || []).slice(0,5))}.`;
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
    const prompt = `Return JSON only with key weeks (array). Athlete profile: ${JSON.stringify({ goal: profile?.goal_type, weekly: profile?.weekly_miles_current, runDays: profile?.run_days_per_week })}. Race: ${JSON.stringify(race)}. Current plan: ${JSON.stringify(currentPlan)}. Rebalance with taper starting 2 weeks out when race <= 60 days.`;
    const msg = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
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
      model: 'claude-sonnet-4-6',
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

module.exports = {
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
};
