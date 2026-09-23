// Shared closed contract for classification, summaries and persisted evidence.
const COMPLETION_OUTCOMES = Object.freeze([
  'UNDER_TARGET', 'ON_TARGET', 'ABOVE_TARGET', 'EXCESSIVE_STRAIN', 'INCOMPLETE',
  'PAIN_LIMITED', 'UNSCORABLE_PARTIAL_SYNC', 'UNSCORABLE_INSUFFICIENT_EVIDENCE',
]);
const UNSCORABLE_OUTCOMES = new Set(['UNSCORABLE_PARTIAL_SYNC', 'UNSCORABLE_INSUFFICIENT_EVIDENCE']);
const DOSE_OUTCOMES = new Set(['UNDER_TARGET', 'ON_TARGET', 'ABOVE_TARGET']);
// Canonical family authority, not the title or fastest accessory step. No
// interval target evaluation is implemented by this aggregate-dose contract.
const QUALITY_FAMILIES = new Set([
  'threshold_run', 'interval_run', 'race_rhythm_run', 'steady_run', 'race',
  'hyrox_station_strength', 'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
]);
function finiteNonNegativeMetric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function latestCompletionPairs(pairs = []) {
  const stringify = require('./racePlanPolicy').canonicalStringify;
  const bySession = new Map();
  for (const pair of pairs) {
    const id = pair.resolution_id ?? pair.prescribed_session?.session_id;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(pair);
  }
  const latest = [];
  for (const [id, group] of bySession) {
    const validRevision = n => Number.isSafeInteger(n) && n >= 1;
    // Recorder revisions order corrections of the same physical evidence even
    // when the actual activity's observed_at has not changed.
    const first = group[0].observation || {};
    const comparableRevision = first.evidence_id && group.every(p => p.observation?.evidence_id === first.evidence_id
      && validRevision(p.observation.measured_receipt_revision));
    const times = group.map(p => Date.parse(p.observation?.observed_at || ''));
    const maximum = comparableRevision ? Math.max(...group.map(p => p.observation.measured_receipt_revision))
      : times.every(Number.isFinite) ? Math.max(...times) : null;
    const candidates = maximum === null ? group : group.filter((p, i) =>
      (comparableRevision ? p.observation.measured_receipt_revision : times[i]) === maximum);
    if (candidates.every(p => stringify(p) === stringify(candidates[0]))) { latest.push(candidates[0]); continue; }
    // No supported ordering/identity: do not choose a success based on array
    // order. Keep actual observations elsewhere; only completion is uncertain.
    const ids = [...new Set(candidates.flatMap(p => [...(p.observation?.source_evidence_ids || []), p.observation?.evidence_id]).filter(Boolean))].sort();
    const prescribed = [...candidates].sort((a, b) => stringify(a.prescribed_session).localeCompare(stringify(b.prescribed_session)))[0].prescribed_session;
    latest.push({ prescribed_session: prescribed, observation: {
      linked_session_id: prescribed?.session_id ?? candidates[0].observation?.linked_session_id ?? null,
      observed_at: times.every(Number.isFinite) ? new Date(Math.max(...times)).toISOString() : null,
      quality_state: 'COMPLETE', completion_conflict: true, source_evidence_ids: ids,
    } });
  }
  return latest.sort((a, b) => String(a.observation?.observed_at || '').localeCompare(String(b.observation?.observed_at || ''))
    || String(a.prescribed_session?.session_id || '').localeCompare(String(b.prescribed_session?.session_id || ''))
    || stringify(a).localeCompare(stringify(b)));
}
module.exports = { COMPLETION_OUTCOMES, UNSCORABLE_OUTCOMES, DOSE_OUTCOMES, QUALITY_FAMILIES, finiteNonNegativeMetric, latestCompletionPairs };
