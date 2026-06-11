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

function deriveAction(checkin = {}) {
  const feeling = Number(checkin.feeling || 3);
  const timeAvailable = Number(checkin.time_available || 60);
  const sleepHours = checkin.sleep_hours === null || checkin.sleep_hours === undefined || checkin.sleep_hours === ''
    ? null
    : Number(checkin.sleep_hours);
  const flags = parseLifeFlags(checkin.life_flags);
  const hasFlag = (flag) => flags.includes(flag);

  if (hasFlag('sick') || hasFlag('injured') || feeling <= 1 || (sleepHours !== null && sleepHours < 4.5)) {
    return 'rest';
  }

  if (feeling <= 2 || hasFlag('sore') || (sleepHours !== null && sleepHours < 6)) {
    return 'recovery_swap';
  }

  if (timeAvailable > 0 && timeAvailable <= 30) {
    return 'shorten';
  }

  if (hasFlag('long_shift') || hasFlag('traveling')) {
    return 'shorten';
  }

  return 'keep';
}

function getDistancePatch(day, multiplier) {
  const patch = {};
  const distanceKeys = ['distance_miles', 'distance', 'miles'];

  for (const key of distanceKeys) {
    if (day?.[key] === null || day?.[key] === undefined || day?.[key] === '') continue;
    const value = Number(day[key]);
    if (!Number.isFinite(value) || value <= 0) continue;
    patch[key] = Math.max(0.5, Math.round(value * multiplier * 10) / 10);
  }

  return patch;
}

function getDurationPatch(day, multiplier) {
  const patch = {};
  const durationKeys = ['duration_minutes', 'minutes', 'time_minutes'];

  for (const key of durationKeys) {
    if (day?.[key] === null || day?.[key] === undefined || day?.[key] === '') continue;
    const value = Number(day[key]);
    if (!Number.isFinite(value) || value <= 0) continue;
    patch[key] = Math.max(10, Math.round(value * multiplier));
  }

  return patch;
}

function buildPatch(action, day = {}) {
  if (!day || action === 'keep') return {};

  if (action === 'shorten') {
    const workloadPatch = {
      ...getDistancePatch(day, 0.65),
      ...getDurationPatch(day, 0.65),
    };
    if (Object.keys(workloadPatch).length === 0) return {};
    return {
      ...workloadPatch,
      checkin_override: { action, label: 'Shortened from daily check-in' },
    };
  }

  if (action === 'recovery_swap') {
    return {
      ...getDistancePatch(day, 0.5),
      type: 'recovery',
      workout_type: 'recovery',
      title: 'Recovery session',
      intensity: 'Recovery',
      target_zone: 'Zone 1-2',
      description: 'Recovery session from today\'s check-in.',
      checkin_override: { action, label: 'Swapped to recovery from daily check-in' },
    };
  }

  if (action === 'rest') {
    return {
      type: 'rest',
      workout_type: 'rest',
      title: 'Rest day',
      distance_miles: 0,
      distance: 0,
      miles: 0,
      intensity: 'Rest',
      target_zone: null,
      description: 'Rest day from today\'s check-in.',
      steps: [],
      checkin_override: { action, label: 'Changed to rest from daily check-in' },
    };
  }

  return {};
}

function buildDirective(checkin = {}, action = 'keep', patch = {}, hasWorkoutToday = false, readinessDelta = 0) {
  const feeling = Number(checkin.feeling || 3);
  const timeAvailable = Number(checkin.time_available || 60);
  const sleepHours = checkin.sleep_hours === null || checkin.sleep_hours === undefined || checkin.sleep_hours === ''
    ? null
    : Number(checkin.sleep_hours);
  const flags = parseLifeFlags(checkin.life_flags);
  const hasFlag = (flag) => flags.includes(flag);
  const drivers = [];
  const firstNumericValue = (keys) => {
    for (const key of keys) {
      const value = Number(patch?.[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  };
  const adjustedMinutes = firstNumericValue(['duration_minutes', 'minutes', 'time_minutes']);
  const adjustedDistance = firstNumericValue(['distance_miles', 'distance', 'miles']);
  const formatMiles = (miles) => `${miles} ${miles === 1 ? 'mile' : 'miles'}`;

  if (feeling <= 2) {
    drivers.push({
      label: 'Low feeling',
      detail: feeling <= 1
        ? 'You checked in at the lowest energy level, so today needs recovery before more training load.'
        : 'You checked in tired, so today shifts toward lower strain instead of forcing the original workload.',
    });
  }

  if (timeAvailable > 0 && timeAvailable <= 30) {
    drivers.push({
      label: 'Limited time',
      detail: 'You only have a short window, so the plan is trimmed to fit today instead of rushing the full session.',
    });
  }

  if (hasFlag('sore')) {
    drivers.push({
      label: 'Soreness',
      detail: 'Soreness raises the cost of hard work, so today favors easier movement and less accumulated stress.',
    });
  }

  if (hasFlag('sick') || hasFlag('injured')) {
    drivers.push({
      label: 'Not well',
      detail: 'You marked that you are not well, so recovery takes priority over adding training stress.',
    });
  }

  if (hasFlag('traveling')) {
    drivers.push({
      label: 'Traveling',
      detail: 'Travel usually limits routine, recovery, and time, so today is kept more manageable.',
    });
  }

  if (hasFlag('long_shift')) {
    drivers.push({
      label: 'Long shift',
      detail: 'A long shift adds fatigue outside training, so the workout is reduced to protect recovery.',
    });
  }

  if (sleepHours !== null && sleepHours < 6) {
    drivers.push({
      label: 'Poor sleep',
      detail: `You logged ${sleepHours}h of sleep, which lowers readiness for harder training today.`,
    });
  } else if (sleepHours !== null && sleepHours >= 8) {
    drivers.push({
      label: 'Good sleep',
      detail: `You logged ${sleepHours}h of sleep, which supports readiness and helps keep today's plan on track.`,
    });
  }

  const hasPatch = patch && Object.keys(patch).length > 0;
  let headline = 'Keep today as planned';

  if (!hasWorkoutToday) {
    headline = 'Check in saved, no workout found today';
  } else if (!hasPatch) {
    headline = action === 'shorten'
      ? 'Keep today as planned, nothing to shorten'
      : 'Keep today as planned';
  } else if (action === 'rest') {
    headline = 'Rest today, recovery comes first';
  } else if (action === 'recovery_swap') {
    if (adjustedMinutes) headline = `Easy ${adjustedMinutes} min today, you are carrying fatigue`;
    else if (adjustedDistance) headline = `Easy ${formatMiles(adjustedDistance)} today, you are carrying fatigue`;
    else headline = 'Easy 30 today, you are carrying fatigue';
  } else if (action === 'shorten') {
    if (adjustedMinutes) headline = `Shorten to ${adjustedMinutes} min today`;
    else if (adjustedDistance) headline = `Shorten to ${formatMiles(adjustedDistance)} today`;
    else headline = 'Shorten today, protect the streak';
  }

  if (drivers.length === 0 && readinessDelta > 0 && action === 'keep' && hasWorkoutToday) {
    headline = 'Keep today as planned, readiness looks good';
  }

  return { headline, drivers };
}

function applyOverride(day, patch = {}) {
  if (!day || !patch || typeof patch !== 'object') return day || null;
  return { ...day, ...patch };
}

module.exports = { deriveAction, buildPatch, buildDirective, applyOverride };
