const { canonicalHash, addDays } = require('./racePlanPolicy');
const canonical = require('./canonicalWorkout');
const policy = require('./activityAdaptationAuthority');
const running = require('./runningDoseAccounting');
const { resolveSessionStress, aggregateWeeklyStress } = require('./goalBackwardLoad');
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => canonicalHash(a) === canonicalHash(b);
const failure = code => { throw Object.assign(new Error(code), { code, status: 409 }); };

// Only call on newly owned JSON data. Freezing these request-local values
// makes the existing derived-dose memo eligible; it does not cache validation
// or replace any source/owner/revision check.
function freezeOwnedJson(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeOwnedJson);
    Object.freeze(value);
  }
  return value;
}

function immutableProgramSet(value) {
  // Existing constructor output may safely share deeply immutable subgraphs.
  // The predicate rejects shallow freezing and mutable/custom internal state.
  if (value && typeof value === 'object' && require('./immutableOwnJson').immutableOwnJson(value)) return value;
  const owned = require('./goalBackwardRecoveryMaterial').ownMaterializedProgramSnapshot(value);
  // The closed snapshot rejects accessors, proxies, cycles and shared mutable
  // graphs before cloning. Preserve the public JSON object's normal prototype.
  return owned ? freezeOwnedJson(clone(owned)) : null;
}

function canonicalSetPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { plan_generation_candidate_ref, selected_candidate_id, selected_candidate_hash, ...set } = payload;
  return set.program_contract?.version === 'complete-road-program-v1' ? immutableProgramSet(set) : set;
}

function rootCandidateHash(set) {
  if (!canonical.validateCanonicalSessionSet(set).valid) return null;
  let original = set;
  while (original.activity_adaptation) {
    original = predecessorFor(original);
    if (!original) return null;
  }
  return original.candidate_hash;
}

function completionPredecessorHashes(plan) {
  const result = new Map();
  try {
    const header = plan?.programCanonicalIdentity;
    if (!header?.activity_adaptation) return result;
    const byId = new Map((plan.weeks || []).flatMap(week => (week.days || []).flatMap(day => day.sessions || []))
      .map(session => {
        const { removal_session_id, ...value } = session;
        return [value.session_id, value];
      }));
    const current = { ...header, sessions: header.session_content_hashes.map(entry => byId.get(entry.session_id)) };
    if (!canonical.validateCanonicalSessionSet(current).valid) return result;
    const anchors = new Map(current.sessions.map(session => [session.session_id, session]));
    let cursor = current;
    while (cursor.activity_adaptation) {
      cursor = predecessorFor(cursor);
      if (!cursor || !canonical.validateCanonicalSessionSet(cursor).valid) return new Map();
      for (const previous of cursor.sessions) {
        const anchor = anchors.get(previous.session_id);
        // Global plan revision changes do not erase a recorded completion of
        // this exact unchanged prescription. Changed material gets no credit.
        if (!anchor || anchor.session_revision !== previous.session_revision
          || anchor.scheduled_local_date !== previous.scheduled_local_date || anchor.plan_id !== previous.plan_id
          || anchor.workout_family !== previous.workout_family || !equal(anchor.goal_ids, previous.goal_ids)
          || !equal(anchor.steps, previous.steps)) continue;
        const hashes = result.get(previous.session_id) || new Set();
        hashes.add(previous.content_hash); result.set(previous.session_id, hashes);
      }
    }
    return result;
  } catch { return new Map(); }
}

function canonicalRebuild(value) {
  const input = clone(value);
  delete input.content_hash; delete input.canonical_workout_schema_version;
  return canonical.buildCanonicalSession(input);
}

function reductionRest(original, context) {
  const next = { ...clone(original), plan_revision: original.plan_revision + 1,
    session_revision: original.session_revision + 1, workout_family: 'rest', kind: 'rest', type: 'rest',
    workout_type: 'rest', workout_id: 'rest', title: 'Recovery — no workout prescribed', description: 'This session is withheld, not completed or moved to another day.',
    steps: [], main: [], exercises: [], warmup: [], recovery: [], duration_min: 0, distance_miles: 0,
    pace_target: null, target_zone: null, intensity: 'rest', durationIsEstimated: false,
    activity_reduction: policy.buildSessionReduction(original, context, 'REST_WITHHOLDING') };
  if (String(original.workout_family).startsWith('strength_')) {
    next.strength_withholding = policy.buildWithholdingLedger(original, [], context);
  }
  delete next.activity_plan_lineage;
  return canonicalRebuild(next);
}

