const {
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  addDays,
  canonicalHash,
} = require('./racePlanPolicy');
const { types: { isProxy } } = require('node:util');

const RUNNING_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run', 'interval_run',
  'race_rhythm_run', 'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
  'assessment', 'race',
]);
const DIMENSIONS = Object.freeze([
  'aerobic', 'running_impact', 'lower_body_muscular', 'upper_body_muscular',
  'grip', 'neuromuscular', 'metabolic', 'event_specific_fatigue',
]);
const QUALIFYING_REDUCTION_REASONS = new Set([
  'TAPER_VOLUME_REDUCTION',
  'INJURY_SCOPE',
  'ILLNESS_RECOVERY',
  'RECOVERY_VOLUME_REDUCTION',
  'TRAINING_GAP_REBUILD',
  'CROSS_MODAL_FATIGUE_LIMIT',
]);
const SCOPED_REASONS = new Set([
  ...QUALIFYING_REDUCTION_REASONS,
  'SCHEDULE_CONSTRAINT',
  'MODIFY_IMPACT',
  'NO_RUNNING',
  'NO_LOWER_BODY',
  'NO_HIGH_INTENSITY',
  'FULL_REST',
]);
const BLOCK_MODALITIES = new Set([
  'running', 'running_impact', 'running_quality', 'lower_body_muscular',
  'lower_body_intensity', 'aerobic', 'metabolic', 'event_specific_fatigue',
]);
const SCOPE_ACTIONS = new Set([
  'MODIFY_IMPACT', 'NO_RUNNING', 'NO_LOWER_BODY', 'NO_HIGH_INTENSITY',
  'MODIFIED_SESSION_ONLY', 'FULL_REST',
]);
const MAX_RECEIPT_BYTES = 16 * 1024;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_PATTERN = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
const BOUNDED_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function exactLocalDate(value) {
  if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) return null;
  const raw = value;
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function rfc3339Instant(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(RFC3339_PATTERN);
  if (!match || !exactLocalDate(match[1])) return null;
  if (/^[+-]14:(?!00$)/.test(match[5])) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dateOnly(value) {
  return exactLocalDate(value);
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactOwnKeys(value, expectedKeys) {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validTimezone(value) {
  const timezone = String(value || '');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch (_error) {
    return null;
  }
}

function instantLocalDate(instant, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return exactLocalDate(`${values.year}-${values.month}-${values.day}`);
  } catch (_error) {
    return null;
  }
}

function instantForLocalNoon(localDate, timezone) {
  const date = exactLocalDate(localDate);
  const zone = validTimezone(timezone);
  if (!date || !zone) return null;
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  let instant = target;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second), 0,
    );
    instant += target - represented;
  }
  const result = new Date(instant).toISOString();
  return instantLocalDate(result, zone) === date ? result : null;
}

function normalizedHash(value) {
  const raw = String(value || '').toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/.test(raw)) return raw;
  return /^[a-f0-9]{64}$/.test(raw) ? `sha256:${raw}` : null;
}

function finiteNonnegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function prefixedHash(value) {
  return `sha256:${canonicalHash(value)}`;
}

function evidenceRef(value) {
  const raw = String(value || '').trim();
  if (/^sha256:[a-f0-9]{64}$/.test(raw)) return raw;
  return raw ? prefixedHash({ evidence_identity: raw.slice(0, 512) }) : null;
}

function evidenceRefSet(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(evidenceRef).filter(Boolean))].sort();
}

function evidenceRefs(values) {
  return evidenceRefSet(values).slice(0, 16);
}

function sessionsFrom(container = {}) {
  return normalizedSessionRecords(container) || [];
}

function sessionFamily(session = {}) {
  return String(session.workout_family ?? session.workoutFamily ?? session.family ?? '');
}

function sessionRole(session = {}) {
  return String(session.role ?? session.session_role ?? session.sessionRole ?? '').toUpperCase();
}

function primitiveDistance(value, multiplier = 1) {
  if (value === null || value === undefined) return { state: 'MISSING', distance_m: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || value > Number.MAX_SAFE_INTEGER / multiplier) {
    return { state: 'MALFORMED', distance_m: null };
  }
  return { state: 'KNOWN', distance_m: value * multiplier };
}

function ownDataRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => (
      typeof key !== 'string'
        || !Object.hasOwn(descriptors[key], 'value')
    ))) return null;
    return descriptors;
  } catch (_error) {
    return null;
  }
}

function ownArrayValues(value, maximumLength = 4096) {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.hasOwn(descriptors, 'length') ? descriptors.length.value : null;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) return null;
    const allowedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
    if (Reflect.ownKeys(descriptors).some((key) => (
      typeof key !== 'string'
        || !allowedKeys.has(key)
        || !Object.hasOwn(descriptors[key], 'value')
    ))) return null;
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!Object.hasOwn(descriptors, key)) return null;
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch (_error) {
    return null;
  }
}

function ownField(descriptors, keys) {
  for (const key of keys) {
    if (descriptors && Object.hasOwn(descriptors, key)) {
      const value = descriptors[key].value;
      if (value === null || value === undefined) continue;
      return { present: true, value };
    }
  }
  return { present: false, value: undefined };
}

const INVALID_OWN_DATA_JSON = Symbol('INVALID_OWN_DATA_JSON');

function ownDataJsonSnapshot(value, options = {}) {
  const maximumDepth = Number.isSafeInteger(options.maximumDepth)
    ? Math.min(64, Math.max(1, options.maximumDepth)) : 48;
  const maximumNodes = Number.isSafeInteger(options.maximumNodes)
    ? Math.min(50000, Math.max(1, options.maximumNodes)) : 20000;
  const seen = new WeakSet();
  let nodeCount = 0;

  function snapshot(current, depth) {
    nodeCount += 1;
    if (nodeCount > maximumNodes || depth > maximumDepth) return INVALID_OWN_DATA_JSON;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      return Number.isFinite(current) ? current : INVALID_OWN_DATA_JSON;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) return INVALID_OWN_DATA_JSON;
    seen.add(current);

    const arrayValues = ownArrayValues(current);
    if (arrayValues) {
      const output = [];
      for (const entry of arrayValues) {
        const normalized = snapshot(entry, depth + 1);
        if (normalized === INVALID_OWN_DATA_JSON) return INVALID_OWN_DATA_JSON;
        output.push(normalized);
      }
      return Object.freeze(output);
    }

    const descriptors = ownDataRecord(current);
    if (!descriptors) return INVALID_OWN_DATA_JSON;
    const output = Object.create(null);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (descriptor.enumerable !== true) return INVALID_OWN_DATA_JSON;
      const normalized = snapshot(descriptor.value, depth + 1);
      if (normalized === INVALID_OWN_DATA_JSON) return INVALID_OWN_DATA_JSON;
      output[key] = normalized;
    }
    return Object.freeze(output);
  }

  const normalized = snapshot(value, 0);
  return normalized === INVALID_OWN_DATA_JSON ? null : normalized;
}

function ownStringAlias(descriptors, keys) {
  let resolved = null;
  for (const key of keys) {
    if (!descriptors || !Object.hasOwn(descriptors, key)) continue;
    const value = descriptors[key].value;
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 256) {
      return { valid: false, value: null };
    }
    const normalized = value.trim();
    if (resolved !== null && normalized !== resolved) return { valid: false, value: null };
    resolved = normalized;
  }
  return { valid: true, value: resolved };
}

