// Forged Hybrid - canonical plan schema (H1)
//
// Introduces schema-version 2 plan metadata (planMode + strengthPolicy) stored
// INSIDE the existing plan JSON blob (no new DB columns) and bidirectional
// adapters so every legacy day-level consumer keeps working.
//
// Vocabulary (two different levels):
//   - A WEEK holds a day-entry array. Legacy weeks use week.days OR
//     week.sessions; both are arrays of DAY entries (one per calendar day).
//   - A canonical schema-v2 DAY holds day.sessions[] where each entry is a
//     SESSION (run or lift) with a stable id. Legacy days are flat objects
//     with no .sessions array, so Array.isArray(dayEntry.sessions) reliably
//     distinguishes a v2 day.
//
// Design guarantee: for a legacy plan every adapter is the identity function,
// and a run-only schema-v2 plan collapses to behaviour equivalent to its legacy
// twin for today / compliance / override / completion / reschedule.

const SCHEMA_VERSION = 2;

const PLAN_MODES = Object.freeze({
  RUN_ONLY: 'run_only',
  HYBRID_MAINTAIN: 'hybrid_maintain',
  HYBRID_BUILD: 'hybrid_build',
  HYROX_BUILD: 'hyrox_build',
});

const VALID_MODES = new Set(Object.values(PLAN_MODES));

// Neutral strength copy - no running-first / injury-prevention-only framing.
const STRENGTH_MAINTAIN_TITLE = 'Strength maintenance';
const STRENGTH_BUILD_TITLE = 'Strength build';

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const REMOVAL_SESSION_ID_FIELD = 'removal_session_id';

let idCounter = 0;
function stableId(prefix) {
  idCounter += 1;
  return (prefix || 'sess') + '-' + idCounter + '-' + Date.now().toString(36);
}

function isSchemaV2(plan) {
  return !!plan && Number(plan.schemaVersion) === SCHEMA_VERSION;
}

function isHybridMode(mode) {
  return mode === PLAN_MODES.HYBRID_MAINTAIN
    || mode === PLAN_MODES.HYBRID_BUILD
    || mode === PLAN_MODES.HYROX_BUILD;
}

function stripUndefined(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

const SESSION_FIELD_DENYLIST = new Set([
  'access_token',
  'api_key',
  'auth_token',
  'authorization',
  'password',
  'password_hash',
  'refresh_token',
  'response_state',
  'secret',
  'transient_response_state',
]);

function cloneCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(cloneCanonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).reduce((result, key) => {
    if (!SESSION_FIELD_DENYLIST.has(String(key).toLowerCase()) && value[key] !== undefined) {
      result[key] = cloneCanonicalValue(value[key]);
    }
    return result;
  }, {});
}

function kindFromLegacy(entry) {
  const e = entry || {};
  const t = String(e.workout_type || e.type || '').toLowerCase();
  if (t.includes('rest')) return 'rest';
  if (t.includes('strength') || t.includes('lift')) return 'lift';
  if (t.includes('cross')) return 'lift';
  return 'run';
}

function kindFromSession(session) {
  const s = session || {};
  const k = String(s.kind || '').toLowerCase();
  if (k === 'run' || k === 'lift' || k === 'rest' || k === 'hyrox') return k;
  const family = String(s.workout_family || '').toLowerCase();
  if (family === 'rest' || family === 'mobility' || family === 'manual_recovery') return 'rest';
  if (family.startsWith('strength_')) return 'lift';
  if (family.startsWith('hyrox_')) return 'hyrox';
  if (family) return 'run';
  return kindFromLegacy(s);
}

function hasCompletedStatus(value) {
  const status = String(value?.status || value?.state || '').trim().toLowerCase();
  return value?.completed === true || status === 'completed';
}

// Stored plans have used all of these completion shapes over time. Treat the
// owning day as completed for every session it contains so destructive actions
// never become available merely because progress_json lacks the session id.
function isStoredSessionCompleted(dayEntry, session) {
  return hasCompletedStatus(session) || hasCompletedStatus(dayEntry);
}

function dayEntriesKey(week) {
  if (Array.isArray(week && week.days)) return 'days';
  if (Array.isArray(week && week.sessions)) return 'sessions';
  return 'days';
}

function getDayEntries(week) {
  if (Array.isArray(week && week.days)) return week.days;
  if (Array.isArray(week && week.sessions)) return week.sessions;
  return [];
}

function setDayEntries(week, entries) {
  const key = dayEntriesKey(week);
  const next = Object.assign({}, week);
  next[key] = entries;
  return next;
}

function dateOnly(value) {
  const candidate = String(value || '').slice(0, 10);
  if (!DATE_ONLY.test(candidate)) return null;
  const parsed = new Date(`${candidate}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate;
}

function addDateDays(value, amount) {
  const iso = dateOnly(value);
  if (!iso) return null;
  const parsed = new Date(`${iso}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(amount || 0));
  return parsed.toISOString().slice(0, 10);
}

