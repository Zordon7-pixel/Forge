// Preview adaptation only. The Phase 1 solver remains the prescription authority.
const { canonicalHash } = require('./racePlanPolicy');
const { buildCanonicalPlanFromSessionSet } = require('./planSchema');
const { validateCanonicalSessionSet } = require('./canonicalWorkout');
const hash = value => `sha256:${canonicalHash(value)}`;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function build({ prepared, result }) {
  const selected = result?.selected_candidate;
  const set = selected?.canonical_session_set;
  if (!prepared?.foundation) fail('EVIDENCE_MISSING');
  if (prepared.source_support?.source_limited || prepared.source_support?.limits?.some(limit =>
    limit.required && limit.status !== 'SUPPORTED')) fail('EVIDENCE_MISSING');
  if (result?.applicable !== true || !['VALID', 'VALID_WITH_TRADEOFFS'].includes(result.status)
    || !selected?.validation?.valid || !selected.canonical_sessions_materialized
    || !set || !validateCanonicalSessionSet(set).valid
    || set.candidate_hash !== selected.candidate_hash || set.decision_hash !== result.decision.decision_hash
    || canonicalHash(set.sessions) !== canonicalHash(selected.sessions)) fail('CANDIDATE_NOT_SELECTED');
  const plan = buildCanonicalPlanFromSessionSet(set);
  const decision = result.decision;
  const reasons = [...new Set([...decision.phase_reason_codes,
    ...selected.sessions.flatMap(session => session.purpose_reason_codes || [])])];
  return {
    candidateHash: `sha256:${selected.candidate_hash.replace(/^sha256:/, '')}`,
    plan: { ...plan, planMode: selected.sessions.some(session => session.kind === 'lift') ? 'hybrid_maintain' : 'run_only',
      engineVersion: 'adaptive-joint-solver-v1', goal_backward_engine_version: 'adaptive-joint-solver-v1',
      goal_backward_policy_versions: decision.policy_versions,
      purpose: 'Adaptive coaching preview', overall_feasibility: result.status, reasons,
      goal_gap: decision.goal_gap, weekly_objectives: decision.weekly_objectives,
      weeks: plan.weeks.map(week => ({ ...week, phase: decision.phase,
        purpose: 'Adaptive coaching preview', weekly_objectives: decision.weekly_objectives })),
    },
    decision: { ...decision, ...prepared.binding,
      evidence_used: [{ evidence_id: prepared.observed_binding, purpose: 'CAPTURED_OBSERVATION_BINDING' }] },
    selected,
    observedBinding: prepared.observed_binding,
    planHash: hash(plan),
  };
}
module.exports = { build };