function sameStringSet(left, right) {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function ownStringArrayAlias(descriptors, keys) {
  let resolved = null;
  for (const key of keys) {
    if (!descriptors || !Object.hasOwn(descriptors, key)) continue;
    const value = descriptors[key].value;
    if (value === null || value === undefined) continue;
    const values = ownArrayValues(value, 64);
    if (!values) return { valid: false, value: null };
    const normalized = values.map((id) => (
      typeof id === 'string' && id.trim() && id.length <= 256 ? id.trim() : null
    ));
    if (normalized.some((id) => id === null)
      || new Set(normalized).size !== normalized.length) {
      return { valid: false, value: null };
    }
    if (resolved !== null && !sameStringSet(resolved, normalized)) {
      return { valid: false, value: null };
    }
    resolved = normalized;
  }
  return { valid: true, value: resolved };
}

function goalRaceIdsFromRows(rows) {
  const ids = [];
  for (const goal of rows) {
    const descriptors = ownDataRecord(goal);
    if (!descriptors) return null;
    const goalId = ownStringAlias(descriptors, ['raceId', 'race_id']);
    if (!goalId.valid) return null;
    if (goalId.value && !ids.includes(goalId.value)) ids.push(goalId.value);
  }
  return ids;
}

function sessionGoalBindings(session) {
  const sessionRecord = ownDataRecord(session);
  if (!sessionRecord) return null;
  const bindings = [];
  const legacyGoalId = ownStringAlias(sessionRecord, ['goalRaceId', 'goal_race_id']);
  if (!legacyGoalId.valid) return null;
  if (legacyGoalId.value) bindings.push(legacyGoalId.value);
  const canonicalGoalIds = ownStringArrayAlias(sessionRecord, ['goal_ids', 'goalIds']);
  if (!canonicalGoalIds.valid) return null;
  if (canonicalGoalIds.value) bindings.push(...canonicalGoalIds.value);
  return bindings;
}

function semanticSessionBindingIds(bindings, knownRaceIds) {
  const known = new Set(knownRaceIds);
  const identities = [];
  for (const binding of bindings) {
    const matches = [];
    if (known.has(binding)) matches.push(binding);
    if (binding.startsWith('goal-') && binding.length > 'goal-'.length) {
      const prefixedIdentity = binding.slice('goal-'.length);
      if (known.has(prefixedIdentity) && !matches.includes(prefixedIdentity)) {
        matches.push(prefixedIdentity);
      }
    }
    if (matches.length > 1) return null;
    const identity = matches[0] || binding;
    if (!identities.includes(identity)) identities.push(identity);
  }
  return identities;
}

function hasOwnSessionBindingAuthority(descriptors) {
  return ['goalRaceId', 'goal_race_id', 'goal_ids', 'goalIds'].some((key) => (
    descriptors && Object.hasOwn(descriptors, key)
      && descriptors[key].value !== null && descriptors[key].value !== undefined
  ));
}

function sessionBindingsFromSessions(container) {
  const sessions = ownArrayValues(container);
  if (!sessions) return null;
  const bindings = [];
  for (const session of sessions) {
    if (session === null) continue;
    const sessionBindings = sessionGoalBindings(session);
    if (!sessionBindings) return null;
    bindings.push(...sessionBindings);
  }
  return bindings;
}

function sessionBindingsFromDays(container, knownRaceIds) {
  const days = ownArrayValues(container);
  if (!days) return null;
  const bindings = [];
  for (const day of days) {
    if (day === null) continue;
    const dayRecord = ownDataRecord(day);
    if (!dayRecord) return null;
    const sessionsField = ownField(dayRecord, ['sessions']);
    const ownBindings = sessionGoalBindings(day);
    if (!ownBindings) return null;
    const nestedRawBindings = sessionsField.present
      ? sessionBindingsFromSessions(sessionsField.value) : null;
    if (sessionsField.present && !nestedRawBindings) return null;
    const semanticOwnBindings = semanticSessionBindingIds(ownBindings, knownRaceIds);
    const semanticNestedBindings = sessionsField.present
      ? semanticSessionBindingIds(nestedRawBindings, knownRaceIds) : null;
    if (!semanticOwnBindings || (sessionsField.present && !semanticNestedBindings)) return null;
    if (sessionsField.present && hasOwnSessionBindingAuthority(dayRecord)
      && !sameStringSet(semanticOwnBindings, semanticNestedBindings)) return null;
    bindings.push(...(sessionsField.present ? semanticNestedBindings : semanticOwnBindings));
  }
  return bindings;
}

function ownDataRaceRemovalImpact(plan, raceId) {
  const root = ownDataRecord(plan);
  if (!root || typeof raceId !== 'string' || !raceId.trim()) return null;
  const wanted = raceId.trim();
  const goalIds = [];
  const goalsField = ownField(root, ['goals']);
  const goalField = ownField(root, ['goal']);
  let pluralGoalIds = null;
  let singularGoalIds = null;
  if (goalsField.present) {
    const rows = ownArrayValues(goalsField.value);
    if (!rows) return null;
    pluralGoalIds = goalRaceIdsFromRows(rows);
    if (!pluralGoalIds) return null;
  }
  if (goalField.present) {
    singularGoalIds = goalRaceIdsFromRows([goalField.value]);
    if (!singularGoalIds) return null;
  }
  if (pluralGoalIds !== null && singularGoalIds !== null) {
    const singularId = singularGoalIds[0] || null;
    if ((singularId === null && pluralGoalIds.length > 0)
      || (singularId !== null && !pluralGoalIds.includes(singularId))) return null;
  }
  goalIds.push(...(pluralGoalIds ?? singularGoalIds ?? []));
  const knownRaceIds = [...new Set([...goalIds, wanted])];

  const linkedSessionIds = [];
  const weeksField = ownField(root, ['weeks']);
  if (weeksField.present) {
    const weeks = ownArrayValues(weeksField.value);
    if (!weeks) return null;
    for (const week of weeks) {
      if (week === null) continue;
      const weekRecord = ownDataRecord(week);
      if (!weekRecord) return null;
      const daysField = ownField(weekRecord, ['days']);
      const sessionsField = ownField(weekRecord, ['sessions']);
      const dayBindings = daysField.present
        ? sessionBindingsFromDays(daysField.value, knownRaceIds) : null;
      const directRawBindings = sessionsField.present
        ? sessionBindingsFromSessions(sessionsField.value) : null;
      const directBindings = directRawBindings
        ? semanticSessionBindingIds(directRawBindings, knownRaceIds) : null;
      if ((daysField.present && !dayBindings) || (sessionsField.present && !directBindings)) return null;
      if (daysField.present && sessionsField.present
        && !sameStringSet(dayBindings, directBindings)) return null;
      if (dayBindings) linkedSessionIds.push(...dayBindings);
      if (!daysField.present && directBindings) {
        linkedSessionIds.push(...directBindings);
      }
    }
  }
  return Object.freeze({
    linked: goalIds.includes(wanted)
      || linkedSessionIds.includes(wanted)
      || linkedSessionIds.includes(`goal-${wanted}`),
    remainingRaceIds: Object.freeze(goalIds.filter((id) => id !== wanted)),
  });
}

function clonedOwnDataRecord(value, fallbackDate = null) {
  const descriptors = ownDataRecord(value);
  if (!descriptors) return null;
  const cloned = Object.create(null);
  for (const key of Object.keys(descriptors)) cloned[key] = descriptors[key].value;
  if (!Object.hasOwn(cloned, 'scheduled_local_date') && !Object.hasOwn(cloned, 'date')) {
    cloned.scheduled_local_date = fallbackDate;
  }
  return Object.freeze(cloned);
}

function normalizedSessionRecords(container) {
  const directArray = ownArrayValues(container);
  if (directArray) {
    const sessions = directArray.map((session) => clonedOwnDataRecord(session));
    return sessions.every(Boolean) ? sessions : null;
  }
  const root = ownDataRecord(container);
  if (!root) return null;
  const directSessions = ownField(root, ['sessions']);
  if (directSessions.present) {
    const values = ownArrayValues(directSessions.value);
    if (!values) return null;
    const sessions = values.map((session) => clonedOwnDataRecord(session));
    return sessions.every(Boolean) ? sessions : null;
  }
  const weeksField = ownField(root, ['weeks']);
  if (!weeksField.present) return [];
  const weeks = ownArrayValues(weeksField.value);
  if (!weeks) return null;
  const sessions = [];
  for (const week of weeks) {
    if (week === null) continue;
    const weekRecord = ownDataRecord(week);
    if (!weekRecord) return null;
    const daysField = ownField(weekRecord, ['days', 'sessions']);
    if (!daysField.present) continue;
    const days = ownArrayValues(daysField.value);
    if (!days) return null;
    for (const day of days) {
      if (day === null) continue;
      const dayRecord = ownDataRecord(day);
      if (!dayRecord) return null;
      const fallbackDateField = ownField(dayRecord, ['scheduled_local_date', 'date']);
      const daySessions = ownField(dayRecord, ['sessions']);
      if (!daySessions.present) {
        const cloned = clonedOwnDataRecord(day);
        if (!cloned) return null;
        sessions.push(cloned);
        continue;
      }
      const values = ownArrayValues(daySessions.value);
      if (!values) return null;
      for (const session of values) {
        const cloned = clonedOwnDataRecord(session, fallbackDateField.value ?? null);
        if (!cloned) return null;
        sessions.push(cloned);
      }
    }
  }
  return sessions;
}

function distanceObservation(descriptors) {
  const observations = [
    ownField(descriptors, ['running_distance_m']).value,
    ownField(descriptors, ['distance_m']).value,
    ownField(descriptors, ['distanceMeters']).value,
  ].map((value) => primitiveDistance(value));
  const derivedTotals = ownField(descriptors, ['derived_totals']).value;
  if (derivedTotals !== null && derivedTotals !== undefined) {
    const derivedDescriptors = ownDataRecord(derivedTotals);
    if (!derivedDescriptors) return { state: 'MALFORMED', distance_m: null };
    const derivedDistance = ownField(derivedDescriptors, ['distance_m']);
    observations.push(derivedDistance.present
      ? primitiveDistance(derivedDistance.value)
      : { state: 'UNKNOWN', distance_m: null });
  }
  observations.push(...[
    ownField(descriptors, ['distance_miles']).value,
    ownField(descriptors, ['distanceMiles']).value,
  ]
    .map((value) => primitiveDistance(value, 1609.344)));
  if (observations.some((observation) => observation.state === 'MALFORMED')) {
    return { state: 'MALFORMED', distance_m: null };
  }
  const known = observations.find((observation) => observation.state === 'KNOWN');
  if (known) return known;
  if (observations.some((observation) => observation.state === 'UNKNOWN')) {
    return { state: 'UNKNOWN', distance_m: null };
  }
  return { state: 'MISSING', distance_m: null };
}

function normalizedDistanceSession(session, fallbackDate = null) {
  if (session === null || session === undefined) {
    return Object.freeze({
      family: '', date: null, distance: { state: 'MISSING', distance_m: null },
    });
  }
  const descriptors = ownDataRecord(session);
  if (!descriptors) return null;
  const familyField = ownField(descriptors, ['workout_family', 'workoutFamily', 'family']);
  if (familyField.present && typeof familyField.value !== 'string') return null;
  const sessionDate = ownField(descriptors, ['scheduled_local_date', 'date']);
  const sourceDate = sessionDate.present ? sessionDate.value : fallbackDate;
  const date = sourceDate === null || sourceDate === undefined || typeof sourceDate === 'string'
    ? sourceDate : null;
  return Object.freeze({
    family: familyField.present ? familyField.value : '',
    date: date ?? null,
    distance: distanceObservation(descriptors),
  });
}

function normalizedRunningSessions(container) {
  const directArray = ownArrayValues(container);
  if (directArray) {
    const sessions = directArray.map((session) => normalizedDistanceSession(session));
    return sessions.every(Boolean) ? sessions : null;
  }
  const root = ownDataRecord(container);
  if (!root) return null;
  const directSessions = ownField(root, ['sessions']);
  if (directSessions.present) {
    const values = ownArrayValues(directSessions.value);
    if (!values) return null;
    const sessions = values.map((session) => normalizedDistanceSession(session));
    return sessions.every(Boolean) ? sessions : null;
  }
  const weeksField = ownField(root, ['weeks']);
  if (!weeksField.present) return [];
  const weeks = ownArrayValues(weeksField.value);
  if (!weeks) return null;
  const sessions = [];
  for (const week of weeks) {
    if (week === null) continue;
    const weekRecord = ownDataRecord(week);
    if (!weekRecord) return null;
    const daysField = ownField(weekRecord, ['days', 'sessions']);
    if (!daysField.present) continue;
    const days = ownArrayValues(daysField.value);
    if (!days) return null;
    for (const day of days) {
      if (day === null) continue;
      const dayRecord = ownDataRecord(day);
      if (!dayRecord) return null;
      const fallbackDateField = ownField(dayRecord, ['scheduled_local_date', 'date']);
      const daySessions = ownField(dayRecord, ['sessions']);
      if (!daySessions.present) {
        const normalized = normalizedDistanceSession(day);
        if (!normalized) return null;
        sessions.push(normalized);
        continue;
      }
      const values = ownArrayValues(daySessions.value);
      if (!values) return null;
      for (const session of values) {
        const fallbackDate = fallbackDateField.value === null
          || fallbackDateField.value === undefined
          || typeof fallbackDateField.value === 'string'
          ? fallbackDateField.value : null;
        const normalized = normalizedDistanceSession(session, fallbackDate);
        if (!normalized) return null;
        sessions.push(normalized);
      }
    }
  }
  return sessions;
}

function runningDistanceObservation(container = {}, options = {}) {
  const start = dateOnly(options.start);
  const end = dateOnly(options.end);
  const windowRequested = Object.hasOwn(options, 'start') || Object.hasOwn(options, 'end');
  if (windowRequested && (!start || !end || start > end)) {
    return { state: 'UNKNOWN', distance_m: null, reason: 'RUNNING_WINDOW_UNKNOWN' };
  }
  const sessions = normalizedRunningSessions(container);
  if (!sessions) {
    return { state: 'UNKNOWN', distance_m: null, reason: 'RUNNING_DISTANCE_MALFORMED' };
  }
  const running = [];
  for (const session of sessions) {
    if (!RUNNING_FAMILIES.has(session.family)) continue;
    if (session.distance.state === 'MISSING') continue;
    const date = dateOnly(session.date);
    if (windowRequested && !date) {
      return { state: 'UNKNOWN', distance_m: null, reason: 'RUNNING_DATE_UNKNOWN' };
    }
    if ((start && date < start) || (end && date > end)) continue;
    running.push(session);
  }
  const distances = running.map((session) => session.distance);
  if (distances.some((distance) => distance.state === 'MALFORMED')) {
    return { state: 'UNKNOWN', distance_m: null, reason: 'RUNNING_DISTANCE_MALFORMED' };
  }
  if (distances.some((distance) => distance.state !== 'KNOWN')) {
    return { state: 'UNKNOWN', distance_m: null, reason: 'RUNNING_DISTANCE_UNKNOWN' };
  }
  return {
    state: 'KNOWN',
    distance_m: round(distances.reduce((sum, distance) => sum + distance.distance_m, 0), 3),
    reason: null,
  };
}

function normalizeScope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const scopeKind = String(input.scope_kind || '').toUpperCase();
  const reasonCode = String(input.reason_code || '').toUpperCase();
  const effectiveFrom = exactLocalDate(input.effective_from_local);
  const expiresOnLocal = exactLocalDate(input.expires_on_local);
  const expiresAt = rfc3339Instant(input.expires_at);
  const reevaluateAt = rfc3339Instant(input.reevaluate_at);
  const scopeTimezone = validTimezone(input.scope_timezone || 'UTC');
  const modalities = [...new Set((Array.isArray(input.affected_modalities) ? input.affected_modalities : [])
    .map((value) => String(value || '').toLowerCase()).filter((value) => BLOCK_MODALITIES.has(value)))].sort();
  const allDecisiveEvidenceIds = evidenceRefSet(input.decisive_evidence_ids);
  const decisiveEvidenceIds = allDecisiveEvidenceIds.slice(0, 16);
  const actionRaw = String(input.action || '').toUpperCase();
  const action = actionRaw ? (SCOPE_ACTIONS.has(actionRaw) ? actionRaw : null) : null;
  const roleConflict = reasonCode === 'SCHEDULE_CONSTRAINT';
  const requirementId = roleConflict && BOUNDED_ID_PATTERN.test(String(input.requirement_id || ''))
    ? String(input.requirement_id) : null;
  const governingDecisionId = roleConflict && BOUNDED_ID_PATTERN.test(String(input.governing_decision_id || ''))
    ? String(input.governing_decision_id) : null;
  const governingDecisionHash = roleConflict ? normalizedHash(input.governing_decision_hash) : null;
  const governingConstraintRevision = roleConflict
    && /^lock:(?:0|[1-9]\d{0,9}):edit:(?:0|[1-9]\d{0,9})$/.test(String(input.governing_constraint_revision || ''))
    ? String(input.governing_constraint_revision) : null;
  const governingConstraintHash = roleConflict ? normalizedHash(input.governing_constraint_hash) : null;
  if (!['ACUTE', 'BLOCK'].includes(scopeKind) || !SCOPED_REASONS.has(reasonCode)
    || !effectiveFrom || !expiresAt || !expiresOnLocal || !reevaluateAt || !scopeTimezone || !modalities.length
    || !decisiveEvidenceIds.length || allDecisiveEvidenceIds.length > 16
    || (actionRaw && !action)
    || (roleConflict && (!requirementId || !governingDecisionId || !governingDecisionHash
      || !governingConstraintRevision || !governingConstraintHash))) return null;
  const expiresAtLocal = instantLocalDate(expiresAt, scopeTimezone);
  const reevaluateAtLocal = instantLocalDate(reevaluateAt, scopeTimezone);
  if (expiresOnLocal <= effectiveFrom
    || expiresAtLocal !== expiresOnLocal
    || !reevaluateAtLocal || reevaluateAtLocal < effectiveFrom
    || new Date(reevaluateAt).getTime() > new Date(expiresAt).getTime()) return null;
  const normalized = {
    scope_kind: scopeKind,
    reason_code: reasonCode,
    effective_from_local: effectiveFrom,
    expires_on_local: expiresOnLocal,
    expires_at: expiresAt,
    reevaluate_at: reevaluateAt,
    scope_timezone: scopeTimezone,
    affected_modalities: modalities,
    decisive_evidence_ids: decisiveEvidenceIds,
    action,
    authorizes_material_reduction: input.authorizes_material_reduction === true,
    cross_modal_ledger_hash: /^sha256:[a-f0-9]{64}$/.test(String(input.cross_modal_ledger_hash || ''))
      ? String(input.cross_modal_ledger_hash) : null,
    cross_modal_evidence_receipt_hash: /^sha256:[a-f0-9]{64}$/.test(String(input.cross_modal_evidence_receipt_hash || ''))
      ? String(input.cross_modal_evidence_receipt_hash) : null,
    measured_running_ceiling_m: finiteNonnegative(input.measured_running_ceiling_m),
    requirement_id: requirementId,
    governing_decision_id: governingDecisionId,
    governing_decision_hash: governingDecisionHash,
    governing_constraint_revision: governingConstraintRevision,
    governing_constraint_hash: governingConstraintHash,
  };
  const complete = {
    ...normalized,
    scope_hash: prefixedHash(normalized),
  };
  if (input.scope_hash && input.scope_hash !== complete.scope_hash) return null;
  return deepFreeze(complete);
}

