// Forged Hybrid H4 transparent adaptation engine.
// Pure and deterministic: no DB, network, framework, or wall-clock dependency.

const planSchema = require('./planSchema');
const checkinOverride = require('./checkinOverride');
const { canonicalHash } = require('./racePlanPolicy');
const { candidateRejectionMatches } = require('./planCandidateLifecycle');

const HARD_RUN_PATTERN = /(long|quality|tempo|threshold|interval|hill|hard|speed|vo2|race|zone 3|zone 4|zone 5|z3|z4|z5)/i;
const HEALTH_STALE = new Set(['stale', 'suspect', 'missing', 'no_data', 'unknown']);
const MODERATE_INJURY_WINDOW_DAYS = 14;
const MODERATE_INJURY_VOLUME_MULTIPLIER = 0.75;
// Product prescription policy, not a health-benefit or medical threshold.
// FORGE-RACE-TRAVEL-ADAPTATION-SPEC.md already establishes 20 minutes as the
// repository's conservative executable recovery-run dose. Adaptations may be
// distance-only, so 1.5 miles is the paired product guard against the known
// 0.5-0.8 mile token-run leak. We never increase a reduced dose to these floors:
// an under-floor or unquantified run becomes an explicit lower-strain choice.
const MIN_EFFECTIVE_RECOVERY_RUN_MINUTES = 20;
const MIN_EFFECTIVE_RECOVERY_RUN_MILES = 1.5;
const COMPLETION_OUTCOMES = Object.freeze([
  'UNDER_TARGET',
  'ON_TARGET',
  'ABOVE_TARGET',
  'EXCESSIVE_STRAIN',
  'INCOMPLETE',
  'PAIN_LIMITED',
  'UNSCORABLE_PARTIAL_SYNC',
]);
const COMPLETION_OUTCOME_SET = new Set(COMPLETION_OUTCOMES);

function finiteMetric(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFiniteMetric(source = {}, keys = []) {
  for (const key of keys) {
    const value = finiteMetric(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function classifyCompletionOutcome(input = {}) {
  const observation = input.observation && typeof input.observation === 'object'
    ? input.observation : input;
  const observedValue = observation.value && typeof observation.value === 'object'
    && !Array.isArray(observation.value) ? observation.value : {};
  const prescribed = input.prescribedSession ?? input.prescribed_session ?? observation.prescribed_session ?? {};
  const quality = String(observation.quality_state ?? observation.qualityState ?? '').toUpperCase();
  const sync = String(observation.sync_state ?? observation.syncState ?? observation.coverage_state ?? '').toUpperCase();
  const completionState = String(observation.completion_state ?? observation.completionState
    ?? observedValue.completion_state ?? observation.status ?? '').toLowerCase();
  const explicit = String(observation.outcome ?? observedValue.outcome ?? '').toUpperCase();
  const failedSync = quality === 'FAILED_SYNC' || sync === 'FAILED_SYNC';
  const partial = failedSync || ['PARTIAL', 'PARTIAL_SYNC'].includes(quality)
    || ['PARTIAL', 'PARTIAL_SYNC'].includes(sync);
  const pain = observation.pain_limited === true
    || observation.painLimited === true
    || observedValue.pain_limited === true
    || (firstFiniteMetric(observation, ['pain_level', 'painLevel', 'pain'])
      ?? firstFiniteMetric(observedValue, ['pain_level', 'painLevel', 'pain'])) > 0;
  const incomplete = observation.completed === false
    || observation.incomplete === true
    || ['missed', 'incomplete', 'abandoned', 'did_not_start'].includes(completionState);
  const excessive = observation.excessive_strain === true
    || observation.excessiveStrain === true
    || observedValue.excessive_strain === true
    || ((firstFiniteMetric(observation, ['perceived_exertion', 'perceivedEffort', 'rpe'])
      ?? firstFiniteMetric(observedValue, ['perceived_exertion', 'perceived_effort', 'rpe'])) >= 9
      && (observation.target_met ?? observedValue.target_met) !== false);
  const observedDistance = firstFiniteMetric(observation, [
    'observed_distance_m', 'observedDistanceM', 'distance_m', 'distanceMeters',
  ]) ?? firstFiniteMetric(observedValue, ['distance_m', 'observed_distance_m']);
  const prescribedDistance = firstFiniteMetric(prescribed, [
    'prescribed_distance_m', 'distance_m', 'running_distance_m', 'distanceMeters',
  ]) ?? finiteMetric(prescribed.derived_totals?.distance_m)
    ?? firstFiniteMetric(observation, ['prescribed_distance_m', 'prescribedDistanceM']);
  const observedDuration = firstFiniteMetric(observation, [
    'observed_duration_s', 'observedDurationS', 'duration_s', 'durationSeconds',
  ]) ?? firstFiniteMetric(observedValue, ['duration_s', 'observed_duration_s']);
  const prescribedDuration = firstFiniteMetric(prescribed, [
    'prescribed_duration_s', 'duration_s', 'durationSeconds',
  ]) ?? finiteMetric(prescribed.derived_totals?.duration_s)
    ?? firstFiniteMetric(observation, ['prescribed_duration_s', 'prescribedDurationS']);
  const ratios = [];
  if (observedDistance !== null && prescribedDistance > 0) ratios.push(observedDistance / prescribedDistance);
  if (observedDuration !== null && prescribedDuration > 0) ratios.push(observedDuration / prescribedDuration);
  const ratio = ratios.length ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : null;
  let outcome;
  if (partial) outcome = 'UNSCORABLE_PARTIAL_SYNC';
  else if (pain) outcome = 'PAIN_LIMITED';
  else if (incomplete) outcome = 'INCOMPLETE';
  else if (excessive) outcome = 'EXCESSIVE_STRAIN';
  else if (COMPLETION_OUTCOME_SET.has(explicit)) outcome = explicit;
  else if ((observation.target_met ?? observedValue.target_met) === true) outcome = 'ON_TARGET';
  else if (ratio !== null && ratio < 0.9) outcome = 'UNDER_TARGET';
  else if (ratio !== null && ratio > 1.1) outcome = 'ABOVE_TARGET';
  else outcome = 'ON_TARGET';
  const reasonCodes = [];
  if (outcome === 'UNSCORABLE_PARTIAL_SYNC') reasonCodes.push(failedSync ? 'FAILED_SYNC' : 'PARTIAL_SYNC');
  if (outcome === 'EXCESSIVE_STRAIN') reasonCodes.push('EXCESSIVE_STRAIN');
  if (outcome === 'PAIN_LIMITED') reasonCodes.push('PAIN_MONITOR');
  if (outcome === 'INCOMPLETE') reasonCodes.push('MISSED_SESSION_SKIP');
  if (outcome === 'ON_TARGET' && String(prescribed.role || '').toUpperCase() === 'PRIMARY_KEY') {
    reasonCodes.push('KEY_SESSION_COMPLETED_ON_TARGET');
  }
  const sourceEvidenceIds = [...new Set([
    ...(observation.source_evidence_ids || observation.sourceEvidenceIds || []),
    observation.evidence_id ?? observation.evidenceId ?? null,
  ].filter(Boolean).map(String))].sort();
  return Object.freeze({
    outcome,
    scorable: outcome !== 'UNSCORABLE_PARTIAL_SYNC',
    designated_assessment: observation.designated_assessment === true
      || observation.designatedAssessment === true
      || String(prescribed.role || '').toUpperCase() === 'ASSESSMENT',
    linked_session_id: String(prescribed.session_id ?? prescribed.sessionId ?? prescribed.id
      ?? observation.linked_session_id ?? observation.session_id ?? '').trim() || null,
    observed_at: observation.observed_at ?? observation.observedAt ?? null,
    observed_to_prescribed_ratio: outcome === 'UNSCORABLE_PARTIAL_SYNC' || ratio === null
      ? null : Math.round(ratio * 10000) / 10000,
    source_evidence_ids: sourceEvidenceIds,
    reason_codes: Object.freeze(reasonCodes),
  });
}

function summarizeCompletionOutcomes(outcomes = []) {
  const normalized = (Array.isArray(outcomes) ? outcomes : [])
    .filter((entry) => entry && COMPLETION_OUTCOME_SET.has(entry.outcome));
  const scorable = normalized.filter((entry) => entry.scorable !== false);
  const safetySignal = scorable.some((entry) => ['EXCESSIVE_STRAIN', 'PAIN_LIMITED'].includes(entry.outcome));
  const assessmentSignal = scorable.some((entry) => entry.designated_assessment === true);
  const materialEligible = safetySignal || assessmentSignal || scorable.length >= 2;
  const reasonCodes = [...new Set(normalized.flatMap((entry) => entry.reason_codes || []))];
  const singleOrdinaryOutlierProtected = scorable.length === 1 && !safetySignal && !assessmentSignal;
  return Object.freeze({
    outcome_counts: Object.freeze(Object.fromEntries(COMPLETION_OUTCOMES.map((outcome) => [
      outcome,
      normalized.filter((entry) => entry.outcome === outcome).length,
    ]))),
    scorable_count: scorable.length,
    unscorable_count: normalized.length - scorable.length,
    material_adaptation_eligible: materialEligible,
    single_ordinary_outlier_protected: singleOrdinaryOutlierProtected,
    reason_codes: Object.freeze([...new Set(reasonCodes)]),
  });
}

function translateCompletionEvidence(input = {}, prescribedSessions = []) {
  const completion = input.completion || input.adherence || {};
  const explicit = input.completionObservations ?? input.completion_observations
    ?? completion.sessionCompletions ?? completion.session_completions ?? [];
  const observations = Array.isArray(explicit) ? [...explicit] : [];
  if (!observations.length && (completion.evidence_id || completion.evidenceId)) observations.push(completion);

  const checkin = input.checkin || {};
  const checkinSessionId = checkin.linked_session_id ?? checkin.completed_session_id;
  const checkinFlags = normalizeLifeFlags(checkin.life_flags);
  if ((checkin.evidence_id || checkin.evidenceId) && checkinSessionId
    && (checkin.post_workout === true || checkin.post_run === true)
    && (checkin.pain_limited === true || finiteMetric(checkin.pain_level) > 0
      || checkinFlags.some((flag) => ['injured', 'sore'].includes(flag)))) {
    observations.push({
      ...checkin,
      linked_session_id: checkinSessionId,
      pain_limited: true,
    });
  }

  const recentRun = input.recentRunLoad?.latestRun ?? input.recentRunLoad?.protectiveRun;
  if (recentRun && (recentRun.evidence_id || recentRun.evidenceId)
    && (recentRun.linked_session_id || recentRun.session_id)) {
    observations.push({
      ...recentRun,
      linked_session_id: recentRun.linked_session_id ?? recentRun.session_id,
      pain_limited: recentRun.postRunPain && recentRun.postRunPain !== 'none',
      excessive_strain: recentRun.postRunEnergy === 'low' && Number(recentRun.perceivedEffort || 0) >= 9,
    });
  }

  const prescribedById = new Map((Array.isArray(prescribedSessions) ? prescribedSessions : []).map((session) => [
    String(session.session_id ?? session.id ?? ''), session,
  ]));
  const deduplicated = [...new Map(observations.map((observation, index) => {
    const evidenceId = String(observation?.evidence_id ?? observation?.evidenceId ?? `unpersisted-${index}`);
    const linkedId = String(observation?.linked_session_id ?? observation?.session_id ?? '');
    return [`${evidenceId}:${linkedId}`, observation];
  })).values()];
  return Object.freeze(deduplicated.map((observation) => {
    const linkedId = String(observation.linked_session_id ?? observation.session_id ?? '');
    return classifyCompletionOutcome({
      observation,
      prescribedSession: prescribedById.get(linkedId) || {},
    });
  }));
}

function parseISODate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(iso, amount) {
  const date = parseISODate(iso);
  if (!date) return null;
  return toISODate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function compareISO(a, b) {
  const left = parseISODate(a);
  const right = parseISODate(b);
  if (!left || !right) return 0;
  return left.getTime() - right.getTime();
}

function daysBetweenISO(laterISO, earlierISO) {
  const later = parseISODate(laterISO);
  const earlier = parseISODate(earlierISO);
  if (!later || !earlier) return null;
  return Math.round((later.getTime() - earlier.getTime()) / 86400000);
}

function isWithin(date, start, end) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    && compareISO(date, start) >= 0
    && compareISO(date, end) <= 0;
}

function normalizeLifeFlags(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function hasCheckinSignal(checkin = {}) {
  if (!checkin || typeof checkin !== 'object') return false;
  return ['legs', 'drive', 'feeling', 'sleep_hours', 'time_available'].some((key) => (
    checkin[key] !== undefined && checkin[key] !== null && checkin[key] !== ''
  )) || normalizeLifeFlags(checkin.life_flags).length > 0;
}

function normalizeAxis(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3 ? parsed : null;
}

function isHardRun(session = {}) {
  if (planSchema.kindFromSession(session) !== 'run') return false;
  return HARD_RUN_PATTERN.test([
    session.title,
    session.type,
    session.workout_type,
    session.intensity,
    session.target_zone,
    session.description,
  ].filter(Boolean).join(' '));
}

function sessionSummary(session = {}) {
  const kind = planSchema.kindFromSession(session);
  if (kind === 'lift') return session.title || session.focus || 'Strength session';
  if (kind === 'rest') return 'Rest';
  const miles = Number(session.distance_miles ?? session.distance ?? session.miles);
  const duration = Number(session.duration_min ?? session.duration_minutes ?? session.minutes ?? session.time_minutes);
  const bits = [session.title || session.type || 'Run'];
  if (Number.isFinite(miles) && miles > 0) bits.push(`${Math.round(miles * 10) / 10} mi`);
  else if (Number.isFinite(duration) && duration > 0) bits.push(`${Math.round(duration)} min`);
  if (session.intensity) bits.push(session.intensity);
  return bits.filter(Boolean).join(' - ');
}

function firstNumericSessionValue(session = {}, keys = []) {
  for (const key of keys) {
    const value = Number(session[key]);
    if (Number.isFinite(value) && value > 0) return { key, value };
  }
  return null;
}

function sessionIdFor(day, session, sessionIndex, dayIndex) {
  return planSchema.sessionIdentifier(day, session, sessionIndex, dayIndex);
}

function iterateDays(plan, visitor) {
  const weeks = Array.isArray(plan && plan.weeks) ? plan.weeks : [];
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex] || {};
    const entries = planSchema.getDayEntries(week);
    for (let dayIndex = 0; dayIndex < entries.length; dayIndex += 1) {
      visitor({
        week,
        weekIndex,
        day: entries[dayIndex],
        dayIndex,
        entries,
        entriesKey: planSchema.dayEntriesKey(week),
      });
    }
  }
}

function allDatedSessions(plan, start, end) {
  const result = [];
  iterateDays(plan, ({ weekIndex, day, dayIndex }) => {
    if (!isWithin(day && day.date, start, end)) return;
    const sessions = planSchema.daySessions(day);
    sessions.forEach((session, sessionIndex) => {
      result.push({
        weekIndex,
        dayIndex,
        date: day.date,
        day,
        session,
        sessionIndex,
        sessionId: sessionIdFor(day, session, sessionIndex, dayIndex),
        kind: planSchema.kindFromSession(session),
      });
    });
  });
  return result;
}

function metricValue(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw.value ?? raw.score ?? raw.readinessScore ?? null;
  }
  return raw;
}

function metricFreshness(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.suspect === true) return 'suspect';
    const freshness = String(raw.freshness || '').toLowerCase();
    if (freshness) return freshness;
    if (raw.fresh === true) return 'fresh';
  }
  return 'unknown';
}