function weekdayIndex(value) {
  const normalized = String(value || '').trim().slice(0, 3).toLowerCase();
  const index = DAY_ORDER.findIndex((day) => day.toLowerCase() === normalized);
  return index >= 0 ? index : null;
}

function mondayForDate(value, labelledDay = null) {
  const iso = dateOnly(value);
  if (!iso) return null;
  const labelledIndex = weekdayIndex(labelledDay);
  if (labelledIndex !== null) return addDateDays(iso, -labelledIndex);
  const parsed = new Date(`${iso}T12:00:00.000Z`);
  return addDateDays(iso, -((parsed.getUTCDay() + 6) % 7));
}

function canonicalWeekStart(plan, week, weekIndex, assignmentStart = null) {
  const direct = dateOnly(week?.startDate || week?.start_date || week?.week_start);
  if (direct) return mondayForDate(direct);

  const firstDated = getDayEntries(week)
    .map((entry) => ({ date: dateOnly(entry?.date), day: entry?.day || entry?.dayName }))
    .filter((entry) => entry.date)
    .sort((left, right) => left.date.localeCompare(right.date))[0];
  if (firstDated) return mondayForDate(firstDated.date, firstDated.day);

  const planStart = dateOnly(plan?.startDate || plan?.start_date) || dateOnly(assignmentStart);
  return planStart ? addDateDays(mondayForDate(planStart), weekIndex * 7) : null;
}

function removalSessionIdentifier(dayEntry, session) {
  const direct = session?.[REMOVAL_SESSION_ID_FIELD] || dayEntry?.[REMOVAL_SESSION_ID_FIELD];
  return direct ? String(direct) : null;
}

function removalMarker(date, dayEntry, session, sessionIndex) {
  if (!date) return null;
  const explicitId = session?.id ?? dayEntry?.id;
  const base = explicitId !== undefined && explicitId !== null && String(explicitId).trim()
    ? `id:${String(explicitId).trim()}`
    : `slot:${kindFromSession(session)}:${sessionIndex}`;
  return `remove:v1:${date}:${encodeURIComponent(base)}`;
}

// Add a removal-only identity to a served plan view. The immutable plan's
// completion/reschedule ids remain unchanged. Removal identities always carry
// a canonical date and are omitted when no reliable date can be derived or a
// marker is non-unique, so a crafted request can never remove the wrong workout.
function withRemovalSessionIdentities(plan, options = {}) {
  const source = plan && typeof plan === 'object' ? plan : {};
  if (!Array.isArray(source.weeks)) return source;
  const markerCounts = new Map();
  const weeksWithCandidates = source.weeks.map((week, weekIndex) => {
    const weekStart = canonicalWeekStart(source, week, weekIndex, options.assignmentStart);
    const entries = getDayEntries(week).map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const explicitDate = dateOnly(entry.date);
      const dayOffset = weekdayIndex(entry.day || entry.dayName);
      const canonicalDate = explicitDate || (weekStart && dayOffset !== null ? addDateDays(weekStart, dayOffset) : null);
      const datedEntry = canonicalDate && !explicitDate ? { ...entry, date: canonicalDate } : { ...entry };
      if (Array.isArray(entry.sessions)) {
        datedEntry.sessions = entry.sessions.map((session, sessionIndex) => {
          if (!session || typeof session !== 'object' || kindFromSession(session) === 'rest') return session;
          const marker = removalMarker(canonicalDate, entry, session, sessionIndex);
          if (!marker) return { ...session };
          markerCounts.set(marker, (markerCounts.get(marker) || 0) + 1);
          return { ...session, [REMOVAL_SESSION_ID_FIELD]: marker };
        });
        return datedEntry;
      }
      if (kindFromLegacy(entry) === 'rest') return datedEntry;
      const marker = removalMarker(canonicalDate, entry, entry, 0);
      if (!marker) return datedEntry;
      markerCounts.set(marker, (markerCounts.get(marker) || 0) + 1);
      return { ...datedEntry, [REMOVAL_SESSION_ID_FIELD]: marker };
    });
    return setDayEntries(week, entries);
  });

  const weeks = weeksWithCandidates.map((week) => setDayEntries(week, getDayEntries(week).map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (Array.isArray(entry.sessions)) {
      return {
        ...entry,
        sessions: entry.sessions.map((session) => {
          const marker = session?.[REMOVAL_SESSION_ID_FIELD];
          if (!marker || markerCounts.get(marker) === 1) return session;
          const next = { ...session };
          delete next[REMOVAL_SESSION_ID_FIELD];
          return next;
        }),
      };
    }
    const marker = entry[REMOVAL_SESSION_ID_FIELD];
    if (!marker || markerCounts.get(marker) === 1) return entry;
    const next = { ...entry };
    delete next[REMOVAL_SESSION_ID_FIELD];
    return next;
  })));
  return { ...source, weeks };
}

