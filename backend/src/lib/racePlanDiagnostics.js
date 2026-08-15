const planSchema = require('./planSchema');
const runWorkoutTaxonomy = require('./runWorkoutTaxonomy');
const { RACE_PLAN_POLICY_V1, canonicalHash } = require('./racePlanPolicy');
const {
  assertBoundedJson,
  findArtifactRedactionViolations,
  redactSnapshotValue,
} = require('./planCandidateLifecycle');
const {
  validatePipelineArtifact,
} = require('./goalBackwardContracts');
const {
  assertGoalBackwardReleaseTelemetry,
  evaluateGoalBackwardReleaseAlerts,
} = require('./betaPlanRollout');

const MAX_TEXT_LENGTH = 80;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedText(value, maximum = MAX_TEXT_LENGTH) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maximum) : null;
}

function planWeeks(plan = {}) {
  return Array.isArray(plan.weeks) ? plan.weeks : [];
}

function weekDays(week = {}) {
  return planSchema.getDayEntries(week);
}

function sessionRole(session = {}) {
  return boundedText(session.workout_id || session.workoutId || session.type || session.workout_type || session.kind, 48);
}

function isLongRun(session = {}) {
  return String(session.kind || '').toLowerCase() === 'run'
    && (String(session.type || '').toLowerCase() === 'long'
      || String(session.workout_id || '') === 'long_aerobic');
}

function isDemandingRun(session = {}) {
  if (String(session.kind || '').toLowerCase() !== 'run') return false;
  return isLongRun(session)
    || String(session.type || '').toLowerCase() === 'race'
    || runWorkoutTaxonomy.isQualityWorkout(session.workout_id);
}

function isLowerBodyStrength(session = {}) {
  if (String(session.kind || '').toLowerCase() !== 'lift') return false;
  const focus = `${session.focus || ''} ${session.title || ''}`.toLowerCase();
  return /(lower|leg|glute|hamstring|quad|calf|posterior)/.test(focus);
}

function dosageTrace(session = {}) {
  const dosage = {};
  const numericFields = [
    ['distance_miles', session.distance_miles],
    ['duration_minutes', session.duration_min ?? session.duration_minutes],
    ['sets', session.sets],
    ['reps', session.reps],
    ['rest_seconds', session.rest_seconds],
    ['interval_seconds', session.interval_seconds],
    ['recovery_seconds', session.recovery_seconds],
  ];
  for (const [key, value] of numericFields) {
    const normalized = finite(value);
    if (normalized !== null && normalized >= 0) dosage[key] = normalized;
  }
  const targetZone = boundedText(session.target_zone || session.targetZone, 24);
  if (targetZone) dosage.target_zone = targetZone;
  const pace = boundedText(session.pace_target || session.goal_pace_label, 32);
  if (pace) dosage.pace = pace;
  return dosage;
}

function sessionTrace(day, session) {
  const reasonCodes = [session.downgrade_reason, ...(Array.isArray(session.reason_codes) ? session.reason_codes : [])]
    .map((value) => boundedText(value, 64))
    .filter(Boolean)
    .slice(0, 8);
  return {
    date: boundedText(day.date, 10),
    kind: boundedText(session.kind, 12),
    role: sessionRole(session),
    dosage: dosageTrace(session),
    downgrade_reason_codes: [...new Set(reasonCodes)],
  };
}

function summarizeWeek(week, weekIndex) {
  const sessions = weekDays(week).flatMap((day) => planSchema.daySessions(day).map((session) => ({ day, session })));
  const runs = sessions.filter(({ session }) => session.kind === 'run');
  const longRuns = runs.filter(({ session }) => isLongRun(session));
  const quality = runs.filter(({ session }) => runWorkoutTaxonomy.isQualityWorkout(session.workout_id));
  const strengthConflicts = weekDays(week).filter((day) => {
    const daySessions = planSchema.daySessions(day);
    return daySessions.some(isDemandingRun) && daySessions.some(isLowerBodyStrength);
  }).map((day) => boundedText(day.date, 10)).filter(Boolean);
  return {
    week: Number(week.week || weekIndex + 1),
    start_date: boundedText(week.startDate || week.start_date, 10),
    phase: boundedText(week.phase, 24),
    purpose: boundedText(week.purpose || week.weekPurpose, 80),
    weekly_miles: Number(runs.reduce((sum, { session }) => sum + (finite(session.distance_miles) || 0), 0).toFixed(2)),
    long_run_miles: longRuns.length
      ? Math.max(...longRuns.map(({ session }) => finite(session.distance_miles) || 0))
      : null,
    long_run_minutes: longRuns.length
      ? Math.max(...longRuns.map(({ session }) => finite(session.duration_min) || 0))
      : null,
    quality_roles: quality.map(({ session }) => sessionRole(session)).filter(Boolean),
    strength_sessions: sessions.filter(({ session }) => session.kind === 'lift').length,
    strength_conflict_dates: strengthConflicts,
  };
}