function acuteScope({ planningDate, timezone, evidenceIds, reasonCode, modalities, action }) {
  const expiresOnLocal = addDays(planningDate, 2);
  const normalized = normalizeScope({
    scope_kind: 'ACUTE',
    reason_code: reasonCode,
    effective_from_local: planningDate,
    expires_on_local: expiresOnLocal,
    expires_at: instantForLocalNoon(expiresOnLocal, timezone),
    reevaluate_at: instantForLocalNoon(addDays(planningDate, 1), timezone),
    scope_timezone: timezone,
    affected_modalities: modalities,
    decisive_evidence_ids: evidenceIds,
    authorizes_material_reduction: false,
    action,
  });
  return normalized;
}

function blockScope({
  planningDate,
  candidateWindowEnd,
  evidenceIds,
  reasonCode,
  modalities,
  action,
  authorizesMaterialReduction,
  crossModalLedgerHash = null,
  measuredRunningCeilingM = null,
  crossModalEvidenceReceiptHash = null,
  timezone = 'UTC',
}) {
  const expiresOnLocal = addDays(candidateWindowEnd, 1);
  return normalizeScope({
    scope_kind: 'BLOCK',
    reason_code: reasonCode,
    effective_from_local: planningDate,
    expires_on_local: expiresOnLocal,
    expires_at: instantForLocalNoon(expiresOnLocal, timezone),
    reevaluate_at: instantForLocalNoon(addDays(planningDate, 1), timezone),
    scope_timezone: timezone,
    affected_modalities: modalities,
    decisive_evidence_ids: evidenceIds,
    authorizes_material_reduction: authorizesMaterialReduction === true,
    action,
    cross_modal_ledger_hash: crossModalLedgerHash,
    cross_modal_evidence_receipt_hash: crossModalEvidenceReceiptHash,
    measured_running_ceiling_m: measuredRunningCeilingM,
  });
}

