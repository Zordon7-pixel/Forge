import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, renameSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import YAML from 'yaml'
import serviceWorkerConfig from '../playwright.service-worker.config.mjs'

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
const checkout = 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"\ngit rev-parse HEAD\nsha256sum backend/package-lock.json frontend/package-lock.json'
const shardCommand = 'mkdir -p "$RUNNER_TEMP/forge-smoke-receipts"\nnode backend/scripts/run-smoke-suite.js ${{ matrix.arguments }} --receipt "$RUNNER_TEMP/forge-smoke-receipts/${{ matrix.label }}.json"'
const verifierCommand = 'node backend/scripts/verify-smoke-receipts.js --receipts-dir "$RUNNER_TEMP/forge-smoke-receipts"'
const matrix = [...Array.from({ length: 4 }, (_, i) => ({ label: `base-${i}`, arguments: `--ci-shard-index ${i} --ci-shard-count 4` })), { label: 'route-positive', arguments: '--ci-route-positive' }]
const commands = job => job.steps.filter(step => step.run).map(step => step.run.trim())
function validate(value) {
  assert.deepEqual(value.on, { pull_request: null, push: { branches: ['main'] }, workflow_dispatch: null, schedule: [{ cron: '17 */6 * * *' }] })
  assert.deepEqual(value.concurrency, { group: 'forge-qa-${{ github.ref }}', 'cancel-in-progress': true })
  const jobs = value.jobs
  assert.deepEqual(Object.keys(jobs).sort(), ['deterministic-support-qa', 'backend-smoke-qa', 'browser-qa', 'deterministic-and-browser-qa', 'deterministic-qa', 'ios-native-compile', 'production-shell-qa'].sort())
  for (const key of ['browser-qa']) {
    const job = jobs[key]
    assert.equal(job['runs-on'], 'ubuntu-latest')
    assert.equal(job['timeout-minutes'], 45)
    assert.equal(job.needs, undefined, 'expensive suites must run independently')
    assert.equal(job.if, undefined, 'no conditional omission of either suite')
    assert.equal(job.steps[0].uses, 'actions/checkout@v7')
    assert.deepEqual(job.steps[1], { uses: 'actions/setup-node@v7', with: { 'node-version': 22, cache: 'npm', 'cache-dependency-path': 'frontend/package-lock.json\nbackend/package-lock.json\n' } })
    for (const step of job.steps.filter(step => step.run)) assert.equal(step.if, undefined)
  }
  for (const key of ['deterministic-support-qa', 'backend-smoke-qa', 'deterministic-qa']) {
    const job = jobs[key]
    assert.equal(job['runs-on'], 'ubuntu-latest')
    assert.equal(job['timeout-minutes'], 45)
    assert.deepEqual(job.steps[0], { uses: 'actions/checkout@v7', with: { ref: '${{ github.sha }}' } })
    assert.equal(job.steps[1].run.trim(), checkout)
    assert.deepEqual(job.steps[2], { uses: 'actions/setup-node@v7', with: { 'node-version': 22, cache: 'npm', 'cache-dependency-path': 'frontend/package-lock.json\nbackend/package-lock.json\n' } })
    for (const step of job.steps.filter(step => step.run)) assert.equal(step.if, undefined, 'no conditional execution omissions')
    if (key !== 'deterministic-qa') { assert.equal(job.needs, undefined); assert.equal(job.if, undefined) }
  }
  assert.deepEqual(commands(jobs['deterministic-support-qa']), [checkout, install, 'npm --prefix frontend run test:smoke', 'npm --prefix backend run check:account-data', 'npm --prefix frontend audit --audit-level=high\nnpm --prefix backend audit --audit-level=high', 'npm --prefix frontend run build'])
  assert.deepEqual(jobs['backend-smoke-qa'].strategy, { 'fail-fast': false, matrix: { include: matrix } })
  assert.deepEqual(commands(jobs['backend-smoke-qa']), [checkout, install, shardCommand])
  const receiptUpload = jobs['backend-smoke-qa'].steps.at(-1)
  assert.equal(receiptUpload.if, '${{ always() }}')
  assert.equal(receiptUpload.uses, 'actions/upload-artifact@v4')
  assert.deepEqual(receiptUpload.with, { name: 'forge-backend-smoke-${{ matrix.label }}-${{ github.sha }}', path: '${{ runner.temp }}/forge-smoke-receipts/${{ matrix.label }}.json', 'if-no-files-found': 'error', 'retention-days': 7 })
  const deterministic = jobs['deterministic-qa']
  assert.equal(jobs['deterministic-support-qa'].steps.length, 8)
  assert.equal(jobs['backend-smoke-qa'].steps.length, 6)
  assert.equal(deterministic.steps.length, 6)
  assert.equal(deterministic.if, '${{ always() }}')
  assert.deepEqual(deterministic.needs, ['deterministic-support-qa', 'backend-smoke-qa'])
  assert.deepEqual(commands(deterministic), [checkout, install, verifierCommand])
  assert.deepEqual(deterministic.steps[4], { name: 'Download exact backend receipts', uses: 'actions/download-artifact@v4', with: { pattern: 'forge-backend-smoke-*-${{ github.sha }}', path: '${{ runner.temp }}/forge-smoke-receipts', 'merge-multiple': false } })
  assert.equal(deterministic.steps[4].if, undefined)
  assert.deepEqual(deterministic.steps[5].env, { SUPPORT_RESULT: '${{ needs.deterministic-support-qa.result }}', BACKEND_RESULT: '${{ needs.backend-smoke-qa.result }}' })
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
assert.equal(frontendScripts['test:smoke'], 'node scripts/run-smoke-suite.mjs')
assert.equal(frontendScripts['test:e2e'], 'playwright test')
assert.equal(frontendScripts['test:e2e:sw'], 'playwright test --config=playwright.service-worker.config.mjs')
for (const name of ['compact-mobile-320', 'iphone-17']) assert(normalConfig.includes(`name: '${name}'`))
assert(normalConfig.includes('retries: process.env.CI ? 1 : 0'))
assert(normalConfig.includes('forbidOnly: Boolean(process.env.CI)'))
const validateServiceWorkerSuites = config => assert.deepEqual(config.testMatch, ['serviceWorker.spec.mjs', 'pushSetup.spec.mjs'])
validateServiceWorkerSuites(serviceWorkerConfig)
for (const testMatch of [
  ['serviceWorker.spec.mjs'], ['pushSetup.spec.mjs'],
  ['serviceWorker.spec.mjs', 'pushSetup.spec.mjs', 'pushSetup.spec.mjs'],
  ['serviceWorker.spec.mjs', 'pushSetup.spec.mjs', 'extra.spec.mjs'],
]) assert.throws(() => validateServiceWorkerSuites({ ...serviceWorkerConfig, testMatch }))

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
  value => { value.jobs['deterministic-support-qa'].steps[4].run = 'echo skipped' },
  value => { value.jobs['deterministic-support-qa'].steps[5].if = 'false' },
  value => { value.jobs['production-shell-qa'].needs = ['deterministic-qa'] },
  value => { delete value.jobs['deterministic-and-browser-qa'].if },
  value => { value.jobs['browser-qa']['continue-on-error'] = true },
  value => { value.jobs['browser-qa'].needs = 'deterministic-qa' },
  value => { value.jobs['backend-smoke-qa'].strategy['fail-fast'] = true },
  value => { value.jobs['backend-smoke-qa'].strategy.matrix.include.pop() },
  value => { value.jobs['backend-smoke-qa'].steps.at(-1).with['if-no-files-found'] = 'ignore' },
  value => { value.jobs['backend-smoke-qa'].steps.at(-1).if = 'success()' },
  value => { value.jobs['backend-smoke-qa'].steps.at(-1).with.name = 'shared-receipt' },
  value => { value.jobs['deterministic-qa'].needs.pop() },
  value => { delete value.jobs['deterministic-qa'].if },
  value => { value.jobs['deterministic-qa'].steps[5].env.BACKEND_RESULT = 'success' },
  value => { value.jobs['deterministic-qa'].steps[4].with['run-id'] = 'other-run' },
  value => { value.jobs['deterministic-qa'].steps[4].with['merge-multiple'] = true },
  value => { value.jobs['deterministic-support-qa'].steps[0].with.ref = 'main' },
  value => { value.jobs['backend-smoke-qa'].steps[3].run = 'npm --prefix backend ci' },
  value => { value.jobs['deterministic-qa']['timeout-minutes'] = 90 },
]) {
  const changed = structuredClone(workflow); mutate(changed)
  assert.throws(() => validate(changed))
}

