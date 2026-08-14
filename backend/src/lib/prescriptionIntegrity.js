const RECOVERY_MARKER = /(recovery|zone\s*1(?:\s*-\s*2)?|fully conversational)/i;
const HARD_WORK_MARKER = /(hill|interval|repeat|threshold|sprint|tempo|race pace|zone\s*[3-5]|hard(?:\s+but)?|comfortably steady|steady effort|moderate\s+(?:effort|pace|run(?:ning)?|intensity))/i;

const SAFE_RECOVERY = Object.freeze({
  type: 'recovery',
  workout_type: 'recovery',
  title: 'Recovery run',
  target_zone: 'Zone 1-2',
  pace_target: 'Fully conversational; walking is allowed',
  intensity: 'Recovery',
  warmup: ['5 min easy walking', 'Begin running only when your stride feels relaxed'],
  steps: ['Stay in Zone 1-2', 'Keep breathing relaxed', 'Stop if soreness changes your stride'],
  cooldown: ['5 min easy walking', 'Hydrate and refuel'],
  progression: 'Do not add pace or distance today.',
});

function stringValues(value) {
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return value === null || value === undefined ? [] : [String(value)];
}

function isRunSession(session = {}) {
  const marker = [session.kind, session.type, session.workout_type].filter(Boolean).join(' ');
  return !/(lift|strength|rest|cross)/i.test(marker);
}

function isRecoveryRun(session = {}) {
  if (!isRunSession(session)) return false;
  const nested = session.prescription && typeof session.prescription === 'object' ? session.prescription : {};
  return RECOVERY_MARKER.test([
    session.title,
    session.type,
    session.workout_type,
    session.target_zone,
    session.intensity,
    session.pace_target,
    nested.title,
    nested.type,
    nested.workout_type,
    nested.target_zone,
    nested.intensity,
    nested.pace_target,
  ].filter(Boolean).join(' '));
}

function hasConflictingHardWork(session = {}) {
  const nested = session.prescription && typeof session.prescription === 'object' ? session.prescription : {};
  return HARD_WORK_MARKER.test(stringValues([
    session.warmup,
    session.steps,
    session.blocks,
    session.structure,
    session.cooldown,
    session.pace_target,
    session.intensity,
    session.progression,
    nested.warmup,
    nested.steps,
    nested.blocks,
    nested.structure,
    nested.cooldown,
    nested.pace_target,
    nested.intensity,
    nested.progression,
  ]).join(' '));
}

function repairRecoverySession(session = {}) {
  if (!isRecoveryRun(session) || !hasConflictingHardWork(session)) return session;
  const next = {
    ...session,
    ...SAFE_RECOVERY,
    prescriptionIntegrityAdjusted: true,
  };
  if (session.prescription && typeof session.prescription === 'object') {
    next.prescription = {
      ...session.prescription,
      ...SAFE_RECOVERY,
      prescriptionIntegrityAdjusted: true,
    };
  }
  return next;
}

function repairSessionList(sessions) {
  if (!Array.isArray(sessions)) return sessions;
  return sessions.map((session) => repairRecoverySession(session));
}

function repairPlanPrescriptions(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.weeks)) return plan;
  let changed = false;
  const weeks = plan.weeks.map((week) => {
    let nextWeek = week;
    if (Array.isArray(week?.sessions)) {
      const sessions = repairSessionList(week.sessions);
      if (sessions.some((session, index) => session !== week.sessions[index])) {
        nextWeek = { ...nextWeek, sessions };
        changed = true;
      }
    }
    if (Array.isArray(week?.days)) {
      const days = week.days.map((day) => {
        if (Array.isArray(day?.sessions)) {
          const sessions = repairSessionList(day.sessions);
          if (sessions.some((session, index) => session !== day.sessions[index])) {
            changed = true;
            return { ...day, sessions };
          }
          return day;
        }
        const repaired = repairRecoverySession(day);
        if (repaired !== day) changed = true;
        return repaired;
      });
      if (days.some((day, index) => day !== week.days[index])) nextWeek = { ...nextWeek, days };
    }
    return nextWeek;
  });
  return changed ? { ...plan, weeks, prescriptionIntegrityAdjusted: true } : plan;
}

