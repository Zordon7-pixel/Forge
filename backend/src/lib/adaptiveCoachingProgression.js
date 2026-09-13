// Observed family progression only. These are dose bounds for later materialization,
// never workout prescriptions or a calendar-index progression curve.
const { classifyCompletionOutcome } = require('./adaptationEngine');
const { decideWeeklyRamp } = require('./weeklyRampEngine');
const { addDays, mondayFor, daysBetween, eventPolicyForGoal, peakLongRunDemand } = require('./racePlanPolicy');
const { PLANNING_PHASES } = require('./goalBackwardContracts');

const definitions = {
  aerobic_volume: [['easy_run', 'recovery_run', 'steady_run'], 'distance_m', 0.10],
  long_run: [['long_aerobic'], 'distance_m', 0.08],
  threshold: [['threshold_run', 'race_rhythm_run'], 'duration_s', 0.05],
  speed_neuromuscular: [['interval_run'], 'duration_s', 0.05],
  strength: [['strength_lower', 'strength_full_body'], 'duration_s', 0.05],
  strength_upper: [['strength_upper'], 'duration_s', 0.05],
  hyrox_skill: [['hyrox_station_skill'], 'duration_s', 0.05],
  hyrox_specific: [['hyrox_station_strength', 'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation'], 'duration_s', 0.05],
};
const PROGRESSION_FAMILIES = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([id, [families, variable, max]]) => [id, Object.freeze({
  family: id, workout_families: Object.freeze(families), allowed_variable: variable,
  max_increase_fraction: max, max_regression_fraction: 0.10,
  phase_compatibility: Object.freeze(id === 'aerobic_volume' || id === 'hyrox_skill' || id.startsWith('strength')
    ? [...PLANNING_PHASES] : PLANNING_PHASES.filter(p => !['FOUNDATION', 'POST_RACE_TRANSITION'].includes(p))),
  recovery_requirements: Object.freeze(['READY', 'NORMAL']),
})])));

function progressionFamilyFor(workoutFamily) {
  return Object.values(PROGRESSION_FAMILIES).find(p => p.workout_families.includes(workoutFamily))?.family || null;
}

