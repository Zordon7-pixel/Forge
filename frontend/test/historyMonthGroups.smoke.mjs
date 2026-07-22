import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = fs.readFileSync(path.join(repoRoot, 'frontend/src/pages/History.jsx'), 'utf8')

assert.match(source, /function MonthGroups\(/, 'History has a shared monthly disclosure component')
assert.match(source, /initiallyOpen=\{index === 0\}/, 'only the newest month starts open')
assert.match(source, /open=\{open\} onToggle=/, 'month disclosures remain user-collapsible')
assert.match(source, /noun\.endsWith\('y'\)/, 'activity counts use the correct plural')
assert.match(source, /<MonthGroups items=\{filteredRuns\}/, 'activities are grouped by month')
assert.match(source, /<MonthGroups items=\{trainingHistoryItems\}/, 'lift and workout records share month groups')
assert.match(source, /<MonthGroups items=\{races\}/, 'races are grouped by month')
assert.match(source, />Trends</, 'charts remain available behind a compact Trends disclosure')

console.log('HISTORY MONTH GROUPS SMOKE OK (8)')
