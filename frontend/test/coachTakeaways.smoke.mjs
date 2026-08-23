import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCoachTakeaways } from '../src/lib/coachTakeaways.js'

const longFeedback = 'Your final mile stayed controlled at the planned effort. Recovery should stay easy for the next 24 hours. Keep the next run conversational before adding speed. No pain was reported, but stop if discomfort appears. Heart rate stayed steady through the finish.'
const longTakeaways = buildCoachTakeaways(longFeedback)
assert.equal(longTakeaways.length, 4, 'long feedback is bounded to four takeaways')
assert.equal(longTakeaways[0].label, 'Pain', 'pain and safety language is promoted to the first takeaway')
assert.ok(longTakeaways.some(({ label }) => label === 'Next Step'), 'actionable advice keeps a highlighted Next Step label')
assert.ok(longTakeaways.some(({ label }) => label === 'Recovery'), 'recovery guidance keeps a highlighted Recovery label')
for (const phrase of [
  'Your final mile stayed controlled at the planned effort.',
  'Recovery should stay easy for the next 24 hours.',
  'Keep the next run conversational before adding speed.',
  'No pain was reported, but stop if discomfort appears.',
  'Heart rate stayed steady through the finish.',
]) {
  assert.ok(longTakeaways.some(({ text }) => text.includes(phrase)), `long feedback preserves: ${phrase}`)
}

const clauseTakeaways = buildCoachTakeaways('Hold this effort steady; recover fully before the next hard run.')
assert.equal(clauseTakeaways.length, 2, 'a compact semicolon-delimited evaluation becomes two takeaways')
assert.deepEqual(clauseTakeaways.map(({ label }) => label), ['Next Step', 'Recovery'])

const shortTakeaways = buildCoachTakeaways('Effort stayed controlled.')
assert.deepEqual(shortTakeaways, [{ label: 'Effort', text: 'Effort stayed controlled.' }], 'an indivisible short evaluation remains one meaningful takeaway')

assert.deepEqual(buildCoachTakeaways(''), [], 'an empty evaluation produces no empty bullets')
assert.deepEqual(buildCoachTakeaways('   \n  '), [], 'whitespace-only evaluation produces no empty bullets')
assert.deepEqual(buildCoachTakeaways(null), [], 'a null legacy evaluation produces no empty bullets')

const bulleted = buildCoachTakeaways('• Effort: Pace stayed even.\n• Next step: Keep tomorrow easy.\n\n- Recovery: Hydrate and rest.')
assert.deepEqual(bulleted, [
  { label: 'Next Step', text: 'Keep tomorrow easy.' },
  { label: 'Recovery', text: 'Hydrate and rest.' },
  { label: 'Effort', text: 'Pace stayed even.' },
], 'legacy bullets use grammatical labels, omit empty items, and retain their copy')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const modal = fs.readFileSync(path.join(repoRoot, 'frontend/src/components/RunDetailModal.jsx'), 'utf8')
assert.match(modal, /<ul[^>]+aria-label="Run coaching takeaways"/, 'the Coach Takeaways card uses a semantic list')
assert.match(modal, /<li[\s\S]*?takeaway\.label[\s\S]*?takeaway\.text/, 'every takeaway exposes a visible text label and supporting copy')
assert.match(modal, /linear-gradient\(145deg, var\(--accent-dim\)/, 'the card follows the existing dark and gold visual tokens')
assert.match(modal, /overflowWrap: 'anywhere'/, 'long legacy copy wraps safely on narrow phones')
assert.doesNotMatch(modal, />\{feedback\}<\/p>/, 'the full wall-of-text paragraph is no longer duplicated below the takeaways')
assert.ok(modal.indexOf('<AiGuidanceNote />') > modal.indexOf('aria-label="Run coaching takeaways"'), 'the AI guidance disclaimer remains visible after the takeaways')

console.log('COACH TAKEAWAYS SMOKE OK (long, short, empty, legacy bullets, semantic mobile card)')