function summarizePlan(plan = {}) {
  const weeks = planWeeks(plan).map(summarizeWeek);
  const sessions = planWeeks(plan).flatMap((week) => weekDays(week).flatMap((day) => (
    planSchema.daySessions(day).map((session) => sessionTrace(day, session))
  )));
  const qualityDistribution = {};
  for (const session of sessions) {
    if (!session.role || !runWorkoutTaxonomy.isQualityWorkout(session.role)) continue;
    qualityDistribution[session.role] = (qualityDistribution[session.role] || 0) + 1;
  }
  return {
    feasibility: boundedText(plan.overall_feasibility, 24),
    reason_codes: [...new Set((Array.isArray(plan.reasons) ? plan.reasons : [])
      .map((value) => boundedText(value, 64)).filter(Boolean))],
    weekly_curve: weeks,
    quality_distribution: qualityDistribution,
    strength_conflicts: weeks.flatMap((week) => week.strength_conflict_dates),
    sessions,
  };
}

function inputSources(snapshot = {}) {
  const context = snapshot.context || {};
  const history = context.history || {};
  const recovery = context.recovery || {};
  return {
    planning_date_local: boundedText(snapshot.planning_date_local, 10),
    checkin_date: boundedText(context.checkin?.date, 10),
    health_synced_at: boundedText(recovery.syncedAt, 40),
    latest_run_date: boundedText(history.acuteRunLoad?.latestRun?.date, 10),
    performance_anchor_date: boundedText(history.performanceProfile?.targetAnchor?.date, 10),
    recent_run_count: finite(history.recentRunCount),
    recent_lift_count: finite(history.recentLiftCount),
    weekly_baseline_source: boundedText(history.mileageBaseline?.source, 40),
  };
}

function safetyConstraints(snapshot = {}) {
  const context = snapshot.context || {};
  return {
    active_injury: Boolean(context.safety?.activeInjury),
    comeback_mode: Boolean(context.safety?.comebackMode),
    injury_notes_present: Boolean(context.safety?.injuryNotesPresent),
    recovery_state: boundedText(context.recovery?.state, 24),
    recovery_data_available: Boolean(context.recovery?.dataAvailable),
  };
}

function comparison(activeSummary, candidateSummary) {
  const activeByStart = new Map(activeSummary.weekly_curve.map((week) => [week.start_date || String(week.week), week]));
  return {
    weekly_curve: candidateSummary.weekly_curve.map((week) => {
      const prior = activeByStart.get(week.start_date || String(week.week));
      return {
        week: week.week,
        start_date: week.start_date,
        active_miles: prior?.weekly_miles ?? null,
        candidate_miles: week.weekly_miles,
        delta_miles: prior ? Number((week.weekly_miles - prior.weekly_miles).toFixed(2)) : null,
        active_long_run_miles: prior?.long_run_miles ?? null,
        candidate_long_run_miles: week.long_run_miles,
      };
    }),
    active_quality_distribution: activeSummary.quality_distribution,
    candidate_quality_distribution: candidateSummary.quality_distribution,
    active_strength_conflicts: activeSummary.strength_conflicts,
    candidate_strength_conflicts: candidateSummary.strength_conflicts,
    active_feasibility: activeSummary.feasibility,
    candidate_feasibility: candidateSummary.feasibility,
  };
}