function sessionIdentifier(dayEntry, session, sessionIndex = 0, dayIndex = 0) {
  const d = dayEntry || {};
  const s = session || {};
  if (s.session_id !== undefined && s.session_id !== null && String(s.session_id).length) return String(s.session_id);
  if (s.id !== undefined && s.id !== null && String(s.id).length) return String(s.id);
  if (!Array.isArray(d.sessions)) {
    return d.id !== undefined && d.id !== null && String(d.id).length
      ? String(d.id)
      : String(dayIndex);
  }
  const anchor = d.id || d.date || d.day || `day-${dayIndex}`;
  return `${anchor}-${kindFromSession(s)}-${sessionIndex}`;
}

function canonicalTargetHasField(steps, field) {
  return (Array.isArray(steps) ? steps : []).some((entry) => (
    Boolean(entry?.target && Object.hasOwn(entry.target, field))
    || canonicalTargetHasField(entry?.children, field)
  ));
}

function normalizeSession(session, fallbackId) {
  const s = session || {};
  const kind = kindFromSession(s);
  const prescription = s.prescription && typeof s.prescription === 'object' ? s.prescription : null;
  const preserved = cloneCanonicalValue(s);
  const flat = prescription ? cloneCanonicalValue(prescription) : {};
  const stableSessionId = s.session_id ?? s.id;
  const id = stableSessionId !== undefined && stableSessionId !== null && String(stableSessionId).length
    ? String(stableSessionId)
    : fallbackId;
  const canonical = Number(s.canonical_workout_schema_version) === 1;
  const totals = canonical && s.derived_totals && typeof s.derived_totals === 'object'
    ? s.derived_totals
    : {};
  const hasCanonicalDistance = canonical && canonicalTargetHasField(s.steps, 'distance_m');
  const hasCanonicalDuration = canonical && canonicalTargetHasField(s.steps, 'duration_s');
  const legacyType = canonical ? legacyTypeForCanonicalFamily(s.workout_family) : undefined;
  const legacyWorkoutType = canonical ? legacyWorkoutTypeForKind(kind) : undefined;
  return Object.assign(
    {},
    flat,
    preserved,
    { kind },
    id ? { id } : {},
    canonical && id ? { session_id: id } : {},
    stripUndefined({
      type: s.type ?? legacyType,
      workout_type: s.workout_type ?? legacyWorkoutType,
      title: s.title,
      display_name: s.display_name ?? s.displayName,
      distance_miles: canonical
        ? (hasCanonicalDistance
          ? (s.distance_miles ?? (Number.isFinite(totals.distance_m) ? totals.distance_m / 1609.344 : undefined))
          : undefined)
        : s.distance_miles,
      duration_min: canonical
        ? (hasCanonicalDuration
          ? (s.duration_min ?? (Number.isFinite(totals.duration_s) ? totals.duration_s / 60 : undefined))
          : undefined)
        : s.duration_min,
      description: s.description,
      pace_target: s.pace_target,
      target_zone: s.target_zone,
      intensity: s.intensity,
      steps: s.steps,
      structure: s.structure,
      focus: s.focus,
      warmup: s.warmup,
      main: s.main,
      exercises: s.exercises,
      recovery: s.recovery,
      cooldown: s.cooldown,
      progression: s.progression,
      prescriptionBasis: s.prescriptionBasis,
      prescription_basis: s.prescription_basis,
      purpose: s.purpose,
      recoveries: s.recoveries,
      evidence_refs: s.evidence_refs,
      durationIsEstimated: s.durationIsEstimated,
      duration_is_estimate: s.duration_is_estimate,
      distance_is_estimate: s.distance_is_estimate,
      benchmark: s.benchmark,
    })
  );
}

function legacyWorkoutTypeForKind(kind) {
  if (kind === 'lift') return 'strength';
  if (kind === 'hyrox') return 'hyrox';
  if (kind === 'rest') return 'rest';
  return 'run';
}

function legacyTypeForCanonicalFamily(family) {
  if (family === 'rest' || family === 'mobility' || family === 'manual_recovery') return 'rest';
  if (family === 'recovery_run') return 'recovery';
  if (family === 'easy_run') return 'easy';
  if (family === 'long_aerobic') return 'long';
  if (String(family || '').startsWith('strength_')) return 'strength';
  if (String(family || '').startsWith('hyrox_')) return 'hyrox';
  if (family === 'assessment') return 'assessment';
  if (family === 'race') return 'race';
  return family ? 'quality' : undefined;
}

// Return the canonical session list for a day entry.
//   - legacy flat day -> single wrapped session (or [] for rest)
//   - schema-v2 day    -> its sessions[], normalized, rest sessions dropped
function daySessions(dayEntry) {
  const d = dayEntry || {};
  if (Array.isArray(d.sessions)) {
    return d.sessions
      .map((session, index) => normalizeSession(session, sessionIdentifier(d, session, index)))
      .filter((s) => s.kind !== 'rest');
  }
  const kind = kindFromLegacy(d);
  if (kind === 'rest') return [];
  const existingId = d.id !== undefined && d.id !== null && String(d.id).length ? String(d.id) : undefined;
  return [normalizeSession(Object.assign({}, d, { kind }), existingId)];
}

