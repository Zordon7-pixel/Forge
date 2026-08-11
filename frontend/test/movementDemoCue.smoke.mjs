import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const movementDemo = read('src/components/MovementDemo.jsx')
const stretches = read('src/pages/Stretches.jsx')
const stretchSession = read('src/pages/StretchSession.jsx')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(movementDemo.includes("cue = ''"), 'MovementDemo accepts an optional authoritative cue')
check(movementDemo.includes('const displayCue = cue || (photoSrc') && movementDemo.includes('{displayCue}</p>'), 'catalog cue takes precedence over the visual-aware fallback text')
check(/<MovementDemo[^>]+cue=\{stretch\.cue\}/.test(stretches), 'inline stretch flow passes the catalog cue')
check(/<MovementDemo[^>]+cue=\{currentStretch\.cue\}/.test(stretchSession), 'pre-run stretch flow passes the catalog cue')

console.log(`MOVEMENT DEMO CUE SMOKE OK (${passed})`)
