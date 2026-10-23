// Release provenance: C1 + Full-Bleed + Trace + every Forged Days layout. Generation receipts are never acceptance locks.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve, relative, isAbsolute } from 'node:path'

export const repo = fileURLToPath(new URL('../../', import.meta.url))
export const goldenRoot = join(repo, 'frontend/test/goldens/share-c1')
export const runnerPath = 'frontend/test/shareOverlaysC1.smoke.mjs'
export const lockPath = join(goldenRoot, 'acceptance-v4.json')
export const pinPath = join(goldenRoot, 'acceptance-v4.sha256')
export const ids = ['iron-chips', 'strike-pr', 'hybrid-split', 'full-bleed-story', 'trace', 'forged-days']
const variants = ['run-on', 'run-off', 'lift-on', 'lift-off']
const legacyMatrix = [
  ...ids.slice(0, 3).flatMap(id => ['light', 'dark', 'color'].flatMap(theme => ['feed', 'story'].map(size =>
    ({ id, theme, size, fixture: id, showRoute: false, name: `${id}-${theme}-${size}.png`, width: 1080, height: size === 'story' ? 1920 : 1350 })))),
  ...variants.flatMap(variant => ['light', 'dark', 'color'].flatMap(theme => ['feed', 'story'].map(size =>
    ({ id: 'full-bleed-story', theme, size, fixture: variant.startsWith('run') ? 'photo-run' : 'photo-lift', showRoute: variant.endsWith('-on'),
      name: `full-bleed-story-${variant}-${theme}-${size}.png`, width: 1080, height: size === 'story' ? 1920 : 1350 })))),
]
// Preserve every historical C1/Full-Bleed filename and the five original batches.
export const c2Layouts = ['week', 'month', 'milestone', 'count']
const c2Cases = (id, layout) => ['light', 'dark', 'color'].flatMap(theme => ['feed', 'story'].map(size =>
  ({ id, theme, size, fixture: layout === 'count' ? 'streak-count' : id, showRoute: id === 'trace',
    ...(layout ? { layout } : {}), name: `${id}${layout ? `-${layout}` : ''}-${theme}-${size}.png`,
    width: 1080, height: size === 'story' ? 1920 : 1350 })))
