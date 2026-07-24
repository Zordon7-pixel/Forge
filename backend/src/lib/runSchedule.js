const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_TRAINING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeTrainingDays(raw) {
  let values = raw;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch (_err) {
      values = values.split(',').map((value) => value.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(values)) return [];
  const normalized = values
    .map((value) => DAY_ORDER.find((day) => day.toLowerCase() === String(value || '').trim().slice(0, 3).toLowerCase()))
    .filter(Boolean);
  const unique = [...new Set(normalized)];
  return DAY_ORDER.filter((day) => unique.includes(day));
}

function explicitTargetValue(target, camelKey, snakeKey) {
  if (hasOwn(target, camelKey) && target[camelKey] !== undefined) {
    return { supplied: true, value: target[camelKey] };
  }
  if (hasOwn(target, snakeKey) && target[snakeKey] !== undefined) {
    return { supplied: true, value: target[snakeKey] };
  }
  return { supplied: false, value: undefined };
}

function invalid(error, code) {
  return { valid: false, error, code };
}

function resolveRunSchedule(profile = {}, target = {}, options = {}) {
  const runInput = explicitTargetValue(target, 'runDaysPerWeek', 'run_days_per_week');
  const daysInput = explicitTargetValue(target, 'trainingDays', 'training_days');
  const requireCompleteSelection = options.requireCompleteSelection === true;

  if (requireCompleteSelection && runInput.supplied !== daysInput.supplied) {
    return invalid(
      'runDaysPerWeek and trainingDays must be supplied together so run frequency cannot fall back silently.',
      'INCOMPLETE_RUN_SCHEDULE'
    );
  }

  let explicitDays = [];
  if (daysInput.supplied) {
    if (!Array.isArray(daysInput.value) || daysInput.value.length === 0) {
      return invalid('trainingDays must contain at least one weekday.', 'INVALID_TRAINING_DAYS');
    }
    explicitDays = normalizeTrainingDays(daysInput.value);
    if (explicitDays.length !== new Set(daysInput.value.map((value) => String(value || '').trim().slice(0, 3).toLowerCase())).size) {
      return invalid('trainingDays contains an invalid weekday.', 'INVALID_TRAINING_DAYS');
    }
  }

  let explicitRunDays = null;
  if (runInput.supplied) {
    explicitRunDays = Number(runInput.value);
    if (!Number.isInteger(explicitRunDays) || explicitRunDays < 1 || explicitRunDays > 6) {
      return invalid('runDaysPerWeek must be a whole number from 1 to 6.', 'INVALID_RUN_FREQUENCY');
    }
  }

  const savedDays = normalizeTrainingDays(profile.preferred_workout_days);
  const trainingDays = daysInput.supplied
    ? explicitDays
    : savedDays.length
      ? savedDays
      : DEFAULT_TRAINING_DAYS.slice();
  const profileRunDays = Number(profile.run_days_per_week);
  const legacyRunDays = Number.isInteger(profileRunDays) && profileRunDays >= 1 && profileRunDays <= 6
    ? profileRunDays
    : 3;
  const requestedRunDays = runInput.supplied ? explicitRunDays : legacyRunDays;

  if (runInput.supplied && requestedRunDays > trainingDays.length) {
    return invalid(
      'runDaysPerWeek cannot exceed the number of selected trainingDays.',
      'RUN_FREQUENCY_EXCEEDS_TRAINING_DAYS'
    );
  }

  const runDaysPerWeek = Math.min(requestedRunDays, trainingDays.length);
  return {
    valid: true,
    runDaysPerWeek,
    trainingDays,
    runDaysSource: runInput.supplied
      ? 'target'
      : Number.isInteger(profileRunDays) && profileRunDays >= 1 && profileRunDays <= 6
        ? 'profile'
        : 'legacy_default',
    trainingDaysSource: daysInput.supplied ? 'target' : savedDays.length ? 'profile' : 'legacy_default',
    explicitSelection: runInput.supplied && daysInput.supplied,
    legacyAdjusted: !runInput.supplied && requestedRunDays !== runDaysPerWeek,
  };
}

module.exports = {
  DAY_ORDER,
  DEFAULT_TRAINING_DAYS,
  normalizeTrainingDays,
  resolveRunSchedule,
};
