const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function runStaticAssetFallbackSmoke() {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

  const assetFallbackIndex = appSource.indexOf("app.get('/assets/*'");
  const spaFallbackIndex = appSource.indexOf("app.get('*'");

  assert.ok(assetFallbackIndex >= 0, 'missing /assets files have an explicit fallback');
  assert.ok(spaFallbackIndex > assetFallbackIndex, 'asset 404 is registered before the SPA fallback');
  assert.match(
    appSource.slice(assetFallbackIndex, spaFallbackIndex),
    /status\(404\).*type\('text\/plain'\)/s,
    'missing assets return a plain-text 404 instead of index.html'
  );

  console.log('STATIC ASSET FALLBACK SMOKE OK (3)');
}

if (require.main === module) runStaticAssetFallbackSmoke();

module.exports = { runStaticAssetFallbackSmoke };
