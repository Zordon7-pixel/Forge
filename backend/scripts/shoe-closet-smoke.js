const fs = require('fs');
const path = require('path');
const catalog = require('../src/data/shoe_catalog.seed.json');
const { recommendShoe } = require('../src/lib/shoeRecommendation');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL: ${message}`);
  }
}

function shoe(overrides = {}) {
  return {
    id: overrides.id || 'shoe',
    brand: 'Test',
    model: 'Runner',
    category: 'daily_trainer',
    surface: 'road',
    intent_tags: ['easy', 'recovery', 'long'],
    wet_ok: null,
    recommended_miles: 450,
    total_miles: 50,
    is_active: 1,
    is_retired: 0,
    ...overrides,
  };
}

console.log('\n== catalog quality ==');
check(catalog.length >= 12, 'pilot catalog contains at least 12 carefully sourced models');
check(new Set(catalog.map((entry) => entry.id)).size === catalog.length, 'catalog IDs are unique');
for (const entry of catalog) {
  check(entry.verification_status === 'manufacturer_verified', `${entry.id} is manufacturer verified`);
  check(entry.confidence === 'high', `${entry.id} carries explicit confidence`);
  check(Array.isArray(entry.source_urls) && entry.source_urls.every((url) => /^https:\/\/(www\.)?(nike|asics|brooksrunning|adidas|newbalance)\./.test(url) || /^https:\/\/(au|nz)\.hoka\.com\//.test(url)), `${entry.id} uses manufacturer provenance`);
  check(Array.isArray(entry.verified_fields) && entry.verified_fields.length >= 4, `${entry.id} lists verified fields`);
  check(Number(entry.drop_mm) >= 0 && Number(entry.drop_mm) <= 20, `${entry.id} has a sane verified drop`);
  check(Number(entry.recommended_miles_min) > 0 && Number(entry.recommended_miles_max) >= Number(entry.recommended_miles_min), `${entry.id} has a bounded mileage estimate`);
}

console.log('\n== deterministic picks ==');
const racePick = recommendShoe([
  shoe({ id: 'daily', total_miles: 20 }),
  shoe({ id: 'racer', category: 'race', intent_tags: ['race', 'intervals'], recommended_miles: 250, total_miles: 40 }),
], 'race', {}, 'road');
check(racePick.shoe?.id === 'racer', 'race day selects the race shoe');
check(racePick.reason_codes.includes('INTENT_MATCH'), 'race pick explains the intent match');

const wetPick = recommendShoe([
  shoe({ id: 'unknown-wet', wet_ok: null }),
  shoe({ id: 'wet-ready', wet_ok: 1, total_miles: 100 }),
], 'easy', { available: true, isPrecip: true }, 'road');
check(wetPick.shoe?.id === 'wet-ready', 'recorded wet preference breaks otherwise equal suitability');
check(wetPick.reason_codes.includes('WET_PREFERENCE_RECORDED'), 'wet flag is not external verification');

const trailPick = recommendShoe([
  shoe({ id: 'road' }),
  shoe({ id: 'trail', category: 'trail', surface: 'trail', intent_tags: ['trail', 'long'] }),
], 'trail', {}, 'trail');
check(trailPick.shoe?.id === 'trail', 'trail run selects a trail shoe');
check(trailPick.reason_codes.includes('SURFACE_MATCH'), 'trail pick explains the surface match');

const wearPick = recommendShoe([
  shoe({ id: 'spent', total_miles: 450 }),
  shoe({ id: 'fresh', total_miles: 75 }),
], 'easy', {}, 'road');
// Mileage is a tie-break/condition prompt, never an automatic exclusion.
check(wearPick.shoe?.id === 'fresh', 'lower mileage breaks otherwise equal suitability');
check(wearPick.alternatives.some(result => result.shoe.id === 'spent'), 'high-mileage active pair remains an alternative');

const retiredPick = recommendShoe([
  shoe({ id: 'retired-racer', category: 'race', intent_tags: ['race'], is_retired: 1 }),
  shoe({ id: 'active-daily' }),
], 'race', {}, 'road');
check(retiredPick.shoe?.id === 'active-daily', 'retired shoes are never recommended');

const migration = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
check(migration.indexOf('CREATE TABLE IF NOT EXISTS shoe_catalog') < migration.indexOf('ALTER TABLE gear_shoes ADD COLUMN IF NOT EXISTS catalog_id'), 'catalog table is created before the gear foreign key column');
check(migration.includes('await seedShoeCatalog()'), 'always migrations seed the catalog idempotently');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('SHOE CLOSET SMOKE OK');
