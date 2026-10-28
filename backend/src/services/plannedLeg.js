const { createHash } = require('node:crypto');

const MAX_BYTES = 512 * 1024;
const TTL_MS = 86400000;
const TIMEOUT_MS = 8000;
const PROFILES = ['foot-walking', 'foot-hiking'];
class PlanningError extends Error {
  constructor(code, status = 503, retryAfter = undefined) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
const fail = (code = 'PLANNING_UNAVAILABLE', status = 503) => { throw new PlanningError(code, status); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
const bounded = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const point = p => Array.isArray(p) && p.length === 2 && bounded(p[0], -180, 180) && bounded(p[1], -90, 90);
function validateInput(body) {
  if (!keys(body, ['profile', 'points']) || !PROFILES.includes(body.profile)
    || !Array.isArray(body.points) || body.points.length !== 2 || !point(body.points[0]) || !point(body.points[1])) {
    fail('INVALID_LEG', 400);
  }
  // No client routing options in v1. Version binds the fixed options in the key.
  return { profile: body.profile, points: body.points.map(p => p.map(n => Number(n.toFixed(5)) || 0)) };
}
function cacheKey(owner, input) {
  return createHash('sha256').update(JSON.stringify(['leg-v1', owner, input.profile,
    { instructions: false, elevation: false }, input.points])).digest('hex');
}
function validateLeg(leg) {
  if (!keys(leg, ['profile', 'geometry', 'distanceMeters', 'durationSeconds'])
    || !PROFILES.includes(leg.profile) || !keys(leg.geometry, ['type', 'coordinates'])
    || leg.geometry.type !== 'LineString' || !Array.isArray(leg.geometry.coordinates)
    || leg.geometry.coordinates.length < 2 || leg.geometry.coordinates.length > 10000
    || !leg.geometry.coordinates.every(point) || !bounded(leg.distanceMeters, 0, 1000000)
    || !bounded(leg.durationSeconds, 0, 2592000)
    || Buffer.byteLength(JSON.stringify(leg)) > MAX_BYTES) fail('INVALID_PROVIDER_RESPONSE', 502);
  return { profile: leg.profile, geometry: { type: 'LineString', coordinates: leg.geometry.coordinates },
    distanceMeters: leg.distanceMeters, durationSeconds: leg.durationSeconds };
}
function providerLeg(data, profile) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length !== 1
    || data.features[0]?.type !== 'Feature') fail('INVALID_PROVIDER_RESPONSE', 502);
  const feature = data.features[0];
  return validateLeg({ profile, geometry: feature.geometry && {
    type: feature.geometry.type, coordinates: feature.geometry.coordinates,
  }, distanceMeters: feature.properties?.summary?.distance, durationSeconds: feature.properties?.summary?.duration });
}
function retrySeconds(value, now) {
  // Forward only a bounded integer; never relay upstream text or headers.
  let seconds = 60;
  if (typeof value === 'string' && value.length <= 64) {
    if (/^\d{1,10}$/.test(value)) seconds = Number(value);
    else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) seconds = Math.ceil((parsed - now) / 1000);
    }
  }
  return Math.max(60, Math.min(86400, seconds));
}
async function readProvider(response, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) fail('INVALID_PROVIDER_RESPONSE', 502);
  if (!response.body?.getReader) fail('INVALID_PROVIDER_RESPONSE', 502);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) fail('INVALID_PROVIDER_RESPONSE', 502);
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('INVALID_PROVIDER_RESPONSE', 502); }
  } finally {
    // Cancellation is best effort and must not replace the stable error.
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
function createPlanner({ store, fetchImpl = (...args) => fetch(...args), getKey = () => process.env.ORS_API_KEY,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const inFlight = new Map();
  async function execute(owner, input, key, credential) {
    try {
      const cached = await store.lookup(owner, key);
      if (cached !== null) {
        const leg = validateLeg(JSON.parse(cached));
        if (leg.profile !== input.profile) fail();
        return { leg, status: { cache: 'hit' } };
      }
      await store.reserve(owner);
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimer(() => {
          controller.abort();
          reject(new PlanningError('PROVIDER_TIMEOUT', 504));
        }, TIMEOUT_MS);
      });
      let leg;
      try {
        leg = await Promise.race([deadline, (async () => {
          const response = await fetchImpl(`https://api.heigit.org/openrouteservice/v2/directions/${input.profile}/geojson`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { Authorization: credential, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
            body: JSON.stringify({ coordinates: input.points, instructions: false, elevation: false }),
          });
          if (controller.signal.aborted) fail('PROVIDER_TIMEOUT', 504);
          if (response.status === 429) {
            const seconds = retrySeconds(response.headers.get('retry-after'), await store.now());
            await store.cooldown(owner, seconds);
            fail('PROVIDER_RATE_LIMITED', 429);
          }
          if (response.status === 401 || response.status === 403) fail('PLANNING_UNAVAILABLE');
          if (response.status !== 200) fail('PROVIDER_UNAVAILABLE', 502);
          return providerLeg(await readProvider(response, controller.signal), input.profile);
        })()]);
      } finally {
        clearTimer(timer);
        controller.abort();
      }
      await store.save(owner, key, JSON.stringify(leg));
      return { leg, status: { cache: 'miss' } };
    } catch (err) {
      if (err instanceof PlanningError) {
        if (err.code === 'PROVIDER_RATE_LIMITED') {
          // Read persisted cooldown: all instances use the same backoff.
          const retryAfter = await store.remainingCooldown(owner).catch(() => 60);
          throw new PlanningError(err.code, 429, retryAfter);
        }
        throw err;
      }
      throw new PlanningError('PLANNING_UNAVAILABLE');
    }
  }
  return async (owner, body) => {
    if (typeof owner !== 'string' || !owner.length) fail('UNAUTHORIZED', 401);
    const input = validateInput(body);
    const credential = getKey();
    if (typeof credential !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,512}$/.test(credential)) fail();
    const key = cacheKey(owner, input);
    if (!inFlight.has(key)) {
      const work = execute(owner, input, key, credential).finally(() => inFlight.delete(key));
      inFlight.set(key, work);
    }
    return inFlight.get(key);
  };
}
module.exports = { createPlanner, PlanningError, validateInput, validateLeg, cacheKey, retrySeconds, MAX_BYTES, TTL_MS, TIMEOUT_MS };
