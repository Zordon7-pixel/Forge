import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activityKind,
  latestRunningActivity,
  runningActivities,
} from '../src/lib/activityType.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = (relativePath) => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const walk = {
  id: 'health-walk',
  type: 'walk',
  activity_kind: 'walk',
  watch_activity_type: 'Walking',
  watch_normalized_type: 'walk',
  date: '2026-09-02',
  distance_miles: 3.1,
  duration_seconds: 3600,
}
const run = {
  id: 'health-run',
  type: 'easy',
  activity_kind: 'run',
  watch_activity_type: 'Running',
  date: '2026-09-01',
  distance_miles: 4,
  duration_seconds: 2400,
}

assert.equal(activityKind(walk), 'walk', 'Apple Health Walking remains canonically distinct from running')
assert.deepEqual(runningActivities([walk, run]), [run], 'walk distance is excluded from run-only collections')
assert.equal(latestRunningActivity([walk, run])?.id, 'health-run', 'a newer walk cannot become the latest run')
assert.equal(latestRunningActivity([walk]), null, 'a walk-only history has no recent run')
assert.deepEqual(runningActivities(null), [], 'nullable activity history fails closed for run-only consumers')

const runHub = source('src/pages/RunHub.jsx')
const plan = source('src/pages/Plan.jsx')
const prWall = source('src/pages/PRWall.jsx')
const activeWorkout = source('src/pages/ActiveWorkout.jsx')

assert.match(runHub, /activity_kind:\s*['"]run['"]/i, 'Train requests a server-filtered run history')
assert.match(runHub, /setLatestRun\(latestRunningActivity\(runs\)\)/, 'Train rechecks canonical activity type before showing Recent run')
assert.match(plan, /activity_kind:\s*['"]run['"]/i, 'Plan calendar requests running activities only')
assert.match(prWall, /activity_kind:\s*['"]run['"]/i, 'running PR calculations request running activities only')
assert.match(prWall, /runningActivities\(allRunsRes\.data\?\.runs \|\| \[\]\)/, 'running mileage totals recheck canonical activity identity')
assert.match(activeWorkout, /activity_kind:\s*['"]run['"]/i, 'latest-run heart-rate context requests running activities only')
assert.match(activeWorkout, /latestRunningActivity\(r\.data\?\.runs \|\| \[\]\)/, 'latest-run heart-rate context rejects a walk defensively')

console.log('RUN ACTIVITY BOUNDARY SMOKE OK (12)')
