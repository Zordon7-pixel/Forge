const { aggregateWeeklyStress, evaluateStressBudget, validateRollingHardDays } = require('./goalBackwardLoad');
const { validateGoalBackwardCandidate, validateInterference, validateConstraints, longestRequiredSeparation } = require('./goalBackwardValidators');
const { validateCanonicalSession } = require('./canonicalWorkout');
const { addDays, canonicalHash } = require('./racePlanPolicy');
const { isRun, isStrength } = require('./adaptiveCoachingSelection');
const { EXERCISES_BY_ID } = require('./strengthDoseAccounting');
const localDate = (instant, timezone) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const weekday = date => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${date}T12:00:00Z`).getUTCDay()];
const duration = session => session.derived_totals?.duration_s ?? 0;
const demanding = session => ['threshold_run', 'interval_run', 'race_rhythm_run', 'long_aerobic', 'race',
  'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation'].includes(session.workout_family);
const lowerBody = session => (session.steps || []).some(step => EXERCISES_BY_ID[step.exercise_id]?.region === 'lower');
function normalizeSolverConstraints(state, input = {}) {
  const start = state.planning_date_local, end = addDays(start, 6);
  const windows = {};
  for (const modality of ['run', 'lift']) {
    if (!Array.isArray(input[modality]) || input[modality].length > 28) throw new Error('Supply at most 28 explicit time windows per modality');
    windows[modality] = input[modality].map(window => {
      const a = Date.parse(window.start_at), b = Date.parse(window.end_at);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b - a > 86400000
        || !/(Z|[+-]\d\d:\d\d)$/.test(window.start_at) || !/(Z|[+-]\d\d:\d\d)$/.test(window.end_at)) throw new Error('Invalid availability interval');
      const date = localDate(a, state.timezone);
      if (date < start || date > end || localDate(b - 1, state.timezone) !== date) throw new Error('Availability must lie in the seven-local-day planning window');
      if (!state.available_days.includes(date) && !state.available_days.includes(weekday(date))) throw new Error('Availability exceeds athlete state');
      return { date, start_at: new Date(a).toISOString(), end_at: new Date(b).toISOString() };
    }).sort((a, b) => a.start_at.localeCompare(b.start_at));
  }
  const occupied = input.occupied_sessions || [];
  if (!Array.isArray(occupied) || occupied.length > 28 || occupied.some(s => !validateCanonicalSession(s).valid
    || !s.scheduled_start_at || !Number.isFinite(Date.parse(s.scheduled_start_at)) || duration(s) <= 0
    || localDate(s.scheduled_start_at, state.timezone) !== s.scheduled_local_date
    || s.scheduled_local_date < addDays(start, -6) || s.scheduled_local_date > addDays(end, 6))) throw new Error('Occupied sessions must be complete canonical sessions with exact times within the boundary window');
  const blocked = input.blocked_dates || [];
  if (!Array.isArray(blocked) || blocked.length > 7 || blocked.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < start || d > end)) throw new Error('Invalid blocked dates');
  const locks = [...state.locks, ...(input.locks || [])], edits = [...state.manual_edits, ...(input.manual_edits || [])];
  if (locks.length > 28 || edits.length > 28 || locks.some(l => !['day_lock', 'session_lock'].includes(l.constraint_kind ?? l.kind))
    || edits.some(e => (e.constraint_kind ?? e.kind) !== 'manual_edit')) throw new Error('Unsupported or excessive athlete constraints');
  return { ...windows, occupied_sessions: occupied, blocked_dates: [...new Set(blocked)].sort(), locks, manual_edits: edits,
    start_date: start, end_date: end, timezone: state.timezone };
}
function validateAdaptivePlacement(sessions, constraints, state, weeklyObjectives, { complete = false } = {}) {
  const violations = [], all = [...constraints.occupied_sessions, ...sessions];
  const inWindow = s => s.scheduled_local_date >= constraints.start_date && s.scheduled_local_date <= constraints.end_date;
  for (const s of sessions.filter(s => s.workout_family !== 'rest')) {
    const start = Date.parse(s.scheduled_start_at), end = start + duration(s) * 1000;
    const modality = isStrength(s.workout_family) ? 'lift' : 'run';
    if (!Number.isFinite(start) || constraints.planning_instant && start < Date.parse(constraints.planning_instant) || duration(s) <= 0 || constraints.blocked_dates.includes(s.scheduled_local_date)
      || !constraints[modality].some(w => w.date === s.scheduled_local_date && start >= Date.parse(w.start_at) && end <= Date.parse(w.end_at))
      || state.adaptive_foundation.max_session_minutes !== null && duration(s) > state.adaptive_foundation.max_session_minutes * 60) {
      violations.push({ code: 'SCHEDULE_CONSTRAINT', session_id: s.session_id });
    }
  }
  const active = all.filter(s => s.workout_family !== 'rest');
  if (new Set(all.map(s => s.session_id)).size !== all.length) violations.push({ code: 'DUPLICATE_SESSION_ID' });
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j];
    // Existing neighboring work constrains the candidate, but cannot be repaired here.
    if (i < constraints.occupied_sessions.length && j < constraints.occupied_sessions.length) continue;
    const [first, second] = Date.parse(a.scheduled_start_at) <= Date.parse(b.scheduled_start_at) ? [a, b] : [b, a];
    const hours = (Date.parse(second.scheduled_start_at) - Date.parse(first.scheduled_start_at) - duration(first) * 1000) / 3600000;
    const same = first.scheduled_local_date === second.scheduled_local_date;
    const physiologicalMinimum = longestRequiredSeparation(first, second, { training_age_class: state.training_age_class })?.hours || 0;
    const required = Math.max(physiologicalMinimum, demanding(first) && demanding(second) ? 48
      : (lowerBody(first) && demanding(second) || lowerBody(second) && demanding(first)) ? 24
        : same ? 6 : 0);
    if (hours < required) violations.push({ code: 'ADAPTIVE_RECOVERY_HOURS', session_ids: [first.session_id, second.session_id],
      actual_recovery_hours: hours, minimum_recovery_hours: required });
  }
  for (const date of new Set(active.filter(inWindow).map(s => s.scheduled_local_date))) {
    const day = active.filter(s => s.scheduled_local_date === date);
    const minutes = state.time_constraints?.[date]?.available_minutes ?? state.time_constraints?.[date]?.maximum_minutes;
    if (typeof minutes === 'number' && Number.isFinite(minutes) && day.reduce((n, s) => n + duration(s), 0) > minutes * 60) violations.push({ code: 'SCHEDULE_CONSTRAINT', scheduled_local_date: date });
    if (day.length > 2 || day.filter(s => isRun(s.workout_family)).length > 1 || day.filter(s => isStrength(s.workout_family)).length > 1) {
      violations.push({ code: 'DAILY_MODALITY_CAPACITY', scheduled_local_date: date });
    }
  }
  for (const [modality, predicate] of [['run', isRun], ['lift', isStrength]]) {
    if (active.filter(s => inWindow(s) && predicate(s.workout_family)).length > weeklyObjectives.capacities[modality]) violations.push({ code: 'FREQUENCY_IS_CAPACITY', modality });
  }
  const plannedRuns = all.filter(s => inWindow(s) && isRun(s.workout_family));
  const sum = key => plannedRuns.reduce((n, s) => n + s.derived_totals[key], 0);
  const dose = weeklyObjectives.dose_policy;
  if (sum('duration_s') > dose.running_duration_ceiling_s || dose.running_distance_ceiling_m !== null && sum('distance_m') > dose.running_distance_ceiling_m) {
    violations.push({ code: 'OBSERVED_RUNNING_DOSE_EXCEEDED' });
  }
  const options = { training_age_class: state.training_age_class, consistency_state: state.consistency_state,
    recovery_state: state.recovery_state, safety_action: state.safety_action };
  const interference = validateInterference(all, options);
  const rolling = validateRollingHardDays(all, { ...options, spacing_valid: interference.valid });
  const aggregate = aggregateWeeklyStress(all.filter(inWindow));
  const budget = evaluateStressBudget(aggregate, { normal_ceiling_vector: weeklyObjectives.weekly_stress_budget,
    authorized_ceiling_vector: weeklyObjectives.weekly_stress_budget });
  const occupiedDates = new Set(active.filter(inWindow).map(s => s.scheduled_local_date));
  if (occupiedDates.size === 7) violations.push({ code: 'REQUIRED_RECOVERY_DAY' });
  if (complete) {
    const locks = validateConstraints(all, { locks: constraints.locks, manual_edits: constraints.manual_edits });
    violations.push(...locks.violations);
  }
  return { valid: !violations.length && interference.valid && rolling.valid && aggregate.valid && budget.valid,
    violations: [...violations, ...interference.violations, ...rolling.violations, ...aggregate.violations, ...budget.violations],
    aggregate, budget, rolling, interference };
}
function validateAdaptiveCandidate(candidate, constraints, state, selection) {
  const actual = validateAdaptivePlacement(candidate.sessions, constraints, state, selection.weekly_objectives, { complete: true });
  const objectiveIds = new Set(selection.weekly_objectives.objectives.map(o => o.objective_id));
  const traceViolations = candidate.sessions.flatMap(s => !Array.isArray(s.objective_ids) || !s.objective_ids.length
    || s.objective_ids.some(id => !objectiveIds.has(id)) ? [{ code: 'OBJECTIVE_TRACE_MISSING', session_id: s.session_id }] : []);
  for (const session of candidate.sessions.filter(s => s.workout_family !== 'rest')) {
    const entry = selection.entries.find(e => e.selection_id === session.session_id);
    const prescribedExercises = entry?.exercises?.map(require('./strengthDoseAccounting').canonicalStrengthExercise);
    const actualExercises = session.steps.filter(s => s.type === 'strength_exercise');
    const doseMismatch = !entry || entry.workout_family !== session.workout_family
      || canonicalHash(entry.dose_basis) !== canonicalHash(session.dose_basis)
      || entry.duration_s !== undefined && session.derived_totals.duration_s !== entry.duration_s
      || entry.distance_m !== undefined && entry.distance_m !== null && session.derived_totals.distance_m !== entry.distance_m
      || entry.quality_work_s !== undefined && entry.quality_work_s !== null && session.derived_totals.work_duration_s !== entry.quality_work_s
      || prescribedExercises && (prescribedExercises.length !== actualExercises.length
        || prescribedExercises.some((e, i) => e.exercise_id !== actualExercises[i].exercise_id
          || Object.keys(e.target).some(k => canonicalHash(e.target[k]) !== canonicalHash(actualExercises[i].target[k]))));
    if (doseMismatch) traceViolations.push({ code: 'SELECTED_DOSE_MISMATCH', session_id: session.session_id });
  }
  const primary = selection.weekly_objectives.objectives.filter(o => ['PRIMARY_KEY', 'ASSESSMENT'].includes(o.role));
  const uncovered = primary.filter(o => !candidate.sessions.some(s => s.objective_ids?.includes(o.objective_id)));
  traceViolations.push(...uncovered.map(o => ({ code: 'REQUIRED_EXPOSURE_UNPLACEABLE', objective_id: o.objective_id })));
  actual.violations.push(...traceViolations);
  actual.valid = actual.valid && !traceViolations.length;
  const validation = validateGoalBackwardCandidate(candidate, {
    training_age_class: state.training_age_class, consistency_state: state.consistency_state,
    recovery_state: state.recovery_state, safety_action: state.safety_action,
    available_local_dates: Array.from({ length: 7 }, (_, i) => addDays(constraints.start_date, i)),
    recent_normal_running_minutes_per_week: state.recent_normal_running.median_duration_s / 60,
    minimum_weekly_demand: selection.weekly_objectives.running_demand,
    required_exposure_ledger: primary.map(o => ({ requirement_id: o.requirement_id, any_of: o.candidate_families, role: o.role })),
    workload_evidence: actual, planning_date_local: constraints.start_date,
    candidate_window_end_local: constraints.end_date,
    allowed_requirement_ids: [...selection.entries.map(e => e.requirement_id), 'protect_recovery'],
    maximum_session_count: 21,
  });
  return { valid: actual.valid && validation.valid, validator_results: [...validation.validator_results,
    { validator: 'adaptive_actual_placement', ...actual }], violations: [...validation.violations, ...actual.violations],
    reason_codes: [...new Set([...validation.reason_codes, ...actual.violations.map(v => v.code)])] };
}
module.exports = { localDate, weekday, duration, demanding, lowerBody, normalizeSolverConstraints,
  validateAdaptivePlacement, validateAdaptiveCandidate };
