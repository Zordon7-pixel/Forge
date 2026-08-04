import assert from 'node:assert/strict'
import {
  chooseRotatingRoutine,
  getPreviousRoutineIds,
  getRoutineHistory,
  rememberRoutine,
  selectRotatingRoutine,
} from '../src/lib/routineRotation.js'

const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}

const ids = (routine) => routine.map((item) => item.id)
const pool = Array.from({ length: 16 }, (_, index) => ({ id: `move-${index + 1}` }))
const seededRandom = () => 0.25

const first = chooseRotatingRoutine('three-session-test', pool, 5, seededRandom)
rememberRoutine('three-session-test', first)
const second = chooseRotatingRoutine('three-session-test', pool, 5, seededRandom)
rememberRoutine('three-session-test', second)
const third = chooseRotatingRoutine('three-session-test', pool, 5, seededRandom)
rememberRoutine('three-session-test', third)

assert.equal(new Set([...ids(first), ...ids(second), ...ids(third)]).size, 15, 'three routines must maximize unseen movements')
assert.notDeepEqual(ids(second), ids(first), 'consecutive routines must differ')
assert.notDeepEqual(ids(third), ids(second), 'three seeded routines must not repeat')
assert.equal(getRoutineHistory('three-session-test').length, 3, 'three prior routines must be retained')
assert.equal(getPreviousRoutineIds('three-session-test').length, 15, 'flattened exclusions must include bounded multi-session history')

values.set('forge_recent_routine:anonymous:legacy-test', JSON.stringify(['move-1', 'move-2', 'move-2']))
assert.deepEqual(getRoutineHistory('legacy-test'), [['move-1', 'move-2']], 'legacy flat history must migrate in memory')
assert.deepEqual(getPreviousRoutineIds('legacy-test'), ['move-1', 'move-2'], 'legacy exclusions remain readable')

values.set('forge_recent_routine:anonymous:malformed-json', '{bad')
assert.deepEqual(getRoutineHistory('malformed-json'), [], 'malformed JSON must be ignored safely')
values.set('forge_recent_routine:anonymous:malformed-shape', JSON.stringify([[null, {}, 'move-1', 'move-1'], 'bad', Array(80).fill('move-2')]))
const boundedHistory = getRoutineHistory('malformed-shape')
assert(boundedHistory.length <= 3, 'history routine count must stay bounded')
assert(boundedHistory.every((routine) => routine.length <= 12), 'each stored routine must stay bounded')
assert.deepEqual(boundedHistory[0], ['move-1'], 'malformed IDs must be removed and duplicates collapsed')

const previousOrdered = pool.slice(0, 5).map((item) => item.id)
const rotated = selectRotatingRoutine(pool, 5, [previousOrdered], seededRandom)
assert(rotated.every((item) => !previousOrdered.includes(item.id)), 'the immediately previous routine must be avoided when the pool permits')

const fullPoolPrevious = pool.slice(0, 5)
assert.notDeepEqual(
  ids(selectRotatingRoutine(fullPoolPrevious, 5, [ids(fullPoolPrevious)], () => 0.999999)),
  ids(fullPoolPrevious),
  'an exact ordered repeat must be changed when an alternative ordering exists',
)

const duplicatePool = [{ id: 'one' }, { id: 'one' }, { id: 'two' }, null, { id: '' }]
assert.deepEqual(ids(selectRotatingRoutine(duplicatePool, 12, [], () => 0)).sort(), ['one', 'two'], 'malformed catalog IDs must be deduplicated')
assert.equal(selectRotatingRoutine(pool, 0, []).length, 0, 'zero count must return an empty routine')
assert.equal(selectRotatingRoutine(pool, -2, []).length, 0, 'negative count must return an empty routine')
assert.equal(selectRotatingRoutine(pool, { unsafe: true }, []).length, 0, 'object counts must not be coerced')
assert.equal(selectRotatingRoutine(pool, 5000, []).length, pool.length, 'oversized count must clamp to the pool')

console.log('ROUTINE ROTATION SMOKE OK')
