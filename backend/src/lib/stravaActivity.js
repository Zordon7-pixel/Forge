function boundedNumber(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function toDateString(value) {
  const raw = String(value || '').trim();
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function decodeSummaryPolyline(encodedValue) {
  const encoded = String(encodedValue || '');
  if (!encoded || encoded.length > 100000) return [];

  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length && points.length < 5000) {
    const deltas = [];
    for (let coordinateIndex = 0; coordinateIndex < 2; coordinateIndex += 1) {
      let result = 0;
      let shift = 0;
      let byte = 0;
      do {
        if (index >= encoded.length || shift > 30) return [];
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        if (byte < 0 || byte > 63) return [];
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      deltas.push((result & 1) ? ~(result >> 1) : (result >> 1));
    }
    latitude += deltas[0];
    longitude += deltas[1];
    const lat = latitude / 1e5;
    const lon = longitude / 1e5;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return [];
    points.push({ lat, lon });
  }
  return points;
}

function normalizeStravaRun(activity = {}) {
  const meters = boundedNumber(activity.distance, 0, 1000000) || 0;
  const distanceMiles = Number((meters / 1609.34).toFixed(3));
  const movingSeconds = Math.max(0, Math.round(boundedNumber(activity.moving_time, 0, 172800) || 0));
  const elapsedSeconds = Math.max(movingSeconds, Math.round(boundedNumber(activity.elapsed_time, 0, 172800) || movingSeconds));
  const elevationMeters = boundedNumber(activity.total_elevation_gain, 0, 30000);
  const perceivedEffort = boundedNumber(activity.perceived_exertion, 1, 10);
  const averageHeartRate = boundedNumber(activity.average_heartrate, 30, 250);
  const rawStartDate = String(activity.start_date || '').trim();
  const startTime = new Date(rawStartDate).getTime();
  const startDate = Number.isFinite(startTime) ? new Date(startTime).toISOString() : null;
  const endDate = startDate && elapsedSeconds > 0
    ? new Date(startTime + elapsedSeconds * 1000).toISOString()
    : null;
  const rawActivityId = String(activity.id || '').trim();
  return {
    activityId: /^\d{1,30}$/.test(rawActivityId) ? rawActivityId : '',
    date: toDateString(activity.start_date_local || startDate),
    startDate,
    endDate,
    distanceMiles,
    movingSeconds,
    elapsedSeconds,
    calories: boundedNumber(activity.calories, 0, 30000) || 0,
    perceivedEffort: perceivedEffort === null ? null : Math.round(perceivedEffort),
    averageHeartRate: averageHeartRate === null ? null : Math.round(averageHeartRate),
    elevationGainFeet: elevationMeters === null ? null : Number((elevationMeters * 3.280839895).toFixed(1)),
    routeCoords: decodeSummaryPolyline(activity.map?.summary_polyline),
    activityType: String(activity.sport_type || activity.type || 'Run').slice(0, 40),
    name: String(activity.name || 'Run').trim().slice(0, 120) || 'Run',
  };
}

function chooseMatchingHealthRun(candidates, incoming) {
  const durationMatches = (Array.isArray(candidates) ? candidates : []).filter((row) => {
    const duration = Number(row.duration_seconds || 0);
    return Math.min(
      Math.abs(duration - incoming.movingSeconds),
      Math.abs(duration - incoming.elapsedSeconds)
    ) <= 5 * 60;
  });
  if (!durationMatches.length) return null;

  const incomingStart = new Date(incoming.startDate || '').getTime();
  if (Number.isFinite(incomingStart)) {
    const timed = durationMatches
      .map((row) => ({ row, delta: Math.abs(new Date(row.health_start_at || '').getTime() - incomingStart) }))
      .filter((entry) => Number.isFinite(entry.delta) && entry.delta <= 15 * 60 * 1000)
      .sort((a, b) => a.delta - b.delta);
    if (timed.length) return timed[0].row;
  }
  return durationMatches.length === 1 ? durationMatches[0] : null;
}

module.exports = {
  chooseMatchingHealthRun,
  decodeSummaryPolyline,
  normalizeStravaRun,
};
