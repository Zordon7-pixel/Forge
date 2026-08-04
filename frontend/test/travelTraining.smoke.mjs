// Deterministic race reconciliation + travel/no-gym helper smoke.
// Run: node frontend/test/travelTraining.smoke.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  deriveRacePlanReconciliation,
  deriveTravelTrainingChoices,
  normalizeTravelWorkoutOverride,
} from '../src/lib/travelTraining.js'

const today = '2026-08-03'
const armyGoal = { raceId: 'army', name: 'Army Ten-Miler', dateISO: '2026-10-11' }
const army = {
  id: 'army', race_name: 'Army Ten-Miler', race_date: '2026-10-11', status: 'upcoming', goal_time_seconds: 5220,
}
const yonkers = {
  id: 'yonkers', race_name: 'Yonkers Half Marathon', race_date: '2026-09-20', status: 'upcoming', goal_time_seconds: 7200,
}

const direct = deriveRacePlanReconciliation({ calendarGoals: [armyGoal], savedRaces: [army, yonkers], todayISO: today })
assert.equal(direct.kind, 'direct')
assert.deepEqual(direct.orderedRaceIds, ['yonkers', 'army'])
assert.equal(direct.missingRace.race_name, 'Yonkers Half Marathon')

assert.equal(deriveRacePlanReconciliation({
  calendarGoals: [armyGoal, { raceId: 'yonkers', name: yonkers.race_name, dateISO: yonkers.race_date }],
  savedRaces: [army, yonkers], todayISO: today,
}), null, 'already-combined plans do not reconcile again')

const closeRace = { ...yonkers, id: 'close', race_date: '2026-09-25' }
assert.equal(deriveRacePlanReconciliation({ calendarGoals: [armyGoal], savedRaces: [army, closeRace], todayISO: today })?.kind, 'review')
assert.equal(deriveRacePlanReconciliation({ calendarGoals: [armyGoal], savedRaces: [army, { ...yonkers, race_date: '2026-07-20' }], todayISO: today }), null)
assert.equal(deriveRacePlanReconciliation({ calendarGoals: [armyGoal], savedRaces: [army, { ...yonkers, goal_time_seconds: 0 }], todayISO: today }), null)
assert.equal(deriveRacePlanReconciliation({
  calendarGoals: [armyGoal],
  savedRaces: [army, { ...army, id: 'duplicate-army' }],
  todayISO: today,
}), null, 'duplicate race/date identity is not a second goal')

const ambiguous = deriveRacePlanReconciliation({
  calendarGoals: [armyGoal],
  savedRaces: [army, yonkers, { id: 'november', race_name: 'November 10K', race_date: '2026-11-15', status: 'upcoming', goal_time_seconds: 3000 }],
  todayISO: today,
})
assert.equal(ambiguous.kind, 'review')
assert.equal(ambiguous.reason, 'ambiguous')

const liftExecution = {
  hasPlan: true, hasDay: true, isRest: false, date: today, week: 5,
  sessions: [{ id: 'lift-5', kind: 'lift', completed: false }],
  run: null,
  lift: { id: 'lift-5', kind: 'lift', completed: false },
}
const green = { available: true, score: 80, band: 'GREEN' }
const travelingLift = deriveTravelTrainingChoices({
  execution: liftExecution,
  checkinData: { life_flags: '["traveling"]' },
  readiness: green,
  activeInjury: null,
  hasRunRecordedToday: false,
})
assert.equal(travelingLift.shouldPrompt, true)
assert.ok(travelingLift.choices.some((choice) => choice.kind === 'bodyweight_strength' && choice.sessionId === 'lift-5'))
assert.ok(travelingLift.choices.some((choice) => choice.kind === 'recovery'))
assert.ok(travelingLift.choices.some((choice) => choice.kind === 'keep'))

const scheduledRun = { id: 'run-5', kind: 'run', type: 'easy', distance_miles: 4, target_zone: 'Zone 2', completed: false }
const runExecution = {
  hasPlan: true, hasDay: true, isRest: false, date: today, week: 5,
  sessions: [scheduledRun], run: scheduledRun, lift: null,
}
const travelingRun = deriveTravelTrainingChoices({
  execution: runExecution,
  checkinData: { lifeFlags: ['traveling'] },
  readiness: green,
  activeInjury: null,
  hasRunRecordedToday: false,
})
const scheduledChoice = travelingRun.choices.find((choice) => choice.kind === 'scheduled_run')
assert.equal(scheduledChoice.routeState.planSessionId, 'run-5')
assert.equal(scheduledChoice.routeState.currentWeek, 5)
assert.equal(scheduledChoice.routeState.scheduledRun, scheduledRun)

const ordinaryRun = deriveTravelTrainingChoices({
  execution: runExecution,
  checkinData: { life_flags: [] },
  adaptationProposal: null,
  readiness: green,
})
assert.equal(ordinaryRun.shouldPrompt, false, 'ordinary planned run does not add duplicate coaching')

