const router = require('express').Router();
const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const { dbGet, withPlanningInputMutation } = require('../db');
const auth = require('../middleware/auth');
const { activityKind } = require('../lib/runActivity');
const { buildRunImportKeys } = require('../lib/runImportKey');
const { classifyRouteIntegrity, normalizeDistanceEvidence } = require('../lib/runPostRun');
const { normalizeWorkoutMetrics } = require('../lib/workoutMetrics');
const {
  mergeWorkoutMetricStreams,
  normalizeWorkoutMetricStreams,
} = require('../lib/workoutMetricStreams');
const {
  chooseForgedRunMatch,
  distanceTolerance,
  durationTolerance,
  hasForgedRecordingProvenance,
  isTrustedSensorSummarySource,
  normalizedSource,
  sensorSummarySourcePriority,
} = require('../lib/canonicalRunMatch');
const {
  findPlannedRunForDate,
  hasMeaningfulPlannedRun,
  isExplicitlyUnlinkedRun,
} = require('../lib/plannedRunMatch');
const autoUpdatePRs = require('../services/prAuto');
const { planningInputUnchanged } = require('../lib/planningRevision');
const {
  buildActivityIdentityReceipt,
  classifyCanonicalActivityIdentity,
} = require('../lib/goalBackwardEvidence');

