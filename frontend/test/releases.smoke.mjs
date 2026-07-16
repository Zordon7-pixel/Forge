import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  RELEASES,
  eligibleReleases,
  isAllowedReleaseCta,
} from '../src/data/releases.js'

const locale = JSON.parse(fs.readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'))
let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

function translation(path) {
  return path.split('.').reduce((value, key) => value?.[key], locale)
}

const ids = new Set()
const sequences = new Set()
let prior = 0
for (const release of RELEASES) {
  check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(release.id) && !ids.has(release.id), 'release id is unique kebab-case')
  ids.add(release.id)
  check(Number.isInteger(release.sequence) && release.sequence > prior && !sequences.has(release.sequence), 'sequences are unique and strictly ascending')
  sequences.add(release.sequence); prior = release.sequence
  check(/^\d{4}-\d{2}-\d{2}$/.test(release.publishedAt) && !Number.isNaN(new Date(`${release.publishedAt}T12:00:00`).getTime()), 'published date is valid')
  check(release.highlightKeys.length >= 1 && release.highlightKeys.length <= 3, 'release has one to three highlights')
  check(['web', 'native', 'mixed'].includes(release.delivery), 'delivery is allowlisted')
  check(['all', 'ios', 'android'].includes(release.audience), 'audience is allowlisted')
  check(Boolean(translation(release.titleKey)) && Boolean(translation(release.summaryKey)), 'title and summary copy exist')
  release.highlightKeys.forEach((key) => check(Boolean(translation(key)), `highlight copy exists: ${key}`))
  if (release.cta) {
    check(isAllowedReleaseCta(release.cta.to), 'CTA stays on an allowed app route')
    check(Boolean(translation(release.cta.labelKey)), 'CTA copy exists')
  }
  if (release.delivery === 'web') check(release.minIosBuild === null && release.minAndroidBuild === null, 'web releases do not claim native minimums')
}

const webReleases = eligibleReleases({ platform: 'web' })
check(webReleases.length === RELEASES.filter((release) => release.delivery === 'web' && release.audience === 'all').length, 'all current web releases are eligible')
check(webReleases.at(-1)?.id === 'forged-closet', 'Forged Closet is the newest web release')
check(!isAllowedReleaseCta('https://example.com'), 'external CTA is rejected')
check(!isAllowedReleaseCta('//example.com'), 'protocol-relative CTA is rejected')
const contextSource = fs.readFileSync(new URL('../src/context/ReleaseNotesContext.jsx', import.meta.url), 'utf8')
const stateSource = fs.readFileSync(new URL('../src/lib/releaseState.js', import.meta.url), 'utf8')
const sheetSource = fs.readFileSync(new URL('../src/components/WhatsNewSheet.jsx', import.meta.url), 'utf8')
check(contextSource.includes("location.pathname === '/whats-new'"), 'archive route suppresses the one-time sheet')
check(contextSource.includes("document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')"), 'existing app dialogs suppress the sheet')
check(sheetSource.includes('aria-modal="true"') && sheetSource.includes("event.key === 'Escape'"), 'sheet is modal and Escape-aware')
check(sheetSource.includes('window.history.pushState'), 'sheet consumes browser back before route navigation')
check(stateSource.includes('forge_whats_new_seen:'), 'local fallback is scoped by authenticated user')
check(stateSource.includes('writeLocalReleaseState(userId, optimistic, true)'), 'failed acknowledgements remain pending for the next authoritative server load')

console.log(`PASSED: ${passed}  FAILED: 0`)
console.log('RELEASE MANIFEST SMOKE OK')
