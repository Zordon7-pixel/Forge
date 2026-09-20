// Opt-in, pure foundation seam. No route, persistence write, clock, or model calls.
const { buildAthleteState, buildEvidenceStateArtifacts } = require('./goalBackwardEvidence');
const { buildPipelineArtifact } = require('./planCandidateLifecycle');
const { canonicalHash, daysBetween, mondayFor, eventPolicyForGoal } = require('./racePlanPolicy');
const { selectGoalBackwardPhase } = require('./goalBackwardDecisionEngine');
const { buildGoalGaps } = require('./adaptiveCoachingGoalGap');
const { buildFamilyProgression } = require('./adaptiveCoachingProgression');
const { buildWeeklyObjectives, buildSessionSelectionContracts } = require('./adaptiveCoachingObjectives');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function capacity(value, max, name) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} must be an integer from 0 to ${max}`);
  return value;
}

/**
 * Input snapshot is the existing EvidenceSnapshot (explicit planning instant).
 * stateOptions uses buildAthleteState's existing options, including observed weeks,
 * readiness, performanceAnchors, locks and previousState. context is the current
 * buildConcurrentContext shape; only constraints are taken from it, never its
 * inferred fitness or unknown recovery defaults. completionPairs are linked
 * {prescribed_session: canonical workout, observation: completion evidence}.
 * Returned artifacts are the first THREE rows of the existing seven-kind chain;
 * later workers persist them with the candidate/validator/workout/manifest rows.
 */
function buildAdaptiveCoachingFoundation({ snapshot, context = {}, stateOptions = {}, goals = [], races = [],
  completionPairs = [], weeklyMileageHistory = [], readinessTrend = null, feasibilityByGoal = {},
  phaseEvidence = {}, priorPlanRevision = null } = {}) {
  if (priorPlanRevision !== null && (!Number.isSafeInteger(priorPlanRevision) || priorPlanRevision < 0)) {
    throw new Error('Invalid prior plan revision');
  }
  if (!snapshot?.created_at || !snapshot?.planning_date_local || !snapshot?.evidence_snapshot_id) {
    throw new Error('An existing timestamped EvidenceSnapshot is required');
  }
  const target = context.target || {}, profile = context.profile || {};
  const capacities = {
    run: capacity(target.runDaysPerWeek ?? profile.run_days_per_week ?? 0, 7, 'run capacity'),
    lift: capacity(target.liftDaysPerWeek ?? profile.lift_days_per_week ?? 0, 5, 'lift capacity'),
  };
  const maxMinutes = target.maxSessionMinutes ?? null;
  if (maxMinutes !== null && (typeof maxMinutes !== 'number' || !Number.isFinite(maxMinutes) || maxMinutes < 1 || maxMinutes > 1440)) {
    throw new Error('maxSessionMinutes must be null or 1–1440');
  }
  const evidenceIds = new Set(snapshot.evidence.map(e => e.evidence_id));
  const pairs = JSON.parse(JSON.stringify(completionPairs)).sort((a, b) =>
    String(a.observation?.observed_at || '').localeCompare(String(b.observation?.observed_at || ''))
    || String(a.prescribed_session?.session_id || '').localeCompare(String(b.prescribed_session?.session_id || '')));
  for (const pair of pairs) {
    const obs = pair.observation || {};
    if (obs.athlete_id && obs.athlete_id !== snapshot.athlete_id) throw new Error('Completion owner mismatch');
    const refs = [...(obs.source_evidence_ids || []), obs.evidence_id].filter(Boolean);
    if (refs.some(id => !evidenceIds.has(id))) throw new Error('Completion evidence is outside snapshot');
  }
  const anchors = [...(stateOptions.performanceAnchors || [])].map(anchor => {
    const raw = snapshot.evidence.find(e => e.evidence_id === anchor.evidence_id);
    const activity = snapshot.canonical_activities.find(a => a.evidence_ids.includes(anchor.evidence_id));
    const source = activity || raw;
    const age = daysBetween(String(source?.observed_at || '').slice(0, 10), snapshot.planning_date_local);
    // Corrected canonical observations, never anchor/request-supplied numbers.
    return { ...anchor, distance_m: activity ? activity.distance_m : raw?.value?.distance_m ?? null,
      duration_s: activity ? activity.duration_s : raw?.value?.duration_s ?? null,
      observed_at: source?.observed_at ?? null, quality_state: source?.quality_state ?? 'UNKNOWN',
      value_state: source?.value_state ?? 'UNKNOWN',
      freshness_state: age !== null && age >= 0 && age <= 42 ? 'FRESH' : 'STALE' };
  }).sort((a, b) => String(a.evidence_id).localeCompare(String(b.evidence_id)));
  if (anchors.some(a => !evidenceIds.has(a.evidence_id) || a.athlete_id && a.athlete_id !== snapshot.athlete_id)) {
    throw new Error('Performance evidence is outside athlete snapshot');
  }
  const athleteState = buildAthleteState({ ...stateOptions, snapshot, performanceAnchors: anchors,
    weeks: (stateOptions.weeks || []).filter(week => String(week.week_id || week.start_date_local || '') < mondayFor(snapshot.planning_date_local)),
    availableDays: stateOptions.availableDays ?? target.trainingDays ?? [],
    equipment: stateOptions.equipment ?? profile.equipment ?? [],
    adaptiveFoundation: { version: 'adaptive-foundation-v1', capacities, max_session_minutes: maxMinutes,
      context_safety: { active_injury: context.safety?.activeInjury === true,
        comeback_mode: context.safety?.comebackMode === true, injury_notes_present: context.safety?.injuryNotesPresent === true },
      completion_pairs: pairs, weekly_mileage_history: weeklyMileageHistory, readiness_trend: readinessTrend },
  });
  const goalGaps = buildGoalGaps({ athleteState, goals, races, feasibilityByGoal });
  const primary = goalGaps[0];
  // A previous event's development/peak receipt cannot authorize its successor.
  const phaseBindingMatches = primary && ['goal_id', 'event_revision', 'source_revision', 'event_local_date']
    .every(key => phaseEvidence[key] === primary.goal[key]);
  const activePhaseEvidence = (goals.length <= 1 && !phaseEvidence.goal_id) || phaseBindingMatches ? phaseEvidence : {};
  const phaseDecision = selectGoalBackwardPhase({
    goal: primary?.goal || {}, event_policy: primary ? eventPolicyForGoal(primary.goal) : null,
    planning_date_local: snapshot.planning_date_local, athlete_state: athleteState,
    goal_gap: primary, phase_authority: 'adaptive-foundation-v1',
    development_gate_complete: activePhaseEvidence.development_gate_complete === true,
    peak_exposure_complete: activePhaseEvidence.peak_exposure_complete === true,
    safe_useful_peak_fits: activePhaseEvidence.safe_useful_peak_fits === true,
    due_exposure_count: primary ? eventPolicyForGoal(primary.goal)?.required_exposure_ledger?.EVENT_SPECIFIC_DEVELOPMENT?.length || 0 : 0,
  });
  const progression = buildFamilyProgression({ athleteState, completionPairs: pairs,
    weeklyMileageHistory, readinessTrend, phase: phaseDecision.phase });
  const weeklyObjectives = buildWeeklyObjectives({ athleteState, goalGaps, phaseDecision, progression });
  const selection = buildSessionSelectionContracts({ athleteState, weeklyObjectives });
  const content = { version: 'adaptive-foundation-v1',
    ...(priorPlanRevision === null ? {} : { plan_revision: priorPlanRevision }), athlete_id: snapshot.athlete_id,
    athlete_state_hash: athleteState.athlete_state_hash, athlete_state_revision: athleteState.athlete_state_revision,
    evidence_snapshot_id: snapshot.evidence_snapshot_id, planning_date_local: snapshot.planning_date_local,
    phase: phaseDecision.phase, phase_reason_codes: phaseDecision.reason_codes,
    active_goal_id: primary?.goal_id || null,
    goal_gap: goalGaps, weekly_objectives: weeklyObjectives, session_selection: selection,
    pipeline_stages: ['athlete_state', 'goal_gap', 'phase', 'weekly_objectives', 'session_selection'],
    reason_codes: weeklyObjectives.reason_codes };
  const hash = canonicalHash(content);
  const decision = { ...content, decision_id: `decision-${hash.slice(0, 24)}`, decision_hash: hash };
  const artifacts = buildEvidenceStateArtifacts({ snapshot, athleteState, decisionId: decision.decision_id, createdAt: snapshot.created_at });
  const decisionArtifact = buildPipelineArtifact({ userId: snapshot.athlete_id, kind: 'planning_decision',
    decisionId: decision.decision_id, parentArtifactId: athleteState.athlete_state_id,
    payload: decision, createdAt: snapshot.created_at });
  return freeze({ athlete_state: athleteState, decision, artifacts: [...artifacts, decisionArtifact] });
}
module.exports = { buildAdaptiveCoachingFoundation };