function deriveScopedRecoveryState(input = {}) {
  const planningDate = dateOnly(input.planning_date_local);
  if (!planningDate) throw new Error('planning_date_local is required for recovery scope');
  const candidateWindowEnd = dateOnly(input.candidate_window_end_local) || addDays(planningDate, 6);
  const context = input.context || {};
  const timezone = validTimezone(input.timezone || context.profile?.timezone || 'UTC') || 'UTC';
  const safety = context.safety || {};
  const recovery = context.recovery || {};
  const checkin = context.checkin || {};
  const flags = new Set((Array.isArray(checkin.lifeFlags) ? checkin.lifeFlags : [])
    .map((value) => String(value || '').toLowerCase()));
  const injury = safety.activeInjury === true || safety.injuryNotesPresent === true
    || flags.has('injured');
  const illness = flags.has('sick') || flags.has('not_well');
  const rawRecovery = String(recovery.state || '').toUpperCase();
  const lowReadiness = ['LOW', 'RECOVERY'].includes(rawRecovery)
    || (finiteNonnegative(recovery.readinessScore) !== null && Number(recovery.readinessScore) < 45);
  let recoveryState = ['READY', 'NORMAL', 'CAUTION'].includes(rawRecovery) ? rawRecovery : 'UNKNOWN';
  let safetyAction = 'NORMAL';
  const scopes = [];
  const snapshotId = input.evidence_snapshot_id || prefixedHash({
    planning_date_local: planningDate,
    recovery_synced_at: recovery.syncedAt || null,
  });
  const injuryEvidenceIds = [
    safety.activeInjury === true ? `${snapshotId}:active-injury` : null,
    safety.injuryNotesPresent === true ? `${snapshotId}:injury-notes` : null,
    flags.has('injured') ? `${snapshotId}:injured-checkin` : null,
  ].filter(Boolean);
  const illnessEvidenceIds = [
    illness ? `${snapshotId}:illness-checkin` : null,
    illness && lowReadiness && recovery.syncedAt
      && (recovery.available === true || recovery.dataAvailable === true)
      ? `${snapshotId}:corroborating-recovery` : null,
  ].filter(Boolean);
  if (injury) {
    recoveryState = 'RECOVERY';
    safetyAction = 'MONITOR';
    const scope = blockScope({
      planningDate,
      candidateWindowEnd,
      timezone,
      evidenceIds: injuryEvidenceIds,
      reasonCode: 'INJURY_SCOPE',
      modalities: ['running_impact', 'lower_body_muscular'],
      action: 'MODIFY_IMPACT',
      authorizesMaterialReduction: injuryEvidenceIds.length >= 2,
    });
    if (scope) scopes.push(scope);
  } else if (illness) {
    recoveryState = 'RECOVERY';
    safetyAction = 'MONITOR';
    const corroborated = illnessEvidenceIds.length >= 2;
    const scope = corroborated ? blockScope({
      planningDate, candidateWindowEnd, timezone, evidenceIds: illnessEvidenceIds,
      reasonCode: 'ILLNESS_RECOVERY', modalities: ['running_quality', 'metabolic'],
      action: 'NO_HIGH_INTENSITY', authorizesMaterialReduction: true,
    }) : acuteScope({
      planningDate, timezone, evidenceIds: illnessEvidenceIds,
      reasonCode: 'ILLNESS_RECOVERY', modalities: ['running_quality', 'metabolic'],
      action: 'NO_HIGH_INTENSITY',
    });
    if (scope) scopes.push(scope);
  } else if (lowReadiness) {
    recoveryState = 'CAUTION';
    safetyAction = 'MONITOR';
    const scope = acuteScope({
      planningDate,
      timezone,
      evidenceIds: [snapshotId],
      reasonCode: 'RECOVERY_VOLUME_REDUCTION',
      modalities: ['running_quality', 'lower_body_intensity'],
      action: 'NO_HIGH_INTENSITY',
    });
    if (scope) scopes.push(scope);
  }
  const receipt = {
    recovery_state: recoveryState,
    safety_action: safetyAction,
    scopes,
    reason_codes: [...new Set(scopes.map((scope) => scope.reason_code))],
  };
  return deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
}

