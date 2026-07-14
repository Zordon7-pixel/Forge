import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { postRunStretches, preRunStretches } from '../src/data/stretches.js'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const movementDemoSource = fs.readFileSync(path.join(frontendRoot, 'src/components/MovementDemo.jsx'), 'utf8')

const mappedAssets = {
  'leg-swings': ['leg-swings-male.png', 'leg-swings-female.png'],
  'hip-circles': ['hip-circles.png'],
  'high-knees': ['high-knees.png'],
  'butt-kicks': ['butt-kicks.png'],
  'ankle-rolls': ['ankle-rolls.png'],
  'walking-lunges': ['walking-lunges.png'],
  'arm-swings': ['arm-swings.png'],
  'standing-quad': ['standing-quad.png'],
  'hamstring-stretch': ['hamstring-stretch.png'],
  'calf-stretch': ['calf-stretch.png'],
  'hip-flexor': ['hip-flexor-male.png', 'hip-flexor-female.png'],
  'figure-four': ['figure-four.png'],
  'childs-pose': ['childs-pose.png'],
}

const allMovements = [...preRunStretches, ...postRunStretches]
assert.equal(preRunStretches.length, 10)
assert.equal(postRunStretches.length, 12)
assert.equal(new Set(allMovements.map((movement) => movement.id)).size, allMovements.length)

for (const movement of allMovements) {
  const assets = movement.image_url
    ? [movement.image_url.replace('/stretches/', '')]
    : mappedAssets[movement.id]
  assert(assets?.length, `${movement.name} has no local form-image mapping`)
  for (const asset of assets) {
    const publicPath = path.join(frontendRoot, 'public/stretches', asset)
    assert(fs.existsSync(publicPath), `${movement.name} is missing ${publicPath}`)
    if (!movement.image_url) {
      assert(movementDemoSource.includes(`/stretches/${asset}`), `${movement.name} is not wired in MovementDemo`)
    }
  }
}

console.log(`STRETCH POOL ASSETS OK (${preRunStretches.length} warm-up, ${postRunStretches.length} recovery)`)
