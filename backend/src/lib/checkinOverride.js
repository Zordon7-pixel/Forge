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

function normalizeAxis(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3 ? parsed : null;
}

function hasAxes(checkin = {}) {
  return normalizeAxis(checkin.legs) !== null && normalizeAxis(checkin.drive) !== null;
}

function hasLowDrive(checkin = {}) {
  return hasAxes(checkin) && normalizeAxis(checkin.drive) === 1;
}

function parsePaceMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return 10;
  return Number(match[1]) + (Number(match[2]) / 60);
}

function estimateWorkoutMinutes(day = {}) {
  for (const key of ['duration_minutes', 'duration_min', 'minutes', 'time_minutes']) {
    const value = Number(day?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  for (const key of ['distance_miles', 'distance', 'miles']) {
    const miles = Number(day?.[key]);
    if (!Number.isFinite(miles) || miles <= 0) continue;
    const paceMinutes = parsePaceMinutes(day.pace_target || day.pace || day.target_pace);
    return miles * paceMinutes;
  }

  return null;
}

function deriveAction(checkin = {}) {
  const feeling = Number(checkin.feeling || 3);
  const legs = normalizeAxis(checkin.legs);
  const usesAxes = hasAxes(checkin);
  const timeAvailable = Number(checkin.time_available || 60);
  const sleepHours = checkin.sleep_hours === null || checkin.sleep_hours === undefined || checkin.sleep_hours === ''
    ? null
    : Number(checkin.sleep_hours);
  const flags = parseLifeFlags(checkin.life_flags);
  const hasFlag = (flag) => flags.includes(flag);

  if (hasFlag('sick') || hasFlag('injured') || (!usesAxes && feeling <= 1) || (sleepHours !== null && sleepHours < 4.5)) {
    return 'rest';
  }

  if ((usesAxes && legs === 1) || (!usesAxes && feeling <= 2) || hasFlag('sore') || (sleepHours !== null && sleepHours < 6)) {
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

function sessionLooksHard(day = {}) {
  const fields = [
    day.type,
    day.workout_type,
    day.title,
    day.name,
    day.intensity,
    day.target_zone,
    day.description,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(hard|tempo|threshold|interval|intervals|speed|race|vo2|quality|hill|hills|fartlek|zone 3|zone 4|zone 5|z3|z4|z5)\b/.test(fields);
}

function applyDriveCap(patch, action, checkin = {}, day = {}) {
  if (action === 'recovery_swap') return patch;
  if (!hasLowDrive(checkin) || !sessionLooksHard(day)) return patch;
  return {
    ...patch,
    intensity: 'Easy',
    target_zone: 'Zone 1-2',
    description: 'Easy effort from today\'s low-drive check-in.',
    checkin_override: {
      ...(patch.checkin_override || {}),
      action,
      label: 'Intensity capped from low drive check-in',
    },
  };
}

function buildPatch(action, day = {}, checkin = {}) {
  if (!day) return {};

  if (action === 'keep') {
    return applyDriveCap({}, action, checkin, day);
  }

  if (action === 'shorten') {
    const plannedMinutes = estimateWorkoutMinutes(day);
    const timeAvailable = Number(checkin.time_available);
    const timeMultiplier = Number.isFinite(timeAvailable) && timeAvailable > 0 && plannedMinutes && plannedMinutes > timeAvailable
      ? timeAvailable / plannedMinutes
      : 1;
    const multiplier = Math.min(0.65, timeMultiplier);
    const workloadPatch = {
      ...getDistancePatch(day, multiplier),
      ...getDurationPatch(day, multiplier),
    };
    const patch = {
      ...workloadPatch,
      checkin_override: { action, label: 'Shortened from daily check-in' },
    };
    const cappedPatch = applyDriveCap(patch, action, checkin, day);
    if (Object.keys(workloadPatch).length === 0 && cappedPatch === patch) return {};
    return cappedPatch;
  }

  if (action === 'recovery_swap') {
    const patch = {
      ...getDistancePatch(day, 0.5),
      type: 'recovery',
      workout_type: 'recovery',
      title: 'Recovery session',
      intensity: 'Recovery',
      target_zone: 'Zone 1-2',
      description: 'Recovery session from today\'s check-in.',
      checkin_override: { action, label: 'Swapped to recovery from daily check-in' },
    };
    return patch;
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
  const legs = normalizeAxis(checkin.legs);
  const drive = normalizeAxis(checkin.drive);
  const usesAxes = hasAxes(checkin);
  const timeAvailable = Number(checkin.time_available || 60);
  const sleepHours = checkin.sleep_hours === null || checkin.sleep_hours === undefined || checkin.sleep_hours === ''
    ? null
    : Number(checkin.sleep_hours);
  const flags = parseLifeFlags(checkin.life_flags);
  const hasFlag = (flag) => flags.includes(flag);
  const drivers = [];
  const hasPatch = patch && Object.keys(patch).length > 0;
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

  if (usesAxes && legs <= 2) {
    drivers.push({
      label: legs === 1 ? 'Legs heavy' : 'Legs okay',
      detail: legs === 1
        ? 'You checked in with heavy legs, so today shifts away from loading tired tissue.'
        : 'Your legs are not fully fresh, so today avoids adding unnecessary physical strain.',
    });
  } else if (!usesAxes && feeling <= 2) {
    drivers.push({
      label: 'Low feeling',
      detail: feeling <= 1
        ? 'You checked in at the lowest energy level, so today needs recovery before more training load.'
        : 'You checked in tired, so today shifts toward lower strain instead of forcing the original workload.',
    });
  }

  if (usesAxes && drive === 1) {
    drivers.push({
      label: 'Low drive',
      detail: 'You checked in flat, so today should stay controlled and avoid forcing hard intensity.',
    });
  }

  if (timeAvailable > 0 && (timeAvailable <= 30 || (action === 'shorten' && !hasFlag('long_shift') && !hasFlag('traveling')))) {
    drivers.push({
      label: 'Limited time',
      detail: hasPatch && action === 'shorten'
        ? 'You only have a short window, so the plan is trimmed to fit today instead of rushing the full session.'
        : hasPatch
          ? 'You only have a short window, so today is adjusted around the time you actually have.'
          : 'You only have a short window, but today stays as planned because there was no distance or duration to trim.',
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
    const reason = usesAxes && legs === 1 ? 'legs are heavy' : 'you are carrying fatigue';
    if (adjustedMinutes) headline = `Easy ${adjustedMinutes} min today, ${reason}`;
    else if (adjustedDistance) headline = `Easy ${formatMiles(adjustedDistance)} today, ${reason}`;
    else headline = `Easy recovery session today, ${reason}`;
  } else if (action === 'shorten') {
    if (adjustedMinutes) headline = `Shorten to ${adjustedMinutes} min today`;
    else if (adjustedDistance) headline = `Shorten to ${formatMiles(adjustedDistance)} today`;
    else headline = 'Shorten today, protect the streak';
  }

  if (usesAxes && drive === 1 && hasWorkoutToday && (action === 'keep' || action === 'shorten')) {
    headline = action === 'shorten'
      ? `${headline}, keep it easy`
      : 'Keep today easy, drive is low';
  }

  if (readinessDelta > 0 && action === 'keep' && hasWorkoutToday && !(usesAxes && drive === 1)) {
    headline = 'Keep today as planned, readiness looks good';
  }

  return { headline, drivers };
}

function applyOverride(day, patch = {}) {
  if (!day || !patch || typeof patch !== 'object') return day || null;
  return { ...day, ...patch };
}

module.exports = { deriveAction, buildPatch, buildDirective, applyOverride, estimateWorkoutMinutes };
