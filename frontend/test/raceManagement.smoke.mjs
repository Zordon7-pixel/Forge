import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const races = read('frontend/src/pages/Races.jsx')
const editor = read('frontend/src/components/calendar/RaceEditSheet.jsx')
const removal = read('frontend/src/components/races/RaceRemoveSheet.jsx')

assert.match(races, /import RaceEditSheet from ['"]\.\.\/components\/calendar\/RaceEditSheet['"]/, 'Upcoming race editing reuses RaceEditSheet')
assert.match(races, /import RaceRemoveSheet from ['"]\.\.\/components\/races\/RaceRemoveSheet['"]/, 'Upcoming race removal uses the focused confirmation sheet')
assert.match(races, /upcoming\.map[\s\S]*>Edit<[\s\S]*>Remove</, 'every mapped Upcoming card exposes visible Edit and Remove actions')
assert.match(races, /minHeight:\s*44/g, 'race actions expose 44px touch targets')
assert.match(races, /gridTemplateColumns:\s*'repeat\(2, minmax\(0, 1fr\)\)'/, 'card management controls fit a 320px two-column layout')
assert.match(races, /background:\s*'var\(--danger-dim\)'[\s\S]*color:\s*'var\(--danger\)'/, 'Remove is visually distinct without relying on color alone')

const previewCall = races.indexOf('/removal-preview`')
const directDelete = races.indexOf('api.delete(`/races/${encodeURIComponent(removalState.race.id)}`')
const linkedApply = races.indexOf('api.post(`/plans/candidates/${encodeURIComponent(candidateId)}/apply`')
assert.ok(previewCall >= 0, 'Remove fetches the backend impact preview')
assert.ok(directDelete > previewCall, 'direct deletion is available only after impact preview')
assert.ok(linkedApply > previewCall, 'linked removal applies the reviewed atomic candidate')
assert.match(races, /if \(removalState\.preview\.requires_apply\)[\s\S]*candidate_hash:[\s\S]*choice:\s*'train_for_target'/, 'linked removal applies the exact reviewed candidate token')
assert.match(races, /catch \(err\)[\s\S]*setRemovalError\([\s\S]*finally[\s\S]*setRemovalApplying\(false\)/, 'failed apply reports an error and exits the loading state')
assert.ok(races.indexOf('await load()', linkedApply) > linkedApply, 'race and plan state reload only after the atomic apply succeeds')

assert.match(removal, /Recorded runs, lifts, health data, check-ins, and training history are preserved\./, 'recorded-history preservation is explicit')
assert.match(removal, /Removed[\s\S]*Rebuilt[\s\S]*Retained/, 'preview names what is removed, rebuilt, and retained')
assert.match(removal, /role="dialog"[\s\S]*aria-modal="true"/, 'removal confirmation exposes dialog semantics')
assert.match(removal, /activateModalDialog/, 'Escape, focus restoration, and scroll locking use the shared modal architecture')
assert.match(removal, /disabled=\{applying\}/, 'confirmation prevents double submission')
assert.match(removal, /minHeight:\s*48/, 'destructive confirmation has a large touch target')
assert.match(removal, /Remove race|Remove and apply reviewed plan/, 'removal requires an explicit destructive confirmation')

assert.match(races, /<RaceEditSheet[\s\S]*onSave=\{saveRaceEdit\}/, 'the reused editor owns Upcoming-card saves')
assert.match(races, /protectedGoal = activePlanRaceIds\.includes[\s\S]*affectsPlan && protectedGoal[\s\S]*previewAndApplyPlan\(\s*'\/plans\/generate-for-races'/, 'material edits to protected goals preview a rebuild before apply')
assert.match(races, /Race details were saved, but your current calendar was kept/, 'cancelled edit reconciliation truthfully distinguishes saved details from the unchanged plan')
assert.match(editor, /affectsPlan/, 'RaceEditSheet still identifies material plan edits')

assert.match(races, /\/races\/catalog/, 'legacy race catalog remains wired')
assert.match(races, /\/plans\/generate-for-race/, 'legacy single-race generation remains wired')
assert.match(races, /\/plans\/generate-for-races/, 'legacy combined-race generation remains wired')

console.log('RACE MANAGEMENT FRONTEND SMOKE OK (27)')
