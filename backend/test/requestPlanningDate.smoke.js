#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isISODate,
  isPlanningDateAllowed,
  requestPlanningDate,
} = require('../src/lib/requestPlanningDate');

function run() {
  const now = new Date('2026-08-08T16:00:00.000Z');
  assert.equal(isISODate('2026-02-30'), false, 'calendar-invalid dates fail validation');
  assert.equal(isPlanningDateAllowed('2026-08-07', now), true, 'one-day timezone skew remains accepted');
  assert.equal(isPlanningDateAllowed('2026-08-09', now), true, 'one-day forward timezone skew remains accepted');
  assert.equal(isPlanningDateAllowed('2026-08-10', now), false, 'body and query dates cannot forge a future planning day');

  const validRequest = {
    body: { date: '2026-08-09' },
    query: {},
    get: () => null,
  };
  assert.equal(requestPlanningDate(validRequest, { now }), '2026-08-09');

  const forgedRequest = {
    body: { date: '2026-08-20' },
    query: { date: '2026-08-21' },
    get: (name) => (name === 'x-forged-local-date' ? '2026-08-08' : null),
  };
  assert.equal(requestPlanningDate(forgedRequest, { now }), '2026-08-08', 'untrusted body/query dates fall through to a bounded device header');

  const checkinSource = fs.readFileSync(path.join(__dirname, '../src/routes/checkin.js'), 'utf8');
  assert.equal((checkinSource.match(/!isPlanningDateAllowed\(req\.(?:body|query)\.(?:date)\)/g) || []).length, 3, 'check-in create, preview, and today reject unbounded dates at the route boundary');

  console.log('REQUEST PLANNING DATE SMOKE OK (7)');
}

run();
