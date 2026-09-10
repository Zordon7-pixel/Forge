const { canonicalHash } = require('./racePlanPolicy');
const { aggregateWeeklyStress, resolveSessionStress } = require('./goalBackwardLoad');
const { immutableOwnJson } = require('./immutableOwnJson');
const VERSION = 'canonical-combined-load-v3';
const VERSIONS = Object.freeze({ combined: VERSION, running: require('./runningDoseAccounting').VERSION,
  strength: require('./strengthDoseAccounting').VERSION, taxonomy: 1, canonical: 1, stack: 'existing-maxplus-v1' });
const verifiedFrozenSources = new WeakMap();
const sumBase = sessions => sessions.reduce((sum, session) => {
  const resolved = resolveSessionStress(session);
  if (!resolved.valid) throw new Error('Invalid canonical dose');
  return sum.map((value, index) => value + resolved.vector[index]);
}, Array(8).fill(0));
const knownRunDistance = sessions => sessions.filter(session => session.kind === 'run' || !String(session.workout_family).startsWith('strength_'))
  .reduce((sum, session) => sum + (session.derived_totals?.distance_m || 0), 0);

function buildCanonicalLoadSource(sessionSet, { contextHash, authority = 'TEMPLATE_BOUNDED', partialWeekContract = null, frequencyDoseContract = null }) {
  if (!contextHash || !validVersionedSet(sessionSet)) throw new Error('Independent source set is invalid');
  const content = { versions: VERSIONS, authority, context_hash: contextHash,
    ...(partialWeekContract ? { partial_week_contract: structuredClone(partialWeekContract) } : {}),
    ...(frequencyDoseContract ? { frequency_dose_contract: structuredClone(frequencyDoseContract) } : {}),
    canonical_session_set: sessionSet, base_vector: sumBase(sessionSet.sessions),
    placed_vector: aggregateWeeklyStress(sessionSet.sessions).weekly_dimension_sum };
  return { ...content, content_hash: canonicalHash(content) };
}

function validVersionedSet(set) {
  return set?.prescribed_dose_versions?.running === VERSIONS.running
    && set?.prescribed_dose_versions?.strength === VERSIONS.strength
    && require('./runningDoseAccounting').validateIndependentRunningSource(set.sessions || [])
    && require('./canonicalWorkout').validateCanonicalSessionSet(set).valid;
}

