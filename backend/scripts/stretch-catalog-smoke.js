const fs = require('fs');
const path = require('path');
const { _test } = require('../src/routes/stretches');

const publicRoot = path.resolve(__dirname, '../../frontend/public');
const stretches = Object.values(_test.POOLS).flat();
const ids = new Set(stretches.map((stretch) => stretch.id));

if (ids.size !== stretches.length) {
  throw new Error(`Stretch IDs must be unique: ${ids.size}/${stretches.length}`);
}

for (const stretch of stretches) {
  const mapped = _test.withLocalImage(stretch);
  if (!mapped.image_url.startsWith('/stretches/')) {
    throw new Error(`${stretch.id} does not resolve to a local stretch image`);
  }

  const assetPath = path.join(publicRoot, mapped.image_url);
  if (!fs.existsSync(assetPath)) {
    throw new Error(`${stretch.id} references missing asset ${mapped.image_url}`);
  }

  const header = fs.readFileSync(assetPath).subarray(0, 12);
  const isPng = header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const isWebp = header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isPng && !isWebp) {
    throw new Error(`${stretch.id} references an unsupported image asset ${mapped.image_url}`);
  }
}

const hipPool = _test.POOLS['hip-focused'];
const previousIds = hipPool.slice(0, 5).map((stretch) => stretch.id);
const rotated = _test.selectRoutine(hipPool, previousIds, 5, () => 0.25);
const unseenIds = new Set(hipPool.slice(5).map((stretch) => stretch.id));
if (!rotated.slice(0, unseenIds.size).every((stretch) => unseenIds.has(stretch.id))) {
  throw new Error('Stretch rotation must select unseen movements before recent movements');
}
if (rotated.every((stretch) => previousIds.includes(stretch.id))) {
  throw new Error('Stretch rotation repeated the prior routine despite unseen movements');
}
if (_test.selectRoutine(hipPool, previousIds, -1).length !== 0) {
  throw new Error('Stretch rotation must clamp negative counts to zero');
}
if (_test.selectRoutine(hipPool, previousIds, 100).length !== hipPool.length) {
  throw new Error('Stretch rotation must clamp oversized counts to the pool');
}
const duplicateSelection = _test.selectRoutine([hipPool[0], hipPool[0], hipPool[1]], [], 3);
if (duplicateSelection.length !== 2 || new Set(duplicateSelection.map((stretch) => stretch.id)).size !== 2) {
  throw new Error('Stretch rotation must not emit duplicate movement IDs');
}

const parsedExclusions = _test.parseExcludedIds('hip-flexor-lunge,invalid value,pigeon-pose');
if (parsedExclusions.join(',') !== 'hip-flexor-lunge,pigeon-pose') {
  throw new Error('Stretch exclusion parsing did not reject malformed IDs');
}

console.log(`Stretch catalog OK: ${stretches.length} entries, ${ids.size} local image mappings, exclusion rotation verified`);