function canonicalSteps(steps, output = []) {
  if (!Array.isArray(steps)) return output;
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
    output.push(step);
    if (Array.isArray(step.children)) canonicalSteps(step.children, output);
  }
  return output;
}

function canonicalDurationMinutes(session = {}) {
  const seconds = Number(session.derived_totals?.duration_s);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds / 60;
  const direct = Number(session.duration_min ?? session.duration_minutes);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const directSeconds = Number(session.duration_s);
  return Number.isFinite(directSeconds) && directSeconds >= 0 ? directSeconds / 60 : 0;
}

function canonicalQualityMinutes(session = {}) {
  const seconds = Number(session.derived_totals?.work_duration_s);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds / 60;
  const direct = Number(session.quality_work_duration_min ?? session.qualityWorkDurationMinutes);
  return Number.isFinite(direct) && direct >= 0 ? direct : 0;
}

function canonicalRunStationPairs(session = {}) {
  function countTypes(steps, wanted, multiplier = 1) {
    if (!Array.isArray(steps)) return 0;
    return steps.reduce((sum, step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return sum;
      if (step.type === 'repeat') {
        const count = Number.isSafeInteger(step.repeat_count) && step.repeat_count > 0 ? step.repeat_count : 0;
        return sum + countTypes(step.children, wanted, multiplier * count);
      }
      return sum + (wanted.has(step.type) ? multiplier : 0);
    }, 0);
  }
  const runs = countTypes(session.steps, new Set(['run', 'interval']));
  const stations = countTypes(session.steps, new Set(['station']));
  return Math.min(runs, stations);
}

function hasNamedPresentationFloorException(session = {}) {
  const reasonCodes = session.purpose_reason_codes ?? session.reason_codes ?? [];
  return Array.isArray(reasonCodes)
    && reasonCodes.includes('BELOW_PRESENTATION_FLOOR_EXCEPTION')
    && typeof session.beginner_or_rehab_protocol_id === 'string'
    && session.beginner_or_rehab_protocol_id.trim().length > 0;
}

function validateCanonicalPresentationFloor(session = {}, athleteState = {}) {
  const family = session.workout_family;
  const age = String(athleteState.training_age_class ?? session.training_age_class ?? '').toUpperCase();
  const consistency = String(athleteState.consistency_state ?? session.consistency_state ?? '').toUpperCase();
  const beginner = age === 'BEGINNER';
  const returning = age === 'RETURNING' || consistency === 'RETURNING';
  const weeklyMinutes = Number(athleteState.recent_normal_running_minutes_per_week);
  const medianEasy = Number(athleteState.median_ordinary_easy_duration_min);
  const duration = canonicalDurationMinutes(session);
  const steps = canonicalSteps(session.steps, []);
  const violations = [];

  let reason = null;
  if (family === 'recovery_run') {
    const minimum = beginner || (Number.isFinite(weeklyMinutes) && weeklyMinutes < 60) ? 15 : 20;
    if (duration < minimum) reason = 'RECOVERY_RUN_BELOW_MINIMUM';
  } else if (family === 'easy_run') {
    const minimum = beginner || returning ? 20 : 25;
    if (duration < minimum) reason = 'EASY_RUN_BELOW_MINIMUM';
  } else if (family === 'long_aerobic' && athleteState.beginner_time_on_feet_policy !== true) {
    const minimum = Math.max(30, Number.isFinite(medianEasy) ? medianEasy * 1.5 : 30);
    if (duration < minimum) reason = 'LONG_RUN_BELOW_MINIMUM';
  } else if (['threshold_run', 'interval_run', 'race_rhythm_run'].includes(family)) {
    const hasWarmup = steps.some((step) => step.type === 'warmup');
    const hasCooldown = steps.some((step) => step.type === 'cooldown');
    if (canonicalQualityMinutes(session) < 8 || !hasWarmup || !hasCooldown) reason = 'QUALITY_SESSION_BELOW_MINIMUM';
  } else if (family === 'hyrox_compromised') {
    if (canonicalRunStationPairs(session) < 2 || canonicalQualityMinutes(session) < 20) {
      reason = 'HYROX_COMPROMISED_BELOW_MINIMUM';
    }
  } else if (['strength_lower', 'strength_upper', 'strength_full_body'].includes(family)
    && session.technique_or_rehab_scope !== true) {
    const exercises = steps.filter((step) => step.type === 'strength_exercise');
    if (exercises.length < 2 || exercises.some((step) => Number(step.target?.sets) < 2)) {
      reason = 'STRENGTH_SESSION_BELOW_MINIMUM';
    }
  }

  if (reason && !hasNamedPresentationFloorException(session)) {
    violations.push({
      code: 'BELOW_PRESENTATION_FLOOR_EXCEPTION',
      reason,
      session_id: session.session_id ?? session.id ?? null,
      workout_family: family ?? null,
    });
  }
  return {
    valid: violations.length === 0,
    violations,
    reason_codes: violations.map((violation) => violation.code),
  };
}