function metricAsOf(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.asOf || raw.as_of || null : null;
}

function isUsableHealthMetric(raw) {
  const value = metricValue(raw);
  const freshness = metricFreshness(raw);
  if (value === null || value === undefined || value === '') return false;
  if (HEALTH_STALE.has(freshness)) return false;
  return freshness === 'fresh';
}

function freshnessLabel(raw) {
  const freshness = metricFreshness(raw);
  const asOf = metricAsOf(raw);
  return asOf ? `${freshness} as of ${String(asOf).slice(0, 10)}` : freshness;
}

function firstFreshMetric(healthSignals = {}, keys = []) {
  const metrics = healthSignals.metrics || {};
  for (const key of keys) {
    const metric = metrics[key] ?? healthSignals[key];
    if (isUsableHealthMetric(metric)) return { key, metric, value: Number(metricValue(metric)) };
  }
  return null;
}

function buildHealthEvidence(healthSignals = {}) {
  const evidence = [];
  const drivers = [];
  const addDriver = (signal, metric, detail) => {
    evidence.push({
      signal,
      source: 'apple_health',
      objective: true,
      freshness: freshnessLabel(metric),
      detail,
    });
    drivers.push(signal);
  };

  const readiness = firstFreshMetric(healthSignals, ['readinessScore', 'readiness_score']);
  if (readiness && Number.isFinite(readiness.value) && readiness.value < 70) {
    addDriver(
      'readiness',
      readiness.metric,
      `Objective Apple Health readiness is ${Math.round(readiness.value)}, below the normal training threshold.`
    );
  }

  const sleep = firstFreshMetric(healthSignals, ['sleepHoursLastNight', 'sleep_hours_last_night', 'sleep']);
  if (sleep && Number.isFinite(sleep.value) && sleep.value < 6) {
    addDriver(
      'sleep',
      sleep.metric,
      `Objective Apple Health sleep is ${Math.round(sleep.value * 10) / 10}h, below the recovery target.`
    );
  }

  const hrv = firstFreshMetric(healthSignals, ['hrvMs', 'hrv_ms', 'hrv']);
  if (hrv && Number.isFinite(hrv.value) && hrv.value < 35) {
    addDriver(
      'hrv',
      hrv.metric,
      `Objective Apple Health HRV is ${Math.round(hrv.value)} ms, which indicates recovery stress.`
    );
  }

  const restingHr = firstFreshMetric(healthSignals, ['restingHeartRate', 'resting_heart_rate', 'rhr']);
  if (restingHr && Number.isFinite(restingHr.value) && restingHr.value >= 85) {
    addDriver(
      'resting_hr',
      restingHr.metric,
      `Objective Apple Health resting heart rate is ${Math.round(restingHr.value)} bpm, above the preferred range.`
    );
  }

  const load = firstFreshMetric(healthSignals, ['acuteChronicLoadRatio', 'acute_chronic_load_ratio', 'loadRatio']);
  if (load && Number.isFinite(load.value) && (load.value > 1.4 || load.value < 0.5)) {
    addDriver(
      'load',
      load.metric,
      `Objective Apple Health load ratio is ${Math.round(load.value * 100) / 100}:1, outside the preferred range.`
    );
  }

  const severe = evidence.some((item) => item.signal === 'readiness' && /readiness is ([0-4][0-9])/.test(item.detail))
    || (readiness && readiness.value < 45)
    || (sleep && sleep.value < 5)
    || (hrv && hrv.value < 28);
  const caution = evidence.length > 0;
  return {
    evidence,
    drivers,
    severity: severe ? 'rest' : caution ? 'reduce' : 'none',
  };
}

function buildCheckinEvidence(checkin = {}, todaySessions = []) {
  if (!hasCheckinSignal(checkin)) return { evidence: [], action: 'keep', patch: {}, safety: false, directive: null };
  const runToday = todaySessions.find((item) => item.kind === 'run');
  const flags = normalizeLifeFlags(checkin.life_flags);
  const legs = normalizeAxis(checkin.legs);
  const feeling = Number(checkin.feeling || 3);
  const timeAvailable = Number(checkin.time_available || 60);
  const sleepHours = checkin.sleep_hours === null || checkin.sleep_hours === undefined || checkin.sleep_hours === ''
    ? null
    : Number(checkin.sleep_hours);
  let action = checkinOverride.deriveAction(checkin);
  let patch = runToday ? checkinOverride.buildPatch(action, runToday.session, checkin) : {};
  const heavyLegsOnly = legs === 1
    && action === 'recovery_swap'
    && !flags.some((flag) => ['sick', 'injured', 'not_well', 'sore'].includes(flag))
    && feeling > 2
    && !(timeAvailable > 0 && timeAvailable <= 30)
    && !flags.some((flag) => ['long_shift', 'traveling'].includes(flag))
    && !(Number.isFinite(sleepHours) && sleepHours < 6);
  if (heavyLegsOnly) {
    action = 'keep';
    patch = runToday && isHardRun(runToday.session) ? patchRunForHeavyLegs(runToday.session) : {};
  }
  const includeWhenKeep = heavyLegsOnly && Object.keys(patch || {}).length > 0;
  const directive = checkinOverride.buildDirective(checkin, action, patch, Boolean(runToday), 0);
  const safety = flags.includes('sick') || flags.includes('injured');
  const drivers = Array.isArray(directive.drivers) ? directive.drivers : [];
  const evidence = drivers.length
    ? drivers.map((driver) => ({
      signal: driver.label || 'check-in',
      source: 'checkin',
      objective: false,
      freshness: 'today',
      detail: `Subjective check-in: ${driver.detail || driver.label || 'daily check-in signal'}`,
    }))
    : [{
      signal: 'check-in',
      source: 'checkin',
      objective: false,
      freshness: 'today',
      detail: 'Subjective check-in was recorded and does not require a calendar change.',
    }];
  return { evidence, action, patch, safety, directive, includeWhenKeep };
}

