function normalizeDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function addDays(dateString, delta) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function serverUtcAnchorCandidates(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return [addDays(today, 1), today, addDays(today, -1)];
}

function computeBestStreak(uniqueDates) {
  let best = uniqueDates.length ? 1 : 0;
  let current = uniqueDates.length ? 1 : 0;
  for (let i = 1; i < uniqueDates.length; i += 1) {
    const expected = addDays(uniqueDates[i - 1], 1);
    current = uniqueDates[i] === expected ? current + 1 : 1;
    if (current > best) best = current;
  }
  return best;
}

function computeCurrentStreak(dateSet, anchorCandidates = serverUtcAnchorCandidates()) {
  const anchors = [...new Set((anchorCandidates || []).map(normalizeDate).filter(Boolean))]
    .sort()
    .reverse();
  const start = anchors.find((anchor) => dateSet.has(anchor));
  if (!start) return 0;

  let count = 0;
  let cursor = start;
  while (dateSet.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

function computeStreak(inputDates, anchorCandidates = serverUtcAnchorCandidates()) {
  const dateSet = inputDates instanceof Set
    ? new Set([...inputDates].map(normalizeDate).filter(Boolean))
    : new Set((inputDates || []).map(normalizeDate).filter(Boolean));
  const uniqueDates = [...dateSet].sort();
  return {
    current: computeCurrentStreak(dateSet, anchorCandidates),
    best: computeBestStreak(uniqueDates),
  };
}

module.exports = {
  addDays,
  computeStreak,
  serverUtcAnchorCandidates,
};
