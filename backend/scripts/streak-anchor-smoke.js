#!/usr/bin/env node

const assert = require('assert');
const { computeStreak, serverUtcAnchorCandidates } = require('../src/lib/streak');

const now = new Date('2026-07-03T12:00:00.000Z');
const anchors = serverUtcAnchorCandidates(now);
assert.deepStrictEqual(anchors, ['2026-07-04', '2026-07-03', '2026-07-02']);

let result = computeStreak(new Set(['2026-07-04']), anchors);
assert.strictEqual(result.current, 1, 'server-UTC tomorrow should count as current streak');

result = computeStreak(new Set(['2026-07-04', '2026-07-03', '2026-07-02']), anchors);
assert.strictEqual(result.current, 3, 'tomorrow+today+yesterday should count once each');
assert.strictEqual(result.best, 3);

result = computeStreak(new Set(['2026-07-04', '2026-07-02']), anchors);
assert.strictEqual(result.current, 1, 'gap after newest anchor should break current streak walk');
assert.strictEqual(result.best, 1);

result = computeStreak(new Set(['2026-06-20', '2026-06-21', '2026-06-23', '2026-06-24', '2026-06-25']), anchors);
assert.strictEqual(result.current, 0, 'old fixture without anchor should not be current');
assert.strictEqual(result.best, 3, 'best streak should match old consecutive-date math');

const today = now.toISOString().slice(0, 10);
const bucketRows = [
  { id: 'yesterday', date: '2026-07-02' },
  { id: 'today', date: '2026-07-03' },
].filter((row) => row.date >= today);
assert.deepStrictEqual(bucketRows.map((row) => row.id), ['today'], 'day bucket should exclude yesterday');

console.log('Streak anchor smoke OK');