function buildCompletionEvidence(completion = {}) {
  if (!completion || typeof completion !== 'object') return { evidence: [], driver: false };
  if (completion.adaptationEnabled === false) return { evidence: [], driver: false };
  const nullableNonNegative = (value, maximum = Number.MAX_SAFE_INTEGER) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
  };
  const adherence = nullableNonNegative(completion.adherenceRate ?? completion.adherence_rate, 1);
  const missed = nullableNonNegative(completion.missedWorkouts ?? completion.missed_workouts ?? completion.missedCount, 100);
  const missedRuns = nullableNonNegative(completion.missedRuns ?? completion.missedRunCount, 100);
  const missedLifts = nullableNonNegative(completion.missedLifts ?? completion.missedLiftCount, 100);
  const daysInactive = Number(completion.daysInactive ?? completion.days_inactive);
  const daysSinceRun = Number(completion.daysSinceRun ?? completion.days_since_run);
  const lastRunDate = completion.lastRunDate || completion.last_run_date || null;
  const runGapEpisodeKey = completion.runGapEpisodeKey || completion.run_gap_episode_key
    || (lastRunDate ? `run-gap:${lastRunDate}` : null);
  const gapPromptEnabled = completion.gapPromptEnabled !== false;
  const runGap = gapPromptEnabled
    && Boolean(lastRunDate)
    && Number.isFinite(daysSinceRun)
    && daysSinceRun >= 7;
  const driver = runGap || (adherence !== null && adherence < 0.65)
    || (missed !== null && missed >= 2) || (missedRuns !== null && missedRuns >= 2);
  if (!driver) return { evidence: [], driver: false };
  const details = [];
  if (adherence !== null) details.push(`${Math.round(adherence * 100)}% recent adherence`);
  if ([missedRuns, missedLifts, missed].some((value) => value !== null && value > 0)) {
    const missedDetails = [];
    if (missedRuns !== null) missedDetails.push(`${missedRuns} missed runs`);
    if (missedLifts !== null) missedDetails.push(`${missedLifts} missed lifts`);
    if (!missedDetails.length && missed !== null) missedDetails.push(`${missed} missed sessions`);
    details.push(missedDetails.join(', '));
  }
  if (runGap) details.unshift(`${Math.round(daysSinceRun)} days since the last logged run`);
  return {
    driver: true,
    runGap,
    trainingGap: runGap,
    daysSinceRun: runGap ? Math.round(daysSinceRun) : null,
    daysInactive: runGap ? Math.round(daysSinceRun) : null,
    lastRunDate: runGap ? lastRunDate : null,
    episodeKey: runGap ? runGapEpisodeKey : null,
    weeklyMileageBaseline: nullableNonNegative(completion.weeklyMileageBaseline, 300),
    evidence: [{
      signal: runGap ? 'run_gap' : 'adherence',
      source: 'completion',
      objective: true,
      freshness: completion.freshness || 'recent',
      daysSinceRun: runGap ? Math.round(daysSinceRun) : null,
      daysInactive: runGap ? Math.round(daysSinceRun) : null,
      lastRunDate: runGap ? lastRunDate : null,
      episodeKey: runGap ? runGapEpisodeKey : null,
      missedWorkouts: missed,
      detail: runGap
        ? `Forged Hybrid has not seen a logged run for ${Math.round(daysSinceRun)} days. Lifting and life events do not hide the running gap; a bounded easy re-entry is offered without treating it as failure.`
        : `Logged completion history shows ${details.join('; ') || 'recent missed sessions'}, so the next hard run is reduced instead of forcing a catch-up.`
    }],
  };
}

function isDemandingRun(session) {
  return isHardRun(session) || (planSchema.kindFromSession(session) === 'run' && /(steady|moderate|progression|zone 2-3)/i.test(
    [session.title, session.type, session.intensity, session.target_zone].filter(Boolean).join(' ')
  ));
}

function buildRecentRunEvidence(recentRunLoad = {}) {
  const latest = recentRunLoad?.protectiveRun || recentRunLoad?.latestRun;
  const protection = recentRunLoad?.protection;
  if (!latest || !protection?.active) return { evidence: [], driver: false, latest: null, protection: null };
  const details = [
    `${Number(latest.distanceMiles || 0).toFixed(1)} mi`,
    latest.paceLabel || null,
    latest.durationMinutes ? `${Math.round(Number(latest.durationMinutes))} min` : null,
    latest.avgHeartRate ? `avg HR ${Math.round(Number(latest.avgHeartRate))}` : null,
  ].filter(Boolean).join(', ');
  const evidence = [{
    signal: 'recent run load',
    source: 'recent_run',
    objective: true,
    freshness: latest.daysSince === 0 ? 'today' : latest.daysSince === 1 ? 'yesterday' : `${latest.daysSince} days ago`,
    detail: `Logged run: ${details}. Duplicate running, hard sessions, and lower-body loading are protected during the next 24-72 hours.`,
  }];
  if (latest.postRunCaution) {
    const checkinDetails = [
      latest.postRunPain && latest.postRunPain !== 'none' ? `${latest.postRunPain} pain` : null,
      latest.postRunEnergy === 'low' ? 'low energy' : null,
    ].filter(Boolean).join(' and ');
    evidence.push({
      signal: 'post-run check-in',
      source: 'post_run_checkin',
      objective: false,
      freshness: latest.daysSince === 0 ? 'today' : latest.daysSince === 1 ? 'yesterday' : `${latest.daysSince} days ago`,
      detail: `The athlete reported ${checkinDetails}; the next run and lower-body load stay conservative.`,
    });
  }
  return {
    driver: true,
    latest,
    protection,
    evidence,
  };
}

function formatBodyPart(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, ' ') || 'unspecified body part';
}

function normalizeInjurySeverity(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (['severe', 'high'].includes(raw)) return 'severe';
  if (['moderate', 'medium'].includes(raw)) return 'moderate';
  if (['mild', 'low', 'minor'].includes(raw)) return 'mild';
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  if (score >= 8) return 'severe';
  if (score >= 5) return 'moderate';
  if (score >= 1) return 'mild';
  return null;
}

function injuryFreshness(entry = {}, planningDateISO) {
  const date = String(entry.date || entry.logged_at || entry.created_at || entry.freshness || '').slice(0, 10);
  const daysAgo = daysBetweenISO(planningDateISO, date);
  if (daysAgo === null) return { daysAgo: null, label: entry.freshness || 'current' };
  if (daysAgo <= 0) return { daysAgo: 0, label: 'today' };
  if (daysAgo === 1) return { daysAgo, label: 'yesterday' };
  return { daysAgo, label: `${daysAgo} days ago` };
}

function injuryWithinWindow(injury, days) {
  return injury.daysAgo === null || injury.daysAgo <= days;
}

function bodyPartModalities(bodyPart) {
  const part = formatBodyPart(bodyPart);
  const lower = /\b(foot|feet|toe|ankle|achilles|calf|shin|knee|quad|hamstring|hip|groin|glute|it band|plantar|leg|lower back|back)\b/.test(part);
  const upper = /\b(shoulder|elbow|wrist|hand|forearm|bicep|tricep|chest|neck|upper back)\b/.test(part);
  const unknown = !lower && !upper;
  return {
    run: lower || unknown,
    lowerLift: lower || unknown,
    upperLift: upper || unknown,
  };
}

function normalizeInjuryEntries(injuryState = {}, planningDateISO) {
  const arrays = ['openInjuries', 'activeInjuries', 'injuries', 'logs', 'entries'];
  const source = arrays.find((key) => Array.isArray(injuryState[key]));
  const rows = source ? injuryState[source] : (injuryState.active || injuryState.hasActiveInjury ? [injuryState] : []);
  return rows.map((row) => {
    const cleared = row?.cleared === true || row?.cleared === 1 || String(row?.cleared) === '1';
    if (!row || cleared || row.active === false) return null;
    const freshness = injuryFreshness(row, planningDateISO);
    const severity = normalizeInjurySeverity(
      row.severity ?? row.injurySeverity ?? row.painSeverity ?? row.pain_level ?? row.painLevel
    );
    const bodyPart = formatBodyPart(row.bodyPart || row.body_part || row.area);
    return {
      id: row.id || null,
      bodyPart,
      severity,
      notes: row.notes || '',
      date: row.date || row.created_at || null,
      daysAgo: freshness.daysAgo,
      freshness: freshness.label,
      modalities: bodyPartModalities(bodyPart),
    };
  }).filter(Boolean);
}

function injuryRuleDetail(prefix, injury) {
  return `${prefix}: open ${injury.bodyPart} injury (${injury.severity || 'ungraded'}) logged ${injury.freshness}.`;
}

function buildInjuryEvidence(injuryState = {}, planningDateISO = null) {
  const sick = Boolean(injuryState && injuryState.sick);
  if (sick) {
    return {
      safety: true,
      reason: injuryState.reason || injuryState.notes || 'sick',
      rules: [],
      evidence: [{
        signal: 'sick',
        source: 'injury',
        objective: false,
        freshness: injuryState.freshness || 'current',
        detail: `User-logged sick: ${String(injuryState.reason || injuryState.notes || 'sick').slice(0, 180)}.`
      }],
    };
  }

  const entries = normalizeInjuryEntries(injuryState || {}, planningDateISO);
  const hasArraySource = ['openInjuries', 'activeInjuries', 'injuries', 'logs', 'entries'].some((key) => Array.isArray(injuryState?.[key]));
  const legacyActiveWithoutSeverity = Boolean(injuryState && (injuryState.active || injuryState.hasActiveInjury))
    && !hasArraySource
    && entries.length <= 1
    && !entries[0]?.severity;
  if (!entries.length && !legacyActiveWithoutSeverity) return { evidence: [], safety: false, reason: null, rules: [] };

  // Injury thresholds: open pain 5-7/moderate within 14 days trims affected
  // modality volume by 25% and caps intensity; open pain >=8/severe keeps the
  // existing safety-hold path. Legacy active injuries with no severity also
  // keep the existing safety behavior for compatibility.
  const severe = entries.find((entry) => entry.severity === 'severe');
  if (severe || legacyActiveWithoutSeverity) {
    const fallback = entries[0] || {};
    const reason = severe
      ? `open ${severe.bodyPart} injury (${severe.severity}) logged ${severe.freshness}`
      : injuryState.reason || injuryState.notes || `active injury${fallback.bodyPart ? ` (${fallback.bodyPart})` : ''}`;
    return {
      safety: true,
      reason,
      rules: [],
      evidence: [{
        signal: severe ? 'severe injury' : 'active injury',
        source: 'injury',
        objective: false,
        freshness: severe?.freshness || injuryState.freshness || 'current',
        detail: `User-logged ${reason}.`
      }],
    };
  }

  const rules = entries
    .filter((entry) => entry.severity === 'moderate' && injuryWithinWindow(entry, MODERATE_INJURY_WINDOW_DAYS))
    .map((entry) => ({
      action: 'reduce',
      volumeMultiplier: MODERATE_INJURY_VOLUME_MULTIPLIER,
      ...entry,
    }));
  const evidence = rules.map((rule) => ({
    signal: 'moderate injury',
    source: 'injury',
    objective: false,
    freshness: rule.freshness,
    detail: injuryRuleDetail('Reduced affected-modality load', rule),
  }));
  return {
    safety: false,
    reason: rules[0] ? injuryRuleDetail('Reduced affected-modality load', rules[0]) : null,
    rules,
    evidence,
  };
}