function hashImportKey(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeDateTime(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeZoneSeconds(value) {
  let raw = value;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      console.error('[import] heart-rate zones JSON parse failed:', err.message);
      raw = null;
    }
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return ['z1', 'z2', 'z3', 'z4', 'z5'].reduce((acc, zone) => {
    const upper = zone.toUpperCase();
    acc[zone] = Math.max(0, Math.round(asNumber(source[zone] ?? source[upper] ?? 0, 0)));
    return acc;
  }, {});
}

function normalizeHeartRate(value) {
  const bpm = asNumber(value, null);
  return bpm >= 30 && bpm <= 250 ? bpm : null;
}

function firstValue(raw, keys) {
  for (const key of keys) {
    if (raw[key] !== null && raw[key] !== undefined && raw[key] !== '') return raw[key];
  }
  return null;
}

function optionalNumber(raw, keys, min, max) {
  const value = firstValue(raw, keys);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function distanceEvidenceCandidates(raw, source) {
  const candidates = [];
  const append = (keys, unit) => {
    for (const key of keys) {
      if (raw[key] !== null && raw[key] !== undefined && raw[key] !== '') {
        candidates.push({ value: raw[key], unit, source });
      }
    }
  };
  append(['distanceMiles', 'distance_miles'], 'miles');
  append(['distanceKilometers', 'distance_kilometers', 'distanceKm', 'distance_km'], 'kilometers');
  append(['distanceMeters', 'distance_meters', 'distanceM', 'distance_m'], 'meters');

  const genericDistance = firstValue(raw, ['distance', 'totalDistance', 'total_distance']);
  if (genericDistance !== null) {
    candidates.push({
      value: genericDistance,
      unit: firstValue(raw, ['distanceUnit', 'distance_unit', 'unit']),
      source,
    });
  }
  return candidates;
}

function normalizeRouteCoords(value) {
  let parsed = value;
  if (typeof parsed === 'string' && parsed.trim()) {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      console.error('[import] route coordinates JSON parse failed:', err.message);
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 5000).map((point) => {
    const coordinate = {
      lat: Number(point?.lat ?? point?.latitude),
      lon: Number(point?.lon ?? point?.lng ?? point?.longitude),
    };
    const altitude = Number(point?.alt ?? point?.altitude);
    if (Number.isFinite(altitude) && altitude >= -500 && altitude <= 30000) coordinate.alt = altitude;
    const timestampValue = point?.time ?? point?.timestamp;
    if (timestampValue) {
      const timestamp = new Date(timestampValue);
      if (!Number.isNaN(timestamp.getTime())) coordinate.time = timestamp.toISOString();
    }
    return coordinate;
  }).filter((point) => Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 && Number.isFinite(point.lon) && point.lon >= -180 && point.lon <= 180);
}

function parseStoredWorkoutMetrics(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('[import] stored workout metrics JSON parse failed:', err.message);
    return {};
  }
}

function normalizedText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function meaningfulRunNote(value) {
  const note = normalizedText(value);
  if (!note) return null;
  if (/^imported workout(?:\s+\[.*\])?$/i.test(note)) return null;
  if (/^synced (?:from|via)\b/i.test(note)) return null;
  return note;
}

function runPlanState(run = {}) {
  const planSessionId = normalizedText(run.plan_session_id);
  let snapshot = null;
  if (run.planned_session_json && typeof run.planned_session_json === 'object') {
    snapshot = run.planned_session_json;
  } else if (run.planned_session_json) {
    try {
      const parsed = JSON.parse(run.planned_session_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snapshot = parsed;
    } catch {
      snapshot = null;
    }
  }
  const meaningful = hasMeaningfulPlannedRun(snapshot) || isExplicitlyUnlinkedRun(snapshot);
  const snapshotSessionId = normalizedText(snapshot?.sessionId ?? snapshot?.session_id);
  return {
    hasPlan: Boolean(planSessionId || meaningful),
    planSessionId: planSessionId || snapshotSessionId,
    explicitNone: isExplicitlyUnlinkedRun(snapshot),
    snapshot,
  };
}

function sameOptionalValue(left, right) {
  return normalizedText(left) === normalizedText(right);
}

function numericRunValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsedStructuredValue(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function stableStructuredValue(value) {
  const parsed = parsedStructuredValue(value);
  if (Array.isArray(parsed)) return parsed.map(stableStructuredValue);
  if (!parsed || typeof parsed !== 'object') return parsed;
  return Object.fromEntries(
    Object.keys(parsed)
      .sort()
      .filter((key) => parsed[key] !== undefined)
      .map((key) => [key, stableStructuredValue(parsed[key])])
  );
}

function structuredValuesEqual(left, right) {
  return JSON.stringify(stableStructuredValue(left)) === JSON.stringify(stableStructuredValue(right));
}

function runAdjustmentProposalsEquivalent(left, right) {
  if (!left || !right) return false;
  const mergeableStatuses = new Set(['pending', 'reviewed']);
  if (!mergeableStatuses.has(left.status) || left.status !== right.status) return false;
  return (
    sameOptionalValue(left.user_plan_id, right.user_plan_id)
    && sameOptionalValue(left.plan_id, right.plan_id)
    && sameOptionalValue(left.plan_version, right.plan_version)
    && sameOptionalValue(left.window_start, right.window_start)
    && sameOptionalValue(left.window_end, right.window_end)
    && sameOptionalValue(left.planning_date, right.planning_date)
    && Number(left.safety_exception || 0) === Number(right.safety_exception || 0)
    && structuredValuesEqual(left.original_json, right.original_json)
    && structuredValuesEqual(left.proposed_json, right.proposed_json)
    && sameOptionalValue(left.reason, right.reason)
  );
}

function canPreserveExplicitUnlinkedPlan(canonicalRun, duplicateRun) {
  const canonicalPlan = runPlanState(canonicalRun);
  const duplicatePlan = runPlanState(duplicateRun);
  return canonicalPlan.explicitNone && duplicatePlan.hasPlan && !duplicatePlan.explicitNone;
}

function planSnapshotsEquivalent(left, right) {
  if (!left || !right) return false;
  const withoutSessionId = (snapshot) => {
    const comparable = { ...snapshot };
    delete comparable.sessionId;
    delete comparable.session_id;
    return comparable;
  };
  return structuredValuesEqual(withoutSessionId(left), withoutSessionId(right));
}

function storedValueMissing(value) {
  return value === null || value === undefined || value === '';
}

const LOWER_PRIORITY_FILLABLE_WORKOUT_METRICS = new Set([
  'running_power_watts',
  'running_power_min_watts',
  'running_power_max_watts',
  'running_speed_mps',
  'running_speed_min_mps',
  'running_speed_max_mps',
  'running_stride_length_m',
  'running_stride_length_min_m',
  'running_stride_length_max_m',
  'running_vertical_oscillation_cm',
  'running_vertical_oscillation_min_cm',
  'running_vertical_oscillation_max_cm',
  'running_ground_contact_time_ms',
  'running_ground_contact_time_min_ms',
  'running_ground_contact_time_max_ms',
  'running_cadence_spm',
  'running_cadence_min_spm',
  'running_cadence_max_spm',
  'running_vertical_ratio_pct',
  'ground_contact_balance_left_pct',
  'ground_contact_balance_right_pct',
  'respiratory_rate_avg',
  'respiratory_rate_max',
  'performance_condition',
  'run_time_seconds',
  'walk_time_seconds',
  'idle_time_seconds',
  'hr_sample_coverage_pct',
  'post_workout_heart_rate_drop_bpm',
]);

function mergeMissingWorkoutMetrics(storedMetrics, incomingMetrics, source) {
  const merged = { ...storedMetrics };
  const metricSources = {
    ...(storedMetrics.metric_sources && typeof storedMetrics.metric_sources === 'object'
      ? storedMetrics.metric_sources
      : {}),
  };
  let enriched = false;
  for (const key of LOWER_PRIORITY_FILLABLE_WORKOUT_METRICS) {
    const incomingValue = incomingMetrics[key];
    if (storedValueMissing(incomingValue) || !storedValueMissing(merged[key])) continue;
    merged[key] = incomingValue;
    metricSources[key] = source;
    enriched = true;
  }
  if (enriched) merged.metric_sources = metricSources;
  return merged;
}

function mergeAuthoritativeWorkoutMetrics(storedMetrics, incomingMetrics, source) {
  const merged = { ...storedMetrics, ...incomingMetrics };
  const metricSources = {
    ...(storedMetrics.metric_sources && typeof storedMetrics.metric_sources === 'object'
      ? storedMetrics.metric_sources
      : {}),
  };
  for (const key of LOWER_PRIORITY_FILLABLE_WORKOUT_METRICS) {
    if (!storedValueMissing(incomingMetrics[key])) metricSources[key] = source;
  }
  if (Object.keys(metricSources).length) merged.metric_sources = metricSources;
  return merged;
}

function incomingValueChangesStored(incomingValue, storedValue) {
  if (storedValueMissing(incomingValue)) return false;
  if (typeof incomingValue === 'number') {
    const storedNumber = numericRunValue(storedValue);
    return storedNumber === null || Math.abs(storedNumber - incomingValue) > 0.0001;
  }
  return !structuredValuesEqual(incomingValue, storedValue);
}

function analyzeRunConsolidation(canonicalRun, duplicateRun, item) {
  const conflicts = [];
  if (normalizedText(duplicateRun.date) && duplicateRun.date !== item.date) conflicts.push('date');
  if (activityKind(duplicateRun) !== activityKind({ type: item.runType })) conflicts.push('activity type');

  const duplicateDistance = numericRunValue(duplicateRun.distance_miles);
  if (
    duplicateDistance !== null
    && item.distanceMiles > 0
    && Math.abs(duplicateDistance - item.distanceMiles) > distanceTolerance(item.distanceMiles)
  ) {
    conflicts.push('distance');
  }
  const duplicateDuration = numericRunValue(duplicateRun.duration_seconds);
  if (
    duplicateDuration !== null
    && item.durationSeconds > 0
    && Math.abs(duplicateDuration - item.durationSeconds) > durationTolerance(item.durationSeconds)
  ) {
    conflicts.push('duration');
  }

  const canonicalNote = meaningfulRunNote(canonicalRun.notes);
  const duplicateNote = meaningfulRunNote(duplicateRun.notes);
  if (canonicalNote && duplicateNote && canonicalNote !== duplicateNote) conflicts.push('notes');

  const canonicalEffort = numericRunValue(canonicalRun.perceived_effort);
  const duplicateEffort = numericRunValue(duplicateRun.perceived_effort);
  if (canonicalEffort !== null && duplicateEffort !== null && canonicalEffort !== duplicateEffort) {
    conflicts.push('effort');
  }
  if (canonicalRun.pain_level && duplicateRun.pain_level && !sameOptionalValue(canonicalRun.pain_level, duplicateRun.pain_level)) {
    conflicts.push('pain');
  }
  if (canonicalRun.post_energy && duplicateRun.post_energy && !sameOptionalValue(canonicalRun.post_energy, duplicateRun.post_energy)) {
    conflicts.push('post-run energy');
  }
  if (canonicalRun.shoe_id && duplicateRun.shoe_id && !sameOptionalValue(canonicalRun.shoe_id, duplicateRun.shoe_id)) {
    conflicts.push('shoe');
  }

  const canonicalPlan = runPlanState(canonicalRun);
  const duplicatePlan = runPlanState(duplicateRun);
  if (canonicalPlan.hasPlan && duplicatePlan.hasPlan) {
    const incompatibleMode = canonicalPlan.explicitNone !== duplicatePlan.explicitNone;
    const bothSessionIds = canonicalPlan.planSessionId && duplicatePlan.planSessionId;
    const matchingSessionIds = bothSessionIds
      && canonicalPlan.planSessionId === duplicatePlan.planSessionId;
    const equivalentSnapshots = planSnapshotsEquivalent(canonicalPlan.snapshot, duplicatePlan.snapshot);
    if (incompatibleMode || (!matchingSessionIds && !equivalentSnapshots)) conflicts.push('plan link');
  }

  return {
    conflicts: [...new Set(conflicts)],
    patch: {
      notes: canonicalNote ? null : duplicateNote,
      perceivedEffort: canonicalEffort === null ? duplicateEffort : null,
      painLevel: canonicalRun.pain_level ? null : normalizedText(duplicateRun.pain_level),
      postEnergy: canonicalRun.post_energy ? null : normalizedText(duplicateRun.post_energy),
      shoeId: canonicalRun.shoe_id ? null : normalizedText(duplicateRun.shoe_id),
      planSessionId: canonicalPlan.hasPlan ? null : duplicatePlan.planSessionId,
      plannedSessionJson: canonicalPlan.hasPlan || !duplicatePlan.hasPlan
        ? null
        : JSON.stringify(duplicatePlan.snapshot || {}),
    },
  };
}

function resolveCanonicalDistanceSource(storedWorkoutMetrics, existingRun, item, sensorSummaryWins = false) {
  if (sensorSummaryWins) return item.source;
  if (storedWorkoutMetrics.distance_source) return storedWorkoutMetrics.distance_source;
  if (existingRun.health_source === 'forged_hybrid') return 'forged_phone';
  if (existingRun.health_source) return existingRun.health_source;
  return existingRun.watch_mode === 'import' ? item.source : 'manual';
}

function classifyType(rawType = '') {
  const value = String(rawType || '').toLowerCase().trim();
  if (value.includes('strength') || value.includes('lift') || value.includes('weight') || value.includes('resistance')) {
    return { section: 'lift', runType: null, liftCategory: 'strength' };
  }
  if (value.includes('walk')) return { section: 'activity', runType: 'walk', liftCategory: null };
  if (value.includes('treadmill')) return { section: 'run', runType: 'treadmill', liftCategory: null };
  if (value.includes('run') || value.includes('jog')) return { section: 'run', runType: 'easy', liftCategory: null };
  if (value.includes('cycl') || value.includes('bike')) return { section: 'activity', runType: 'cycling', liftCategory: null };
  if (value.includes('swim')) return { section: 'activity', runType: 'swimming', liftCategory: null };
  if (value.includes('hik')) return { section: 'activity', runType: 'hiking', liftCategory: null };
  if (value.includes('row')) return { section: 'activity', runType: 'rowing', liftCategory: null };
  if (value.includes('elliptical')) return { section: 'activity', runType: 'elliptical', liftCategory: null };
  if (value.includes('workout') || value === 'other' || !value) return { section: 'activity', runType: 'workout', liftCategory: null };
  return { section: 'activity', runType: value.slice(0, 40), liftCategory: null };
}

function normalizeRow(raw = {}) {
  const startDate = normalizeDateTime(raw.startDate || raw.start_date || raw.start || raw.activityStartDate);
  const endDate = normalizeDateTime(raw.endDate || raw.end_date || raw.end || raw.activityEndDate);
  const createdAt = normalizeDateTime(raw.createdAt || raw.created_at || raw.importCreatedAt || raw.import_created_at);
  const date = normalizeDate(raw.date || startDate || raw.startDate || raw.start_date || raw.activityDate || raw['Activity Date']);
  const type = classifyType(raw.type || raw.activityType || raw['Activity Type']);
  const source = String(raw.source || 'imported').slice(0, 40);
  const distanceEvidence = normalizeDistanceEvidence(distanceEvidenceCandidates(raw, source));
  if (distanceEvidence.error) {
    const error = new Error(distanceEvidence.error);
    error.code = 'IMPORT_ROW_INVALID';
    throw error;
  }
  const distanceMiles = distanceEvidence.miles === null ? 0 : Number(distanceEvidence.miles.toFixed(3));
  const durationSeconds = Math.max(0, Math.round(asNumber(raw.durationSeconds || raw.duration_seconds || raw.duration || raw.elapsedTime || 0, 0)));
  const avgHeartRate = normalizeHeartRate(raw.avgHR || raw.avgHeartRate || raw.avg_heart_rate || raw.average_heart_rate || raw['Average Heart Rate'] || null);
  const maxHeartRate = normalizeHeartRate(raw.maxHR || raw.maxHeartRate || raw.max_heart_rate || raw.maximum_heart_rate || raw['Max Heart Rate'] || null);
  const minHeartRate = normalizeHeartRate(raw.minHR || raw.minHeartRate || raw.min_heart_rate || raw.minimum_heart_rate || raw['Min Heart Rate'] || null);
  const zoneSeconds = normalizeZoneSeconds(raw.zoneSeconds || raw.zone_seconds || raw.heart_rate_zones);
  const sourceWorkoutId = String(raw.sourceWorkoutId || raw.source_workout_id || raw.id || raw.uuid || '').trim().slice(0, 200) || null;
  const routeCoords = normalizeRouteCoords(raw.routeCoords || raw.route_coords || raw.route);
  const routeIntegrity = classifyRouteIntegrity({
    routeCoords,
    materialGap: raw.routeMaterialGap === true || raw.route_material_gap === true || raw.discardedCatchUpSegment === true,
    coverageIncomplete: raw.routeCoverageIncomplete === true || raw.route_coverage_incomplete === true || raw.routeStatus === 'partial' || raw.route_status === 'partial',
  });
  const workoutMetrics = normalizeWorkoutMetrics({ ...raw, metric_source: source });
  const workoutMetricStreams = normalizeWorkoutMetricStreams(
    raw.workoutMetricStreams || raw.workout_metric_streams || raw.metricStreams || {}
  );
  if (distanceEvidence.miles !== null) {
    workoutMetrics.metrics.distance_source = distanceEvidence.source;
    workoutMetrics.metrics.distance_unit = distanceEvidence.unit;
  }
  workoutMetrics.metrics.route_status = routeIntegrity.status;
  workoutMetrics.metrics.route_point_count = routeIntegrity.pointCount;
  workoutMetrics.metrics.route_status_reason = routeIntegrity.reason;
  const totalZoneSeconds = Object.values(zoneSeconds).reduce((sum, seconds) => sum + seconds, 0);
  if (durationSeconds > 0 && totalZoneSeconds > 0 && workoutMetrics.metrics.hr_sample_coverage_pct === undefined) {
    workoutMetrics.metrics.hr_sample_coverage_pct = Math.min(100, Math.round((totalZoneSeconds / durationSeconds) * 1000) / 10);
  }
  return {
    date,
    startDate,
    endDate,
    createdAt,
    ...type,
    distanceMiles,
    durationSeconds,
    avgHeartRate,
    maxHeartRate,
    minHeartRate,
    zoneSeconds,
    source,
    sourceWorkoutId,
    calories: optionalNumber(raw, ['calories', 'Calories'], 0, 30000),
    perceivedEffort: optionalNumber(raw, ['perceivedEffort', 'perceived_effort', 'rpe', 'RPE'], 1, 10),
    cadenceSpm: optionalNumber(raw, ['cadenceSpm', 'cadence_spm', 'avgCadence', 'averageCadence', 'Avg Run Cadence'], 0, 300),
    elevationGain: optionalNumber(raw, ['elevationGain', 'elevation_gain', 'elevationGainFeet', 'totalAscent', 'Total Ascent'], 0, 100000),
    elevationLoss: optionalNumber(raw, ['elevationLoss', 'elevation_loss', 'elevationLossFeet', 'totalDescent', 'Total Descent'], 0, 100000),
    vo2Max: optionalNumber(raw, ['vo2Max', 'vo2_max', 'VO2 Max'], 5, 100),
    trainingEffectAerobic: optionalNumber(raw, ['trainingEffectAerobic', 'training_effect_aerobic', 'aerobicTrainingEffect', 'Aerobic TE'], 0, 10),
    trainingEffectAnaerobic: optionalNumber(raw, ['trainingEffectAnaerobic', 'training_effect_anaerobic', 'anaerobicTrainingEffect', 'Anaerobic TE'], 0, 10),
    recoveryTimeHours: optionalNumber(raw, ['recoveryTimeHours', 'recovery_time_hours', 'Recovery Time'], 0, 1000),
    temperatureF: optionalNumber(raw, ['temperatureF', 'temperature_f', 'avgTemperatureF', 'Average Temperature'], -100, 150),
    routeCoords,
    workoutMetrics: workoutMetrics.metrics,
    workoutMetricStreams,
    droppedMetricFields: workoutMetrics.droppedFields,
    raw,
  };
}

function selectExistingRunIdentityMatch(userId, candidates, item) {
  const incoming = {
    athlete_id: userId,
    activity_kind: activityKind({ type: item.runType }),
    observed_at: item.startDate,
    duration_s: item.durationSeconds,
    distance_m: Number(item.distanceMiles) * 1609.344,
    source_system: item.source,
    source_activity_id: item.sourceWorkoutId,
    route_points: item.routeCoords,
  };
  const matches = (Array.isArray(candidates) ? candidates : []).map((row) => ({
    row,
    identity: classifyCanonicalActivityIdentity({
      athlete_id: userId,
      activity_kind: activityKind(row),
      observed_at: row.health_start_at,
      duration_s: row.duration_seconds,
      distance_m: Number(row.distance_miles) * 1609.344,
      source_system: row.health_source,
      source_activity_id: row.health_source_workout_id,
      route_points: row.route_coords,
    }, incoming),
  })).filter((entry) => entry.identity?.duplicate === true)
    .sort((left, right) => (
      left.identity.reason_code.localeCompare(right.identity.reason_code)
      || String(left.row.id).localeCompare(String(right.row.id))
    ));
  const selected = matches[0] || null;
  return selected ? {
    run: selected.row,
    identityDecision: {
      kept_ref: selected.row.id,
      suppressed_ref: item.sourceWorkoutId || canonicalImportSourceKey(item),
      reason_code: selected.identity.reason_code,
    },
  } : { run: null, identityDecision: null };
}

async function findMatchingForgedRun(db, userId, item, { excludeId = null } = {}) {
  if (
    !isTrustedSensorSummarySource(item.source)
    || (!item.startDate && !item.createdAt)
    || item.distanceMiles <= 0
    || item.durationSeconds <= 0
  ) {
    return null;
  }
  const candidates = await db.all(
    `SELECT id, date, type, watch_mode, watch_activity_type, watch_normalized_type,
            duration_seconds, health_start_at, created_at, health_source, health_source_workout_id,
            distance_miles, route_coords, perceived_effort, pain_level, post_energy, notes,
            avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones, cadence_spm,
            elevation_gain, elevation_loss, vo2_max, training_effect_aerobic,
            training_effect_anaerobic, recovery_time_hours, temperature_f,
            calories, calories_burned, calories_watch, shoe_id, plan_session_id,
            planned_session_json, workout_metrics_json, workout_metric_streams_json, ai_feedback, ai_feedback_requested_at
     FROM runs
     WHERE user_id=? AND date=?
       AND (
         health_source='forged_hybrid'
         OR COALESCE(workout_metrics_json, '') LIKE '%"forged_recording_id"%'
         OR COALESCE(workout_metrics_json, '') LIKE '%"route_source":"forged_phone"%'
       )
       AND ABS(COALESCE(distance_miles, 0) - ?) <= ?
     LIMIT 20
     FOR UPDATE`,
    [userId, item.date, item.distanceMiles, distanceTolerance(item.distanceMiles)]
  );
  const incomingKind = activityKind({ type: item.runType });
  const sameActivity = candidates.filter((row) => activityKind(row) === incomingKind);
  return chooseForgedRunMatch(sameActivity, item, { excludeId });
}

async function findExistingRun(db, userId, item) {
  if (item.sourceWorkoutId) {
    const exact = await db.get(
      `SELECT id, date, type, watch_mode, watch_activity_type, watch_normalized_type,
              duration_seconds, health_start_at, created_at, health_source, health_source_workout_id,
              distance_miles, route_coords, perceived_effort, pain_level, post_energy, notes,
              avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones, cadence_spm,
              elevation_gain, elevation_loss, vo2_max, training_effect_aerobic,
              training_effect_anaerobic, recovery_time_hours, temperature_f,
              calories, calories_burned, calories_watch, shoe_id, plan_session_id,
              planned_session_json, workout_metrics_json, workout_metric_streams_json, ai_feedback, ai_feedback_requested_at
       FROM runs
       WHERE user_id=? AND health_source=? AND health_source_workout_id=?
       LIMIT 1
       FOR UPDATE`,
      [userId, item.source, item.sourceWorkoutId]
    );
    if (exact) return {
      run: exact,
      identityDecision: {
        kept_ref: exact.id,
        suppressed_ref: item.sourceWorkoutId,
        reason_code: 'EXACT_SOURCE_ACTIVITY_ID',
      },
    };
  }

  const forgedMatch = await findMatchingForgedRun(db, userId, item);
  if (forgedMatch) return { run: forgedMatch, identityDecision: null };

  const candidates = await db.all(
    `SELECT id, date, type, watch_mode, watch_activity_type, watch_normalized_type,
            duration_seconds, health_start_at, created_at, health_source, health_source_workout_id,
            distance_miles, route_coords, perceived_effort, pain_level, post_energy, notes,
            avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones, cadence_spm,
            elevation_gain, elevation_loss, vo2_max, training_effect_aerobic,
            training_effect_anaerobic, recovery_time_hours, temperature_f,
            calories, calories_burned, calories_watch, shoe_id, plan_session_id,
            planned_session_json, workout_metrics_json, workout_metric_streams_json, ai_feedback, ai_feedback_requested_at
     FROM runs
     WHERE user_id=? AND date=? AND ABS(COALESCE(distance_miles,0) - ?) < 0.05
       AND COALESCE(health_source, '')<>'forged_hybrid'
       AND COALESCE(workout_metrics_json, '') NOT LIKE '%"forged_recording_id"%'
       AND COALESCE(workout_metrics_json, '') NOT LIKE '%"route_source":"forged_phone"%'
     LIMIT 25
     FOR UPDATE`,
    [userId, item.date, item.distanceMiles]
  );
  return selectExistingRunIdentityMatch(userId, candidates, item);
}

function importKeysForItem(item) {
  return buildRunImportKeys({
    healthSource: item.source,
    sourceWorkoutId: item.sourceWorkoutId,
    startDate: item.startDate,
    type: item.runType,
    watchActivityType: String(item.raw?.type || item.raw?.activityType || 'imported'),
    watchNormalizedType: item.runType,
    distanceMiles: item.distanceMiles,
    durationSeconds: item.durationSeconds,
  });
}

function canonicalImportSourceKey(item) {
  const key = importKeysForItem(item)[0];
  if (key) return key;
  const source = String(item.source || 'imported').trim().toLowerCase().slice(0, 40) || 'imported';
  return `${source}:fallback:${hashImportKey([
    item.date,
    item.startDate,
    item.section,
    item.runType,
    item.liftCategory,
    String(item.raw?.type || item.raw?.activityType || '').trim().toLowerCase(),
    Number(item.distanceMiles || 0).toFixed(3),
    Math.max(0, Math.round(Number(item.durationSeconds || 0))),
    item.avgHeartRate,
    item.calories,
  ])}`;
}

async function isDeletedImport(db, userId, item) {
  const keys = importKeysForItem(item);
  for (const key of keys) {
    const tombstone = await db.get(
      'SELECT id FROM run_import_tombstones WHERE user_id=? AND source_key=? LIMIT 1',
      [userId, key]
    );
    if (tombstone) return true;
  }
  return false;
}

async function findExistingLift(db, userId, date, distanceMiles, durationSeconds) {
  const distanceTag = `[import_distance:${Number(distanceMiles || 0).toFixed(3)}]`;
  return db.get(
    'SELECT id FROM lifts WHERE user_id=? AND date=? AND (notes LIKE ? OR ABS(COALESCE(workout_duration_seconds,0) - ?) <= 60) LIMIT 1',
    [userId, date, `%${distanceTag}%`, durationSeconds]
  );
}

async function insertRun(db, userId, item) {
  const runId = uuidv4();
  const planned = item.section === 'run' ? await findPlannedRunForDate(userId, item.date, { get: db.get }) : null;
  await db.run(
    `INSERT INTO runs (
      id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes,
      avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones, calories, watch_mode, watch_activity_type,
      watch_normalized_type, health_source, health_source_workout_id, health_start_at, health_end_at, cadence_spm,
      elevation_gain, elevation_loss, route_coords, vo2_max, training_effect_aerobic,
      training_effect_anaerobic, recovery_time_hours, temperature_f, workout_metrics_json, workout_metric_streams_json,
      plan_session_id, planned_session_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      userId,
      item.date,
      item.runType || 'easy',
      item.distanceMiles,
      item.durationSeconds,
      item.perceivedEffort,
      'Imported workout',
      item.avgHeartRate,
      item.maxHeartRate,
      item.minHeartRate,
      JSON.stringify(item.zoneSeconds),
      Math.round(asNumber(item.calories, 0)),
      'import',
      String(item.raw?.type || item.raw?.activityType || 'imported'),
      item.runType || 'imported',
      item.source,
      item.sourceWorkoutId,
      item.startDate,
      item.endDate,
      item.cadenceSpm,
      item.elevationGain,
      item.elevationLoss,
      JSON.stringify(item.routeCoords),
      item.vo2Max,
      item.trainingEffectAerobic,
      item.trainingEffectAnaerobic,
      item.recoveryTimeHours,
      item.temperatureF,
      JSON.stringify(item.workoutMetrics),
      JSON.stringify(item.workoutMetricStreams),
      planned?.sessionId || null,
      JSON.stringify(planned || {}),
    ]
  );
  return runId;
}

async function updateExistingRunHealth(db, userId, existingRun, item, { preserveRawIdentityFacts = false } = {}) {
  const normalizedZones = item.zoneSeconds || normalizeZoneSeconds();
  const totalZoneSeconds = ['z1', 'z2', 'z3', 'z4', 'z5'].reduce((sum, zone) => sum + asNumber(normalizedZones[zone], 0), 0);
  const zoneParam = totalZoneSeconds > 0 ? JSON.stringify(normalizedZones) : null;
  const planned = item.section === 'run'
    && !isExplicitlyUnlinkedRun(existingRun.planned_session_json)
    && !hasMeaningfulPlannedRun(existingRun.planned_session_json)
    ? await findPlannedRunForDate(userId, item.date, { get: db.get })
    : null;
  const storedWorkoutMetrics = parseStoredWorkoutMetrics(existingRun.workout_metrics_json);
  const storedWorkoutMetricStreams = normalizeWorkoutMetricStreams(existingRun.workout_metric_streams_json);
  const isForgedCapture = hasForgedRecordingProvenance(existingRun);
  const incomingSource = normalizedSource(item.source);
  const storedSummarySource = normalizedSource(
    storedWorkoutMetrics.summary_source
      || (isForgedCapture && normalizedSource(existingRun.health_source) === 'forged_hybrid'
        ? null
        : existingRun.health_source)
  );
  const incomingSourcePriority = sensorSummarySourcePriority(incomingSource);
  const storedSourcePriority = sensorSummarySourcePriority(storedSummarySource);
  const summaryUpdateAllowed = incomingSourcePriority > 0
    ? storedSourcePriority === 0 || incomingSourcePriority >= storedSourcePriority
    : !isForgedCapture
      && storedSourcePriority === 0
      && Boolean(incomingSource)
      && incomingSource === storedSummarySource;
  const authoritativeSummaryUpdate = summaryUpdateAllowed && !preserveRawIdentityFacts;
  const sensorSummaryWins = isForgedCapture
    && summaryUpdateAllowed
    && isTrustedSensorSummarySource(incomingSource);
  const authorityChanged = sensorSummaryWins && incomingSource !== storedSummarySource;
  const existingEffortIsTrusted = storedWorkoutMetrics.workout_effort_user_rated === 1
    || Boolean(existingRun.pain_level)
    || Boolean(existingRun.post_energy)
    || !(existingRun.watch_mode === 'import' && existingRun.notes === 'Imported workout');
  const importedEffort = summaryUpdateAllowed
    && item.perceivedEffort != null
    && (existingRun.perceived_effort == null || !existingEffortIsTrusted)
    ? item.perceivedEffort
    : null;
  const storedRouteCoords = normalizeRouteCoords(existingRun.route_coords);
  const preserveForgedRoute = isForgedCapture && storedRouteCoords.length >= 2;
  const incomingRouteReplacesStored = isTrustedSensorSummarySource(incomingSource)
    && item.routeCoords.length >= 2
    && !preserveForgedRoute
    && !preserveRawIdentityFacts
    && (item.workoutMetrics.route_status === 'complete' || storedRouteCoords.length < 2);
  const storedRouteIntegrity = classifyRouteIntegrity({
    routeCoords: storedRouteCoords,
    coverageIncomplete: storedWorkoutMetrics.route_status === 'partial',
  });
  const canonicalRouteMetrics = incomingRouteReplacesStored
    ? {
      route_status: item.workoutMetrics.route_status,
      route_point_count: item.workoutMetrics.route_point_count,
      route_status_reason: item.workoutMetrics.route_status_reason,
    }
    : {
      route_status: storedRouteIntegrity.status,
      route_point_count: storedRouteIntegrity.pointCount,
      route_status_reason: storedWorkoutMetrics.route_status === storedRouteIntegrity.status
        ? storedWorkoutMetrics.route_status_reason || storedRouteIntegrity.reason
        : storedRouteIntegrity.reason,
    };
  const baseWorkoutMetrics = authoritativeSummaryUpdate
    ? mergeAuthoritativeWorkoutMetrics(storedWorkoutMetrics, item.workoutMetrics, item.source)
    : isTrustedSensorSummarySource(incomingSource)
      ? mergeMissingWorkoutMetrics(storedWorkoutMetrics, item.workoutMetrics, item.source)
      : storedWorkoutMetrics;
  const mergedWorkoutMetricStreams = summaryUpdateAllowed || isTrustedSensorSummarySource(incomingSource)
    ? mergeWorkoutMetricStreams(storedWorkoutMetricStreams, item.workoutMetricStreams)
    : storedWorkoutMetricStreams;
  const mergedWorkoutMetrics = {
    ...baseWorkoutMetrics,
    ...canonicalRouteMetrics,
    distance_source: resolveCanonicalDistanceSource(storedWorkoutMetrics, existingRun, item, sensorSummaryWins),
    distance_unit: 'miles',
    ...(authoritativeSummaryUpdate && isTrustedSensorSummarySource(incomingSource) ? {
      summary_source: item.source,
    } : {}),
    ...(isForgedCapture ? {
      forged_recording_id: storedWorkoutMetrics.forged_recording_id || existingRun.id,
    } : {}),
    ...(incomingRouteReplacesStored ? { route_source: item.source } : {}),
    ...(preserveForgedRoute ? { route_source: 'forged_phone' } : {}),
  };
  const canonicalDistance = authoritativeSummaryUpdate && item.distanceMiles > 0 ? item.distanceMiles : null;
  const canonicalDuration = authoritativeSummaryUpdate && item.durationSeconds > 0 ? item.durationSeconds : null;
  const canonicalPace = canonicalDistance && canonicalDuration
    ? canonicalDuration / canonicalDistance
    : null;
  const incomingCalories = asNumber(item.calories, null);
  const canonicalSensorCalories = sensorSummaryWins
    ? (incomingCalories > 0 ? Math.round(incomingCalories) : null)
    : null;
  const sensorCalorieAction = sensorSummaryWins
    ? incomingCalories > 0
      ? 1
      : authorityChanged && storedSourcePriority === 0
        ? 2
        : 0
    : 0;
  const importedCalories = summaryUpdateAllowed && incomingCalories > 0
    ? Math.round(incomingCalories)
    : 0;
  const fillMissingSummaryValue = (value, storedValue) => (
    summaryUpdateAllowed || (
      isTrustedSensorSummarySource(incomingSource)
      && (storedValue === null || storedValue === undefined || storedValue === '')
    )
      ? value
      : null
  );
  const canonicalAvgHeartRate = fillMissingSummaryValue(item.avgHeartRate, existingRun.avg_heart_rate);
  const canonicalMaxHeartRate = fillMissingSummaryValue(item.maxHeartRate, existingRun.max_heart_rate);
  const canonicalMinHeartRate = fillMissingSummaryValue(item.minHeartRate, existingRun.min_heart_rate);
  const canonicalZones = fillMissingSummaryValue(zoneParam, existingRun.heart_rate_zones);
  const canonicalHealthSource = authoritativeSummaryUpdate ? item.source : null;
  const canonicalHealthSourceWorkoutId = authoritativeSummaryUpdate ? item.sourceWorkoutId : null;
  const canonicalHealthStartAt = authoritativeSummaryUpdate ? item.startDate : null;
  const canonicalHealthEndAt = authoritativeSummaryUpdate ? item.endDate : null;
  const canonicalType = authoritativeSummaryUpdate && item.section === 'activity' ? item.runType : null;
  const canonicalWatchActivityType = authoritativeSummaryUpdate ? String(item.raw?.type || item.raw?.activityType || 'imported') : null;
  const canonicalWatchNormalizedType = authoritativeSummaryUpdate ? item.runType : null;
  const canonicalCadence = fillMissingSummaryValue(item.cadenceSpm, existingRun.cadence_spm);
  const canonicalElevationGain = fillMissingSummaryValue(item.elevationGain, existingRun.elevation_gain);
  const canonicalElevationLoss = fillMissingSummaryValue(item.elevationLoss, existingRun.elevation_loss);
  const canonicalVo2Max = fillMissingSummaryValue(item.vo2Max, existingRun.vo2_max);
  const canonicalTrainingEffectAerobic = fillMissingSummaryValue(
    item.trainingEffectAerobic,
    existingRun.training_effect_aerobic
  );
  const canonicalTrainingEffectAnaerobic = fillMissingSummaryValue(
    item.trainingEffectAnaerobic,
    existingRun.training_effect_anaerobic
  );
  const canonicalRecoveryTimeHours = fillMissingSummaryValue(
    item.recoveryTimeHours,
    existingRun.recovery_time_hours
  );
  const canonicalTemperatureF = fillMissingSummaryValue(item.temperatureF, existingRun.temperature_f);
  const routeChanged = incomingRouteReplacesStored
    && !structuredValuesEqual(item.routeCoords, storedRouteCoords);
  const workoutMetricsChanged = !structuredValuesEqual(mergedWorkoutMetrics, storedWorkoutMetrics);
  const workoutMetricStreamsChanged = !structuredValuesEqual(mergedWorkoutMetricStreams, storedWorkoutMetricStreams);
  const sensorCaloriesChanged = sensorCalorieAction === 1
    ? incomingValueChangesStored(canonicalSensorCalories, existingRun.calories)
      || incomingValueChangesStored(canonicalSensorCalories, existingRun.calories_burned)
      || incomingValueChangesStored(canonicalSensorCalories, existingRun.calories_watch)
    : sensorCalorieAction === 2
      && [existingRun.calories, existingRun.calories_burned, existingRun.calories_watch]
        .some((value) => !storedValueMissing(value));
  const importedCaloriesChanged = sensorCalorieAction === 0
    && importedCalories > 0
    && incomingValueChangesStored(importedCalories, existingRun.calories);
  const summaryChanged = [
    [canonicalDistance, existingRun.distance_miles],
    [canonicalDuration, existingRun.duration_seconds],
    [importedEffort, existingRun.perceived_effort],
    [canonicalAvgHeartRate, existingRun.avg_heart_rate],
    [canonicalMaxHeartRate, existingRun.max_heart_rate],
    [canonicalMinHeartRate, existingRun.min_heart_rate],
    [canonicalZones, existingRun.heart_rate_zones],
    [canonicalType, existingRun.type],
    [canonicalWatchActivityType, existingRun.watch_activity_type],
    [canonicalWatchNormalizedType, existingRun.watch_normalized_type],
    [canonicalCadence, existingRun.cadence_spm],
    [canonicalElevationGain, existingRun.elevation_gain],
    [canonicalElevationLoss, existingRun.elevation_loss],
    [canonicalVo2Max, existingRun.vo2_max],
    [canonicalTrainingEffectAerobic, existingRun.training_effect_aerobic],
    [canonicalTrainingEffectAnaerobic, existingRun.training_effect_anaerobic],
    [canonicalRecoveryTimeHours, existingRun.recovery_time_hours],
    [canonicalTemperatureF, existingRun.temperature_f],
  ].some(([incomingValue, storedValue]) => incomingValueChangesStored(incomingValue, storedValue))
    || routeChanged
    || workoutMetricsChanged
    || workoutMetricStreamsChanged
    || sensorCaloriesChanged
    || importedCaloriesChanged;
  const invalidateAiFeedback = authorityChanged || summaryChanged;

  await db.run(
    `UPDATE runs SET
      distance_miles = COALESCE(?, distance_miles),
      duration_seconds = COALESCE(?, duration_seconds),
      pace_avg = COALESCE(?, pace_avg),
      perceived_effort = COALESCE(?, perceived_effort),
      avg_heart_rate = COALESCE(?, avg_heart_rate),
      max_heart_rate = COALESCE(?, max_heart_rate),
      min_heart_rate = COALESCE(?, min_heart_rate),
      heart_rate_zones = COALESCE(?, heart_rate_zones),
      health_source = COALESCE(?, health_source),
      health_source_workout_id = COALESCE(?, health_source_workout_id),
      health_start_at = COALESCE(?, health_start_at),
      health_end_at = COALESCE(?, health_end_at),
      type = COALESCE(?, type),
      watch_activity_type = COALESCE(?, watch_activity_type),
      watch_normalized_type = COALESCE(?, watch_normalized_type),
      cadence_spm = COALESCE(?, cadence_spm),
      elevation_gain = COALESCE(?, elevation_gain),
      elevation_loss = COALESCE(?, elevation_loss),
      route_coords = COALESCE(NULLIF(?, '[]'), route_coords),
      vo2_max = COALESCE(?, vo2_max),
      training_effect_aerobic = COALESCE(?, training_effect_aerobic),
      training_effect_anaerobic = COALESCE(?, training_effect_anaerobic),
      recovery_time_hours = COALESCE(?, recovery_time_hours),
      temperature_f = COALESCE(?, temperature_f),
      calories = CASE CAST(? AS INTEGER) WHEN 1 THEN ? WHEN 2 THEN NULL ELSE CASE WHEN CAST(? AS INTEGER)>0 THEN ? ELSE calories END END,
      calories_burned = CASE CAST(? AS INTEGER) WHEN 1 THEN ? WHEN 2 THEN NULL ELSE calories_burned END,
      calories_watch = CASE CAST(? AS INTEGER) WHEN 1 THEN ? WHEN 2 THEN NULL ELSE calories_watch END,
      workout_metrics_json = COALESCE(NULLIF(?, '{}'), workout_metrics_json),
      workout_metric_streams_json = COALESCE(NULLIF(?, '{}'), workout_metric_streams_json),
      plan_session_id = COALESCE(NULLIF(plan_session_id, ''), ?),
      planned_session_json = CASE
        WHEN planned_session_json IS NULL OR planned_session_json='' OR planned_session_json='{}'
          THEN COALESCE(?, '{}')
        ELSE planned_session_json
      END,
      ai_feedback = CASE WHEN CAST(? AS INTEGER)=1 THEN NULL ELSE ai_feedback END,
      ai_feedback_requested_at = CASE WHEN CAST(? AS INTEGER)=1 THEN NULL ELSE ai_feedback_requested_at END
     WHERE id=? AND user_id=?`,
    [
      canonicalDistance,
      canonicalDuration,
      canonicalPace,
      importedEffort,
      canonicalAvgHeartRate,
      canonicalMaxHeartRate,
      canonicalMinHeartRate,
      canonicalZones,
      canonicalHealthSource,
      canonicalHealthSourceWorkoutId,
      canonicalHealthStartAt,
      canonicalHealthEndAt,
      canonicalType,
      canonicalWatchActivityType,
      canonicalWatchNormalizedType,
      canonicalCadence,
      canonicalElevationGain,
      canonicalElevationLoss,
      JSON.stringify(incomingRouteReplacesStored ? item.routeCoords : []),
      canonicalVo2Max,
      canonicalTrainingEffectAerobic,
      canonicalTrainingEffectAnaerobic,
      canonicalRecoveryTimeHours,
      canonicalTemperatureF,
      sensorCalorieAction,
      canonicalSensorCalories,
      importedCalories,
      importedCalories,
      sensorCalorieAction,
      canonicalSensorCalories,
      sensorCalorieAction,
      canonicalSensorCalories,
      JSON.stringify(mergedWorkoutMetrics),
      JSON.stringify(mergedWorkoutMetricStreams),
      planned?.sessionId || null,
      planned ? JSON.stringify(planned) : null,
      invalidateAiFeedback ? 1 : 0,
      invalidateAiFeedback ? 1 : 0,
      existingRun.id,
      userId,
    ]
  );
  return existingRun.id;
}

async function updateImportedRunPrs(userId, runId, { tx = null } = {}) {
  const get = tx?.get || dbGet;
  const run = await get('SELECT * FROM runs WHERE id=? AND user_id=?', [runId, userId]);
  if (run) await autoUpdatePRs(userId, run, tx ? { tx } : undefined);
}

async function insertLift(db, userId, item) {
  const liftId = uuidv4();
  const distanceTag = `[import_distance:${Number(item.distanceMiles || 0).toFixed(3)}]`;
  await db.run(
    `INSERT INTO lifts (
      id, user_id, date, muscle_groups, intensity, notes, exercise_name,
      workout_duration_seconds, avg_heart_rate, category, watch_activity_type, watch_normalized_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      liftId,
      userId,
      item.date,
      JSON.stringify([]),
      'moderate',
      `Imported workout ${distanceTag}`,
      'Imported Strength Session',
      item.durationSeconds || null,
      item.avgHeartRate,
      item.liftCategory || 'strength',
      String(item.raw?.type || item.raw?.activityType || 'imported'),
      'imported',
    ]
  );
  return liftId;
}

async function findRunById(db, userId, runId) {
  return db.get(
    `SELECT id, date, type, watch_mode, watch_activity_type, watch_normalized_type,
            duration_seconds, health_start_at, created_at, health_source, health_source_workout_id,
            distance_miles, route_coords, perceived_effort, pain_level, post_energy, notes,
            avg_heart_rate, max_heart_rate, heart_rate_zones, cadence_spm,
            elevation_gain, elevation_loss, vo2_max, training_effect_aerobic,
            training_effect_anaerobic, recovery_time_hours, temperature_f,
            calories, calories_burned, calories_watch, shoe_id, plan_session_id,
            planned_session_json, workout_metrics_json, ai_feedback, ai_feedback_requested_at
     FROM runs
     WHERE id=? AND user_id=?
     LIMIT 1
     FOR UPDATE`,
    [runId, userId]
  );
}

async function hasDirectRunInteractions(db, userId, runId) {
  const row = await db.get(
    `SELECT
       CASE WHEN EXISTS (
         SELECT 1
         FROM runs
         WHERE id=? AND user_id=?
       ) THEN
         (SELECT COUNT(*) FROM activity_likes WHERE activity_id=? AND (activity_type='run' OR activity_type IS NULL)) +
         (SELECT COUNT(*) FROM activity_comments WHERE activity_id=? AND (activity_type='run' OR activity_type IS NULL))
       ELSE 0 END AS interaction_count`,
    [runId, userId, runId, runId]
  );
  return Number(row?.interaction_count || 0) > 0;
}

async function findRunAdjustmentProposal(db, userId, runId) {
  return db.get(
    `SELECT id, trigger_run_id, user_plan_id, plan_id, plan_version,
            window_start, window_end, planning_date, status, safety_exception,
            original_json, proposed_json, changes_json, evidence_json, reason
     FROM plan_adjustment_proposals
     WHERE user_id=? AND trigger_run_id=?
     LIMIT 1
     FOR UPDATE`,
    [userId, runId]
  );
}

async function applyRunConsolidationPatch(db, userId, canonicalRunId, patch) {
  await db.run(
    `UPDATE runs SET
       notes=COALESCE(?, notes),
       perceived_effort=COALESCE(?, perceived_effort),
       pain_level=COALESCE(?, pain_level),
       post_energy=COALESCE(?, post_energy),
       shoe_id=COALESCE(?, shoe_id),
       plan_session_id=COALESCE(?, plan_session_id),
       planned_session_json=CASE
         WHEN CAST(? AS TEXT) IS NOT NULL THEN ?
         ELSE planned_session_json
       END
     WHERE id=? AND user_id=?`,
    [
      patch.notes,
      patch.perceivedEffort,
      patch.painLevel,
      patch.postEnergy,
      patch.shoeId,
      patch.planSessionId,
      patch.plannedSessionJson,
      patch.plannedSessionJson,
      canonicalRunId,
      userId,
    ]
  );
}

async function repointOwnedRunReferences(db, userId, duplicateRunId, canonicalRunId, {
  duplicateProposal = null,
} = {}) {
  await db.run(
    'UPDATE personal_records SET run_id=? WHERE run_id=? AND user_id=?',
    [canonicalRunId, duplicateRunId, userId]
  );
  await db.run(
    'UPDATE shared_routes SET run_id=? WHERE run_id=? AND user_id=?',
    [canonicalRunId, duplicateRunId, userId]
  );
  await db.run(
    'UPDATE community_posts SET run_id=? WHERE run_id=? AND user_id=?',
    [canonicalRunId, duplicateRunId, userId]
  );
  await db.run(
    "UPDATE activity_media SET activity_id=? WHERE activity_id=? AND user_id=? AND activity_type='run'",
    [canonicalRunId, duplicateRunId, userId]
  );

  if (duplicateProposal) {
    await db.run(
      'UPDATE plan_adjustment_proposals SET trigger_run_id=? WHERE trigger_run_id=? AND user_id=?',
      [canonicalRunId, duplicateRunId, userId]
    );
  }
  await db.run(
    `UPDATE activity_import_claims
     SET activity_id=?, updated_at=NOW()
     WHERE activity_kind='run' AND activity_id=? AND user_id=?`,
    [canonicalRunId, duplicateRunId, userId]
  );
}

async function consolidateImportedRunIntoForged(db, userId, importedRun, item) {
  if (
    !importedRun
    || hasForgedRecordingProvenance(importedRun)
    || !isTrustedSensorSummarySource(item.source)
  ) {
    return null;
  }
  const forgedRun = await findMatchingForgedRun(db, userId, {
    ...item,
    startDate: importedRun.health_start_at || item.startDate,
    createdAt: importedRun.created_at || item.createdAt,
  }, { excludeId: importedRun.id });
  if (!forgedRun) return null;
  if (await hasDirectRunInteractions(db, userId, importedRun.id)) {
    console.warn(`[import] skipped automatic run consolidation for ${importedRun.id}: direct activity interactions exist`);
    return null;
  }
  const canonicalProposal = await findRunAdjustmentProposal(db, userId, forgedRun.id);
  const duplicateProposal = await findRunAdjustmentProposal(db, userId, importedRun.id);
  const hasEquivalentDualProposals = canonicalProposal
    && duplicateProposal
    && runAdjustmentProposalsEquivalent(canonicalProposal, duplicateProposal);
  if (canonicalProposal && duplicateProposal) {
    if (!hasEquivalentDualProposals) {
      console.warn(`[import] skipped automatic run consolidation for ${importedRun.id}: both runs have different plan adjustment decisions`);
      return null;
    }
  }
  const merge = analyzeRunConsolidation(forgedRun, importedRun, item);
  const blockingConflicts = merge.conflicts.filter((conflict) => (
    conflict !== 'plan link'
    || !hasEquivalentDualProposals
    || !canPreserveExplicitUnlinkedPlan(forgedRun, importedRun)
  ));
  if (blockingConflicts.length) {
    console.warn(`[import] skipped automatic run consolidation for ${importedRun.id}: conflicting ${blockingConflicts.join(', ')}`);
    return null;
  }
  if (hasEquivalentDualProposals) {
    const removed = await db.run(
      `DELETE FROM plan_adjustment_proposals
       WHERE id=? AND user_id=? AND trigger_run_id=? AND status IN ('pending','reviewed')`,
      [canonicalProposal.id, userId, forgedRun.id]
    );
    if (removed.changes !== 1) throw new Error('Equivalent run adjustment proposal could not be consolidated');
  }

  await applyRunConsolidationPatch(db, userId, forgedRun.id, merge.patch);
  const patchedForgedRun = {
    ...forgedRun,
    notes: merge.patch.notes || forgedRun.notes,
    perceived_effort: merge.patch.perceivedEffort ?? forgedRun.perceived_effort,
    pain_level: merge.patch.painLevel || forgedRun.pain_level,
    post_energy: merge.patch.postEnergy || forgedRun.post_energy,
    shoe_id: merge.patch.shoeId || forgedRun.shoe_id,
    plan_session_id: merge.patch.planSessionId || forgedRun.plan_session_id,
    planned_session_json: merge.patch.plannedSessionJson || forgedRun.planned_session_json,
  };
  const canonicalRunId = await updateExistingRunHealth(db, userId, patchedForgedRun, item);
  await repointOwnedRunReferences(db, userId, importedRun.id, canonicalRunId, { duplicateProposal });
  await db.run('DELETE FROM runs WHERE id=? AND user_id=?', [importedRun.id, userId]);
  return canonicalRunId;
}

async function claimImportedActivity(db, userId, item) {
  const sourceKey = canonicalImportSourceKey(item);
  const claimToken = uuidv4();
  await db.run(
    `INSERT INTO activity_import_claims (user_id, source_key, claim_token)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id, source_key) DO NOTHING`,
    [userId, sourceKey, claimToken]
  );
  const claim = await db.get(
    `SELECT source_key, claim_token, activity_kind, activity_id
     FROM activity_import_claims
     WHERE user_id=? AND source_key=?
     FOR UPDATE`,
    [userId, sourceKey]
  );
  if (!claim) {
    const error = new Error('Unable to acquire workout import claim');
    error.code = 'IMPORT_CLAIM_FAILED';
    throw error;
  }
  return { ...claim, sourceKey, claimToken, owned: claim.claim_token === claimToken };
}

async function recoverStaleClaim(db, userId, claim) {
  const result = await db.run(
    `UPDATE activity_import_claims
     SET claim_token=?, activity_kind=NULL, activity_id=NULL, updated_at=NOW()
     WHERE user_id=? AND source_key=? AND claim_token=?`,
    [claim.claimToken, userId, claim.sourceKey, claim.claim_token]
  );
  if (result.changes !== 1) {
    const error = new Error('Workout import claim changed before recovery');
    error.code = 'IMPORT_CLAIM_FAILED';
    throw error;
  }
}

async function finalizeImportClaim(db, userId, claim, activityKindName, activityId) {
  const result = await db.run(
    `UPDATE activity_import_claims
     SET activity_kind=?, activity_id=?, updated_at=NOW()
     WHERE user_id=? AND source_key=? AND claim_token=?`,
    [activityKindName, activityId, userId, claim.sourceKey, claim.claimToken]
  );
  if (result.changes !== 1) {
    const error = new Error('Workout import claim could not be finalized');
    error.code = 'IMPORT_CLAIM_FAILED';
    throw error;
  }
}

async function importItem(db, userId, item) {
  if ((item.section === 'run' || item.section === 'activity') && await isDeletedImport(db, userId, item)) {
    return { status: 'skipped', runId: null, changed: false };
  }

  const claim = await claimImportedActivity(db, userId, item);
  if (!claim.owned) {
    if (claim.activity_kind === 'run' && claim.activity_id) {
      const claimedRun = await findRunById(db, userId, claim.activity_id);
      if (claimedRun) {
        const consolidatedRunId = await consolidateImportedRunIntoForged(db, userId, claimedRun, item);
        if (consolidatedRunId) return { status: 'skipped', runId: consolidatedRunId, changed: true };
        const runId = await updateExistingRunHealth(db, userId, claimedRun, item);
        return {
          status: 'skipped',
          runId,
          changed: true,
          identityDecision: {
            kept_ref: claimedRun.id,
            suppressed_ref: item.sourceWorkoutId || claim.sourceKey,
            reason_code: item.sourceWorkoutId ? 'EXACT_SOURCE_ACTIVITY_ID' : 'EXACT_IMPORT_CLAIM',
          },
        };
      }
    } else if (claim.activity_kind === 'lift' && claim.activity_id) {
      const claimedLift = await db.get('SELECT id FROM lifts WHERE id=? AND user_id=? LIMIT 1', [claim.activity_id, userId]);
      if (claimedLift) return { status: 'skipped', runId: null, changed: false };
    }
    await recoverStaleClaim(db, userId, claim);
  }

  if (item.section === 'run' || item.section === 'activity') {
    const existingMatch = await findExistingRun(db, userId, item);
    const existing = existingMatch.run;
    const consolidatedRunId = await consolidateImportedRunIntoForged(db, userId, existing, item);
    if (consolidatedRunId) {
      await finalizeImportClaim(db, userId, claim, 'run', consolidatedRunId);
      return { status: 'skipped', runId: consolidatedRunId, changed: true, identityDecision: existingMatch.identityDecision };
    }
    const runId = existing
      ? await updateExistingRunHealth(db, userId, existing, item, {
        preserveRawIdentityFacts: Boolean(existingMatch.identityDecision
          && existingMatch.identityDecision.reason_code !== 'EXACT_SOURCE_ACTIVITY_ID'),
      })
      : await insertRun(db, userId, item);
    await finalizeImportClaim(db, userId, claim, 'run', runId);
    return { status: existing ? 'skipped' : 'imported', runId, changed: true, identityDecision: existingMatch.identityDecision };
  }

  const existingLift = await findExistingLift(db, userId, item.date, item.distanceMiles, item.durationSeconds);
  const liftId = existingLift?.id || await insertLift(db, userId, item);
  await finalizeImportClaim(db, userId, claim, 'lift', liftId);
  return { status: existingLift ? 'skipped' : 'imported', runId: null, changed: !existingLift };
}

async function importRows(userId, rawRows, {
  transaction = null,
  updateRunPrs = updateImportedRunPrs,
} = {}) {
  const errors = [];
  let imported = 0;
  let skipped = 0;
  const identityDecisions = [];
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const transactionRunner = transaction || ((callback) => withPlanningInputMutation(userId, async (tx) => {
    const outcome = await callback(tx);
    return outcome.changed ? outcome : planningInputUnchanged(outcome);
  }));

  for (let i = 0; i < rows.length; i += 1) {
    try {
      const item = normalizeRow(rows[i]);
      if (!item.date) {
        skipped += 1;
        continue;
      }
      const outcome = await transactionRunner(
        async (tx) => {
          const importedItem = await importItem(tx, userId, item);
          if (importedItem.runId) {
            try {
              await updateRunPrs(userId, importedItem.runId, { tx });
            } catch (error) {
              console.error(`[import] PR refresh failed for run ${importedItem.runId}:`, error.message);
            }
          }
          return importedItem;
        },
        { userIds: [userId], requireUserIds: [userId] }
      );
      if (outcome.status === 'imported') imported += 1;
      else skipped += 1;
      if (outcome.identityDecision) identityDecisions.push(outcome.identityDecision);

    } catch (err) {
      console.error(`[import] row ${i} failed:`, err.message);
      errors.push({
        index: i,
        error: err.message || 'Import failed for row',
        code: err.code || 'IMPORT_OPERATION_FAILED',
        retryable: err.code !== 'IMPORT_ROW_INVALID',
      });
    }
  }

  return { imported, skipped, errors, identity_decision_receipt: buildActivityIdentityReceipt(identityDecisions) };
}

router.post('/health', auth, async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body?.workouts;
    const result = await importRows(req.user.id, rows);
    res.json(result);
  } catch (err) {
    console.error('[import/health] failed:', err.message);
    res.status(500).json({ imported: 0, skipped: 0, errors: [{ error: 'Apple Health import failed' }] });
  }
});

router.post('/workouts', auth, async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body?.workouts;
    const result = await importRows(req.user.id, rows);
    res.json(result);
  } catch (err) {
    console.error('[import/workouts] failed:', err.message);
    res.status(500).json({ imported: 0, skipped: 0, errors: [{ error: 'Workout import failed' }] });
  }
});

module.exports = router;
module.exports._test = {
  analyzeRunConsolidation,
  classifyType,
  canonicalImportSourceKey,
  importRows,
  normalizeRouteCoords,
  normalizeRow,
  selectExistingRunIdentityMatch,
  importKeysForItem,
  resolveCanonicalDistanceSource,
  canPreserveExplicitUnlinkedPlan,
  runAdjustmentProposalsEquivalent,
  chooseForgedRunMatch,
  consolidateImportedRunIntoForged,
  updateExistingRunHealth,
};
