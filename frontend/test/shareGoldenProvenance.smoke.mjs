// Offline fail-closed contracts; discovered by the existing smoke-suite runner/CI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { matrix, ids, directories, repo, goldenRoot, sourcePaths, runnerPath, lockPath, pinPath,
  parseOptions, selectBaseline, fingerprints, readLock, validateProvenance, pngRecord,
  newReceipt, receiptPath, validateReceipt, validateBaselines, assembleCandidate, sha256 } from './shareGoldenProvenance.mjs'
let rejected = 0
const rejects = (label, work, pattern) => { assert.throws(work, pattern, label); rejected++; console.log(`REJECT ${label}`) }
assert.deepEqual(ids, ['iron-chips', 'strike-pr', 'hybrid-split', 'trace', 'forged-days', 'full-bleed-story'])
assert.equal(matrix.length, 36)
assert.equal(new Set(matrix.map(item => item.name)).size, 36)
const lock = readLock()
validateProvenance(lock, lock.runtime)
const files = new Map(), receipts = {}
for (const key of Object.keys(directories)) {
  const [os, arch] = key.split('-')
  assert.equal(selectBaseline(os, arch), key)
  const receipt = newReceipt(lock, key, lock.runtime), all = []
  for (let batch = 1; batch <= 4; batch++) {
    const parsed = parseOptions([`--update-batch=${batch}`, `--platform=${key}`], {}, os, arch)
    assert.equal(parsed.selected.length, 9)
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
  assert.deepEqual(all, matrix.map(item => item.name), 'Batches preserve exactly all 18 C1 + 18 C2 cases')
  receipts[key] = receipt
  files.set(receiptPath(key), Buffer.from(JSON.stringify(receipt)))
}
const read = (path, ...args) => files.has(path) ? files.get(path) : readFileSync(path, ...args)
const list = () => matrix.map(item => item.name)
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
  ['--update-batch=5', '--platform=darwin-arm64'], ['--update-batch=1'], ['--update-batch=1', '--platform=linux-x64'],
  ['--platform=darwin-arm64', '--update-batch=1'], ['--candidate='], ['--filter-only', '--update-batch=1']]) {
  rejects(`invalid selection ${args.join(' ')}`, () => parseOptions(args, {}, 'darwin', 'arm64'), /Invalid filter/)
}
assert.deepEqual(parseOptions(['--compare=c1'], {}, 'linux', 'x64').selected, matrix.slice(0, 18))
assert.deepEqual(parseOptions(['--compare=c2'], {}, 'linux', 'x64').selected, matrix.slice(18))
for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) for (const args of [
  ['--update-batch=1', '--platform=linux-x64'], ['--candidate=/tmp/candidate.json']]) {
  rejects('CI mutation', () => parseOptions(args, env, 'linux', 'x64'), /forbidden in CI/)
}
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
  rejects(`${key} wrong directory`, () => validateReceipt(mutate(r => { r.directory = directories[other] }), lock, key, true, read, list), /Wrong platform directory/)
  rejects(`${key} wrong runtime`, () => validateReceipt(mutate(r => { r.runtime.version = 'wrong' }), lock, key, true, read, list), /runtime mismatch/)
  rejects(`${key} wrong fingerprint`, () => validateReceipt(mutate(r => { r.fingerprints.fixtureSourceSha256 = 'wrong' }), lock, key, true, read, list), /mismatch/)
  const partial = mutate(r => { delete r.batches[4] })
  assert.equal(validateReceipt(partial, lock, key, false, read, list).size, 27, 'Partial receipts are generation evidence only')
  rejects(`${key} incomplete receipt`, () => validateReceipt(partial, lock, key, true, read, list), /Incomplete generation/)
  rejects(`${key} partial final manifest`, () => validateBaselines({ ...candidate, platforms: { ...receipts, [key]: partial } }, read, list), /Incomplete generation/)
  rejects(`${key} unknown batch`, () => validateReceipt(mutate(r => { r.batches[5] = [] }), lock, key, true, read, list), /Invalid receipt batch/)
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
console.log(`PASS share provenance: 36 cases, four bounded batches/platform, ${rejected} fail-closed negatives; no browser/golden claim`)