function patchRunForHeavyLegs(session) {
  if (!isHardRun(session)) return {};
  return {
    type: 'controlled',
    workout_type: 'run',
    title: 'Controlled aerobic run',
    intensity: 'Moderate',
    target_zone: 'Zone 2-3',
    pace_target: 'Controlled aerobic effort; skip hard surges',
    description: 'Intensity trimmed from today\'s heavy-leg check-in.',
    steps: ['Keep the effort controlled', 'Skip hard repeats or surges', 'Stop if soreness changes your stride'],
    progression: 'Do not add pace or extra reps today.',
    checkin_override: { action: 'keep', label: 'Intensity trimmed from heavy legs' },
  };
}

function recoveryRunDose(session = {}, options = {}) {
  const duration = firstNumericSessionValue(session, ['duration_min', 'duration_minutes', 'minutes', 'time_minutes']);
  const distance = firstNumericSessionValue(session, ['distance_miles', 'distance', 'miles']);
  const basis = String(session.prescription_basis || '').toLowerCase();
  const minutes = duration ? Math.round(duration.value) : null;
  const miles = distance ? Math.round(distance.value * 10) / 10 : null;
  const minimumMinutes = Number.isFinite(Number(options.minimumRunMinutes))
    ? Number(options.minimumRunMinutes) : MIN_EFFECTIVE_RECOVERY_RUN_MINUTES;
  const minimumMiles = Number.isFinite(Number(options.minimumRunMiles))
    ? Number(options.minimumRunMiles) : MIN_EFFECTIVE_RECOVERY_RUN_MILES;

  if (basis === 'time') {
    return {
      meaningful: minutes !== null && minutes >= minimumMinutes,
      decisionReason: minutes === null ? 'dose_unquantified' : 'below_time_minimum',
      basis,
      minutes,
      miles,
    };
  }
  if (basis === 'distance') {
    return {
      meaningful: miles !== null && miles >= minimumMiles,
      decisionReason: miles === null ? 'dose_unquantified' : 'below_distance_minimum',
      basis,
      minutes,
      miles,
    };
  }
  if (minutes === null && miles === null) {
    return { meaningful: false, decisionReason: 'dose_unquantified', basis: 'unquantified', minutes, miles };
  }
  return {
    meaningful: (minutes !== null && minutes >= minimumMinutes)
      || (miles !== null && miles >= minimumMiles),
    decisionReason: 'below_time_and_distance_minimums',
    basis: minutes !== null && miles !== null ? 'time_or_distance' : minutes !== null ? 'time' : 'distance',
    minutes,
    miles,
  };
}

function recoveryWalkOrRest(session, label, dose, options = {}) {
  const safetyRationale = 'The reduced dose would not deliver the intended recovery session, so Forge does not label a token run as productive. Rest or comfortable low-strain movement is the truthful choice.';
  const minimumMinutes = Number.isFinite(Number(options.minimumRunMinutes))
    ? Number(options.minimumRunMinutes) : MIN_EFFECTIVE_RECOVERY_RUN_MINUTES;
  const minimumMiles = Number.isFinite(Number(options.minimumRunMiles))
    ? Number(options.minimumRunMiles) : MIN_EFFECTIVE_RECOVERY_RUN_MILES;
  const alternative = {
    id: session.id,
    kind: 'rest',
    type: 'rest',
    workout_type: 'rest',
    title: 'Rest, easy walking, or mobility',
    intensity: 'Rest or very easy',
    target_zone: null,
    distance_miles: 0,
    prescription_basis: 'choice',
    description: `${label} ${safetyRationale}`,
    steps: [
      'Rest completely if you feel unusually tired, sore, unwell, or your movement is not normal',
      'Otherwise walk for 20-30 min at a very easy, fully conversational effort',
      'Or use 5-10 min of gentle mobility through comfortable ranges',
      'Stop the optional walking or mobility if pain increases, soreness changes normal movement, or you feel unwell',
    ],
    progression: 'Do not turn the recovery choice into a run workout or add intensity.',
    recovery_alternative: {
      policy: 'minimum_effective_recovery_session_v1',
      decision_reason: dose.decisionReason,
      evaluated_basis: dose.basis,
      minimum_run_minutes: minimumMinutes,
      minimum_run_miles: minimumMiles,
      reduced_run_minutes: dose.minutes,
      reduced_run_miles: dose.miles,
      safety_rationale: safetyRationale,
      activity_health_minimum_claimed: false,
      options: [
        {
          type: 'rest',
          duration_minutes: 0,
          intensity: 'Rest / no exercise',
          guidance: 'Take a full rest day.',
          safety_rationale: 'Choose rest when unusually tired, sore, unwell, or normal movement is altered.',
        },
        {
          type: 'walking',
          duration_range_minutes: [20, 30],
          intensity: 'Very easy and fully conversational',
          guidance: 'Use relaxed walking only; this is not a run substitute to complete at pace.',
          safety_rationale: 'Continue only while movement feels comfortable; stop if pain or soreness changes normal movement.',
        },
        {
          type: 'mobility',
          duration_range_minutes: [5, 10],
          intensity: 'Gentle, comfortable range of motion',
          guidance: 'Choose familiar low-strain mobility and avoid loaded or forced ranges.',
          safety_rationale: 'Keep every movement pain-free and stop rather than pushing through discomfort.',
        },
      ],
    },
  };
  if (options.v24 !== true) return alternative;
  return {
    ...alternative,
    session_id: session.session_id ?? session.id,
    role: session.role ?? session.session_role ?? 'RECOVERY',
    workout_family: 'manual_recovery',
    scheduled_local_date: session.scheduled_local_date ?? session.local_date ?? session.date,
    reason_codes: [...new Set([...(session.reason_codes || []), 'RECOVERY_VOLUME_REDUCTION'])],
    presentation_floor_adaptation: {
      policy: 'goal_backward_presentation_floor_v1',
      source_workout_family: session.workout_family || null,
      minimum_run_minutes: minimumMinutes,
      minimum_run_miles: minimumMiles,
      rendered_as: 'rest_walk_mobility_choice',
    },
  };
}

function enforceMinimumEffectiveRecoveryRun(session, label, options = {}) {
  if (options.enforceStructuredRunFloor === false) return session;
  const dose = recoveryRunDose(session, options);
  return dose.meaningful ? session : recoveryWalkOrRest(session, label, dose, options);
}

function patchRunForRecovery(session, severity, label, options = {}) {
  const multiplier = severity === 'rest' ? 0.5 : 0.7;
  const next = Object.assign({}, session, {
    type: 'recovery',
    workout_type: 'recovery',
    title: severity === 'rest' ? 'Recovery run' : 'Easy aerobic run',
    intensity: severity === 'rest' ? 'Recovery' : 'Easy',
    target_zone: 'Zone 1-2',
    pace_target: 'Conversational effort',
    description: label,
    warmup: ['5-10 min easy walking or jogging'],
    steps: ['Stay in Zone 1-2', 'Keep breathing relaxed', 'Stop if soreness changes your stride'],
    cooldown: ['5 min easy walking', 'Hydrate and refuel'],
    progression: 'Do not add pace, repeats, or distance today.',
  });
  if (options.v24 === true) {
    next.session_id = session.session_id ?? session.id;
    next.workout_family = 'recovery_run';
    next.role = session.role ?? session.session_role ?? 'RECOVERY';
    next.reason_codes = [...new Set([...(session.reason_codes || []), 'RECOVERY_VOLUME_REDUCTION'])];
  }
  const miles = firstNumericSessionValue(session, ['distance_miles', 'distance', 'miles']);
  if (miles) next[miles.key] = Math.max(0.5, Math.round(miles.value * multiplier * 10) / 10);
  const duration = firstNumericSessionValue(session, ['duration_min', 'duration_minutes', 'minutes', 'time_minutes']);
  if (duration) next[duration.key] = Math.max(10, Math.round(duration.value * multiplier));
  if (session.injury_adjustment) {
    next.pace_target = session.pace_target;
    next.description = session.description;
    next.steps = clone(session.steps);
    next.cooldown = clone(session.cooldown);
    next.progression = session.progression;
  }
  return enforceMinimumEffectiveRecoveryRun(next, label, options);
}

function patchRunForReentry(session, index, distanceLimit = null, plannedMiles = null, options = {}) {
  const next = patchRunForRecovery(
    session,
    'reduce',
    index === 0
      ? 'First easy run after a seven-day running gap.'
      : 'Easy re-entry running while consistency is rebuilt.',
    { ...options, enforceStructuredRunFloor: false },
  );
  next.title = index === 0 ? 'Return-to-running easy run' : 'Easy re-entry run';
  next.prescription_basis = 'time';
  const originalDuration = Number(session.duration_min);
  next.duration_min = Number.isFinite(originalDuration) && originalDuration > 0
    ? Math.min(originalDuration, index === 0 ? 30 : 45)
    : (index === 0 ? 25 : 30);
  const originalMiles = Number(session.distance_miles);
  if (Number.isFinite(originalMiles) && originalMiles > 0) {
    next.distance_miles = Number.isFinite(distanceLimit)
      ? Math.max(0, Math.min(originalMiles, distanceLimit))
      : originalMiles;
  }
  if (session.injury_adjustment) {
    next.title = 'Injury-adjusted re-entry run';
    next.pace_target = session.pace_target;
    next.description = session.description;
    next.steps = clone(session.steps);
    next.cooldown = clone(session.cooldown);
    next.progression = session.progression;
  }
  const finalMiles = Number(next.distance_miles);
  const actualMileageScale = Number.isFinite(plannedMiles) && plannedMiles > 0 && Number.isFinite(finalMiles)
    ? Math.round((finalMiles / plannedMiles) * 1000) / 1000
    : null;
  next.reentry_adjustment = {
    day: index + 1,
    intensity: 'easy',
    mileageScale: actualMileageScale,
  };
  return next;
}