function buildFamilyProgression({ athleteState, completionPairs = [], weeklyMileageHistory = [], readinessTrend = null, phase } = {}) {
  if (!athleteState?.planning_date_local || !PLANNING_PHASES.includes(phase)) throw new Error('Progression requires state and phase');
  const planning = Date.parse(`${athleteState.planning_date_local}T23:59:59.999Z`);
  const records = completionPairs.map(pair => {
    const prescribed = pair.prescribed_session || {};
    const observation = pair.observation || {};
    const outcome = classifyCompletionOutcome({ prescribed_session: prescribed, observation });
    const instant = Date.parse(outcome.observed_at || '');
    const linked = prescribed.session_id && observation.linked_session_id === prescribed.session_id;
    const hasActual = observation.completed === true && (outcome.observed_to_prescribed_ratio !== null
      || observation.target_met === true);
    const usable = linked && observation.quality_state === 'COMPLETE'
      && outcome.source_evidence_ids.length > 0 && Number.isFinite(instant) && instant <= planning
      && planning - instant <= 28 * 86400000 && outcome.scorable;
    return { family: progressionFamilyFor(prescribed.workout_family), prescribed, observation,
      outcome, usable, hasActual, instant };
  }).sort((a, b) => a.instant - b.instant || String(a.outcome.linked_session_id).localeCompare(String(b.outcome.linked_session_id)));
  const lastMiles = weeklyMileageHistory.at(-1);
  const ramp = decideWeeklyRamp({ weeklyMileageHistory, readinessTrend,
    plannedNextWeekMiles: typeof lastMiles === 'number' ? lastMiles * 1.1 : null });
  return Object.values(PROGRESSION_FAMILIES).map(policy => {
    // A repeated import of one completed session is one exposure.
    const sourceSeen = new Set();
    const bySession = new Map(records.filter(r => r.family === policy.family && r.usable)
      .map(r => [r.outcome.linked_session_id, r]));
    const distinct = [...bySession.values()].filter(r => {
      if (r.outcome.source_evidence_ids.some(id => sourceSeen.has(id))) return false;
      r.outcome.source_evidence_ids.forEach(id => sourceSeen.add(id));
      return true;
    });
    const unique = new Map(distinct.map(r => [r.outcome.linked_session_id, r]));
    const recent = [...unique.values()].sort((a, b) => a.instant - b.instant);
    const last = recent.at(-1);
    const latestAvailable = records.filter(r => r.family === policy.family).at(-1);
    const uncertainLatest = latestAvailable && !latestAvailable.usable;
    const successful = recent.filter(r => r.hasActual && r.outcome.outcome === 'ON_TARGET');
    const previous = successful.at(-1);
    const measured = previous?.observation[`observed_${policy.allowed_variable}`]
      ?? previous?.observation[policy.allowed_variable] ?? null;
    const currentLevel = typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? measured : null;
    const actionSafety = athleteState.safety_action;
    const blocksRunning = ['NO_RUNNING', 'NO_LOWER_BODY'].includes(actionSafety) && !policy.family.startsWith('strength_upper');
    const omit = ['FULL_REST', 'PROFESSIONAL_ASSESSMENT_RECOMMENDED', 'MODIFIED_SESSION_ONLY'].includes(actionSafety)
      || blocksRunning || !policy.phase_compatibility.includes(phase)
      || (actionSafety === 'NO_HIGH_INTENSITY' && !['aerobic_volume', 'hyrox_skill'].includes(policy.family));
    let action = 'HOLD';
    if (omit) action = 'OMIT';
    else if (['CAUTION', 'RECOVERY'].includes(athleteState.recovery_state)
      || ['PAIN_LIMITED', 'EXCESSIVE_STRAIN'].includes(last?.outcome.outcome)
      || (recent.length >= 2 && recent.slice(-2).every(r => ['UNDER_TARGET', 'INCOMPLETE'].includes(r.outcome.outcome)))
      || ramp.decision === 'DELOAD') action = 'REGRESS';
    else if (!uncertainLatest && policy.recovery_requirements.includes(athleteState.recovery_state)
      && ['NORMAL', 'MONITOR'].includes(actionSafety) && currentLevel !== null
      && !['TAPER_RACE_WEEK', 'SHARPENING', 'POST_RACE_TRANSITION'].includes(phase)
      && (policy.family !== 'long_run' || planning - last.instant <= 7 * 86400000)
      && recent.slice(-2).length === 2 && recent.slice(-2).every(r => r.hasActual && r.outcome.outcome === 'ON_TARGET')
      && new Set(recent.slice(-2).map(r => r.outcome.observed_at.slice(0, 10))).size === 2
      && (!policy.family.startsWith('aerobic') && policy.family !== 'long_run' || ramp.decision === 'ADVANCE')) action = 'ADVANCE';
    return {
      ...policy, action, current_level: currentLevel,
      previous_successful_exposure: previous ? previous.outcome : null,
      previous_success: previous !== undefined,
      max_change_fraction: action === 'ADVANCE' ? policy.max_increase_fraction : action === 'REGRESS' ? -policy.max_regression_fraction : 0,
      next_level_ceiling: currentLevel === null || action === 'OMIT' ? null
        : Math.floor(currentLevel * (action === 'ADVANCE' ? 1 + policy.max_increase_fraction : action === 'REGRESS' ? 0.9 : 1)),
      observed_outcomes: recent.map(r => r.outcome),
      reason_codes: [action === 'ADVANCE' ? 'PROGRESSION_OBSERVED_ADVANCE' : `PROGRESSION_${action}`],
      running_ramp: ['aerobic_volume', 'long_run'].includes(policy.family) ? ramp : null,
    };
  });
}
// Backward demand is a conditional target, not a ledger of completed weeks.
// Only the existing observed progression gate can authorize the next exposure.
function buildLongRunDemand({ athleteState, goalGap, progression } = {}) {
  const goal = goalGap?.goal, policy = goal && eventPolicyForGoal(goal);
  if (!goal?.planning_eligible || !['ROAD_ENDURANCE', 'MARATHON'].includes(policy?.event_kind)
    || !goal.distance_miles || !goal.event_local_date) return null;
  const peak = Math.round(peakLongRunDemand(goal.distance_miles,
    goal.target_time_s !== null ? 'pr' : goal.goal_type) * 1609.344);
  const peakDate = addDays(goal.event_local_date, -policy.taper_days - policy.recovery_buffer_days);
  const days = daysBetween(athleteState.planning_date_local, peakDate);
  const steps = Math.max(0, Math.ceil(days / 7));
  const growth = progression.max_increase_fraction;
  const demand = Math.ceil(peak / (1 + growth) ** Math.max(0, steps - 1));
  const observed = progression.current_level;
  const ceiling = progression.next_level_ceiling;
  const observedAt = progression.previous_successful_exposure?.observed_at;
  const nextObservedWeek = observedAt ? addDays(mondayFor(observedAt.slice(0, 10)), 7) : null;
  const observedSteps = nextObservedWeek ? Math.max(0, Math.ceil(daysBetween(nextObservedWeek, peakDate) / 7)) : null;
  const observedDemand = observedSteps === null ? null : Math.ceil(peak / (1 + growth) ** Math.max(0, observedSteps - 1));
  const next = observed === null || ceiling === null ? null : Math.min(ceiling,
    progression.action === 'ADVANCE' ? Math.max(observed, Math.min(peak, observedDemand)) : ceiling);
  return { policy_id: policy.event_policy_id, goal_id: goal.goal_id,
    event_revision: goal.event_revision, source_revision: goal.source_revision,
    event_local_date: goal.event_local_date, peak_date_local: peakDate,
    registry_peak_distance_m: peak, remaining_exposure_opportunities: steps,
    backward_demand_distance_m: demand, observation_bound_demand_distance_m: observedDemand, observed_success_distance_m: observed,
    observed_evidence_ids: progression.previous_successful_exposure?.source_evidence_ids || [],
    actual_progression_action: progression.action, observed_next_level_ceiling_m: ceiling,
    next_distance_ceiling_m: next,
    runway_supports_peak: observed === null ? null : observed >= peak
      || progression.action === 'ADVANCE' && observed * (1 + growth) ** steps >= peak,
    curve_requires_future_observed_success: true,
    demand_is_observation: false, future_success_assumed: false,
    // Bounded diagnostic curve; no sessions or observed coverage are created.
    curve: Array.from({ length: Math.min(52, steps) }, (_, i) => ({
      opportunity: i + 1, demand_distance_m: Math.ceil(peak / (1 + growth) ** Math.max(0, steps - i - 1)),
    })), curve_truncated: steps > 52 };
}
module.exports = { PROGRESSION_FAMILIES, progressionFamilyFor, buildFamilyProgression, buildLongRunDemand };