export const batches = Object.fromEntries([
  ...Array.from({ length: 5 }, (_, i) => [String(i + 1), legacyMatrix.slice(i * 9, (i + 1) * 9)]),
  ['trace', c2Cases('trace')],
  ...c2Layouts.map(layout => [`forged-days-${layout}`, c2Cases('forged-days', layout)]),
])
export const matrix = Object.values(batches).flat()
export const batchCount = Object.keys(batches).length
export function selectBatch(batch) {
  assert.ok(Object.hasOwn(batches, batch), 'Invalid filter/batch: use 1..5, trace, or forged-days-week|month|milestone|count')
  const selected = batches[batch]
  assert.ok(selected.length > 0 && selected.length + 1 <= 10, 'Batch exceeds ten paths including receipt')
  return selected
}
// Separate PNG directories keep every completed v2/v3 artifact immutable.
export const directories = { 'darwin-arm64': 'v4/darwin-arm64', 'linux-x64': 'v4/linux-x64-chromium-151-no-hint' }
export const sourcePaths = [
  'frontend/src/lib/shareOverlaysC1.js', 'frontend/src/lib/shareFullBleed.js',
  'frontend/src/lib/shareOverlaysC2.js', 'frontend/test/shareOverlaysC2.smoke.mjs',
  'frontend/src/lib/shareTheme.js', 'frontend/src/lib/shareTemplates.js',
  'frontend/src/lib/shareStats.js', 'frontend/src/lib/shareStudioModel.js',
  'frontend/src/components/ActivityShareStudio.jsx', 'frontend/public/icon-192.png',
  'frontend/package-lock.json', '.github/workflows/forge-qa.yml',
  ...['Anton-Regular', 'BarlowCondensed-ExtraBold', 'BarlowCondensed-SemiBold', 'JetBrainsMono']
    .map(name => `frontend/src/assets/share-fonts/${name}.ttf`),
  runnerPath, 'frontend/test/shareGoldenProvenance.mjs',
]
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const keys = (value, expected, label) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label)
const names = files => files.map(file => file.name).sort()
export function selectBaseline(platform, arch) {
  const key = `${platform}-${arch}`
  assert.ok(Object.hasOwn(directories, key), `Unsupported share platform: ${key}`)
  return key
}
export function parseOptions(args, env = process.env, platform = process.platform, arch = process.arch) {
  const key = selectBaseline(platform, arch)
  let mode = 'compare', selected = matrix, batch = null, candidate = null, output = null
  if (args.length === 1 && ['--smoke', '--filter-only'].includes(args[0])) mode = args[0].slice(2)
  else if (args.length === 1 && /^--compare=(c1|photo|c2)$/.test(args[0])) selected = args[0] === '--compare=c1' ? matrix.slice(0, 18) : args[0] === '--compare=photo' ? matrix.slice(18, 42) : matrix.slice(42)
  else if (args.length === 2 && args[0].startsWith('--update-batch=') && args[1] === `--platform=${key}`) {
    mode = 'update'; batch = args[0].slice(args[0].indexOf('=') + 1); selected = selectBatch(batch)
  } else if (args.length === 3 && args[0].startsWith('--capture-batch=') && args[1] === `--platform=${key}` && args[2].startsWith('--output=')) {
    mode = 'capture'; batch = args[0].slice(args[0].indexOf('=') + 1); selected = selectBatch(batch)
    output = args[2].slice(9)
    assert.ok(isAbsolute(output) && relative(repo, resolve(output)).startsWith('../'), 'Capture output must be outside repository')
  } else if (args.length === 1 && args[0].startsWith('--candidate=') && args[0].length > 12) {
    mode = 'candidate'; candidate = args[0].slice(12)
  } else assert.equal(args.length, 0, 'Invalid filter/batch/platform: use --smoke, --filter-only, --compare=c1|photo|c2, --update-batch=<batch> --platform=<actual OS-arch>, or --candidate=<external path>')
  assert.ok(!['update', 'candidate'].includes(mode) || (!env.CI && !env.GITHUB_ACTIONS), 'Golden updates/candidate assembly forbidden in CI')
  return { mode, selected, batch, candidate, output, key }
}
export function fingerprints(read = readFileSync) {
  const source = read(join(repo, runnerPath), 'utf8').toString()
  const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length)
    assert.ok(a >= 0 && b > a, 'Missing fingerprint section')
    return sha256(source.slice(a, b))
  }
  return {
    sources: Object.fromEntries(sourcePaths.map(path => [path, sha256(read(join(repo, path)))])),
    fixtureSourceSha256: section('const prefs =', 'const entryFor ='),
    renderSourceSha256: section('\n  await page.evaluate(async () => {', '\n  const render ='),
  }
}
export function readLock(read = readFileSync) {
  const bytes = read(lockPath), pin = read(pinPath, 'utf8').toString().trim()
  assert.match(pin, /^[a-f0-9]{64}$/, 'Invalid acceptance pin')
  assert.equal(sha256(bytes), pin, 'Unapproved share provenance digest')
  const lock = JSON.parse(bytes)
  keys(lock, ['schema', 'state', 'runtime', 'fingerprints', 'platforms'], 'Lock fields')
  assert.equal(lock.schema, 'share-goldens-v4')
  assert.ok(['pending', 'complete'].includes(lock.state), 'Invalid lock state')
  keys(lock.platforms, Object.keys(directories), 'Both canonical platforms required')
  return lock
}
export function validateProvenance(lock, runtime, read = readFileSync) {
  assert.equal(lock.schema, 'share-goldens-v4', 'Historical lock is not current acceptance')
  assert.deepEqual(runtime, lock.runtime, 'Browser/Playwright/launch provenance mismatch')
  assert.deepEqual(fingerprints(read), lock.fingerprints, 'Source/font/fixture/render provenance mismatch')
}
export function pngRecord(item, png) {
  assert.ok(png.length >= 26 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && png.toString('ascii', 12, 16) === 'IHDR', `Invalid PNG: ${item.name}`)
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [item.width, item.height], `PNG dimensions: ${item.name}`)
  assert.equal(png[25], 6, `PNG must retain RGBA: ${item.name}`)
  return { name: item.name, width: item.width, height: item.height, sha256: sha256(png) }
}
export const receiptPath = (key, base = goldenRoot) => join(base, directories[key], 'generation-v4.json')
export function newReceipt(lock, key, runtime) {
  assert.ok(Object.hasOwn(directories, key), 'Wrong receipt platform')
  assert.deepEqual(runtime, lock.runtime, 'Receipt runtime mismatch')
  return { schema: 'share-generation-v4', platform: key, directory: directories[key], runtime, fingerprints: lock.fingerprints, host: { platform: process.platform, arch: process.arch, node: process.version }, batches: {} }
}
export function validateReceipt(receipt, lock, key, complete = false, read = readFileSync, list = readdirSync, base = goldenRoot) {
  keys(receipt, ['schema', 'platform', 'directory', 'runtime', 'fingerprints', 'host', 'batches'], 'Receipt fields')
  assert.equal(receipt.schema, 'share-generation-v4')
  assert.equal(receipt.platform, key, 'Wrong receipt platform')
  keys(receipt.host, ['platform', 'arch', 'node'], 'Host fields')
  assert.equal(`${receipt.host.platform}-${receipt.host.arch}`, key, 'Wrong actual capture host')
  assert.match(receipt.host.node, /^v[0-9]+\.[0-9]+\.[0-9]+$/, 'Missing Node provenance')
  assert.equal(receipt.directory, directories[key], 'Wrong platform directory')
  assert.deepEqual(receipt.runtime, lock.runtime, 'Receipt runtime mismatch')
  assert.deepEqual(receipt.fingerprints, lock.fingerprints, 'Receipt source/font/fixture/render mismatch')
  const globalBatches = batches
  const recorded = Object.keys(receipt.batches).sort()
  assert.ok(recorded.every(batch => Object.hasOwn(globalBatches, batch)), 'Invalid receipt batch')
  if (complete) assert.deepEqual(recorded, Object.keys(globalBatches).sort(), 'Incomplete generation receipt')
  const dir = join(base, directories[key]), bytes = new Map()
  for (const batch of recorded) {
    const expected = selectBatch(batch), files = receipt.batches[batch]
    assert.deepEqual(names(files), names(expected), 'Incomplete/extra/duplicate batch files')
    for (const item of expected) {
      const png = read(join(dir, item.name)), record = files.find(file => file.name === item.name)
      assert.deepEqual(record, pngRecord(item, png), `Baseline hash/dimensions: ${key}/${item.name}`)
      bytes.set(item.name, png)
    }
  }
  if (complete) assert.deepEqual(list(dir).filter(name => name.toLowerCase().endsWith('.png')).sort(), names(matrix), 'Incomplete/extra baseline directory')
  return bytes
}
export function validateBaselines(lock, read = readFileSync, list = readdirSync) {
  assert.equal(lock.schema, 'share-goldens-v4', 'Historical lock is not current acceptance')
  keys(lock.platforms, Object.keys(directories), 'Both canonical platforms required')
  assert.equal(lock.state, 'complete', 'Canonical baselines pending: generation is not acceptance')
  return Object.fromEntries(Object.keys(directories).map(key => [key, validateReceipt(lock.platforms[key], lock, key, true, read, list)]))
}
export function assembleCandidate(lock, read = readFileSync, list = readdirSync) {
  validateProvenance(lock, lock.runtime, read)
  const candidate = { ...lock, state: 'complete', platforms: Object.fromEntries(Object.keys(directories).map(key =>
    [key, JSON.parse(read(receiptPath(key), 'utf8'))])) }
  validateBaselines(candidate, read, list)
  return candidate
}

