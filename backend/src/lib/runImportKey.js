const crypto = require('crypto');
const { activityKind } = require('./runActivity');

function cleanText(value, maximum = 200) {
  return String(value || '').trim().slice(0, maximum);
}

function hashKey(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function buildRunImportKeys({
  healthSource,
  sourceWorkoutId,
  startDate,
  type,
  watchActivityType,
  watchNormalizedType,
  distanceMiles,
  durationSeconds,
} = {}) {
  const source = cleanText(healthSource, 40).toLowerCase();
  if (!source) return [];

  const kind = activityKind({ type, watch_activity_type: watchActivityType, watch_normalized_type: watchNormalizedType });
  const keys = [];
  const sourceId = cleanText(sourceWorkoutId);
  if (sourceId) keys.push(`${source}:id:${hashKey([sourceId])}`);

  const start = cleanText(startDate, 80);
  const distance = Number(distanceMiles);
  const duration = Number(durationSeconds);
  if (start && Number.isFinite(distance) && Number.isFinite(duration)) {
    keys.push(`${source}:fingerprint:${hashKey([
      start,
      kind,
      Number(distance.toFixed(3)),
      Math.max(0, Math.round(duration)),
    ])}`);
  }

  return [...new Set(keys)];
}

module.exports = { buildRunImportKeys };
