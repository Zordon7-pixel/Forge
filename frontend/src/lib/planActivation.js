function planData(activePlan = null) {
  return activePlan?.plan_data || activePlan?.plan_json || {}
}

export function activePlanGoals(activePlan = null) {
  const data = planData(activePlan)
  if (Array.isArray(data.goals) && data.goals.length) return data.goals
  return data.goal ? [data.goal] : []
}

export function activePlanRaceIds(activePlan = null) {
  return activePlanGoals(activePlan)
    .map((goal) => String(goal?.raceId || goal?.race_id || '').trim())
    .filter(Boolean)
}

function sameOrderedIds(actual = [], expected = []) {
  return actual.length === expected.length
    && actual.every((value, index) => String(value) === String(expected[index]))
}

function positiveSeconds(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null
}

export function verifyRaceRemovalActivation({
  races = [],
  activePlan = null,
  activePlanReadConfirmed = true,
  removedRaceId,
  expectedRemainingRaceIds = null,
} = {}) {
  const removedId = String(removedRaceId || '')
  const raceStillExists = races.some((race) => String(race?.id || '') === removedId)
  const activeRaceIds = activePlanRaceIds(activePlan)
  const removedGoalStillActive = activeRaceIds.includes(removedId)
  const expected = Array.isArray(expectedRemainingRaceIds)
    ? expectedRemainingRaceIds.map(String)
    : null
  const exactReplacement = expected === null || sameOrderedIds(activeRaceIds, expected)
  return {
    activeRaceIds,
    activePlanReadConfirmed,
    confirmed: activePlanReadConfirmed && !raceStillExists && !removedGoalStillActive && exactReplacement,
    exactReplacement,
    raceStillExists,
    removedGoalStillActive,
  }
}

export function verifyHyroxPlanActivation({
  planResponse = {},
  expectedUserPlanId,
  hyroxRace,
  secondaryRaceId = '',
} = {}) {
  const activePlan = planResponse?.plan || null
  const goals = activePlanGoals(activePlan)
  const activeRaceIds = activePlanRaceIds(activePlan)
  const expectedRaceIds = [hyroxRace?.id, secondaryRaceId].filter(Boolean).map(String)
  const expectedHyroxId = String(hyroxRace?.id || '')
  const hyroxGoal = expectedHyroxId
    ? goals.find((goal) => String(goal?.raceId || goal?.race_id || '') === expectedHyroxId)
    : null
  const expectedTarget = positiveSeconds(hyroxRace?.goal_time_seconds)
  const actualTarget = positiveSeconds(hyroxGoal?.goalTimeSeconds ?? hyroxGoal?.goal_time_seconds)
  const expectedDate = String(hyroxRace?.event_local_date || hyroxRace?.race_date || '')
  const actualDate = String(hyroxGoal?.eventLocalDate || hyroxGoal?.date || hyroxGoal?.dateISO || '')
  const expectedFormat = String(hyroxRace?.event_format || '')
  const actualFormat = String(hyroxGoal?.division || hyroxGoal?.event_format || '')
  const expectedCategory = String(hyroxRace?.event_category || '')
  const actualCategory = String(hyroxGoal?.category || hyroxGoal?.event_category || '')
  const userPlanMatches = String(planResponse?.user_plan?.id || '') === String(expectedUserPlanId || '')
  const exactGoals = sameOrderedIds(activeRaceIds, expectedRaceIds)
  const hyroxTruthMatches = !expectedHyroxId || (Boolean(hyroxGoal)
    && actualDate === expectedDate
    && actualFormat === expectedFormat
    && actualCategory === expectedCategory
    && actualTarget === expectedTarget)
  return {
    activeRaceIds,
    confirmed: userPlanMatches && exactGoals && hyroxTruthMatches,
    exactGoals,
    expectedRaceIds,
    hyroxTruthMatches,
    userPlanMatches,
  }
}
