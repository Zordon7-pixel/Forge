const { canonicalHash, daysBetween, eventPolicyForGoal } = require('./racePlanPolicy');
const { resolveOwnedGoals, deriveGoalConfidence } = require('./goalBackwardDecisionEngine');
const { evaluateGoalBackwardFeasibility } = require('./planFeasibility');
const { convertNearbyRoadRace } = require('./goalBackwardTargets');

const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

// Demand is arithmetic, not pace authority. Unvalidated maps to the new closed
// status without changing the legacy feasibility union or its existing callers.
function buildGoalGaps({ athleteState, goals = [], races = [], feasibilityByGoal = {} } = {}) {
  if (!athleteState?.athlete_state_hash) throw new Error('Goal gaps require canonical athlete state');
  return resolveOwnedGoals({ athlete_id: athleteState.athlete_id, goals, races })
    .filter(goal => goal.planning_eligible || goal.event_state === 'COMPLETED' && !goal.transition_exit_met).map(goal => {
      const policy = eventPolicyForGoal(goal);
      const distanceM = positive(goal.distance_miles) === null ? null : goal.distance_miles * 1609.344;
      const road = ['ROAD_SHORT', 'ROAD_ENDURANCE', 'MARATHON'].includes(policy?.event_kind);
      const targetPace = road && distanceM && goal.target_time_s ? goal.target_time_s * 1000 / distanceM : null;
      const relevant = (athleteState.performance_anchors || []).filter(row => row.goal_id === goal.goal_id);
      const conflict = relevant.some(row => row.material_conflict === true || row.conflict === true || row.quality_state === 'CONFLICT');
      const observations = relevant.filter(row => {
        const age = daysBetween(String(row.observed_at || '').slice(0, 10), athleteState.planning_date_local);
        return !conflict && row.goal_id === goal.goal_id && row.evidence_id && row.quality_state === 'COMPLETE'
          && row.value_state === 'KNOWN' && row.freshness_state === 'FRESH'
          && row.material_conflict !== true && row.conflict !== true
          && Number.isFinite(age) && age >= 0 && age <= 42;
      });
      const estimates = observations.flatMap(row => {
        if (!road || !distanceM || !positive(row.distance_m) || !positive(row.duration_s)) return [];
        const same = Math.abs(row.distance_m - distanceM) <= 1;
        const converted = same ? row.duration_s : convertNearbyRoadRace({ source_distance_m: row.distance_m,
          target_distance_m: distanceM, source_duration_s: row.duration_s,
          comparable_course_surface: row.comparable_course_surface === true })?.target_duration_s;
        return converted ? [{ duration_s: converted, evidence_id: row.evidence_id }] : [];
      });
      // Conservative demonstrated estimate; a requested target never enters this calculation.
      const demonstrated = estimates.length ? Math.max(...estimates.map(e => e.duration_s)) : null;
      const confidence = deriveGoalConfidence(observations).confidence;
      const receipt = feasibilityByGoal[goal.goal_id] || {};
      const feasibility = evaluateGoalBackwardFeasibility({ ...receipt, goal, current_status: 'unvalidated',
        target_observations: observations, confidence, unresolved_material_conflict: conflict,
        established_recent_normal: athleteState.recent_normal_running.status === 'ESTABLISHED',
        safety_permits_goal_training: ['NORMAL', 'MONITOR'].includes(athleteState.safety_action),
      });
      const unsupportedPace = goal.target_time_s !== null && (demonstrated === null || goal.target_time_s < demonstrated);
      const status = !policy || unsupportedPace || feasibility.status === 'not_currently_supported'
        ? 'NOT_CURRENTLY_SUPPORTED' : feasibility.status === 'supported' ? 'SUPPORTED' : 'AT_RISK';
      const content = {
        version: 'adaptive-goal-gap-v1', athlete_state_hash: athleteState.athlete_state_hash,
        goal_id: goal.goal_id, goal, event_policy_id: policy?.event_policy_id || null,
        days_remaining: goal.event_local_date ? daysBetween(athleteState.planning_date_local, goal.event_local_date) : null,
        weeks_remaining: goal.event_local_date ? Math.max(0, daysBetween(athleteState.planning_date_local, goal.event_local_date) / 7) : null,
        derived_target_pace_s_per_km: targetPace, target_demand: { distance_m: distanceM, duration_s: goal.target_time_s },
        demonstrated_fitness: { projected_duration_s: demonstrated,
          pace_s_per_km: demonstrated && distanceM ? demonstrated * 1000 / distanceM : null },
        gap_seconds: demonstrated !== null && goal.target_time_s !== null ? demonstrated - goal.target_time_s : null,
        confidence, feasibility_status: status, legacy_feasibility: feasibility,
        training_pace_authority: false, evidence_ids: observations.map(e => e.evidence_id).sort(),
        reason_codes: [...new Set([...(unsupportedPace || !policy ? ['GOAL_DEMAND_UNSUPPORTED'] : []),
          ...(demonstrated === null ? ['PACE_EVIDENCE_MISSING', 'ASSESSMENT_REQUIRED'] : []),
          ...feasibility.reason_codes])].sort(),
      };
      return { ...content, goal_gap_hash: canonicalHash(content) };
    });
}
module.exports = { buildGoalGaps };
