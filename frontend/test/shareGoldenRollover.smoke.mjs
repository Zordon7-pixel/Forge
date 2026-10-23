// Offline namespace regression. Only temporary lock/pin fixtures are written;
// no renderer, repository preparation, PNG or generation-receipt writer runs.
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { repo, goldenRoot, lockPath, pinPath, directories, sourcePaths, matrix, batches,
  sha256, readLock, fingerprints, validateProvenance, validateBaselines, validateReceipt,
  assembleCandidate, receiptPath } from './shareGoldenProvenance.mjs'

const historicalDirectories = { 'darwin-arm64': '.', 'linux-x64': 'linux-x64-chromium-151-no-hint' }
const historicalFiles = [
  'acceptance-v2.json', 'acceptance-v2.sha256', 'acceptance-v3.json', 'acceptance-v3.sha256',
  'linux-diagnosis.json', 'LINUX-DIAGNOSIS.txt',
  ...Object.values(historicalDirectories).flatMap(dir =>
    ['generation-v2.json', 'generation-v3.json', ...matrix.map(item => item.name)].map(name => join(dir, name))),
].sort()
const snapshot = root => Object.fromEntries(historicalFiles.map(path => [path, sha256(readFileSync(join(root, path)))]))
const before = snapshot(goldenRoot)
assert.equal(historicalFiles.length, 154)
// Frozen digest of the 154 historical files at 563134bf53bc216a203a8f82ba1dd0bdb5d0a722.
assert.equal(sha256(JSON.stringify(before)), '645239a70eee260705a782dd34961f0da3080215bc0f00fe0e0c73524711fb87', 'Historical evidence changed')
const oldBytes = readFileSync(join(goldenRoot, 'acceptance-v3.json'))
const oldPin = readFileSync(join(goldenRoot, 'acceptance-v3.sha256'), 'utf8').trim()
assert.equal(sha256(oldBytes), oldPin)
const old = JSON.parse(oldBytes)
assert.equal(old.state, 'complete')
assert.equal(old.schema, 'share-goldens-v3')
assert.throws(() => readLock(path => path === lockPath ? oldBytes : oldPin), /share-goldens-v4/)
assert.throws(() => validateProvenance(old, old.runtime), /Historical lock/)
assert.throws(() => validateBaselines(old), /Historical lock/)
assert.throws(() => assembleCandidate(old), /Historical lock/)

const current = readLock()
validateProvenance(current, current.runtime)
assert.equal(relative(goldenRoot, lockPath), 'acceptance-v4.json')
assert.equal(relative(goldenRoot, pinPath), 'acceptance-v4.sha256')
assert.deepEqual(directories, { 'darwin-arm64': 'v4/darwin-arm64', 'linux-x64': 'v4/linux-x64-chromium-151-no-hint' })
for (const [key, dir] of Object.entries(historicalDirectories)) {
  const receipt = JSON.parse(readFileSync(join(goldenRoot, dir, 'generation-v3.json'), 'utf8'))
  assert.deepEqual(receipt, old.platforms[key], 'Historical complete receipt remains inspectable')
  assert.deepEqual(Object.keys(receipt.batches).sort(), Object.keys(batches).sort())
  assert.equal(Object.values(receipt.batches).flat().length, 72)
  for (const record of Object.values(receipt.batches).flat()) {
    assert.equal(sha256(readFileSync(join(goldenRoot, dir, record.name))), record.sha256)
  }
  assert.equal(receiptPath(key), join(goldenRoot, directories[key], 'generation-v4.json'))
  assert.throws(() => validateReceipt(receipt, current, key, true), /share-generation-v4/)
  assert.throws(() => validateReceipt({ ...receipt, schema: 'share-generation-v4' }, current, key, true), /Wrong platform directory/)
}