function enforceRunGapConstraints(changeMap, constraint) {
  if (!constraint) return;
  const {
    plannedRuns,
    retainedRunCount,
    mileageScale,
    mileageCap,
    recoveryFloorOptions,
  } = constraint;
  let remainingTenths = Math.max(0, Math.floor((mileageCap * 10) + 1e-9));

  plannedRuns.forEach((item, index) => {
    const key = `${item.date}:${item.sessionId}`;
    const current = changeMap.get(key)?.after || item.session;
    if (index >= retainedRunCount) {
      addChange(
        changeMap,
        item,
        safetyRestSession(item.session, 'the seven-day re-entry week is capped at three easy runs'),
        `${sessionSummary(item.session)} is removed from this re-entry week so the return stays capped at three easy runs.`
      );
      return;
    }
    if (String(current?.type || '').toLowerCase() === 'rest') return;

    const originalMiles = Number(item.session?.distance_miles);
    const desiredTenths = Number.isFinite(originalMiles) && originalMiles > 0
      ? Math.max(0, Math.floor((originalMiles * mileageScale * 10) + 1e-9))
      : 0;
    const allocatedTenths = Math.min(desiredTenths, remainingTenths);
    remainingTenths -= allocatedTenths;
    const after = patchRunForReentry(current, index, allocatedTenths / 10, originalMiles, recoveryFloorOptions);
    addChange(
      changeMap,
      item,
      after,
      `${sessionSummary(item.session)} changes to ${sessionSummary(after)} for a bounded, nonpunitive return to running.`
    );
  });
}

function patchRunForInjury(session, rule) {
  const next = Object.assign({}, session, {
    type: 'recovery',
    workout_type: 'run',
    title: 'Injury-adjusted easy run',
    intensity: 'Easy',
    target_zone: 'Zone 1-2',
    pace_target: `Conversational effort; stop if ${rule.bodyPart} symptoms change your stride`,
    description: injuryRuleDetail('Reduced run volume', rule),
    warmup: ['5-10 min easy walking or jogging'],
    steps: ['Stay in Zone 1-2', `Stop if ${rule.bodyPart} pain increases`, 'Keep the stride relaxed and symmetrical'],
    cooldown: ['5 min easy walking', 'Hydrate and reassess symptoms'],
    progression: 'Hold pace, repeats, and distance progression until the injury log is cleared.',
    injury_adjustment: {
      action: rule.action,
      severity: rule.severity,
      body_part: rule.bodyPart,
      volume_multiplier: rule.volumeMultiplier,
    },
  });
  const miles = firstNumericSessionValue(session, ['distance_miles', 'distance', 'miles']);
  if (miles) next[miles.key] = Math.max(0.5, Math.round(miles.value * rule.volumeMultiplier * 10) / 10);
  const duration = firstNumericSessionValue(session, ['duration_min', 'duration_minutes', 'minutes', 'time_minutes']);
  if (duration) next[duration.key] = Math.max(10, Math.round(duration.value * rule.volumeMultiplier));
  return next;
}

function reducedInjuryExercise(name, bodyPart) {
  return {
    name,
    sets: 2,
    reps: '8-10',
    rest: '60 sec',
    load: 'Very light',
    rpe: '5-6',
    cue: `Stay pain-free around the ${bodyPart}.`,
    progression: 'No load progression today.',
  };
}

function reduceLiftExercisesForInjury(session, rule) {
  const source = Array.isArray(session.main) ? session.main : Array.isArray(session.exercises) ? session.exercises : [];
  if (!source.length) {
    return [
      reducedInjuryExercise('Pain-free range-of-motion strength', rule.bodyPart),
      reducedInjuryExercise('Light trunk stability drill', rule.bodyPart),
    ];
  }
  return source.map((exercise) => {
    const sets = Number(exercise.sets);
    return {
      ...exercise,
      sets: Number.isInteger(sets) ? Math.max(1, Math.floor(sets * rule.volumeMultiplier)) : exercise.sets,
      load: 'Light - about 25% below normal',
      rpe: '5-6',
      rir: '4+ RIR',
      cue: exercise.cue || `Stay pain-free around the ${rule.bodyPart}.`,
      progression: 'Hold load and volume today; resume progression after the injury log is cleared.',
    };
  });
}

function patchLiftForInjury(session, rule) {
  const exercises = reduceLiftExercisesForInjury(session, rule);
  const next = Object.assign({}, session, {
    kind: 'lift',
    type: 'strength',
    workout_type: 'strength',
    title: `Injury-adjusted ${session.title || 'strength session'}`,
    focus: session.focus || (rule.modalities.upperLift && !rule.modalities.lowerLift ? 'Upper body' : 'Lower body'),
    warmup: Array.isArray(session.warmup) && session.warmup.length
      ? session.warmup
      : ['5 min easy movement', 'Pain-free range-of-motion prep'],
    main: exercises,
    recovery: [
      `Stop if ${rule.bodyPart} pain increases`,
      'Resume normal strength loading only after symptoms settle',
    ],
    progression: 'Reduce volume by 25% today and avoid load progression.',
    description: injuryRuleDetail('Reduced strength volume', rule),
    injury_adjustment: {
      action: rule.action,
      severity: rule.severity,
      body_part: rule.bodyPart,
      volume_multiplier: rule.volumeMultiplier,
    },
  });
  if (Array.isArray(session.exercises) && !Array.isArray(session.main)) {
    delete next.main;
    next.exercises = exercises;
  }
  return next;
}

function liftAffectedByInjury(session = {}, rule = {}) {
  const focus = String(session.focus || session.title || '').toLowerCase();
  if (!focus) return rule.modalities.lowerLift || rule.modalities.upperLift;
  if (/lower/.test(focus)) return rule.modalities.lowerLift;
  if (/upper/.test(focus)) return rule.modalities.upperLift;
  return rule.modalities.lowerLift || rule.modalities.upperLift;
}

function safetyRestSession(session, reason) {
  return {
    id: session.id,
    kind: 'rest',
    type: 'rest',
    workout_type: 'rest',
    title: 'Safety hold',
    intensity: 'Rest',
    target_zone: null,
    distance_miles: 0,
    description: `Safety hold: ${reason}`,
    steps: [],
  };
}

function replaceLowerBodyAfterRun(session, latestRun) {
  return {
    ...session,
    kind: 'lift',
    type: 'strength',
    workout_type: 'strength',
    title: 'Optional upper-body strength',
    focus: 'Upper body',
    warmup: ['Band pull-apart x 20', 'Scapular push-up x 10', 'Two progressive warm-up sets'],
    main: [
      { name: 'Dumbbell bench press', sets: 3, reps: '6-8', rest: '2 min', load: 'Submaximal', rpe: '6-7', cue: 'Keep the shoulder blades set on the bench.', progression: 'Hold load today; do not chase fatigue.' },
      { name: 'One-arm dumbbell row', sets: 3, reps: '8 each side', rest: '90 sec', load: 'Moderate', rpe: '6-7', cue: 'Drive the elbow toward the hip without twisting.', progression: 'Stop with at least three reps in reserve.' },
      { name: 'Pull-up or lat pulldown', sets: 2, reps: '6-10', rest: '90 sec', load: 'Easy-moderate', rir: '3', cue: 'Pull the elbows down without shrugging.', progression: 'Skip the final set if whole-body fatigue is elevated.' },
    ],
    recovery: ['Skip this optional session if soreness changes normal movement', 'Prioritize carbohydrate, protein, hydration, and sleep'],
    progression: 'Resume normal strength progression after lower-body recovery is normal.',
    description: `Lower-body loading is deferred after the ${Number(latestRun.distanceMiles || 0).toFixed(1)} mi recent run.`,
    acuteLoadAdjusted: true,
  };
}

function markUpperBodyOptionalAfterRun(session, latestRun) {
  const currentTitle = String(session.title || 'Upper-body strength').replace(/^Optional\s+/i, '');
  return {
    ...session,
    title: `Optional ${currentTitle}`,
    description: `${session.description || 'Upper-body strength.'} Keep this submaximal and skip it if whole-body fatigue or soreness is elevated after the ${Number(latestRun.distanceMiles || 0).toFixed(1)} mi run.`,
    acuteLoadAdjusted: true,
  };
}

function addChange(changeMap, item, after, summary) {
  const key = `${item.date}:${item.sessionId}`;
  if (deepEqual(item.session, after)) return;
  changeMap.set(key, {
    date: item.date,
    sessionId: item.sessionId,
    kind: planSchema.kindFromSession(item.session),
    before: clone(item.session),
    after: clone(after),
    summary,
  });
}

function attributedAfter(change = {}) {
  const after = clone(change.after || {});
  const reason = String(change.summary || '').trim();
  if (!reason) return after;
  return Object.assign({}, after, {
    adjusted: true,
    adjustment_reason: reason,
  });
}

function applyChangesToClone(plan, changes) {
  const next = clone(plan);
  const byDate = new Map();
  for (const change of changes || []) {
    if (!change || !change.date || !change.sessionId) continue;
    const list = byDate.get(change.date) || [];
    list.push(change);
    byDate.set(change.date, list);
  }

  const weeks = Array.isArray(next.weeks) ? next.weeks : [];
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex] || {};
    const entries = planSchema.getDayEntries(week);
    const key = planSchema.dayEntriesKey(week);
    let touched = false;
    const nextEntries = entries.map((day, dayIndex) => {
      const dayChanges = byDate.get(day && day.date);
      if (!dayChanges || !dayChanges.length) return day;
      touched = true;
      const changeBySessionId = new Map(dayChanges.map((change) => [String(change.sessionId), change]));

      if (Array.isArray(day && day.sessions)) {
        const rebuilt = [];
        day.sessions.forEach((session, sessionIndex) => {
          const id = sessionIdFor(day, session, sessionIndex, dayIndex);
          const change = changeBySessionId.get(String(id));
          if (!change) {
            rebuilt.push(session);
            return;
          }
          const afterKind = planSchema.kindFromSession(change.after);
          if (change.after?.removeSession === true) return;
          // A normal rest conversion removes the executable session. The
          // recovery-floor policy is different: it is a real, reviewable
          // rest/easy-walk prescription that must survive acceptance so the
          // calendar can explain the alternative instead of silently showing
          // an empty day.
          if (afterKind === 'rest' && !change.after?.recovery_alternative) return;
          const after = attributedAfter(change);
          rebuilt.push(Object.assign({}, after, { id: after.id || session.id || id }));
        });
        const framed = planSchema.toCanonicalDay(day, rebuilt, true);
        framed.sessions = rebuilt.map((session, sessionIndex) => (
          Object.assign({}, session, { id: session.id || `${day.date || day.day || 'day'}-${sessionIndex}` })
        ));
        return framed;
      }

      const legacyId = sessionIdFor(day, day, 0, dayIndex);
      const change = changeBySessionId.get(String(legacyId));
      if (!change) return day;
      return planSchema.applyOverrideToDay(day, attributedAfter(change));
    });
    if (touched) weeks[weekIndex] = Object.assign({}, week, { [key]: nextEntries });
  }
  return next;
}

