export function candidateFeasibilityCanApply(plan = {}) {
  const feasibility = String(plan?.overall_feasibility || '').toLowerCase()
  if (feasibility === 'supported' || feasibility === 'stretch') return true
  if (['unvalidated', 'at_risk'].includes(feasibility)
    && plan.goal_backward_engine_version === 'goal-backward-coaching-v2.4'
    && plan.canonical_workout_schema_version === 1
    && /^(?:sha256:)?[a-f0-9]{64}$/.test(String(plan.canonical_session_set_hash || ''))) return true
  if (feasibility !== 'not_applicable') return false
  const goals = Array.isArray(plan?.goals) ? plan.goals : plan?.goal ? [plan.goal] : []
  return !goals.some((goal) => /^\d{4}-\d{2}-\d{2}$/.test(String(goal?.date || goal?.raceDate || goal?.race_date || '')))
}
