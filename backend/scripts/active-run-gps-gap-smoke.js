#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const activeRunPath = path.resolve(__dirname, '../../frontend/src/pages/ActiveRun.jsx');
const source = fs.readFileSync(activeRunPath, 'utf8');

for (const marker of [
  'lastFixAtRef',
  'gpsGapSecondsRef',
  'discardedSegmentRef',
  'buildGpsGapNote',
  'gps_gap_notice',
  'GPS paused during this run',
]) {
  assert(source.includes(marker), `Missing ActiveRun GPS gap marker: ${marker}`);
}

assert(source.includes('gapSeconds > 15'), 'GPS gaps must be tracked after a 15 second threshold');
assert(source.includes('segment >= 0.25'), 'Large catch-up segments must be flagged when discarded');

console.log('active run gps gap smoke OK');
