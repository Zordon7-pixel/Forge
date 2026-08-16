const {
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  addDays,
  canonicalHash,
} = require('./racePlanPolicy');

const RUNNING_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run', 'interval_run',
  'race_rhythm_run', 'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
  'assessment', 'race',
]);
const DIMENSIONS = Object.freeze([
  'aerobic', 'running_impact', 'lower_body_muscular', 'upper_body_muscular',
  'grip', 'neuromuscular', 'metabolic', 'event_specific_fatigue',
]);
const QUALIFYING_REDUCTION_REASONS = new Set([
  'TAPER_VOLUME_REDUCTION',
  'INJURY_SCOPE',
  'ILLNESS_RECOVERY',
  'RECOVERY_VOLUME_REDUCTION',
  'TRAINING_GAP_REBUILD',
  'CROSS_MODAL_FATIGUE_LIMIT',
]);
const SCOPED_REASONS = new Set([
  ...QUALIFYING_REDUCTION_REASONS,
  'SCHEDULE_CONSTRAINT',
  'MODIFY_IMPACT',
  'NO_RUNNING',
  'NO_LOWER_BODY',
  'NO_HIGH_INTENSITY',
  'FULL_REST',
]);
const BLOCK_MODALITIES = new Set([
  'running', 'running_impact', 'running_quality', 'lower_body_muscular',
  'lower_body_intensity', 'aerobic', 'metabolic', 'event_specific_fatigue',
]);
const SCOPE_ACTIONS = new Set([
  'MODIFY_IMPACT', 'NO_RUNNING', 'NO_LOWER_BODY', 'NO_HIGH_INTENSITY',
  'MODIFIED_SESSION_ONLY', 'FULL_REST',
]);
const MAX_RECEIPT_BYTES = 16 * 1024;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function dateOnly(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function finiteNonnegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function prefixedHash(value) {
  return `sha256:${canonicalHash(value)}`;
}

function evidenceRef(value) {
  const raw = String(value || '').trim();
  if (/^sha256:[a-f0-9]{64}$/.test(raw)) return raw;
  return raw ? prefixedHash({ evidence_identity: raw.slice(0, 512) }) : null;
}

function evidenceRefSet(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(evidenceRef).filter(Boolean))].sort();
}

function evidenceRefs(values) {
  return evidenceRefSet(values).slice(0, 16);
}

function sessionsFrom(container = {}) {
  if (Array.isArray(container)) return container;
  if (Array.isArray(container.sessions)) return container.sessions;
  return (container.weeks || []).flatMap((week) => (
    (week.days || week.sessions || []).flatMap((day) => (
      Array.isArray(day.sessions)
        ? day.sessions.map((session) => ({
          ...session,
          scheduled_local_date: session.scheduled_local_date ?? session.date
            ?? day.scheduled_local_date ?? day.date ?? null,
        }))
        : [day]
    ))
  ));
}

function sessionFamily(session = {}) {
  return String(session.workout_family ?? session.workoutFamily ?? session.family ?? '');
}

function sessionRole(session = {}) {
  return String(session.role ?? session.session_role ?? session.sessionRole ?? '').toUpperCase();
}

function distanceMeters(session = {}) {
  const direct = finiteNonnegative(
    session.running_distance_m ?? session.distance_m ?? session.distanceMeters
    ?? session.derived_totals?.distance_m,
  );
  if (direct !== null) return direct;
  const miles = finiteNonnegative(session.distance_miles ?? session.distanceMiles);
  return miles === null ? null : miles * 1609.344;
}

