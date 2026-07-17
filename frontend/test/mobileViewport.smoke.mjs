import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const indexCss = read('src/index.css')
const indexHtml = read('index.html')
const community = read('src/pages/Community.jsx')
const layout = read('src/components/Layout.jsx')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(indexCss.includes('@supports (-webkit-touch-callout: none)'), 'iOS-specific form zoom guard exists')
check(indexCss.includes("input:not([type='checkbox']):not([type='radio']):not([type='range'])"), 'text-like inputs are covered without resizing toggles')
check(indexCss.includes('font-size: 16px !important'), 'iOS form controls render at the no-auto-zoom threshold')
check(indexHtml.includes('user-scalable=yes'), 'user pinch zoom remains enabled for accessibility')
check(!indexHtml.includes('user-scalable=no') && !indexHtml.includes('maximum-scale=1'), 'viewport metadata does not trap users at an enlarged scale')
check(community.includes("gridTemplateColumns: 'repeat(3, minmax(0, 1fr))'"), 'Community tabs can shrink within narrow phones')
check(community.includes("overflowX: 'clip'"), 'Community contains accidental horizontal paint overflow')
check((community.match(/maxWidth: 'calc\(100vw - 24px\)'/g) || []).length === 2, 'friend action menus are capped to the phone viewport')
check(layout.includes('grid-cols-5'), 'bottom navigation remains a stable five-column grid')
check(layout.includes("maxWidth: 'min(480px, 100vw)'"), 'app shell stays bounded to the device viewport')

console.log(`MOBILE VIEWPORT SMOKE OK (${passed})`)
