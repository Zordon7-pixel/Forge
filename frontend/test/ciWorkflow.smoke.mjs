import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const source = read('../../.github/workflows/forge-qa.yml')
const workflow = YAML.parse(source, { uniqueKeys: true })
const packageScripts = JSON.parse(read('../../package.json')).scripts
const backendScripts = JSON.parse(read('../../backend/package.json')).scripts
const frontendScripts = JSON.parse(read('../package.json')).scripts
const normalConfig = read('../playwright.config.mjs')
const swConfig = read('../playwright.service-worker.config.mjs')
const install = 'npm --prefix frontend ci\nnpm --prefix backend ci'
const verdict = 'test "$DETERMINISTIC_RESULT" = success && test "$BROWSER_RESULT" = success'
const commands = job => job.steps.filter(step => step.run).map(step => step.run.trim())
function validate(value) {
  assert.deepEqual(value.on, { pull_request: null, push: { branches: ['main'] }, workflow_dispatch: null, schedule: [{ cron: '17 */6 * * *' }] })
  assert.deepEqual(value.concurrency, { group: 'forge-qa-${{ github.ref }}', 'cancel-in-progress': true })
  const jobs = value.jobs
  assert.deepEqual(Object.keys(jobs).sort(), ['browser-qa', 'deterministic-and-browser-qa', 'deterministic-qa', 'ios-native-compile', 'production-shell-qa'].sort())
  for (const key of ['deterministic-qa', 'browser-qa']) {
    const job = jobs[key]
    assert.equal(job['runs-on'], 'ubuntu-latest')
    assert.equal(job['timeout-minutes'], 45)
    assert.equal(job.needs, undefined, 'expensive suites must run independently')
    assert.equal(job.if, undefined, 'no conditional omission of either suite')
    assert.equal(job.steps[0].uses, 'actions/checkout@v7')
    assert.deepEqual(job.steps[1], { uses: 'actions/setup-node@v7', with: { 'node-version': 22, cache: 'npm', 'cache-dependency-path': 'frontend/package-lock.json\nbackend/package-lock.json\n' } })
    for (const step of job.steps.filter(step => step.run)) assert.equal(step.if, undefined)
  }
  assert.deepEqual(commands(jobs['deterministic-qa']), [install, 'npm run qa:smoke', 'npm --prefix backend run check:account-data', 'npm --prefix frontend audit --audit-level=high\nnpm --prefix backend audit --audit-level=high', 'npm --prefix frontend run build'])
  assert.deepEqual(commands(jobs['browser-qa']), [install, 'npx playwright install --with-deps chromium', 'npm run qa:browser'])
  const browserSteps = jobs['browser-qa'].steps
  assert.equal(browserSteps.find(step => step.run === 'npx playwright install --with-deps chromium')['working-directory'], 'frontend')
  const upload = browserSteps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.equal(upload.if, 'failure()')
  assert.equal(upload.with.name, 'forge-playwright-report')
  assert.equal(upload.with.path, 'frontend/playwright-report\nfrontend/test-results\n')
  assert.equal(upload.with['retention-days'], 7)
  const aggregate = jobs['deterministic-and-browser-qa']
  assert.equal(aggregate.if, '${{ always() }}')
  assert.deepEqual(aggregate.needs, ['deterministic-qa', 'browser-qa'])
  assert.equal(aggregate['runs-on'], 'ubuntu-latest')
  assert.equal(aggregate['timeout-minutes'], 5)
  assert.equal(aggregate.steps.length, 1)
  assert.equal(aggregate.steps[0].if, undefined)
  assert.equal(aggregate.steps[0].run, verdict)
  assert.deepEqual(aggregate.steps[0].env, { DETERMINISTIC_RESULT: '${{ needs.deterministic-qa.result }}', BROWSER_RESULT: '${{ needs.browser-qa.result }}' })
  const production = jobs['production-shell-qa']
  assert.deepEqual(production.needs, ['deterministic-qa', 'browser-qa', 'deterministic-and-browser-qa'])
  assert.equal(production.if, "github.event_name != 'pull_request'")
  assert.equal(production['timeout-minutes'], 20)
  // No job/step may transform an error into a successful release gate.
  const visit = node => {
    if (!node || typeof node !== 'object') return
    assert.equal(Object.hasOwn(node, 'continue-on-error'), false)
    for (const child of Object.values(node)) visit(child)
  }
  visit(value)
}
validate(workflow)