// Apply assignment-level session removals without mutating the immutable plan
// artifact.  Session ids are resolved against the original day before any
// filtering so removing one sibling never changes another sibling's fallback
// identity.
function withoutRemovedSessions(plan, removedSessionIds = []) {
  const source = plan && typeof plan === 'object' ? plan : {};
  const removed = new Set((Array.isArray(removedSessionIds) ? removedSessionIds : [])
    .map(String)
    .filter(Boolean));
  if (!removed.size || !Array.isArray(source.weeks)) return source;

  let changed = false;
  const weeks = source.weeks.map((week) => {
    const entries = getDayEntries(week);
    let weekChanged = false;
    const nextEntries = entries.map((entry, dayIndex) => {
      if (!entry || typeof entry !== 'object') return entry;
      if (Array.isArray(entry.sessions)) {
        const sessions = entry.sessions.filter((session, sessionIndex) => (
          !removed.has(removalSessionIdentifier(entry, session, sessionIndex, dayIndex))
        ));
        if (sessions.length === entry.sessions.length) return entry;
        weekChanged = true;
        return { ...entry, sessions };
      }

      if (kindFromLegacy(entry) === 'rest') return entry;
      const sessionId = removalSessionIdentifier(entry, entry, 0, dayIndex);
      if (!removed.has(sessionId)) return entry;
      weekChanged = true;
      return {
        ...entry,
        sessions: [],
        rest: true,
        status: 'removed',
        type: 'rest',
        workout_type: 'rest',
      };
    });
    if (!weekChanged) return week;
    changed = true;
    return setDayEntries(week, nextEntries);
  });
  return changed ? { ...source, weeks } : source;
}

function assignmentProgress(assignmentRow = {}) {
  let progress = assignmentRow?.progress_json || {};
  if (typeof progress === 'string') {
    try {
      progress = JSON.parse(progress || '{}');
    } catch {
      progress = {};
    }
  }
  return progress && typeof progress === 'object' && !Array.isArray(progress) ? progress : {};
}

function remapProgressIds(values, identityMap) {
  const result = [];
  for (const value of (Array.isArray(values) ? values : [])) {
    const current = String(value);
    const matches = identityMap.get(current);
    const next = matches?.size === 1 ? Array.from(matches)[0] : current;
    if (!result.includes(next)) result.push(next);
  }
  return result;
}