function numberTokens(value) {
  const matches = String(value ?? '').match(/\d+(?:\.\d+)?/g) || [];
  return matches.map((token) => {
    const numeric = Number(token);
    return Number.isFinite(numeric) ? String(numeric) : token;
  });
}

function collectFactNumbers(value, output = new Set()) {
  if (typeof value === 'number' && Number.isFinite(value)) output.add(String(value));
  else if (typeof value === 'string') numberTokens(value).forEach((token) => output.add(token));
  else if (Array.isArray(value)) value.forEach((entry) => collectFactNumbers(entry, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectFactNumbers(entry, output));
  return output;
}

function explanationFactProjection(canonicalFacts = {}) {
  if (Array.isArray(canonicalFacts.allowed_numbers)) return canonicalFacts.allowed_numbers;
  const steps = canonicalSteps(canonicalFacts.steps, []).map((step) => ({
    type: step.type,
    repeat_count: step.repeat_count,
    target: step.target,
  }));
  return {
    scheduled_local_date: canonicalFacts.scheduled_local_date,
    steps,
    derived_totals: canonicalFacts.derived_totals,
    success_criteria: canonicalFacts.success_criteria,
    adjustment_criteria: canonicalFacts.adjustment_criteria,
    stop_criteria: canonicalFacts.stop_criteria,
  };
}

function validateExplanationAgainstCanonicalFacts(explanation, canonicalFacts = {}) {
  if (typeof explanation !== 'string') {
    return { valid: false, unexpected_numbers: [], reason_codes: ['EXPLANATION_INVALID'] };
  }
  const allowed = collectFactNumbers(explanationFactProjection(canonicalFacts));
  const supplied = numberTokens(explanation);
  const unexpected = [...new Set(supplied.filter((token) => !allowed.has(token)))];
  return {
    valid: unexpected.length === 0,
    unexpected_numbers: unexpected,
    allowed_numbers: [...allowed].sort((left, right) => Number(left) - Number(right)),
    reason_codes: unexpected.length ? ['EXPLANATION_FACT_MISMATCH'] : [],
  };
}

function assertExplanationAgainstCanonicalFacts(explanation, canonicalFacts) {
  const result = validateExplanationAgainstCanonicalFacts(explanation, canonicalFacts);
  if (!result.valid) {
    const error = new Error('Explanation contains a number absent from canonical facts');
    error.code = 'EXPLANATION_FACT_MISMATCH';
    error.status = 422;
    error.details = result;
    throw error;
  }
  return explanation;
}

function attachValidatedExplanation(session, explanation, canonicalFacts = session) {
  assertExplanationAgainstCanonicalFacts(explanation, canonicalFacts);
  const { canonicalWorkoutHash } = require('./canonicalWorkout');
  const before = canonicalWorkoutHash(session);
  const result = { ...session, athlete_explanation: explanation };
  if (canonicalWorkoutHash(result) !== before) {
    const error = new Error('Explanation attempted to mutate canonical prescription');
    error.code = 'EXPLANATION_PRESCRIPTION_MUTATION';
    error.status = 422;
    throw error;
  }
  return result;
}

module.exports = {
  SAFE_RECOVERY,
  assertExplanationAgainstCanonicalFacts,
  attachValidatedExplanation,
  hasConflictingHardWork,
  isRecoveryRun,
  repairRecoverySession,
  repairPlanPrescriptions,
  validateCanonicalPresentationFloor,
  validateExplanationAgainstCanonicalFacts,
  validateExplanationNumbers: validateExplanationAgainstCanonicalFacts,
  validatePresentationFloor: validateCanonicalPresentationFloor,
};
