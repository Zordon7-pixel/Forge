import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const indexCss = read('src/index.css')
const indexHtml = read('index.html')
const community = read('src/pages/Community.jsx')
const layout = read('src/components/Layout.jsx')
const plan = read('src/pages/Plan.jsx')
const planCatalog = read('src/pages/PlanCatalog.jsx')
const raceEditor = read('src/components/calendar/RaceEditSheet.jsx')
const durationPicker = read('src/components/DurationPicker.jsx')

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
check(community.includes("gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'"), 'all four Community tabs can shrink within narrow phones')
check(community.includes("overflowX: 'clip'"), 'Community contains accidental horizontal paint overflow')
check((community.match(/maxWidth: 'calc\(100vw - 24px\)'/g) || []).length === 2, 'friend action menus are capped to the phone viewport')
check(layout.includes('grid-cols-5'), 'bottom navigation remains a stable five-column grid')
check(layout.includes("maxWidth: 'min(480px, 100vw)'"), 'app shell stays bounded to the device viewport')
check(plan.includes('className="rounded-lg p-4 min-w-0"') && plan.includes("overflowWrap: 'anywhere'"), 'the durable plan-review status wraps inside narrow phones')
check(planCatalog.includes("width: 'min(660px, 100%)'") && planCatalog.includes("maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - 18px)'"), 'the review dialog is viewport- and safe-area-bounded')
check(planCatalog.includes("paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)'") && planCatalog.includes("overscrollBehavior: 'contain'"), 'the review dialog preserves bottom-safe actions and contained scrolling')

for (const viewportWidth of [320, 375]) {
  const overlayContentWidth = viewportWidth - 20
  const reviewDialogWidth = Math.min(660, overlayContentWidth)
  const raceDialogWidth = Math.min(620, overlayContentWidth)
  check(reviewDialogWidth > 0 && reviewDialogWidth <= viewportWidth, `${viewportWidth}px review dialog has no horizontal overflow`)
  check(raceDialogWidth > 0 && raceDialogWidth <= viewportWidth, `${viewportWidth}px race editor has no horizontal overflow`)
}

check(raceEditor.includes('fontSize: 16') && durationPicker.includes('fontSize: 20'), 'race and duration-picker form controls remain above the 16px mobile zoom threshold')
check((planCatalog.match(/<select[\s\S]{0,300}fontSize: 16/g) || []).length >= 3, 'review-plan selects use at least 16px text')
check(planCatalog.includes('activateModalDialog({') && planCatalog.includes('role="dialog"') && planCatalog.includes('aria-modal="true"'), 'the review dialog retains focus management and modal semantics')

console.log(`MOBILE VIEWPORT SMOKE OK (${passed})`)
