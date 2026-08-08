function normalizePlanningUserId(userId) {
  const normalized = String(userId || '').trim();
  if (!normalized) {
    const err = new Error('Planning mutation requires an owner');
    err.code = 'PLANNING_OWNER_REQUIRED';
    throw err;
  }
  return normalized;
}

async function incrementPlanningInputRevision(tx, userId) {
  if (!tx || typeof tx.get !== 'function') {
    throw new TypeError('Planning revision increment requires a transaction');
  }
  const normalizedUserId = normalizePlanningUserId(userId);
  const row = await tx.get(
    `UPDATE users
     SET planning_input_revision = planning_input_revision + 1
     WHERE id = ?
     RETURNING planning_input_revision`,
    [normalizedUserId]
  );
  if (!row) {
    const err = new Error('Planning owner no longer exists');
    err.code = 'AUTH_ACCOUNT_DELETED';
    throw err;
  }
  return Number(row.planning_input_revision);
}

function createPlanningInputMutationRunner(withUserMutation) {
  if (typeof withUserMutation !== 'function') {
    throw new TypeError('Planning mutation runner requires withUserMutation');
  }

  return async function withPlanningInputMutation(userId, mutation) {
    if (typeof mutation !== 'function') throw new TypeError('Planning mutation callback is required');
    const normalizedUserId = normalizePlanningUserId(userId);
    return withUserMutation(normalizedUserId, async (tx) => {
      const result = await mutation(tx);
      await incrementPlanningInputRevision(tx, normalizedUserId);
      return result;
    });
  };
}

module.exports = {
  createPlanningInputMutationRunner,
  incrementPlanningInputRevision,
  normalizePlanningUserId,
};