const scratch = mkdtempSync(join(tmpdir(), 'forge-share-rollover-'))
try {
  const scratchGoldens = join(scratch, relative(repo, goldenRoot))
  // Copy immutable input bytes; never create synthetic PNGs or generation receipts.
  for (const path of [...sourcePaths, ...historicalFiles.map(path => relative(repo, join(goldenRoot, path)))]) {
    const target = join(scratch, path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(repo, path), target)
  }
  const scratchLock = join(scratch, relative(repo, lockPath)), scratchPin = join(scratch, relative(repo, pinPath))
  const tree = root => readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile()).map(item => relative(root, join(item.parentPath, item.name))).sort()
  const initialTree = tree(scratch)
  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, ['frontend/test/shareGoldenProvenance.mjs', ...args], {
      cwd: scratch, env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env }, encoding: 'utf8',
    })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  }
  const prepared = run(['--prepare'])
  assert.equal(prepared.status, 0, prepared.output)
  assert.match(prepared.output, /Generated pending lock/)
  const bytes = readFileSync(scratchLock), pin = readFileSync(scratchPin)
  assert.equal(sha256(bytes), pin.toString().trim())
  const pending = JSON.parse(bytes)
  assert.equal(pending.schema, 'share-goldens-v4')
  assert.equal(pending.state, 'pending')
  assert.deepEqual(pending.platforms, { 'darwin-arm64': null, 'linux-x64': null })
  assert.deepEqual(pending.fingerprints, fingerprints())
  assert.deepEqual(pending.runtime, old.runtime)
  assert.deepEqual(tree(scratch), [...initialTree, relative(repo, lockPath), relative(repo, pinPath)].sort(), 'Preparation writes only the new lock/pin')
  assert.deepEqual(snapshot(scratchGoldens), before, 'Actual preparation must not overwrite history')
  for (const key of Object.keys(directories)) assert.equal(existsSync(receiptPath(key, scratchGoldens)), false)
  assert.throws(() => validateBaselines(pending), /Canonical baselines pending/)
  assert.throws(() => assembleCandidate(pending, (path, ...args) => {
    if (Object.keys(directories).some(key => path === receiptPath(key))) {
      return readFileSync(join(goldenRoot, historicalDirectories[path.includes('linux-x64') ? 'linux-x64' : 'darwin-arm64'], 'generation-v3.json'))
    }
    return readFileSync(path, ...args)
  }), /share-generation-v4/, 'Historical receipts cannot assemble current acceptance')
  const aggregate = run([])
  assert.equal(aggregate.status, 1, aggregate.output)
  assert.match(aggregate.output, /Canonical baselines pending: generation is not acceptance/)
  assert.equal(run(['--prepare']).status, 0, 'Pending preparation is deterministic before any receipts exist')
  assert.deepEqual(readFileSync(scratchLock), bytes)
  assert.deepEqual(readFileSync(scratchPin), pin)
  for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    const refused = run(['--prepare'], env)
    assert.equal(refused.status, 1, refused.output)
    assert.match(refused.output, /Lock mutation forbidden in CI/)
    assert.deepEqual(readFileSync(scratchLock), bytes)
    assert.deepEqual(readFileSync(scratchPin), pin)
  }
  // Synthetic lock only: prove the completed-current-generation guard survives rollover.
  const complete = JSON.stringify({ ...pending, state: 'complete' })
  writeFileSync(scratchLock, complete)
  writeFileSync(scratchPin, sha256(complete) + '\n')
  const refused = run(['--prepare'])
  assert.equal(refused.status, 1, refused.output)
  assert.match(refused.output, /Cannot replace complete acceptance with preparation/)
  assert.equal(readFileSync(scratchLock, 'utf8'), complete)
  assert.equal(readFileSync(scratchPin, 'utf8'), sha256(complete) + '\n')
  assert.deepEqual(snapshot(scratchGoldens), before)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
assert.deepEqual(snapshot(goldenRoot), before, 'Repository history remains byte-identical')
console.log('PASS rollover: 154 immutable historical files / 144 PNGs; actual prepare adds only pending v4 lock/pin; historical acceptance, receipts, CI writes and completed-lock replacement rejected; aggregate expected RED')
