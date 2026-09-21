import assert from 'node:assert/strict'
import { normalizePlannerRoute, normalizePlannerPlaces, plannerErrorMessage } from '../src/lib/routePlannerData.js'
const route = { distanceMiles: '4.1', coordinates: [[40, -73], ['40.1', '-73.1']], elevationPreference: 'flat', elevationProfile: [{ distanceMiles: '0', elevationFeet: '14' }], elevationGainFeet: null }
const normalized = normalizePlannerRoute(route)
assert.equal(normalized.distanceMiles.toFixed(1), '4.1')
assert.equal(normalized.elevationGainFeet, null)
assert.deepEqual(normalized.coordinates[1], [40.1, -73.1])
assert.equal(route.distanceMiles, '4.1', 'normalization must not mutate its input')
for (const bad of [null, {}, { ...route, distanceMiles: '' }, { ...route, distanceMiles: -1 }, { ...route, coordinates: [[null, 0], [0, 1]] }, { ...route, coordinates: [[91, 0], [0, 1]] }, { ...route, elevationProfile: 'broken' }, { ...route, notice: {} }, { ...route, elevationPreference: {} }]) {
  assert.throws(() => normalizePlannerRoute(bad), /invalid route/)
}
assert.deepEqual(normalizePlannerPlaces([{ label: 'Synthetic park', latitude: '40', longitude: '-73' }]), [{label: 'Synthetic park', latitude: 40, longitude: -73}])
for (const bad of [null, {}, [null], [{ latitude: 40, longitude: -73, label: {} }]]) assert.throws(() => normalizePlannerPlaces(bad), /search again/)
assert.equal(plannerErrorMessage({ response: { data: { error: { broken: true } } } }, 'Retry'), 'Retry')
assert.equal(plannerErrorMessage(null, 'Retry'), 'Retry')
console.log('Route planner data regression passed.')
