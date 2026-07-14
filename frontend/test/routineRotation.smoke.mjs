import assert from 'node:assert/strict'
import { selectRotatingRoutine } from '../src/lib/routineRotation.js'

const pool = Array.from({ length: 10 }, (_, index) => ({ id: `move-${index + 1}` }))
const previous = pool.slice(0, 5).map((item) => item.id)

const rotated = selectRotatingRoutine(pool, 5, previous, () => 0.25)
assert.equal(rotated.length, 5)
assert(rotated.every((item) => !previous.includes(item.id)), 'a full unseen set should replace the prior routine')

const partial = selectRotatingRoutine(pool, 7, previous, () => 0.25)
assert(partial.slice(0, 5).every((item) => !previous.includes(item.id)), 'unseen movements must be selected first')
assert.equal(new Set(partial.map((item) => item.id)).size, 7, 'routine must not contain duplicates')
assert.equal(selectRotatingRoutine(pool, 0, previous).length, 0, 'zero count must return an empty routine')
assert.equal(selectRotatingRoutine(pool, -2, previous).length, 0, 'negative count must return an empty routine')
assert.equal(selectRotatingRoutine(pool, 50, previous).length, pool.length, 'oversized count must clamp to the pool')

const duplicatePool = [{ id: 'one' }, { id: 'one' }, { id: 'two' }]
assert.deepEqual(
  selectRotatingRoutine(duplicatePool, 3, [], () => 0).map((item) => item.id).sort(),
  ['one', 'two'],
)

console.log('ROUTINE ROTATION SMOKE OK')
