const crypto = require('node:crypto');
const { activityKind } = require('./runActivity');

const MILE_M = 1609.344;
const FUZZY_START_WINDOW_MS = 3 * 60 * 1000;
const FUZZY_DISTANCE_RATIO = 0.01;
const FUZZY_DISTANCE_FLOOR_MILES = 0.02;
const FUZZY_DISTANCE_CEILING_MILES = 0.1;
const FUZZY_DURATION_RATIO = 0.12;
const FUZZY_DURATION_FLOOR_SECONDS = 30;
const FUZZY_DURATION_CEILING_SECONDS = 300;
const MAX_IDENTITY_RECEIPTS = 128;
const MAX_SUPPRESSED_REFS = 16;

const IDENTITY_REASON_CODES = Object.freeze({
  EXACT: 'ACTIVITY_IDENTITY_EXACT_DUPLICATE',
  FUZZY: 'ACTIVITY_IDENTITY_FUZZY_COLLISION',
  CROSS_SOURCE: 'ACTIVITY_IDENTITY_CROSS_SOURCE_CORROBORATION',
});

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value, maximum = 200) {
  return String(value || '').trim().slice(0, maximum);
}

function envelope(row = {}) {
  return row?.envelope && typeof row.envelope === 'object' ? row.envelope : row;
}

function normalizedSource(row = {}) {
  const value = envelope(row);
  return text(value.source_system || value.health_source || row.source || row.healthSource, 40).toLowerCase();
}

function providerActivityId(row = {}) {
  const value = envelope(row);
  return text(
    value.source_activity_id
      || value.health_source_workout_id
      || value.sourceWorkoutId
      || row.sourceWorkoutId,
  ) || null;
}

function activityType(row = {}) {
  const value = envelope(row);
  return text(
    value.value?.activity_kind
      || value.activity_kind
      || activityKind({ ...value, type: value.type || value.runType || row.runType }),
    40,
  ).toLowerCase();
}

