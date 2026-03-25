const router = require('express').Router();
const auth = require('../middleware/auth');
const { sanitize, generateComebackPlan } = require('../services/ai');

const FITNESS_LEVELS = new Set(['easy', 'moderate', 'high']);

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

router.post('/comeback-plan', auth, async (req, res) => {
  try {
    const {
      injury_type,
      weeks_out,
      pt_milestone,
      target_race,
      target_weeks,
      current_fitness,
    } = req.body || {};

    if (!hasValue(injury_type)) {
      return res.status(400).json({ error: 'injury_type is required' });
    }
    if (String(injury_type).trim().length > 100) {
      return res.status(400).json({ error: 'injury_type must be 100 characters or fewer' });
    }

    const parsedWeeksOut = Number(weeks_out);
    if (!Number.isInteger(parsedWeeksOut) || parsedWeeksOut < 1 || parsedWeeksOut > 52) {
      return res.status(400).json({ error: 'weeks_out must be an integer between 1 and 52' });
    }

    if (!hasValue(pt_milestone)) {
      return res.status(400).json({ error: 'pt_milestone is required' });
    }
    if (String(pt_milestone).trim().length > 200) {
      return res.status(400).json({ error: 'pt_milestone must be 200 characters or fewer' });
    }

    if (!hasValue(current_fitness)) {
      return res.status(400).json({ error: 'current_fitness is required' });
    }

    const parsedFitness = sanitize(current_fitness, 20).toLowerCase();
    if (!FITNESS_LEVELS.has(parsedFitness)) {
      return res.status(400).json({ error: 'current_fitness must be one of: easy, moderate, high' });
    }

    let parsedTargetWeeks = null;
    if (hasValue(target_weeks)) {
      parsedTargetWeeks = Number(target_weeks);
      if (!Number.isInteger(parsedTargetWeeks) || parsedTargetWeeks < 1 || parsedTargetWeeks > 104) {
        return res.status(400).json({ error: 'target_weeks must be an integer between 1 and 104 when provided' });
      }
    }

    const sanitizedPayload = {
      injuryType: sanitize(injury_type, 100),
      weeksOut: parsedWeeksOut,
      ptMilestone: sanitize(pt_milestone, 200),
      targetRace: hasValue(target_race) ? sanitize(target_race, 120) : '',
      targetWeeks: parsedTargetWeeks,
      currentFitness: parsedFitness,
    };

    const plan = await generateComebackPlan(sanitizedPayload);
    if (!plan) {
      return res.status(502).json({ error: 'Failed to generate comeback plan' });
    }

    return res.json(plan);
  } catch (err) {
    console.error('Comeback plan route error:', err.message);
    return res.status(500).json({ error: 'Failed to generate comeback plan' });
  }
});

module.exports = router;