function evaluateCanonicalCombinedLoad(sessions, source, contextHash) {
  const invalid = reason => ({ valid: false, policy_version: VERSION, state: 'INVALID_LOAD_ARTIFACT',
    reason_codes: ['CROSS_MODAL_FATIGUE_LIMIT'], violations: [{ code: 'CROSS_MODAL_FATIGUE_LIMIT', reason }] });
  if (!source || !contextHash || source.context_hash !== contextHash || canonicalHash(source.versions) !== canonicalHash(VERSIONS)
    || !['HISTORY_COMPATIBLE','TEMPLATE_BOUNDED'].includes(source.authority)) return invalid('CANONICAL_SOURCE_VERSION_OR_AUTHORITY_MISMATCH');
  const { content_hash: hash, ...content } = source;
  const cacheEligible = immutableOwnJson(source);
  const cached = cacheEligible ? verifiedFrozenSources.get(source) : null;
  if (!cached && (hash !== canonicalHash(content) || !validVersionedSet(source.canonical_session_set))) return invalid('CANONICAL_SOURCE_HASH_INVALID');
  const running = require('./runningDoseAccounting');
  const allowedRunningSources = new Set(source.canonical_session_set.sessions
    .filter(session => running.FAMILIES.has(session.workout_family)).map(session => session.running_dose?.source_hash));
  if (!running.validateRunningDosePools(sessions)
    || sessions.some(session => running.FAMILIES.has(session.workout_family)
      && !allowedRunningSources.has(session.running_dose?.source_hash))) {
    return invalid('CANONICAL_RUNNING_SOURCE_AUTHORITY_MISMATCH');
  }
  const allowedStrengthSources = new Set(source.canonical_session_set.sessions
    .filter(session => session.strength_distribution)
    .map(session => session.strength_distribution.source_template_content_hash));
  if (sessions.some(session => session.strength_distribution
    && !allowedStrengthSources.has(session.strength_distribution.source_template_content_hash))) {
    return invalid('CANONICAL_STRENGTH_SOURCE_AUTHORITY_MISMATCH');
  }
  let sourceBase, candidateBase;
  try { sourceBase = cached || sumBase(source.canonical_session_set.sessions); candidateBase = sumBase(sessions); }
  catch { return invalid('CANONICAL_SOURCE_OR_CANDIDATE_DOSE_INVALID'); }
  if (canonicalHash(sourceBase) !== canonicalHash(source.base_vector)) return invalid('SOURCE_TOTAL_MISMATCH');
  // Only recursively frozen, fully verified source graphs can be memoized.
  // Mutable caller payloads are always revalidated after any tampering.
  if (!cached && cacheEligible) verifiedFrozenSources.set(source, sourceBase);
  const aggregate = aggregateWeeklyStress(sessions);
  if (!aggregate.valid) return invalid('PLACEMENT_DOSE_INVALID');
  const violations = candidateBase.flatMap((value, dimension) => value > sourceBase[dimension] + 1e-6
    ? [{ code: 'CROSS_MODAL_FATIGUE_LIMIT', reason: 'CANONICAL_SOURCE_DOSE_EXCEEDED', dimension,
      candidate_base: value, source_base: sourceBase[dimension] }] : []);
  const candidateDistance = knownRunDistance(sessions), sourceDistance = knownRunDistance(source.canonical_session_set.sessions);
  if (candidateDistance > sourceDistance + 1e-6) violations.push({ code: 'CROSS_MODAL_FATIGUE_LIMIT',
    reason: 'CANONICAL_SOURCE_RUNNING_DISTANCE_EXCEEDED', candidate_distance_m: candidateDistance, source_distance_m: sourceDistance });
  return { valid: !violations.length, policy_version: VERSION,
    state: violations.length ? 'UNSUPPORTED_OVERAGE' : source.authority,
    source_hash: hash, source_base_vector: sourceBase, candidate_base_vector: candidateBase,
    actual_placed_vector: aggregate.weekly_dimension_sum,
    reason_codes: violations.length ? ['CROSS_MODAL_FATIGUE_LIMIT'] : [], violations };
}

function validateRollingCanonicalLoad(sessions, sources, { throughDate } = {}) {
  if (!Array.isArray(sources) || !sources.length || sources.some(source =>
    !evaluateCanonicalCombinedLoad(source?.canonical_session_set?.sessions || [], source, source?.context_hash).valid)) return { valid: false };
  const sourceSessions = sources.flatMap(source => source.canonical_session_set.sessions);
  const { addDays } = require('./racePlanPolicy');
  // Do not compare a suffix of the current week to a complete seven-day
  // source window. Future dates have not been selected yet; they are checked
  // when the next week is appended.
  const windows = [...new Set(sessions.map(session => session.scheduled_local_date))].sort()
    .filter(start => !throughDate || addDays(start, 6) <= throughDate).map(start => {
    const end = addDays(start, 6);
    const within = entries => entries.filter(session => session.scheduled_local_date >= start && session.scheduled_local_date <= end);
    const actual = sumBase(within(sessions)), source = sumBase(within(sourceSessions));
    const actualDistance = knownRunDistance(within(sessions)), sourceDistance = knownRunDistance(within(sourceSessions));
    return { start_date: start, end_date: end, actual, source,
      actual_distance_m: actualDistance, source_distance_m: sourceDistance,
      valid: actual.every((value, dimension) => value <= source[dimension] + 1e-6) && actualDistance <= sourceDistance + 1e-6 };
  });
  return { valid: windows.every(window => window.valid), windows };
}

module.exports = { VERSION, VERSIONS, buildCanonicalLoadSource, evaluateCanonicalCombinedLoad, validateRollingCanonicalLoad, sumBase };