const require = createRequire(import.meta.url)
const producer = require('../../backend/scripts/run-smoke-suite.js')
const verifier = require('../../backend/scripts/verify-smoke-receipts.js')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const gitBinary = process.platform === 'darwin' ? '/Library/Developer/CommandLineTools/usr/bin/git' : 'git'
const gitAt = cwd => args => execFileSync(gitBinary, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
const revision = gitAt(repo)(['rev-parse', 'HEAD']).trim()
const context = producer.deriveContext(repo, revision, { git: gitAt(repo) })
const authority = verifier.deriveExpected(repo, revision, { git: gitAt(repo) })
assert.deepEqual(context.full, authority.full)
assert.equal(context.inventory_hash, authority.inventory_hash)
assert.deepEqual(producer.basePlan(producer.discoverFiles(path.join(repo, 'backend'))), authority.base)
const shardOptions = i => producer.parseArgs(['--ci-shard-index', String(i), '--ci-shard-count', '4', '--receipt', 'unused.json'])
const routeOptions = producer.parseArgs(['--ci-route-positive', '--receipt', 'unused.json'])
const assignments = [...Array.from({ length: 4 }, (_, i) => producer.assignment(context, shardOptions(i))), producer.assignment(context, routeOptions)]
assert.equal(new Set(assignments.flat().map(JSON.stringify)).size, context.full.length)
assert.deepEqual(assignments.flat().map(JSON.stringify).sort(), authority.full.map(JSON.stringify).sort())
for (const identity of [['backend/test/racePlanQuality.smoke.js', []], ['backend/test/racePlanQuality.smoke.js', ['--semantic-acceptance']], ['backend/test/adaptiveCoachingCalendar.smoke.js', ['--route-positive']]]) {
  assert.equal(context.full.filter(item => JSON.stringify(item) === JSON.stringify(identity)).length, 1)
}

// Execute the original no-argument algorithm independently in a VM. The only
// substituted boundaries are directory listing, process exit and child launch.
const legacy = `const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test');
const files = readdirSync(testDir).filter(file => file.endsWith('.smoke.js')).sort().concat('concurrentPlan.test.js');
for (const file of files) {
 const argumentSets = file === 'racePlanQuality.smoke.js' ? [[], ['--semantic-acceptance']] : [[]];
 for (const args of argumentSets) {
  console.log('\u005cn[backend smoke] ' + file + (args.length ? ' --semantic-acceptance' : ''));
  const result = spawnSync(process.execPath, [path.join(testDir, file), ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
 }
}
console.log('\u005cnBACKEND SMOKE SUITE OK (' + files.length + ' files)');`
const names = ['z.smoke.js', 'ignored.txt', 'racePlanQuality.smoke.js', 'a.smoke.js']
for (const failure of [null, 0, 1, 2, 4]) for (const failureStatus of [7, null]) {
  const oldCalls = [], newCalls = [], oldLogs = [], newLogs = []
  const executor = calls => (...args) => { calls.push(args); return { status: calls.length - 1 === failure ? failureStatus : 0 } }
  let oldExit = 0
  try {
    vm.runInNewContext(legacy, { __dirname: '/synthetic/backend/scripts', require: name => name === 'node:fs' ? { readdirSync: () => names } : name === 'node:child_process' ? { spawnSync: executor(oldCalls) } : path,
      console: { log: line => oldLogs.push(line) }, process: { execPath: process.execPath, exit: code => { throw { legacyExit: code } } } })
  } catch (error) { if (!Object.hasOwn(error, 'legacyExit')) throw error; oldExit = error.legacyExit }
  const nextExit = producer.runDefault({ backendRoot: '/synthetic/backend', files: names.filter(n => n.endsWith('.smoke.js')).sort().concat('concurrentPlan.test.js'), spawn: executor(newCalls), log: line => newLogs.push(line) })
  assert.equal(nextExit, oldExit)
  assert.deepEqual(JSON.parse(JSON.stringify(newCalls)), JSON.parse(JSON.stringify(oldCalls)))
  assert.deepEqual(newLogs, oldLogs)
}

const badArgs = [
  ['--unknown'], ['--receipt', 'x'], ['--ci-shard-index'], ['--ci-shard-count', '4', '--receipt', 'x'],
  ['--ci-shard-index', '0', '--receipt', 'x'], ['--ci-shard-index', '0', '--ci-shard-count', '4'],
  ...['-1', '4', '00', '+1', '1.0', '1e0', ' 1', 'NaN'].map(i => ['--ci-shard-index', i, '--ci-shard-count', '4', '--receipt', 'x']),
  ...['3', '04', '5', '4.0'].map(n => ['--ci-shard-index', '0', '--ci-shard-count', n, '--receipt', 'x']),
  ['--ci-shard-index', '0', '--ci-shard-count', '4', '--receipt', 'x', '--receipt', 'y'],
  ['--ci-route-positive', '--ci-shard-index', '0', '--ci-shard-count', '4', '--receipt', 'x'],
  ['--ci-route-positive', '--ci-route-positive', '--receipt', 'x'], ['--ci-route-positive', '--receipt', ''],
  ['--ci-route-positive', '--receipt', 'x', '--unknown'], ['--ci-route-positive', '--receipt', 'x', 'trailing']
]
for (const args of badArgs) assert.throws(() => producer.parseArgs(args))
assert.deepEqual(producer.parseArgs([]), { mode: 'local' })

const scratch = mkdtempSync(path.join(tmpdir(), 'forge-ci-contract-'))
try {
  // Actual producer receipt writes, synthetic executor only: no product test,
  // provider, native toolchain or database runs in this contract gate.
  let tick = Date.parse('2026-01-01T00:00:00.000Z')
  const receipts = []
  for (const [i, options] of [...Array.from({ length: 4 }, (_, n) => shardOptions(n)), routeOptions].entries()) {
    const label = i === 4 ? 'route-positive' : `base-${i}`
    const artifact = path.join(scratch, `forge-backend-smoke-${label}-${revision}`); mkdirSync(artifact)
    const receiptPath = path.join(artifact, label + '.json')
    let calls = 0
    assert.equal(producer.runCI(context, { ...options, receipt: receiptPath }, { log() {}, now: () => tick++, spawn(command, args, config) {
      const checkpoint = JSON.parse(readFileSync(receiptPath, 'utf8'))
      assert.equal(checkpoint.executed.length, calls, 'each previous terminal is atomically checkpointed')
      assert.equal(checkpoint.terminal.state, 'RUNNING')
      assert.equal(command, process.execPath); assert.equal(config.cwd, path.join(repo, 'backend')); assert.equal(config.stdio, 'inherit'); assert.equal(config.env, undefined)
      assert.deepEqual(args, [path.join(repo, checkpoint.expected[calls][0]), ...checkpoint.expected[calls][1]])
      calls++; return { status: 0, signal: null }
    } }), 0)
    receipts.push(JSON.parse(readFileSync(receiptPath, 'utf8')))
  }
  const success = { supportResult: 'success', backendResult: 'success' }
  assert.equal(verifier.verifyReceipts(verifier.readReceipts(scratch, revision), authority, success).invocations, authority.full.length)
  for (const supportResult of ['success', 'failure', 'cancelled', 'skipped', undefined]) for (const backendResult of ['success', 'failure', 'cancelled', 'skipped', undefined]) {
    if (supportResult === 'success' && backendResult === 'success') continue
    assert.throws(() => verifier.verifyReceipts(receipts, authority, { supportResult, backendResult }))
  }
  const mutations = [
    r => r.pop(), r => r.push(structuredClone(r[0])), r => { r[1] = structuredClone(r[0]) },
    r => { r[0].extra = true }, r => { delete r[0].inventory_hash }, r => { r[0].schema_version = 'unknown' },
    ...['event_revision', 'checkout_revision', 'backend_lock_sha256', 'frontend_lock_sha256', 'inventory_hash'].map(k => r => { r[0][k] = '0'.repeat(k.includes('revision') ? 40 : 64) }),
    r => { r[0].assignment_algorithm = 'other' }, r => { r[0].shard_count = 3 }, r => { r[0].shard_index = 4 },
    r => { r[0].mode = 'other' }, r => { r[4].shard_index = 0 },
    r => r[0].expected.pop(), r => r[0].expected.push(r[0].expected[0]), r => { r[0].expected[0] = r[1].expected[0] },
    r => { r[0].expected[0] = ['backend/test/not-authorized.smoke.js', []] },
    r => { r[4].expected[0][1] = [] },
    r => { const target = r.find(x => x.expected.some(id => id[1][0] === '--semantic-acceptance')); target.expected.find(id => id[1][0] === '--semantic-acceptance')[1] = [] },
    r => r[0].executed.pop(), r => r[0].executed.push(r[0].executed[0]),
    r => { r[0].executed[0].identity = r[1].expected[0] }, r => r[0].executed.reverse(), r => { r[0].executed[0].ordinal = 1 },
    r => { r[0].executed[0].exit = 7 }, r => { r[0].executed[0].exit = null; r[0].executed[0].signal = 'SIGTERM' },
    r => { r[0].executed[0].signal = 'SIGTERM' }, r => { r[0].executed[0].extra = 1 },
    r => { r[0].executed[0].elapsed_ms = -1 }, r => { r[0].executed[0].started_at = 'not UTC' },
    r => r[0].succeeded.pop(), r => r[0].succeeded.push(r[0].expected[0]), r => { r[0].succeeded[0] = r[1].expected[0] },
    r => { r[0].terminal.state = 'RUNNING' }, r => { r[0].terminal.exit = 1 }, r => { r[0].terminal.extra = true }
  ]
  for (const mutate of mutations) { const copy = structuredClone(receipts); mutate(copy); assert.throws(() => verifier.verifyReceipts(copy, authority, success)) }
  const firstArtifact = path.join(scratch, `forge-backend-smoke-base-0-${revision}`)
  const firstReceipt = path.join(firstArtifact, 'base-0.json'), original = readFileSync(firstReceipt, 'utf8')
  for (const malformed of ['{', original.replace('"schema_version":', '"schema_version":"duplicate", "schema_version":')]) {
    writeFileSync(firstReceipt, malformed); assert.throws(() => verifier.readReceipts(scratch, revision))
  }
  writeFileSync(firstReceipt, original)
  renameSync(firstReceipt, firstReceipt + '.unexpected'); assert.throws(() => verifier.readReceipts(scratch, revision)); renameSync(firstReceipt + '.unexpected', firstReceipt)
  writeFileSync(path.join(firstArtifact, 'extra.json'), '{}'); assert.throws(() => verifier.readReceipts(scratch, revision)); unlinkSync(path.join(firstArtifact, 'extra.json'))
  const extraArtifact = path.join(scratch, `forge-backend-smoke-extra-${revision}`); mkdirSync(extraArtifact); writeFileSync(path.join(extraArtifact, 'base-0.json'), original)
  assert.throws(() => verifier.readReceipts(scratch, revision), 'extra artifact cannot hide by overwriting a matching filename'); rmSync(extraArtifact, { recursive: true })
  renameSync(firstArtifact, firstArtifact + '-wrong-revision'); assert.throws(() => verifier.readReceipts(scratch, revision)); renameSync(firstArtifact + '-wrong-revision', firstArtifact)
  const failureDir = path.join(scratch, 'failed'); mkdirSync(failureDir)
  for (const result of [{ status: 7, signal: null }, { status: null, signal: 'SIGTERM' }, { status: null, signal: null }]) {
    const file = path.join(failureDir, `failure-${readdirSync(failureDir).length}.json`); let calls = 0
    assert.notEqual(producer.runCI(context, { ...shardOptions(0), receipt: file }, { log() {}, spawn() { calls++; return result } }), 0)
    const failed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(calls, 1); assert.equal(failed.executed.length, 1); assert.deepEqual(failed.succeeded, []); assert.equal(failed.terminal.state, 'FAILED')
  }
  for (const receipt of [firstReceipt, path.join(scratch, 'missing-directory/x.json'), path.join(firstReceipt, 'child.json')]) {
    assert.throws(() => producer.runCI(context, { ...routeOptions, receipt }, { spawn() { assert.fail('must reject before launch') } }))
  }

  // Exercise the actual CLI end-to-end in an owned synthetic Git repository.
  const fixture = path.join(scratch, 'fixture'); mkdirSync(fixture)
  for (const dir of ['backend/scripts', 'backend/test', 'frontend']) mkdirSync(path.join(fixture, dir), { recursive: true })
  for (const script of ['run-smoke-suite.js', 'verify-smoke-receipts.js']) writeFileSync(path.join(fixture, 'backend/scripts', script), read(`../../backend/scripts/${script}`))
  for (const lock of ['backend/package-lock.json', 'frontend/package-lock.json']) writeFileSync(path.join(fixture, lock), '{}\n')
  const stub = `require('node:fs').appendFileSync(process.env.SMOKE_TRACE, JSON.stringify([require('node:path').basename(__filename), process.argv.slice(2)])+'\\n'); if(process.env.SMOKE_SIGNAL==='1') process.kill(process.pid,'SIGTERM'); if(process.env.SMOKE_FAIL===require('node:path').basename(__filename)) process.exit(7);\n`
  for (const name of ['a.smoke.js', 'adaptiveCoachingCalendar.smoke.js', 'racePlanQuality.smoke.js', 'concurrentPlan.test.js']) writeFileSync(path.join(fixture, 'backend/test', name), stub)
  const fixtureGit = gitAt(fixture)
  fixtureGit(['init', '-q']); fixtureGit(['add', '.']); fixtureGit(['-c', 'user.name=Forge synthetic CI', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic inventory'])
  const sha = fixtureGit(['rev-parse', 'HEAD']).trim(), out = path.join(fixture, 'receipts'); mkdirSync(out)
  const env = { ...process.env, PATH: path.dirname(gitBinary) + path.delimiter + process.env.PATH, GITHUB_SHA: sha, SMOKE_TRACE: path.join(fixture, 'trace'), SUPPORT_RESULT: 'success', BACKEND_RESULT: 'success' }
  const cli = (script, args, overrides = {}) => spawnSync(process.execPath, [path.join(fixture, 'backend/scripts', script), ...args], { cwd: fixture, env: { ...env, ...overrides }, encoding: 'utf8' })
  for (const entry of matrix) {
    const artifact = path.join(out, `forge-backend-smoke-${entry.label}-${sha}`); mkdirSync(artifact)
    const result = cli('run-smoke-suite.js', [...entry.arguments.split(' '), '--receipt', path.join(artifact, entry.label + '.json')])
    assert.equal(result.status, 0, result.stderr)
  }
  const verified = cli('verify-smoke-receipts.js', ['--receipts-dir', out]); assert.equal(verified.status, 0, verified.stderr)
  assert(verified.stdout.includes('BACKEND SMOKE RECEIPTS VERIFIED'))
  for (const field of ['SUPPORT_RESULT', 'BACKEND_RESULT']) for (const status of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(cli('verify-smoke-receipts.js', ['--receipts-dir', out], { [field]: status }).status, 0)
  }
  for (const args of [[], ['--receipts-dir'], ['--unknown', out], ['--receipts-dir', out, '--receipts-dir', out]]) assert.notEqual(cli('verify-smoke-receipts.js', args).status, 0)
  const fixtureAuthority = verifier.deriveExpected(fixture, sha, { git: fixtureGit })
  assert.equal(readFileSync(env.SMOKE_TRACE, 'utf8').trim().split('\n').length, fixtureAuthority.full.length)
  const defaultCLI = cli('run-smoke-suite.js', [])
  assert.equal(defaultCLI.status, 0, defaultCLI.stderr)
  assert(defaultCLI.stdout.includes(`BACKEND SMOKE SUITE OK (${producer.discoverFiles(path.join(fixture, 'backend')).length} files)`))
  assert.equal(readFileSync(env.SMOKE_TRACE, 'utf8').trim().split('\n').length, fixtureAuthority.full.length + fixtureAuthority.base.length)
  const traceBefore = readFileSync(env.SMOKE_TRACE, 'utf8')
  for (const args of badArgs) assert.notEqual(cli('run-smoke-suite.js', args).status, 0)
  assert.notEqual(cli('run-smoke-suite.js', ['--ci-route-positive', '--receipt', path.join(fixture, 'no-dir/x')]).status, 0)
  assert.notEqual(cli('run-smoke-suite.js', ['--ci-route-positive', '--receipt', path.join(fixture, 'bad-sha.json')], { GITHUB_SHA: '0'.repeat(40) }).status, 0)
  assert.equal(readFileSync(env.SMOKE_TRACE, 'utf8'), traceBefore, 'all malformed CLI cases launch zero children')
  const fail = cli('run-smoke-suite.js', ['--ci-route-positive', '--receipt', path.join(fixture, 'failed.json')], { SMOKE_FAIL: 'adaptiveCoachingCalendar.smoke.js' })
  assert.equal(fail.status, 7); assert.equal(JSON.parse(readFileSync(path.join(fixture, 'failed.json'))).terminal.state, 'FAILED')
  const partial = cli('run-smoke-suite.js', ['--ci-shard-index', '0', '--ci-shard-count', '4', '--receipt', path.join(fixture, 'partial.json')], { SMOKE_FAIL: 'concurrentPlan.test.js' })
  assert.equal(partial.status, 7)
  const partialReceipt = JSON.parse(readFileSync(path.join(fixture, 'partial.json')))
  assert.deepEqual(partialReceipt.executed.map(row => row.exit), [0, 7]); assert.equal(partialReceipt.succeeded.length, 1); assert.equal(partialReceipt.terminal.state, 'FAILED')
  const signalled = cli('run-smoke-suite.js', ['--ci-route-positive', '--receipt', path.join(fixture, 'signal.json')], { SMOKE_SIGNAL: '1' })
  assert.equal(signalled.status, 1)
  const signalReceipt = JSON.parse(readFileSync(path.join(fixture, 'signal.json')))
  assert.equal(signalReceipt.executed[0].exit, null); assert.equal(signalReceipt.executed[0].signal, 'SIGTERM'); assert.deepEqual(signalReceipt.succeeded, [])
  for (const derive of [producer.deriveContext, verifier.deriveExpected]) {
    const untracked = path.join(fixture, 'backend/test/untracked.smoke.js'); writeFileSync(untracked, stub)
    assert.throws(() => derive(fixture, sha, { git: fixtureGit })); unlinkSync(untracked)
    for (const name of ['a.smoke.js', 'adaptiveCoachingCalendar.smoke.js', 'concurrentPlan.test.js', 'racePlanQuality.smoke.js']) {
      const target = path.join(fixture, 'backend/test', name); renameSync(target, target + '.held')
      assert.throws(() => derive(fixture, sha, { git: fixtureGit })); renameSync(target + '.held', target)
    }
    const target = path.join(fixture, 'backend/test/a.smoke.js'); renameSync(target, target + '.held'); symlinkSync(target + '.held', target)
    assert.throws(() => derive(fixture, sha, { git: fixtureGit })); unlinkSync(target); renameSync(target + '.held', target)
  }
  writeFileSync(path.join(fixture, 'backend/test/new.smoke.js'), stub); fixtureGit(['add', 'backend/test/new.smoke.js']); fixtureGit(['-c', 'user.name=Forge synthetic CI', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'New tracked invocation'])
  const newSha = fixtureGit(['rev-parse', 'HEAD']).trim(), newer = producer.deriveContext(fixture, newSha, { git: fixtureGit }), newerExpected = verifier.deriveExpected(fixture, newSha, { git: fixtureGit })
  assert.equal(newer.full.length, fixtureAuthority.full.length + 1); assert.notEqual(newer.inventory_hash, fixtureAuthority.inventory_hash); assert.deepEqual(newer.full, newerExpected.full)
  assert.throws(() => verifier.verifyReceipts(verifier.readReceipts(out, sha), newerExpected, success))
  console.log(`CI RECEIPTS GATE OK: ${authority.full.length} dynamically derived identities sha256:${authority.inventory_hash}; ${mutations.length} malformed receipt mutations; ${badArgs.length} malformed argument cases; synthetic actual CLI, tracking, atomic checkpoints and default equivalence`)
} finally {
  // The directory is created by this invocation and contains only synthetic data.
  rmSync(scratch, { recursive: true, force: true })
}
console.log('CI WORKFLOW GATE OK: isolated four-shard plus route-positive union; support/lock/revision/fail-closed dependencies; unchanged native/browser/product contracts')
