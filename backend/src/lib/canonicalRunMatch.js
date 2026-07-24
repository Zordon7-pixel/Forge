function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function distanceTolerance(distanceMiles) {
  const distance = Math.max(0, finiteNumber(distanceMiles) || 0);
  return Math.min(0.25, Math.max(0.1, distance * 0.05));
}

function durationTolerance(durationSeconds) {
  const duration = Math.max(0, finiteNumber(durationSeconds) || 0);
  return Math.min(300, Math.max(90, duration * 0.05));
}

function scoreForgedRunMatch(candidate = {}, incoming = {}) {
  if (candidate.health_source !== 'forged_hybrid') return null;

  const existingStart = timestampMs(candidate.health_start_at);
  const incomingStart = timestampMs(incoming.startDate);
  const existingDuration = finiteNumber(candidate.duration_seconds);
  const incomingDuration = finiteNumber(incoming.durationSeconds);
  const existingDistance = finiteNumber(candidate.distance_miles);
  const incomingDistance = finiteNumber(incoming.distanceMiles);
  if (
    existingStart === null
    || incomingStart === null
    || existingDuration === null
    || incomingDuration === null
    || existingDuration <= 0
    || incomingDuration <= 0
    || existingDistance === null
    || incomingDistance === null
    || existingDistance <= 0
    || incomingDistance <= 0
  ) {
    return null;
  }

  const startDeltaMs = Math.abs(existingStart - incomingStart);
  const durationDelta = Math.abs(existingDuration - incomingDuration);
  const distanceDelta = Math.abs(existingDistance - incomingDistance);
  const allowedStartMs = 5 * 60 * 1000;
  const allowedDuration = durationTolerance(incomingDuration);
  const allowedDistance = distanceTolerance(incomingDistance);
  if (
    startDeltaMs > allowedStartMs
    || durationDelta > allowedDuration
    || distanceDelta > allowedDistance
  ) {
    return null;
  }

  return (
    (startDeltaMs / allowedStartMs) * 0.6
    + (durationDelta / allowedDuration) * 0.2
    + (distanceDelta / allowedDistance) * 0.2
  );
}

function chooseForgedRunMatch(candidates, incoming, { excludeId = null } = {}) {
  const matches = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => !excludeId || candidate.id !== excludeId)
    .map((candidate) => ({ candidate, score: scoreForgedRunMatch(candidate, incoming) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => left.score - right.score);
  if (!matches.length) return null;
  if (matches.length > 1 && matches[1].score - matches[0].score < 0.15) return null;
  return matches[0].candidate;
}

module.exports = {
  chooseForgedRunMatch,
  distanceTolerance,
  durationTolerance,
  scoreForgedRunMatch,
};