function runningDistanceObservation(container = {}, options = {}) {
  const start = dateOnly(options.start);
  const end = dateOnly(options.end);
  const windowRequested = Object.hasOwn(options, 'start') || Object.hasOwn(options, 'end');
  if (windowRequested && (!start || !end || start > end)) {
    return { state: 'UNKNOWN', distance_m: null, reason: 'RUNNING_WINDOW_UNKNOWN' };
  }
  const running = [];
  for (const session of sessionsFrom(container)) {
    if (!RUNNING_FAMILIES.has(sessionFamily(session))) continue;
    const date = dateOnly(session.scheduled_local_date ?? session.date);
    if (windowRequested && !date) {
      return { state: 'UNKNOWN', distance_m: null, reason: 'RUNNING_DATE_UNKNOWN' };
    }
    if ((start && date < start) || (end && date > end)) continue;
    running.push(session);
  }
  const distances = running.map(distanceMeters);
  if (distances.some((distance) => distance === null)) {
    return { state: 'UNKNOWN', distance_m: null, reason: 'RUNNING_DISTANCE_UNKNOWN' };
  }
  return {
    state: 'KNOWN',
    distance_m: round(distances.reduce((sum, distance) => sum + distance, 0), 3),
    reason: null,
  };
}

function normalizeScope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const scopeKind = String(input.scope_kind || '').toUpperCase();
  const reasonCode = String(input.reason_code || '').toUpperCase();
  const effectiveFrom = dateOnly(input.effective_from_local);
  const expiresAtRaw = String(input.expires_at || '');
  const expiresOnLocal = dateOnly(input.expires_on_local) || dateOnly(expiresAtRaw);
  const reevaluateAtRaw = String(input.reevaluate_at || '');
  const expiresAt = Number.isNaN(new Date(expiresAtRaw).getTime()) ? null : new Date(expiresAtRaw).toISOString();
  const reevaluateAt = Number.isNaN(new Date(reevaluateAtRaw).getTime()) ? null : new Date(reevaluateAtRaw).toISOString();
  const modalities = [...new Set((Array.isArray(input.affected_modalities) ? input.affected_modalities : [])
    .map((value) => String(value || '').toLowerCase()).filter((value) => BLOCK_MODALITIES.has(value)))].sort();
  const allDecisiveEvidenceIds = evidenceRefSet(input.decisive_evidence_ids);
  const decisiveEvidenceIds = allDecisiveEvidenceIds.slice(0, 16);
  const actionRaw = String(input.action || '').toUpperCase();
  const action = actionRaw ? (SCOPE_ACTIONS.has(actionRaw) ? actionRaw : null) : null;
  if (!['ACUTE', 'BLOCK'].includes(scopeKind) || !SCOPED_REASONS.has(reasonCode)
    || !effectiveFrom || !expiresAt || !expiresOnLocal || !reevaluateAt || !modalities.length
    || !decisiveEvidenceIds.length || allDecisiveEvidenceIds.length > 16
    || (actionRaw && !action)) return null;
  const effectiveStart = new Date(`${effectiveFrom}T00:00:00.000Z`).getTime();
  if (expiresOnLocal <= effectiveFrom
    || new Date(reevaluateAt).getTime() < effectiveStart
    || new Date(reevaluateAt).getTime() > new Date(expiresAt).getTime()) return null;
  const normalized = {
    scope_kind: scopeKind,
    reason_code: reasonCode,
    effective_from_local: effectiveFrom,
    expires_on_local: expiresOnLocal,
    expires_at: expiresAt,
    reevaluate_at: reevaluateAt,
    affected_modalities: modalities,
    decisive_evidence_ids: decisiveEvidenceIds,
    action,
    authorizes_material_reduction: input.authorizes_material_reduction === true,
    cross_modal_ledger_hash: /^sha256:[a-f0-9]{64}$/.test(String(input.cross_modal_ledger_hash || ''))
      ? String(input.cross_modal_ledger_hash) : null,
    measured_running_ceiling_m: finiteNonnegative(input.measured_running_ceiling_m),
  };
  return deepFreeze({
    ...normalized,
    scope_hash: prefixedHash(normalized),
  });
}

