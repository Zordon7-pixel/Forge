import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  durationPartsToSeconds,
  formatDuration,
  normalizeDurationSeconds,
  splitDurationSeconds,
} from '../src/lib/duration.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

assert.deepEqual(splitDurationSeconds(2 * 3600 + 8 * 60), { hours: 2, minutes: 8, seconds: 0 })
assert.equal(durationPartsToSeconds({ hours: 2, minutes: 8, seconds: 0 }), 7680)
assert.equal(formatDuration(7680), '2:08:00')
assert.equal(formatDuration(7680, { padHours: true }), '02:08:00')
assert.equal(normalizeDurationSeconds(null), 0)
assert.equal(normalizeDurationSeconds('invalid'), 0)
assert.equal(durationPartsToSeconds({ hours: 1, minutes: 75, seconds: 80 }), 7199)

const picker = read('src/components/DurationPicker.jsx')
const editor = read('src/components/calendar/RaceEditSheet.jsx')
const catalog = read('src/pages/PlanCatalog.jsx')
const races = read('src/pages/Races.jsx')

assert.match(picker, /key: 'hours', label: 'Hours'/)
assert.match(picker, /key: 'minutes', label: 'Minutes'/)
assert.match(picker, /key: 'seconds', label: 'Seconds'/)
assert.match(picker, /aria-label=\{`\$\{ariaLabel\} \$\{unit\.label\.toLowerCase\(\)\}`\}/)
assert.match(picker, /durationPartsToSeconds/)
assert.match(picker, /Clear goal time/)
assert.doesNotMatch(picker, /<input/)

for (const [name, source] of [
  ['race editor', editor],
  ['plan catalog', catalog],
  ['race form', races],
]) {
  assert.match(source, /<DurationPicker/, `${name} uses the shared duration picker`)
  assert.doesNotMatch(source, /placeholder="(?:Goal time|1:30|01:30)/, `${name} has no free-text goal-time field`)
}

assert.match(editor, /goal_time_seconds: draft\.goal_time_seconds \|\| null/)
assert.match(catalog, /goalTimeSeconds \|\| null/)
assert.match(races, /goal_time_seconds: form\.goal_time_seconds \|\| null/)
assert.doesNotMatch(catalog, /\{goalTime &&/, 'numeric zero cannot render as text in the plan form')
assert.equal((catalog.match(/\{goalTime > 0 &&/g) || []).length, 2)

console.log('DURATION PICKER SMOKE OK (25)')
