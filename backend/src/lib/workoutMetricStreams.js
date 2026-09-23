const MAX_STREAM_POINTS = 600;
const MAX_WORKOUT_SECONDS = 48 * 60 * 60;
const STREAM_VERSION = 2;

const STREAM_SPECS = Object.freeze({
  heart_rate_bpm: { min: 30, max: 250, maxSeconds: MAX_WORKOUT_SECONDS },
  post_workout_heart_rate_bpm: { min: 30, max: 250, maxSeconds: 5 * 60 },
  running_speed_mps: { min: 0, max: 15, maxSeconds: MAX_WORKOUT_SECONDS },
  running_power_watts: { min: 0, max: 2000, maxSeconds: MAX_WORKOUT_SECONDS },
  running_cadence_spm: { min: 0, max: 300, maxSeconds: MAX_WORKOUT_SECONDS },
  running_stride_length_m: { min: 0.2, max: 3, maxSeconds: MAX_WORKOUT_SECONDS },
  running_vertical_oscillation_cm: { min: 0, max: 30, maxSeconds: MAX_WORKOUT_SECONDS },
  running_ground_contact_time_ms: { min: 50, max: 1000, maxSeconds: MAX_WORKOUT_SECONDS },
});

function parseObject(raw) {
  if (!raw) return {};
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error('[workoutMetricStreams] JSON parse failed:', error.message);
      return {};
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function boundedPoints(points) {
  if (points.length <= MAX_STREAM_POINTS) return points;
  const lastIndex = points.length - 1;
  const scale = lastIndex / (MAX_STREAM_POINTS - 1);
  const used = new Set();
  return Array.from({ length: MAX_STREAM_POINTS }, (_, index) => {
    const sourceIndex = Math.min(lastIndex, Math.round(index * scale));
    if (used.has(sourceIndex)) return null;
    used.add(sourceIndex);
    return points[sourceIndex];
  }).filter(Boolean);
}

function normalizeStream(rawPoints, spec) {
  if (!Array.isArray(rawPoints)) return [];
  const normalized = rawPoints.flatMap((point) => {
    const pair = Array.isArray(point) ? point.length === 2 ? point : []
      : point && typeof point === 'object' ? [Object.hasOwn(point, 't') ? point.t : point.time,
        Object.hasOwn(point, 'v') ? point.v : point.value] : [];
    const t = streamNumber(pair[0]), v = streamNumber(pair[1]);
    if (t === null || v === null) return [];
    if (t < 0 || t > spec.maxSeconds || v < spec.min || v > spec.max) return [];
    return [{ t: Math.round(t * 10) / 10 || 0, v: Math.round(v * 100) / 100 || 0 }];
  }).sort((left, right) => left.t - right.t);

  const deduped = [];
  for (const point of normalized) {
    if (deduped.length && deduped.at(-1).t === point.t) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  return boundedPoints(deduped);
}

// Native callers send numbers. Retain only bounded decimal-string compatibility
// for persisted/import JSON; never coerce null, booleans, containers or blanks.
function streamNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 32 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function declaredSource(value) {
  if (typeof value !== 'string') return null;
  const source = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,39}$/.test(source) && !['unknown', 'mixed'].includes(source.toLowerCase()) ? source : null;
}
function metricOrigin(source, key, incoming) {
  if (source.version === STREAM_VERSION) {
    const meta = source.metric_sources?.[key];
    const declared = meta?.basis === 'DECLARED' ? declaredSource(meta.declared_source) : null;
    const legacy = meta?.basis === 'LEGACY_GLOBAL_ONLY' ? declaredSource(meta.legacy_global_source) : null;
    return { declared_source: declared, verification_status: 'UNVERIFIED',
      basis: declared ? 'DECLARED' : legacy ? 'LEGACY_GLOBAL_ONLY' : 'UNKNOWN',
      ...(legacy ? { legacy_global_source: legacy } : {}) };
  }
  const declared = declaredSource(source.source);
  return { declared_source: incoming ? declared : null, verification_status: 'UNVERIFIED',
    basis: declared ? incoming ? 'DECLARED' : 'LEGACY_GLOBAL_ONLY' : 'UNKNOWN',
    ...(!incoming && declared ? { legacy_global_source: declared } : {}) };
}
function globalSource(metricSources) {
  const sources = new Set(Object.values(metricSources).map(meta => meta.declared_source || 'unknown'));
  return sources.size === 1 ? [...sources][0] : 'mixed';
}
function normalizeWorkoutMetricStreams(raw = {}, { inputKind = 'stored' } = {}) {
  const outer = parseObject(raw);
  const nested = outer.workoutMetricStreams
    ?? outer.workout_metric_streams
    ?? outer.metricStreams
    ?? outer;
  const source = parseObject(nested);
  const origins = {};
  const normalized = { version: STREAM_VERSION, source: 'unknown', metric_sources: origins };

  for (const [key, spec] of Object.entries(STREAM_SPECS)) {
    const points = normalizeStream(source[key], spec);
    if (points.length) {
      normalized[key] = points;
      origins[key] = metricOrigin(source, key, inputKind === 'incoming');
    }
  }

  if (!Object.keys(origins).length) return {};
  normalized.source = globalSource(origins);
  return normalized;
}

function mergeWorkoutMetricStreams(stored, incoming) {
  const existing = normalizeWorkoutMetricStreams(stored);
  const next = normalizeWorkoutMetricStreams(incoming, { inputKind: 'incoming' });
  if (!Object.keys(next).length) return existing;
  const merged = {
    ...existing,
    version: STREAM_VERSION,
    metric_sources: { ...existing.metric_sources },
  };
  for (const key of Object.keys(STREAM_SPECS)) {
    if (Array.isArray(next[key]) && next[key].length) {
      merged[key] = next[key];
      merged.metric_sources[key] = next.metric_sources[key];
    }
  }
  merged.source = globalSource(merged.metric_sources);
  return merged;
}

module.exports = {
  MAX_STREAM_POINTS,
  STREAM_VERSION,
  STREAM_SPECS,
  mergeWorkoutMetricStreams,
  normalizeWorkoutMetricStreams,
};