function startTimestamp(row = {}) {
  const value = envelope(row);
  const raw = value.observed_at
    || value.health_start_at
    || value.activity_start_at
    || value.startDate
    || row.startDate;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function distanceMiles(row = {}) {
  const value = envelope(row);
  const direct = finite(value.distance_miles ?? value.distanceMiles ?? row.distanceMiles);
  if (direct !== null) return direct;
  const meters = finite(value.value?.distance_m ?? value.distance_m);
  return meters === null ? null : meters / MILE_M;
}

function durationSeconds(row = {}) {
  const value = envelope(row);
  return finite(value.value?.duration_s ?? value.duration_s ?? value.duration_seconds ?? value.durationSeconds ?? row.durationSeconds);
}

function internalReference(row = {}) {
  const value = envelope(row);
  return text(
    row.identity_reference
      || value.evidence_id
      || value.id
      || value.source_record_id
      || row.id,
  ) || null;
}

function distanceToleranceMiles(value) {
  const distance = Math.max(0, finite(value) || 0);
  return Math.min(
    FUZZY_DISTANCE_CEILING_MILES,
    Math.max(FUZZY_DISTANCE_FLOOR_MILES, distance * FUZZY_DISTANCE_RATIO),
  );
}

function durationToleranceSeconds(value) {
  const duration = Math.max(0, finite(value) || 0);
  return Math.min(
    FUZZY_DURATION_CEILING_SECONDS,
    Math.max(FUZZY_DURATION_FLOOR_SECONDS, duration * FUZZY_DURATION_RATIO),
  );
}

function activityIdentityMatch(left = {}, right = {}) {
  const source = normalizedSource(left);
  if (!source || source !== normalizedSource(right)) return null;
  const leftProviderId = providerActivityId(left);
  const rightProviderId = providerActivityId(right);
  if (leftProviderId && rightProviderId && leftProviderId === rightProviderId) {
    return IDENTITY_REASON_CODES.EXACT;
  }
  if (!activityType(left) || activityType(left) !== activityType(right)) return null;
  const leftStart = startTimestamp(left);
  const rightStart = startTimestamp(right);
  const leftDistance = distanceMiles(left);
  const rightDistance = distanceMiles(right);
  const leftDuration = durationSeconds(left);
  const rightDuration = durationSeconds(right);
  if (
    leftStart === null
    || rightStart === null
    || leftDistance === null
    || rightDistance === null
    || leftDistance <= 0
    || rightDistance <= 0
    || leftDuration === null
    || rightDuration === null
    || leftDuration <= 0
    || rightDuration <= 0
  ) return null;
  if (Math.abs(leftStart - rightStart) > FUZZY_START_WINDOW_MS) return null;
  if (Math.abs(leftDistance - rightDistance) > distanceToleranceMiles(Math.max(leftDistance, rightDistance))) return null;
  if (Math.abs(leftDuration - rightDuration) > durationToleranceSeconds(Math.max(leftDuration, rightDuration))) return null;
  return IDENTITY_REASON_CODES.FUZZY;
}

function privacySafeActivityRef(row = {}) {
  const identity = [
    internalReference(row),
    normalizedSource(row),
    providerActivityId(row),
    activityType(row),
    startTimestamp(row),
    distanceMiles(row),
    durationSeconds(row),
  ];
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function strongestReason(reasons = []) {
  if (reasons.includes(IDENTITY_REASON_CODES.FUZZY)) return IDENTITY_REASON_CODES.FUZZY;
  if (reasons.includes(IDENTITY_REASON_CODES.EXACT)) return IDENTITY_REASON_CODES.EXACT;
  if (reasons.includes(IDENTITY_REASON_CODES.CROSS_SOURCE)) return IDENTITY_REASON_CODES.CROSS_SOURCE;
  return null;
}

function buildActivityIdentityReceipt({ kept, suppressed = [], reasonCode } = {}) {
  const suppressedRefs = [...new Set(suppressed.map(privacySafeActivityRef))].sort();
  return Object.freeze({
    receipt_schema_version: 1,
    reason_code: reasonCode,
    kept_activity_ref: privacySafeActivityRef(kept),
    suppressed_activity_refs: Object.freeze(suppressedRefs.slice(0, MAX_SUPPRESSED_REFS)),
    suppressed_count: suppressedRefs.length,
    references_truncated: suppressedRefs.length > MAX_SUPPRESSED_REFS,
  });
}

function defaultKeptActivity(rows) {
  return [...rows].sort((left, right) => (
    String(internalReference(left) || '').localeCompare(String(internalReference(right) || ''))
    || privacySafeActivityRef(left).localeCompare(privacySafeActivityRef(right))
  ))[0];
}

function canonicalizeActivityRows(rows = [], { match = activityIdentityMatch, selectKept = null } = {}) {
  const groups = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const candidate = groups.find((group) => group.rows.every((existing) => Boolean(match(existing, row))));
    if (!candidate) {
      groups.push({ rows: [row], reasons: [] });
      continue;
    }
    candidate.reasons.push(...candidate.rows.map((existing) => match(existing, row)).filter(Boolean));
    candidate.rows.push(row);
  }
  const canonicalRows = [];
  const canonicalGroups = [];
  const receipts = [];
  for (const group of groups) {
    const kept = selectKept
      ? selectKept([...group.rows])
      : defaultKeptActivity(group.rows);
    canonicalRows.push(kept);
    const reasonCode = strongestReason(group.reasons);
    canonicalGroups.push(Object.freeze({
      kept,
      rows: Object.freeze([...group.rows]),
      reason_code: reasonCode,
    }));
    if (group.rows.length <= 1) continue;
    if (!reasonCode) continue;
    receipts.push(buildActivityIdentityReceipt({
      kept,
      suppressed: group.rows.filter((row) => row !== kept),
      reasonCode,
    }));
  }
  const boundedReceipts = receipts
    .sort((left, right) => left.kept_activity_ref.localeCompare(right.kept_activity_ref))
    .slice(0, MAX_IDENTITY_RECEIPTS);
  return Object.freeze({
    canonical_rows: Object.freeze(canonicalRows),
    canonical_groups: Object.freeze(canonicalGroups),
    identity_receipts: Object.freeze(boundedReceipts),
    raw_row_count: Array.isArray(rows) ? rows.length : 0,
    canonical_row_count: canonicalRows.length,
    receipt_count: receipts.length,
    receipts_truncated: receipts.length > MAX_IDENTITY_RECEIPTS,
  });
}

function validDateOnly(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function addUtcDays(dateOnly, amount) {
  const parsed = new Date(`${dateOnly}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function activityDate(row = {}) {
  const value = envelope(row);
  return validDateOnly(value.date)
    || validDateOnly(value.observed_at)
    || validDateOnly(value.health_start_at)
    || validDateOnly(value.startDate)
    || null;
}

function summarizeCanonicalActivityWindows(rows = [], { planningDateISO } = {}) {
  const planningDate = validDateOnly(planningDateISO);
  if (!planningDate) throw new Error('planningDateISO must be a valid YYYY-MM-DD date');
  const resolution = canonicalizeActivityRows(rows);
  const windows = {};
  for (const days of [7, 14, 21, 28, 42, 56]) {
    const cutoff = addUtcDays(planningDate, -(days - 1));
    const included = resolution.canonical_rows.filter((row) => {
      const date = activityDate(row);
      return date && date >= cutoff && date <= planningDate;
    });
    const miles = included.reduce((sum, row) => sum + Math.max(0, distanceMiles(row) || 0), 0);
    const seconds = included.reduce((sum, row) => sum + Math.max(0, durationSeconds(row) || 0), 0);
    windows[days] = Object.freeze({
      activity_count: included.length,
      distance_miles: Number(miles.toFixed(3)),
      duration_seconds: Math.round(seconds),
    });
  }
  return Object.freeze({ ...resolution, windows: Object.freeze(windows) });
}

module.exports = {
  FUZZY_DISTANCE_CEILING_MILES,
  FUZZY_DISTANCE_FLOOR_MILES,
  FUZZY_DISTANCE_RATIO,
  FUZZY_DURATION_CEILING_SECONDS,
  FUZZY_DURATION_FLOOR_SECONDS,
  FUZZY_DURATION_RATIO,
  FUZZY_START_WINDOW_MS,
  IDENTITY_REASON_CODES,
  activityIdentityMatch,
  buildActivityIdentityReceipt,
  canonicalizeActivityRows,
  distanceToleranceMiles,
  durationToleranceSeconds,
  privacySafeActivityRef,
  summarizeCanonicalActivityWindows,
};