// Early schema-v2 generators could persist nested sessions without ids.
// Backfill them deterministically before a later mutation. Prefer the old
// fallback id when unique so existing completion evidence retains its meaning;
// ambiguous fallbacks get a date/position-qualified id and are not guessed.
function normalizePersistedPlanIdentities(plan, assignmentRow = {}) {
  const source = plan && typeof plan === 'object' ? plan : {};
  const progress = assignmentProgress(assignmentRow);
  if (!isSchemaV2(source) || !Array.isArray(source.weeks)) {
    return { plan: source, progress, planChanged: false, progressChanged: false, changed: false };
  }

  const usedIds = new Set();
  const fallbackCounts = new Map();
  const missingRecords = [];
  source.weeks.forEach((week, weekIndex) => {
    getDayEntries(week).forEach((entry, dayIndex) => {
      const sessions = Array.isArray(entry?.sessions) ? entry.sessions : [entry].filter(Boolean);
      sessions.forEach((session, sessionIndex) => {
        const explicit = session?.id == null ? '' : String(session.id).trim();
        if (explicit) {
          usedIds.add(explicit);
          return;
        }
        const fallback = sessionIdentifier(entry, session, sessionIndex, dayIndex);
        fallbackCounts.set(fallback, (fallbackCounts.get(fallback) || 0) + 1);
        missingRecords.push({ weekIndex, dayIndex, sessionIndex, fallback });
      });
    });
  });
  const preexistingExplicitIds = new Set(usedIds);
  if (!missingRecords.length) {
    return { plan: source, progress, planChanged: false, progressChanged: false, changed: false };
  }

  const missingByPosition = new Map(missingRecords.map((record) => [
    `${record.weekIndex}:${record.dayIndex}:${record.sessionIndex}`,
    record,
  ]));
  const completionMap = new Map();
  const recordCompletionMapping = (from, to) => {
    if (!completionMap.has(from)) completionMap.set(from, new Set());
    completionMap.get(from).add(to);
  };
  const assignmentStart = assignmentRow?.week_start || assignmentRow?.effective_from
    || assignmentRow?.started_at || null;
  const weeks = source.weeks.map((week, weekIndex) => {
    const weekStart = canonicalWeekStart(source, week, weekIndex, assignmentStart);
    const entries = getDayEntries(week).map((entry, dayIndex) => {
      if (!entry || typeof entry !== 'object') return entry;
      const dayOffset = weekdayIndex(entry.day || entry.dayName);
      const canonicalDate = dateOnly(entry.date)
        || (weekStart && dayOffset !== null ? addDateDays(weekStart, dayOffset) : null);
      const addIdentity = (session, sessionIndex) => {
        const record = missingByPosition.get(`${weekIndex}:${dayIndex}:${sessionIndex}`);
        if (!record) return session;
        let generated = fallbackCounts.get(record.fallback) === 1 && !usedIds.has(record.fallback)
          ? record.fallback
          : `legacy-v2-${canonicalDate || `w${weekIndex + 1}-d${dayIndex + 1}`}-${kindFromSession(session)}-${sessionIndex + 1}`;
        const base = generated;
        let suffix = 2;
        while (usedIds.has(generated)) {
          generated = `${base}-${suffix}`;
          suffix += 1;
        }
        usedIds.add(generated);
        // A rescheduled historical session may already own the computed
        // fallback as its explicit id. In that case completion evidence belongs
        // to that true owner and must never be reassigned to this id-less sibling.
        if (!preexistingExplicitIds.has(record.fallback)) {
          recordCompletionMapping(record.fallback, generated);
        }
        return { ...session, id: generated };
      };
      if (Array.isArray(entry.sessions)) {
        return { ...entry, sessions: entry.sessions.map(addIdentity) };
      }
      return addIdentity(entry, 0);
    });
    return setDayEntries(week, entries);
  });
  const normalizedPlan = { ...source, weeks };

  const originalIdentified = withRemovalSessionIdentities(source, { assignmentStart });
  const normalizedIdentified = withRemovalSessionIdentities(normalizedPlan, { assignmentStart });
  const removalMap = new Map();
  source.weeks.forEach((week, weekIndex) => {
    const originalEntries = getDayEntries(originalIdentified.weeks?.[weekIndex]);
    const normalizedEntries = getDayEntries(normalizedIdentified.weeks?.[weekIndex]);
    getDayEntries(week).forEach((entry, dayIndex) => {
      const originalEntry = originalEntries[dayIndex];
      const normalizedEntry = normalizedEntries[dayIndex];
      const originalSessions = Array.isArray(entry?.sessions) ? originalEntry?.sessions || [] : [originalEntry];
      const normalizedSessions = Array.isArray(entry?.sessions) ? normalizedEntry?.sessions || [] : [normalizedEntry];
      originalSessions.forEach((session, sessionIndex) => {
        const oldMarker = removalSessionIdentifier(originalEntry, session);
        const newMarker = removalSessionIdentifier(normalizedEntry, normalizedSessions[sessionIndex]);
        if (!oldMarker || !newMarker) return;
        if (!removalMap.has(oldMarker)) removalMap.set(oldMarker, new Set());
        removalMap.get(oldMarker).add(newMarker);
      });
    });
  });

  const completedSessionIds = remapProgressIds(progress.completedSessionIds, completionMap);
  const removedSessionIds = remapProgressIds(progress.removedSessionIds, removalMap);
  const nextProgress = {
    ...progress,
    ...(Array.isArray(progress.completedSessionIds) ? { completedSessionIds } : {}),
    ...(Array.isArray(progress.removedSessionIds) ? { removedSessionIds } : {}),
  };
  const progressChanged = JSON.stringify(nextProgress) !== JSON.stringify(progress);
  return {
    plan: normalizedPlan,
    progress: nextProgress,
    planChanged: true,
    progressChanged,
    changed: true,
  };
}

function planViewsForAssignment(plan, assignmentRow = {}) {
  const normalized = normalizePersistedPlanIdentities(plan, assignmentRow);
  const progress = normalized.progress;
  const removedSessionIds = Array.isArray(progress?.removedSessionIds)
    ? progress.removedSessionIds
    : [];
  const identified = withRemovalSessionIdentities(normalized.plan, {
    assignmentStart: assignmentRow?.week_start || assignmentRow?.effective_from || assignmentRow?.started_at || null,
  });
  return {
    storedPlan: identified,
    visiblePlan: withoutRemovedSessions(identified, removedSessionIds),
    progress,
  };
}

function visiblePlanForAssignment(plan, assignmentRow = {}) {
  return planViewsForAssignment(plan, assignmentRow).visiblePlan;
}

function isRestEntry(dayEntry) {
  const d = dayEntry || {};
  if (Array.isArray(d.sessions)) return daySessions(d).length === 0;
  if (d.rest === true) return true;
  return kindFromLegacy(d) === 'rest';
}

// Produce the flat, legacy-shaped day object a single-session consumer expects.
// For legacy days this returns the SAME object (identity), guaranteeing
// byte-equivalent behaviour; only v2 days are flattened.
function flattenDayForConsumer(dayEntry) {
  const d = dayEntry;
  if (!d || !Array.isArray(d.sessions)) return d;
  const sessions = daySessions(d);
  const base = { day: d.day, date: d.date };
  if (d.id !== undefined) base.id = d.id;
  if (d.orderGuidance !== undefined) base.orderGuidance = d.orderGuidance;
  if (d.status !== undefined) base.status = d.status;
  if (sessions.length === 0) {
    return Object.assign({}, base, {
      type: 'rest',
      workout_type: 'rest',
      distance_miles: 0,
      description: d.description || 'Rest and recovery',
      rest: true,
      sessions: [],
    });
  }
  const primary = sessions.find((s) => s.kind === 'run') || sessions[0];
  const primaryFlat = Object.assign({}, primary);
  delete primaryFlat.id;
  delete primaryFlat.kind;
  return Object.assign({}, base, {
    id: base.id !== undefined ? base.id : primary.id,
    type: primary.type || (primary.kind === 'lift' ? 'strength' : 'run'),
  }, primaryFlat, { sessions });
}

