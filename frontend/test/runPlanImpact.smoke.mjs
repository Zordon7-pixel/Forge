import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const modal = read('frontend/src/components/RunDetailModal.jsx')
const impact = read('frontend/src/components/RunPlanImpact.jsx')

assert.match(modal, /isRun && <RunPlanImpact run=\{run\} \/>/, 'every running-activity detail mounts plan-impact analysis')
assert.match(impact, /api\.get\('\/plans\/adaptation\/current'/, 'plan impact reuses the deterministic adaptation endpoint')
assert.match(impact, /api\.post\(`\/plans\/adaptation\/\$\{proposal\.id\}\/\$\{nextDecision\}`\)/, 'plan decisions reuse user-scoped accept and keep endpoints')
assert.ok(impact.includes("'Apply adjustment'"), 'the user can apply a proposed adjustment')
assert.ok(impact.includes("'Keep plan'"), 'the user can keep the original plan')
assert.doesNotMatch(impact, /ai\/|openai|anthropic/i, 'run-plan impact does not add an LLM path')

console.log('RUN PLAN IMPACT SMOKE OK (6)')