function reductionRecovery(original, context, { duration_s, training_age_class } = {}) {
  if (!Number.isSafeInteger(duration_s) || duration_s <= 0) return reductionRest(original, context);
  const existingEasy = running.FAMILIES.has(original.workout_family);
  let registry, before;
  try {
    registry = existingEasy ? null : policy.buildRecoveryRegistry(original, context);
    before = existingEasy ? running.canonicalRunDose(original, { allowEffortOnly: true }) : registry.original_dose;
  } catch { return reductionRest(original, context); }
  if (!before || duration_s > before.duration_s) return reductionRest(original, context);
  const distance = before.distance_basis === 'CANONICAL_DISTANCE_PRESCRIPTION'
    ? Math.floor(before.distance_m * duration_s / before.duration_s) : null;
  const effort = policy.originalEffortEnvelope(original);
  if (!effort) return reductionRest(original, context);
  const target = { duration_s, ...(distance === null ? {} : { distance_m: distance }),
    rpe_range: { minimum: Math.min(2, effort.minimum), maximum: Math.min(4, effort.maximum) },
    ...(effort.heart_rate_range_bpm === undefined ? {} : { heart_rate_range_bpm: clone(effort.heart_rate_range_bpm) }) };
  const next = { ...clone(original), session_revision: original.session_revision + 1,
    plan_revision: original.plan_revision + 1, workout_family: 'recovery_run', kind: 'run', type: 'recovery',
    workout_type: 'recovery', workout_id: 'recovery_run', title: 'Useful recovery run', description: 'Easy effort only; stop if symptoms worsen. This replaces, rather than postpones, the original work.',
    duration_min: duration_s / 60, ...(distance === null ? { distance_miles: null } : { distance_miles: distance / 1609.344 }),
    intensity: 'easy', pace_target: null, target_zone: null, durationIsEstimated: false,
    steps: [{ step_id: `${original.session_id}-activity-recovery`, order: 1, type: 'run', step_role: 'WORK',
      workout_family: 'recovery_run', target, provenance: [{ source_evidence_ids: context.evidence_ids,
        derived_athlete_state_field: 'accepted_original_prescription_recovery', policy_id: policy.VERSION, policy_version: 1,
        confidence: 'HIGH', derived_at: context.observed_at, decision_id: original.decision_id,
        canonical_units: [...(distance === null ? ['s', 'rpe'] : ['s', 'm', 'rpe']),
          ...(effort.heart_rate_range_bpm === undefined ? [] : ['bpm'])] }] }],
    activity_reduction: policy.buildSessionReduction(original, context, 'RECOVERY_CONVERSION') };
  delete next.activity_plan_lineage;
  try {
    const session = existingEasy ? canonicalRebuild(next) : running.bindRunningDosePool([next], policy.recoverySource(registry))[0];
    if (!policy.validateSessionReduction(session)
      || !require('./prescriptionIntegrity').validateCanonicalPresentationFloor(session, { training_age_class }).valid) {
      return reductionRest(original, context);
    }
    return session;
  } catch { return reductionRest(original, context); }
}

function reductionStrength(original, context, retainedSets, { training_age_class, siblings = [] } = {}) {
  if (!Array.isArray(retainedSets) || retainedSets.length !== original.steps.length
    || !siblings.some(sibling => sibling.session_id === original.session_id)) return reductionRest(original, context);
  const steps = original.steps.flatMap((step, index) => retainedSets[index] === 0 ? []
    : [{ ...clone(step), target: { ...clone(step.target), sets: retainedSets[index] } }]);
  if (!steps.length) return reductionRest(original, context);
  const next = { ...clone(original), plan_revision: original.plan_revision + 1, session_revision: original.session_revision + 1,
    activity_reduction: policy.buildSessionReduction(original, context, 'STRENGTH_WITHHOLDING'),
    strength_withholding: policy.buildWithholdingLedger(original, steps, context), steps };
  delete next.activity_plan_lineage;
  // The execution adapters stay derived from the retained canonical targets.
  for (const field of ['main', 'exercises']) if (Array.isArray(next[field])) {
    next[field] = next[field].flatMap((exercise, index) => retainedSets[index] === 0 ? [] : [{ ...exercise, sets: retainedSets[index] }]);
  }
  const session = canonicalRebuild(next);
  return require('./goalBackwardValidators').validatePresentationFloor(
    siblings.map(sibling => sibling.session_id === session.session_id ? session : sibling), { training_age_class }).valid
    ? session : reductionRest(original, context);
}

