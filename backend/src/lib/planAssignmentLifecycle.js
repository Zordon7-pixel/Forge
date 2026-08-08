const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(value) {
  const date = String(value || '').slice(0, 10);
  return DATE_ONLY.test(date) ? date : null;
}

function assignmentEffectiveFrom(row = {}) {
  return dateOnly(row.effective_from) || dateOnly(row.started_at);
}

function isAssignmentEffective(row, planningDateLocal) {
  const planningDate = dateOnly(planningDateLocal);
  if (!planningDate) return false;
  const effectiveFrom = assignmentEffectiveFrom(row);
  return !effectiveFrom || effectiveFrom <= planningDate;
}

function shouldFollowSupersededAssignment(row, planningDateLocal, { includeFuture = false } = {}) {
  if (!row || includeFuture || isAssignmentEffective(row, planningDateLocal)) return false;
  return Boolean(String(row.supersedes_user_plan_id || '').trim());
}

module.exports = {
  assignmentEffectiveFrom,
  dateOnly,
  isAssignmentEffective,
  shouldFollowSupersededAssignment,
};
