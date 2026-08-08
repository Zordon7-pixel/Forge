#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  createPlanningInputMutationRunner,
  planningInputUnchanged,
} = require('../src/lib/planningRevision');

function createSerializedOwnerStore() {
  const revisions = new Map();
  const tails = new Map();

  async function withUserMutation(userId, callback) {
    const previous = tails.get(userId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    tails.set(userId, previous.then(() => current));
    await previous;
    const tx = {
      get: async (sql, params) => {
        assert.match(sql, /UPDATE users[\s\S]*planning_input_revision = planning_input_revision \+ 1[\s\S]*WHERE id = \?/);
        assert.deepEqual(params, [userId]);
        const next = (revisions.get(userId) || 0) + 1;
        revisions.set(userId, next);
        return { planning_input_revision: next };
      },
    };
    try {
      return await callback(tx);
    } finally {
      release();
    }
  }

  return { revisions, withUserMutation };
}

async function runPlanningRevisionConcurrencySmoke() {
  const store = createSerializedOwnerStore();
  const withPlanningInputMutation = createPlanningInputMutationRunner(store.withUserMutation);
  let committedMutations = 0;
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (
    withPlanningInputMutation('user-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      committedMutations += 1;
      return index;
    })
  )));

  assert.equal(results.length, 24);
  assert.equal(committedMutations, 24);
  assert.equal(store.revisions.get('user-a'), 24, 'concurrent owner writes must not lose revision increments');

  await assert.rejects(
    withPlanningInputMutation('user-a', async () => { throw new Error('rollback'); }),
    /rollback/
  );
  assert.equal(store.revisions.get('user-a'), 24, 'failed owner mutation must not advance revision');

  const noOpResult = await withPlanningInputMutation(
    'user-a',
    async () => planningInputUnchanged({ unchanged: true })
  );
  assert.deepEqual(noOpResult, { unchanged: true });
  assert.equal(store.revisions.get('user-a'), 24, 'idempotent no-op must not advance revision');
}

if (require.main === module) {
  runPlanningRevisionConcurrencySmoke()
    .then(() => console.log('PLANNING REVISION CONCURRENCY SMOKE OK (24 writes)'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { runPlanningRevisionConcurrencySmoke };
