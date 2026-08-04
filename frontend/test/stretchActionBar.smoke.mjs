import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const layout = read('src/components/Layout.jsx')
const timer = read('src/components/GuidedMovementTimer.jsx')
const stretches = read('src/pages/Stretches.jsx')
const stretchSession = read('src/pages/StretchSession.jsx')
const css = read('src/index.css')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(css.includes('--app-bottom-nav-height: calc(var(--app-bottom-nav-base-height) + var(--safe-bottom))'), 'shared CSS defines one safe-area-aware bottom-nav height')
check(layout.includes("height: 'var(--app-bottom-nav-height)'"), 'bottom navigation consumes the shared height')
check(timer.includes("bottom: 'var(--app-bottom-nav-height, calc(59px + env(safe-area-inset-bottom, 0px)))'"), 'timer action bar sits above the safe-area-aware bottom navigation')
check(timer.includes('zIndex: 25'), 'timer action bar remains below the navigation stacking layer')
check(timer.includes('minHeight: 44'), 'every shared timer action is touch-safe')
check(timer.includes("gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'"), 'controls wrap into two safe columns at 320px')
check(timer.includes('maxWidth: 480') && timer.includes('minWidth: 0'), 'the action bar stays bounded without horizontal overflow')
check(['Start', 'Pause', 'Resume', 'Restart', 'Previous', 'Skip'].every(label => timer.includes(label)), 'all required timer and navigation actions are explicit')
check(stretches.includes("padding: '20px 16px 220px'"), 'library timer content clears the shared action bar')
check(stretchSession.includes("paddingBottom: 'calc(var(--app-bottom-nav-height, 59px) + 164px)'"), 'session timer content clears the shared action bar')

console.log(`STRETCH ACTION BAR SMOKE OK (${passed})`)
