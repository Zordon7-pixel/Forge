const assert = require('node:assert/strict');
const { scenario } = require('./programFixtures');
const { computeGoalBackwardShadowDiagnostics, computeGoalBackwardShadowDiagnosticsAsync } = require('../src/routes/plans')._test;

async function main() {
  const fixture = scenario({ count: 3, liftDays: 4, constructOnly: true });
  const input = { userId: fixture.owner, state: fixture.state, built: fixture.built, planningDateLocal: fixture.date };
  const expected = computeGoalBackwardShadowDiagnostics(structuredClone(input));
  assert.ok(expected.selected_candidate);
  const phases = [], chunks = [];
  let controlRan = false;
  setImmediate(() => { controlRan = true; });
  const actual = await computeGoalBackwardShadowDiagnosticsAsync(structuredClone(input), {
    inspectCooperativeYield(phase) { phases.push(phase); assert.equal(controlRan, true); },
    inspectCooperativeChunk(chunk) { chunks.push(chunk); },
  });
  assert.deepEqual(actual, expected, 'Sync and cooperative drains preserve the complete deterministic result, not only displayed counts');
  assert.ok(phases.includes('weekly-window') && phases.includes('program-search') && phases.includes('program-composition'));
  assert.ok(chunks.every(chunk => Number.isFinite(chunk.elapsed_ms) && chunk.elapsed_ms >= 0));
  for (const phase of ['weekly-window', 'program-search', 'program-composition']) {
    const changed = structuredClone(input);
    await assert.rejects(computeGoalBackwardShadowDiagnosticsAsync(changed, {
      inspectCooperativeYield(current) { if (current === phase) changed.state.planningInputRevision++; },
    }), error => error.code === 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID' && /PROGRAM_SNAPSHOT_CHANGED/.test(error.message),
    `A changed snapshot cannot cross the ${phase} checkpoint into validated output`);
  }
  const sentinel = new Error('deterministic-compute-error');
  await assert.rejects(computeGoalBackwardShadowDiagnosticsAsync(structuredClone(input), {
    buildDecision() { throw sentinel; },
  }), error => error === sentinel, 'The awaited route computation preserves errors without returning partial output');
  console.log(`COOPERATIVE PROGRAM COMPOSITION OK: full sync/async equality, ${phases.length} checkpoints, mutation/error/control guards`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