function acuteScope({ planningDate, evidenceIds, reasonCode, modalities, action }) {
  const expiresOnLocal = addDays(planningDate, 2);
  const normalized = normalizeScope({
    scope_kind: 'ACUTE',
    reason_code: reasonCode,
    effective_from_local: planningDate,
    expires_on_local: expiresOnLocal,
    expires_at: `${expiresOnLocal}T12:00:00.000Z`,
    reevaluate_at: `${addDays(planningDate, 1)}T12:00:00.000Z`,
    affected_modalities: modalities,
    decisive_evidence_ids: evidenceIds,
    authorizes_material_reduction: false,
    action,
  });
  return normalized;
}

function blockScope({
  planningDate,
  candidateWindowEnd,
  evidenceIds,
  reasonCode,
  modalities,
  action,
  authorizesMaterialReduction,
  crossModalLedgerHash = null,
  measuredRunningCeilingM = null,
}) {
  const expiresOnLocal = addDays(candidateWindowEnd, 1);
  return normalizeScope({
    scope_kind: 'BLOCK',
    reason_code: reasonCode,
    effective_from_local: planningDate,
    expires_on_local: expiresOnLocal,
    expires_at: `${expiresOnLocal}T12:00:00.000Z`,
    reevaluate_at: `${addDays(planningDate, 1)}T12:00:00.000Z`,
    affected_modalities: modalities,
    decisive_evidence_ids: evidenceIds,
    authorizes_material_reduction: authorizesMaterialReduction === true,
    action,
    cross_modal_ledger_hash: crossModalLedgerHash,
    measured_running_ceiling_m: measuredRunningCeilingM,
  });
}

function deriveScopedRecoveryState(input = {}) {
  const planningDate = dateOnly(input.planning_date_local);
  if (!planningDate) throw new Error('planning_date_local is required for recovery scope');
  const candidateWindowEnd = dateOnly(input.candidate_window_end_local) || addDays(planningDate, 6);
  const context = input.context || {};
  const safety = context.safety || {};
  const recovery = context.recovery || {};
  const checkin = context.checkin || {};
  const flags = new Set((Array.isArray(checkin.lifeFlags) ? checkin.lifeFlags : [])
    .map((value) => String(value || '').toLowerCase()));
  const injury = safety.activeInjury === true || safety.injuryNotesPresent === true
    || flags.has('injured');
  const illness = flags.has('sick') || flags.has('not_well');
  const rawRecovery = String(recovery.state || '').toUpperCase();
  const lowReadiness = ['LOW', 'RECOVERY'].includes(rawRecovery)
    || (finiteNonnegative(recovery.readinessScore) !== null && Number(recovery.readinessScore) < 45);
  let recoveryState = ['READY', 'NORMAL', 'CAUTION'].includes(rawRecovery) ? rawRecovery : 'UNKNOWN';
  let safetyAction = 'NORMAL';
  const scopes = [];
  const snapshotId = input.evidence_snapshot_id || prefixedHash({
    planning_date_local: planningDate,
    recovery_synced_at: recovery.syncedAt || null,
  });
  const injuryEvidenceIds = [
    safety.activeInjury === true ? `${snapshotId}:active-injury` : null,
    safety.injuryNotesPresent === true ? `${snapshotId}:injury-notes` : null,
    flags.has('injured') ? `${snapshotId}:injured-checkin` : null,
  ].filter(Boolean);
  const illnessEvidenceIds = [
    illness ? `${snapshotId}:illness-checkin` : null,
    illness && lowReadiness && recovery.syncedAt
      && (recovery.available === true || recovery.dataAvailable === true)
      ? `${snapshotId}:corroborating-recovery` : null,
  ].filter(Boolean);
  if (injury) {
    recoveryState = 'RECOVERY';
    safetyAction = 'MONITOR';
    const scope = blockScope({
      planningDate,
      candidateWindowEnd,
      evidenceIds: injuryEvidenceIds,
      reasonCode: 'INJURY_SCOPE',
      modalities: ['running_impact', 'lower_body_muscular'],
      action: 'MODIFY_IMPACT',
      authorizesMaterialReduction: injuryEvidenceIds.length >= 2,
    });
    if (scope) scopes.push(scope);
  } else if (illness) {
    recoveryState = 'RECOVERY';
    safetyAction = 'MONITOR';
    const corroborated = illnessEvidenceIds.length >= 2;
    const scope = corroborated ? blockScope({
      planningDate, candidateWindowEnd, evidenceIds: illnessEvidenceIds,
      reasonCode: 'ILLNESS_RECOVERY', modalities: ['running_quality', 'metabolic'],
      action: 'NO_HIGH_INTENSITY', authorizesMaterialReduction: true,
    }) : acuteScope({
      planningDate, evidenceIds: illnessEvidenceIds,
      reasonCode: 'ILLNESS_RECOVERY', modalities: ['running_quality', 'metabolic'],
      action: 'NO_HIGH_INTENSITY',
    });
    if (scope) scopes.push(scope);
  } else if (lowReadiness) {
    recoveryState = 'CAUTION';
    safetyAction = 'MONITOR';
    const scope = acuteScope({
      planningDate,
      evidenceIds: [snapshotId],
      reasonCode: 'RECOVERY_VOLUME_REDUCTION',
      modalities: ['running_quality', 'lower_body_intensity'],
      action: 'NO_HIGH_INTENSITY',
    });
    if (scope) scopes.push(scope);
  }
  const receipt = {
    recovery_state: recoveryState,
    safety_action: safetyAction,
    scopes,
    reason_codes: [...new Set(scopes.map((scope) => scope.reason_code))],
  };
  return deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
}

