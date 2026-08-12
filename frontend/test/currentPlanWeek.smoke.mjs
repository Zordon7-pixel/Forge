import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveCurrentPlanWeekIndex,
  derivePlanWeekSyncTarget,
  resolvePlanWeekSelection,
} from '../src/lib/planCalendar.js'

const plan = {
  weeks: 4,
  plan_data: {
    weeks: [
      { week: 1, startDate: '2026-08-03', days: [] },
      { week: 2, startDate: '2026-08-10', days: [] },
      { week: 3, startDate: '2026-08-17', days: [] },
      { week: 4, startDate: '2026-08-24', days: [] },
    ],
  },
}

assert.equal(
  deriveCurrentPlanWeekIndex(plan, { started_at: '2026-08-03' }, new Date(2026, 7, 19, 23, 55)),
  2,
  'a mid-plan local date should open the matching plan week',
)
assert.equal(
  deriveCurrentPlanWeekIndex(plan, { started_at: '2026-08-03' }, new Date(2026, 6, 30, 23, 55)),
  0,
  'dates before plan start should clamp to week one',
)
assert.equal(
  deriveCurrentPlanWeekIndex(plan, { started_at: '2026-08-03' }, new Date(2026, 8, 12, 0, 5)),
  3,
  'dates after plan end should clamp to the last week',
)
assert.equal(
  deriveCurrentPlanWeekIndex(plan, { started_at: '2026-08-03' }, new Date(2026, 7, 17, 0, 1)),
  2,
  'the phone-local Monday boundary should select the new week deterministically',
)

const now = new Date(2026, 7, 19, 12)
assert.equal(resolvePlanWeekSelection(plan, { started_at: '2026-08-03' }, null, now), 2)
assert.equal(
  resolvePlanWeekSelection(plan, { started_at: '2026-08-03' }, 0, now),
  0,
  'manual week navigation should persist during the mounted screen session',
)
assert.equal(
  resolvePlanWeekSelection(plan, { started_at: '2026-08-03' }, null, now),
  2,
  'a reopened screen has no in-session selection and should return to the current week',
)

const staleProgress = { started_at: '2026-08-03', current_week: 1 }
const manuallyBrowsedWeek = resolvePlanWeekSelection(plan, staleProgress, 0, now)
assert.equal(manuallyBrowsedWeek, 0, 'manual navigation still controls only the visible week')
assert.equal(
  derivePlanWeekSyncTarget(plan, staleProgress, now),
  3,
  'persisted progress advances to the independently date-derived week, not the manually browsed week',
)
assert.notEqual(
  derivePlanWeekSyncTarget(plan, staleProgress, now),
  manuallyBrowsedWeek + 1,
  'the manual previous/next cursor is never chosen as the persisted value',
)
assert.equal(
  derivePlanWeekSyncTarget(plan, { ...staleProgress, current_week: 3 }, now),
  null,
  'already synchronized progress does not write again',
)
assert.equal(
  derivePlanWeekSyncTarget(plan, { ...staleProgress, current_week: 4 }, now),
  null,
  'opening an earlier derived week never moves persisted progress backward',
)

const testDir = path.dirname(fileURLToPath(import.meta.url))
const planPageSource = readFileSync(path.join(testDir, '../src/pages/Plan.jsx'), 'utf8')
assert.match(planPageSource, /derivePlanWeekSyncTarget\(myPlan, myUserPlan\)/)
assert.match(planPageSource, /current_week:\s*syncWeek/)
assert.doesNotMatch(
  planPageSource.match(/const goToWeek =[^}]+}/s)?.[0] || '',
  /api\.put/,
  'manual week navigation must remain an in-memory cursor',
)

console.log('current plan week smoke passed')
