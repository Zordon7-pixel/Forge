const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_TRAINING_DAYS = DAY_ORDER.slice();

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

function frequencyValue(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : NaN;
}

function resolveRunSchedule(profile = {}, target = {}, options = {}) {
  const runInput = explicitTargetValue(target, 'runDaysPerWeek', 'run_days_per_week');
  const modalityDaysInput = explicitTargetValue(target, 'runEligibleWeekdays', 'run_eligible_weekdays');
  const daysInput = modalityDaysInput.supplied ? modalityDaysInput
    : explicitTargetValue(target, 'trainingDays', 'training_days');
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
    explicitRunDays = frequencyValue(runInput.value);
    if (!Number.isInteger(explicitRunDays) || explicitRunDays < 1 || explicitRunDays > 7) {
      return invalid('runDaysPerWeek must be a whole number from 1 to 7.', 'INVALID_RUN_FREQUENCY');
    }
  }

  const savedDays = normalizeTrainingDays(profile.run_eligible_weekdays ?? profile.preferred_workout_days);
  const trainingDays = daysInput.supplied
    ? explicitDays
    : savedDays.length
      ? savedDays
      : DEFAULT_TRAINING_DAYS.slice();
  const profileRunDays = Number(profile.run_days_per_week);
  const legacyRunDays = Number.isInteger(profileRunDays) && profileRunDays >= 1 && profileRunDays <= 7
    ? profileRunDays
    : 3;
  const requestedRunDays = runInput.supplied ? explicitRunDays : legacyRunDays;

  if (requestedRunDays > trainingDays.length) {
    return invalid(
      'runDaysPerWeek cannot exceed the number of selected trainingDays.',
      'RUN_FREQUENCY_EXCEEDS_TRAINING_DAYS'
    );
  }

  const runDaysPerWeek = requestedRunDays;
  return {
    valid: true,
    runDaysPerWeek,
    trainingDays,
    runEligibleWeekdays: trainingDays,
    runDaysSource: runInput.supplied
      ? 'target'
      : Number.isInteger(profileRunDays) && profileRunDays >= 1 && profileRunDays <= 7
        ? 'profile'
        : 'legacy_default',
    trainingDaysSource: daysInput.supplied ? 'target' : savedDays.length ? 'profile' : 'legacy_default',
    explicitSelection: runInput.supplied && daysInput.supplied,
    legacyAdjusted: !runInput.supplied && requestedRunDays !== runDaysPerWeek,
  };
}

// Modality-specific availability is authoritative. Old clients can continue
// sending trainingDays, which deliberately supplies the shared legacy fallback.
function resolveLiftSchedule(profile = {}, target = {}) {
  const input = explicitTargetValue(target, 'liftDaysPerWeek', 'lift_days_per_week');
  const daysInput = explicitTargetValue(target, 'liftEligibleWeekdays', 'lift_eligible_weekdays');
  const sharedInput = explicitTargetValue(target, 'trainingDays', 'training_days');
  const rawDays = daysInput.supplied ? daysInput.value : sharedInput.supplied ? sharedInput.value
    : profile.lift_eligible_weekdays ?? profile.preferred_workout_days ?? DEFAULT_TRAINING_DAYS;
  const liftEligibleWeekdays = normalizeTrainingDays(rawDays);
  if (daysInput.supplied && (!Array.isArray(rawDays)
    || liftEligibleWeekdays.length !== new Set(rawDays.map((day) => String(day || '').trim().slice(0, 3).toLowerCase())).size)) {
    return invalid('liftEligibleWeekdays must contain valid weekdays.', 'INVALID_LIFT_WEEKDAYS');
  }
  const fallbackCount = Number(profile.lift_days_per_week);
  const requestedCount = input.supplied ? frequencyValue(input.value)
    : Number.isInteger(fallbackCount) && fallbackCount >= 0 && fallbackCount <= 7 ? fallbackCount
      : target.liftingEnabled === true ? 2 : 0;
  if (!Number.isInteger(requestedCount) || requestedCount < 0 || requestedCount > 7) {
    return invalid('liftDaysPerWeek must be a whole number from 0 to 7.', 'INVALID_LIFT_FREQUENCY');
  }
  if (target.liftingEnabled === false && input.supplied && requestedCount > 0) {
    return invalid('Enable lifting or choose zero lift days.', 'CONFLICTING_LIFT_PREFERENCE');
  }
  const liftDaysPerWeek = target.liftingEnabled === false ? 0 : requestedCount;
  if (liftDaysPerWeek > liftEligibleWeekdays.length) {
    return invalid('Lift days cannot exceed your eligible lifting weekdays.', 'LIFT_FREQUENCY_EXCEEDS_WEEKDAYS');
  }
  return { valid: true, liftDaysPerWeek, liftEligibleWeekdays,
    liftingEnabled: liftDaysPerWeek > 0,
    liftDaysSource: input.supplied ? 'target' : 'profile_or_legacy_default',
    liftWeekdaysSource: daysInput.supplied ? 'target' : 'shared_legacy_fallback' };
}

module.exports = {
  DAY_ORDER,
  DEFAULT_TRAINING_DAYS,
  normalizeTrainingDays,
  resolveRunSchedule,
  resolveLiftSchedule,
};