function deriveMaterialReductionScope(input = {}) {
  const planningDate = dateOnly(input.planning_date_local);
  const candidateWindowEnd = dateOnly(input.candidate_window_end_local);
  const decision = input.decision;
  if (!planningDate || !candidateWindowEnd || planningDate > candidateWindowEnd
    || !decision?.decision_id || !decision?.decision_hash) return null;
  const scopedRecovery = input.scoped_recovery_state || {};
  const existing = (Array.isArray(scopedRecovery.scopes) ? scopedRecovery.scopes : [])
    .map(normalizeScope)
    .filter((scope) => scope && scope.scope_kind === 'BLOCK'
      && scope.authorizes_material_reduction === true
      && scopeCoversCandidate(scope, {
        planning_date_local: planningDate,
        candidate_window_end_local: candidateWindowEnd,
      }));
  if (existing.length) {
    const priority = ['INJURY_SCOPE', 'ILLNESS_RECOVERY', 'RECOVERY_VOLUME_REDUCTION'];
    return existing.sort((left, right) => (
      priority.indexOf(left.reason_code) - priority.indexOf(right.reason_code)
      || left.scope_hash.localeCompare(right.scope_hash)
    ))[0];
  }
  const decisionEvidenceIds = [
    ...(decision.evidence_used || []).map((entry) => (
      typeof entry === 'string' ? entry : entry?.evidence_id ?? entry?.id
    )),
    ...(input.decision_evidence_ids || []),
    input.evidence_snapshot_id,
  ].filter(Boolean);
  if (String(decision.phase || '').toUpperCase() === 'TAPER_RACE_WEEK') {
    return blockScope({
      planningDate, candidateWindowEnd, evidenceIds: decisionEvidenceIds,
      reasonCode: 'TAPER_VOLUME_REDUCTION', modalities: ['running', 'running_impact'],
      action: null, authorizesMaterialReduction: true,
    });
  }
  const recent = input.recent_normal_running || {};
  const returning = String(decision.consistency_state || '').toUpperCase() === 'RETURNING'
    || String(decision.training_age_class || '').toUpperCase() === 'RETURNING'
    || String(recent.status || '').toUpperCase() === 'TRAINING_GAP';
  if (returning) {
    return blockScope({
      planningDate,
      candidateWindowEnd,
      evidenceIds: [
        ...(recent.evidence_ids || []),
        ...(input.load_evidence_ids || []),
        input.evidence_snapshot_id,
      ].filter(Boolean),
      reasonCode: 'TRAINING_GAP_REBUILD',
      modalities: ['running', 'running_impact'],
      action: null,
      authorizesMaterialReduction: true,
    });
  }
  const ledger = input.cross_modal_ledger;
  const measuredRunningCeilingM = finiteNonnegative(input.measured_running_ceiling_m);
  if (ledger?.valid === true && measuredRunningCeilingM !== null) {
    return blockScope({
      planningDate,
      candidateWindowEnd,
      evidenceIds: ledger.decisive_evidence_ids,
      reasonCode: 'CROSS_MODAL_FATIGUE_LIMIT',
      modalities: ['running_impact', 'lower_body_muscular'],
      action: null,
      authorizesMaterialReduction: true,
      crossModalLedgerHash: ledger.receipt_hash,
      measuredRunningCeilingM,
    });
  }
  return null;
}

