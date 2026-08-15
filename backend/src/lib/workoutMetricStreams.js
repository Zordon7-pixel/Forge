const MAX_STREAM_POINTS = 600;
const MAX_WORKOUT_SECONDS = 48 * 60 * 60;

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
    const t = Number(Array.isArray(point) ? point[0] : point?.t ?? point?.time);
    const v = Number(Array.isArray(point) ? point[1] : point?.v ?? point?.value);
    if (!Number.isFinite(t) || !Number.isFinite(v)) return [];
    if (t < 0 || t > spec.maxSeconds || v < spec.min || v > spec.max) return [];
    return [{ t: Math.round(t * 10) / 10, v: Math.round(v * 100) / 100 }];
  }).sort((left, right) => left.t - right.t);

  const deduped = [];
  for (const point of normalized) {
    if (deduped.length && deduped.at(-1).t === point.t) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  return boundedPoints(deduped);
}

function normalizeWorkoutMetricStreams(raw = {}) {
  const outer = parseObject(raw);
  const nested = outer.workoutMetricStreams
    ?? outer.workout_metric_streams
    ?? outer.metricStreams
    ?? outer;
  const source = parseObject(nested);
  const normalized = { version: 1 };
  const metricSource = String(source.source || outer.source || '').trim().slice(0, 40);
  if (metricSource) normalized.source = metricSource;

  for (const [key, spec] of Object.entries(STREAM_SPECS)) {
    const points = normalizeStream(source[key], spec);
    if (points.length) normalized[key] = points;
  }

  return Object.keys(normalized).length > (metricSource ? 2 : 1) ? normalized : {};
}

function mergeWorkoutMetricStreams(stored, incoming) {
  const existing = normalizeWorkoutMetricStreams(stored);
  const next = normalizeWorkoutMetricStreams(incoming);
  if (!Object.keys(next).length) return existing;
  const merged = {
    ...existing,
    version: 1,
    source: next.source || existing.source,
  };
  for (const key of Object.keys(STREAM_SPECS)) {
    if (Array.isArray(next[key]) && next[key].length) merged[key] = next[key];
  }
  return merged;
}

module.exports = {
  MAX_STREAM_POINTS,
  STREAM_SPECS,
  mergeWorkoutMetricStreams,
  normalizeWorkoutMetricStreams,
};
