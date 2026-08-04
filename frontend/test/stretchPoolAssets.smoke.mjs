import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { postRunStretches, preRunStretches } from '../src/data/stretches.js'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pools = [
  ['pre-run', preRunStretches, 16],
  ['post-run', postRunStretches, 20],
]

for (const [label, pool, minimum] of pools) {
  assert(pool.length >= minimum, `${label} must contain at least ${minimum} movements`)
  assert.equal(new Set(pool.map((movement) => movement.id)).size, pool.length, `${label} IDs must be unique`)

  for (const movement of pool) {
    assert.match(movement.id, /^[a-z0-9-]{1,64}$/, `${movement.name} needs a stable ID`)
    assert(['dynamic', 'static', 'mobility'].includes(movement.type), `${movement.name} needs a valid type`)
    assert(Number.isFinite(movement.duration) && movement.duration >= 20 && movement.duration <= 60, `${movement.name} duration is out of bounds`)
    assert(typeof movement.muscle === 'string' && movement.muscle.trim(), `${movement.name} needs a body area`)
    assert(typeof movement.cue === 'string' && movement.cue.trim(), `${movement.name} needs a cue`)
    assert(['bilateral', 'alternating', 'each-side'].includes(movement.sideMode), `${movement.name} needs explicit side semantics`)
    assert.equal(movement.sides, movement.sideMode === 'each-side' ? 2 : 1, `${movement.name} side count does not match its side mode`)
    if (movement.type === 'static' && /each side/i.test(movement.durationLabel)) {
      assert.equal(movement.sideMode, 'each-side', `${movement.name} must time both sides`)
    }

    assert.match(movement.image_url, /^\/stretches\/[a-z0-9-]+\.(png|webp)$/i, `${movement.name} must use a local stretch asset`)
    const publicPath = path.join(frontendRoot, 'public', movement.image_url)
    assert(fs.existsSync(publicPath), `${movement.name} is missing ${publicPath}`)
  }
}

assert(preRunStretches.every((movement) => movement.type === 'dynamic'), 'pre-run must remain dynamic only')
assert.equal(
  new Set([...preRunStretches, ...postRunStretches].map((movement) => movement.id)).size,
  preRunStretches.length + postRunStretches.length,
  'runner catalog IDs must be globally unique',
)

console.log(`STRETCH POOL ASSETS OK (${preRunStretches.length} warm-up, ${postRunStretches.length} recovery)`)