function buildCrossModalDoseLedger(input = {}) {
  const weekly = Array.isArray(input.weekly_dimension_sum) ? input.weekly_dimension_sum.map(finiteNonnegative) : [];
  const dimensions = DIMENSIONS.map((dimension, index) => {
    const supplied = input.dimensions?.[dimension] || {};
    return {
      dimension,
      weekly_sum: weekly[index] ?? null,
      status: String(supplied.status || 'INSUFFICIENT').toUpperCase(),
      confidence: String(supplied.confidence || 'INSUFFICIENT').toUpperCase(),
      normal_ceiling: finiteNonnegative(supplied.normal_ceiling),
      authorized_ceiling: finiteNonnegative(supplied.authorized_ceiling),
    };
  });
  const complete = weekly.length === DIMENSIONS.length && weekly.every((value) => value !== null)
    && dimensions.every((entry) => ['ESTABLISHED', 'PROVISIONAL'].includes(entry.status)
      && ['HIGH', 'MEDIUM', 'LOW'].includes(entry.confidence)
      && entry.normal_ceiling !== null && entry.authorized_ceiling !== null);
  const allDecisiveEvidenceIds = evidenceRefSet(input.decisive_evidence_ids);
  const decisiveEvidenceIds = allDecisiveEvidenceIds.slice(0, 16);
  const ledger = {
    valid: complete && decisiveEvidenceIds.length > 0 && allDecisiveEvidenceIds.length <= 16,
    dimensions,
    decisive_evidence_ids: decisiveEvidenceIds,
    reason_codes: complete && decisiveEvidenceIds.length > 0 && allDecisiveEvidenceIds.length <= 16
      ? [] : ['CROSS_MODAL_FATIGUE_LIMIT'],
  };
  const receipt = deepFreeze({ ...ledger, receipt_hash: prefixedHash(ledger) });
  if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > MAX_RECEIPT_BYTES) {
    return deepFreeze({
      valid: false,
      dimensions: [],
      decisive_evidence_ids: [],
      reason_codes: ['CROSS_MODAL_FATIGUE_LIMIT'],
      receipt_hash: prefixedHash({ invalid: 'CROSS_MODAL_LEDGER_OVERSIZED' }),
    });
  }
  return receipt;
}

function comparatorReceipt(source, baselineRunning, options = {}) {
  const candidateRunning = options.candidateRunning;
  const deltaMeters = round(candidateRunning - baselineRunning, 3);
  const deltaPercentage = baselineRunning > 0 ? round((deltaMeters / baselineRunning) * 100, 2) : null;
  const policy = GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running;
  return {
    source,
    baseline_running_m: round(baselineRunning, 3),
    candidate_running_m: round(candidateRunning, 3),
    delta_m: deltaMeters,
    delta_percentage: deltaPercentage,
    material_reduction: deltaMeters <= -policy.absolute_m
      && deltaPercentage !== null && deltaPercentage <= -(policy.percentage * 100),
    baseline_plan_revision: options.baselinePlanRevision ?? null,
    evidence_refs: evidenceRefs(options.evidenceIds),
  };
}

