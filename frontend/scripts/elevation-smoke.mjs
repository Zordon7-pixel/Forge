#!/usr/bin/env node
import assert from 'node:assert/strict'
import { calculateElevationStats } from '../src/utils/elevation.js'

const noAltitude = calculateElevationStats([
  [39.1, -76.1, null],
  [39.2, -76.2, null],
])
assert.equal(noAltitude.available, false, 'missing altitude must not produce fake elevation')

const hill = calculateElevationStats([
  [39.10, -76.10, 100],
  [39.11, -76.11, 100],
  [39.12, -76.12, 103],
  [39.13, -76.13, 108],
  [39.14, -76.14, 115],
  [39.15, -76.15, 115],
  [39.16, -76.16, 110],
  [39.17, -76.17, 105],
  [39.18, -76.18, 98],
  [39.19, -76.19, 92],
])
assert.equal(hill.available, true, 'valid altitude samples should be available')
assert(hill.gainFeet > 0, 'climbing should produce elevation gain')
assert(hill.lossFeet > 0, 'descending should produce elevation loss')

console.log('elevation smoke OK')
