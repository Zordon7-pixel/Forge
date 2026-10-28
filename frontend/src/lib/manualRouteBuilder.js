// Planned-course state only. This module has no recording or activity dependencies.
export const METERS_PER_MILE = 1609.344
export const PROFILES = ['foot-walking', 'foot-hiking']
export const MODE_LABELS = { routed: 'Planned ORS route', straight: 'Planned straight line' }
const bounded = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
const invalid = () => { throw new Error('Saved route data is invalid or unsupported.') }
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k))
export const validPoint = (p, elevation = true) => Array.isArray(p) && (p.length === 2 || (elevation && p.length === 3))
  && bounded(p[0], -180, 180) && bounded(p[1], -90, 90)
  && (p.length === 2 || p[2] === null || bounded(p[2], -2000, 100000))
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1]
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
  && !/[^\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(v)
export const validRouteId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
export function geometricMeters(a, b) {
  const rad = Math.PI / 180
  const h = Math.sin((b[1] - a[1]) * rad / 2) ** 2
    + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)))
}
export function elevationStats(points) {
  const known = points.filter(p => Number.isFinite(p[2])).length
  let gain = 0, loss = 0, pairs = 0
  for (let i = 1; i < points.length; i++) {
    if (!Number.isFinite(points[i - 1][2]) || !Number.isFinite(points[i][2])) continue
    const delta = points[i][2] - points[i - 1][2]
    gain += Math.max(0, delta); loss += Math.max(0, -delta); pairs++
  }
  return { coverage: !known ? 'missing' : known === points.length ? 'complete' : 'partial',
    gainMeters: pairs ? gain : null, lossMeters: pairs ? loss : null }
}
// Locate target/2 along actual geometry. Never extend beyond the planned path.
export function turnaroundPoint(points, targetMeters) {
  if (!bounded(targetMeters, Number.MIN_VALUE, 1000000)) return null
  let remaining = targetMeters / 2
  for (let i = 1; i < points.length; i++) {
    const length = geometricMeters(points[i - 1], points[i])
    if (length > 0 && remaining <= length) {
      const t = remaining / length, a = points[i - 1], b = points[i]
      if (t === 1) return b.slice(0, 2)
      const longitudeDelta = ((b[0] - a[0] + 540) % 360) - 180
      return [((a[0] + longitudeDelta * t + 540) % 360) - 180, a[1] + (b[1] - a[1]) * t]
    }
    remaining -= length
  }
  return null
}
export function validateSavedRoute(raw) {
  if (!keys(raw, ['id', 'kind', 'schemaVersion', 'provenanceTrust', 'createdAt', 'updatedAt',
    'name', 'waypoints', 'geometry', 'legs', 'distanceMeters', 'targetDistanceMeters', 'elevation', 'display'])
    || !validRouteId(raw.id) || raw.kind !== 'planned' || raw.schemaVersion !== 1
    || raw.provenanceTrust !== 'client_declared' || !text(raw.name, 120)
    || JSON.stringify(raw).length > 1048576
    || !Array.isArray(raw.waypoints) || raw.waypoints.length < 2 || raw.waypoints.length > 100
    || !raw.waypoints.every(p => validPoint(p, false))
    || !keys(raw.geometry, ['type', 'coordinates']) || raw.geometry.type !== 'LineString'
    || !Array.isArray(raw.geometry.coordinates) || raw.geometry.coordinates.length < 2
    || raw.geometry.coordinates.length > 10000 || !raw.geometry.coordinates.every(p => validPoint(p))
    || !Array.isArray(raw.legs) || raw.legs.length !== raw.waypoints.length - 1
    || !bounded(raw.distanceMeters, 0, 1000000)
    || !(raw.targetDistanceMeters === null || bounded(raw.targetDistanceMeters, 0, 1000000))) invalid()
  let end = 0
  for (const leg of raw.legs) {
    if (!keys(leg, ['mode', 'provenance', 'profile', 'startIndex', 'endIndex', 'distanceMeters', 'distanceSource'])
      || leg.startIndex !== end || !Number.isInteger(leg.endIndex) || leg.endIndex <= end
      || leg.endIndex >= raw.geometry.coordinates.length
      || !(leg.mode === 'routed' && leg.provenance === 'ors' && PROFILES.includes(leg.profile)
        || leg.mode === 'straight' && leg.provenance === 'manual' && leg.profile === null && leg.endIndex === end + 1)) invalid()
    const hasDistance = Object.hasOwn(leg, 'distanceMeters')
    if (hasDistance !== Object.hasOwn(leg, 'distanceSource')
      || (hasDistance && (!bounded(leg.distanceMeters, 0, 1000000)
        || !(leg.distanceSource === 'saved_total_remainder'
          || leg.mode === 'routed' && leg.distanceSource === 'ors'
          || leg.mode === 'straight' && leg.distanceSource === 'geometry')))) invalid()
    end = leg.endIndex
  }
  if (end !== raw.geometry.coordinates.length - 1) invalid()
  if (raw.legs.every(leg => Object.hasOwn(leg, 'distanceMeters'))
    && Math.abs(raw.legs.reduce((sum, leg) => sum + leg.distanceMeters, 0) - raw.distanceMeters) > 0.000001) invalid()
  const e = raw.elevation, d = raw.display, computed = elevationStats(raw.geometry.coordinates)
  if (!keys(e, ['source', 'gainMeters', 'lossMeters', 'coverage'])
    || ![null, 'manual', 'imported', 'provider'].includes(e.source) || e.coverage !== computed.coverage
    || ![e.gainMeters, e.lossMeters].every(v => v === null || bounded(v, 0, 1000000))
    || ((computed.coverage !== 'missing' || e.gainMeters !== null || e.lossMeters !== null) && !e.source)
    || !keys(d, ['description', 'surface', 'elevationPreference'])
    || !(d.description === null || text(d.description, 500))
    || ![null, 'road', 'trail', 'mixed'].includes(d.surface)
    || ![null, 'flat', 'balanced', 'hilly'].includes(d.elevationPreference)) invalid()
  return structuredClone(raw)
}
export function routePayload(state, name, targetDistanceMeters) {
  const elevation = elevationStats(state.coordinates)
  const payload = { name: name.trim(), waypoints: state.waypoints,
    geometry: { type: 'LineString', coordinates: state.coordinates }, legs: state.legs,
    distanceMeters: state.distanceMeters, targetDistanceMeters,
    elevation: { ...elevation, source: elevation.coverage === 'missing' ? null : state.elevationSource },
    display: state.display }
  // Use the same fail-closed shape for writes as reads; no generated fields escape.
  validateSavedRoute({ ...payload, id: '00000000-0000-0000-0000-000000000000', kind: 'planned', schemaVersion: 1, provenanceTrust: 'client_declared' })
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 1048576) invalid()
  return payload
}
export function validateLegResponse(raw, profile) {
  if (!raw || raw.profile !== profile || !PROFILES.includes(profile)
    || raw.geometry?.type !== 'LineString' || !Array.isArray(raw.geometry.coordinates)
    || raw.geometry.coordinates.length < 2 || raw.geometry.coordinates.length > 10000
    || !raw.geometry.coordinates.every(p => validPoint(p)) || !bounded(raw.distanceMeters, 0, 1000000)) {
    throw new Error('Routing returned invalid geometry. Existing legs were kept.')
  }
  return structuredClone(raw)
}
export function legKey(profile, points) {
  if (!PROFILES.includes(profile) || points.length !== 2 || !points.every(p => validPoint(p, false))) invalid()
  return JSON.stringify([profile, points.map(p => p.map(n => Number(n.toFixed(5)) || 0))])
}
// One instance per authenticated editor; never shared across accounts or persisted.
export function createLegClient(request, { now = Date.now, maxEntries = 64, ttl = 600000 } = {}) {
  const cache = new Map(), flight = new Map()
  let disposed = false
  return {
    get(profile, points) {
      if (disposed) return Promise.reject(new Error('Route editor closed.'))
      const key = legKey(profile, points), cached = cache.get(key)
      if (cached && now() - cached.at < ttl) return Promise.resolve(structuredClone(cached.leg))
      if (flight.has(key)) return flight.get(key)
      const normalized = JSON.parse(key)[1]
      const promise = Promise.resolve().then(() => request({ profile, points: normalized }))
        .then(raw => {
          const leg = validateLegResponse(raw, profile)
          if (!disposed) {
            cache.delete(key); cache.set(key, { at: now(), leg })
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
          }
          return structuredClone(leg)
        }).finally(() => flight.delete(key))
      flight.set(key, promise)
      return promise
    },
    dispose() { disposed = true; cache.clear(); flight.clear() },
  }
}
export function routeError(error) {
  const status = error?.response?.status
  const seconds = Number(error?.response?.headers?.['retry-after'])
  const retryAfter = status === 429 ? Math.max(1, Math.min(86400, Number.isFinite(seconds) ? seconds : 60)) : 0
  const code = error?.response?.data?.error
  const message = status === 429 ? 'Routing limit reached. Existing legs were kept.'
    : code === 'PROVIDER_TIMEOUT' || error?.code === 'ECONNABORTED' ? 'Routing timed out. Existing legs were kept.'
      : 'Could not route this leg. Existing legs were kept. Retry or choose planned straight line explicitly.'
  return { message, retryAfter }
}
const empty = () => ({ waypoints: [], coordinates: [], legs: [], distanceMeters: 0,
  elevationSource: null, display: { description: null, surface: null, elevationPreference: null }, legacyDistances: false })