function scopeCoversCandidate(scope, input, { requireMaterialAuthorization = true } = {}) {
  if (!scope || scope.scope_kind !== 'BLOCK'
    || (requireMaterialAuthorization && scope.authorizes_material_reduction !== true)) return false;
  const start = dateOnly(input.planning_date_local);
  const end = dateOnly(input.candidate_window_end_local);
  const expiry = scope.expires_on_local;
  return Boolean(start && end && scope.effective_from_local <= start && expiry && expiry > end);
}

function qualifyingAuthorization(scope, input, comparators) {
  if (!scopeCoversCandidate(scope, input)) return null;
  const phase = String(input.phase || '').toUpperCase();
  const age = String(input.training_age_class || '').toUpperCase();
  const consistency = String(input.consistency_state || '').toUpperCase();
  const recentStatus = String(input.recent_normal_running?.status || '').toUpperCase();
  const reasons = {
    TAPER_VOLUME_REDUCTION: phase === 'TAPER_RACE_WEEK',
    TRAINING_GAP_REBUILD: age === 'RETURNING' || consistency === 'RETURNING' || recentStatus === 'TRAINING_GAP',
    INJURY_SCOPE: scope.decisive_evidence_ids.length >= 2,
    ILLNESS_RECOVERY: scope.decisive_evidence_ids.length >= 2,
    RECOVERY_VOLUME_REDUCTION: scope.decisive_evidence_ids.length >= 2,
    CROSS_MODAL_FATIGUE_LIMIT: false,
  };
  if (scope.reason_code === 'CROSS_MODAL_FATIGUE_LIMIT') {
    const ledger = input.cross_modal_ledger;
    const maximumCandidate = finiteNonnegative(scope.measured_running_ceiling_m);
    reasons.CROSS_MODAL_FATIGUE_LIMIT = ledger?.valid === true
      && scope.cross_modal_ledger_hash === ledger.receipt_hash
      && maximumCandidate !== null
      && finiteNonnegative(input.candidate_running_m) <= maximumCandidate
      && comparators.some((comparator) => comparator.baseline_running_m > maximumCandidate)
      && scope.decisive_evidence_ids.every((ref) => ledger.decisive_evidence_ids.includes(ref));
  }
  return reasons[scope.reason_code] === true ? scope : null;
}

