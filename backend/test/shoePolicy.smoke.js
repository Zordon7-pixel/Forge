const assert = require('node:assert/strict');
const { recommendShoe } = require('../src/lib/shoeRecommendation');
const shoe = (extra = {}) => ({ id: 'pair', category: 'daily_trainer', surface: 'road',
  intent_tags: ['easy'], total_miles: 50, recommended_miles: 450, is_active: 1, is_retired: 0, ...extra });
const high = shoe({ total_miles: 500 });
assert.equal(recommendShoe([high]).shoe.id, high.id, 'mileage alone cannot exclude an active pair');
assert.ok(recommendShoe([high]).reason_codes.includes('INSPECT_WEAR'));
assert.doesNotMatch(recommendShoe([high]).reason, /unsafe|must retire|left out/i);
const quality = shoe({ id: 'quality', category: 'tempo', intent_tags: ['threshold'], total_miles: 800 });
const fresh = shoe({ id: 'fresh', total_miles: 0, wet_ok: 1 });
assert.equal(recommendShoe([fresh, quality], 'threshold', { isPrecip: true }).shoe.id, 'quality', 'suitability outranks mileage and unverified wet flag');
for (const surface of ['trail', 'both']) {
  const no = recommendShoe([shoe()], 'easy', {}, surface);
  assert.equal(no.shoe, null);
  assert.deepEqual(no.alternatives, []);
  assert.ok(no.reason_codes.includes('NO_COMPATIBLE_SHOE'));
  assert.equal(no.training_unchanged, true);
}
const trail = shoe({ id: 'trail', surface: 'trail', category: 'trail' });
const both = shoe({ id: 'both', surface: 'both' });
assert.equal(recommendShoe([trail, shoe(), both], 'easy', {}, 'both').shoe.id, 'both');
const trailPick = recommendShoe([trail, shoe(), both], 'trail', {}, 'trail');
assert.ok(![trailPick.shoe, ...trailPick.alternatives.map(x => x.shoe)].some(x => x.surface === 'road'));
for (const absent of [undefined, null, '', 'unrecognized']) {
  const no = recommendShoe([shoe({ category: null, surface: absent })]);
  assert.equal(no.shoe, null);
  assert.ok(no.reason_codes.includes('UNKNOWN_SHOE_METADATA'));
  assert.equal(no.confidence, 'LOW');
  assert.doesNotMatch(no.reason, /built for|best match|verified traction/i);
}
assert.equal(recommendShoe([shoe()], 'easy', {}, 'snow').shoe, null);
assert.ok(recommendShoe([shoe()], 'easy', {}, 'snow').reason_codes.includes('UNKNOWN_REQUESTED_SURFACE'));
const wet = recommendShoe([shoe({ wet_ok: 1, catalog_verification_status: 'manufacturer_verified', catalog_confidence: 'high' })], 'easy', { isPrecip: true });
assert.equal(wet.confidence, 'LOW');
assert.equal(wet.metadata_basis, 'UNVERIFIED_PROFILE');
assert.doesNotMatch(wet.reason, /has verified|built for/);
assert.match(wet.reason, /not independently verified/);
assert.ok(wet.reason_codes.includes('WET_PREFERENCE_RECORDED'));
const noShoes = recommendShoe([]);
assert.equal(noShoes.shoe, null);
assert.ok(noShoes.reason_codes.includes('NO_ACTIVE_SHOES'));
assert.equal(noShoes.training_unchanged, true);
assert.equal(recommendShoe([shoe({ is_retired: 1 })]).shoe, null);
const rotation = [shoe({ id: 'a', total_miles: 500 }), shoe({ id: 'b', total_miles: 10 }), shoe({ id: 'c', total_miles: 20 })];
const snapshot = JSON.stringify(rotation);
assert.deepEqual(recommendShoe(rotation), recommendShoe([...rotation].reverse()));
assert.equal(JSON.stringify(rotation), snapshot, 'recommendation is non-mutating');
assert.equal(recommendShoe(rotation).alternatives.length, 2);
console.log('PASS shoe policy: mileage, suitability, strict surfaces, mixed terrain, unknown metadata, unverified wet flags, optional closet, deterministic non-mutation');
