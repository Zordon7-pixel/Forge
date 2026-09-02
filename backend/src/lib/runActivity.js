function activityTypeText(activity = {}) {
  return [
    activity.type,
    activity.run_type,
    activity.workout_type,
    activity.activity_kind,
    activity.watch_activity_type,
    activity.watch_normalized_type,
  ]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim().toLowerCase().replace(/[_-]+/g, ' '))
    .join(' ');
}

const ACTIVITY_KIND_MATCHERS = [
  ['walk', /\bwalk(?:ing)?\b/],
  ['cycling', /\b(?:cycl(?:e|ing)|bike|biking)\b/],
  ['swimming', /\bswim(?:ming)?\b/],
  ['hiking', /\bhik(?:e|ing)\b/],
  ['rowing', /\brow(?:ing)?\b/],
  ['elliptical', /\belliptical\b/],
  ['stairs', /\b(?:stair|stepper)\b/],
  ['yoga', /\b(?:yoga|pilates)\b/],
  ['hiit', /\bhiit\b|high intensity interval/],
  ['strength', /\b(?:strength|weightlifting|resistance)\b/],
  ['workout', /\b(?:workout|other)\b/],
];

function activityKind(activity = {}) {
  const text = activityTypeText(activity);
  const match = ACTIVITY_KIND_MATCHERS.find(([, regex]) => regex.test(text));
  return match?.[0] || 'run';
}

function isWalkActivity(activity = {}) {
  return activityKind(activity) === 'walk';
}

function isRunActivity(activity = {}) {
  return activityKind(activity) === 'run';
}

function runActivitySql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const typeText = `LOWER(COALESCE(${prefix}type, '') || ' ' || COALESCE(${prefix}watch_activity_type, '') || ' ' || COALESCE(${prefix}watch_normalized_type, ''))`;
  return [
    'walk', 'cycl', 'bike', 'swim', 'hik', 'row', 'elliptical', 'stair',
    'stepper', 'yoga', 'pilates', 'hiit', 'high intensity interval', 'strength',
    'weightlifting', 'resistance', 'workout', 'other',
  ].map((term) => `${typeText} NOT LIKE '%${term}%'`).join('\n    AND ');
}

function runListActivityFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return { kind: 'all', sql: null };
  if (normalized === 'run') return { kind: 'run', sql: runActivitySql() };
  return null;
}

module.exports = {
  activityKind,
  activityTypeText,
  isRunActivity,
  isWalkActivity,
  runActivitySql,
  runListActivityFilter,
};
