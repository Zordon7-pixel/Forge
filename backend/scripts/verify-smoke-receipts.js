'use strict';
// Deliberately independent of run-smoke-suite.js: producer-declared inventory
// is evidence to compare, never the aggregate's authority.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function deriveExpected(repo, eventRevision, { git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }) } = {}) {
  const checkout = git(['rev-parse', 'HEAD']).trim();
  assert.match(eventRevision ?? '', /^[a-f0-9]{40}$/);
  assert.equal(checkout, eventRevision, 'event checkout mismatch');
  const tracked = git(['ls-files', '-z', '--', 'backend/test']).split('\0').filter(Boolean);
  const discovered = fs.readdirSync(path.join(repo, 'backend/test')).filter(n => n.endsWith('.smoke.js')).sort().map(n => 'backend/test/' + n);
  assert.deepEqual(discovered, tracked.filter(p => /^backend\/test\/[^/]+\.smoke\.js$/.test(p)).sort(), 'tracked filesystem mismatch');
  const explicit = ['backend/test/concurrentPlan.test.js', 'backend/test/racePlanQuality.smoke.js', 'backend/test/adaptiveCoachingCalendar.smoke.js'];
  for (const file of [...discovered, ...explicit]) {
    assert(tracked.includes(file), 'missing tracked test');
    assert(fs.lstatSync(path.join(repo, file)).isFile(), 'test must be regular');
  }
  const base = [];
  for (const file of [...discovered, explicit[0]]) {
    base.push([file, []]);
    if (file === explicit[1]) base.push([file, ['--semantic-acceptance']]);
  }
  const route = [[explicit[2], ['--route-positive']]], full = [...base, ...route];
  return { event_revision: eventRevision, checkout_revision: checkout,
    backend_lock_sha256: digest(fs.readFileSync(path.join(repo, 'backend/package-lock.json'))),
    frontend_lock_sha256: digest(fs.readFileSync(path.join(repo, 'frontend/package-lock.json'))),
    inventory_hash: digest(JSON.stringify(full) + '\n'), base, route, full };
}
function closed(value, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'expected closed object');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'unknown/missing receipt field');
}
function utc(value) {
  assert.equal(typeof value, 'string');
  const ms = Date.parse(value);
  assert(Number.isFinite(ms) && new Date(ms).toISOString() === value, 'invalid UTC time');
  return ms;
}
function verifyReceipts(receipts, authority, { supportResult, backendResult }) {
  assert.equal(supportResult, 'success', 'support job not successful');
  assert.equal(backendResult, 'success', 'backend matrix not successful');
  assert(Array.isArray(receipts));
  assert.equal(receipts.length, 5, 'exactly five receipts required');
  const labels = new Set(), expectedUnion = [], executedUnion = [], succeededUnion = [];
  for (const receipt of receipts) {
    closed(receipt, ['schema_version', 'event_revision', 'checkout_revision', 'backend_lock_sha256', 'frontend_lock_sha256',
      'inventory_hash', 'assignment_algorithm', 'mode', 'shard_index', 'shard_count', 'expected', 'executed', 'succeeded', 'terminal']);
    assert.equal(receipt.schema_version, 'forge-backend-smoke-receipt-v1');
    assert.equal(receipt.assignment_algorithm, 'sorted-base-index-modulo-4-v1');
    assert.equal(receipt.shard_count, 4);
    for (const field of ['event_revision', 'checkout_revision', 'backend_lock_sha256', 'frontend_lock_sha256', 'inventory_hash']) assert.equal(receipt[field], authority[field], field);
    let assigned, label;
    if (receipt.mode === 'base') {
      assert(Number.isInteger(receipt.shard_index) && receipt.shard_index >= 0 && receipt.shard_index < 4, 'invalid shard');
      label = 'base-' + receipt.shard_index;
      assigned = authority.base.filter((_, i) => i % 4 === receipt.shard_index);
    } else {
      assert.equal(receipt.mode, 'route-positive');
      assert.equal(receipt.shard_index, null);
      label = 'route-positive'; assigned = authority.route;
    }
    assert(!labels.has(label), 'duplicate receipt assignment'); labels.add(label);
    assert.deepEqual(receipt.expected, assigned, 'wrong expected assignment/order');
    assert(Array.isArray(receipt.executed)); assert.equal(receipt.executed.length, assigned.length, 'incomplete executions');
    let previousFinish = -Infinity;
    receipt.executed.forEach((row, ordinal) => {
      closed(row, ['identity', 'ordinal', 'started_at', 'finished_at', 'elapsed_ms', 'exit', 'signal']);
      assert.deepEqual(row.identity, assigned[ordinal], 'wrong execution identity/order');
      assert.equal(row.ordinal, ordinal);
      const start = utc(row.started_at), finish = utc(row.finished_at);
      assert(start >= previousFinish && finish >= start, 'nonsequential execution timestamps'); previousFinish = finish;
      assert(Number.isSafeInteger(row.elapsed_ms) && row.elapsed_ms >= 0 && row.elapsed_ms === finish - start, 'invalid elapsed time');
      assert.equal(row.exit, 0, 'unsuccessful child'); assert.equal(row.signal, null, 'signal termination');
      executedUnion.push(row.identity);
    });
    assert.deepEqual(receipt.succeeded, assigned, 'succeeded evidence mismatch');
    closed(receipt.terminal, ['state', 'exit']);
    assert.equal(receipt.terminal.state, 'COMPLETE'); assert.equal(receipt.terminal.exit, 0);
    expectedUnion.push(...receipt.expected); succeededUnion.push(...receipt.succeeded);
  }
  const full = authority.full.map(identity => JSON.stringify(identity)).sort();
  assert.equal(new Set(full).size, full.length, 'duplicate authoritative identity');
  for (const union of [expectedUnion, executedUnion, succeededUnion]) {
    const keys = union.map(identity => JSON.stringify(identity));
    assert.equal(new Set(keys).size, keys.length, 'duplicate union identity');
    assert.deepEqual(keys.sort(), full, 'incomplete/extra union');
  }
  return { event_revision: authority.event_revision, checkout_revision: authority.checkout_revision,
    backend_lock_sha256: authority.backend_lock_sha256, frontend_lock_sha256: authority.frontend_lock_sha256,
    inventory_hash: authority.inventory_hash, receipts: labels.size, invocations: full.length };
}
function readReceipts(directory, eventRevision) {
  assert.match(eventRevision ?? '', /^[a-f0-9]{40}$/);
  const names = fs.readdirSync(directory).sort();
  const labels = ['base-0', 'base-1', 'base-2', 'base-3', 'route-positive'];
  assert.deepEqual(names, labels.map(label => `forge-backend-smoke-${label}-${eventRevision}`).sort(), 'missing/extra artifact');
  return labels.map(label => {
    const artifact = path.join(directory, `forge-backend-smoke-${label}-${eventRevision}`), name = label + '.json';
    assert(fs.lstatSync(artifact).isDirectory(), 'artifact must be an actual directory');
    assert.deepEqual(fs.readdirSync(artifact), [name], 'missing/extra artifact content');
    const file = path.join(artifact, name), stat = fs.lstatSync(file);
    assert(stat.isFile() && stat.size <= 4 * 1024 * 1024, 'invalid receipt file');
    const bytes = fs.readFileSync(file, 'utf8'), receipt = JSON.parse(bytes);
    // Producer's canonical JSON encoding also excludes duplicate JSON keys.
    assert.equal(bytes, JSON.stringify(receipt, null, 2) + '\n', 'noncanonical receipt JSON');
    const declaredLabel = receipt.mode === 'base' ? 'base-' + receipt.shard_index : receipt.mode;
    assert.equal(label, declaredLabel, 'artifact/assignment mismatch');
    return receipt;
  });
}
function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--receipts-dir' || !argv[1] || argv[1].startsWith('--')) throw Error('Expected --receipts-dir directory');
  const authority = deriveExpected(path.resolve(__dirname, '../..'), process.env.GITHUB_SHA);
  const result = verifyReceipts(readReceipts(argv[1], authority.event_revision), authority, { supportResult: process.env.SUPPORT_RESULT, backendResult: process.env.BACKEND_RESULT });
  console.log('BACKEND SMOKE RECEIPTS VERIFIED', JSON.stringify(result));
  return 0;
}
module.exports = { deriveExpected, verifyReceipts, readReceipts, main };
if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error('BACKEND SMOKE RECEIPTS REJECTED:', error.message); process.exitCode = 1; }
}
