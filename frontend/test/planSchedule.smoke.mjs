import assert from 'node:assert/strict'
import {
  buildScheduleRebuildRequest,
  normalizeTrainingDays,
  protectedRaceIdsFromGoals,
  scheduleDraftFromPlan,
  scheduleFrequencyGuidance,
  scheduleHasChanges,
  toggleTrainingDay,
  validateScheduleDraft,
} from '../src/lib/planSchedule.js'

const planData = {
  planMode: 'hybrid_maintain',
  schedulePreferences: {
    runDaysPerWeek: 3,
    trainingDays: ['Sat', 'Tue', 'Thu'],
  },
  strengthPolicy: {
    enabled: true,
    sessionsPerWeek: 2,
    goal: 'maintain',
    equipment: ['barbell', 'dumbbells'],
  },
}

assert.deepEqual(normalizeTrainingDays(['Sun', 'Tue', 'Tue', 'invalid']), ['Tue', 'Sun'])
assert.deepEqual(
  protectedRaceIdsFromGoals([{ raceId: 'yonkers' }, { race_id: 'army' }]),
  ['yonkers', 'army'],
)
assert.deepEqual(protectedRaceIdsFromGoals([{ name: 'General fitness' }]), [])
assert.throws(
  () => protectedRaceIdsFromGoals([{ raceId: 'yonkers' }, { name: 'Army Ten-Miler' }]),
  /Review the saved races/,
)
assert.throws(
  () => protectedRaceIdsFromGoals([{ raceId: 'same-race' }, { raceId: 'same-race' }]),
  /Review the saved races/,
)
assert.deepEqual(scheduleDraftFromPlan(planData), {
  runDaysPerWeek: 3,
  trainingDays: ['Tue', 'Thu', 'Sat'],
})

const fourDayDraft = toggleTrainingDay(scheduleDraftFromPlan(planData), 'Sun')
fourDayDraft.runDaysPerWeek = 4
assert.deepEqual(fourDayDraft.trainingDays, ['Tue', 'Thu', 'Sat', 'Sun'])
assert.equal(validateScheduleDraft(fourDayDraft), '')
assert.equal(scheduleHasChanges(planData, fourDayDraft), true)
assert.match(scheduleFrequencyGuidance(4), /quality, easy, steady, and long/)

const twoRaceRequest = buildScheduleRebuildRequest({
  planData,
  goal: { name: 'Army Ten-Miler', dateISO: '2026-10-11', distanceMiles: 10 },
  raceIds: ['yonkers', 'army'],
  draft: fourDayDraft,
  weekCount: 10,
})
assert.equal(twoRaceRequest.path, '/plans/generate-for-races')
assert.deepEqual(twoRaceRequest.body.race_ids, ['yonkers', 'army'])
assert.equal(twoRaceRequest.body.target.runDaysPerWeek, 4)
assert.deepEqual(twoRaceRequest.body.target.trainingDays, ['Tue', 'Thu', 'Sat', 'Sun'])
assert.equal(twoRaceRequest.body.target.planMode, 'hybrid_maintain')
assert.equal(twoRaceRequest.body.target.liftingEnabled, true)
assert.equal(twoRaceRequest.body.target.liftDaysPerWeek, 2)

const singleRaceRequest = buildScheduleRebuildRequest({
  planData,
  raceIds: ['army'],
  draft: fourDayDraft,
})
assert.equal(singleRaceRequest.path, '/plans/generate-for-race/army')

const generalRequest = buildScheduleRebuildRequest({
  planData,
  goal: { name: '10-mile block', distanceMiles: 10, goalTimeSeconds: 5400 },
  draft: fourDayDraft,
  weekCount: 8,
})
assert.equal(generalRequest.path, '/plans/generate')
assert.equal(generalRequest.body.target.distanceMiles, 10)
assert.equal(generalRequest.body.target.goalTimeSeconds, 5400)
assert.equal(generalRequest.body.target.weeks, 8)

assert.equal(validateScheduleDraft({ trainingDays: [], runDaysPerWeek: 1 }), 'Choose at least one eligible running day.')
assert.throws(() => buildScheduleRebuildRequest({ planData, raceIds: ['a', 'b', 'c'], draft: fourDayDraft }), /at most two races/)

console.log('PLAN SCHEDULE SMOKE OK (28 assertions)')