function evaluateMaterialDose(input = {}) {
  const window = {
    start: input.planning_date_local,
    end: input.candidate_window_end_local,
  };
  const candidateObservation = runningDistanceObservation(input.candidate || {}, window);
  const candidateRunning = candidateObservation.distance_m;
  const recent = input.recent_normal_running || {};
  const comparators = [];
  const baseWithoutComparators = {
    candidate_running_m: candidateRunning,
    comparators,
    material_threshold: clone(GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running),
    reduction_authorization: null,
  };
  if (candidateRunning === null) {
    const receipt = {
      ...baseWithoutComparators,
      valid: false,
      violations: [{
        code: 'RECENT_NORMAL_INSUFFICIENT',
        reason: candidateObservation.reason === 'RUNNING_DATE_UNKNOWN'
          ? 'CANDIDATE_RUNNING_DATE_UNKNOWN'
          : candidateObservation.reason === 'RUNNING_WINDOW_UNKNOWN'
            ? 'CANDIDATE_RUNNING_WINDOW_UNKNOWN' : 'CANDIDATE_RUNNING_DISTANCE_UNKNOWN',
      }],
      reason_codes: ['RECENT_NORMAL_INSUFFICIENT'],
    };
    return deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
  }
  const recentMedian = finiteNonnegative(
    String(recent.status || '').toUpperCase() === 'TRAINING_GAP'
      ? recent.historical_median_distance_m ?? recent.median_distance_m
      : recent.median_distance_m,
  );
  const recentConfidence = String(recent.confidence || '').toUpperCase();
  if (['ESTABLISHED', 'PROVISIONAL', 'TRAINING_GAP'].includes(String(recent.status || '').toUpperCase())
    && recentMedian !== null && recentMedian > 0 && ['HIGH', 'MEDIUM', 'LOW'].includes(recentConfidence)) {
    comparators.push(comparatorReceipt('CANONICAL_RECENT_NORMAL', recentMedian, {
      candidateRunning,
      evidenceIds: recent.evidence_ids,
    }));
  }
  const activeObservation = input.active_applied_plan
    ? runningDistanceObservation(input.active_applied_plan, window) : null;
  if (activeObservation?.state === 'UNKNOWN') {
    const receipt = {
      ...baseWithoutComparators,
      comparators,
      valid: false,
      violations: [{
        code: 'RECENT_NORMAL_INSUFFICIENT',
        reason: activeObservation.reason === 'RUNNING_DATE_UNKNOWN'
          ? 'ACTIVE_PLAN_RUNNING_DATE_UNKNOWN'
          : activeObservation.reason === 'RUNNING_WINDOW_UNKNOWN'
            ? 'ACTIVE_PLAN_RUNNING_WINDOW_UNKNOWN' : 'ACTIVE_PLAN_RUNNING_DISTANCE_UNKNOWN',
      }],
      reason_codes: ['RECENT_NORMAL_INSUFFICIENT'],
    };
    return deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
  }
  const activeRunning = activeObservation?.distance_m ?? null;
  if (activeRunning !== null && activeRunning > 0) {
    comparators.push(comparatorReceipt('ACTIVE_APPLIED_PLAN', activeRunning, {
      candidateRunning,
      baselinePlanRevision: input.active_applied_plan.plan_revision ?? input.active_applied_plan.planRevision ?? null,
    }));
  }
  const observedLowerBound = finiteNonnegative(input.observed_lower_bound_running_m);
  if (observedLowerBound !== null && observedLowerBound > 0) {
    comparators.push(comparatorReceipt('OBSERVED_LOWER_BOUND', observedLowerBound, {
      candidateRunning,
      evidenceIds: input.observed_lower_bound_evidence_ids,
    }));
  }
  comparators.sort((left, right) => left.source.localeCompare(right.source));
  const base = {
    candidate_running_m: candidateRunning,
    comparators,
    material_threshold: clone(GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running),
    reduction_authorization: null,
  };
  if (!comparators.length) {
    const beginnerFoundation = String(input.training_age_class || '').toUpperCase() === 'BEGINNER'
      && String(input.phase || '').toUpperCase() === 'FOUNDATION';
    const receipt = {
      ...base,
      valid: beginnerFoundation,
      dose_state: beginnerFoundation ? 'BOUNDED_BEGINNER_NO_COMPARATOR' : 'COMPARATOR_UNKNOWN',
      violations: beginnerFoundation ? [] : [{ code: 'RECENT_NORMAL_INSUFFICIENT', reason: 'MATERIAL_DOSE_COMPARATOR_UNKNOWN' }],
      reason_codes: ['RECENT_NORMAL_INSUFFICIENT'],
    };
    return deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
  }
  const reductions = comparators.filter((comparator) => comparator.material_reduction);
  const normalizedScope = normalizeScope(input.reduction_scope);
  const authorization = reductions.length ? qualifyingAuthorization(normalizedScope, {
    ...input,
    candidate_running_m: candidateRunning,
  }, comparators) : null;
  const valid = !reductions.length || authorization !== null;
  const violations = valid ? [] : reductions.map((comparator) => ({
    code: 'RECENT_LOAD_MAINTAIN',
    reason: 'UNSUPPORTED_MATERIAL_RUNNING_REDUCTION',
    comparator_source: comparator.source,
    baseline_running_m: comparator.baseline_running_m,
    candidate_running_m: comparator.candidate_running_m,
    delta_m: comparator.delta_m,
    delta_percentage: comparator.delta_percentage,
  }));
  const receipt = {
    ...base,
    valid,
    dose_state: reductions.length ? (valid ? 'QUALIFIED_REDUCTION' : 'UNSUPPORTED_REDUCTION') : 'WITHIN_MATERIAL_BOUND',
    reduction_authorization: authorization,
    violations,
    reason_codes: violations.length ? ['RECENT_LOAD_MAINTAIN']
      : authorization ? [authorization.reason_code] : [],
  };
  const finalReceipt = deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
  if (Buffer.byteLength(JSON.stringify(finalReceipt), 'utf8') > MAX_RECEIPT_BYTES) {
    return deepFreeze({
      valid: false,
      candidate_running_m: candidateRunning,
      comparators: [],
      reduction_authorization: null,
      violations: [{ code: 'RECENT_LOAD_MAINTAIN', reason: 'MATERIAL_DOSE_RECEIPT_OVERSIZED' }],
      reason_codes: ['RECENT_LOAD_MAINTAIN'],
      receipt_hash: prefixedHash({ invalid: 'MATERIAL_DOSE_RECEIPT_OVERSIZED' }),
    });
  }
  return finalReceipt;
}

