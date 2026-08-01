import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { postRunStretches, preRunStretches } from '../src/data/stretches.js'
import { stretchSideCount, stretchSideLabel, stretchTimerSeconds } from '../src/lib/stretchTimer.js'

const hamstring = postRunStretches.find((stretch) => stretch.id === 'hamstring-stretch')
assert.equal(stretchTimerSeconds(hamstring), 30, 'the on-screen hold stays 30 seconds per side')
assert.equal(stretchSideCount(hamstring), 2, 'a static each-side hold runs two timed sides')
assert.equal(stretchSideLabel(hamstring, 0), 'Left side')
assert.equal(stretchSideLabel(hamstring, 1), 'Right side')

const legSwings = preRunStretches.find((stretch) => stretch.id === 'leg-swings')
assert.equal(stretchSideCount(legSwings), 1, 'dynamic alternating reps are not incorrectly doubled')
assert.equal(stretchTimerSeconds(legSwings), 30)

const source = readFileSync(new URL('../src/pages/StretchSession.jsx', import.meta.url), 'utf8')
assert.match(source, /currentSideCount === 2 && sideIndex === 0/, 'the first side transitions to a second timed hold')
assert.match(source, /Switch sides/, 'the handoff tells the athlete to switch sides')
assert.match(source, /current > 0 \? 'Previous' : 'Back'/, 'Back moves to the previous movement after exercise one')
assert.match(source, /setCurrent\(value => value - 1\)/, 'previous movement navigation does not exit the session')

console.log('STRETCH SESSION TIMER SMOKE OK (12)')
