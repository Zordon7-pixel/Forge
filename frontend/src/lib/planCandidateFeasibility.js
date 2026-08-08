export function candidateFeasibilityCanApply(plan = {}) {
  const feasibility = String(plan?.overall_feasibility || '').toLowerCase()
  if (feasibility === 'supported' || feasibility === 'stretch') return true
  if (feasibility !== 'not_applicable') return false
  const goals = Array.isArray(plan?.goals) ? plan.goals : plan?.goal ? [plan.goal] : []
  return !goals.some((goal) => /^\d{4}-\d{2}-\d{2}$/.test(String(goal?.date || goal?.raceDate || goal?.race_date || '')))
}
