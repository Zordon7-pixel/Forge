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

const trace = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/lib/gpsTrace.js'), 'utf8');
assert(trace.includes('gapMs >= 15000'), 'GPS gaps include the exact 15 second threshold');
assert(source.includes('recordedSegments.map'), 'Each segment must draw independently');
assert(trace.includes("return reject('speed')"), 'Speed spikes must not reach geometry or distance');

console.log('active run gps gap smoke OK');