const restExecution = { hasPlan: true, hasDay: true, isRest: true, date: today, week: 5, sessions: [], run: null, lift: null }
const gapProposal = { status: 'proposal', evidence: [{ signal: 'run_gap', daysSinceRun: 8 }] }
const genericTrainingGapProposal = { status: 'proposal', evidence: [{ signal: 'training_gap', daysSinceRun: 8 }] }
const recoveryChoices = deriveTravelTrainingChoices({
  execution: restExecution,
  adaptationProposal: gapProposal,
  readiness: { available: true, score: 58, band: 'AMBER' },
  activeInjury: null,
  hasRunRecordedToday: false,
})
const recoveryRun = recoveryChoices.choices.find((choice) => choice.kind === 'recovery_run')
assert.ok(recoveryRun)
assert.equal(recoveryRun.workout.duration_min, 20)
assert.ok(recoveryRun.workout.distance_miles <= 2)
assert.equal(recoveryRun.workout.target_zone, 'Zone 1-2')
assert.equal(recoveryRun.workout.walking_allowed, true)
assert.equal(recoveryRun.routeState.planSessionId, null)

for (const unsafe of [
  { activeInjury: { id: 'injury-1' }, readiness: green, hasRunRecordedToday: false },
  { activeInjury: null, readiness: { available: true, score: 30, band: 'RED' }, hasRunRecordedToday: false },
  { activeInjury: null, readiness: { available: false, score: null, band: null }, hasRunRecordedToday: false },
  { activeInjury: null, readiness: green, hasRunRecordedToday: true },
]) {
  const result = deriveTravelTrainingChoices({ execution: restExecution, adaptationProposal: gapProposal, ...unsafe })
  assert.equal(result.choices.some((choice) => choice.kind === 'recovery_run'), false)
}

const genericGapChoices = deriveTravelTrainingChoices({
  execution: restExecution,
  adaptationProposal: genericTrainingGapProposal,
  readiness: green,
  activeInjury: null,
  hasRunRecordedToday: false,
})
assert.equal(genericGapChoices.shouldPrompt, false)
assert.equal(genericGapChoices.choices.some((choice) => choice.kind === 'recovery_run'), false)

const injuredLift = deriveTravelTrainingChoices({
  execution: liftExecution,
  checkinData: { life_flags: ['traveling'] },
  readiness: green,
  activeInjury: { id: 'injury-1' },
})
assert.equal(injuredLift.choices.some((choice) => choice.kind === 'bodyweight_strength'), false)
const checkinInjuredLift = deriveTravelTrainingChoices({
  execution: liftExecution,
  checkinData: { life_flags: '["traveling","injured"]' },
  readiness: green,
  activeInjury: null,
})
assert.equal(checkinInjuredLift.choices.some((choice) => choice.kind === 'bodyweight_strength'), false)
const poorLift = deriveTravelTrainingChoices({
  execution: liftExecution,
  checkinData: { life_flags: ['traveling'] },
  readiness: { available: true, score: 30, band: 'RED' },
  activeInjury: null,
})
assert.equal(poorLift.choices.some((choice) => choice.kind === 'bodyweight_strength'), false)
const unknownReadinessLift = deriveTravelTrainingChoices({
  execution: liftExecution,
  checkinData: { life_flags: ['traveling'] },
  readiness: { available: false, score: null, band: null },
  activeInjury: null,
})
assert.equal(unknownReadinessLift.choices.some((choice) => choice.kind === 'bodyweight_strength'), false)

const normalized = normalizeTravelWorkoutOverride({
  travelRecovery: true,
  source: 'travel_recovery',
  date: today,
  duration_min: 180,
  distance_miles: 20,
  target_zone: 'Zone 5',
  pace_target: 'Sprint uphill intervals at race pace',
  planSessionId: 'steal-plan-credit',
  currentWeek: 99,
})
assert.equal(normalized.duration_min, 20)
assert.equal(normalized.distance_miles, 2)
assert.equal(normalized.target_zone, 'Zone 1-2')
assert.match(normalized.pace_target, /conversational/i)
assert.equal(normalized.planSessionId, null)
assert.equal(normalized.currentWeek, null)
assert.doesNotMatch(`${normalized.title} ${normalized.pace_target} ${normalized.steps.join(' ')}`, /sprint|hill|interval|tempo|race effort/i)
assert.equal(normalizeTravelWorkoutOverride({ type: 'tempo', planSessionId: 'bad' }), null)
assert.equal(normalizeTravelWorkoutOverride({ travelRecovery: true, type: 'tempo' }), null)

const planSource = fs.readFileSync(new URL('../src/pages/Plan.jsx', import.meta.url), 'utf8')
assert.match(planSource, /api\.post\('\/plans\/generate-for-races',\s*\{\s*race_ids:\s*racePlanReconciliation\.orderedRaceIds,?\s*\}\)/)
assert.match(planSource, /setRaceReconciliationNotice[\s\S]*await loadAll\(\)/)
assert.match(planSource, /disabled=\{busy\}/)

const promptSource = fs.readFileSync(new URL('../src/components/TravelTrainingPrompt.jsx', import.meta.url), 'utf8')
assert.match(promptSource, /api\.post\('\/plans\/today\/bodyweight-alternative'/)
assert.match(promptSource, /planSessionId:\s*choice\.sessionId[\s\S]*currentWeek:\s*choice\.currentWeek/)
assert.match(promptSource, /min-h-11[\s\S]*role="status"|role="status"[\s\S]*min-h-11/)

const logRunSource = fs.readFileSync(new URL('../src/pages/LogRun.jsx', import.meta.url), 'utf8')
assert.match(logRunSource, /normalizeTravelWorkoutOverride\(location\.state\?\.travelWorkoutOverride\)/)

console.log('TRAVEL TRAINING FRONTEND SMOKE OK')
