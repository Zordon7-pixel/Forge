// Deterministic identity replays of the high-fanout established 6/4 shape.
// Two daily placement alternatives match the internal measured-source caller.
const assert = require('node:assert/strict');
const { fixture, withObservedWork, windows } = require('./adaptiveCoachingSolver.smoke');
const { buildAdaptiveCoachingCandidate } = require('../src/lib/adaptiveCoachingSolver');
const availability = windows();
for (const modality of ['run', 'lift']) availability[modality] = availability[modality].flatMap(w =>
  [6, 17].map(hour => ({ start_at: `${w.start_at.slice(0, 11)}${String(hour).padStart(2, '0')}:00:00Z`,
    end_at: `${w.start_at.slice(0, 11)}23:59:00Z` })));
for (const owner of ['budget-identity-3', 'solver-fixture', 'budget-identity-1', 'budget-identity-2']) {
  const input = { foundationInput: withObservedWork(fixture(6, 4, 240, owner), { quality: true, strengthSets: 6 }), availability };
  const started = performance.now();
  const result = buildAdaptiveCoachingCandidate(input);
  assert.equal(result.applicable, true);
  assert.equal(result.selected_candidate.validation.valid, true);
  assert.equal(result.status, 'VALID');
  const sessions = result.selected_candidate.sessions;
  assert.equal(sessions.filter(s => s.kind === 'run').length, 6);
  assert.equal(sessions.filter(s => s.kind === 'lift').length, 4);
  assert.equal(result.strength_dose_receipt.prescribed_sets, 24);
  const entries = result.decision.session_selection.entries;
  // This fixture's individual choices all fit their windows. Demand headroom
  // for a whole sweep, including every distinct supporting-strength dose.
  const sweep = entries.reduce((n, entry) => n + 14 * (1 + entry.dose_variants.length), 0);
  assert.ok(result.search.expanded_nodes < result.search.node_limit, `${owner}: final objective must not consume the ceiling`);
  assert.ok(result.search.expanded_nodes <= result.search.node_limit - sweep,
    `${owner}: final-objective headroom (${result.search.expanded_nodes}, sweep ${sweep})`);
  assert.ok(sessions.some(s => s.session_id === entries.at(-1).selection_id), 'final objective actually placed');
  assert.ok(result.deferred_objectives.every(d => !d.reason_codes.includes('CANDIDATE_SEARCH_NODE_BUDGET_EXHAUSTED')));
  assert.equal(result.search.optimality_claimed, false);
  console.log(JSON.stringify({ owner, nodes: result.search.expanded_nodes, headroom: result.search.node_limit - result.search.expanded_nodes,
    sweep, elapsed_ms: Math.round(performance.now() - started) }));
  if (owner === 'solver-fixture') {
    assert.equal(buildAdaptiveCoachingCandidate(input).result_hash, result.result_hash);
    const limited = buildAdaptiveCoachingCandidate({ ...input, search: { max_nodes: 32 } });
    assert.equal(limited.search.node_limit, 32);
    assert.equal(limited.search.expanded_nodes, 32, 'actual constrained ceiling reached');
    assert.equal(limited.search.truncated, true);
    assert.equal(limited.search.optimality_claimed, false);
    assert.ok(limited.deferred_objectives.some(d => d.reason_codes.includes('CANDIDATE_SEARCH_NODE_BUDGET_EXHAUSTED')),
      'real exhaustion remains disclosed');
  }
}
console.log('adaptive search budget regression passed');