function deriveMaterialReductionScope(input = {}) {
  const planningDate = dateOnly(input.planning_date_local);
  const candidateWindowEnd = dateOnly(input.candidate_window_end_local);
  const decision = input.decision;
  const timezone = validTimezone(input.timezone || decision?.timezone || 'UTC') || 'UTC';
  if (!planningDate || !candidateWindowEnd || planningDate > candidateWindowEnd
    || !decision?.decision_id || !decision?.decision_hash) return null;
  const scopedRecovery = input.scoped_recovery_state || {};
  const existing = (Array.isArray(scopedRecovery.scopes) ? scopedRecovery.scopes : [])
    .map(normalizeScope)
    .filter((scope) => scope && scope.scope_kind === 'BLOCK'
      && scope.authorizes_material_reduction === true
      && scopeCoversCandidate(scope, {
        planning_date_local: planningDate,
        candidate_window_end_local: candidateWindowEnd,
      }));
  if (existing.length) {
    const priority = ['INJURY_SCOPE', 'ILLNESS_RECOVERY', 'RECOVERY_VOLUME_REDUCTION'];
    return existing.sort((left, right) => (
      priority.indexOf(left.reason_code) - priority.indexOf(right.reason_code)
      || left.scope_hash.localeCompare(right.scope_hash)
    ))[0];
  }
  const decisionEvidenceIds = [
    ...(decision.evidence_used || []).map((entry) => (
      typeof entry === 'string' ? entry : entry?.evidence_id ?? entry?.id
    )),
    ...(input.decision_evidence_ids || []),
    input.evidence_snapshot_id,
  ].filter(Boolean);
  if (String(decision.phase || '').toUpperCase() === 'TAPER_RACE_WEEK') {
    return blockScope({
      planningDate, candidateWindowEnd, evidenceIds: decisionEvidenceIds,
      timezone,
      reasonCode: 'TAPER_VOLUME_REDUCTION', modalities: ['running', 'running_impact'],
      action: null, authorizesMaterialReduction: true,
    });
  }
  const recent = input.recent_normal_running || {};
  const returning = String(decision.consistency_state || '').toUpperCase() === 'RETURNING'
    || String(decision.training_age_class || '').toUpperCase() === 'RETURNING'
    || String(recent.status || '').toUpperCase() === 'TRAINING_GAP';
  if (returning) {
    return blockScope({
      planningDate,
      candidateWindowEnd,
      timezone,
      evidenceIds: [
        ...(recent.evidence_ids || []),
        ...(input.load_evidence_ids || []),
        input.evidence_snapshot_id,
      ].filter(Boolean),
      reasonCode: 'TRAINING_GAP_REBUILD',
      modalities: ['running', 'running_impact'],
      action: null,
      authorizesMaterialReduction: true,
    });
  }
  const evidence = input.cross_modal_reduction_evidence;
  const measuredRunningCeilingM = finiteNonnegative(input.measured_running_ceiling_m);
  const decisionOwnerRef = evidenceRef(decision.athlete_id);
  const decisionSnapshotRef = evidenceRef(decision.evidence_snapshot_id);
  if (evidence?.valid === true
    && evidence.owner_ref === decisionOwnerRef
    && evidence.athlete_state_revision === Number(decision.athlete_state_revision)
    && evidence.evidence_snapshot_ref === decisionSnapshotRef
    && measuredRunningCeilingM !== null
    && measuredRunningCeilingM === evidence.measured_running_ceiling_m) {
    return blockScope({
      planningDate,
      candidateWindowEnd,
      timezone,
      evidenceIds: evidence.decisive_evidence_ids,
      reasonCode: 'CROSS_MODAL_FATIGUE_LIMIT',
      modalities: ['running_impact', 'lower_body_muscular'],
      action: null,
      authorizesMaterialReduction: true,
      crossModalLedgerHash: evidence.dimension_ledger.receipt_hash,
      crossModalEvidenceReceiptHash: evidence.receipt_hash,
      measuredRunningCeilingM,
    });
  }
  return null;
}