function validateDevelopmentRoleDose(candidate = {}, options = {}) {
  const requirements = Array.isArray(options.development_role_requirements)
    ? options.development_role_requirements : [];
  if (!requirements.length) {
    return {
      validator: 'development_roles', valid: true, violations: [], role_evaluations: [], reason_codes: [],
    };
  }
  const sessions = sessionsFrom(candidate);
  const conflicts = new Map((Array.isArray(options.development_role_conflicts)
    ? options.development_role_conflicts : []).map((conflict) => [String(conflict.requirement_id || ''), conflict]));
  const violations = [];
  const roleEvaluations = [];
  for (const requirement of requirements) {
    const matched = sessions.filter((session) => (requirement.any_of || []).includes(sessionFamily(session))
      && (!requirement.minimum_role || sessionRole(session) === requirement.minimum_role));
    let meaningful = matched.length > 0;
    let presentationFloorMin = null;
    let presentationFloorSource = null;
    if (meaningful && requirement.presentation_floor_required === true) {
      const ordinary = finiteNonnegative(options.median_ordinary_easy_duration_min);
      presentationFloorMin = ordinary === null ? 30 : Math.max(30, round(ordinary * 1.5, 2));
      presentationFloorSource = ordinary === null
        ? 'POLICY_MINIMUM_NO_ORDINARY_EASY_EVIDENCE'
        : 'OBSERVED_ORDINARY_EASY_MEDIAN';
      meaningful = matched.some((session) => {
        const duration = finiteNonnegative(session.duration_min ?? session.duration_minutes);
        return duration !== null && duration >= presentationFloorMin;
      });
    }
    roleEvaluations.push({
      requirement_id: String(requirement.requirement_id || ''),
      matched_session_ids: matched.map((session, index) => String(
        session.session_id ?? session.id ?? `${requirement.requirement_id}-${index + 1}`
      )).sort(),
      meaningful,
      presentation_floor_min: presentationFloorMin,
      presentation_floor_source: presentationFloorSource,
    });
    if (meaningful) continue;
    const conflict = conflicts.get(String(requirement.requirement_id));
    const normalizedConflict = normalizeScope(conflict);
    if (normalizedConflict && scopeCoversCandidate(normalizedConflict, options, {
      requireMaterialAuthorization: false,
    })) continue;
    violations.push({
      code: 'REQUIRED_EXPOSURE_UNPLACEABLE',
      reason: matched.length ? 'REQUIRED_ROLE_BELOW_PRESENTATION_FLOOR' : 'REQUIRED_DEVELOPMENT_ROLE_MISSING',
      requirement_id: requirement.requirement_id,
    });
  }
  return {
    validator: 'development_roles',
    valid: violations.length === 0,
    violations,
    role_evaluations: roleEvaluations,
    reason_codes: violations.length ? ['REQUIRED_EXPOSURE_UNPLACEABLE'] : [],
  };
}

module.exports = {
  DIMENSIONS,
  MAX_RECEIPT_BYTES,
  buildCrossModalDoseLedger,
  deriveMaterialReductionScope,
  deriveScopedRecoveryState,
  evaluateMaterialDose,
  normalizeScope,
  validateDevelopmentRoleDose,
};
