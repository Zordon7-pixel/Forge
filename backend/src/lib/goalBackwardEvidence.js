const {
  ATHLETE_STATE_SCHEMA_VERSION,
  CANONICAL_UNITS,
  EVIDENCE_SCHEMA_VERSION,
  PLANNING_POLICY_VERSION,
  findNonJsonValues,
  findRedactionViolations,
} = require('./goalBackwardContracts');
const { canonicalHash, canonicalStringify } = require('./racePlanPolicy');
const { activityKind } = require('./runActivity');
const {
  classifyProviderCoverage,
  healthMetricFreshness,
  modalityEligibility,
  valueStateForEmptyCoverage,
} = require('./healthCoverage');

const MILE_M = 1609.344;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMPORAL_FINGERPRINT_WINDOW_MS = 180 * 1000;
const TEMPORAL_DURATION_TOLERANCE_S = 2;
const ROUTE_POINT_TOLERANCE_M = 50;
const ROUTE_MATCH_MINIMUM = 0.8;
const DISTANCE_EQUIVALENCE_FLOOR_M = 0.02 * MILE_M;
const DISTANCE_EQUIVALENCE_RATIO = 0.005;
const HR_MEDIAN_TOLERANCE_BPM = 5;
const HR_COVERAGE_TOLERANCE_PCT = 3;
const STRESS_DIMENSIONS = Object.freeze([
  'aerobic',
  'running_impact',
  'lower_body_muscular',
  'upper_body_muscular',
  'grip',
  'neuromuscular',
  'metabolic',
  'event_specific_fatigue',
]);
const CONTEXT_REASON_CODES = Object.freeze({
  illness: 'ILLNESS_CONTEXT',
  injury: 'INJURY_CONTEXT',
  injury_restriction: 'INJURY_CONTEXT',
  travel: 'TRAVEL_CONTEXT',
  travel_disruption: 'TRAVEL_CONTEXT',
  taper: 'TAPER_CONTEXT',
  post_race_transition: 'POST_RACE_TRANSITION_CONTEXT',
  planned_break: 'PLANNED_BREAK_CONTEXT',
  data_outage: 'DATA_OUTAGE_CONTEXT',
});
const SAFETY_RANK = Object.freeze({
  NORMAL: 0,
  MONITOR: 1,
  MODIFY_IMPACT: 2,
  NO_HIGH_INTENSITY: 3,
  NO_RUNNING: 4,
  NO_LOWER_BODY: 4,
  MODIFIED_SESSION_ONLY: 5,
  PROFESSIONAL_ASSESSMENT_RECOMMENDED: 6,
  FULL_REST: 7,
});
const FRESHNESS_WINDOWS_MS = Object.freeze({
  sleep_duration: 36 * 60 * 60 * 1000,
  sleep_quality: 36 * 60 * 60 * 1000,
  hrv: 48 * 60 * 60 * 1000,
  resting_heart_rate: 48 * 60 * 60 * 1000,
  subjective_readiness: DAY_MS,
  threshold_evidence: 42 * DAY_MS,
  recent_race_same_distance: 180 * DAY_MS,
  recent_race_nearby_distance: 120 * DAY_MS,
  broad_equivalency: 28 * DAY_MS,
  interval_evidence: 42 * DAY_MS,
  compromised_run_benchmark: 28 * DAY_MS,
  hyrox_station_benchmark: 42 * DAY_MS,
  transition_benchmark: 42 * DAY_MS,
  body_weight: 30 * DAY_MS,
  shoe_inventory: 90 * DAY_MS,
});

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value === 'object') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch (_error) {
    return fallback;
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((nested) => deepFreeze(nested, seen));
  return Object.freeze(value);
}

function prefixedHash(value) {
  return `sha256:${canonicalHash(value)}`;
}

function isIanaTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(value || '') }).format(new Date());
    return Boolean(value);
  } catch (_error) {
    return false;
  }
}