function invariantSignature(plan) {
  const goal = plan && plan.goal ? plan.goal : {};
  const goalSignature = (entry = {}) => ({
    kind: entry.kind,
    raceId: entry.raceId,
    name: entry.name,
    date: entry.date,
    distanceMiles: entry.distanceMiles,
    goalType: entry.goalType,
    goalTimeSeconds: entry.goalTimeSeconds,
    goalPaceSecondsPerMile: entry.goalPaceSecondsPerMile,
    priority: entry.priority,
    sequence: entry.sequence,
    role: entry.role,
    course: entry.course === undefined ? null : entry.course,
  });
  const raceSessions = [];
  iterateDays(plan, ({ day }) => {
    for (const session of Array.isArray(day?.sessions) ? day.sessions : []) {
      if (String(session?.type || '').toLowerCase() !== 'race') continue;
      raceSessions.push({ date: day.date, session: clone(session) });
    }
  });
  return {
    schemaVersion: plan && plan.schemaVersion,
    planMode: plan && plan.planMode,
    strengthPolicy: plan && plan.strengthPolicy,
    goal: goalSignature(goal),
    goals: (Array.isArray(plan && plan.goals) ? plan.goals : []).map(goalSignature),
    phases: (Array.isArray(plan && plan.weeks) ? plan.weeks : []).map((week) => ({
      week: week && week.week,
      phase: week && week.phase,
    })),
    raceSessions,
  };
}

function outsideWindowDaysEqual(original, candidate, start, end, safetyException) {
  if (safetyException) return true;
  const snapshot = (plan) => {
    const days = [];
    iterateDays(plan, ({ weekIndex, dayIndex, day }) => {
      if (!day || !day.date || isWithin(day.date, start, end)) return;
      days.push({ weekIndex, dayIndex, day });
    });
    return days;
  };
  return deepEqual(snapshot(original), snapshot(candidate));
}

function strengthFloorPreserved(plan) {
  if (!planSchema.isHybridMode(plan && plan.planMode)) return true;
  const floor = Number(plan && plan.strengthPolicy && plan.strengthPolicy.minimumSessionsPerWeek);
  if (!Number.isFinite(floor) || floor <= 0) return true;
  const weeks = Array.isArray(plan.weeks) ? plan.weeks : [];
  return weeks.every((week) => {
    if (week && week.phase === 'race') return true;
    const liftCount = planSchema.getDayEntries(week)
      .flatMap((day) => planSchema.daySessions(day))
      .filter((session) => planSchema.kindFromSession(session) === 'lift')
      .length;
    return liftCount >= floor;
  });
}

function keepProposal(input, planningDate, windowStart, windowEnd, evidence, headline, reason) {
  return {
    status: 'keep',
    planningDate,
    windowStart,
    windowEnd,
    safetyException: false,
    evidence: evidence || [],
    changes: [],
    headline,
    choices: ['accept', 'keep_original'],
    reason,
    planVersion: input && input.planVersion ? input.planVersion : null,
    proposedPlan: clone(input && input.plan),
  };
}

function validateCandidateOrKeep(input, proposal, candidate, allowedWindowEnd) {
  const plan = input.plan;
  const planningDate = proposal.planningDate;
  if (!deepEqual(invariantSignature(plan), invariantSignature(candidate))) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      allowedWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      'A candidate adjustment attempted to change protected race, course, phase, mode, or strength-policy metadata, so it was rejected.'
    );
  }
  if (!outsideWindowDaysEqual(plan, candidate, proposal.windowStart, allowedWindowEnd, proposal.safetyException)) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      allowedWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      `A candidate adjustment changed sessions outside the allowed window ending ${allowedWindowEnd}, so it was rejected.`
    );
  }
  if (!proposal.safetyException && !strengthFloorPreserved(candidate)) {
    return keepProposal(
      input,
      planningDate,
      proposal.windowStart,
      allowedWindowEnd,
      proposal.evidence,
      'Keep the calendar as planned',
      'A candidate adjustment would drop lifting below the protected weekly strength floor, so it was rejected.'
    );
  }
  return Object.assign({}, proposal, { proposedPlan: candidate });
}

function goalBackwardRecoveryFloorOptions(input = {}) {
  const policy = input.goalBackwardV24;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return {};
  const trainingAge = String(policy.training_age_class ?? policy.trainingAgeClass ?? '').toUpperCase();
  const weeklyMinutes = finiteMetric(
    policy.recent_normal_running_minutes_per_week ?? policy.recentNormalRunningMinutesPerWeek
  );
  const beginnerFloor = trainingAge === 'BEGINNER' || (weeklyMinutes !== null && weeklyMinutes < 60);
  return {
    v24: true,
    minimumRunMinutes: beginnerFloor ? 15 : 20,
    minimumRunMiles: MIN_EFFECTIVE_RECOVERY_RUN_MILES,
  };
}

function buildAdaptationProposal(input = {}) {
  const plan = input.plan;
  const planningDate = input.planningDateISO || input.planningDate;
  const parsedPlanningDate = parseISODate(planningDate);
  if (!planSchema.isSchemaV2(plan) || !parsedPlanningDate) {
    return keepProposal(
      input,
      planningDate || null,
      planningDate || null,
      planningDate || null,
      [],
      'Keep the calendar as planned',
      'This plan is not a dated schema-v2 calendar, so no transparent adaptation was computed.'
    );
  }

  const normalWindowEnd = addDays(planningDate, 3);
  const windowStart = planningDate;
  const todaySessions = allDatedSessions(plan, planningDate, planningDate);
  const injury = buildInjuryEvidence(input.injuryState || input.injury || {}, planningDate);
  const checkin = buildCheckinEvidence(input.checkin || {}, todaySessions);
  const health = buildHealthEvidence(input.healthSignals || {});
  const completion = buildCompletionEvidence(input.completion || input.adherence || {});
  const recentRun = buildRecentRunEvidence(input.recentRunLoad || {});
  const recoveryFloorOptions = goalBackwardRecoveryFloorOptions(input);
  let safetyException = false;
  let safetyReason = null;
  let windowEnd = normalWindowEnd;
  const evidence = [
    ...injury.evidence,
    ...checkin.evidence.filter((item) => {
      if (checkin.action === 'keep' && !checkin.safety && !checkin.includeWhenKeep) return false;
      return true;
    }),
    ...health.evidence,
    ...completion.evidence,
    ...recentRun.evidence,
  ];

  if (injury.safety || checkin.safety) {
    safetyException = true;
    safetyReason = injury.reason || 'sick or injured check-in';
    windowEnd = addDays(planningDate, 6);
  } else if (completion.runGap) {
    windowEnd = addDays(planningDate, 6);
  }

  if (input.candidatePlan) {
    const candidateProposal = {
      status: 'proposal',
      planningDate,
      windowStart,
      windowEnd: normalWindowEnd,
      safetyException: false,
      evidence,
      changes: [],
      headline: 'Candidate adjustment rejected if invariants changed',
      choices: ['accept', 'keep_original'],
      reason: 'Candidate plan supplied for validation.',
      planVersion: input.planVersion || null,
    };
    return validateCandidateOrKeep(input, candidateProposal, clone(input.candidatePlan), normalWindowEnd);
  }

  const changes = new Map();
  let runGapConstraint = null;
  const sessionsInWindow = allDatedSessions(plan, windowStart, windowEnd);

  if (safetyException) {
    for (const item of sessionsInWindow) {
      if (item.kind !== 'run' && item.kind !== 'lift') continue;
      if (String(item.session?.type || '').toLowerCase() === 'race') continue;
      addChange(
        changes,
        item,
        safetyRestSession(item.session, safetyReason),
        `Safety hold replaces ${sessionSummary(item.session)} because ${safetyReason}.`
      );
    }
  } else {
    const todayRun = todaySessions.find((item) => item.kind === 'run');
    if (todayRun && checkin.action !== 'keep' && Object.keys(checkin.patch || {}).length) {
      const patched = planSchema.applyOverrideToDay(todayRun.session, checkin.patch);
      const after = checkin.action === 'recovery_swap'
        ? enforceMinimumEffectiveRecoveryRun(
          patched,
          'Recovery choice from today\'s soreness or fatigue check-in.',
          recoveryFloorOptions
        )
        : patched;
      addChange(
        changes,
        todayRun,
        after,
        `${sessionSummary(todayRun.session)} changes to ${sessionSummary(after)} from today's subjective check-in.`
      );
    } else if (todayRun && checkin.action === 'keep' && Object.keys(checkin.patch || {}).length) {
      const after = planSchema.applyOverrideToDay(todayRun.session, checkin.patch);
      addChange(
        changes,
        todayRun,
        after,
        `${sessionSummary(todayRun.session)} stays on the calendar but intensity is capped from today's subjective check-in.`
      );
    }

    if (health.severity !== 'none') {
      for (const item of sessionsInWindow) {
        if (item.kind !== 'run' || String(item.session?.type || '').toLowerCase() === 'race' || !isHardRun(item.session)) continue;
        const after = patchRunForRecovery(
          item.session,
          health.severity,
          health.severity === 'rest'
            ? 'Recovery version from fresh objective Apple Health recovery signals.'
            : 'Easier version from fresh objective Apple Health recovery signals.',
          recoveryFloorOptions
        );
        addChange(
          changes,
          item,
          after,
          `${sessionSummary(item.session)} changes to ${sessionSummary(after)} from fresh objective Apple Health recovery data.`
        );
      }
    }

    if (completion.runGap) {
      const plannedRuns = sessionsInWindow.filter((item) => (
        item.kind === 'run' && String(item.session?.type || '').toLowerCase() !== 'race'
      ));
      const baselineMiles = completion.weeklyMileageBaseline === null || completion.weeklyMileageBaseline === undefined
        ? null : Number(completion.weeklyMileageBaseline);
      const originalMiles = plannedRuns.reduce((sum, item) => {
        const miles = Number(item.session?.distance_miles);
        return sum + (Number.isFinite(miles) && miles > 0 ? miles : 0);
      }, 0);
      const mileageCap = Number.isFinite(baselineMiles) && baselineMiles > 0
        ? Math.min(originalMiles * 0.8, baselineMiles * 0.7)
        : Math.min(originalMiles > 0 ? originalMiles * 0.8 : 9, 9);
      const mileageScale = originalMiles > 0
        ? Math.min(1, Math.max(0, mileageCap / originalMiles))
        : 0.7;
      runGapConstraint = {
        plannedRuns,
        retainedRunCount: Number.isFinite(baselineMiles) && baselineMiles > 0 ? plannedRuns.length : Math.min(plannedRuns.length, 3),
        mileageScale,
        mileageCap,
        recoveryFloorOptions,
      };
    } else if (completion.driver) {
      const nextHard = sessionsInWindow.find((item) => (
        item.kind === 'run'
        && String(item.session?.type || '').toLowerCase() !== 'race'
        && isHardRun(item.session)
      ));
      if (nextHard) {
        const after = patchRunForRecovery(
          nextHard.session,
          'reduce',
          'Easier version from recent completion and missed-session history.',
          recoveryFloorOptions
        );
        addChange(
          changes,
          nextHard,
          after,
          `${sessionSummary(nextHard.session)} changes to ${sessionSummary(after)} from recent completion history.`
        );
      }
    }

    if (Array.isArray(injury.rules) && injury.rules.length) {
      for (const rule of injury.rules) {
        for (const item of sessionsInWindow) {
          const key = `${item.date}:${item.sessionId}`;
          const current = changes.get(key)?.after || item.session;
          if (item.kind === 'run' && rule.modalities.run && String(item.session.type || '').toLowerCase() !== 'race') {
            const adjusted = patchRunForInjury(current, rule);
            const after = enforceMinimumEffectiveRecoveryRun(
              adjusted,
              `Lower-strain choice because ${injuryRuleDetail('the reduced run', rule)}`,
              recoveryFloorOptions
            );
            addChange(
              changes,
              item,
              after,
              `${sessionSummary(item.session)} changes to ${sessionSummary(after)} because ${injuryRuleDetail('reduced run volume', rule)}`
            );
            continue;
          }
          if (item.kind === 'lift' && liftAffectedByInjury(current, rule)) {
            const after = patchLiftForInjury(current, rule);
            addChange(
              changes,
              item,
              after,
              `${sessionSummary(item.session)} changes to ${sessionSummary(after)} because ${injuryRuleDetail('reduced strength volume', rule)}`
            );
          }
        }
      }
    }

    if (recentRun.driver) {
      for (const item of sessionsInWindow) {
        const key = `${item.date}:${item.sessionId}`;
        const current = changes.get(key)?.after || item.session;
        if (item.kind === 'run' && recentRun.protection.noAdditionalRunOnDate === item.date && String(item.session.type || '').toLowerCase() !== 'race') {
          addChange(
            changes,
            item,
            safetyRestSession(current, 'a run is already logged for today'),
            `${sessionSummary(item.session)} is removed because the ${Number(recentRun.latest.distanceMiles || 0).toFixed(1)} mi run is already logged today.`
          );
          continue;
        }
        if (item.kind === 'run' && recentRun.protection.postRunSevere && item.date <= recentRun.protection.hardRunsThrough && String(item.session.type || '').toLowerCase() !== 'race') {
          addChange(
            changes,
            item,
            safetyRestSession(current, 'severe pain was reported after the recent run'),
            `${sessionSummary(item.session)} is held because severe post-run pain protects running through ${recentRun.protection.hardRunsThrough}.`
          );
          continue;
        }
        if (item.kind === 'run' && isDemandingRun(item.session) && item.date <= recentRun.protection.hardRunsThrough && String(item.session.type || '').toLowerCase() !== 'race') {
          const after = patchRunForRecovery(
            current,
            'reduce',
            `Recovery version after the ${Number(recentRun.latest.distanceMiles || 0).toFixed(1)} mi recent run.`,
            recoveryFloorOptions
          );
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} changes to ${sessionSummary(after)} because hard running is protected through ${recentRun.protection.hardRunsThrough}.`
          );
          continue;
        }
        if (item.kind === 'lift' && /lower/i.test(String(current.focus || '')) && item.date <= recentRun.protection.lowerBodyThrough) {
          const after = replaceLowerBodyAfterRun(current, recentRun.latest);
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} changes to optional upper-body strength because lower-body loading is protected through ${recentRun.protection.lowerBodyThrough}.`
          );
          continue;
        }
        if (item.kind === 'lift' && /upper/i.test(String(current.focus || '')) && item.date <= recentRun.protection.upperBodyOptionalThrough) {
          const after = markUpperBodyOptionalAfterRun(current, recentRun.latest);
          addChange(
            changes,
            item,
            after,
            `${sessionSummary(item.session)} remains upper-body only and becomes optional after the recent run.`
          );
        }
      }
    }

  }

  enforceRunGapConstraints(changes, runGapConstraint);

  const changeList = Array.from(changes.values()).sort((a, b) => (
    compareISO(a.date, b.date) || String(a.sessionId).localeCompare(String(b.sessionId))
  ));

  if (!changeList.length) {
    return keepProposal(
      input,
      planningDate,
      windowStart,
      windowEnd,
      evidence,
      'Keep the calendar as planned',
      evidence.length
        ? 'Available signals do not warrant changing the dated race calendar.'
        : 'No fresh objective Apple Health driver, recent-run load, subjective check-in driver, completion concern, or active injury was provided.'
    );
  }

  const candidate = applyChangesToClone(plan, changeList);
  const proposal = {
    status: 'proposal',
    planningDate,
    windowStart,
    windowEnd,
    safetyException,
    evidence,
    changes: changeList,
    headline: safetyException
      ? 'Safety hold for the live calendar'
      : completion.runGap ? 'Ready to ease back into running?' : 'Small transparent calendar adjustment',
    choices: ['accept', 'keep_original'],
    reason: safetyException
      ? `A safety exception is marked because ${safetyReason}; the hold can extend beyond 72 hours.`
      : completion.runGap
        ? `We have not seen a logged run in ${completion.daysSinceRun} days. Lifting still counts; this optional change only eases the next seven days of running, and you can leave the calendar exactly as it is.`
        : 'Only dated sessions inside the next 72 hours are changed from current recovery, recent-run load, check-in, and completion evidence; race target, phases, course facts, and the strength policy stay fixed.',
    planVersion: input.planVersion || null,
  };
  return validateCandidateOrKeep(input, proposal, candidate, windowEnd);
}

