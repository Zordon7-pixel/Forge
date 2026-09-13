// Explicit pre-existing accepted history for synthetic DB tests only. This is
// fixture setup, not a SHADOW acceptance path; no surface manifest is created.
const { fixture, windows } = require('../adaptiveCoachingSolver.smoke');
const { buildEvidenceSnapshot } = require('../../src/lib/goalBackwardEvidence');
const { buildAdaptiveCoachingCandidate } = require('../../src/lib/adaptiveCoachingSolver');
const { buildCanonicalPlanFromSessionSet } = require('../../src/lib/planSchema');
const { buildPipelineArtifact } = require('../../src/lib/planCandidateLifecycle');
const { canonicalPrescriptionHash } = require('../../src/lib/goalBackwardValidators');
const { canonicalHash } = require('../../src/lib/racePlanPolicy');
function acceptedFixture(db, owner, baseCandidateId, supplied = null) {
  const input = fixture(2, 0, 180);
  input.snapshot = buildEvidenceSnapshot({ athleteId: owner, timezone: 'UTC', planningInstant: '2026-09-07T00:00:00Z',
    runs: Array.from({ length: 8 }, (_, i) => ({ id: `accepted-history-${i}`, user_id: owner,
      date: `2026-08-${String(31 - i * 2).padStart(2, '0')}`, distance_miles: 5, duration_seconds: 2700 })) });
  const availability = Object.fromEntries(Object.entries(windows()).map(([key, rows]) => [key,
    rows.map(w => Object.fromEntries(Object.entries(w).map(([k, time]) => [k, new Date(Date.parse(time) - 7 * 86400000).toISOString()])))]));
  const candidate = supplied || buildAdaptiveCoachingCandidate({ foundationInput: input, availability }).selected_candidate;
  if (!candidate) throw new Error('Accepted fixture canonical material unavailable');
  const plan = buildCanonicalPlanFromSessionSet(candidate.canonical_session_set);
  const id = `historical-accepted-candidate-${owner}`, assignment = `historical-accepted-assignment-${owner}`;
  const artifact = buildPipelineArtifact({ userId: owner, kind: 'canonical_session_set', decisionId: plan.decision_id,
    planGenerationCandidateId: id, createdAt: '2026-09-07T00:00:00Z', payload: { ...candidate.canonical_session_set,
      plan_generation_candidate_ref: `sha256:${canonicalHash(id)}`, selected_candidate_id: candidate.canonical_session_set.candidate_id,
      selected_candidate_hash: candidate.candidate_hash } });
  db.prepare("UPDATE user_plans SET status='superseded' WHERE user_id=?").run(owner);
  db.prepare('INSERT INTO training_plans(id,user_id,name,plan_data,plan_json,weeks) VALUES (?,?,?,?,?,?)')
    .run(plan.plan_id, owner, 'Synthetic accepted history', JSON.stringify(plan), JSON.stringify(plan), 1);
  db.prepare(`INSERT INTO user_plans(id,user_id,plan_id,status,plan_version,started_at,effective_from)
    VALUES (?,?,?,'active',?,'2026-09-07','2026-09-07')`).run(assignment, owner, plan.plan_id, plan.plan_revision);
  db.prepare(`INSERT INTO plan_generation_candidates(id,user_id,status,planning_input_revision,planning_date_local,
    timezone_offset_minutes,input_hash,candidate_hash,engine_version,policy_version,invariant_version,
    planning_snapshot_json,candidate_plan_json,generation_trace_json,expires_at,decision_id,selected_candidate_hash,
    applied_user_plan_id,material_change_json)
    SELECT ?,user_id,'applied',planning_input_revision,planning_date_local,timezone_offset_minutes,input_hash,?,
      engine_version,policy_version,invariant_version,planning_snapshot_json,?,generation_trace_json,expires_at,?,?,?,?
      FROM plan_generation_candidates WHERE id=? AND user_id=?`).run(id, candidate.candidate_hash, JSON.stringify(plan),
        plan.decision_id, candidate.candidate_hash, assignment,
        JSON.stringify({ candidate_prescription_hash: canonicalPrescriptionHash(plan) }), baseCandidateId, owner);
  db.prepare(`INSERT INTO planning_pipeline_artifacts(id,user_id,artifact_kind,decision_id,plan_generation_candidate_id,
    schema_version,policy_version,revision,content_hash,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      artifact.id, owner, artifact.artifact_kind, plan.decision_id, id, '1', artifact.policy_version, 1,
      artifact.content_hash, JSON.stringify(artifact.payload_json), artifact.created_at);
  if (supplied) return { artifact, assignment, plan, candidate };
  const run = candidate.sessions.find(s => s.kind === 'run');
  // Different actual numbers prove that planned totals do not become observations.
  const actualDuration = Math.round(run.derived_totals.duration_s * 0.95);
  const actualMiles = run.derived_totals.distance_m * 0.96 / 1609.344;
  db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,plan_session_id,planned_session_json)
    VALUES (?,?,?,?,?,?,?,?)`).run('linked-actual', owner, run.scheduled_local_date, 'easy', actualMiles, actualDuration,
      run.session_id, JSON.stringify({ matchSource: 'explicit_owned_session', sessionId: run.session_id,
        date: run.scheduled_local_date, planId: plan.plan_id, kind: 'run', content_hash: run.content_hash }));
  return { run, actualDuration, actualMiles, artifact, assignment };
}
module.exports = { acceptedFixture };