export function createRouteEditor({ client, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let state = { ...empty(), mode: 'routed', profile: 'foot-walking', pending: null, error: null, revision: 0 }
  let history = [], timer, generation = 0, disposed = false
  const emit = () => { if (!disposed) onChange({ ...state, canUndo: history.length > 0 || state.waypoints.length > 0 || !!state.pending }) }
  const invalidate = () => { generation++; clearTimer(timer); state = { ...state, pending: null, error: null, revision: state.revision + 1 } }
  const remember = () => { history.push(state); if (history.length > 100) history.shift() }
  const reject = message => { state = { ...state, pending: null, error: { message, retryAt: 0 } }; emit() }
  function append(point, leg, mode, profile) {
    const previous = state.coordinates.at(-1), coords = leg.geometry.coordinates
    if (state.legs.length && !samePoint(previous, coords[0])) {
      throw new Error('The routed leg does not join the existing geometry. Undo the last leg or choose a different waypoint.')
    }
    const startIndex = state.legs.length ? state.coordinates.length - 1 : 0
    const coordinates = state.legs.length ? [...state.coordinates, ...coords.slice(1)] : coords
    if (coordinates.length > 10000 || state.waypoints.length >= 100 || (state.distanceMeters ?? 0) + leg.distanceMeters > 1000000) {
      throw new Error('Route limit reached: 100 waypoints, 10,000 points or 1,000 km.')
    }
    remember()
    state = { ...state, coordinates, waypoints: [...state.waypoints, point],
      legs: [...state.legs, { mode, provenance: mode === 'straight' ? 'manual' : 'ors', profile: mode === 'straight' ? null : profile,
        startIndex, endIndex: coordinates.length - 1, distanceMeters: leg.distanceMeters,
        distanceSource: mode === 'straight' ? 'geometry' : 'ors' }],
      distanceMeters: state.distanceMeters === null ? null : state.distanceMeters + leg.distanceMeters,
      elevationSource: state.elevationSource || (elevationStats(coords).coverage !== 'missing' ? 'provider' : null), pending: null, error: null }
  }
  const api = {
    snapshot: () => ({ ...state, canUndo: history.length > 0 || state.waypoints.length > 0 || !!state.pending }),
    version: () => generation,
    setStart(point) {
      if (!validPoint(point, false) || state.waypoints.length) return
      invalidate(); remember(); state = { ...state, waypoints: [point], coordinates: [point] }; emit()
    },
    add(point) {
      if (!validPoint(point, false) || !state.waypoints.length || disposed) return
      invalidate()
      const token = generation, mode = state.mode, profile = state.profile
      const start = state.coordinates.at(-1).slice(0, 2)
      if (samePoint(start, point)) { emit(); return }
      state = { ...state, pending: point }; emit()
      if (mode === 'straight') {
        try { append(point, { geometry: { coordinates: [start, point] }, distanceMeters: geometricMeters(start, point) }, mode, profile); emit() }
        catch (error) { reject(error.message) }
        return
      }
      timer = setTimer(async () => {
        try {
          const leg = await client.get(profile, [start, point])
          if (disposed || token !== generation) return
          append(point, leg, mode, profile); emit()
        } catch (error) {
          if (disposed || token !== generation) return
          const problem = error?.response || error?.code ? routeError(error)
            : { message: error.message || 'Routing failed. Existing legs were kept.', retryAfter: 0 }
          state = { ...state, error: { message: problem.message, retryAt: now() + problem.retryAfter * 1000 } }; emit()
        }
      }, 300)
    },
    retry() { if (state.pending && state.error && now() >= state.error.retryAt) api.add(state.pending) },
    setMode(mode) { if (!Object.hasOwn(MODE_LABELS, mode)) return; invalidate(); state = { ...state, mode }; emit() },
    setProfile(profile) { if (!PROFILES.includes(profile)) return; invalidate(); state = { ...state, profile }; emit() },
    undo() {
      const pending = !!state.pending
      invalidate()
      if (!pending && history.length) {
        const previous = history.pop()
        state = { ...previous, mode: state.mode, profile: state.profile, pending: null, error: null, revision: state.revision }
      } else if (!pending && state.waypoints.length) {
        const removed = state.legs.at(-1), legs = state.legs.slice(0, -1)
        // Unknown legacy routed distances cannot be estimated from geometry.
        const distanceMeters = legs.every(leg => Number.isFinite(leg.distanceMeters))
          ? legs.reduce((sum, leg) => sum + leg.distanceMeters, 0)
          : Number.isFinite(state.distanceMeters) && Number.isFinite(removed?.distanceMeters)
            ? Math.max(0, state.distanceMeters - removed.distanceMeters) : null
        state = { ...state, legs, waypoints: state.waypoints.slice(0, -1),
          coordinates: removed ? state.coordinates.slice(0, removed.startIndex + 1) : [], distanceMeters }
      }
      emit()
    },
    clear() { invalidate(); history = []; state = { ...state, ...empty() }; emit() },
    closeLoop() { if (state.legs.length) api.add(state.coordinates[0].slice(0, 2)) },
    outAndBack() {
      invalidate()
      if (!state.legs.length) { emit(); return }
      const count = state.coordinates.length
      if (count * 2 - 1 > 10000 || state.waypoints.length * 2 - 1 > 100 || state.distanceMeters * 2 > 1000000) {
        reject('Out-and-back would exceed the saved route limits.'); return
      }
      remember()
      const reversed = [...state.legs].reverse().map(leg => ({ ...leg,
        startIndex: 2 * (count - 1) - leg.endIndex, endIndex: 2 * (count - 1) - leg.startIndex }))
      state = { ...state, coordinates: [...state.coordinates, ...state.coordinates.slice(0, -1).reverse()],
        waypoints: [...state.waypoints, ...state.waypoints.slice(0, -1).reverse()],
        legs: [...state.legs, ...reversed], distanceMeters: state.distanceMeters === null ? null : state.distanceMeters * 2 }
      emit()
    },
    load(raw) {
      const route = validateSavedRoute(raw)
      invalidate(); history = []
      const legs = route.legs.map(leg => {
        if (Number.isFinite(leg.distanceMeters) || leg.mode !== 'straight') return leg
        return { ...leg, distanceMeters: geometricMeters(route.geometry.coordinates[leg.startIndex], route.geometry.coordinates[leg.endIndex]), distanceSource: 'geometry' }
      })
      const unknown = legs.filter(leg => !Number.isFinite(leg.distanceMeters))
      const knownTotal = legs.reduce((sum, leg) => sum + (leg.distanceMeters ?? 0), 0)
      // Exactly one missing leg is algebraically recoverable, never a reroute or ORS estimate.
      if (unknown.length === 1 && route.distanceMeters >= knownTotal) {
        unknown[0].distanceMeters = route.distanceMeters - knownTotal
        unknown[0].distanceSource = 'saved_total_remainder'
      }
      // An inconsistent legacy aggregate cannot certify a breakdown. Keep its
      // exact saved total, but make totals unknown after an unknowable removal.
      if (knownTotal > route.distanceMeters + 0.000001 || !unknown.length && Math.abs(knownTotal - route.distanceMeters) > 0.000001) {
        for (const leg of legs) { delete leg.distanceMeters; delete leg.distanceSource }
      }
      state = { ...state, waypoints: route.waypoints, coordinates: route.geometry.coordinates, legs,
        distanceMeters: route.distanceMeters, elevationSource: route.elevation.source, display: route.display, legacyDistances: legs.some(leg => !Number.isFinite(leg.distanceMeters)) }
      emit(); return route
    },
    dispose() { invalidate(); disposed = true; client.dispose() },
  }
  return api
}
