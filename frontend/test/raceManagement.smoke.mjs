import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const races = read('frontend/src/pages/Races.jsx')
const editor = read('frontend/src/components/calendar/RaceEditSheet.jsx')
const removal = read('frontend/src/lib/selfServiceRemoval.js')

assert.match(races, /import RaceEditSheet from ['"]\.\.\/components\/calendar\/RaceEditSheet['"]/, 'Upcoming race editing reuses RaceEditSheet')
assert.equal(races.includes('RaceRemoveSheet'), false, 'one-tap removal never opens a separate review or confirmation sheet')
assert.match(races, /upcoming\.map[\s\S]*>Edit<[\s\S]*>Remove</, 'every mapped Upcoming card exposes visible Edit and Remove actions')
assert.match(races, /minHeight:\s*44/g, 'race actions expose 44px touch targets')
assert.match(races, /gridTemplateColumns:\s*'repeat\(2, minmax\(0, 1fr\)\)'/, 'card management controls fit a 320px two-column layout')
assert.match(races, /background:\s*'var\(--danger-dim\)'[\s\S]*color:\s*'var\(--danger\)'/, 'Remove is visually distinct without relying on color alone')

const previewCall = removal.indexOf('/removal-preview`')
const directDelete = removal.indexOf('api.delete(`/races/${encodedRaceId}`')
const linkedApply = removal.indexOf('api.post(`/races/${encodedRaceId}/removal-apply`')
assert.ok(previewCall >= 0, 'one Remove action fetches the backend impact preview')
assert.ok(directDelete > previewCall, 'that same action directly deletes an unlinked race after impact resolution')
assert.ok(linkedApply > previewCall, 'that same action automatically applies the exact linked replacement candidate')
assert.match(removal, /if \(!data\?\.requires_apply\)[\s\S]*candidate_id:\s*candidateId[\s\S]*candidate_hash:\s*candidateHash/, 'linked removal applies the exact candidate token returned behind the action')
assert.doesNotMatch(removal, /\/plans\/candidates\//, 'race ownership removal does not route through the generic premium plan-apply surface')
assert.match(races, /if \(removingRaceId\) return[\s\S]*setRemovingRaceId\(race\.id\)/, 'a single in-flight guard prevents duplicate Remove taps')
assert.match(races, /catch \(err\)[\s\S]*await load\(\{ fresh: true \}\)[\s\S]*finally[\s\S]*setRemovingRaceId\(null\)/, 'failed or ambiguous removal refreshes account truth and restores the action')
assert.match(races, /The race is still listed[\s\S]*Refresh and try again/, 'a confirmed non-removal reports a truthful recoverable state')
assert.match(races, /await removeOwnedRace[\s\S]*const refreshed = await load\(\{ fresh: true \}\)[\s\S]*verifyRaceRemovalActivation/, 'race ownership and replacement-plan goals come from a fresh account read after the atomic removal succeeds')

assert.ok(races.includes("removingRaceId === r.id ? 'Removing…'"), 'the in-flight button copy truthfully says Removing…')
assert.equal(/Reviewing…|Applying safely…|Removal review/.test(races), false, 'one-tap removal never implies a separate review phase')
assert.ok(races.includes('Recorded runs, lifts, health data, check-ins, and training history were preserved.'), 'success copy explicitly preserves recorded history')

assert.match(races, /<RaceEditSheet[\s\S]*onSave=\{saveRaceEdit\}/, 'the reused editor owns Upcoming-card saves')
assert.match(races, /protectedGoal = activePlanRaceIds\.includes[\s\S]*affectsPlan && protectedGoal[\s\S]*previewAndApplyPlan\(\s*'\/plans\/generate-for-races'/, 'material edits to protected goals preview a rebuild before apply')
assert.match(races, /Race details were saved, but your current calendar was kept/, 'cancelled edit reconciliation truthfully distinguishes saved details from the unchanged plan')
assert.match(editor, /affectsPlan/, 'RaceEditSheet still identifies material plan edits')

assert.match(races, /\/races\/catalog/, 'legacy race catalog remains wired')
assert.match(races, /\/plans\/generate-for-race/, 'legacy single-race generation remains wired')
assert.match(races, /\/plans\/generate-for-races/, 'legacy combined-race generation remains wired')

console.log('RACE MANAGEMENT FRONTEND SMOKE OK (27)')
