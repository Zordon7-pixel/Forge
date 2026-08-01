import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const layout = read('src/components/Layout.jsx')
const stretches = read('src/pages/Stretches.jsx')
const css = read('src/index.css')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(css.includes('--app-bottom-nav-height: calc(var(--app-bottom-nav-base-height) + var(--safe-bottom))'), 'shared CSS defines one safe-area-aware bottom-nav height')
check(layout.includes("height: 'var(--app-bottom-nav-height)'"), 'bottom navigation consumes the shared height')
check(stretches.includes("bottom: 'var(--app-bottom-nav-height, 59px)'"), 'stretch action bar sits above the bottom navigation')
check(stretches.includes('zIndex: 25'), 'stretch action bar remains below the navigation stacking layer')

console.log(`STRETCH ACTION BAR SMOKE OK (${passed})`)
