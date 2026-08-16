import assert from 'node:assert/strict'
import {
  activePlanRaceIds,
  verifyHyroxPlanActivation,
  verifyRaceRemovalActivation,
} from '../src/lib/planActivation.js'

const hyrox = {
  id: 'hyrox-dc',
  race_name: 'HYROX Washington DC',
  race_date: '2026-09-06',
  event_local_date: '2026-09-06',
  event_format: 'doubles',
  event_category: 'men',
  goal_time_seconds: 3600,
}
const activePlan = {
  plan_data: {
    goals: [
      {
        kind: 'hyrox', raceId: 'hyrox-dc', name: 'HYROX Washington DC',
        eventLocalDate: '2026-09-06', division: 'doubles', category: 'men', goalTimeSeconds: 3600,
      },
      { kind: 'run_race', raceId: 'army', name: 'Army Ten-Miler', eventLocalDate: '2026-10-11' },
    ],
  },
}

assert.deepEqual(activePlanRaceIds(activePlan), ['hyrox-dc', 'army'])
assert.equal(verifyHyroxPlanActivation({
  planResponse: { plan: activePlan, user_plan: { id: 'assignment-new' } },
  expectedUserPlanId: 'assignment-new',
  hyroxRace: hyrox,
  secondaryRaceId: 'army',
}).confirmed, true, 'the exact applied assignment, ordered goals, division, date, and target confirm activation')

for (const [label, planResponse] of [
  ['stale Yonkers/Army plan', { plan: { plan_data: { goals: [{ raceId: 'yonkers' }, { raceId: 'army' }] } }, user_plan: { id: 'assignment-new' } }],
  ['wrong assignment', { plan: activePlan, user_plan: { id: 'assignment-old' } }],
  ['wrong HYROX target', { plan: { plan_data: { goals: [{ ...activePlan.plan_data.goals[0], goalTimeSeconds: 6900 }, activePlan.plan_data.goals[1]] } }, user_plan: { id: 'assignment-new' } }],
]) {
  assert.equal(verifyHyroxPlanActivation({
    planResponse,
    expectedUserPlanId: 'assignment-new',
    hyroxRace: hyrox,
    secondaryRaceId: 'army',
  }).confirmed, false, label)
}

assert.equal(verifyRaceRemovalActivation({
  races: [{ id: 'army' }],
  activePlan: { plan_data: { goals: [{ raceId: 'army' }] } },
  removedRaceId: 'yonkers',
  expectedRemainingRaceIds: ['army'],
}).confirmed, true)
assert.equal(verifyRaceRemovalActivation({
  races: [{ id: 'army' }],
  activePlan: { plan_data: { goals: [{ raceId: 'yonkers' }, { raceId: 'army' }] } },
  removedRaceId: 'yonkers',
  expectedRemainingRaceIds: ['army'],
}).confirmed, false, 'a deleted race is not confirmed while the active plan still protects it')
assert.equal(verifyRaceRemovalActivation({
  races: [],
  activePlan: null,
  activePlanReadConfirmed: false,
  removedRaceId: 'yonkers',
  expectedRemainingRaceIds: [],
}).confirmed, false, 'an active-plan read failure cannot masquerade as a confirmed empty replacement')

assert.equal(verifyHyroxPlanActivation({
  planResponse: { plan: { plan_data: { goals: [] } }, user_plan: { id: 'foundation-assignment' } },
  expectedUserPlanId: 'foundation-assignment',
  hyroxRace: null,
}).confirmed, true, 'an undated foundation confirms assignment identity without inventing an owned race goal')

assert.equal(verifyHyroxPlanActivation({
  planResponse: { plan: { plan_data: { goals: [] } }, user_plan: { id: '' } },
  expectedUserPlanId: '',
  hyroxRace: null,
}).confirmed, false, 'all-empty assignment and goal inputs can never confirm activation')

console.log('PLAN ACTIVATION IDENTITY SMOKE OK')