function buildCrossModalDoseLedger(input = {}) {
  const weekly = Array.isArray(input.weekly_dimension_sum) ? input.weekly_dimension_sum.map(finiteNonnegative) : [];
  const dimensions = DIMENSIONS.map((dimension, index) => {
    const supplied = input.dimensions?.[dimension] || {};
    return {
      dimension,
      weekly_sum: weekly[index] ?? null,
      status: String(supplied.status || 'INSUFFICIENT').toUpperCase(),
      confidence: String(supplied.confidence || 'INSUFFICIENT').toUpperCase(),
      normal_ceiling: finiteNonnegative(supplied.normal_ceiling),
      authorized_ceiling: finiteNonnegative(supplied.authorized_ceiling),
    };
  });
  const complete = weekly.length === DIMENSIONS.length && weekly.every((value) => value !== null)
    && dimensions.every((entry) => ['ESTABLISHED', 'PROVISIONAL'].includes(entry.status)
      && ['HIGH', 'MEDIUM', 'LOW'].includes(entry.confidence)
      && entry.normal_ceiling !== null && entry.authorized_ceiling !== null);
  const allDecisiveEvidenceIds = evidenceRefSet(input.decisive_evidence_ids);
  const decisiveEvidenceIds = allDecisiveEvidenceIds.slice(0, 16);
  const ledger = {
    valid: complete && decisiveEvidenceIds.length > 0 && allDecisiveEvidenceIds.length <= 16,
    dimensions,
    decisive_evidence_ids: decisiveEvidenceIds,
    reason_codes: complete && decisiveEvidenceIds.length > 0 && allDecisiveEvidenceIds.length <= 16
      ? [] : ['CROSS_MODAL_FATIGUE_LIMIT'],
  };
  const receipt = deepFreeze({ ...ledger, receipt_hash: prefixedHash(ledger) });
  if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > MAX_RECEIPT_BYTES) {
    return deepFreeze({
      valid: false,
      dimensions: [],
      decisive_evidence_ids: [],
      reason_codes: ['CROSS_MODAL_FATIGUE_LIMIT'],
      receipt_hash: prefixedHash({ invalid: 'CROSS_MODAL_LEDGER_OVERSIZED' }),
    });
  }
  return receipt;
}

function invalidCrossModalReductionEvidence(reasonCode) {
  const content = {
    valid: false,
    owner_ref: null,
    athlete_state_revision: null,
    evidence_snapshot_ref: null,
    evidence_revision: null,
    content_hash: null,
    measured_running_ceiling_m: null,
    decisive_evidence_ids: [],
    dimension_ledger: null,
    reason_codes: [reasonCode],
  };
  return deepFreeze({ ...content, receipt_hash: prefixedHash(content) });
}

function normalizeCrossModalReductionEvidence(input, expected = {}) {
  const envelopeKeys = [
    'schema_version', 'athlete_id', 'athlete_state_revision', 'evidence_snapshot_id',
    'evidence_revision', 'weekly_dimension_sum', 'dimensions', 'measured_running_ceiling_m',
    'decisive_evidence_ids', 'content_hash',
  ];
  const dimensionKeys = ['status', 'confidence', 'normal_ceiling', 'authorized_ceiling'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_EVIDENCE_RECEIPT_MISSING');
  }
  if (!exactOwnKeys(input, envelopeKeys) || !plainRecord(input.dimensions)) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_EVIDENCE_SHAPE_INVALID');
  }
  const suppliedDimensionKeys = Object.keys(input.dimensions).sort();
  if (suppliedDimensionKeys.length !== DIMENSIONS.length
    || suppliedDimensionKeys.some((dimension, index) => dimension !== [...DIMENSIONS].sort()[index])) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_DIMENSIONS_INCOMPLETE');
  }
  if (!DIMENSIONS.every((dimension) => exactOwnKeys(input.dimensions[dimension], dimensionKeys))
    || !Array.isArray(input.weekly_dimension_sum)
    || !input.weekly_dimension_sum.every((value) => Number.isFinite(value) && value >= 0)
    || !Array.isArray(input.decisive_evidence_ids)
    || !input.decisive_evidence_ids.every((value) => (
      typeof value === 'string' && value.length > 0 && value.length <= 512
    ))) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_EVIDENCE_SHAPE_INVALID');
  }
  if (Number(input.schema_version) !== 1) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_EVIDENCE_SCHEMA_UNSUPPORTED');
  }
  if (!expected.athlete_id || String(input.athlete_id || '') !== String(expected.athlete_id)) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_OWNER_MISMATCH');
  }
  const athleteStateRevision = Number(input.athlete_state_revision);
  if (!Number.isSafeInteger(athleteStateRevision) || athleteStateRevision < 1
    || athleteStateRevision !== Number(expected.athlete_state_revision)) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_REVISION_MISMATCH');
  }
  const snapshotRef = evidenceRef(input.evidence_snapshot_id);
  if (!snapshotRef || snapshotRef !== evidenceRef(expected.evidence_snapshot_id)) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_SNAPSHOT_MISMATCH');
  }
  const evidenceRevision = Number(input.evidence_revision);
  if (!Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_EVIDENCE_REVISION_INVALID');
  }
  if (!Array.isArray(input.weekly_dimension_sum)
    || input.weekly_dimension_sum.length !== DIMENSIONS.length) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_DIMENSIONS_INCOMPLETE');
  }
  const measuredRunningCeilingM = finiteNonnegative(input.measured_running_ceiling_m);
  if (measuredRunningCeilingM === null || measuredRunningCeilingM <= 0) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_RUNNING_CEILING_UNKNOWN');
  }
  const decisiveEvidenceIds = evidenceRefSet(input.decisive_evidence_ids);
  if (!decisiveEvidenceIds.length || decisiveEvidenceIds.length > 16) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_DECISIVE_EVIDENCE_INVALID');
  }
  const canonicalContent = {
    schema_version: 1,
    athlete_id: String(input.athlete_id),
    athlete_state_revision: athleteStateRevision,
    evidence_snapshot_id: String(input.evidence_snapshot_id),
    evidence_revision: evidenceRevision,
    weekly_dimension_sum: clone(input.weekly_dimension_sum),
    dimensions: clone(input.dimensions),
    measured_running_ceiling_m: measuredRunningCeilingM,
    decisive_evidence_ids: clone(input.decisive_evidence_ids),
  };
  const contentHash = normalizedHash(input.content_hash);
  if (!contentHash || contentHash !== prefixedHash(canonicalContent)) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_EVIDENCE_HASH_MISMATCH');
  }
  const dimensionLedger = buildCrossModalDoseLedger({
    weekly_dimension_sum: canonicalContent.weekly_dimension_sum,
    dimensions: canonicalContent.dimensions,
    decisive_evidence_ids: canonicalContent.decisive_evidence_ids,
  });
  if (!dimensionLedger.valid) {
    return invalidCrossModalReductionEvidence('CROSS_MODAL_DIMENSIONS_INCOMPLETE');
  }
  const content = {
    valid: true,
    owner_ref: evidenceRef(input.athlete_id),
    athlete_state_revision: athleteStateRevision,
    evidence_snapshot_ref: snapshotRef,
    evidence_revision: evidenceRevision,
    content_hash: contentHash,
    measured_running_ceiling_m: measuredRunningCeilingM,
    decisive_evidence_ids: dimensionLedger.decisive_evidence_ids,
    dimension_ledger: dimensionLedger,
    reason_codes: [],
  };
  const receipt = deepFreeze({ ...content, receipt_hash: prefixedHash(content) });
  return Buffer.byteLength(JSON.stringify(receipt), 'utf8') <= MAX_RECEIPT_BYTES
    ? receipt : invalidCrossModalReductionEvidence('CROSS_MODAL_EVIDENCE_RECEIPT_OVERSIZED');
}

function comparatorReceipt(source, baselineRunning, options = {}) {
  const candidateRunning = options.candidateRunning;
  const deltaMeters = round(candidateRunning - baselineRunning, 3);
  const deltaPercentage = baselineRunning > 0 ? round((deltaMeters / baselineRunning) * 100, 2) : null;
  const policy = GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running;
  return {
    source,
    baseline_running_m: round(baselineRunning, 3),
    candidate_running_m: round(candidateRunning, 3),
    delta_m: deltaMeters,
    delta_percentage: deltaPercentage,
    material_reduction: deltaMeters <= -policy.absolute_m
      && deltaPercentage !== null && deltaPercentage <= -(policy.percentage * 100),
    baseline_plan_revision: options.baselinePlanRevision ?? null,
    evidence_refs: evidenceRefs(options.evidenceIds),
  };
}

