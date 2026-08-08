#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeDir = path.join(__dirname, '..', 'src', 'routes');
const readRoute = (name) => fs.readFileSync(path.join(routeDir, name), 'utf8');

function runPlanningProviderRoutesSmoke() {
  const strava = readRoute('strava.js');
  const oura = readRoute('oura.js');
  const whoop = readRoute('whoop.js');
  const garmin = readRoute('garmin.js');
  const watchSync = readRoute('watchSync.js');

  assert.match(strava, /syncStravaActivitiesForUser[\s\S]*withPlanningInputMutation\(userId/, 'Strava activity sync must share the planning owner lock');
  assert.match(strava, /runs\.length \? syncResult : planningInputUnchanged\(syncResult\)/, 'empty Strava sync must not advance revision');
  assert.match(oura, /syncPayloads\.length[\s\S]*withPlanningInputMutation\(req\.user\.id[\s\S]*upsertOuraData\(req\.user\.id, payload, tx\)/, 'Oura aggregates must commit in one planning transaction');
  assert.match(whoop, /syncPayloads\.length[\s\S]*withPlanningInputMutation\(req\.user\.id[\s\S]*upsertWhoopData\(req\.user\.id, payload, tx\)/, 'WHOOP aggregates must commit in one planning transaction');
  assert.match(garmin, /sleepPayloads\.length[\s\S]*withPlanningInputMutation\(req\.user\.id[\s\S]*upsertGarminSleep\(req\.user\.id, payload, tx\)/, 'Garmin sleep aggregates must commit in one planning transaction');
  assert.match(watchSync, /ingestActivity[\s\S]*withPlanningInputMutation\(userId/, 'watch activity ingestion must share the planning owner lock');
}

if (require.main === module) {
  runPlanningProviderRoutesSmoke();
  console.log('PLANNING PROVIDER ROUTES SMOKE OK');
}

module.exports = { runPlanningProviderRoutesSmoke };
