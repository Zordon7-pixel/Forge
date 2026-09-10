// Activity identity, completion evidence and workload are separate authorities.
// Reuse the existing evidence normalizer; do not deduplicate by date or invent
// a new physiological response to the number of recordings.
const { canonicalizeRunLoadInput } = require('./goalBackwardEvidence');
const { canonicalHash } = require('./racePlanPolicy');
const { isExplicitlyUnlinkedRun } = require('./plannedRunMatch');
const { resolveRunEffort } = require('./runEffort');
const { summarizeRecentRunLoad } = require('./recentRunLoad');
const { classifyCompletionOutcome } = require('./adaptationEngine');

const PAIN = ['none', 'mild', 'moderate', 'severe'];
const HARD_TYPES = new Set(['quality', 'tempo', 'threshold', 'interval', 'intervals', 'speed', 'hill', 'race', 'benchmark', 'time_trial', 'long']);
const HARD_FAMILIES = new Set(['threshold_run', 'interval_run', 'race_rhythm_run', 'assessment', 'race']);

function activityAssessment({ athleteId, runs = [], corrections = [], planningDateLocal,
  timezone = 'UTC', weeklyBaseline = null, recoveryState = 'unknown', focusRunId = null,
  observationInstant = new Date(), providerCoverage = [] }) {
  if (runs.some(row => row.user_id != null && String(row.user_id) !== String(athleteId))) {
    throw new Error('Activity assessment contains foreign evidence');
  }
  const load = canonicalizeRunLoadInput({ athleteId, runs, corrections, timezone, planningDateLocal, includeActivitySources: true,
    // Observation time is server-owned, independent of the requested local date.
    // A future planning date must not expire current provider evidence.
    planningInstant: observationInstant, providerCoverage });
  const rawById = new Map(runs.map(row => [String(row.id), row]));
  const sources = new Map(load.canonical_run_rows.map(row => [row.id,
    row.source_evidence_ids.map(id => rawById.get(id)).filter(Boolean)]));
  const canonicalRuns = load.canonical_run_rows.map(row => {
    const group = sources.get(row.id) || [];
    const rated = group.map(source => ({ source, effort: resolveRunEffort(source) }))
      .filter(value => value.effort.source === 'user_rated').sort((a, b) => b.effort.score - a.effort.score)[0];
    const pain = group.map(source => String(source.pain_level || '')).filter(value => PAIN.includes(value))
      .sort((a, b) => PAIN.indexOf(b) - PAIN.indexOf(a))[0];
    return { ...row,
      ...(rated ? { perceived_effort: rated.effort.score, watch_mode: 'assessment_normalized', notes: null } : {}),
      ...(pain ? { pain_level: pain } : {}),
      ...(group.some(source => source.post_energy === 'low') ? { post_energy: 'low' } : {}),
      evidence_ids: group.map(source => String(source.id)).sort(),
      explicitly_unlinked: group.some(source => isExplicitlyUnlinkedRun(source.planned_session_json)),
    };
  });
  const focused = focusRunId ? canonicalRuns.find(row => row.evidence_ids.includes(String(focusRunId))) : null;
  const recentRunLoad = summarizeRecentRunLoad(canonicalRuns, { todayISO: planningDateLocal,
    weeklyBaseline, recoveryState, focusRunId: focused?.id || null,
    coverageComplete: ['COMPLETE', 'VALID_ZERO'].includes(load.load_input_state) });
  // Settled-decision reuse concerns coaching meaning, not incidental provider
  // enrichment. A derived pace/summary_source update cannot create a new dose
  // or prompt. Raw observation hashes and input revisions still bind accept.
  const meaningfulRuns = canonicalRuns.map(row => ({ id: row.id, evidence_ids: row.evidence_ids,
    date: row.date, type: row.type, performance_evidence_type: row.performance_evidence_type,
    distance_miles: row.distance_miles, duration_seconds: row.duration_seconds,
    perceived_effort: row.perceived_effort, avg_heart_rate: row.avg_heart_rate,
    pain_level: row.pain_level, post_energy: row.post_energy, heart_rate_zones: row.heart_rate_zones,
    health_source: row.health_source, explicitly_unlinked: row.explicitly_unlinked }));
  return { athleteId: String(athleteId), load, canonicalRuns, recentRunLoad, sources,
    fingerprint: canonicalHash({ version: 'activity-assessment-v1', planningDateLocal, timezone,
      identity: load.identity_decision_receipt, correction_state: load.correction_input_state,
      correction_receipt_hash: load.correction_receipt_hash, coverage_state: load.coverage_state,
      load_input_state: load.load_input_state, canonicalRuns: meaningfulRuns, recentRunLoad,
      links: runs.map(row => ({ id: row.id, plan_session_id: row.plan_session_id || null,
        planned_session_json: row.planned_session_json || null })).sort((a, b) => String(a.id).localeCompare(String(b.id))) }) };
}