// Compliance helper: expand one day entry into per-session planned rows.
// legacy day -> 1 row (matches old mapType behaviour); v2 day -> one row per
// run/lift session. Run-only v2 collapses to exactly one run row per day.
function plannedSessionsForDay(dayEntry, idx, dateStr) {
  const d = dayEntry || {};
  const sessions = daySessions(d);
  if (sessions.length === 0) return [];
  return sessions.map((s, sIdx) => ({
    sessionId: sessionIdentifier(d, Array.isArray(d.sessions) ? d.sessions[sIdx] : d, sIdx, idx),
    day: d.day || ('Day ' + (idx + 1)),
    date: dateStr,
    type: s.kind === 'lift' ? 'lift' : s.kind === 'hyrox' ? 'hyrox' : 'run',
    distance: Number(s.distance_miles || 0),
    raw: s,
  }));
}

// Move one planned session into the next rest day without dropping a sibling
// session. Compliance and reschedule share sessionIdentifier(), so id-less
// legacy and v2 plans remain addressable across repeated reads.
function rescheduleSessionInWeek(week, sessionId, { targetDate = null } = {}) {
  const entries = getDayEntries(week);
  const wanted = String(sessionId);
  let sourceIndex = -1;
  let sourceSessionIndex = -1;

  for (let dayIndex = 0; dayIndex < entries.length; dayIndex += 1) {
    const day = entries[dayIndex] || {};
    if (!Array.isArray(day.sessions)) {
      if (isRestEntry(day)) continue;
      if (sessionIdentifier(day, day, 0, dayIndex) === wanted) {
        sourceIndex = dayIndex;
        break;
      }
      continue;
    }
    const match = day.sessions.findIndex((session, index) => (
      kindFromSession(session) !== 'rest' && sessionIdentifier(day, session, index, dayIndex) === wanted
    ));
    if (match >= 0) {
      sourceIndex = dayIndex;
      sourceSessionIndex = match;
      break;
    }
  }

  if (sourceIndex < 0) return { error: 'not_found' };
  const requestedDate = typeof targetDate === 'string' ? targetDate.trim() : '';
  const targetIndex = requestedDate
    ? entries.findIndex((entry, index) => index !== sourceIndex && entry?.date === requestedDate && isRestEntry(entry))
    : entries.findIndex((entry, index) => index > sourceIndex && isRestEntry(entry));
  if (targetIndex < 0) return { error: 'no_target' };

  const source = entries[sourceIndex];
  const target = entries[targetIndex];
  const nextEntries = entries.slice();
  const movedFrom = source.day;
  const movedTo = target.day;

  if (Array.isArray(source.sessions)) {
    const normalizedSessions = source.sessions.map((session, index) => (
      normalizeSession(session, sessionIdentifier(source, session, index, sourceIndex))
    ));
    const movingSession = normalizedSessions[sourceSessionIndex];
    const siblingSessions = normalizedSessions.filter((_, index) => index !== sourceSessionIndex);
    nextEntries[sourceIndex] = toCanonicalDay(source, siblingSessions);
    nextEntries[targetIndex] = toCanonicalDay(target, [movingSession]);
  } else {
    nextEntries[sourceIndex] = stripUndefined({
      day: source.day,
      date: source.date,
      type: 'rest',
      workout_type: 'rest',
      distance_miles: 0,
      duration_min: 0,
      description: 'Rescheduled recovery day',
      rest: true,
    });
    nextEntries[targetIndex] = Object.assign({}, source, {
      id: source.id || wanted,
      day: target.day,
      date: target.date || source.date,
      description: `${source.description || ''} (rescheduled)`.trim(),
      rest: false,
    });
  }

  return {
    week: setDayEntries(week, nextEntries),
    movedFrom,
    movedTo,
    movedFromDate: source.date || null,
    movedToDate: target.date || null,
  };
}

function isRestOverridePatch(patch) {
  const p = patch || {};
  const normalized = (value) => String(value || '').trim().toLowerCase();
  return normalized(p.checkin_override?.action) === 'rest'
    || normalized(p.type) === 'rest'
    || normalized(p.workout_type) === 'rest';
}

// Session-aware override merge. Identical to { ...day, ...patch } for legacy /
// single-session days. Run-specific adjustments continue to touch only the run
// session, while a safety rest directive makes every retained session kind
// non-executable (including lift-only and hybrid days).
function applyOverrideToDay(day, patch) {
  const p = patch || {};
  if (!day || typeof p !== 'object') return day || null;
  const merged = Object.assign({}, day, p);
  if (Array.isArray(day.sessions) && day.sessions.length) {
    const restOverride = isRestOverridePatch(p);
    merged.sessions = day.sessions.map((s) => (
      restOverride || kindFromSession(s) === 'run' ? Object.assign({}, s, p) : s
    ));
  }
  return merged;
}

