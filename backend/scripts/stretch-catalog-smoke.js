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

console.log(`Stretch catalog OK: ${stretches.length} entries, ${ids.size} local image mappings`);