function minimumRunningDoseWithoutMaterialReduction(baselineRunningValues = []) {
  const policy = GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running;
  const boundaries = (Array.isArray(baselineRunningValues) ? baselineRunningValues : [])
    .filter((baseline) => typeof baseline === 'number' && Number.isFinite(baseline) && baseline > 0)
    .map((baseline) => Math.min(
      baseline - policy.absolute_m,
      baseline * (1 - policy.percentage),
    ))
    .filter((boundary) => Number.isFinite(boundary) && boundary >= 0);
  if (!boundaries.length) return null;
  // Material reduction uses inclusive boundaries. Candidate material is
  // expressed in whole metres, so the first unqualified whole-metre dose is
  // one metre above the strictest applicable boundary.
  return Math.floor(Math.max(...boundaries)) + 1;
}

function scopeCoversCandidate(scope, input, { requireMaterialAuthorization = true } = {}) {
  if (!scope || scope.scope_kind !== 'BLOCK'
    || (requireMaterialAuthorization && scope.authorizes_material_reduction !== true)) return false;
  const start = dateOnly(input.planning_date_local);
  const end = dateOnly(input.candidate_window_end_local);
  const expiry = scope.expires_on_local;
  return Boolean(start && end && scope.effective_from_local <= start && expiry && expiry > end);
}

function qualifyingAuthorization(scope, input, comparators) {
  if (!scopeCoversCandidate(scope, input)) return null;
  const phase = String(input.phase || '').toUpperCase();
  const age = String(input.training_age_class || '').toUpperCase();
  const consistency = String(input.consistency_state || '').toUpperCase();
  const recentStatus = String(input.recent_normal_running?.status || '').toUpperCase();
  const reasons = {
    TAPER_VOLUME_REDUCTION: phase === 'TAPER_RACE_WEEK',
    TRAINING_GAP_REBUILD: age === 'RETURNING' || consistency === 'RETURNING' || recentStatus === 'TRAINING_GAP',
    INJURY_SCOPE: scope.decisive_evidence_ids.length >= 2,
    ILLNESS_RECOVERY: scope.decisive_evidence_ids.length >= 2,
    RECOVERY_VOLUME_REDUCTION: scope.decisive_evidence_ids.length >= 2,
    CROSS_MODAL_FATIGUE_LIMIT: false,
  };
  if (scope.reason_code === 'CROSS_MODAL_FATIGUE_LIMIT') {
    const candidateLedger = input.cross_modal_ledger;
    const evidence = input.cross_modal_reduction_evidence;
    const maximumCandidate = finiteNonnegative(scope.measured_running_ceiling_m);
    reasons.CROSS_MODAL_FATIGUE_LIMIT = candidateLedger?.valid === true
      && evidence?.valid === true
      && scope.cross_modal_ledger_hash === evidence.dimension_ledger?.receipt_hash
      && scope.cross_modal_evidence_receipt_hash === evidence.receipt_hash
      && maximumCandidate !== null
      && maximumCandidate === evidence.measured_running_ceiling_m
      && finiteNonnegative(input.candidate_running_m) <= maximumCandidate
      && comparators.some((comparator) => comparator.baseline_running_m > maximumCandidate)
      && scope.decisive_evidence_ids.every((ref) => evidence.decisive_evidence_ids.includes(ref)
        && candidateLedger.decisive_evidence_ids.includes(ref));
  }
  return reasons[scope.reason_code] === true ? scope : null;
}

function evaluateMaterialDose(input = {}) {
  const window = {
    start: input.planning_date_local,
    end: input.candidate_window_end_local,
  };
  const candidateObservation = runningDistanceObservation(input.candidate || {}, window);
  const candidateRunning = candidateObservation.distance_m;
  const recent = input.recent_normal_running || {};
  const comparators = [];
  const baseWithoutComparators = {
    candidate_running_m: candidateRunning,
    comparators,
    material_threshold: clone(GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running),
    reduction_authorization: null,
  };
  if (candidateRunning === null) {
    const receipt = {
      ...baseWithoutComparators,
      valid: false,
      violations: [{
        code: 'RECENT_NORMAL_INSUFFICIENT',
        reason: candidateObservation.reason === 'RUNNING_DATE_UNKNOWN'
          ? 'CANDIDATE_RUNNING_DATE_UNKNOWN'
          : candidateObservation.reason === 'RUNNING_WINDOW_UNKNOWN'
            ? 'CANDIDATE_RUNNING_WINDOW_UNKNOWN' : 'CANDIDATE_RUNNING_DISTANCE_UNKNOWN',
      }],
      reason_codes: ['RECENT_NORMAL_INSUFFICIENT'],
    };
    return deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
  }
  const recentMedian = finiteNonnegative(
    String(recent.status || '').toUpperCase() === 'TRAINING_GAP'
      ? recent.historical_median_distance_m ?? recent.median_distance_m
      : recent.median_distance_m,
  );
  const recentConfidence = String(recent.confidence || '').toUpperCase();
  if (['ESTABLISHED', 'PROVISIONAL', 'TRAINING_GAP'].includes(String(recent.status || '').toUpperCase())
    && recentMedian !== null && recentMedian > 0 && ['HIGH', 'MEDIUM', 'LOW'].includes(recentConfidence)) {
    comparators.push(comparatorReceipt('CANONICAL_RECENT_NORMAL', recentMedian, {
      candidateRunning,
      evidenceIds: recent.evidence_ids,
    }));
  }
  const activeObservation = input.active_applied_plan
    ? runningDistanceObservation(input.active_applied_plan, window) : null;
  if (activeObservation?.state === 'UNKNOWN') {
    const receipt = {
      ...baseWithoutComparators,
      comparators,
      valid: false,
      violations: [{
        code: 'RECENT_NORMAL_INSUFFICIENT',
        reason: activeObservation.reason === 'RUNNING_DATE_UNKNOWN'
          ? 'ACTIVE_PLAN_RUNNING_DATE_UNKNOWN'
          : activeObservation.reason === 'RUNNING_WINDOW_UNKNOWN'
            ? 'ACTIVE_PLAN_RUNNING_WINDOW_UNKNOWN' : 'ACTIVE_PLAN_RUNNING_DISTANCE_UNKNOWN',
      }],
      reason_codes: ['RECENT_NORMAL_INSUFFICIENT'],
    };
    return deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
  }
  const activeRunning = activeObservation?.distance_m ?? null;
  if (activeRunning !== null && activeRunning > 0) {
    comparators.push(comparatorReceipt('ACTIVE_APPLIED_PLAN', activeRunning, {
      candidateRunning,
      baselinePlanRevision: input.active_applied_plan.plan_revision ?? input.active_applied_plan.planRevision ?? null,
    }));
  }
  const observedLowerBound = finiteNonnegative(input.observed_lower_bound_running_m);
  if (observedLowerBound !== null && observedLowerBound > 0) {
    comparators.push(comparatorReceipt('OBSERVED_LOWER_BOUND', observedLowerBound, {
      candidateRunning,
      evidenceIds: input.observed_lower_bound_evidence_ids,
    }));
  }
  comparators.sort((left, right) => left.source.localeCompare(right.source));
  const base = {
    candidate_running_m: candidateRunning,
    comparators,
    material_threshold: clone(GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running),
    reduction_authorization: null,
  };
  if (!comparators.length) {
    const beginnerFoundation = String(input.training_age_class || '').toUpperCase() === 'BEGINNER'
      && String(input.phase || '').toUpperCase() === 'FOUNDATION';
    const receipt = {
      ...base,
      valid: beginnerFoundation,
      dose_state: beginnerFoundation ? 'BOUNDED_BEGINNER_NO_COMPARATOR' : 'COMPARATOR_UNKNOWN',
      violations: beginnerFoundation ? [] : [{ code: 'RECENT_NORMAL_INSUFFICIENT', reason: 'MATERIAL_DOSE_COMPARATOR_UNKNOWN' }],
      reason_codes: ['RECENT_NORMAL_INSUFFICIENT'],
    };
    return deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
  }
  const reductions = comparators.filter((comparator) => comparator.material_reduction);
  const normalizedScope = normalizeScope(input.reduction_scope);
  const authorization = reductions.length ? qualifyingAuthorization(normalizedScope, {
    ...input,
    candidate_running_m: candidateRunning,
  }, comparators) : null;
  const valid = !reductions.length || authorization !== null;
  const violations = valid ? [] : reductions.map((comparator) => ({
    code: 'RECENT_LOAD_MAINTAIN',
    reason: 'UNSUPPORTED_MATERIAL_RUNNING_REDUCTION',
    comparator_source: comparator.source,
    baseline_running_m: comparator.baseline_running_m,
    candidate_running_m: comparator.candidate_running_m,
    delta_m: comparator.delta_m,
    delta_percentage: comparator.delta_percentage,
  }));
  const receipt = {
    ...base,
    valid,
    dose_state: reductions.length ? (valid ? 'QUALIFIED_REDUCTION' : 'UNSUPPORTED_REDUCTION') : 'WITHIN_MATERIAL_BOUND',
    reduction_authorization: authorization,
    violations,
    reason_codes: violations.length ? ['RECENT_LOAD_MAINTAIN']
      : authorization ? [authorization.reason_code] : [],
  };
  const finalReceipt = deepFreeze({ ...receipt, receipt_hash: prefixedHash(receipt) });
  if (Buffer.byteLength(JSON.stringify(finalReceipt), 'utf8') > MAX_RECEIPT_BYTES) {
    return deepFreeze({
      valid: false,
      candidate_running_m: candidateRunning,
      comparators: [],
      reduction_authorization: null,
      violations: [{ code: 'RECENT_LOAD_MAINTAIN', reason: 'MATERIAL_DOSE_RECEIPT_OVERSIZED' }],
      reason_codes: ['RECENT_LOAD_MAINTAIN'],
      receipt_hash: prefixedHash({ invalid: 'MATERIAL_DOSE_RECEIPT_OVERSIZED' }),
    });
  }
  return finalReceipt;
}

