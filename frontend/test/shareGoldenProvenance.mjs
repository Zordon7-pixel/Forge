// C1 provenance extended to C1+C2. Generation receipts are never acceptance locks.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const repo = fileURLToPath(new URL('../../', import.meta.url))
export const goldenRoot = join(repo, 'frontend/test/goldens/share-c1')
export const runnerPath = 'frontend/test/shareOverlaysC1.smoke.mjs'
export const lockPath = join(goldenRoot, 'acceptance-v2.json')
export const pinPath = join(goldenRoot, 'acceptance-v2.sha256')
export const ids = ['iron-chips', 'strike-pr', 'hybrid-split', 'trace', 'forged-days', 'full-bleed-story']
export const matrix = ids.flatMap(id => ['light', 'dark', 'color'].flatMap(theme => ['feed', 'story'].map(size =>
  ({ id, theme, size, name: `${id}-${theme}-${size}.png`, width: 1080, height: size === 'story' ? 1920 : 1350 }))))
export const directories = { 'darwin-arm64': '.', 'linux-x64': 'linux-x64-chromium-151-no-hint' }
export const sourcePaths = [
  'frontend/src/lib/shareOverlaysC1.js', 'frontend/src/lib/shareOverlaysC2.js',
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
  let mode = 'compare', selected = matrix, batch = null, candidate = null
  if (args.length === 1 && ['--smoke', '--filter-only'].includes(args[0])) mode = args[0].slice(2)
  else if (args.length === 1 && /^--compare=(c1|c2)$/.test(args[0])) selected = matrix.slice(args[0] === '--compare=c1' ? 0 : 18, args[0] === '--compare=c1' ? 18 : 36)
  else if (args.length === 2 && /^--update-batch=[1-4]$/.test(args[0]) && args[1] === `--platform=${key}`) {
    mode = 'update'; batch = Number(args[0].split('=')[1]); selected = matrix.slice((batch - 1) * 9, batch * 9)
  } else if (args.length === 1 && args[0].startsWith('--candidate=') && args[0].length > 12) {
    mode = 'candidate'; candidate = args[0].slice(12)
  } else assert.equal(args.length, 0, 'Invalid filter/batch/platform: use --smoke, --filter-only, --compare=c1|c2, --update-batch=1..4 --platform=<actual OS-arch>, or --candidate=<external path>')
  assert.ok(!['update', 'candidate'].includes(mode) || (!env.CI && !env.GITHUB_ACTIONS), 'Golden updates/candidate assembly forbidden in CI')
  return { mode, selected, batch, candidate, key }
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
  assert.equal(lock.schema, 'share-goldens-v2')
  assert.ok(['pending', 'complete'].includes(lock.state), 'Invalid lock state')
  keys(lock.platforms, Object.keys(directories), 'Both canonical platforms required')
  return lock
}
export function validateProvenance(lock, runtime, read = readFileSync) {
  assert.deepEqual(runtime, lock.runtime, 'Browser/Playwright/launch provenance mismatch')
  assert.deepEqual(fingerprints(read), lock.fingerprints, 'Source/font/fixture/render provenance mismatch')
}
export function pngRecord(item, png) {
  assert.ok(png.length >= 26 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && png.toString('ascii', 12, 16) === 'IHDR', `Invalid PNG: ${item.name}`)
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [item.width, item.height], `PNG dimensions: ${item.name}`)
  assert.equal(png[25], 6, `PNG must retain RGBA: ${item.name}`)
  return { name: item.name, width: item.width, height: item.height, sha256: sha256(png) }
}
export const receiptPath = key => join(goldenRoot, directories[key], 'generation-v2.json')
export function newReceipt(lock, key, runtime) {
  assert.ok(Object.hasOwn(directories, key), 'Wrong receipt platform')
  assert.deepEqual(runtime, lock.runtime, 'Receipt runtime mismatch')
  return { schema: 'share-generation-v2', platform: key, directory: directories[key], runtime, fingerprints: lock.fingerprints, batches: {} }
}
export function validateReceipt(receipt, lock, key, complete = false, read = readFileSync, list = readdirSync) {
  keys(receipt, ['schema', 'platform', 'directory', 'runtime', 'fingerprints', 'batches'], 'Receipt fields')
  assert.equal(receipt.schema, 'share-generation-v2')
  assert.equal(receipt.platform, key, 'Wrong receipt platform')
  assert.equal(receipt.directory, directories[key], 'Wrong platform directory')
  assert.deepEqual(receipt.runtime, lock.runtime, 'Receipt runtime mismatch')
  assert.deepEqual(receipt.fingerprints, lock.fingerprints, 'Receipt source/font/fixture/render mismatch')
  const batches = Object.keys(receipt.batches).sort()
  assert.ok(batches.every(batch => /^[1-4]$/.test(batch)), 'Invalid receipt batch')
  if (complete) assert.deepEqual(batches, ['1', '2', '3', '4'], 'Incomplete generation receipt')
  const dir = join(goldenRoot, directories[key]), bytes = new Map()
  for (const batch of batches) {
    const expected = matrix.slice((Number(batch) - 1) * 9, Number(batch) * 9), files = receipt.batches[batch]
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
