const Anthropic = require('@anthropic-ai/sdk');

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

async function generateTrainingPlan(profile) {
  const goalDesc = {
    comeback:      'returning from injury, needs conservative build-up',
    race:          `training for a ${profile.goal_race_distance || 'race'} on ${profile.goal_race_date || 'an upcoming date'}`,
    fitness:       'building general running fitness',
    base_building: 'building aerobic base mileage',
  }[profile.goal_type] || 'building fitness';

  // Get schedule preferences
  const scheduleInfo = profile.schedule_type ? `
- Schedule style: ${profile.schedule_type} (flexible/structured/adaptive)
- Lifestyle: ${profile.lifestyle || 'works_fulltime'}
- Preferred workout time: ${profile.preferred_workout_time || 'evening'}
- Preferred workout days per week: ${profile.weekly_workout_days || 4}
- If missed workout: ${profile.missed_workout_pref || 'adjust_week'}` : '';

  const prompt = `You are an expert running coach. Create a 4-week training plan for this athlete:
- Name: ${profile.name}
- Current weekly miles: ${profile.weekly_miles_current}
- Goal: ${goalDesc}
- Run days per week: ${profile.run_days_per_week}
- Lift days per week: ${profile.lift_days_per_week}
- Injury notes: ${profile.injury_notes || 'none'}
- Comeback mode: ${profile.comeback_mode ? 'YES — be very conservative, no speed work for first 2 weeks' : 'no'}${scheduleInfo}

Return ONLY valid JSON in this exact format, no other text:
{
  "weeks": [
    {
      "week": 1,
      "theme": "short theme name",
      "total_miles": 0,
      "days": [
        {"day": "Mon", "type": "easy", "distance_miles": 0, "duration_min": 0, "description": "brief description", "rest": false},
        {"day": "Tue", "type": "rest", "distance_miles": 0, "duration_min": 0, "description": "Rest day", "rest": true},
        {"day": "Wed", "type": "easy", "distance_miles": 0, "duration_min": 0, "description": "...", "rest": false},
        {"day": "Thu", "type": "rest", "distance_miles": 0, "duration_min": 0, "description": "Rest day", "rest": true},
        {"day": "Fri", "type": "easy", "distance_miles": 0, "duration_min": 0, "description": "...", "rest": false},
        {"day": "Sat", "type": "long", "distance_miles": 0, "duration_min": 0, "description": "...", "rest": false},
        {"day": "Sun", "type": "rest", "distance_miles": 0, "duration_min": 0, "description": "Rest day", "rest": true}
      ]
    }
  ]
}
Types can be: easy, tempo, long, intervals, recovery, rest, cross_train
Increase mileage ~10% per week max. Week 4 should be a recovery week (reduce ~20%).`;

  try {
    const res = await getClient().messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
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
  const personalities = {
    mentor:          'calm, analytical, and encouraging — like a wise coach who believes in you',
    hype_coach:      'energetic, loud, and motivating — celebrate every win',
    drill_sergeant:  'direct, no excuses, push harder — but also strategic',
    training_partner: 'peer-to-peer, relatable, like a training partner who ran the same route',
  };
  const voice = personalities[profile.coach_personality] || personalities.mentor;

  const durationMin = Math.round((run.duration_seconds || 0) / 60);
  const pace = run.distance_miles > 0 && durationMin > 0
    ? `${Math.floor(durationMin / run.distance_miles)}:${String(Math.round((durationMin / run.distance_miles % 1) * 60)).padStart(2, '0')}/mi`
    : 'unknown pace';

  // Get schedule preferences
  const scheduleContext = profile.schedule_type ? `
- Schedule style: ${profile.schedule_type}
- Lifestyle: ${profile.lifestyle || 'works_fulltime'}
- Preferred training time: ${profile.preferred_workout_time || 'evening'}` : '';

  const prompt = `You are a running coach with a ${voice} personality.
Give 2-3 sentences of feedback on this run. Be specific to the data. Do NOT mention BMI or weight loss.

Run data:
- Type: ${run.type}
- Distance: ${run.distance_miles} miles
- Duration: ${durationMin} min (${pace})
- Perceived effort: ${run.perceived_effort}/10
- Notes from athlete: ${run.notes || 'none'}
- Athlete context: ${profile.injury_notes || 'healthy'}, goal: ${profile.goal_type}, weekly base: ${profile.weekly_miles_current} mi/week${scheduleContext}

Keep it under 60 words total. No headers, no bullet points — just natural coaching feedback.`;

  try {
    const res = await getClient().messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    return res.content[0].text.trim();
  } catch (e) {
    console.error('AI feedback error:', e.message);
    return null;
  }
}

module.exports = { generateTrainingPlan, generateRunFeedback };