function reboundUnchanged(original, revision, parentHash = null) {
  const next = clone(original); next.plan_revision = revision;
  if (next.activity_reduction) {
    if (revision > original.plan_revision) {
      if (!parentHash || revision !== original.plan_revision + 1) failure('ACTIVITY_REBIND_PARENT_REQUIRED');
      next.activity_plan_lineage = [...(next.activity_plan_lineage || []), { plan_revision: revision, parent_set_hash: parentHash }];
    } else if (revision < original.plan_revision) {
      next.activity_plan_lineage = (next.activity_plan_lineage || []).filter(entry => entry.plan_revision <= revision);
      if (!next.activity_plan_lineage.length) delete next.activity_plan_lineage;
    }
  }
  next.content_hash = canonical.canonicalWorkoutHash(next);
  return next;
}

function totals(sessions) {
  return sessions.reduce((sum, session) => {
    for (const [key, value] of Object.entries(session.derived_totals)) sum[key] = (sum[key] || 0) + value;
    return sum;
  }, {});
}

function rebuildSet(parent, sessions, context, observationArtifact) {
  const { sessions: ignored, ...header } = clone(parent);
  const receiptBody = { version: policy.VERSION, context: clone(context), parent_header: header,
    observation_artifact: clone(observationArtifact) };
  const next = { ...header, plan_revision: parent.plan_revision + 1, sessions,
    derived_totals: totals(sessions), session_content_hashes: sessions.map(session => ({ session_id: session.session_id, content_hash: session.content_hash })),
    activity_adaptation: { ...receiptBody, receipt_hash: canonicalHash(receiptBody) } };
  next.content_hash = canonical.canonicalSessionSetHash(next);
  next.candidate_hash = canonicalHash({ candidate_skeleton_hash: next.candidate_skeleton_hash, canonical_session_set_hash: next.content_hash });
  return next;
}

function predecessorFor(set) {
  return require('./activityValidationScope').memoizeImmutableActivity('predecessor', set,
    () => predecessorForUncached(set));
}

function predecessorForUncached(set) {
  const receipt = set.activity_adaptation;
  if (!receipt || Object.keys(receipt).sort().join('|') !== ['version', 'context', 'parent_header', 'receipt_hash', 'observation_artifact'].sort().join('|')) return null;
  const { receipt_hash: hash, ...body } = receipt;
  if (receipt.version !== policy.VERSION || hash !== canonicalHash(body) || !policy.validateContext(receipt.context)
    || !require('./activityObservation').validateObservation(receipt.observation_artifact, receipt.context)) return null;
  const header = receipt.parent_header;
  if (!header || header.content_hash !== receipt.context.parent_canonical_set_hash
    || header.plan_id !== receipt.context.parent_plan_id || header.plan_revision !== receipt.context.parent_plan_revision
    || set.plan_revision !== header.plan_revision + 1 || !equal(set.program_contract, header.program_contract)) return null;
  const originals = set.sessions.map(session => session.activity_reduction
    && session.activity_reduction.context.parent_canonical_set_hash === header.content_hash
    ? clone(session.activity_reduction.original) : reboundUnchanged(session, header.plan_revision));
  return freezeOwnedJson({ ...clone(header), sessions: originals });
}

function validateActivitySet(set, { authenticatedParent = null, authenticatedContext = null } = {}) {
  // Context/parent comparisons are not memoized: a different owner, accepted
  // parent or observation must still be rejected even inside the same request.
  const valid = require('./activityValidationScope').memoizeImmutableActivity('activity-set', set,
    () => validateActivitySetUncached(set));
  if (!valid) return false;
  try {
    return (!authenticatedParent || equal(predecessorFor(set), authenticatedParent))
      && (!authenticatedContext || equal(set.activity_adaptation.context, authenticatedContext));
  } catch { return false; }
}

