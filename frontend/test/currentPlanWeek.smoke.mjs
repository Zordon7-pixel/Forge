import assert from 'node:assert/strict'
import {
  deriveCurrentPlanWeekIndex,
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

console.log('current plan week smoke passed')
