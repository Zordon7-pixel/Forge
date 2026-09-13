// Closed numeric/enum comparison, separate from release telemetry v1. No IDs,
// titles, raw observations, exception strings or user-authored fields survive.
const { PLANNING_PHASES } = require('./goalBackwardContracts');
const { canonicalHash, addDays } = require('./racePlanPolicy');
const { aggregateWeeklyStress } = require('./goalBackwardLoad');
const { validateInterference } = require('./goalBackwardValidators');
const { legacyGoalBackwardFamily } = require('./racePlanCandidateEngine');
const { validateCanonicalSession } = require('./canonicalWorkout');
const { capacitiesFor } = require('./adaptiveCoachingObjectives');
const FAMILIES = new Set(['easy_run', 'recovery_run', 'steady_run', 'threshold_run', 'interval_run',
  'race_rhythm_run', 'long_aerobic', 'race', 'strength_upper', 'strength_lower', 'strength_full_body',
  'hyrox_station_skill', 'hyrox_station_strength', 'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation', 'rest']);
const KEYS = new Set(['threshold_run', 'interval_run', 'race_rhythm_run', 'long_aerobic', 'race',
  'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation']);
const bounded = (n, max = 1e8) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 1000) / 1000 : null;
function sumKnown(values) { return values.every(v => v !== null) ? bounded(values.reduce((n, v) => n + v, 0)) : null; }
function metrics(sessions, phase, objectives, start) {
  if (!sessions || sessions.length > 28) return { phase: null, stress: null, objective_coverage: null,
    frequency: null, key_placement: null, hard_day_count: null, long_run_share: null, taper: null, interference: null };
  const canonical = sessions.every(s => validateCanonicalSession(s).valid);
  const rows = sessions.map(s => ({ s, family: legacyGoalBackwardFamily(s) }));
  const known = rows.every(r => FAMILIES.has(r.family));
  const runs = rows.filter(r => FAMILIES.has(r.family) && capacitiesFor(r.family).includes('run'));
  const durations = rows.filter(r => r.family !== 'rest').map(r => canonical ? bounded(r.s.derived_totals?.duration_s)
    : bounded(typeof r.s.duration_min === 'number' ? r.s.duration_min * 60 : null));
  const distances = runs.map(r => canonical ? bounded(r.family.startsWith('hyrox_') ? r.s.running_distance_m : r.s.derived_totals?.distance_m)
    : bounded(typeof r.s.distance_miles === 'number' ? r.s.distance_miles * 1609.344 : null));
  const runDistance = sumKnown(distances);
  const longDistance = sumKnown(runs.map((r, i) => r.family === 'long_aerobic' ? distances[i] : 0));
  const aggregate = canonical ? aggregateWeeklyStress(sessions) : null;
  const covered = new Set(sessions.flatMap(s => s.objective_ids || []));
  const phaseValue = [...PLANNING_PHASES, 'base', 'build', 'deload', 'peak', 'taper', 'race'].includes(phase) ? phase : null;
  const placement = known ? rows.filter(r => KEYS.has(r.family)).map(r => ({ family: r.family,
    day_offset: bounded((Date.parse(`${r.s.scheduled_local_date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000, 6) })) : null;
  return { phase: phaseValue,
    stress: { prescribed_duration_s: sumKnown(durations), prescribed_running_distance_m: runDistance,
      dose_vector: aggregate?.valid ? aggregate.weekly_dimension_sum.map(v => bounded(v)) : null,
      observed_stress_vector: null }, // completed physiological stress has no authenticated v3 measurement source
    objective_coverage: canonical && objectives ? { total: objectives.length,
      covered: objectives.filter(o => covered.has(o.objective_id)).length,
      mandatory: objectives.filter(o => o.role === 'PRIMARY_KEY').length,
      mandatory_covered: objectives.filter(o => o.role === 'PRIMARY_KEY' && covered.has(o.objective_id)).length } : null,
    frequency: known ? { run: runs.length, strength: rows.filter(r => capacitiesFor(r.family).includes('lift')).length } : null,
    key_placement: placement,
    hard_day_count: aggregate?.valid ? aggregate.days.filter(d => d.hard_day).length : null,
    long_run_share: runDistance > 0 && longDistance !== null ? bounded(longDistance / runDistance, 1) : null,
    taper: phaseValue === null ? null : ['TAPER_RACE_WEEK', 'taper', 'race'].includes(phaseValue),
    interference: canonical ? validateInterference(sessions).valid : null };
}
function compare(prepared, result, plan) {
  const start = prepared.foundation.athlete_state.planning_date_local, end = addDays(start, 6);
  const days = (plan.weeks || []).flatMap(w => (w.days || []).map(d => ({ ...d, phase: w.phase })));
  const window = days.filter(d => d.date >= start && d.date <= end);
  const legacy = window.flatMap(d => (d.sessions || []).map(s => ({ ...s, scheduled_local_date: d.date })));
  const content = { schema_version: 'adaptive_shadow_comparison_v1', mode: 'shadow',
    legacy: metrics(legacy, window[0]?.phase, null, start),
    adaptive: metrics(result.selected_candidate?.sessions || null, result.decision.phase,
      result.decision.weekly_objectives.objectives, start), surface_capability: 'NOT_EXPOSED' };
  if (Buffer.byteLength(JSON.stringify(content)) > 8192) throw new Error('Comparison bound');
  return Object.freeze({ ...content, comparison_hash: canonicalHash(content) });
}
module.exports = { compare };
