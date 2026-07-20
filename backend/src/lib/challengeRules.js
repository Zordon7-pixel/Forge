const { boundedText } = require('./friendship');
const { cleanText } = require('./profanity');

const CHALLENGE_DURATIONS = new Set([7, 14, 30]);
const CHALLENGE_TEMPLATES = new Set([
  'running_distance',
  'running_time',
  'running_consistency',
  'strength_consistency',
  'hybrid_balance',
]);
const VERIFICATION_POLICIES = new Set(['all_activity', 'device_only']);
const DISTANCE_UNITS = new Set(['miles', 'kilometers']);

const TEMPLATE_LABELS = {
  running_distance: 'Running distance challenge',
  running_time: 'Running time challenge',
  running_consistency: 'Running consistency challenge',
  strength_consistency: 'Strength consistency challenge',
  hybrid_balance: 'Hybrid challenge',
};

function isDateString(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year)
    && parsed.getUTCMonth() === Number(month) - 1
    && parsed.getUTCDate() === Number(day);
}

function addDays(dateString, days) {
  if (!isDateString(dateString)) return null;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function isIanaTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(value || '') }).format(new Date());
    return Boolean(value);
  } catch {
    return false;
  }
}

function dateInTimezone(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || !isIanaTimezone(timezone)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function challengeTemplateLabel(templateType) {
  return TEMPLATE_LABELS[templateType] || 'Private training challenge';
}

function isHybridChallengeTemplate(templateType) {
  return templateType === 'hybrid_balance';
}

function effectiveChallengeStatus(challenge, now = new Date()) {
  if (challenge?.status !== 'active') return challenge?.status || 'active';
  const today = dateInTimezone(now, challenge.timezone || 'UTC');
  return today && challenge.end_date < today ? 'completed' : 'active';
}

function boundedNumber(value, min, max, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  if (integer && !Number.isInteger(parsed)) return null;
  return integer ? parsed : Math.round(parsed * 100) / 100;
}

function normalizeChallengeInput(body = {}, now = new Date()) {
  const timezone = String(body.timezone || '').trim();
  if (!isIanaTimezone(timezone)) return { error: 'Choose a valid timezone.' };

  const templateType = String(body.template_type || '');
  if (!CHALLENGE_TEMPLATES.has(templateType)) return { error: 'Choose a valid challenge template.' };

  const durationDays = Number(body.duration_days);
  if (!CHALLENGE_DURATIONS.has(durationDays)) return { error: 'Challenge duration must be 7, 14, or 30 days.' };

  const startDate = String(body.start_date || '');
  if (!isDateString(startDate)) return { error: 'Choose a valid start date.' };
  const today = dateInTimezone(now, timezone);
  if (!today || startDate < today || startDate > addDays(today, 365)) {
    return { error: 'Start date must be today or within the next year.' };
  }

  const name = boundedText(cleanText(body.name), 60);
  if (name.length < 3) return { error: 'Challenge name must be at least 3 characters.' };
  const description = boundedText(cleanText(body.description), 280) || null;

  const verificationPolicy = String(body.verification_policy || 'all_activity');
  if (!VERIFICATION_POLICIES.has(verificationPolicy)) return { error: 'Choose a valid verification policy.' };

  const participantLimit = body.participant_limit === undefined
    ? 25
    : boundedNumber(body.participant_limit, 2, 50, { integer: true });
  if (!participantLimit) return { error: 'Participant limit must be between 2 and 50.' };

  let runTarget = null;
  let runUnit = null;
  let liftTarget = null;
  let liftUnit = null;

  if (templateType === 'running_distance' || templateType === 'hybrid_balance') {
    runUnit = String(body.run_unit || 'miles');
    if (!DISTANCE_UNITS.has(runUnit)) return { error: 'Distance unit must be miles or kilometers.' };
    runTarget = boundedNumber(body.run_target, runUnit === 'miles' ? 0.5 : 1, runUnit === 'miles' ? 500 : 800);
    if (!runTarget) return { error: 'Enter a valid running distance target.' };
  } else if (templateType === 'running_time') {
    runUnit = 'minutes';
    runTarget = boundedNumber(body.run_target, 10, 10000, { integer: true });
    if (!runTarget) return { error: 'Running time must be between 10 and 10,000 minutes.' };
  } else if (templateType === 'running_consistency') {
    runUnit = 'days';
    runTarget = boundedNumber(body.run_target, 1, durationDays, { integer: true });
    if (!runTarget) return { error: 'Running days must fit inside the challenge window.' };
  }

  if (templateType === 'strength_consistency' || templateType === 'hybrid_balance') {
    liftUnit = 'sessions';
    liftTarget = boundedNumber(body.lift_target, 1, durationDays * 2, { integer: true });
    if (!liftTarget) return { error: 'Enter a valid strength-session target.' };
  }

  return {
    value: {
      name,
      description,
      templateType,
      durationDays,
      startDate,
      endDate: addDays(startDate, durationDays - 1),
      timezone,
      verificationPolicy,
      participantLimit,
      runTarget,
      runUnit,
      liftTarget,
      liftUnit,
    },
  };
}

module.exports = {
  CHALLENGE_DURATIONS,
  CHALLENGE_TEMPLATES,
  DISTANCE_UNITS,
  VERIFICATION_POLICIES,
  addDays,
  challengeTemplateLabel,
  dateInTimezone,
  effectiveChallengeStatus,
  isHybridChallengeTemplate,
  isDateString,
  isIanaTimezone,
  normalizeChallengeInput,
};