// Explicit generator commands only; importing this module never writes a lock.
// Preparation fingerprints changed source but deliberately approves ZERO images.
if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])) {
  const { writeFileSync, existsSync } = await import('node:fs')
  const args = process.argv.slice(2)
  // Read-only CLI is the aggregate provenance gate, including in CI.
  if (args.length === 0) {
    selectBaseline(process.platform, process.arch)
    const current = readLock()
    validateProvenance(current, current.runtime)
    validateBaselines(current)
    console.log(`PASS share provenance: ${matrix.length} cases on both canonical platforms`)
    process.exit(0)
  }
  assert.ok(!process.env.CI && !process.env.GITHUB_ACTIONS, 'Lock mutation forbidden in CI')
  let lock
  if (args.length === 1 && args[0] === '--prepare') {
    if (existsSync(lockPath) || existsSync(pinPath)) {
      assert.equal(readLock().state, 'pending', 'Cannot replace complete acceptance with preparation')
    }
    for (const key of Object.keys(directories)) assert.ok(!existsSync(receiptPath(key)), 'Existing generation evidence must be reconciled before preparation')
    const runtime = JSON.parse(readFileSync(join(goldenRoot, 'linux-diagnosis.json'), 'utf8')).acceptance.runtime
    lock = { schema: 'share-goldens-v4', state: 'pending', runtime, fingerprints: fingerprints(),
      platforms: Object.fromEntries(Object.keys(directories).map(key => [key, null])) }
  } else if (args.length === 3 && args[0].startsWith('--import-batch=') && args[1].startsWith('--platform=') && args[2].startsWith('--input=')) {
    const batch = args[0].slice('--import-batch='.length), key = args[1].slice(11), input = args[2].slice(8)
    assert.ok(Object.hasOwn(directories, key), 'Unsupported import platform')
    selectBatch(batch)
    const { execFileSync } = await import('node:child_process')
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }).trim(), '', 'Import requires a clean serialized checkpoint')
    const current = readLock()
    validateProvenance(current, current.runtime)
    const captured = JSON.parse(readFileSync(receiptPath(key, input), 'utf8'))
    const bytes = validateReceipt(captured, current, key, true, readFileSync, readdirSync, input)
    const selected = selectBatch(batch)
    const prior = existsSync(receiptPath(key)) ? JSON.parse(readFileSync(receiptPath(key), 'utf8')) : { ...captured, batches: {} }
    validateReceipt(prior, current, key)
    assert.ok(!Object.hasOwn(prior.batches, String(batch)), 'Import batch already recorded')
    assert.deepEqual(prior.host, captured.host, 'Mixed capture hosts')
    prior.batches[batch] = captured.batches[batch]
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(goldenRoot, directories[key]), { recursive: true })
    for (const item of selected) writeFileSync(join(goldenRoot, directories[key], item.name), bytes.get(item.name))
    writeFileSync(receiptPath(key), JSON.stringify(prior, null, 2) + '\n')
    validateReceipt(prior, current, key)
    console.log(`Imported verified ${key} batch ${batch}: ${selected.length} PNGs + receipt; acceptance unchanged`)
    process.exit(0)
  } else if (args.length === 1 && args[0].startsWith('--pin-candidate=')) {
    const candidate = JSON.parse(readFileSync(args[0].slice('--pin-candidate='.length), 'utf8'))
    const current = readLock()
    assert.deepEqual(candidate, assembleCandidate(current), 'Candidate differs from actual complete generation receipts')
    lock = candidate
  } else throw new Error('Use --prepare (new pending lock only) or --pin-candidate=<reviewed candidate path>')
  const bytes = JSON.stringify(lock, null, 2) + '\n'
  writeFileSync(lockPath, bytes)
  writeFileSync(pinPath, sha256(bytes) + '\n')
  console.log(`Generated ${lock.state} lock and SHA256 pin; no pixel/review acceptance claimed`)
}
