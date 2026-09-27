// Stored log facts, not sensor measurements or prescribed-work completion.
const { localDate } = require('./adaptiveCoachingValidation');
const VERSION = 'stored-strength-log-observation-v1';
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(value)) return null;
  if (!dateOnly(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23
    || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
  const normalized = value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const at = Date.parse(normalized);
  return Number.isFinite(at) ? at : null;
}
const number = (value, maximum, integer = false) => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= maximum && (!integer || Number.isSafeInteger(value));
const measure = value => ({ state: value === null ? 'UNKNOWN' : value === 0 ? 'VALID_ZERO' : 'KNOWN', value });
// These columns are database recording clocks, never client occurrence input.
// SQLite CURRENT_TIMESTAMP serializes UTC without an offset; PostgreSQL includes
// its offset. Keep the stored text and do not apply this rule to completed_at.
const sqliteClock = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value);
const recordedInstant = value => instant(sqliteClock(value) ? value + 'Z' : value);
function projectSessionLog(session, rows, { since, through, observationInstant, timezone }) {
  const at = instant(observationInstant), created = recordedInstant(session.created_at);
  const start = instant(session.started_at), end = instant(session.ended_at);
  const datePrecision = dateOnly(session.started_at) && session.ended_at === session.started_at;
  const date = datePrecision ? session.started_at : start === null ? null : localDate(new Date(start).toISOString(), timezone);
  const chronology = at !== null && created !== null && created <= at && date >= since && date <= through
    && date <= localDate(new Date(at).toISOString(), timezone)
    && (datePrecision || start !== null && end !== null && start <= end && end <= at);
  const keys = rows.map(row => `${String(row.exercise_name).trim().toLowerCase()}:${row.set_number}`);
  const duplicate = new Set(keys).size !== keys.length;
  const sets = rows.map(row => {
    const logged = recordedInstant(row.logged_at);
    const name = typeof row.exercise_name === 'string' && row.exercise_name.trim().length
      && row.exercise_name.length <= 256 ? row.exercise_name.trim() : null;
    const repetitions = number(row.reps, 1000, true) && row.reps > 0 ? row.reps : null;
    const load = number(row.weight_lbs, 2000) ? row.weight_lbs : null;
    // SQLite's seconds-resolution clock cannot order events within that second.
    // This is declared log evidence, not precise sensor timing.
    const loggedUpper = logged === null ? null : logged + (sqliteClock(row.logged_at) ? 999 : 0);
    const valid = chronology && !duplicate && logged !== null && logged <= at && loggedUpper >= created
      && (datePrecision ? localDate(new Date(loggedUpper).toISOString(), timezone) >= date : loggedUpper >= start)
      && name !== null && Number.isSafeInteger(row.set_number) && row.set_number > 0
      && repetitions !== null && (row.weight_lbs === null || load !== null);
    return { record_id: row.id, exercise_name: name, set_number: row.set_number,
      repetitions: measure(repetitions), external_load_lbs: measure(load), recorded_at: row.logged_at,
      recorded_time_precision: sqliteClock(row.logged_at) ? 'SECOND' : 'STORED_TIMESTAMP',
      usable_as_log_observation: valid };
  });
  const usable = sets.length > 0 && sets.every(set => set.usable_as_log_observation);
  // Zero on the completed-at import route is a placeholder, not a measured
  // zero-duration session. Never derive duration from its recording timestamp.
  const duration = chronology && start !== null && end !== null && end > start
    && number(session.total_seconds, Number.MAX_SAFE_INTEGER, true) && session.total_seconds > 0
    && Math.abs(session.total_seconds - (end - start) / 1000) <= 1 ? session.total_seconds : null;
  return { version: VERSION, session_id: session.id, origin: 'UNKNOWN',
    evidence_semantics: 'USER_RECORDED_LOG', verification: 'UNVERIFIED',
    occurrence: { state: chronology ? 'DECLARED' : 'UNKNOWN', precision: datePrecision ? 'DATE' : start === null ? 'UNKNOWN' : 'INSTANT',
      started_at: session.started_at, ended_at: session.ended_at, local_date: date },
    recorded_at: session.created_at, duration_s: measure(duration), sets,
    known_set_count: usable ? sets.length : null,
    coverage_state: 'UNKNOWN', prescription_link_state: 'UNSUPPORTED',
    canonical_adherence_verified: false, progression_eligible: false };
}
function validateCompletedLogInput(body, now) {
  const invalid = () => { throw Object.assign(new Error('Invalid strength log.'), { status: 400 }); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const at = instant(now), completed = body.completed_at;
  if (completed != null && completed !== '') {
    // No athlete timezone is persisted on this route. A date is not an instant:
    // reject dates future in every supported civil zone, then acquisition checks
    // the exact planning timezone. Never reinterpret a declared date as UTC.
    if (dateOnly(completed)) { if (completed > new Date(at + 14 * 3600000).toISOString().slice(0, 10)) invalid(); }
    else if (instant(completed) === null || instant(completed) > at) invalid();
  }
  if (body.sets != null && (!Array.isArray(body.sets) || body.sets.length > 8192)) invalid();
  const numeric = (value, maximum, integer, positive = false) => {
    if (value == null || value === '') return;
    if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) invalid();
    const parsed = Number(value);
    if (!number(parsed, maximum, integer) || positive && parsed === 0) invalid();
  };
  for (const set of body.sets || []) {
    if (!set || typeof set !== 'object' || Array.isArray(set)) invalid();
    for (const key of ['exercise_name', 'muscle_group']) {
      if (set[key] != null && (typeof set[key] !== 'string' || set[key].length > 256)) invalid();
    }
    numeric(set.set_number, Number.MAX_SAFE_INTEGER, true, true);
    numeric(set.reps, 1000, true, true);
    numeric(set.weight_lbs, 2000, false);
  }
}
module.exports = { VERSION, dateOnly, instant, projectSessionLog, validateCompletedLogInput };