// Infer a mode for a plan that has no explicit planMode (legacy plans).
function inferPlanMode(plan) {
  const weeks = plan && Array.isArray(plan.weeks) ? plan.weeks : [];
  for (const week of weeks) {
    for (const dayEntry of getDayEntries(week)) {
      for (const session of daySessions(dayEntry)) {
        if (session.kind === 'lift') return PLAN_MODES.HYBRID_MAINTAIN;
      }
    }
  }
  return PLAN_MODES.RUN_ONLY;
}

function getPlanMode(plan) {
  if (plan && VALID_MODES.has(plan.planMode)) return plan.planMode;
  return inferPlanMode(plan);
}

function normalizeStrengthPolicy(policy, mode) {
  if (!isHybridMode(mode)) {
    return { enabled: false };
  }
  const base = policy && typeof policy === 'object' ? policy : {};
  const rawPerWeek = Number(base.sessionsPerWeek);
  const sessionsPerWeek = Number.isFinite(rawPerWeek) ? Math.max(1, Math.min(6, Math.round(rawPerWeek))) : 3;
  const rawMin = Number(base.minimumSessionsPerWeek);
  const minimumSessionsPerWeek = Number.isFinite(rawMin)
    ? Math.max(1, Math.min(sessionsPerWeek, Math.round(rawMin)))
    : Math.min(2, sessionsPerWeek);
  return {
    enabled: true,
    goal: mode === PLAN_MODES.HYBRID_BUILD ? 'build' : 'maintain',
    sessionsPerWeek,
    minimumSessionsPerWeek,
    equipment: Array.isArray(base.equipment) ? base.equipment.slice(0, 12) : ['barbell', 'dumbbell'],
    preferredDays: Array.isArray(base.preferredDays) ? base.preferredDays.slice(0, 7) : ['Mon', 'Wed', 'Fri'],
  };
}

// A run session that must NOT sit next to lower-body strength (interference).
function isHardOrLongRun(session) {
  const s = session || {};
  const text = [s.title, s.description, s.type, s.workout_type, s.intensity, s.target_zone]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /(long|quality|tempo|threshold|interval|hill|hard|speed|vo2|race|zone 3|zone 4|zone 5)/.test(text);
}

function buildLiftSession(focus, mode) {
  const goalTitle = mode === PLAN_MODES.HYBRID_BUILD ? STRENGTH_BUILD_TITLE : STRENGTH_MAINTAIN_TITLE;
  return {
    id: stableId('lift'),
    kind: 'lift',
    type: 'strength',
    workout_type: 'strength',
    title: goalTitle + ' - ' + focus,
    focus,
    distance_miles: 0,
    description: goalTitle + ' session (' + focus + '). Full prescriptions are added in a later phase.',
  };
}

// Future-only mode switch. Past dates and completed sessions are immutable.
//   hybrid_* -> run_only : remove future lift sessions only.
//   run_only -> hybrid_* : inject lifts into eligible future days only, after
//                          deterministic interference + strength-floor checks.
function switchPlanMode(plan, targetMode, opts) {
  const options = opts || {};
  const todayISO = options.todayISO || new Date().toISOString().slice(0, 10);
  const completed = new Set((options.completedSessionIds || []).map(String));
  if (!VALID_MODES.has(targetMode)) {
    throw new Error('switchPlanMode: invalid target mode ' + targetMode);
  }
  const source = plan && typeof plan === 'object' ? plan : { weeks: [] };
  const policy = normalizeStrengthPolicy(
    isHybridMode(targetMode) ? (source.strengthPolicy || options.strengthPolicy) : null,
    targetMode
  );
  const perWeekCap = isHybridMode(targetMode) ? policy.sessionsPerWeek : 0;
  // Preferred lift weekdays that avoid the hard/long run slots (Tue/Sat here).
  const liftDayFocus = { Mon: 'Upper body', Wed: 'Lower body', Fri: 'Upper body' };

  const weeks = (Array.isArray(source.weeks) ? source.weeks : []).map((week) => {
    const entries = getDayEntries(week);
    let liftCountThisWeek = 0;
    const nextEntries = entries.map((entry) => {
      const sessions = daySessions(entry);
      const isFuture = entry && entry.date ? String(entry.date) > todayISO : false;

      // Count existing (non-removed) lifts toward the weekly cap.
      const existingLifts = sessions.filter((s) => s.kind === 'lift');
      if (!isFuture) {
        liftCountThisWeek += existingLifts.length;
        return entry; // immutable past/today
      }

      if (targetMode === PLAN_MODES.RUN_ONLY) {
        // Remove future lifts unless that specific lift was completed.
        const kept = sessions.filter((s) => s.kind !== 'lift' || completed.has(String(s.id)));
        liftCountThisWeek += kept.filter((s) => s.kind === 'lift').length;
        return toCanonicalDay(entry, kept);
      }

      // hybrid target: keep existing lifts, count them.
      liftCountThisWeek += existingLifts.length;
      const weekday = entry.day || weekdayFromDate(entry.date);
      const alreadyHasLift = existingLifts.length > 0;
      const eligibleDay = Object.prototype.hasOwnProperty.call(liftDayFocus, weekday);
      const hasHardRun = sessions.some((s) => s.kind === 'run' && isHardOrLongRun(s));
      if (
        !alreadyHasLift &&
        eligibleDay &&
        !hasHardRun &&
        liftCountThisWeek < perWeekCap &&
        sessions.length < 2
      ) {
        const lift = buildLiftSession(liftDayFocus[weekday], targetMode);
        liftCountThisWeek += 1;
        return toCanonicalDay(entry, sessions.concat([lift]), true);
      }
      return toCanonicalDay(entry, sessions);
    });
    return setDayEntries(week, nextEntries);
  });

  const nextPlan = Object.assign({}, source, {
    schemaVersion: SCHEMA_VERSION,
    planMode: targetMode,
    weeks,
  });
  if (isHybridMode(targetMode)) {
    nextPlan.strengthPolicy = policy;
  } else {
    nextPlan.strengthPolicy = { enabled: false };
  }
  return nextPlan;
}

