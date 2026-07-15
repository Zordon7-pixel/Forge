import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  getLiftMobilityPool,
  inferLiftFocus,
  liftRecoveryMovements,
  liftWarmupMovements,
} from '../src/data/liftMobility.js'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

assert.equal(inferLiftFocus({ target: 'Lower body', main: [{ name: 'Back Squat' }] }), 'legs')
assert.equal(inferLiftFocus({ target: 'Chest', main: [{ name: 'Dumbbell Bench Press' }] }), 'chest')
assert.equal(inferLiftFocus({ target: 'Back', main: [{ name: 'Barbell Row' }] }), 'back')
assert.equal(inferLiftFocus({ target: 'Back', main: [{ name: 'Single-Arm Dumbbell Row' }] }), 'back')
assert.equal(inferLiftFocus({ workoutName: 'Full Body Strength' }), 'full')
assert.equal(inferLiftFocus({}), 'full')

for (const [phase, catalog] of [['warmup', liftWarmupMovements], ['recovery', liftRecoveryMovements]]) {
  const ids = catalog.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length, `${phase} catalog has duplicate ids`)

  for (const item of catalog) {
    assert.ok(item.image_url.startsWith('/stretches/'), `${item.id} has a non-local image`)
    await access(path.join(frontendRoot, 'public', item.image_url))
  }

  for (const focus of ['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'full']) {
    const pool = getLiftMobilityPool({ target: focus }, phase)
    assert.ok(pool.length >= 6, `${phase}/${focus} has fewer than six movements`)
    assert.equal(new Set(pool.map((item) => item.id)).size, pool.length, `${phase}/${focus} has duplicates`)
    assert.ok(pool.every((item) => item.focuses.includes(focus) || item.focuses.includes('full')), `${phase}/${focus} includes an unrelated movement`)
  }
}

console.log('Lift mobility smoke OK: focus inference, image coverage, and six-movement pools verified')
