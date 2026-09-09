import { racePlanGenerationTarget } from './planCalendar.js'

export function buildRacePlanGoalRebuildRequest({
  plan,
  profile = {},
  raceIds = [],
  completionFirst = false,
  choice,
} = {}) {
  const planData = plan?.plan_data || {}
  const strengthPolicy = planData.strengthPolicy || {}
  const schedulePreferences = planData.schedulePreferences || {}
  const hybridTarget = racePlanGenerationTarget(plan, profile)
  const profileRunDays = Number(hybridTarget.runDaysPerWeek)
  const planRunDays = Number(schedulePreferences.runDaysPerWeek)

  return {
    race_ids: raceIds.map(String),
    choice: ['train_for_target', 'adjust_goal', 'completion_first'].includes(choice)
      ? choice
      : completionFirst ? 'completion_first' : 'adjust_goal',
    target: {
      ...hybridTarget,
      trainingDays: Array.isArray(schedulePreferences.trainingDays)
        ? schedulePreferences.trainingDays : [],
      runDaysPerWeek: profileRunDays > 0
        ? profileRunDays
        : planRunDays > 0 ? planRunDays : null,
      strengthGoal: strengthPolicy.goal || 'maintain',
      equipment: Array.isArray(strengthPolicy.equipment) ? strengthPolicy.equipment : [],
    },
  }
}

export async function executeRacePlanGoalRebuild({
  plan,
  profile,
  raceIds,
  completionFirst,
  choice,
  previewAndApply,
} = {}) {
  if (typeof previewAndApply !== 'function') {
    throw new TypeError('previewAndApply is required')
  }
  const request = buildRacePlanGoalRebuildRequest({
    plan,
    profile,
    raceIds,
    completionFirst,
    choice,
  })
  return previewAndApply('/plans/generate-for-races', request, { timeout: 90000 })
}