// Pinned scripts retain every original suite and both browser viewport projects.
assert.equal(packageScripts['qa:smoke'], 'npm --prefix frontend run test:smoke && npm --prefix backend run test:smoke')
assert.equal(packageScripts['qa:browser'], 'npm --prefix frontend run test:e2e && npm --prefix frontend run test:e2e:sw')
assert.equal(backendScripts['test:smoke'], 'node scripts/run-smoke-suite.js && node test/adaptiveCoachingCalendar.smoke.js --route-positive')
assert.equal(frontendScripts['test:e2e'], 'playwright test')
assert.equal(frontendScripts['test:e2e:sw'], 'playwright test --config=playwright.service-worker.config.mjs')
for (const name of ['compact-mobile-320', 'iphone-17']) assert(normalConfig.includes(`name: '${name}'`))
assert(normalConfig.includes('retries: process.env.CI ? 1 : 0'))
assert(normalConfig.includes('forbidOnly: Boolean(process.env.CI)'))
assert(swConfig.includes("testMatch: 'serviceWorker.spec.mjs'"))

// Byte-for-byte protection for the native job and live-shell revision semantics.
const native = source.slice(source.indexOf('  ios-native-compile:'), source.indexOf('  production-shell-qa:'))
assert.equal(createHash('sha256').update(native).digest('hex'), 'e65f80468806044db3af292458be0e3f822b5797890d2e122193c086aa8e94dc')
const production = workflow.jobs['production-shell-qa']
const expected = production.steps.find(step => step.name === 'Export expected pushed revision and bundle identity')
assert.equal(expected.if, "github.event_name != 'schedule'")
assert.equal(expected.run.trim(), 'npm --prefix frontend run build\necho "FORGE_QA_EXPECTED_REVISION=$GITHUB_SHA" >> "$GITHUB_ENV"\nnode frontend/scripts/export-built-entry.mjs >> "$GITHUB_ENV"')
assert(commands(production).includes('npm --prefix frontend run wait:production'))
assert(commands(production).includes('npm run qa:production'))

// Exercise the actual aggregate shell for success/failure/cancellation/skips.
for (const deterministic of ['success', 'failure', 'cancelled', 'skipped']) {
  for (const browser of ['success', 'failure', 'cancelled', 'skipped']) {
    const result = spawnSync('/bin/sh', ['-c', verdict], { env: { DETERMINISTIC_RESULT: deterministic, BROWSER_RESULT: browser } })
    assert.equal(result.status === 0, deterministic === 'success' && browser === 'success')
  }
}
for (const mutate of [
  value => value.jobs['browser-qa'].steps.splice(2, 1),
  value => { value.jobs['browser-qa'].steps[2].run = 'npm --prefix frontend ci' },
  value => { value.jobs['browser-qa'].steps[4].run = 'npm --prefix frontend run test:e2e' },
  value => { value.jobs['deterministic-qa'].steps[3].run = 'echo skipped' },
  value => { value.jobs['deterministic-qa'].steps[4].if = 'false' },
  value => { value.jobs['production-shell-qa'].needs = ['deterministic-qa'] },
  value => { delete value.jobs['deterministic-and-browser-qa'].if },
  value => { value.jobs['browser-qa']['continue-on-error'] = true },
  value => { value.jobs['browser-qa'].needs = 'deterministic-qa' },
]) {
  const changed = structuredClone(workflow); mutate(changed)
  assert.throws(() => validate(changed))
}
console.log('CI WORKFLOW GATE OK: independent bounded suites; locked coverage/dependencies; 16 aggregate outcomes; nine omission negatives; native bytes and production identities preserved')
