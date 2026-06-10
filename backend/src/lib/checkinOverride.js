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

function applyOverride(day, patch = {}) {
  if (!day || !patch || typeof patch !== 'object') return day || null;
  return { ...day, ...patch };
}

module.exports = { deriveAction, buildPatch, applyOverride };
