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

async function resolveAssignedPlanForDate(userId, get, options = {}) {
  if (typeof get !== 'function') throw new TypeError('Plan assignment resolver requires a database getter');
  const ownerId = String(userId || '').trim();
  if (!ownerId) throw new TypeError('Plan assignment resolver requires a user ID');
  const planningDateLocal = dateOnly(options.planningDateLocal)
    || new Date().toISOString().slice(0, 10);
  let assigned = await get(`
    SELECT up.id as user_plan_id, up.plan_id, up.current_week, up.started_at, up.status, up.progress_json,
           up.plan_version, up.lineage_id, up.supersedes_user_plan_id, up.effective_from,
           tp.*
    FROM user_plans up
    JOIN training_plans tp ON tp.id = up.plan_id
    WHERE up.user_id = ? AND up.status = 'active'
    ORDER BY up.created_at DESC, up.id DESC
    LIMIT 1
  `, [ownerId]);
  const visited = new Set();
  while (shouldFollowSupersededAssignment(assigned, planningDateLocal, options)) {
    const predecessorId = String(assigned.supersedes_user_plan_id);
    if (visited.has(predecessorId)) throw new Error('Plan assignment lineage contains a cycle');
    visited.add(predecessorId);
    const predecessor = await get(`
      SELECT up.id as user_plan_id, up.plan_id, up.current_week, up.started_at, up.status, up.progress_json,
             up.plan_version, up.lineage_id, up.supersedes_user_plan_id, up.effective_from,
             tp.*
      FROM user_plans up
      JOIN training_plans tp ON tp.id = up.plan_id
      WHERE up.id=? AND up.user_id=?
      LIMIT 1
    `, [predecessorId, ownerId]);
    if (!predecessor) throw new Error('Plan assignment predecessor is unavailable');
    assigned = predecessor;
  }
  return assigned;
}

async function resolveActivePlanForDate(userId, get, options = {}) {
  const assigned = await resolveAssignedPlanForDate(userId, get, options);
  if (assigned) return { source: 'assigned', row: assigned };
  const legacy = await get(
    'SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [String(userId)]
  );
  return legacy ? { source: 'legacy', row: { ...legacy, plan_id: legacy.plan_id || legacy.id } } : null;
}

module.exports = {
  assignmentEffectiveFrom,
  dateOnly,
  isAssignmentEffective,
  resolveActivePlanForDate,
  resolveAssignedPlanForDate,
  shouldFollowSupersededAssignment,
};
