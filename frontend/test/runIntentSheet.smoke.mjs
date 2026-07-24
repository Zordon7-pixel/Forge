import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockDocumentScroll } from '../src/lib/documentScrollLock.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const logRun = read('src/pages/LogRun.jsx')
const css = read('src/index.css')

function styleWith(values) {
  return {
    overflow: '',
    position: '',
    top: '',
    left: '',
    right: '',
    width: '',
    touchAction: '',
    overscrollBehavior: '',
    ...values,
  }
}

const originalBodyStyles = {
  overflow: 'auto',
  position: 'relative',
  top: '3px',
  left: '4px',
  right: '5px',
  width: '92%',
  touchAction: 'manipulation',
}
const originalRootStyles = {
  overflow: 'clip',
  overscrollBehavior: 'contain',
  touchAction: 'auto',
}
const bodyStyle = styleWith(originalBodyStyles)
const rootStyle = styleWith(originalRootStyles)
const restoredScrollPositions = []
const release = lockDocumentScroll({
  documentRef: {
    body: { style: bodyStyle },
    documentElement: { style: rootStyle },
  },
  windowRef: {
    scrollX: 7,
    scrollY: 318,
    scrollTo: (x, y) => restoredScrollPositions.push([x, y]),
  },
})

assert.equal(bodyStyle.overflow, 'hidden', 'open sheet locks body overflow')
assert.equal(bodyStyle.position, 'fixed', 'iOS background is pinned instead of remaining page-scrollable')
assert.equal(bodyStyle.top, '-318px', 'body pin preserves the prior vertical page position')
assert.equal(bodyStyle.touchAction, 'pan-y', 'the lock does not suppress vertical pan gestures needed by the sheet')
assert.equal(rootStyle.overflow, 'hidden', 'document root cannot scroll behind the portal')

release()
release()
assert.deepEqual(
  Object.fromEntries(Object.keys(originalBodyStyles).map((key) => [key, bodyStyle[key]])),
  originalBodyStyles,
  'close restores every prior body overflow, position, and touch style exactly',
)
assert.deepEqual(
  Object.fromEntries(Object.keys(originalRootStyles).map((key) => [key, rootStyle[key]])),
  originalRootStyles,
  'close restores every prior document-root overflow and touch style exactly',
)
assert.deepEqual(restoredScrollPositions, [[7, 318]], 'close restores page scroll once')

assert.match(logRun, /createPortal\([\s\S]*document\.body/, 'sheet is portaled outside the pull-to-refresh scroll ancestor')
assert.match(logRun, /data-testid="run-intent-scrollport"[\s\S]*data-swipe-back-ignore/, 'dedicated scrollport opts out of the page swipe gesture')
assert.match(logRun, /aria-pressed=\{selectedRunIntentId === 'extra'\}/, 'extra-run card exposes selected state')
assert.match(logRun, /aria-pressed=\{isSelected\}/, 'missed-run cards expose selected state')
assert.match(logRun, /onClick=\{continueRunIntent\}[\s\S]*className="run-intent-primary/, 'selected choice has a semantic primary action')
assert.match(css, /\.run-intent-overlay\s*\{[\s\S]*height:\s*100dvh;[\s\S]*overflow:\s*hidden;/, 'overlay is bounded to the dynamic viewport')
assert.match(css, /\.run-intent-sheet\s*\{[\s\S]*max-height:\s*calc\(100dvh[\s\S]*min-height:\s*0;[\s\S]*overflow:\s*hidden;/, 'sheet shell is viewport-bounded and cannot become the page scrollport')
assert.match(css, /\.run-intent-scrollport\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;[\s\S]*-webkit-overflow-scrolling:\s*touch;[\s\S]*touch-action:\s*pan-y;/, 'internal scrollport preserves iOS momentum and vertical pan')
assert.match(css, /\.run-intent-content\s*\{[\s\S]*var\(--safe-bottom\)/, 'bottom content clears the iPhone safe area')

console.log('RUN INTENT SHEET SMOKE OK (body-lock behavior + mobile geometry contracts)')
