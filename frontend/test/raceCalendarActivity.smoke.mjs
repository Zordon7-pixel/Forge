import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateModalDialog } from '../src/lib/modalDialog.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const plan = read('frontend/src/pages/Plan.jsx')
const catalog = read('frontend/src/pages/PlanCatalog.jsx')
const calendar = read('frontend/src/components/calendar/ForgedCalendar.jsx')
const dayView = read('frontend/src/components/calendar/ForgedDayView.jsx')
const raceEditor = read('frontend/src/components/calendar/RaceEditSheet.jsx')
const racesRoute = read('backend/src/routes/races.js')
const plansRoute = read('backend/src/routes/plans.js')
const runsRoute = read('backend/src/routes/runs.js')
const history = read('frontend/src/pages/History.jsx')
const modalDialog = read('frontend/src/lib/modalDialog.js')

assert.match(plan, /api\.get\('\/races'\)/, 'Train loads the user-owned race row')
assert.match(plan, /api\.get\('\/runs'/, 'Train loads recorded activities for calendar overlays')
assert.match(plan, /calendarDateRange\(nextCalendar, todayISO\(\)\)/, 'Train bounds activity loading to the active calendar plus today')
assert.match(plan, /runDateRange[\s\S]*limit: 500/, 'the bounded calendar query can cover a full twenty-week plan')
assert.match(runsRoute, /date >= \? AND date <= \?[\s\S]*\[req\.user\.id, startDate, endDate, limit\]/, 'calendar-range run reads remain owner scoped')
assert.match(history, /api\.get\(`\/runs\/\$\{encodeURIComponent\(runId\)\}`\)/, 'History directly loads a linked run outside its default list')
assert.match(plan, /api\.patch\(`\/races\/\$\{encodeURIComponent\(activeRace\.id\)\}`/, 'race saves target the selected race id')
assert.match(racesRoute, /router\.patch\('\/:id', auth/, 'race editing remains authenticated')
assert.match(racesRoute, /SELECT \* FROM race_events WHERE id=\? AND user_id=\?/, 'race ownership is checked before editing')
assert.match(racesRoute, /UPDATE race_events[\s\S]*WHERE id=\? AND user_id=\?/, 'race mutation is owner scoped')
assert.match(racesRoute, /const identityChanged =[\s\S]*course_profile_json: null[\s\S]*SET race_name=\?, race_date=\?, distance_miles=\?[\s\S]*course_profile_json=\?/, 'identity edits clear stale course facts before a rebuild')
assert.match(plansRoute, /router\.put\('\/my\/race-link', auth[\s\S]*SELECT \* FROM race_events WHERE id=\? AND user_id=\?[\s\S]*updateActivePlanData/, 'legacy race linkage is authenticated, owner checked, and persisted through the active-plan mutation path')
assert.match(plan, /api\.put\('\/plans\/my\/race-link'[\s\S]*api\.patch\(`\/races\//, 'legacy linkage is made durable before changing the race identity')
assert.match(raceEditor, /Goal time/, 'race editor exposes the goal-time control')
assert.match(raceEditor, /race_name:[\s\S]*race_date:[\s\S]*distance_miles:[\s\S]*goal_time_seconds:/, 'race editor submits the editable race identity and goal')
assert.match(raceEditor, /race\.race_name[\s\S]*race\.race_date[\s\S]*race\.distance_miles[\s\S]*race\.goal_time_seconds[\s\S]*race\.location/, 'every race identity, course, or goal edit prompts a plan rebuild review')
assert.match(raceEditor, /fontSize: 16/, 'race form controls avoid iOS input auto-zoom')
assert.match(raceEditor, /activateModalDialog\([\s\S]*dialog: dialogRef\.current[\s\S]*if \(!saving\) onClose/, 'race editor uses the behavior-tested modal controller without allowing Escape during save')
assert.match(plan, /indexRecordedRuns\(runs\)/, 'recorded runs are indexed separately from plan sessions')
assert.match(calendar, /recordedRunsByDate\?\.get\(day\.dateISO\)/, 'week rows receive same-date recorded runs')
assert.match(calendar, /cell\.hasRecordedRun/, 'activity-only month dates remain openable')
assert.match(dayView, /Recorded separately from this plan/, 'off-plan activity is never presented as plan completion')
assert.match(plan, /navigate\(`\/history\?runId=\$\{encodeURIComponent\(activity\.id\)\}`\)/, 'recorded activity opens its existing History recap')
assert.match(catalog, /location\.state\?\.raceId[\s\S]*openRace\(race, 'owned'\)/, 'plan rebuild handoff opens the exact edited race')
assert.match(catalog, /activateModalDialog\(\{\s*dialog: planDialogRef\.current,\s*onClose: closeOptions,/, 'rebuild dialog delegates Escape to closeOptions')
const closeDelegates = [...catalog.matchAll(/const closeOptions = \(\) => \{([\s\S]*?)\n  \}/g)]
assert.equal(closeDelegates.length, 1, 'execute the actual catalog close delegate')
const generationInFlight = { current: false }
const prefillRequestRevision = { current: 7 }
const closeEffects = []
const closeOptions = vm.runInNewContext(`(() => {${closeDelegates[0][1]}\n})`, {
  generationInFlight, prefillRequestRevision,
  setPrefillLoading: value => closeEffects.push(['prefill', value]),
  setSelectedGoal: value => closeEffects.push(['goal', value]),
})
assert.match(modalDialog, /event\.key === 'Escape'[\s\S]*node\.inert = true[\s\S]*documentRef\.body\.style\.overflow = 'hidden'/, 'modal controller handles Escape, inert background, and scroll lock')
assert.match(catalog, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="plan-options-title"/, 'rebuild dialog exposes modal semantics and an accessible title')

function createElement(name, documentRef) {
  const attributes = new Map()
  return {
    name,
    inert: false,
    style: {},
    children: [],
    parentElement: null,
    focus() { documentRef.activeElement = this },
    getAttribute(key) { return attributes.has(key) ? attributes.get(key) : null },
    setAttribute(key, value) { attributes.set(key, String(value)) },
    removeAttribute(key) { attributes.delete(key) },
    contains(target) {
      if (target === this) return true
      return this.children.some((child) => child.contains(target))
    },
    querySelectorAll() { return [] },
  }
}

function append(parent, child) {
  parent.children.push(child)
  child.parentElement = parent
}

function dispatchKey(documentRef, key, shiftKey = false) {
  const event = new Event('keydown', { cancelable: true })
  Object.defineProperty(event, 'key', { value: key })
  Object.defineProperty(event, 'shiftKey', { value: shiftKey })
  documentRef.dispatchEvent(event)
  return event
}

const documentRef = new EventTarget()
const body = createElement('body', documentRef)
const root = createElement('root', documentRef)
const page = createElement('page', documentRef)
const overlay = createElement('overlay', documentRef)
const dialog = createElement('dialog', documentRef)
const firstButton = createElement('first-button', documentRef)
const lastButton = createElement('last-button', documentRef)
const outsideFooter = createElement('footer', documentRef)
const opener = createElement('opener', documentRef)
body.style.overflow = 'auto'
outsideFooter.setAttribute('aria-hidden', 'false')
append(body, root)
append(body, outsideFooter)
append(root, page)
append(root, overlay)
append(page, opener)
append(overlay, dialog)
append(dialog, firstButton)
append(dialog, lastButton)
dialog.querySelectorAll = () => [firstButton, lastButton]
documentRef.body = body
documentRef.activeElement = opener

let closeCount = 0
const cleanupModal = activateModalDialog({
  dialog,
  documentRef,
  onClose: () => { closeCount += 1; closeOptions() },
})

assert.equal(documentRef.activeElement, dialog, 'opening the dialog moves focus inside it')
assert.equal(body.style.overflow, 'hidden', 'opening the dialog locks body scroll')
assert.equal(page.inert, true, 'page content behind the dialog becomes inert')
assert.equal(outsideFooter.inert, true, 'background outside the page branch also becomes inert')
assert.equal(page.getAttribute('aria-hidden'), 'true', 'page content is hidden from assistive technology')
assert.equal(outsideFooter.getAttribute('aria-hidden'), 'true', 'outer background is hidden from assistive technology')

lastButton.focus()
const forwardTab = dispatchKey(documentRef, 'Tab')
assert.equal(forwardTab.defaultPrevented, true, 'forward Tab is contained at the last control')
assert.equal(documentRef.activeElement, firstButton, 'forward Tab wraps to the first control')
firstButton.focus()
const backwardTab = dispatchKey(documentRef, 'Tab', true)
assert.equal(backwardTab.defaultPrevented, true, 'reverse Tab is contained at the first control')
assert.equal(documentRef.activeElement, lastButton, 'reverse Tab wraps to the last control')
opener.focus()
dispatchKey(documentRef, 'Tab')
assert.equal(documentRef.activeElement, firstButton, 'focus forced outside the dialog is recovered')
generationInFlight.current = { id: 'pending-generation' }
const lockedEscape = dispatchKey(documentRef, 'Escape')
assert.equal(lockedEscape.defaultPrevented, true, 'Escape is consumed during generation')
assert.equal(closeCount, 1, 'Escape reaches the actual delegate during generation')
assert.deepEqual(closeEffects, [], 'generation lock prevents all close side effects')
assert.equal(prefillRequestRevision.current, 7, 'locked Escape does not invalidate pending prefill')
assert.equal(body.style.overflow, 'hidden', 'locked dialog keeps scroll locked')
assert.equal(page.inert, true, 'locked dialog keeps the background inert')
generationInFlight.current = false
const escape = dispatchKey(documentRef, 'Escape')
assert.equal(escape.defaultPrevented, true, 'Escape is consumed by the dialog')
assert.equal(closeCount, 2, 'unlocked Escape reaches the same delegate once')
assert.deepEqual(closeEffects, [['prefill', false], ['goal', null]], 'close stops loading and clears selected goal')
assert.equal(prefillRequestRevision.current, 8, 'close invalidates stale prefill')

cleanupModal()
assert.equal(body.style.overflow, 'auto', 'cleanup restores the prior body scroll state')
assert.equal(page.inert, false, 'cleanup restores page inert state')
assert.equal(outsideFooter.inert, false, 'cleanup restores outer inert state')
assert.equal(page.getAttribute('aria-hidden'), null, 'cleanup removes newly added aria-hidden')
assert.equal(outsideFooter.getAttribute('aria-hidden'), 'false', 'cleanup restores an existing aria-hidden value')
assert.equal(documentRef.activeElement, opener, 'cleanup restores focus to the opener')

console.log('RACE CALENDAR ACTIVITY SMOKE OK (including actual close delegate and generation lock)')