function buildPlanDiagnosticBundle({ targetUserId, candidate }) {
  const diagnostics = candidate?.diagnostics || {};
  const activeSummary = summarizePlan(diagnostics.active_plan_data || {});
  const candidateSummary = summarizePlan(candidate?.plan || {});
  const bundle = {
    schema_version: 1,
    engine_mode: RACE_PLAN_POLICY_V1.rollout.engineMode,
    engine_version: boundedText(diagnostics.trace?.engine_version || candidate?.plan?.engineVersion, 64),
    target_ref: `sha256:${canonicalHash(String(targetUserId || ''))}`,
    active_plan: {
      training_plan_id: diagnostics.active_plan?.trainingPlanId || null,
      user_plan_id: diagnostics.active_plan?.userPlanId || null,
      plan_version: diagnostics.active_plan?.planVersion ?? null,
      summary: activeSummary,
    },
    candidate: {
      id: candidate?.id || null,
      hash: candidate?.candidateHash || null,
      feasibility: candidateSummary.feasibility,
      reason_codes: candidateSummary.reason_codes,
      validation: diagnostics.trace?.validation || null,
      summary: candidateSummary,
    },
    input_sources: inputSources(diagnostics.snapshot || {}),
    active_safety_constraints: safetyConstraints(diagnostics.snapshot || {}),
    comparison: comparison(activeSummary, candidateSummary),
  };
  const redacted = redactSnapshotValue(bundle);
  assertBoundedJson(redacted, RACE_PLAN_POLICY_V1.diagnostics.maximumResponseBytes, 'plan diagnostic response');
  return redacted;
}

function parseArtifactPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function pseudonymizeArtifactPayload(value, targetUserId, targetRef) {
  if (Array.isArray(value)) {
    return value.map((entry) => pseudonymizeArtifactPayload(entry, targetUserId, targetRef));
  }
  if (!value || typeof value !== 'object') return value === targetUserId ? targetRef : value;
  return Object.keys(value).sort().reduce((result, key) => {
    const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const nested = value[key];
    if (['athlete_id', 'user_id', 'owner_id', 'attributed_by_user_id'].includes(normalized)) {
      result[key] = nested == null ? null : targetRef;
    } else {
      result[key] = pseudonymizeArtifactPayload(nested, targetUserId, targetRef);
    }
    return result;
  }, {});
}

function diagnosticArtifactError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = 422;
  if (details) error.details = details;
  return error;
}

