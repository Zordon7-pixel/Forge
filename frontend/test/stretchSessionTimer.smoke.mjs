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

const sessionSource = readFileSync(new URL('../src/pages/StretchSession.jsx', import.meta.url), 'utf8')
const librarySource = readFileSync(new URL('../src/pages/Stretches.jsx', import.meta.url), 'utf8')
const timerSource = readFileSync(new URL('../src/components/GuidedMovementTimer.jsx', import.meta.url), 'utf8')
assert.match(sessionSource, /import GuidedMovementTimer/, 'the runner and lift flow imports the shared guided timer')
assert.match(librarySource, /import GuidedMovementTimer/, 'the stretch library flow imports the shared guided timer')
assert.doesNotMatch(sessionSource, /setInterval|setTimeout/, 'the runner and lift flow has no page-local countdown')
assert.doesNotMatch(librarySource, /setInterval|setTimeout/, 'the stretch library flow has no page-local countdown')
assert.match(timerSource, /visibilityState === 'hidden'/, 'the shared timer pauses when the app becomes hidden')
assert.match(timerSource, /aria-live="polite"/, 'timer state changes use a polite live region')

console.log('STRETCH SESSION TIMER SMOKE OK')
