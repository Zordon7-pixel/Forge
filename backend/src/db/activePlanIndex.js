const UNIQUE_ACTIVE_PLAN_INDEX_SQL = "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_plans_one_active_per_user ON user_plans(user_id) WHERE status='active'";

async function ensureUniqueActiveUserPlanIndex(query) {
  if (typeof query !== 'function') throw new TypeError('Active plan index check requires a query function');
  const duplicateResult = await query(`
    SELECT COUNT(*)::int AS duplicate_users
    FROM (
      SELECT user_id
      FROM user_plans
      WHERE status='active'
      GROUP BY user_id
      HAVING COUNT(*) > 1
    ) duplicate_owners
  `);
  const duplicateCount = Number(duplicateResult.rows?.[0]?.duplicate_users || 0);
  if (duplicateCount > 0) {
    const err = new Error(`Duplicate active plans require guarded repair for ${duplicateCount} athlete account(s)`);
    err.code = 'DUPLICATE_ACTIVE_USER_PLANS';
    err.duplicateCount = duplicateCount;
    throw err;
  }
  await query(UNIQUE_ACTIVE_PLAN_INDEX_SQL);
}

module.exports = {
  ensureUniqueActiveUserPlanIndex,
  UNIQUE_ACTIVE_PLAN_INDEX_SQL,
};