function validateActivitySetUncached(set) {
  try {
    const parent = predecessorFor(set);
    if (!parent || !canonical.validateCanonicalSessionSet(parent).valid) return false;
    const context = set.activity_adaptation.context;
    if (!equal(context.parent_horizon, { start_date: parent.program_contract.start_date, end_date: parent.program_contract.end_date })
      || context.parent_goals_hash !== canonicalHash(parent.program_contract.goals)) return false;
    const originals = new Map(parent.sessions.map(session => [session.session_id, session]));
    const changed = [];
    for (const session of set.sessions) {
      const original = originals.get(session.session_id);
      if (!original || session.scheduled_local_date !== original.scheduled_local_date) return false;
      const altered = session.activity_reduction?.context.parent_canonical_set_hash === parent.content_hash;
      if (altered) {
        if (!policy.validateSessionReduction(session) || !equal(session.activity_reduction.original, original)
          || !equal(session.activity_reduction.context, context)) return false;
        changed.push(session.session_id);
      } else if (!equal(reboundUnchanged(session, original.plan_revision), original)
        || session.activity_reduction && session.activity_plan_lineage?.at(-1)?.parent_set_hash !== parent.content_hash) return false;
      const before = resolveSessionStress(original), after = resolveSessionStress(session);
      if (!before.valid || !after.valid || after.vector.some((value, index) => value > before.vector[index] + 1e-6)) return false;
    }
    if (set.sessions.length !== parent.sessions.length || !equal(changed.slice().sort(), context.affected_session_ids.slice().sort())) return false;
    return true;
  } catch { return false; }
}

function nonIncreasingWindows(before, after) {
  const starts = [...new Set([...before, ...after].map(session => session.scheduled_local_date))].sort();
  const windows = starts.flatMap(start => [0, 6].map(offset => {
    const end = addDays(start, offset);
    const within = sessions => sessions.filter(session => session.scheduled_local_date >= start && session.scheduled_local_date <= end);
    const original = aggregateWeeklyStress(within(before));
    const proposed = aggregateWeeklyStress(within(after));
    return { start_date: start, end_date: end,
      original_vector: original.weekly_dimension_sum, proposed_vector: proposed.weekly_dimension_sum,
      valid: original.valid && proposed.valid && proposed.weekly_dimension_sum.every((value, index) => value <= original.weekly_dimension_sum[index] + 1e-6) };
  }));
  return { valid: windows.every(window => window.valid), windows, comparison_kind: 'FUTURE_PRESCRIPTION_NONINCREASE',
    observed_activity_bound_separately: true, observed_v3_vector_state: 'NOT_AVAILABLE', absolute_observed_plus_future_v3_budget_claimed: false };
}

function buildActivityCanonicalSuccessor({ parent, context, changes, training_age_class, observationArtifact }) {
  parent = immutableProgramSet(parent);
  if (!parent) failure('ACTIVITY_PARENT_IDENTITY_INVALID');
  if (!canonical.validateCanonicalSessionSet(parent).valid || !policy.validateContext(context)
    || parent.content_hash !== context.parent_canonical_set_hash
    || !require('./activityObservation').validateObservation(observationArtifact, context)) failure('ACTIVITY_PARENT_IDENTITY_INVALID');
  if (!Array.isArray(changes) || !equal(changes.map(change => change.session_id).sort(), context.affected_session_ids.slice().sort())) {
    failure('ACTIVITY_CHANGED_SESSION_SCOPE_INVALID');
  }
  const byId = new Map(changes.map(change => [change.session_id, change]));
  const sessions = parent.sessions.map(original => {
    const change = byId.get(original.session_id);
    if (!change) return reboundUnchanged(original, parent.plan_revision + 1, parent.content_hash);
    if (change.action === 'recovery') return reductionRecovery(original, context, { duration_s: change.duration_s, training_age_class });
    if (change.action === 'withhold_sets') return reductionStrength(original, context, change.retained_sets, { training_age_class, siblings: parent.sessions });
    if (change.action === 'rest') return reductionRest(original, context);
    failure('ACTIVITY_REDUCTION_ACTION_INVALID');
  });
  const next = freezeOwnedJson(rebuildSet(parent, sessions, context, observationArtifact));
  if (!validateActivitySet(next, { authenticatedParent: parent, authenticatedContext: context })) failure('ACTIVITY_SUCCESSOR_IDENTITY_INVALID');
  const windows = nonIncreasingWindows(parent.sessions.filter(session => session.scheduled_local_date >= context.planning_date),
    sessions.filter(session => session.scheduled_local_date >= context.planning_date));
  if (!windows.valid) failure('ACTIVITY_SUCCESSOR_LOAD_INCREASE');
  if (!canonical.validateCanonicalSessionSet(next).valid) failure('ACTIVITY_SUCCESSOR_CANONICAL_INVALID');
  return { canonical: next, load_reconciliation: windows };
}

module.exports = { canonicalRebuild, reductionRest, reductionRecovery, reductionStrength, reboundUnchanged,
  buildActivityCanonicalSuccessor, validateActivitySet, predecessorFor, nonIncreasingWindows,
  canonicalSetPayload, rootCandidateHash, completionPredecessorHashes };