function buildDevelopmentRoleBinding(decision = {}) {
  if (!BOUNDED_ID_PATTERN.test(String(decision.decision_id || ''))) return null;
  const decisionHash = normalizedHash(decision.decision_hash);
  if (!decisionHash) return null;
  const lockRevision = Math.max(0, Number(decision.lock_revision || 0));
  const editRevision = Math.max(0, Number(decision.edit_revision || 0));
  if (!Number.isSafeInteger(lockRevision) || !Number.isSafeInteger(editRevision)) return null;
  const constraintContent = {
    lock_revision: lockRevision,
    edit_revision: editRevision,
    constraint_fingerprint: decision.constraint_fingerprint || null,
    athlete_locks: clone(decision.athlete_locks || []),
    manual_edits: clone(decision.manual_edits || []),
  };
  return deepFreeze({
    decision_id: String(decision.decision_id),
    decision_hash: decisionHash,
    constraint_revision: `lock:${lockRevision}:edit:${editRevision}`,
    constraint_hash: prefixedHash(constraintContent),
  });
}

function validDevelopmentRoleConflict(rawConflict, requirementId, binding) {
  if (!rawConflict || !binding || !rawConflict.scope_hash) return false;
  const normalized = normalizeScope(rawConflict);
  return Boolean(normalized
    && normalized.reason_code === 'SCHEDULE_CONSTRAINT'
    && normalized.requirement_id === requirementId
    && normalized.governing_decision_id === binding.decision_id
    && normalized.governing_decision_hash === binding.decision_hash
    && normalized.governing_constraint_revision === binding.constraint_revision
    && normalized.governing_constraint_hash === binding.constraint_hash);
}

function validateDevelopmentRoleDose(candidate = {}, options = {}) {
  const requirements = Array.isArray(options.development_role_requirements)
    ? options.development_role_requirements : [];
  if (!requirements.length) {
    return {
      validator: 'development_roles', valid: true, violations: [], role_evaluations: [], reason_codes: [],
    };
  }
  const sessions = sessionsFrom(candidate);
  const conflicts = new Map();
  for (const conflict of Array.isArray(options.development_role_conflicts)
    ? options.development_role_conflicts : []) {
    const requirementId = String(conflict?.requirement_id || '');
    if (!conflicts.has(requirementId)) conflicts.set(requirementId, []);
    conflicts.get(requirementId).push(conflict);
  }
  const binding = options.development_role_binding || null;
  const violations = [];
  const roleEvaluations = [];
  for (const requirement of requirements) {
    const matched = sessions.filter((session) => (requirement.any_of || []).includes(sessionFamily(session))
      && (!requirement.minimum_role || sessionRole(session) === requirement.minimum_role));
    let meaningful = matched.length > 0;
    let presentationFloorMin = null;
    let presentationFloorSource = null;
    if (meaningful && requirement.presentation_floor_required === true) {
      const ordinary = finiteNonnegative(options.median_ordinary_easy_duration_min);
      presentationFloorMin = ordinary === null ? 30 : Math.max(30, round(ordinary * 1.5, 2));
      presentationFloorSource = ordinary === null
        ? 'POLICY_MINIMUM_NO_ORDINARY_EASY_EVIDENCE'
        : 'OBSERVED_ORDINARY_EASY_MEDIAN';
      meaningful = matched.some((session) => {
        const duration = finiteNonnegative(session.duration_min ?? session.duration_minutes);
        return duration !== null && duration >= presentationFloorMin;
      });
    }
    roleEvaluations.push({
      requirement_id: String(requirement.requirement_id || ''),
      matched_session_ids: matched.map((session, index) => String(
        session.session_id ?? session.id ?? `${requirement.requirement_id}-${index + 1}`
      )).sort(),
      meaningful,
      presentation_floor_min: presentationFloorMin,
      presentation_floor_source: presentationFloorSource,
    });
    if (meaningful) continue;
    const requirementId = String(requirement.requirement_id || '');
    const roleConflicts = conflicts.get(requirementId) || [];
    if (roleConflicts.length === 1
      && validDevelopmentRoleConflict(roleConflicts[0], requirementId, binding)) {
      const normalizedConflict = normalizeScope(roleConflicts[0]);
      if (scopeCoversCandidate(normalizedConflict, options, {
        requireMaterialAuthorization: false,
      })) continue;
    }
    violations.push({
      code: 'REQUIRED_EXPOSURE_UNPLACEABLE',
      reason: matched.length ? 'REQUIRED_ROLE_BELOW_PRESENTATION_FLOOR' : 'REQUIRED_DEVELOPMENT_ROLE_MISSING',
      requirement_id: requirement.requirement_id,
    });
  }
  return {
    validator: 'development_roles',
    valid: violations.length === 0,
    violations,
    role_evaluations: roleEvaluations,
    reason_codes: violations.length ? ['REQUIRED_EXPOSURE_UNPLACEABLE'] : [],
  };
}

module.exports = {
  DIMENSIONS,
  MAX_RECEIPT_BYTES,
  buildDevelopmentRoleBinding,
  buildCrossModalDoseLedger,
  deriveMaterialReductionScope,
  deriveScopedRecoveryState,
  evaluateMaterialDose,
  minimumRunningDoseWithoutMaterialReduction,
  normalizeCrossModalReductionEvidence,
  normalizeScope,
  ownDataJsonSnapshot,
  ownDataRaceRemovalImpact,
  runningDistanceObservation,
  validateDevelopmentRoleDose,
};