function machineFamilyForAdaptation(session = {}) {
  const kind = planSchema.kindFromSession(session);
  const type = String(session.type ?? session.workout_type ?? '').toLowerCase();
  if (session.reentry_adjustment || ['recovery', 'easy'].includes(type) && kind === 'run') return 'recovery_run';
  if (kind === 'rest') return session.recovery_alternative ? 'manual_recovery' : 'rest';
  if (session.workout_family) return session.workout_family;
  if (kind === 'lift') {
    const focus = String(session.focus || '').toLowerCase();
    if (focus.includes('upper')) return 'strength_upper';
    if (focus.includes('lower')) return 'strength_lower';
    return 'strength_full_body';
  }
  if (kind === 'run') {
    if (type === 'race') return 'race';
    if (['recovery', 'easy'].includes(type)) return type === 'easy' ? 'easy_run' : 'recovery_run';
    if (type === 'long') return 'long_aerobic';
    if (type === 'steady') return 'steady_run';
    if (['interval', 'intervals', 'speed'].includes(type)) return 'interval_run';
    if (['threshold', 'tempo', 'quality', 'controlled'].includes(type)) return 'threshold_run';
  }
  return session.workout_family || null;
}

function v24SessionForValidation(session = {}, date = null) {
  const family = machineFamilyForAdaptation(session);
  const role = session.role ?? session.session_role
    ?? (family === 'rest' ? 'REST' : family === 'manual_recovery' || family === 'recovery_run' ? 'RECOVERY' : 'SUPPORTING');
  return {
    ...clone(session),
    session_id: session.session_id ?? session.id,
    scheduled_local_date: session.scheduled_local_date ?? date ?? null,
    workout_family: family,
    role,
  };
}

function v24QualityWorkMinutes(session = {}) {
  const direct = finiteMetric(session.quality_work_duration_min ?? session.qualityWorkDurationMinutes);
  if (direct !== null) return direct;
  const derived = finiteMetric(session.derived_totals?.work_duration_s);
  if (derived !== null) return derived / 60;
  return (Array.isArray(session.steps) ? session.steps : []).filter((step) => (
    step && typeof step === 'object'
    && String(step.step_role ?? step.role ?? '').toUpperCase() === 'WORK'
  )).reduce((sum, step) => sum + Number(step.duration_s || step.duration_seconds || 0)
    * Number(step.repetitions || 1), 0) / 60;
}

function adaptSessionToPresentationFloor(session = {}, options = {}) {
  const normalized = v24SessionForValidation(session, session.scheduled_local_date);
  const family = normalized.workout_family;
  const trainingAge = String(options.training_age_class ?? options.trainingAgeClass ?? '').toUpperCase();
  const beginner = trainingAge === 'BEGINNER';
  const returning = trainingAge === 'RETURNING';
  const weeklyMinutes = finiteMetric(
    options.recent_normal_running_minutes_per_week ?? options.recentNormalRunningMinutesPerWeek
  );
  const duration = firstFiniteMetric(normalized, ['duration_min', 'duration_minutes'])
    ?? (finiteMetric(normalized.derived_totals?.duration_s) !== null
      ? finiteMetric(normalized.derived_totals.duration_s) / 60 : 0);
  const ordinaryEasy = finiteMetric(
    options.median_ordinary_easy_duration_min ?? options.medianOrdinaryEasyDurationMinutes
  );
  let below = false;
  if (family === 'recovery_run') below = duration < (beginner || (weeklyMinutes !== null && weeklyMinutes < 60) ? 15 : 20);
  else if (family === 'easy_run') below = duration < (beginner || returning ? 20 : 25);
  else if (family === 'long_aerobic' && options.beginner_time_on_feet_policy !== true) {
    below = duration < 30 || (ordinaryEasy !== null && duration < ordinaryEasy * 1.5);
  } else if (['threshold_run', 'interval_run', 'race_rhythm_run'].includes(family)) {
    below = v24QualityWorkMinutes(normalized) < 8;
  } else if (family === 'hyrox_compromised') {
    below = Number(normalized.run_station_pair_count || 0) < 2
      || Number(normalized.main_work_duration_min || 0) < 20;
  } else if (['strength_lower', 'strength_upper', 'strength_full_body'].includes(family)
    && normalized.technique_or_rehab_scope !== true) {
    const exercises = Array.isArray(normalized.exercises) ? normalized.exercises
      : Array.isArray(normalized.main) ? normalized.main : [];
    below = exercises.length < 2 || exercises.some((exercise) => (
      Number(exercise.working_sets ?? exercise.sets ?? 0) < 2
    ));
  }
  const namedException = (normalized.reason_codes || []).includes('BELOW_PRESENTATION_FLOOR_EXCEPTION')
    && Boolean(normalized.beginner_or_rehab_protocol_id);
  if (!below || namedException) return normalized;
  const minimumMinutes = family === 'recovery_run'
    ? (beginner || (weeklyMinutes !== null && weeklyMinutes < 60) ? 15 : 20)
    : family === 'easy_run' ? (beginner || returning ? 20 : 25) : 20;
  const alternative = recoveryWalkOrRest(
    normalized,
    `The reduced ${family || 'session'} falls below the v2.4 presentation floor.`,
    {
      meaningful: false,
      decisionReason: 'below_v24_presentation_floor',
      basis: 'canonical_workout_family',
      minutes: duration || null,
      miles: firstFiniteMetric(normalized, ['distance_miles', 'distance']),
    },
    {
      v24: true,
      minimumRunMinutes: minimumMinutes,
      minimumRunMiles: MIN_EFFECTIVE_RECOVERY_RUN_MILES,
    }
  );
  alternative.presentation_floor_adaptation.source_workout_family = family;
  alternative.presentation_floor_adaptation.named_exception_required = true;
  return alternative;
}