function localDateInTimezone(instant, timezone) {
  if (!isIanaTimezone(timezone)) throw new Error('A valid IANA athlete timezone is required');
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error('A valid planning instant is required');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localDateDistance(later, earlier) {
  const laterMs = Date.parse(`${String(later || '').slice(0, 10)}T12:00:00.000Z`);
  const earlierMs = Date.parse(`${String(earlier || '').slice(0, 10)}T12:00:00.000Z`);
  return Number.isFinite(laterMs) && Number.isFinite(earlierMs)
    ? Math.round((laterMs - earlierMs) / DAY_MS)
    : null;
}

function sourceSystem(value) {
  const source = String(value || '').trim().toLowerCase();
  if (source === 'forged_hybrid' || source === 'forged_phone') return 'forge';
  if (source === 'garmin_csv' || source === 'watch_sync') return 'garmin';
  if (source === 'healthkit') return 'apple_health';
  if (['forge', 'fit', 'garmin', 'apple_health', 'health_connect', 'manual', 'import'].includes(source)) return source;
  return 'import';
}

function normalizeRoutePoints(raw) {
  const parsed = parseJson(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((point) => {
    const lat = finite(Array.isArray(point) ? point[0] : point?.lat);
    const lon = finite(Array.isArray(point) ? point[1] : point?.lon ?? point?.lng);
    return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
  }).filter(Boolean);
}

function radians(value) {
  return value * Math.PI / 180;
}

function pointDistanceM(left, right) {
  const latDelta = radians(right[0] - left[0]);
  const lonDelta = radians(right[1] - left[1]);
  const lat1 = radians(left[0]);
  const lat2 = radians(right[0]);
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeMatchRatio(leftRoute, rightRoute) {
  const left = normalizeRoutePoints(leftRoute);
  const right = normalizeRoutePoints(rightRoute);
  if (!left.length || !right.length) return null;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  const matched = shorter.filter((point) => (
    longer.some((candidate) => pointDistanceM(point, candidate) <= ROUTE_POINT_TOLERANCE_M)
  )).length;
  return matched / shorter.length;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function temporalRouteFingerprintMatch(left = {}, right = {}) {
  if (!left.athlete_id || left.athlete_id !== right.athlete_id) return false;
  if (!left.activity_kind || left.activity_kind !== right.activity_kind) return false;
  const leftStart = timestamp(left.observed_at);
  const rightStart = timestamp(right.observed_at);
  const leftDuration = finite(left.duration_s);
  const rightDuration = finite(right.duration_s);
  if (leftStart === null || rightStart === null || leftDuration === null || rightDuration === null) return false;
  if (Math.abs(leftStart - rightStart) > TEMPORAL_FINGERPRINT_WINDOW_MS) return false;
  if (Math.abs(leftDuration - rightDuration) > TEMPORAL_DURATION_TOLERANCE_S) return false;
  const leftRoute = normalizeRoutePoints(left.route_points);
  const rightRoute = normalizeRoutePoints(right.route_points);
  if (leftRoute.length && rightRoute.length) {
    return routeMatchRatio(leftRoute, rightRoute) >= ROUTE_MATCH_MINIMUM;
  }
  return true;
}

function routeFingerprint(points) {
  const route = normalizeRoutePoints(points);
  if (!route.length) return null;
  const bounded = route.map(([lat, lon]) => [Number(lat.toFixed(5)), Number(lon.toFixed(5))]);
  return prefixedHash(bounded);
}

function runEvidenceRecord(row, athleteId, timezone) {
  const metrics = parseJson(row.workout_metrics_json, {});
  const routePoints = normalizeRoutePoints(row.route_coords);
  const distanceMiles = finite(row.distance_miles);
  const durationSeconds = finite(row.duration_seconds);
  const distanceM = distanceMiles !== null && distanceMiles > 0 ? Math.round(distanceMiles * MILE_M) : null;
  const durationS = durationSeconds !== null && durationSeconds > 0 ? Math.round(durationSeconds) : null;
  const avgHeartRate = finite(row.avg_heart_rate);
  const hrSampleCoverage = finite(metrics.hr_sample_coverage_pct);
  const perceivedEffort = finite(row.perceived_effort);
  const observedAt = row.health_start_at || row.activity_start_at || (row.date ? `${String(row.date).slice(0, 10)}T12:00:00.000Z` : null);
  const receivedAt = row.created_at || observedAt || new Date(0).toISOString();
  const source = sourceSystem(row.health_source || metrics.distance_source || row.watch_mode || 'manual');
  const invalidMeasurement = (distanceMiles !== null && distanceMiles < 0) || (durationSeconds !== null && durationSeconds < 0);
  const qualityState = invalidMeasurement ? 'CORRUPTED' : distanceM === null || durationS === null ? 'PARTIAL' : 'COMPLETE';
  const valueState = distanceM === null || durationS === null ? 'MISSING' : 'KNOWN';
  const sourceActivityId = String(row.health_source_workout_id || row.watch_sync_id || '').trim() || null;
  const evidenceId = String(row.id || '').trim();
  const envelope = {
    evidence_id: evidenceId,
    athlete_id: athleteId,
    evidence_type: source === 'fit' ? 'fit_activity' : 'completed_workout',
    truth_class: 'OBSERVED',
    value: {
      activity_kind: activityKind(row),
      distance_m: distanceM,
      duration_s: durationS,
      avg_heart_rate_bpm: avgHeartRate !== null && avgHeartRate > 0 && avgHeartRate <= 260 ? avgHeartRate : null,
      hr_sample_coverage_pct: hrSampleCoverage !== null && hrSampleCoverage > 0 && hrSampleCoverage <= 100 ? hrSampleCoverage : null,
      perceived_effort: perceivedEffort !== null && perceivedEffort >= 1 && perceivedEffort <= 10 ? perceivedEffort : null,
      route_fingerprint: routeFingerprint(routePoints),
      route_point_count: routePoints.length,
    },
    canonical_unit: 'm',
    source_system: source,
    source_record_id: evidenceId || null,
    source_activity_id: sourceActivityId,
    observed_at: observedAt,
    recorded_at: receivedAt,
    received_at: receivedAt,
    athlete_timezone: timezone,
    quality_state: qualityState,
    value_state: valueState,
    freshness_class: 'TIMELESS',
    supersedes_evidence_id: null,
    linked_session_id: row.plan_session_id || null,
    confidence: qualityState === 'COMPLETE' && source === 'fit' ? 'HIGH' : qualityState === 'COMPLETE' ? 'MEDIUM' : 'INSUFFICIENT',
    provenance: {
      import_job_id: metrics.import_job_id || null,
      provider_payload_hash: /^sha256:[a-f0-9]{64}$/.test(String(metrics.provider_payload_hash || ''))
        ? metrics.provider_payload_hash
        : null,
      manual_correction_reason: null,
    },
  };
  return { envelope, routePoints };
}

function liftEvidenceEnvelope(row, athleteId, timezone) {
  const evidenceId = String(row.id || '').trim();
  const observedAt = row.started_at || (row.date ? `${String(row.date).slice(0, 10)}T12:00:00.000Z` : null);
  const recordedAt = row.created_at || observedAt;
  const duration = finite(row.workout_duration_seconds);
  const watchSyncId = String(row.watch_sync_id || '').trim() || null;
  const source = watchSyncId ? 'garmin' : 'forge';
  return {
    evidence_id: evidenceId,
    athlete_id: athleteId,
    evidence_type: 'completed_workout',
    truth_class: 'OBSERVED',
    value: {
      activity_kind: 'lift',
      duration_s: duration !== null && duration > 0 ? Math.round(duration) : null,
      category: String(row.category || 'strength').slice(0, 40),
      intensity: String(row.intensity || '').slice(0, 24) || null,
      sets: finite(row.sets),
      reps: finite(row.reps),
      external_load_kg: finite(row.weight_lbs) === null ? null : Number((row.weight_lbs * 0.45359237).toFixed(3)),
      avg_heart_rate_bpm: finite(row.avg_heart_rate),
    },
    canonical_unit: 'ordinal',
    source_system: source,
    source_record_id: evidenceId || null,
    source_activity_id: watchSyncId,
    observed_at: observedAt,
    recorded_at: recordedAt,
    received_at: recordedAt,
    athlete_timezone: timezone,
    quality_state: duration !== null && duration > 0 ? 'COMPLETE' : 'PARTIAL',
    value_state: duration !== null && duration > 0 ? 'KNOWN' : 'MISSING',
    freshness_class: 'TIMELESS',
    supersedes_evidence_id: null,
    linked_session_id: row.plan_session_id || null,
    confidence: watchSyncId ? 'HIGH' : 'MEDIUM',
    provenance: { import_job_id: null, provider_payload_hash: null, manual_correction_reason: null },
  };
}

function checkInEvidenceEnvelope(row, athleteId, timezone, planningInstant) {
  const evidenceId = String(row.id || '').trim();
  const date = String(row.checkin_date || row.date || '').slice(0, 10);
  const observedAt = row.observed_at || (date ? `${date}T12:00:00.000Z` : row.created_at || null);
  const parsedLifeFlags = Array.isArray(row.life_flags) ? row.life_flags : parseJson(row.life_flags, []);
  const lifeFlags = [...new Set((Array.isArray(parsedLifeFlags) ? parsedLifeFlags : [])
    .map((flag) => String(flag || '').trim().toLowerCase()).filter(Boolean))].sort();
  const envelope = {
    evidence_id: evidenceId,
    athlete_id: athleteId,
    evidence_type: 'subjective_readiness',
    truth_class: 'OBSERVED',
    value: {
      feeling: finite(row.feeling),
      legs: finite(row.legs),
      drive: finite(row.drive),
      time_available_minutes: finite(row.time_available),
      sleep_hours: finite(row.sleep_hours),
      life_flags: lifeFlags,
      local_date: date || null,
    },
    canonical_unit: 'ordinal',
    source_system: 'forge',
    source_record_id: evidenceId || null,
    source_activity_id: null,
    observed_at: observedAt,
    recorded_at: row.created_at || observedAt,
    received_at: row.created_at || observedAt,
    athlete_timezone: timezone,
    quality_state: 'COMPLETE',
    value_state: 'KNOWN',
    freshness_class: 'EXPIRED',
    supersedes_evidence_id: null,
    linked_session_id: null,
    confidence: 'HIGH',
    provenance: { import_job_id: null, provider_payload_hash: null, manual_correction_reason: null },
  };
  envelope.freshness_class = freshnessForEvidence(envelope, planningInstant);
  return envelope;
}

function coverageEvidenceEnvelope(row, athleteId, timezone, planningInstant) {
  const coverage = row?.quality_state && Array.isArray(row.modalities) ? row : classifyProviderCoverage(row);
  const identity = [coverage.source_system, coverage.coverage_start_local, coverage.coverage_end_local, coverage.modalities];
  const evidenceId = String(row.id || '').trim() || `coverage-${canonicalHash(identity).slice(0, 24)}`;
  return {
    evidence_id: evidenceId,
    athlete_id: athleteId,
    evidence_type: 'provider_coverage',
    truth_class: 'OBSERVED',
    value: {
      modalities: coverage.modalities,
      coverage_start_local: coverage.coverage_start_local,
      coverage_end_local: coverage.coverage_end_local,
      complete: coverage.complete,
    },
    canonical_unit: null,
    source_system: sourceSystem(coverage.source_system),
    source_record_id: evidenceId,
    source_activity_id: null,
    observed_at: planningInstant.toISOString(),
    recorded_at: planningInstant.toISOString(),
    received_at: planningInstant.toISOString(),
    athlete_timezone: timezone,
    quality_state: coverage.quality_state,
    value_state: coverage.complete ? 'KNOWN' : 'UNKNOWN',
    freshness_class: 'FRESH',
    supersedes_evidence_id: null,
    linked_session_id: null,
    confidence: coverage.complete ? 'HIGH' : 'INSUFFICIENT',
    provenance: { import_job_id: null, provider_payload_hash: null, manual_correction_reason: null },
  };
}

function correctionEvidenceEnvelope(row, athleteId, timezone) {
  return {
    evidence_id: String(row.id),
    athlete_id: athleteId,
    evidence_type: 'manual_correction',
    truth_class: 'OBSERVED',
    value: {
      raw_evidence_kind: 'run',
      raw_evidence_ref: String(row.raw_evidence_ref),
      field: 'distance_m',
      corrected_value: correctionValue(row),
      correction_revision: Number(row.revision),
      reason_code: 'MANUAL_CORRECTION_APPLIED',
    },
    canonical_unit: row.canonical_unit || 'm',
    source_system: 'manual',
    source_record_id: String(row.id),
    source_activity_id: null,
    observed_at: row.created_at,
    recorded_at: row.created_at,
    received_at: row.created_at,
    athlete_timezone: timezone,
    quality_state: 'COMPLETE',
    value_state: 'KNOWN',
    freshness_class: 'TIMELESS',
    supersedes_evidence_id: row.supersedes_correction_id || String(row.raw_evidence_ref),
    linked_session_id: null,
    confidence: 'HIGH',
    provenance: {
      import_job_id: null,
      provider_payload_hash: null,
      manual_correction_reason: 'athlete_attributed_correction',
    },
  };
}

function normalizeSafetyReport(row, athleteId, timezone, evidenceType) {
  const id = String(row.id || '').trim();
  const observedAt = row.observed_at || row.created_at || null;
  const resolved = row.resolved === true
    || row.recovered === true
    || String(row.pain_level || '').toLowerCase() === 'none'
    || String(row.status || '').toLowerCase() === 'resolved';
  const defaultAction = evidenceType === 'illness_report' ? 'NO_HIGH_INTENSITY' : 'MONITOR';
  const action = resolved ? 'NORMAL' : String(row.safety_action || defaultAction).toUpperCase();
  const scope = resolved ? [] : [...new Set((Array.isArray(row.safety_scope) ? row.safety_scope : [])
    .map((value) => String(value || '').trim()).filter(Boolean))].sort();
  return {
    evidence_id: id,
    athlete_id: athleteId,
    evidence_type: evidenceType,
    truth_class: 'OBSERVED',
    value: { active: !resolved, safety_action: SAFETY_RANK[action] === undefined ? defaultAction : action, safety_scope: scope },
    canonical_unit: null,
    source_system: 'manual',
    source_record_id: id || null,
    source_activity_id: null,
    observed_at: observedAt,
    recorded_at: row.created_at || observedAt,
    received_at: row.created_at || observedAt,
    athlete_timezone: timezone,
    quality_state: 'COMPLETE',
    value_state: 'KNOWN',
    freshness_class: 'FRESH',
    supersedes_evidence_id: row.supersedes_evidence_id || null,
    linked_session_id: null,
    confidence: 'HIGH',
    provenance: { import_job_id: null, provider_payload_hash: null, manual_correction_reason: null },
  };
}

function freshnessForEvidence(evidence, planningInstant) {
  if (!evidence || typeof evidence !== 'object') return 'EXPIRED';
  if (evidence.evidence_type === 'completed_workout' || evidence.evidence_type === 'fit_activity') return 'TIMELESS';
  if (evidence.evidence_type === 'pain_report' || evidence.evidence_type === 'illness_report') {
    return evidence.value?.active === false ? 'TIMELESS' : 'FRESH';
  }
  if (evidence.evidence_type === 'subjective_readiness') {
    try {
      return (evidence.value?.local_date || localDateInTimezone(evidence.observed_at, evidence.athlete_timezone))
        === localDateInTimezone(planningInstant, evidence.athlete_timezone)
        ? 'FRESH'
        : 'EXPIRED';
    } catch (_error) {
      return 'EXPIRED';
    }
  }
  const windowMs = FRESHNESS_WINDOWS_MS[evidence.evidence_type];
  const observedMs = timestamp(evidence.observed_at);
  const planningMs = timestamp(planningInstant);
  if (!windowMs || observedMs === null || planningMs === null || observedMs > planningMs) return 'EXPIRED';
  return planningMs - observedMs <= windowMs ? 'FRESH' : 'STALE';
}

function correctionValue(raw) {
  const value = parseJson(raw.corrected_canonical_value_json, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = String(value.field || 'distance_m');
  const numeric = finite(value.value ?? value.distance_m);
  return field === 'distance_m' && numeric !== null && numeric > 0 ? Math.round(numeric) : null;
}

function validCorrection(row, athleteId) {
  return row
    && String(row.user_id || '') === athleteId
    && String(row.raw_evidence_kind || '') === 'run'
    && String(row.reason_code || 'MANUAL_CORRECTION_APPLIED') === 'MANUAL_CORRECTION_APPLIED'
    && Number.isSafeInteger(Number(row.revision))
    && Number(row.revision) >= 1
    && String(row.reason || '').trim().length >= 1
    && String(row.attributed_by_user_id || '') === athleteId
    && correctionValue(row) !== null;
}

function latestCorrections(rows, athleteId) {
  const latest = new Map();
  for (const correction of Array.isArray(rows) ? rows : []) {
    if (!validCorrection(correction, athleteId)) continue;
    const ref = String(correction.raw_evidence_ref || '');
    const current = latest.get(ref);
    if (!current || Number(correction.revision) > Number(current.revision)) latest.set(ref, correction);
  }
  return latest;
}

function distanceEquivalent(left, right) {
  const leftDistance = finite(left);
  const rightDistance = finite(right);
  if (leftDistance === null || rightDistance === null) return false;
  const tolerance = Math.max(DISTANCE_EQUIVALENCE_FLOOR_M, Math.max(leftDistance, rightDistance) * DISTANCE_EQUIVALENCE_RATIO);
  return Math.abs(leftDistance - rightDistance) <= tolerance;
}

function preferredActivity(records) {
  const priority = { fit: 5, forge: 4, garmin: 3, apple_health: 2, health_connect: 2, manual: 1, import: 0 };
  return [...records].sort((left, right) => {
    const sampleDelta = finite(right.envelope.value?.route_point_count) - finite(left.envelope.value?.route_point_count);
    const qualityDelta = Number(right.envelope.quality_state === 'COMPLETE') - Number(left.envelope.quality_state === 'COMPLETE');
    return qualityDelta
      || (priority[right.envelope.source_system] || 0) - (priority[left.envelope.source_system] || 0)
      || (Number.isFinite(sampleDelta) ? sampleDelta : 0)
      || left.envelope.evidence_id.localeCompare(right.envelope.evidence_id);
  })[0];
}

function deduplicateActivityRecords(records, corrections) {
  const groups = [];
  for (const record of records) {
    const comparable = {
      athlete_id: record.envelope.athlete_id,
      activity_kind: record.envelope.value.activity_kind,
      observed_at: record.envelope.observed_at,
      duration_s: record.envelope.value.duration_s,
      route_points: record.routePoints,
    };
    const group = groups.find((candidate) => candidate.some((existing) => {
      const leftSourceId = existing.envelope.source_activity_id;
      const sameStableIdentity = leftSourceId && record.envelope.source_activity_id
        && existing.envelope.source_system === record.envelope.source_system
        && leftSourceId === record.envelope.source_activity_id;
      if (sameStableIdentity) return true;
      return temporalRouteFingerprintMatch({
        athlete_id: existing.envelope.athlete_id,
        activity_kind: existing.envelope.value.activity_kind,
        observed_at: existing.envelope.observed_at,
        duration_s: existing.envelope.value.duration_s,
        route_points: existing.routePoints,
      }, comparable);
    }));
    if (group) group.push(record);
    else groups.push([record]);
  }
  return groups.map((group) => {
    const preferred = preferredActivity(group);
    const preferredDistance = preferredActivity(group.filter((record) => record.envelope.value.distance_m !== null)) || preferred;
    const preferredDuration = preferredActivity(group.filter((record) => record.envelope.value.duration_s !== null)) || preferred;
    const distances = group.map((record) => record.envelope.value.distance_m).filter((value) => value !== null);
    const distanceConflict = distances.some((distance) => !distanceEquivalent(distance, preferredDistance.envelope.value.distance_m));
    const durations = group.map((record) => record.envelope.value.duration_s).filter((value) => value !== null);
    const durationConflict = durations.some((duration) => (
      preferredDuration.envelope.value.duration_s !== null
      && Math.abs(duration - preferredDuration.envelope.value.duration_s) > TEMPORAL_DURATION_TOLERANCE_S
    ));
    const evidenceIds = group.map((record) => record.envelope.evidence_id).sort();
    const applicableCorrections = evidenceIds.map((id) => corrections.get(id)).filter(Boolean)
      .sort((left, right) => Number(right.revision) - Number(left.revision));
    const correction = applicableCorrections[0] || null;
    const resolvedDistance = correction ? correctionValue(correction) : distanceConflict ? null : preferredDistance.envelope.value.distance_m;
    const resolvedDuration = durationConflict ? null : preferredDuration.envelope.value.duration_s;
    const distanceQualityState = distanceConflict && !correction ? 'CONFLICT' : resolvedDistance === null ? 'PARTIAL' : 'COMPLETE';
    const durationQualityState = durationConflict ? 'CONFLICT' : resolvedDuration === null ? 'PARTIAL' : 'COMPLETE';
    const heartRateEvidence = group.map((record) => ({
      evidence_id: record.envelope.evidence_id,
      source_system: record.envelope.source_system,
      quality_state: record.envelope.quality_state,
      value: {
        median_bpm: record.envelope.value.avg_heart_rate_bpm,
        duration_coverage_pct: record.envelope.value.hr_sample_coverage_pct,
      },
    }));
    const heartRateResolution = resolveHeartRateEvidence(heartRateEvidence);
    return {
      canonical_activity_id: `activity-${canonicalHash(evidenceIds).slice(0, 24)}`,
      activity_kind: preferred.envelope.value.activity_kind,
      observed_at: preferred.envelope.observed_at,
      distance_m: resolvedDistance,
      duration_s: resolvedDuration,
      source_system: preferredDistance.envelope.source_system,
      source_activity_id: preferredDistance.envelope.source_activity_id,
      evidence_ids: evidenceIds,
      corroborating_source_systems: [...new Set(group.map((record) => record.envelope.source_system))].sort(),
      quality_state: distanceQualityState === 'CONFLICT' || durationQualityState === 'CONFLICT'
        ? 'CONFLICT'
        : distanceQualityState === 'PARTIAL' || durationQualityState === 'PARTIAL' ? 'PARTIAL' : 'COMPLETE',
      value_state: resolvedDistance === null && resolvedDuration === null ? 'UNKNOWN' : 'KNOWN',
      distance_quality_state: distanceQualityState,
      duration_quality_state: durationQualityState,
      correction_id: correction?.id || null,
      correction_revision: correction ? Number(correction.revision) : null,
      heart_rate_resolution: heartRateResolution,
      reason_codes: [
        ...(distanceConflict && !correction ? ['EVIDENCE_CONFLICT_UNRESOLVED'] : []),
        ...(durationConflict ? ['EVIDENCE_CONFLICT_UNRESOLVED'] : []),
        ...(resolvedDistance === null && !distanceConflict ? ['EVIDENCE_MISSING'] : []),
        ...(resolvedDuration === null && !durationConflict ? ['EVIDENCE_MISSING'] : []),
        ...(heartRateResolution.quality_state === 'CONFLICT' ? ['EVIDENCE_CONFLICT_UNRESOLVED'] : []),
        ...(correction ? ['MANUAL_CORRECTION_APPLIED'] : []),
      ],
    };
  });
}

function normalizedProviderCoverage(rows) {
  return (Array.isArray(rows) ? rows : []).map(classifyProviderCoverage).sort((left, right) => (
    left.source_system.localeCompare(right.source_system)
    || String(left.coverage_start_local || '').localeCompare(String(right.coverage_start_local || ''))
    || String(left.coverage_end_local || '').localeCompare(String(right.coverage_end_local || ''))
    || canonicalStringify(left.modalities).localeCompare(canonicalStringify(right.modalities))
  ));
}

function buildEvidenceSnapshot({
  athleteId,
  planningInstant = new Date(),
  timezone,
  runs = [],
  lifts = [],
  checkIns = [],
  painReports = [],
  illnessReports = [],
  providerCoverage = [],
  corrections = [],
} = {}) {
  const scopedAthleteId = String(athleteId || '').trim();
  if (!scopedAthleteId) throw new Error('buildEvidenceSnapshot requires athleteId');
  const planningAt = new Date(planningInstant);
  if (Number.isNaN(planningAt.getTime())) throw new Error('buildEvidenceSnapshot requires a valid planning instant');
  if (!isIanaTimezone(timezone)) throw new Error('buildEvidenceSnapshot requires an IANA athlete timezone');
  const runRecords = (Array.isArray(runs) ? runs : []).map((row) => runEvidenceRecord(row, scopedAthleteId, timezone));
  const safetyEvidence = [
    ...(Array.isArray(painReports) ? painReports : []).map((row) => normalizeSafetyReport(row, scopedAthleteId, timezone, 'pain_report')),
    ...(Array.isArray(illnessReports) ? illnessReports : []).map((row) => normalizeSafetyReport(row, scopedAthleteId, timezone, 'illness_report')),
  ].map((evidence) => ({ ...evidence, freshness_class: freshnessForEvidence(evidence, planningAt) }));
  const validCorrectionRows = (Array.isArray(corrections) ? corrections : [])
    .filter((row) => validCorrection(row, scopedAthleteId))
    .sort((left, right) => (
      String(left.raw_evidence_ref).localeCompare(String(right.raw_evidence_ref))
      || Number(left.revision) - Number(right.revision)
      || String(left.id).localeCompare(String(right.id))
    ));
  const correctionMap = latestCorrections(validCorrectionRows, scopedAthleteId);
  const correctionEvidence = validCorrectionRows.map((row) => correctionEvidenceEnvelope(row, scopedAthleteId, timezone));
  const liftEvidence = (Array.isArray(lifts) ? lifts : []).map((row) => liftEvidenceEnvelope(row, scopedAthleteId, timezone));
  const checkInEvidence = (Array.isArray(checkIns) ? checkIns : []).map((row) => (
    checkInEvidenceEnvelope(row, scopedAthleteId, timezone, planningAt)
  ));
  runRecords.sort((left, right) => (
    String(left.envelope.observed_at || '').localeCompare(String(right.envelope.observed_at || ''))
    || left.envelope.evidence_id.localeCompare(right.envelope.evidence_id)
  ));
  const canonicalActivities = deduplicateActivityRecords(runRecords, correctionMap)
    .sort((left, right) => String(left.observed_at || '').localeCompare(String(right.observed_at || ''))
      || left.canonical_activity_id.localeCompare(right.canonical_activity_id));
  const coverage = normalizedProviderCoverage(providerCoverage);
  const coverageEvidence = coverage.map((row) => coverageEvidenceEnvelope(row, scopedAthleteId, timezone, planningAt));
  const runningCoverage = coverage.filter((row) => row.modalities.includes('running'));
  const runningActivities = canonicalActivities.filter((activity) => activity.activity_kind === 'run');
  const activityValueState = runningActivities.some((activity) => activity.distance_m === null)
    ? 'UNKNOWN'
    : runningActivities.length ? 'KNOWN' : valueStateForEmptyCoverage(runningCoverage);
  const activityValue = activityValueState === 'KNOWN'
    ? runningActivities.reduce((sum, activity) => sum + (activity.distance_m || 0), 0)
    : activityValueState === 'VALID_ZERO' ? 0 : null;
  const evidence = [
    ...runRecords.map((record) => record.envelope),
    ...liftEvidence,
    ...checkInEvidence,
    ...safetyEvidence,
    ...correctionEvidence,
    ...coverageEvidence,
  ].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
  const distanceConflicts = canonicalActivities.filter((activity) => activity.distance_quality_state === 'CONFLICT');
  const durationConflicts = canonicalActivities.filter((activity) => activity.duration_quality_state === 'CONFLICT');
  const heartRateConflicts = canonicalActivities.filter((activity) => activity.heart_rate_resolution.quality_state === 'CONFLICT');
  const reasonCodes = [...new Set([
    ...coverage.flatMap((row) => row.reason_codes),
    ...canonicalActivities.flatMap((activity) => activity.reason_codes),
    ...(activityValueState === 'VALID_ZERO' ? ['VALID_ZERO_CONFIRMED'] : []),
    ...(activityValueState === 'UNKNOWN' && !coverage.length ? ['EVIDENCE_UNKNOWN'] : []),
  ])].sort();
  const planningDateLocal = localDateInTimezone(planningAt, timezone);
  const payload = {
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    policy_version: PLANNING_POLICY_VERSION,
    created_at: planningAt.toISOString(),
    athlete_id: scopedAthleteId,
    planning_date_local: planningDateLocal,
    timezone,
    evidence,
    canonical_activities: canonicalActivities,
    included_evidence_ids: [...new Set(evidence.filter((item) => item.quality_state !== 'CORRUPTED').map((item) => item.evidence_id))].sort(),
    excluded_evidence: [
      ...distanceConflicts.flatMap((activity) => activity.evidence_ids.map((evidenceId) => ({
        evidence_id: evidenceId,
        field: 'distance_m',
        reason_code: 'EVIDENCE_CONFLICT_UNRESOLVED',
      }))),
      ...durationConflicts.flatMap((activity) => activity.evidence_ids.map((evidenceId) => ({
        evidence_id: evidenceId,
        field: 'duration_s',
        reason_code: 'EVIDENCE_CONFLICT_UNRESOLVED',
      }))),
      ...heartRateConflicts.flatMap((activity) => activity.evidence_ids.map((evidenceId) => ({
        evidence_id: evidenceId,
        field: 'heart_rate',
        reason_code: 'EVIDENCE_CONFLICT_UNRESOLVED',
      }))),
    ],
    stale_evidence_ids: evidence.filter((item) => item.freshness_class === 'STALE').map((item) => item.evidence_id).sort(),
    partial_sync_sources: [...new Set(coverage.filter((row) => row.quality_state === 'PARTIAL').map((row) => row.source_system))].sort(),
    failed_sync_sources: [...new Set(coverage.filter((row) => row.quality_state === 'FAILED_SYNC').map((row) => row.source_system))].sort(),
    unresolved_conflicts: [
      ...distanceConflicts.map((activity) => ({ field: 'distance_m', evidence_ids: activity.evidence_ids, reason_code: 'EVIDENCE_CONFLICT_UNRESOLVED' })),
      ...durationConflicts.map((activity) => ({ field: 'duration_s', evidence_ids: activity.evidence_ids, reason_code: 'EVIDENCE_CONFLICT_UNRESOLVED' })),
      ...heartRateConflicts.map((activity) => ({ field: 'heart_rate', evidence_ids: activity.evidence_ids, reason_code: 'EVIDENCE_CONFLICT_UNRESOLVED' })),
    ],
    provider_coverage_intervals: coverage,
    modality_eligibility: modalityEligibility(coverage),
    activity_summary: { value_state: activityValueState, value: activityValue, canonical_unit: 'm' },
    source_row_counts: {
      runs: runRecords.length,
      lifts: Array.isArray(lifts) ? lifts.length : 0,
      check_ins: Array.isArray(checkIns) ? checkIns.length : 0,
    },
    reason_codes: reasonCodes,
  };
  const canonicalHashValue = prefixedHash(payload);
  return deepFreeze({
    evidence_snapshot_id: `evidence-snapshot-${canonicalHashValue.slice(-24)}`,
    ...payload,
    canonical_hash: canonicalHashValue,
  });
}

function resolveHeartRateEvidence(rows = []) {
  const eligible = (Array.isArray(rows) ? rows : []).filter((row) => (
    row?.quality_state === 'COMPLETE'
    && finite(row?.value?.median_bpm) > 0
    && finite(row?.value?.duration_coverage_pct) > 0
    && finite(row?.value?.duration_coverage_pct) <= 100
  ));
  if (!eligible.length) {
    return { quality_state: 'PARTIAL', value_state: 'UNKNOWN', value: null, target_fallback: 'HR_RPE_FALLBACK', reason_codes: ['EVIDENCE_UNKNOWN'] };
  }
  const conflict = eligible.some((left, index) => eligible.slice(index + 1).some((right) => (
    Math.abs(left.value.median_bpm - right.value.median_bpm) > HR_MEDIAN_TOLERANCE_BPM
    || Math.abs(left.value.duration_coverage_pct - right.value.duration_coverage_pct) > HR_COVERAGE_TOLERANCE_PCT
  )));
  if (conflict) {
    return {
      quality_state: 'CONFLICT',
      value_state: 'UNKNOWN',
      value: null,
      evidence_ids: eligible.map((row) => row.evidence_id).sort(),
      target_fallback: 'HR_RPE_FALLBACK',
      reason_codes: ['EVIDENCE_CONFLICT_UNRESOLVED', 'HR_RPE_FALLBACK'],
    };
  }
  const mostGranular = [...eligible].sort((left, right) => (
    right.value.duration_coverage_pct - left.value.duration_coverage_pct
    || left.evidence_id.localeCompare(right.evidence_id)
  ))[0];
  return {
    quality_state: 'COMPLETE',
    value_state: 'KNOWN',
    value: mostGranular.value.median_bpm,
    evidence_ids: eligible.map((row) => row.evidence_id).sort(),
    target_fallback: null,
    reason_codes: [],
  };
}

function resolvePerformanceEvidence(rows = [], planningInstant = new Date()) {
  const thresholds = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.evidence_type === 'threshold_evidence')
    .sort((left, right) => (timestamp(right.observed_at) || 0) - (timestamp(left.observed_at) || 0));
  const threshold = thresholds[0];
  if (!threshold || threshold.quality_state !== 'COMPLETE' || threshold.value_state !== 'KNOWN') {
    return {
      threshold_pace_seconds_per_mile: null,
      freshness_class: threshold ? freshnessForEvidence(threshold, planningInstant) : 'EXPIRED',
      fallback: 'HR_RPE_FALLBACK',
      reason_codes: ['PACE_EVIDENCE_MISSING', 'HR_RPE_FALLBACK'],
    };
  }
  const freshnessClass = freshnessForEvidence(threshold, planningInstant);
  if (freshnessClass !== 'FRESH') {
    return {
      threshold_pace_seconds_per_mile: null,
      freshness_class: freshnessClass,
      fallback: 'HR_RPE_FALLBACK',
      reason_codes: ['PACE_EVIDENCE_STALE', 'HR_RPE_FALLBACK'],
    };
  }
  const pace = finite(threshold.value?.pace_seconds_per_mile);
  return pace !== null && pace > 0
    ? { threshold_pace_seconds_per_mile: pace, freshness_class: 'FRESH', fallback: null, reason_codes: [] }
    : { threshold_pace_seconds_per_mile: null, freshness_class: 'FRESH', fallback: 'HR_RPE_FALLBACK', reason_codes: ['PACE_EVIDENCE_MISSING', 'HR_RPE_FALLBACK'] };
}

function classifyCompletedWeek(week = {}) {
  const weekId = String(week.week_id || week.start_date_local || '').slice(0, 10);
  const coverage = normalizedProviderCoverage(week.coverage || []);
  const tags = [...new Set((Array.isArray(week.context_tags) ? week.context_tags : [])
    .map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
  const reasonCodes = [];
  const distance = finite(week.distance_m);
  const duration = finite(week.duration_s);
  const missingMeasurements = week.distance_m === null || week.distance_m === undefined || week.distance_m === ''
    || week.duration_s === null || week.duration_s === undefined || week.duration_s === '';
  const invalidMeasurements = !missingMeasurements
    && (distance === null || distance < 0 || duration === null || duration < 0);
  let classification = 'VALID_NORMAL_WEEK';
  if (week.is_current === true || week.partial_days === true || (finite(week.covered_local_days) !== null && finite(week.covered_local_days) < 7)) {
    classification = 'PARTIAL_WEEK';
  } else if (invalidMeasurements || week.unresolved_duplicates === true || week.corrupted === true) {
    classification = 'CORRUPTED_WEEK';
  } else if (missingMeasurements) {
    classification = 'PARTIAL_WEEK';
  } else if (coverage.some((row) => row.quality_state === 'FAILED_SYNC' || row.quality_state === 'PARTIAL')) {
    classification = 'PARTIAL_WEEK';
  } else if (coverage.some((row) => row.quality_state === 'CONFLICT' || row.quality_state === 'CORRUPTED')) {
    classification = 'CORRUPTED_WEEK';
  } else if (!coverage.length && week.forge_native_coverage !== true) {
    classification = 'PARTIAL_WEEK';
  } else if (tags.some((tag) => CONTEXT_REASON_CODES[tag])) {
    classification = 'EXCLUDED_CONTEXT_WEEK';
  }
  if (classification === 'PARTIAL_WEEK') {
    if (missingMeasurements) reasonCodes.push('EVIDENCE_MISSING');
    if (coverage.some((row) => row.quality_state === 'FAILED_SYNC')) reasonCodes.push('FAILED_SYNC');
    else if (coverage.some((row) => row.quality_state === 'PARTIAL') || !missingMeasurements) reasonCodes.push('PARTIAL_SYNC');
  }
  if (classification === 'CORRUPTED_WEEK') reasonCodes.push('EVIDENCE_CONFLICT_UNRESOLVED');
  if (classification === 'EXCLUDED_CONTEXT_WEEK') {
    for (const tag of tags) if (CONTEXT_REASON_CODES[tag]) reasonCodes.push(CONTEXT_REASON_CODES[tag]);
  }
  const baselineEligible = classification === 'VALID_NORMAL_WEEK';
  return deepFreeze({
    week_id: weekId,
    start_date_local: week.start_date_local || weekId,
    end_date_local: week.end_date_local || null,
    classification,
    baseline_eligible: baselineEligible,
    distance_m: baselineEligible ? Math.round(finite(week.distance_m)) : null,
    duration_s: baselineEligible ? Math.round(finite(week.duration_s)) : null,
    context_tags: tags.sort(),
    reason_codes: [...new Set(reasonCodes)].sort(),
    modality_eligibility: week.modality_eligibility || modalityEligibility(coverage),
    stress_dimensions: week.stress_dimensions || {},
  });
}

function type7Quantile(values, probability) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * probability;
  const j = Math.floor(h);
  const g = h - j;
  return (1 - g) * sorted[j] + g * sorted[Math.min(j + 1, sorted.length - 1)];
}

function median(values) {
  return type7Quantile(values, 0.5);
}

function activityDate(activity, timezone) {
  const instant = activity.observed_at || activity.date;
  if (!instant) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(instant))) return String(instant);
  try {
    return localDateInTimezone(instant, timezone);
  } catch (_error) {
    return null;
  }
}

function deriveRecentNormalRunning({
  weeks = [],
  planningDateLocal,
  completedRuns = [],
  timezone = 'UTC',
  completeDaysInSeedWindow = 28,
  gapExplained = false,
} = {}) {
  const classified = (Array.isArray(weeks) ? weeks : []).map(classifyCompletedWeek)
    .sort((left, right) => left.week_id.localeCompare(right.week_id)).slice(-8);
  const eligible = classified.filter((week) => week.baseline_eligible);
  const excluded = classified.filter((week) => !week.baseline_eligible);
  const distances = eligible.map((week) => week.distance_m);
  const durations = eligible.map((week) => week.duration_s);
  let status = eligible.length >= 4 ? 'ESTABLISHED' : eligible.length === 3 ? 'PROVISIONAL' : 'INSUFFICIENT';
  let confidence = eligible.length >= 6 ? 'HIGH' : eligible.length >= 4 ? 'MEDIUM' : eligible.length === 3 ? 'LOW' : 'INSUFFICIENT';
  const establishedMedian = eligible.length >= 3 ? median(distances) : null;
  const datedRuns = (Array.isArray(completedRuns) ? completedRuns : []).map((run) => ({
    date: activityDate(run, timezone),
    distance_m: finite(run.distance_m) !== null && finite(run.distance_m) > 0
      ? finite(run.distance_m)
      : null,
  })).filter((run) => run.date && run.date <= planningDateLocal);
  const latestRunDate = datedRuns.sort((left, right) => right.date.localeCompare(left.date))[0]?.date || null;
  const last28Runs = datedRuns.filter((run) => {
    const age = localDateDistance(planningDateLocal, run.date);
    return age !== null && age >= 0 && age < 28;
  });
  const last28HasUnknownDistance = last28Runs.some((run) => run.distance_m === null);
  const last28Distance = last28Runs.reduce((sum, run) => sum + (run.distance_m || 0), 0);
  const latestGapDays = latestRunDate ? localDateDistance(planningDateLocal, latestRunDate) : null;
  const gapByDays = latestGapDays !== null && latestGapDays >= 21;
  const gapByLoad = establishedMedian !== null
    && !last28HasUnknownDistance
    && last28Distance < 0.5 * 4 * establishedMedian;
  const trainingGap = status !== 'INSUFFICIENT' && !gapExplained && (gapByDays || gapByLoad);
  let forwardLoadSeed = null;
  const completeDays = Math.max(0, Math.min(28, Math.floor(finite(completeDaysInSeedWindow) || 0)));
  if (trainingGap && !last28HasUnknownDistance && completeDays >= 28) forwardLoadSeed = last28Distance / 4;
  else if (trainingGap && !last28HasUnknownDistance && completeDays >= 7) forwardLoadSeed = last28Distance * 7 / completeDays;
  if (trainingGap) {
    status = 'TRAINING_GAP';
    confidence = forwardLoadSeed === null ? 'INSUFFICIENT' : 'LOW';
  }
  const bounds = eligible.length === 3
    ? { lower: Math.min(...distances), upper: Math.max(...distances) }
    : { lower: type7Quantile(distances, 0.25), upper: type7Quantile(distances, 0.75) };
  return deepFreeze({
    status,
    lookback_weeks: 8,
    eligible_week_ids: eligible.map((week) => week.week_id),
    excluded_week_ids: excluded.map((week) => week.week_id),
    excluded_weeks: excluded.map((week) => ({ week_id: week.week_id, reason_code: week.reason_codes[0] || 'RECENT_NORMAL_INSUFFICIENT' })),
    median_distance_m: establishedMedian === null ? null : Math.round(establishedMedian),
    lower_bound_m: bounds.lower === null || bounds.lower === undefined ? null : Math.round(bounds.lower),
    upper_bound_m: bounds.upper === null || bounds.upper === undefined ? null : Math.round(bounds.upper),
    median_duration_s: durations.length >= 3 ? Math.round(median(durations)) : null,
    historical_median_distance_m: trainingGap && establishedMedian !== null ? Math.round(establishedMedian) : null,
    forward_load_seed_m: forwardLoadSeed === null ? null : Math.round(forwardLoadSeed),
    latest_completed_run_date: latestRunDate,
    confidence,
    reason_codes: trainingGap
      ? ['TRAINING_GAP_REBUILD']
      : status === 'INSUFFICIENT' ? ['RECENT_NORMAL_INSUFFICIENT'] : ['RECENT_LOAD_MAINTAIN'],
  });
}

function ordinalMedian(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? Math.round(sorted[middle]) : Math.ceil((sorted[middle - 1] + sorted[middle]) / 2);
}

function deriveCrossModalRecentNormal(weeks = [], { planningDateLocal = null } = {}) {
  const classified = (Array.isArray(weeks) ? weeks : []).map((week) => (
    week?.classification ? week : classifyCompletedWeek(week)
  )).sort((left, right) => String(left.week_id).localeCompare(String(right.week_id))).slice(-8);
  const dimensions = {};
  for (const dimension of STRESS_DIMENSIONS) {
    const eligible = classified.filter((week) => (
      week.classification === 'VALID_NORMAL_WEEK'
      && week.modality_eligibility?.[dimension]?.eligible === true
      && finite(week.stress_dimensions?.[dimension]) !== null
    ));
    const excluded = classified.filter((week) => !eligible.includes(week));
    const values = eligible.map((week) => week.stress_dimensions[dimension]);
    let status = eligible.length >= 4 ? 'ESTABLISHED' : eligible.length === 3 ? 'PROVISIONAL' : 'INSUFFICIENT';
    let confidence = eligible.length >= 6 ? 'HIGH' : eligible.length >= 4 ? 'MEDIUM' : eligible.length === 3 ? 'LOW' : 'INSUFFICIENT';
    const historicalMedian = eligible.length >= 3 ? ordinalMedian(values) : null;
    const lastCompletedDate = eligible.filter((week) => finite(week.stress_dimensions[dimension]) > 0)
      .map((week) => String(week.dimension_last_completed_dates?.[dimension] || week.end_date_local || week.week_id).slice(0, 10))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort()
      .at(-1) || null;
    const gapDays = planningDateLocal && lastCompletedDate
      ? localDateDistance(planningDateLocal, lastCompletedDate)
      : null;
    const trainingGap = status !== 'INSUFFICIENT' && gapDays !== null && gapDays >= 21;
    if (trainingGap) {
      status = 'TRAINING_GAP';
      confidence = 'LOW';
    }
    dimensions[dimension] = {
      status,
      eligible_week_ids: eligible.map((week) => week.week_id),
      excluded_week_ids: excluded.map((week) => week.week_id),
      median_sum: trainingGap ? null : historicalMedian,
      historical_median_sum: trainingGap ? historicalMedian : null,
      last_completed_date_local: lastCompletedDate,
      confidence,
      reason_codes: trainingGap ? ['TRAINING_GAP_REBUILD'] : [],
    };
  }
  return deepFreeze({ lookback_weeks: 8, dimensions });
}

function activeSafety(snapshot) {
  const reports = (snapshot?.evidence || []).filter((evidence) => (
    evidence.evidence_type === 'pain_report' || evidence.evidence_type === 'illness_report'
  ));
  const superseded = new Set(reports.map((report) => report.supersedes_evidence_id).filter(Boolean));
  const current = [];
  for (const evidenceType of ['pain_report', 'illness_report']) {
    const unsuperseded = reports.filter((report) => report.evidence_type === evidenceType && !superseded.has(report.evidence_id))
      .sort((left, right) => String(right.observed_at || '').localeCompare(String(left.observed_at || '')));
    if (unsuperseded[0]?.value?.active === false) continue;
    current.push(...unsuperseded.filter((report) => report.value?.active === true));
  }
  const selected = [...current].sort((left, right) => (
    (SAFETY_RANK[right.value.safety_action] || 0) - (SAFETY_RANK[left.value.safety_action] || 0)
    || String(right.observed_at || '').localeCompare(String(left.observed_at || ''))
  ))[0];
  if (!selected) return {
    evidence_type: null,
    evidence_ids: [],
    safety_action: 'NORMAL',
    safety_scope: [],
    reconfirmation_requested: false,
    illness_needs_update: false,
  };
  const planningDate = snapshot.planning_date_local;
  const observedDate = selected.observed_at ? localDateInTimezone(selected.observed_at, snapshot.timezone) : null;
  const ageHours = selected.observed_at ? (timestamp(snapshot.created_at) - timestamp(selected.observed_at)) / 3600000 : Infinity;
  return {
    evidence_type: selected.evidence_type,
    evidence_ids: current.map((report) => report.evidence_id).sort(),
    safety_action: selected.value.safety_action,
    safety_scope: [...new Set(current.flatMap((report) => report.value.safety_scope || []))].sort(),
    reconfirmation_requested: observedDate !== planningDate,
    illness_needs_update: selected.evidence_type === 'illness_report' && ageHours > 48,
  };
}

function deriveRecoveryState({
  snapshot,
  subjectiveReadiness = null,
  biometrics = {},
  recentStress = null,
} = {}) {
  const safety = activeSafety(snapshot);
  if (safety.safety_action === 'FULL_REST' || safety.safety_action === 'PROFESSIONAL_ASSESSMENT_RECOMMENDED') return 'RECOVERY';
  if (safety.evidence_type === 'illness_report') return 'RECOVERY';
  if (safety.safety_action !== 'NORMAL') return 'CAUTION';
  const snapshotReadiness = (snapshot?.evidence || []).filter((evidence) => (
    evidence.evidence_type === 'subjective_readiness'
    && evidence.quality_state === 'COMPLETE'
    && evidence.value_state === 'KNOWN'
    && evidence.freshness_class === 'FRESH'
    && evidence.value?.local_date === snapshot.planning_date_local
  )).sort((left, right) => String(right.observed_at || '').localeCompare(String(left.observed_at || '')))[0];
  const currentReadiness = snapshotReadiness
    ? finite(snapshotReadiness.value?.feeling)
    : subjectiveReadiness && subjectiveReadiness.date === snapshot?.planning_date_local
      ? finite(subjectiveReadiness.value ?? subjectiveReadiness.feeling)
      : null;
  if (currentReadiness !== null) {
    if (currentReadiness <= 1) return 'RECOVERY';
    if (currentReadiness <= 2) return 'CAUTION';
    if (currentReadiness >= 4) return 'READY';
    return 'NORMAL';
  }
  const biometricFlags = [];
  const sleep = biometrics.sleep || biometrics.sleep_duration;
  if (sleep && sleep.quality_state === 'COMPLETE') {
    const freshness = healthMetricFreshness('sleep_duration', sleep.observed_at, snapshot.created_at);
    if (freshness.usable && finite(sleep.value_hours ?? sleep.value) !== null) {
      biometricFlags.push(finite(sleep.value_hours ?? sleep.value) < 6 ? 'CAUTION' : 'NORMAL');
    }
  }
  const hrv = biometrics.hrv;
  if (hrv && hrv.quality_state === 'COMPLETE') {
    const freshness = healthMetricFreshness('hrv', hrv.observed_at, snapshot.created_at, { baselineDays: hrv.baseline_days });
    const value = finite(hrv.value);
    const baseline = finite(hrv.baseline);
    if (freshness.usable && value !== null && baseline !== null && baseline > 0) {
      biometricFlags.push(value < baseline * 0.85 ? 'CAUTION' : 'NORMAL');
    }
  }
  const restingHr = biometrics.resting_heart_rate;
  if (restingHr && restingHr.quality_state === 'COMPLETE') {
    const freshness = healthMetricFreshness('resting_heart_rate', restingHr.observed_at, snapshot.created_at, { baselineDays: restingHr.baseline_days });
    const value = finite(restingHr.value);
    const baseline = finite(restingHr.baseline);
    if (freshness.usable && value !== null && baseline !== null && baseline > 0) {
      biometricFlags.push(value > baseline * 1.1 ? 'CAUTION' : 'NORMAL');
    }
  }
  if (biometricFlags.filter((flag) => flag === 'CAUTION').length >= 2) return 'RECOVERY';
  if (biometricFlags.includes('CAUTION')) return 'CAUTION';
  const recoverySpacingHours = finite(recentStress?.recovery_spacing_hours);
  if (recentStress?.excessive === true || (recoverySpacingHours !== null && recoverySpacingHours < 24)) return 'CAUTION';
  if (biometricFlags.length) return 'NORMAL';
  return 'UNKNOWN';
}

function minimumConfidence(values) {
  const rank = { INSUFFICIENT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  return values.reduce((minimum, value) => (
    rank[value] < rank[minimum] ? value : minimum
  ), 'HIGH');
}

function buildAthleteState({
  snapshot,
  weeks = [],
  previousState = null,
  trainingAgeClass = 'UNKNOWN',
  availableDays = [],
  timeConstraints = {},
  equipment = [],
  locks = [],
  manualEdits = [],
  performanceAnchors = [],
  limiters = [],
  subjectiveReadiness = null,
  biometrics = {},
  recentStress = null,
} = {}) {
  if (!snapshot?.evidence_snapshot_id || !snapshot?.athlete_id) throw new Error('buildAthleteState requires an EvidenceSnapshot');
  const recentNormal = deriveRecentNormalRunning({
    weeks,
    planningDateLocal: snapshot.planning_date_local,
    completedRuns: snapshot.canonical_activities.map((activity) => ({ observed_at: activity.observed_at, distance_m: activity.distance_m })),
    timezone: snapshot.timezone,
  });
  const crossModal = deriveCrossModalRecentNormal(weeks, { planningDateLocal: snapshot.planning_date_local });
  const safety = activeSafety(snapshot);
  const recoveryState = deriveRecoveryState({ snapshot, subjectiveReadiness, biometrics, recentStress });
  const readinessEvidenceIds = snapshot.evidence.filter((evidence) => (
    evidence.evidence_type === 'subjective_readiness'
    && evidence.quality_state === 'COMPLETE'
    && evidence.value_state === 'KNOWN'
    && evidence.freshness_class === 'FRESH'
    && evidence.value?.local_date === snapshot.planning_date_local
  )).map((evidence) => evidence.evidence_id);
  const recoveryEvidenceIds = [...new Set([
    ...safety.evidence_ids,
    ...readinessEvidenceIds,
    ...Object.values(biometrics || {}).map((metric) => metric?.evidence_id).filter(Boolean),
    ...(recentStress?.evidence_ids || []),
  ])].sort();
  const reasonCodes = [...new Set([
    ...snapshot.reason_codes,
    ...recentNormal.reason_codes,
    ...(safety.safety_action !== 'NORMAL' ? [safety.safety_action] : []),
    ...(safety.illness_needs_update ? ['ILLNESS_STATUS_NEEDS_UPDATE'] : []),
    ...(previousState && (
      previousState.timezone !== snapshot.timezone
      || previousState.reason_codes?.includes('TIMEZONE_REVISION')
    ) ? ['TIMEZONE_REVISION'] : []),
  ])].sort();
  const unknowns = [];
  if (recentNormal.status === 'INSUFFICIENT') unknowns.push('recent_normal_running');
  if (recoveryState === 'UNKNOWN') unknowns.push('recovery_state');
  const confidence = minimumConfidence([
    recentNormal.confidence,
    snapshot.failed_sync_sources.length || snapshot.partial_sync_sources.length || snapshot.unresolved_conflicts.length
      ? 'INSUFFICIENT'
      : 'HIGH',
  ]);
  const consistency = recentNormal.status === 'TRAINING_GAP'
    ? 'RETURNING'
    : recentNormal.status === 'ESTABLISHED' ? 'CONSISTENT'
      : recentNormal.status === 'PROVISIONAL' ? 'SPARSE_DATA' : 'UNKNOWN';
  const content = {
    athlete_state_schema_version: ATHLETE_STATE_SCHEMA_VERSION,
    policy_version: PLANNING_POLICY_VERSION,
    athlete_id: snapshot.athlete_id,
    evidence_snapshot_id: snapshot.evidence_snapshot_id,
    planning_date_local: snapshot.planning_date_local,
    timezone: snapshot.timezone,
    training_age_class: trainingAgeClass,
    consistency_state: consistency,
    recent_normal_running: recentNormal,
    cross_modal_recent_normal: crossModal,
    recovery_state: recoveryState,
    recovery_evidence_ids: recoveryEvidenceIds,
    safety_action: safety.safety_action,
    safety_scope: safety.safety_scope,
    reconfirmation_requested: safety.reconfirmation_requested,
    available_days: [...new Set(availableDays)].sort(),
    time_constraints: timeConstraints,
    equipment: [...new Set(equipment)].sort(),
    locks,
    manual_edits: manualEdits,
    performance_anchors: performanceAnchors,
    limiters,
    unknowns,
    reason_codes: reasonCodes,
    confidence,
  };
  const comparableHash = prefixedHash(content);
  const previousComparable = previousState?.state_content_hash || null;
  const revision = previousState
    ? Number(previousState.athlete_state_revision || 0) + (previousComparable === comparableHash ? 0 : 1)
    : 1;
  const withRevision = { ...content, athlete_state_revision: Math.max(1, revision), state_content_hash: comparableHash };
  const athleteStateHash = prefixedHash(withRevision);
  return deepFreeze({
    athlete_state_id: `athlete-state-${athleteStateHash.slice(-24)}`,
    ...withRevision,
    athlete_state_hash: athleteStateHash,
  });
}

function buildAttributedCorrection({
  id,
  athleteId,
  rawEvidenceKind,
  rawEvidenceRef,
  revision,
  correctedValue,
  canonicalUnit,
  reason,
  attributedByUserId,
  supersedesCorrectionId = null,
  createdAt = new Date().toISOString(),
  attribution = {},
} = {}) {
  const scopedAthleteId = String(athleteId || '').trim();
  const evidenceKind = String(rawEvidenceKind || '').trim();
  const evidenceRef = String(rawEvidenceRef || '').trim();
  const correctionId = String(id || '').trim();
  const correctionRevision = Number(revision);
  const reasonText = String(reason || '').trim();
  const unit = canonicalUnit === undefined ? null : canonicalUnit;
  if (!correctionId || !scopedAthleteId || !evidenceKind || !evidenceRef) throw new Error('Correction identity is required');
  if (!Number.isSafeInteger(correctionRevision) || correctionRevision < 1) throw new Error('Correction revision must be positive');
  if (!CANONICAL_UNITS.includes(unit) || unit !== 'm') throw new Error('Run distance corrections require canonical unit m');
  if (!correctedValue || typeof correctedValue !== 'object' || Array.isArray(correctedValue)) throw new Error('Corrected canonical value is required');
  if (correctedValue.field !== 'distance_m' || finite(correctedValue.value) === null || finite(correctedValue.value) <= 0) {
    throw new Error('Run corrections require a positive distance_m value');
  }
  if (findNonJsonValues(correctedValue, 'corrected_canonical_value_json').length
    || findRedactionViolations(correctedValue, 'corrected_canonical_value_json').length
    || findNonJsonValues(attribution, 'attribution_json').length
    || findRedactionViolations(attribution, 'attribution_json').length) {
    throw new Error('Correction payload contains an unsupported value or prohibited key');
  }
  if (Buffer.byteLength(canonicalStringify(correctedValue), 'utf8') > 16 * 1024) throw new Error('Corrected canonical value is too large');
  if (Buffer.byteLength(canonicalStringify(attribution), 'utf8') > 16 * 1024) throw new Error('Correction attribution is too large');
  if (reasonText.length < 1 || reasonText.length > 500) throw new Error('Correction reason must be 1 to 500 characters');
  if (String(attributedByUserId || '') !== scopedAthleteId) throw new Error('Correction attribution must be athlete-owned');
  const createdAtIso = new Date(createdAt).toISOString();
  const record = {
    id: correctionId,
    user_id: scopedAthleteId,
    raw_evidence_kind: evidenceKind,
    raw_evidence_ref: evidenceRef,
    revision: correctionRevision,
    corrected_canonical_value_json: JSON.parse(canonicalStringify(correctedValue)),
    canonical_unit: unit,
    reason_code: 'MANUAL_CORRECTION_APPLIED',
    reason: reasonText,
    attributed_by_user_id: scopedAthleteId,
    attribution_json: {
      ...attribution,
      actor_type: 'athlete',
      field: correctedValue.field,
    },
    supersedes_correction_id: supersedesCorrectionId || null,
    created_at: createdAtIso,
  };
  return deepFreeze({ ...record, content_hash: prefixedHash(record) });
}

function buildEvidenceStateArtifacts({ snapshot, athleteState, decisionId, createdAt = null } = {}) {
  if (!snapshot?.evidence_snapshot_id || !athleteState?.athlete_state_id) {
    throw new Error('EvidenceSnapshot and AthleteState are required');
  }
  if (snapshot.athlete_id !== athleteState.athlete_id || snapshot.evidence_snapshot_id !== athleteState.evidence_snapshot_id) {
    throw new Error('EvidenceSnapshot and AthleteState links do not match');
  }
  const { buildPipelineArtifact } = require('./planCandidateLifecycle');
  const evidenceArtifact = buildPipelineArtifact({
    id: snapshot.evidence_snapshot_id,
    userId: snapshot.athlete_id,
    kind: 'evidence_snapshot',
    decisionId,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    revision: 1,
    payload: snapshot,
    createdAt: createdAt || snapshot.created_at,
  });
  const stateArtifact = buildPipelineArtifact({
    id: athleteState.athlete_state_id,
    userId: athleteState.athlete_id,
    kind: 'athlete_state',
    decisionId,
    parentArtifactId: evidenceArtifact.id,
    schemaVersion: ATHLETE_STATE_SCHEMA_VERSION,
    revision: athleteState.athlete_state_revision,
    payload: athleteState,
    createdAt: createdAt || snapshot.created_at,
  });
  return deepFreeze([evidenceArtifact, stateArtifact]);
}

module.exports = {
  DISTANCE_EQUIVALENCE_FLOOR_M,
  DISTANCE_EQUIVALENCE_RATIO,
  FRESHNESS_WINDOWS_MS,
  HR_COVERAGE_TOLERANCE_PCT,
  HR_MEDIAN_TOLERANCE_BPM,
  ROUTE_MATCH_MINIMUM,
  ROUTE_POINT_TOLERANCE_M,
  STRESS_DIMENSIONS,
  TEMPORAL_DURATION_TOLERANCE_S,
  TEMPORAL_FINGERPRINT_WINDOW_MS,
  buildAthleteState,
  buildAttributedCorrection,
  buildEvidenceSnapshot,
  buildEvidenceStateArtifacts,
  classifyCompletedWeek,
  deriveCrossModalRecentNormal,
  deriveRecentNormalRunning,
  deriveRecoveryState,
  freshnessForEvidence,
  localDateInTimezone,
  resolveHeartRateEvidence,
  resolvePerformanceEvidence,
  routeMatchRatio,
  temporalRouteFingerprintMatch,
  type7Quantile,
};