function buildDecisionArtifactDiagnosticBundle({ targetUserId, decisionId, artifactRows = [] }) {
  const scopedTargetId = String(targetUserId || '').trim();
  const scopedDecisionId = String(decisionId || '').trim();
  if (!scopedTargetId || !scopedDecisionId || scopedDecisionId.length > 200) {
    throw diagnosticArtifactError('A bounded owner and decision ID are required.', 'DIAGNOSTIC_ARTIFACT_SCOPE_INVALID');
  }
  if (!Array.isArray(artifactRows) || artifactRows.length > 32) {
    throw diagnosticArtifactError('Diagnostic artifact results must be bounded to 32 rows.', 'DIAGNOSTIC_ARTIFACT_LIMIT_EXCEEDED');
  }
  const targetRef = `sha256:${canonicalHash(scopedTargetId)}`;
  const artifacts = artifactRows.map((row, index) => {
    const payload = parseArtifactPayload(row?.payload_json);
    if (!payload) {
      throw diagnosticArtifactError('Stored artifact payload is invalid.', 'DIAGNOSTIC_ARTIFACT_INVALID', { index });
    }
    const violations = findArtifactRedactionViolations(payload, `artifacts[${index}].payload_json`);
    if (violations.length) {
      throw diagnosticArtifactError(
        'Stored artifact contains a prohibited secret or PII key.',
        'DIAGNOSTIC_ARTIFACT_REDACTION_REQUIRED',
        { paths: violations }
      );
    }
    const normalized = {
      id: row.id,
      user_id: row.user_id,
      artifact_kind: row.artifact_kind,
      decision_id: row.decision_id,
      parent_artifact_id: row.parent_artifact_id ?? null,
      plan_generation_candidate_id: row.plan_generation_candidate_id ?? null,
      schema_version: row.schema_version,
      policy_version: row.policy_version,
      revision: Number(row.revision),
      content_hash: row.content_hash,
      payload_json: payload,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
    const validation = validatePipelineArtifact(normalized);
    if (!validation.valid || normalized.user_id !== scopedTargetId || normalized.decision_id !== scopedDecisionId) {
      throw diagnosticArtifactError(
        'Stored artifact failed scope or contract validation.',
        'DIAGNOSTIC_ARTIFACT_INVALID',
        { index, validation: validation.errors }
      );
    }
    const expectedContentHash = `sha256:${canonicalHash(payload)}`;
    const normalizedContentHash = String(normalized.content_hash || '').startsWith('sha256:')
      ? String(normalized.content_hash)
      : `sha256:${normalized.content_hash}`;
    if (normalizedContentHash !== expectedContentHash) {
      throw diagnosticArtifactError(
        'Stored artifact payload does not match its content hash.',
        'DIAGNOSTIC_ARTIFACT_HASH_MISMATCH',
        { index, artifact_id: normalized.id }
      );
    }
    const diagnosticPayload = pseudonymizeArtifactPayload(payload, scopedTargetId, targetRef);
    return {
      id: normalized.id,
      artifact_kind: normalized.artifact_kind,
      decision_id: normalized.decision_id,
      parent_artifact_id: normalized.parent_artifact_id,
      plan_generation_candidate_id: normalized.plan_generation_candidate_id,
      schema_version: normalized.schema_version,
      policy_version: normalized.policy_version,
      revision: normalized.revision,
      content_hash: normalized.content_hash,
      diagnostic_payload_hash: `sha256:${canonicalHash(diagnosticPayload)}`,
      payload_json: diagnosticPayload,
      created_at: normalized.created_at,
    };
  });
  const bundle = {
    schema_version: 1,
    target_ref: targetRef,
    decision_id: scopedDecisionId,
    artifact_count: artifacts.length,
    artifacts,
  };
  assertBoundedJson(bundle, RACE_PLAN_POLICY_V1.diagnostics.maximumResponseBytes, 'decision artifact diagnostic response');
  return bundle;
}

function incrementCount(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function buildGoalBackwardReleaseDiagnosticBundle({ telemetry = [] } = {}) {
  if (!Array.isArray(telemetry) || telemetry.length > 256) {
    throw diagnosticArtifactError(
      'Goal-backward release telemetry must be bounded to 256 records.',
      'DIAGNOSTIC_RELEASE_TELEMETRY_LIMIT_EXCEEDED',
    );
  }
  let records;
  try {
    records = telemetry.map((record) => assertGoalBackwardReleaseTelemetry(record));
  } catch (_error) {
    throw diagnosticArtifactError(
      'A goal-backward release telemetry record failed validation.',
      'DIAGNOSTIC_RELEASE_TELEMETRY_INVALID',
    );
  }
  const modeCounts = {};
  const outcomeCounts = {};
  const surfaceCapabilityCounts = {};
  const reasonCounts = {};
  for (const record of records) {
    incrementCount(modeCounts, record.mode);
    incrementCount(outcomeCounts, record.outcome);
    incrementCount(surfaceCapabilityCounts, record.surface_capability);
    for (const [code, counts] of Object.entries(record.reason_counts)) {
      if (!reasonCounts[code]) reasonCounts[code] = { pass: 0, fail: 0 };
      reasonCounts[code].pass += counts.pass;
      reasonCounts[code].fail += counts.fail;
    }
  }
  const bundle = {
    schema_version: 'goal_backward_release_diagnostic_v1',
    telemetry_schema_version: 'goal_backward_release_telemetry_v1',
    record_count: records.length,
    policy_versions: records[0]?.policy_versions || {},
    mode_counts: sortedCounts(modeCounts),
    outcome_counts: sortedCounts(outcomeCounts),
    reason_counts: sortedCounts(reasonCounts),
    candidate_selection: {
      selected: records.filter((record) => record.candidate_selected).length,
      not_selected: records.filter((record) => !record.candidate_selected).length,
    },
    surface_capability_counts: sortedCounts(surfaceCapabilityCounts),
    revision_mismatch_count: records.filter((record) => record.revision_mismatch).length,
    alerts: evaluateGoalBackwardReleaseAlerts(records),
  };
  assertBoundedJson(bundle, 64 * 1024, 'goal-backward release diagnostic response');
  return bundle;
}

module.exports = {
  buildDecisionArtifactDiagnosticBundle,
  buildGoalBackwardReleaseDiagnosticBundle,
  buildPlanDiagnosticBundle,
  dosageTrace,
  inputSources,
  safetyConstraints,
  summarizePlan,
};