function linkedSnapshot(source) {
  if (source.planned_session_json == null) return null;
  try {
    const value = typeof source.planned_session_json === 'string' ? JSON.parse(source.planned_session_json) : source.planned_session_json;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function qualifiedLink(source, item, session, id, date, assessment, planId, predecessorHashes) {
  if (!id || !date || String(source.plan_session_id || '') !== id
    || String(source.date || '').slice(0, 10) !== date
    || source.user_id != null && String(source.user_id) !== assessment.athleteId) return false;
  const snapshot = linkedSnapshot(source);
  // A bare legacy ID cannot prove which revision/plan/date it once referred to.
  if (!snapshot) return false;
  if (snapshot.matchSource !== 'explicit_owned_session') return false;
  if (String(snapshot.sessionId ?? snapshot.session_id ?? '') !== id
    || String(snapshot.date ?? snapshot.scheduled_local_date ?? '') !== date) return false;
  const expectedPlan = planId || item.plan_id || session.plan_id;
  if (!expectedPlan || String(snapshot.planId ?? snapshot.plan_id ?? '') !== String(expectedPlan)) return false;
  const kind = snapshot.kind || snapshot.modality;
  if (kind && kind !== 'run') return false;
  const hash = snapshot.content_hash || snapshot.canonical_content_hash;
  if (Number(session.canonical_workout_schema_version) === 1 && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) return false;
  if (hash && hash !== session.content_hash && !predecessorHashes?.get(id)?.has(hash)) return false;
  return true;
}

function runCompletionEvidence(sessions, assessment, completedIds = [], { planId = null, acceptedPlan = null } = {}) {
  const predecessorHashes = acceptedPlan ? require('./activityCanonicalSuccessor').completionPredecessorHashes(acceptedPlan) : null;
  const marked = new Set(completedIds.map(String));
  const used = new Set();
  return sessions.map(item => {
    const session = item.session || item;
    const id = String(item.sessionId || session.session_id || session.id || '');
    const date = String(item.date || session.scheduled_local_date || '');
    const family = session.workout_family;
    const protectedIntent = HARD_FAMILIES.has(family) || family === 'long_aerobic'
      || HARD_TYPES.has(String(session.type || session.workout_type || '').toLowerCase());
    const matches = id ? assessment.canonicalRuns.filter(row => !used.has(row.id) && !row.explicitly_unlinked
      && row.date === date
      && (assessment.sources.get(row.id) || []).some(source => qualifiedLink(source, item, session, id, date, assessment, planId, predecessorHashes)))
      : [];
    // Two separately logged fragments are real workload, not proof that a
    // continuous long run or interval prescription was executed. Prefer a
    // complete observation over the first partial one; never add completion
    // ratios across recordings.
    const row = [...matches].sort((a, b) => Number(b.duration_seconds || 0) - Number(a.duration_seconds || 0)
      || Number(b.distance_miles || 0) - Number(a.distance_miles || 0) || a.id.localeCompare(b.id))[0];
    for (const match of matches) used.add(match.id);
    // Type, date and even RPE cannot prove the prescribed interval structure.
    // Existing explicit athlete completion is retained separately below.
    const intentMatches = !protectedIntent;
    const hasComparableDose = Boolean(row && (row.duration_seconds > 0 && session.derived_totals?.duration_s > 0
      || row.distance_miles > 0 && session.derived_totals?.distance_m > 0));
    const outcome = row && intentMatches && hasComparableDose ? classifyCompletionOutcome({ prescribedSession: session,
      observation: { observed_distance_m: row.distance_miles == null ? null : row.distance_miles * 1609.344,
        observed_duration_s: row.duration_seconds } }) : null;
    const completed = Boolean(id) && (marked.has(id) || Boolean(outcome && ['ON_TARGET', 'ABOVE_TARGET'].includes(outcome.outcome)));
    return { sessionId: id, date: item.date || session.scheduled_local_date, completed,
      attempted: Boolean(row), source: marked.has(id) ? 'explicit_completion' : row ? 'linked_activity' : 'no_qualified_link',
      activityId: row?.id || null, outcome: outcome?.outcome || null,
      reason: row && !intentMatches ? 'WORKOUT_INTENT_NOT_DEMONSTRATED'
        : row && !hasComparableDose ? 'COMPLETION_DOSE_UNKNOWN' : null };
  });
}

module.exports = { activityAssessment, runCompletionEvidence };