function weekdayFromDate(dateStr) {
  const s = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

// Rebuild a day entry as a canonical schema-v2 day with the given sessions.
function toCanonicalDay(entry, sessions, sameDayRunLift) {
  const e = entry || {};
  const next = {
    date: e.date,
    day: e.day || weekdayFromDate(e.date),
    sessions: sessions.map((session) => {
      const normalized = normalizeSession(session);
      return normalized.id ? normalized : Object.assign({}, normalized, { id: stableId(normalized.kind) });
    }),
  };
  if (e.id !== undefined) next.id = e.id;
  if (e.status !== undefined) next.status = e.status;
  const hasRunAndLift = next.sessions.some((s) => s.kind === 'run') && next.sessions.some((s) => s.kind === 'lift');
  if (hasRunAndLift) {
    next.orderGuidance = sameDayRunLift
      ? 'Run first; lift at least 6 hours later.'
      : e.orderGuidance;
    if (next.orderGuidance === undefined) delete next.orderGuidance;
  }
  return next;
}

function buildCanonicalPlanFromSessionSet(sessionSet, { currentPlan = null } = {}) {
  if (!sessionSet || !Array.isArray(sessionSet.sessions)) return currentPlan;
  const groupedByWeek = new Map();
  for (const session of sessionSet.sessions) {
    const date = dateOnly(session?.scheduled_local_date);
    if (!date) continue;
    const weekStart = mondayForDate(date);
    if (!groupedByWeek.has(weekStart)) groupedByWeek.set(weekStart, new Map());
    const days = groupedByWeek.get(weekStart);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(session);
  }
  const weeks = [...groupedByWeek.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([startDate, days], weekIndex) => ({
      week: weekIndex + 1,
      startDate,
      days: [...days.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([date, sessions]) => toCanonicalDay(
          { date, day: weekdayFromDate(date) },
          sessions.slice().sort((left, right) => (
            String(left.role || '').localeCompare(String(right.role || ''))
            || String(left.session_id || '').localeCompare(String(right.session_id || ''))
          )),
        )),
    }));
  return {
    schemaVersion: SCHEMA_VERSION,
    canonical_workout_schema_version: sessionSet.canonical_workout_schema_version,
    plan_id: sessionSet.plan_id,
    plan_revision: sessionSet.plan_revision,
    decision_id: sessionSet.decision_id,
    decision_hash: sessionSet.decision_hash,
    selected_candidate_id: sessionSet.candidate_id,
    selected_candidate_hash: sessionSet.candidate_hash,
    canonical_session_set_hash: sessionSet.content_hash,
    planMode: currentPlan?.planMode || PLAN_MODES.RUN_ONLY,
    weeks,
  };
}

module.exports = {
  SCHEMA_VERSION,
  PLAN_MODES,
  VALID_MODES,
  STRENGTH_MAINTAIN_TITLE,
  STRENGTH_BUILD_TITLE,
  DAY_ORDER,
  DAY_INDEX,
  stableId,
  isSchemaV2,
  isHybridMode,
  inferPlanMode,
  getPlanMode,
  normalizeStrengthPolicy,
  getDayEntries,
  setDayEntries,
  dayEntriesKey,
  kindFromLegacy,
  kindFromSession,
  isStoredSessionCompleted,
  isRestEntry,
  daySessions,
  withRemovalSessionIdentities,
  removalSessionIdentifier,
  withoutRemovedSessions,
  normalizePersistedPlanIdentities,
  planViewsForAssignment,
  visiblePlanForAssignment,
  normalizeSession,
  adaptCanonicalSessionForLegacy: normalizeSession,
  sessionIdentifier,
  flattenDayForConsumer,
  plannedSessionsForDay,
  rescheduleSessionInWeek,
  applyOverrideToDay,
  isRestOverridePatch,
  isHardOrLongRun,
  buildLiftSession,
  buildCanonicalPlanFromSessionSet,
  switchPlanMode,
  toCanonicalDay,
  weekdayFromDate,
};
