// Offline fail-closed contracts; discovered by the existing smoke-suite runner/CI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { matrix, batches, c2Layouts, selectBatch, ids, directories, repo, goldenRoot, sourcePaths, runnerPath, lockPath, pinPath,
  parseOptions, selectBaseline, fingerprints, readLock, validateProvenance, pngRecord,
  newReceipt, receiptPath, validateReceipt, validateBaselines, assembleCandidate, sha256 } from './shareGoldenProvenance.mjs'
let rejected = 0
const rejects = (label, work, pattern) => { assert.throws(work, pattern, label); rejected++; console.log(`REJECT ${label}`) }
assert.deepEqual(ids, ['iron-chips', 'strike-pr', 'hybrid-split', 'full-bleed-story', 'trace', 'forged-days'])
assert.equal(matrix.length, 72)
assert.deepEqual(matrix.slice(0, 18).map(item => item.name), ids.slice(0, 3).flatMap(id => ['light', 'dark', 'color'].flatMap(theme => ['feed', 'story'].map(size => `${id}-${theme}-${size}.png`))))
for (const fixture of ['photo-run', 'photo-lift']) for (const showRoute of [true, false]) {
  assert.equal(matrix.filter(item => item.fixture === fixture && item.showRoute === showRoute).length, 6)
}
assert.equal(new Set(matrix.map(item => item.name)).size, 72)
assert.deepEqual(Object.keys(batches), ['1', '2', '3', '4', '5', 'trace', ...c2Layouts.map(layout => `forged-days-${layout}`)])
assert.deepEqual(c2Layouts, ['week', 'month', 'milestone', 'count'])
// Bind legacy case order/names/dimensions to both preserved historical receipts.
for (const key of Object.keys(directories)) {
  const old = JSON.parse(readFileSync(join(goldenRoot, directories[key], 'generation-v2.json'), 'utf8'))
  for (const batch of ['1', '2', '3', '4', '5']) assert.deepEqual(
    batches[batch].map(({ name, width, height }) => ({ name, width, height })),
    old.batches[batch].map(({ name, width, height }) => ({ name, width, height })))
}
for (const batch of ['trace', ...c2Layouts.map(layout => `forged-days-${layout}`)]) {
  const selected = selectBatch(batch)
  assert.equal(selected.length, 6)
  assert.deepEqual(selected.map(item => [item.theme, item.size]), ['light', 'dark', 'color'].flatMap(theme => ['feed', 'story'].map(size => [theme, size])))
  for (const item of selected) {
    assert.deepEqual([item.width, item.height], [1080, item.size === 'story' ? 1920 : 1350])
    assert.equal(item.showRoute, batch === 'trace')
    assert.equal(item.id, batch === 'trace' ? 'trace' : 'forged-days')
    if (item.id === 'forged-days') assert.equal(item.layout, batch.slice('forged-days-'.length))
  }
  for (const [os, arch] of [['darwin', 'arm64'], ['linux', 'x64']]) {
    const key = `${os}-${arch}`
    assert.deepEqual(parseOptions([`--update-batch=${batch}`, `--platform=${key}`], {}, os, arch).selected, selected)
    assert.deepEqual(parseOptions([`--capture-batch=${batch}`, `--platform=${key}`, '--output=/tmp/capture'], { CI: 'true' }, os, arch).selected, selected)
    rejects('C2 repository mutation in CI', () => parseOptions([`--update-batch=${batch}`, `--platform=${key}`], { CI: 'true' }, os, arch), /forbidden in CI/)
  }
}
for (const batch of ['', '6', 'trace,forged-days', 'forged-days', 'TRACE', '../trace', 'trace=', 'constructor']) {
  rejects(`invalid bounded selector ${batch}`, () => selectBatch(batch), /Invalid filter/)
}
assert.deepEqual(parseOptions([], {}, 'darwin', 'arm64').selected, matrix, 'Default aggregate never loses C2 or old coverage')
assert.deepEqual(parseOptions(['--compare=c2'], {}, 'darwin', 'arm64').selected, matrix.slice(42))
const lock = readLock()
validateProvenance(lock, lock.runtime)
const files = new Map(), receipts = {}
for (const key of Object.keys(directories)) {
  const [os, arch] = key.split('-')
  assert.equal(selectBaseline(os, arch), key)
  const receipt = newReceipt(lock, key, lock.runtime), all = []
  // Synthetic host stand-in used ONLY for offline validator tests.
  receipt.host = { platform: os, arch, node: process.version }
  for (const batch of Object.keys(batches)) {
    const parsed = parseOptions([`--update-batch=${batch}`, `--platform=${key}`], {}, os, arch)
    assert.equal(parsed.selected.length, ['1', '2', '3', '4'].includes(batch) ? 9 : 6)
    all.push(...parsed.selected.map(item => item.name))
    receipt.batches[batch] = parsed.selected.map(item => {
      // Only a header stand-in for validator unit tests; never a golden or render claim.
      const png = Buffer.alloc(40); Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
      png.write('IHDR', 12); png.writeUInt32BE(item.width, 16); png.writeUInt32BE(item.height, 20); png[25] = 6
      png.write(key, 27)
      files.set(join(goldenRoot, directories[key], item.name), png)
      return pngRecord(item, png)
    })
  }
  assert.deepEqual(all, matrix.map(item => item.name), 'Batches preserve exactly all 18 C1 + 24 Full-Bleed photo + 30 C2 cases')
  receipts[key] = receipt
  files.set(receiptPath(key), Buffer.from(JSON.stringify(receipt)))
}
const read = (path, ...args) => files.has(path) ? files.get(path) : readFileSync(path, ...args)
const list = () => matrix.map(item => item.name)
for (const key of Object.keys(directories)) {
  const externalRoot = '/synthetic-native-capture'
  assert.equal(validateReceipt(receipts[key], lock, key, true, path => {
    assert.ok(path.startsWith(externalRoot + '/'), 'External import must read captured bytes, not repository baselines')
    return read(path.replace(externalRoot, goldenRoot))
  }, list, externalRoot).size, 72)
}
const candidate = assembleCandidate(lock, read, list)
assert.equal(Object.keys(validateBaselines(candidate, read, list)).length, 2)
const pinned = Buffer.from(JSON.stringify(candidate))
assert.deepEqual(readLock(path => path === lockPath ? pinned : sha256(pinned)), candidate)
rejects('tampered lock', () => readLock(path => path === lockPath ? Buffer.from('{}') : sha256(pinned)), /Unapproved/)
rejects('malformed pin', () => readLock(path => path === lockPath ? pinned : 'pending'), /Invalid acceptance pin/)
rejects('partial acceptance', () => validateBaselines({ ...candidate, state: 'pending' }, read, list), /pending/)
for (const [os, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['linux', 'arm64'], ['unknown', 'unknown']]) {
  rejects(`unsupported ${os}-${arch}`, () => selectBaseline(os, arch), /Unsupported/)
}
for (const args of [['--update=trace'], ['--compare=trace'], ['--compare='], ['--smoke', '--compare=c1'], ['--update-batch=0', '--platform=darwin-arm64'],
  ['--update-batch=6', '--platform=darwin-arm64'], ['--update-batch=1'], ['--update-batch=1', '--platform=linux-x64'],
  ['--platform=darwin-arm64', '--update-batch=1'], ['--candidate='], ['--filter-only', '--update-batch=1']]) {
  rejects(`invalid selection ${args.join(' ')}`, () => parseOptions(args, {}, 'darwin', 'arm64'), /Invalid filter/)
}
assert.deepEqual(parseOptions(['--compare=c1'], {}, 'linux', 'x64').selected, matrix.slice(0, 18))
assert.deepEqual(parseOptions(['--compare=photo'], {}, 'linux', 'x64').selected, matrix.slice(18, 42))
for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) for (const args of [
  ['--update-batch=1', '--platform=linux-x64'], ['--candidate=/tmp/candidate.json']]) {
  rejects('CI mutation', () => parseOptions(args, env, 'linux', 'x64'), /forbidden in CI/)
}
for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
  const capture = parseOptions(['--capture-batch=5', '--platform=linux-x64', '--output=/tmp/share-capture'], env, 'linux', 'x64')
  assert.equal(capture.mode, 'capture'); assert.equal(capture.selected.length, 6)
}
rejects('capture cannot spoof Linux on Mac', () => parseOptions(['--capture-batch=1', '--platform=linux-x64', '--output=/tmp/share-capture'], {}, 'darwin', 'arm64'), /Invalid filter/)
rejects('capture cannot write repository', () => parseOptions(['--capture-batch=1', '--platform=darwin-arm64', `--output=${repo}/capture`], {}, 'darwin', 'arm64'), /outside repository/)
rejects('capture requires absolute output', () => parseOptions(['--capture-batch=1', '--platform=darwin-arm64', '--output=capture'], {}, 'darwin', 'arm64'), /outside repository/)
for (const field of Object.keys(lock.runtime)) {
  rejects(`wrong runtime ${field}`, () => validateProvenance(lock, { ...lock.runtime, [field]: 'wrong' }), /provenance mismatch/)
}
for (const path of sourcePaths) {
  rejects(`wrong source/font ${path}`, () => validateProvenance(lock, lock.runtime,
    (file, ...args) => file === join(repo, path) ? Buffer.from(readFileSync(file).toString() + '\n// tampered') : readFileSync(file, ...args)), /provenance mismatch/)
}
for (const [before, after, field] of [["friend_handle: 'abc'", "friend_handle: 'changed'", 'fixtureSourceSha256'],
  ['rgb(60,70,90)', 'rgb(61,70,90)', 'renderSourceSha256']]) {
  const altered = fingerprints((path, ...args) => path === join(repo, runnerPath) ? readFileSync(path, 'utf8').replaceAll(before, after) : readFileSync(path, ...args))
  assert.notEqual(altered[field], lock.fingerprints[field], field)
}
for (const key of Object.keys(directories)) {
  const current = receipts[key], other = key === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'
  const mutate = work => { const value = structuredClone(current); work(value); return value }
  rejects(`${key} wrong platform`, () => validateReceipt(receipts[other], lock, key, true, read, list), /Wrong receipt platform/)
  rejects(`${key} wrong actual host`, () => validateReceipt(mutate(r => { r.host.platform = 'wrong' }), lock, key, true, read, list), /Wrong actual capture host/)
  rejects(`${key} wrong directory`, () => validateReceipt(mutate(r => { r.directory = directories[other] }), lock, key, true, read, list), /Wrong platform directory/)
  rejects(`${key} wrong runtime`, () => validateReceipt(mutate(r => { r.runtime.version = 'wrong' }), lock, key, true, read, list), /runtime mismatch/)
  rejects(`${key} wrong fingerprint`, () => validateReceipt(mutate(r => { r.fingerprints.fixtureSourceSha256 = 'wrong' }), lock, key, true, read, list), /mismatch/)
  rejects(`${key} historical receipt is not current acceptance`, () => validateReceipt({ ...current, schema: 'share-generation-v2' }, lock, key, true, read, list), /share-generation-v3/)
  for (const batch of ['trace', ...c2Layouts.map(layout => `forged-days-${layout}`)]) {
    rejects(`${key} missing ${batch}`, () => validateReceipt(mutate(r => { delete r.batches[batch] }), lock, key, true, read, list), /Incomplete generation/)
    rejects(`${key} mixed ${batch}`, () => validateReceipt(mutate(r => { r.batches[batch] = r.batches[1] }), lock, key, true, read, list), /batch files/)
  }
  const partial = mutate(r => { delete r.batches[5] })
  assert.equal(validateReceipt(partial, lock, key, false, read, list).size, 66, 'Partial receipts are generation evidence only')
  rejects(`${key} incomplete receipt`, () => validateReceipt(partial, lock, key, true, read, list), /Incomplete generation/)
  rejects(`${key} partial final manifest`, () => validateBaselines({ ...candidate, platforms: { ...receipts, [key]: partial } }, read, list), /Incomplete generation/)
  rejects(`${key} unknown batch`, () => validateReceipt(mutate(r => { r.batches[6] = [] }), lock, key, true, read, list), /Invalid receipt batch/)
  for (const [name, change] of [['missing', r => r.batches[1].pop()], ['extra', r => r.batches[1].push(r.batches[1][0])],
    ['duplicate', r => { r.batches[1][0] = r.batches[1][1] }]]) {
    rejects(`${key} ${name} manifest entry`, () => validateReceipt(mutate(change), lock, key, true, read, list), /batch files/)
  }
  for (const [name, listing] of [['missing', () => list().slice(1)], ['extra', () => [...list(), 'unexpected.png']], ['uppercase extra', () => [...list(), 'unexpected.PNG']]]) {
    rejects(`${key} ${name} PNG`, () => validateReceipt(current, lock, key, true, read, listing), /baseline directory/)
  }
  for (const [name, change, pattern] of [
    ['hash', png => { png[39] ^= 1 }, /Baseline hash/],
    ['dimensions', png => png.writeUInt32BE(1, 16), /PNG dimensions/],
    ['alpha', png => { png[25] = 2 }, /RGBA/],
    ['signature', png => { png[0] = 0 }, /Invalid PNG/],
  ]) rejects(`${key} ${name}`, () => validateReceipt(current, lock, key, true, path => {
    const png = Buffer.from(read(path)); change(png); return png
  }, list), pattern)
  rejects(`${key} missing directory`, () => validateReceipt(current, lock, key, true, read, () => { throw new Error('ENOENT') }), /ENOENT/)
  rejects(`${key} Mac/Linux byte substitution`, () => validateReceipt(current, lock, key, true,
    path => read(path.replace(join(goldenRoot, directories[key]), join(goldenRoot, directories[other]))), list), /Baseline hash/)
}
console.log(`PASS share provenance: 72 cases, ten bounded batches/platform, ${rejected} fail-closed negatives; no browser/golden claim`)