function normalizeV24CandidatePlan(plan) {
  const candidate = clone(plan);
  iterateDays(candidate, ({ day }) => {
    if (!Array.isArray(day?.sessions)) return;
    day.sessions = day.sessions.map((session) => v24SessionForValidation(session, day.date));
  });
  return candidate;
}

function missedSessionsFrom(input = {}) {
  const completion = input.completion || input.adherence || {};
  const rows = completion.missedSessions ?? completion.missed_sessions ?? [];
  return (Array.isArray(rows) ? rows : []).map((entry, index) => ({
    session_id: String(entry?.session_id ?? entry?.sessionId ?? `missed-session-${index + 1}`),
    role: String(entry?.role || 'SUPPORTING').toUpperCase(),
    missed_local_date: entry?.missed_local_date ?? entry?.missedLocalDate ?? entry?.date ?? null,
  })).sort((left, right) => (
    String(left.missed_local_date || '').localeCompare(String(right.missed_local_date || ''))
    || left.session_id.localeCompare(right.session_id)
  ));
}

function buildMissedSessionPolicy(input, debtCount = 0) {
  const missed = missedSessionsFrom(input);
  const actions = missed.map((entry, index) => ({
    ...entry,
    action: index === 0 ? 'SKIP' : 'OMIT_EXCESS',
    reason_code: index === 0 ? 'MISSED_SESSION_SKIP' : 'NO_WORKOUT_DEBT',
  }));
  const omittedExcessCount = Math.max(0, missed.length - 1) + debtCount;
  const reasonCodes = [];
  if (missed.length) reasonCodes.push('MISSED_SESSION_SKIP');
  if (omittedExcessCount > 0) reasonCodes.push('NO_WORKOUT_DEBT');
  return Object.freeze({
    policy: 'goal_backward_missed_session_policy_v1',
    actions: Object.freeze(actions.map(Object.freeze)),
    omitted_excess_count: omittedExcessCount,
    reason_codes: Object.freeze(reasonCodes),
  });
}

function workoutDebtChanges(plan, planningDate) {
  const windowEnd = addDays(planningDate, 6);
  return allDatedSessions(plan, planningDate, windowEnd).filter((item) => (
    item.session?.workout_debt === true
    || Boolean(item.session?.debt_source_session_id)
    || Boolean(item.session?.carried_from_missed_session_id)
  )).map((item) => ({
    date: item.date,
    sessionId: item.sessionId,
    kind: item.kind,
    before: clone(item.session),
    after: {
      id: item.session.id,
      session_id: item.session.session_id ?? item.session.id,
      kind: 'rest',
      type: 'rest',
      workout_type: 'rest',
      workout_family: 'rest',
      role: 'REST',
      removeSession: true,
      reason_codes: ['NO_WORKOUT_DEBT'],
    },
    summary: `${sessionSummary(item.session)} is omitted; missed work is not accumulated as workout debt.`,
  }));
}

function buildGoalBackwardAdaptationProposal(input = {}) {
  const athleteState = clone(input.athleteState || input.athlete_state || {});
  const validationOptionsInput = clone(input.validationOptions || input.validation_options || {});
  const goalBackwardV24 = {
    training_age_class: validationOptionsInput.training_age_class ?? athleteState.training_age_class,
    recent_normal_running_minutes_per_week: validationOptionsInput.recent_normal_running_minutes_per_week
      ?? athleteState.recent_normal_running?.median_duration_minutes,
    ...(input.goalBackwardV24 && typeof input.goalBackwardV24 === 'object' ? input.goalBackwardV24 : {}),
  };
  const base = clone(buildAdaptationProposal({ ...input, goalBackwardV24 }));
  const planningDate = input.planningDateISO || input.planningDate;
  const debtChanges = workoutDebtChanges(input.plan, planningDate);
  const presentationFloorOptions = { ...validationOptionsInput, ...goalBackwardV24 };
  const changesByKey = new Map((base.changes || []).map((change) => [
    `${change.date}:${change.sessionId}`,
    {
      ...clone(change),
      after: change.after?.removeSession === true
        ? clone(change.after)
        : adaptSessionToPresentationFloor(
          v24SessionForValidation(change.after, change.date),
          presentationFloorOptions
        ),
    },
  ]));
  for (const change of debtChanges) changesByKey.set(`${change.date}:${change.sessionId}`, change);
  const changes = [...changesByKey.values()].sort((left, right) => (
    compareISO(left.date, right.date) || String(left.sessionId).localeCompare(String(right.sessionId))
  ));
  const candidate = normalizeV24CandidatePlan(applyChangesToClone(input.plan, changes));
  const prescribedSessions = allDatedSessions(input.plan, planningDate, addDays(planningDate, 6))
    .map((item) => ({ ...item.session, session_id: item.sessionId }));
  const completionOutcomes = translateCompletionEvidence(input, prescribedSessions);
  const outcomeSummary = summarizeCompletionOutcomes(completionOutcomes);
  const missedSessionPolicy = buildMissedSessionPolicy(input, debtChanges.length);
  const validationOptions = {
    ...validationOptionsInput,
    athlete_id: input.athlete_id ?? input.athleteId ?? athleteState.athlete_id,
    plan_id: input.plan_id ?? input.planId ?? input.plan?.plan_id,
    athlete_state_revision: athleteState.athlete_state_revision,
    training_age_class: validationOptionsInput.training_age_class ?? athleteState.training_age_class,
    recovery_state: validationOptionsInput.recovery_state ?? athleteState.recovery_state,
    safety_action: athleteState.safety_action ?? validationOptionsInput.safety_action ?? 'NORMAL',
    safety_scope: athleteState.safety_scope ?? validationOptionsInput.safety_scope,
    planning_constraints: input.planningConstraints ?? input.planning_constraints
      ?? validationOptionsInput.planning_constraints,
    cross_modal_recent_normal: validationOptionsInput.cross_modal_recent_normal
      ?? athleteState.cross_modal_recent_normal,
  };
  // Required lazily so the legacy mode-off adaptation path never loads or executes
  // the v2.4 validator graph and retains its existing response bytes.
  const { validateGoalBackwardAdaptationCandidate } = require('./goalBackwardValidators');
  const validation = validateGoalBackwardAdaptationCandidate(candidate, validationOptions);
  const completion = input.completion || input.adherence || {};
  const reasonCodes = [...new Set([
    ...missedSessionPolicy.reason_codes,
    ...completionOutcomes.flatMap((entry) => entry.reason_codes || []),
    ...(Number(completion.daysSinceRun ?? completion.days_since_run) >= 7
      && (completion.lastRunDate || completion.last_run_date) ? ['TRAINING_GAP_REBUILD'] : []),
    ...(validation.valid ? validation.reason_codes : []),
  ])];
  const proposed = changes.length > 0;
  if (!validation.valid && proposed) {
    return {
      ...base,
      status: 'keep',
      changes: [],
      proposedPlan: clone(input.plan),
      headline: 'Keep the calendar as planned',
      reason: 'The flagged adaptation did not pass every v2.4 workload, safety, spacing, constraint, and presentation-floor validator.',
      reason_codes: [...new Set([...reasonCodes, ...validation.reason_codes])],
      completion_outcomes: completionOutcomes,
      completion_outcome_summary: outcomeSummary,
      missed_session_policy: missedSessionPolicy,
      rejected_v24_candidate: candidate,
      v24_validation: validation,
    };
  }
  const proposal = {
    ...base,
    status: proposed ? 'proposal' : base.status,
    changes,
    proposedPlan: candidate,
    reason_codes: reasonCodes,
    completion_outcomes: completionOutcomes,
    completion_outcome_summary: outcomeSummary,
    missed_session_policy: missedSessionPolicy,
    v24_validation: validation,
  };
  return suppressRejectedAdaptationCandidate({
    proposal,
    activePlan: input.plan,
    candidateHash: input.candidateHash ?? input.candidate_hash
      ?? `sha256:${canonicalHash(proposal.proposedPlan)}`,
    rejectionRecords: input.candidateRejections ?? input.candidate_rejections,
    fingerprint: input.rejectionFingerprint ?? input.rejection_fingerprint,
  });
}

function suppressRejectedAdaptationCandidate({
  proposal,
  activePlan,
  candidateHash,
  rejectionRecords = [],
  fingerprint = {},
} = {}) {
  if (!proposal || proposal.status !== 'proposal' || !candidateHash) return clone(proposal);
  const current = { candidate_hash: candidateHash, ...fingerprint };
  const suppressed = (Array.isArray(rejectionRecords) ? rejectionRecords : [])
    .some((rejection) => candidateRejectionMatches(rejection, current));
  if (!suppressed) return clone(proposal);
  return {
    ...clone(proposal),
    status: 'keep',
    changes: [],
    proposedPlan: clone(activePlan),
    headline: 'Keep the calendar as planned',
    reason: 'This identical adaptation was already rejected. New evidence, constraints, goals, or policy are required before it can be proposed again.',
    reason_codes: [...new Set([
      ...(proposal.reason_codes || []),
      'ADAPTATION_REJECTED',
      'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED',
    ])],
    rejected_candidate_hash: candidateHash,
    active_plan_unchanged: true,
  };
}

function applyProposalToPlan(plan, proposal = {}) {
  if (!proposal || !Array.isArray(proposal.changes) || proposal.changes.length === 0) return clone(plan);
  return applyChangesToClone(plan, proposal.changes);
}

function proposalMatchesPlanVersion(proposal = {}, planVersion) {
  if (!proposal.planVersion) return true;
  return String(proposal.planVersion) === String(planVersion);
}

module.exports = {
  COMPLETION_OUTCOMES,
  parseISODate,
  toISODate,
  addDays,
  adaptSessionToPresentationFloor,
  buildGoalBackwardAdaptationProposal,
  buildAdaptationProposal,
  classifyCompletionOutcome,
  applyProposalToPlan,
  proposalMatchesPlanVersion,
  summarizeCompletionOutcomes,
  suppressRejectedAdaptationCandidate,
  translateCompletionEvidence,
  isHardRun,
};
