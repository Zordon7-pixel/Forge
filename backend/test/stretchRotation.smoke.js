const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
Module._load = function loadStretchRouteDependency(request, parent, isMain) {
  if (request === 'express') return { Router: () => ({ get() {} }) };
  if (request === '../middleware/auth') return (_req, _res, next) => next();
  if (request === '../db') return { dbGet: async () => null };
  return originalLoad.call(this, request, parent, isMain);
};

const {
  MOVEMENTS,
  POOLS,
  estimateRoutineSeconds,
  parseExcludedIds,
  parseRoutineCount,
  selectRoutine,
} = require('../src/routes/stretches')._test;
Module._load = originalLoad;

const publicRoot = path.resolve(__dirname, '../../frontend/public');
for (const [category, pool] of Object.entries(POOLS)) {
  assert(pool.length >= 16, `${category} must expose enough movements to rotate a 12-movement routine`);
  assert.equal(new Set(pool.map((movement) => movement.id)).size, pool.length, `${category} IDs must be unique`);

  for (const movement of pool) {
    assert.strictEqual(movement, MOVEMENTS[movement.id], `${movement.id} must use its canonical definition`);
    assert.match(movement.image_url, /^\/stretches\/[a-z0-9-]+\.(png|webp)$/i, `${movement.id} must use a local asset`);
    assert(fs.existsSync(path.join(publicRoot, movement.image_url)), `${movement.id} references a missing asset`);
    assert(Number.isFinite(movement.duration) && movement.duration >= 20 && movement.duration <= 60, `${movement.id} duration is out of bounds`);
    assert.equal(movement.sides, movement.sideMode === 'each-side' ? 2 : 1, `${movement.id} has invalid side semantics`);
    if (movement.type === 'static' && /each side/i.test(movement.durationLabel)) {
      assert.equal(movement.sideMode, 'each-side', `${movement.id} must time two sides`);
    }
  }

  for (const count of [5, 8, 12]) {
    const routine = selectRoutine(pool, [], count, () => 0.25, []);
    assert.equal(routine.length, Math.min(count, pool.length), `${category} must return ${count} unique movements`);
    assert.equal(new Set(routine.map((movement) => movement.id)).size, routine.length, `${category} routine contains duplicates`);
    assert.equal(estimateRoutineSeconds(routine), routine.reduce((sum, movement) => sum + movement.duration * movement.sides, 0));
  }

  const priorFullRoutine = pool.slice(0, 12).map((movement) => movement.id);
  const nextFullRoutine = selectRoutine(pool, priorFullRoutine, 12, () => 0.25, priorFullRoutine);
  assert.equal(nextFullRoutine.length, 12, `${category} full routine must keep its requested size`);
  assert(
    nextFullRoutine.some((movement) => !priorFullRoutine.includes(movement.id)),
    `${category} full routine must rotate movement membership, not only ordering`
  );
}

assert.equal(parseRoutineCount(undefined), 8, 'missing count must default to 8');
assert.equal(parseRoutineCount('5'), 5);
assert.equal(parseRoutineCount('8'), 8);
assert.equal(parseRoutineCount('12'), 12);
for (const malformed of ['0', '7', '12.0', '5000', '', {}, ['5'], null]) {
  assert.equal(parseRoutineCount(malformed), 8, `malformed count ${String(malformed)} must default to 8`);
}

const manyIds = Array.from({ length: 100 }, (_, index) => `move-${index}`).join(',');
const parsed = parseExcludedIds(`valid-id,invalid value,valid-id,${manyIds}`);
assert.equal(parsed[0], 'valid-id');
assert.equal(new Set(parsed).size, parsed.length, 'exclude IDs must be deduplicated');
assert(parsed.length <= 48, 'exclude IDs must be bounded');
assert.deepEqual(parseExcludedIds({ arbitrary: true }), [], 'arbitrary exclude objects must be rejected');

const hipPool = POOLS['hip-focused'];
const immediate = hipPool.slice(0, 5).map((movement) => movement.id);
const unseenRoutine = selectRoutine(hipPool, immediate, 5, () => 0.25, immediate);
assert(unseenRoutine.every((movement) => !immediate.includes(movement.id)), 'immediately previous IDs must be avoided when possible');

const smallPool = hipPool.slice(0, 5);
const reordered = selectRoutine(smallPool, immediate, 5, () => 0.999999, immediate).map((movement) => movement.id);
assert.notDeepEqual(reordered, immediate, 'the exact same ordered server routine must be changed when another ordering exists');

console.log(`STRETCH ROTATION OK (${Object.keys(MOVEMENTS).length} canonical movements; ${Object.keys(POOLS).length} pools)`);
