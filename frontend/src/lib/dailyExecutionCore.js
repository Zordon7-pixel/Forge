// Forged Hybrid H5 — pure daily-execution helpers (frontend, dependency-free).
//
// These are the shared normalizers Home, Run, Lift, and Plan use so there is
// ONE parser of GET /plans/today instead of four. Kept free of the axios `api`
// client and the offline queue so they can be unit-tested framework-free in
// test/dailyExecution.smoke.mjs. The thin api/queue wrappers live in
// dailyExecution.js and re-export everything here.

const SURFACE_MANIFEST_SCHEMA = 'goal_backward_surface_manifest_v1';
const SURFACE_MISMATCH = 'SURFACE_REVISION_MISMATCH';
const SURFACE_MODES = new Set(['preview', 'on']);
const SURFACE_ROLES = new Set(['PRIMARY_KEY', 'SUPPORTING', 'RECOVERY', 'REST', 'ASSESSMENT']);
const SURFACE_CAPABILITIES = new Set([
  'FULLY_STRUCTURED',
  'PARTIALLY_STRUCTURED',
  'MANUAL_COMPONENTS_REQUIRED',
  'NOT_EXPORTABLE',
]);
const SURFACE_EXECUTABILITY = new Set(['EXECUTABLE', 'RESTRICTED', 'NOT_EXECUTABLE']);
const EXACT_SESSION_FIELDS = Object.freeze([
  'session_id',
  'session_revision',
  'plan_id',
  'plan_revision',
  'decision_id',
  'role',
  'steps',
  'target_provenance',
  'purpose_reason_codes',
  'adjustment_criteria',
  'stop_criteria',
  'safety_scope',
  'executability',
  'capability',
  'content_hash',
]);

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function planPayload(plan) {
  const source = objectValue(plan) || {};
  return objectValue(source.plan_data) || objectValue(source.planData)
    || objectValue(source.plan_json) || source;
}

function normalizedHash(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
}

function hashMatches(left, right) {
  const a = normalizedHash(left);
  const b = normalizedHash(right);
  return /^[a-f0-9]{64}$/.test(a) && a === b;
}

function validHash(value) {
  return /^[a-f0-9]{64}$/.test(normalizedHash(value));
}

function sameValue(left, right, seen = new WeakMap()) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;

  const prior = seen.get(left);
  if (prior) return prior === right;
  seen.set(left, right);

  try {
    if (Array.isArray(left)) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        const leftDescriptor = Object.getOwnPropertyDescriptor(left, String(index));
        const rightDescriptor = Object.getOwnPropertyDescriptor(right, String(index));
        if (!leftDescriptor || !rightDescriptor
          || !Object.hasOwn(leftDescriptor, 'value') || !Object.hasOwn(rightDescriptor, 'value')
          || !sameValue(leftDescriptor.value, rightDescriptor.value, seen)) return false;
      }
      return true;
    }

    const leftDescriptors = Object.getOwnPropertyDescriptors(left);
    const rightDescriptors = Object.getOwnPropertyDescriptors(right);
    const enumerableKeys = (descriptors) => Object.keys(descriptors)
      .filter((key) => descriptors[key]?.enumerable)
      .sort();
    const leftKeys = enumerableKeys(leftDescriptors);
    const rightKeys = enumerableKeys(rightDescriptors);
    if (leftKeys.length !== rightKeys.length
      || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    return leftKeys.every((key) => {
      const leftDescriptor = leftDescriptors[key];
      const rightDescriptor = rightDescriptors[key];
      return Object.hasOwn(leftDescriptor, 'value')
        && Object.hasOwn(rightDescriptor, 'value')
        && sameValue(leftDescriptor.value, rightDescriptor.value, seen);
    });
  } catch (_error) {
    return false;
  }
}

function sessionId(session) {
  const value = session?.session_id ?? session?.id;
  return value === null || value === undefined ? '' : String(value);
}

function planSessions(plan) {
  const data = planPayload(plan);
  return (Array.isArray(data.weeks) ? data.weeks : []).flatMap((week) => {
    const entries = Array.isArray(week?.days) ? week.days : Array.isArray(week?.sessions) ? week.sessions : [];
    return entries.flatMap((entry) => Array.isArray(entry?.sessions) ? entry.sessions : [entry]);
  }).filter((session) => session && typeof session === 'object' && sessionId(session));
}

function planWeekPresentations(plan) {
  const data = planPayload(plan);
  return (Array.isArray(data.weeks) ? data.weeks : []).map((week, index) => ({
    week: Math.max(1, Number(week?.week || index + 1)),
    start_date: String(week?.startDate || week?.start_date || ''),
    phase: String(week?.phase || ''),
    purpose: String(week?.purpose || week?.weekPurpose || week?.week_purpose || ''),
  }));
}

function canonicalSessionShapeValid(session, identity) {
  if (!objectValue(session) || !sessionId(session)) return false;
  if (!Number.isInteger(Number(session.session_revision)) || Number(session.session_revision) < 1) return false;
  if (!Number.isInteger(Number(session.plan_revision)) || Number(session.plan_revision) < 1) return false;
  if (String(session.plan_id || '') !== String(identity.plan_id || '')) return false;
  if (Number(session.plan_revision) !== Number(identity.plan_revision)) return false;
  if (String(session.decision_id || '') !== String(identity.decision_id || '')) return false;
  if (!SURFACE_ROLES.has(String(session.role || ''))) return false;
  if (!Array.isArray(session.steps) || !Array.isArray(session.target_provenance)) return false;
  if (!Array.isArray(session.purpose_reason_codes)
    || !Array.isArray(session.adjustment_criteria)
    || !Array.isArray(session.stop_criteria)
    || !Array.isArray(session.safety_scope)) return false;
  if (!SURFACE_EXECUTABILITY.has(String(session.executability || ''))) return false;
  if (!objectValue(session.capability)
    || !SURFACE_CAPABILITIES.has(String(session.capability.classification || ''))) return false;
  return /^[a-f0-9]{64}$/.test(normalizedHash(session.content_hash));
}

function sessionsExactlyMatch(expectedSessions, suppliedSessions) {
  const expected = new Map(expectedSessions.map((session) => [sessionId(session), session]));
  const supplied = new Map(suppliedSessions.map((session) => [sessionId(session), session]));
  if (expected.size !== expectedSessions.length || supplied.size !== suppliedSessions.length
    || expected.size !== supplied.size) return false;
  for (const [id, canonical] of expected.entries()) {
    const candidate = supplied.get(id);
    if (!candidate) return false;
    if (EXACT_SESSION_FIELDS.some((field) => !sameValue(candidate[field], canonical[field]))) return false;
  }
  return true;
}

function blockedSurface(manifest = null) {
  return {
    status: 'blocked',
    reasonCodes: [SURFACE_MISMATCH],
    identity: objectValue(manifest?.identity),
    manifest,
    sessionsById: new Map(),
  };
}

// Validate the one server-issued surface contract before any UI, calendar, or
// workout-start adapter consumes it. Legacy plans intentionally take the old
// path. An enabled v2.4 manifest with any identity/revision/hash/session drift
// is blocked as a unit; consumers never fall back to the legacy prescription.
export function validateSurfaceManifest({ plan = null, userPlan = null, manifest = null, execution = null } = {}) {
  if (!manifest) {
    const data = plan ? planPayload(plan) : null;
    if (data && (Number(data.canonical_workout_schema_version) === 1
      || data.canonical_session_set_hash || data.selected_candidate_hash)) {
      return blockedSurface(null);
    }
    return { status: 'legacy', reasonCodes: [], identity: null, manifest: null, sessionsById: new Map() };
  }
  if (manifest.v24_surface_enabled !== true || !SURFACE_MODES.has(String(manifest.feature_mode || ''))) {
    return manifest.v24_surface_enabled === false
      ? { status: 'legacy', reasonCodes: [], identity: null, manifest: null, sessionsById: new Map() }
      : blockedSurface(manifest);
  }
  const identity = objectValue(manifest.identity);
  const sessions = Array.isArray(manifest.sessions) ? manifest.sessions : [];
  if (manifest.schema_version !== SURFACE_MANIFEST_SCHEMA
    || manifest.status !== 'accepted'
    || !Number.isInteger(Number(manifest.surface_revision))
    || Number(manifest.surface_revision) < 1
    || !identity
    || !String(identity.decision_id || '')
    || !String(identity.candidate_id || '')
    || !String(identity.plan_id || '')
    || !Number.isInteger(Number(identity.candidate_revision))
    || Number(identity.candidate_revision) < 1
    || !Number.isInteger(Number(identity.plan_revision))
    || Number(identity.plan_revision) < 1
    || !validHash(identity.decision_hash)
    || !validHash(identity.candidate_hash)
    || !validHash(identity.canonical_session_set_hash)
    || !validHash(identity.safety_state_hash)
    || !Number.isInteger(Number(identity.athlete_state_revision))
    || Number(identity.athlete_state_revision) < 1
    || !objectValue(identity.goal_revisions)
    || !objectValue(manifest.feasibility)
    || !Array.isArray(manifest.feasibility.reason_codes)
    || !objectValue(manifest.safety)
    || !Array.isArray(manifest.safety.scope)
    || !Array.isArray(manifest.safety.reason_codes)
    || !Array.isArray(manifest.weeks)
    || manifest.weeks.some((week) => !objectValue(week)
      || !Number.isInteger(Number(week.week)) || Number(week.week) < 1)
    || sessions.length < 1
    || sessions.some((session) => !canonicalSessionShapeValid(session, identity))) {
    return blockedSurface(manifest);
  }

  if (plan) {
    const data = planPayload(plan);
    const expectedWeeks = planWeekPresentations(plan);
    const expectedPurpose = String(data.purpose || expectedWeeks.find((week) => week.purpose)?.purpose || '').trim();
    const identityMatchesPlan = String(data.plan_id || '') === String(identity.plan_id)
      && Number(data.plan_revision) === Number(identity.plan_revision)
      && String(data.decision_id || '') === String(identity.decision_id)
      && hashMatches(data.decision_hash, identity.decision_hash)
      && String(data.selected_candidate_id || '') === String(identity.candidate_id)
      && hashMatches(data.selected_candidate_hash, identity.candidate_hash)
      && hashMatches(data.canonical_session_set_hash, identity.canonical_session_set_hash);
    const assignmentRevisionMatches = !userPlan || userPlan.plan_version === undefined
      || Number(userPlan.plan_version) === Number(identity.plan_revision);
    const presentationMatches = String(manifest.purpose || '') === expectedPurpose
      && String(manifest.feasibility?.status || '') === String(data.overall_feasibility || '')
      && sameValue(manifest.feasibility?.reason_codes || [], data.reasons || [])
      && sameValue(manifest.weeks, expectedWeeks);
    if (!identityMatchesPlan || !assignmentRevisionMatches || !presentationMatches
      || !sessionsExactlyMatch(sessions, planSessions(plan))) {
      return blockedSurface(manifest);
    }
  }

  if (execution) {
    const supplied = Array.isArray(execution.sessions) ? execution.sessions : [];
    const expectedForDate = sessions.filter((session) => (
      !execution.date || String(session.scheduled_local_date || '') === String(execution.date)
    )).filter((session) => !['rest', 'mobility', 'manual_recovery'].includes(String(session.workout_family || '')));
    if (!sessionsExactlyMatch(expectedForDate, supplied)) return blockedSurface(manifest);
  }

  return {
    status: 'accepted',
    reasonCodes: [],
    identity,
    manifest,
    sessionsById: new Map(sessions.map((session) => [sessionId(session), session])),
  };
}

function canonicalKind(session) {
  const family = String(session?.workout_family || '').toLowerCase();
  if (family === 'rest' || family === 'mobility' || family === 'manual_recovery') return 'rest';
  if (family.startsWith('strength_')) return 'lift';
  if (family.startsWith('hyrox_')) return 'hyrox';
  return 'run';
}

function executionSession(canonical, runtime) {
  const source = canonical || runtime || {};
  return {
    ...source,
    id: sessionId(source),
    kind: source.kind || canonicalKind(source),
    ...(runtime?.completed === true ? { completed: true } : {}),
    ...(runtime?.status ? { status: runtime.status } : {}),
    ...(runtime?.hrZone ? { hrZone: runtime.hrZone } : {}),
  };
}

// Phone-local YYYY-MM-DD (never UTC-shifted).
export function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Normalize a raw /plans/today response body into ONE canonical shape.
// Always returns a stable object; never throws on missing/partial data.
export function normalizeExecution(body) {
  const exec = body && typeof body === 'object' ? body.execution : null;
  const surface = validateSurfaceManifest({
    plan: body?.plan || null,
    userPlan: body?.user_plan || null,
    manifest: body?.surface_manifest || null,
    execution: exec,
  });
  if (!exec || typeof exec !== 'object') {
    return {
      hasPlan: false,
      hasDay: false,
      isRest: false,
      isPlannedRest: false,
      restSource: null,
      mode: null,
      phase: null,
      week: null,
      goal: null,
      orderGuidance: null,
      status: null,
      type: null,
      workoutType: null,
      checkinOverride: null,
      date: (exec && exec.date) || null,
      day: null,
      sessions: [],
      run: null,
      lift: null,
      legacyToday: (body && body.today) || null,
      surface,
    };
  }
  if (surface.status === 'blocked') {
    return {
      hasPlan: exec.hasPlan === true,
      hasDay: exec.hasDay === true,
      isRest: exec.isRest === true,
      mode: exec.mode || null,
      phase: exec.phase !== undefined ? exec.phase : null,
      week: exec.week !== undefined ? exec.week : null,
      goal: exec.goal || null,
      orderGuidance: exec.orderGuidance || null,
      status: exec.status || null,
      date: exec.date || null,
      day: exec.day || null,
      sessions: [],
      run: null,
      lift: null,
      legacyToday: (body && body.today) || null,
      surface,
    };
  }
  const rawSessions = Array.isArray(exec.sessions) ? exec.sessions : [];
  const sessions = surface.status === 'accepted'
    ? rawSessions.map((runtime) => executionSession(surface.sessionsById.get(sessionId(runtime)), runtime))
    : rawSessions;
  const run = exec.run || sessions.find((s) => s && s.kind === 'run') || null;
  const lift = exec.lift || sessions.find((s) => s && s.kind === 'lift') || null;
  const acceptedRun = surface.status === 'accepted' && run
    ? executionSession(surface.sessionsById.get(sessionId(run)), run)
    : run;
  const acceptedLift = surface.status === 'accepted' && lift
    ? executionSession(surface.sessionsById.get(sessionId(lift)), lift)
    : lift;
  const hasExecutableSibling = [acceptedRun, acceptedLift, ...sessions].some((session) => (
    isExecutableSession(session) && !isRestSession(session)
  ));
  return {
    hasPlan: exec.hasPlan === true,
    hasDay: exec.hasDay === true,
    isRest: exec.isRest === true,
    isPlannedRest: exec.isPlannedRest === true || exec.restSource === 'planned',
    restSource: exec.restSource === 'planned' || exec.restSource === 'removed' ? exec.restSource : null,
    mode: exec.mode || null,
    phase: exec.phase !== undefined ? exec.phase : null,
    week: exec.week !== undefined ? exec.week : null,
    goal: exec.goal || null,
    orderGuidance: exec.orderGuidance || null,
    status: exec.status || null,
    type: exec.type || (body && body.today && body.today.type) || null,
    workoutType: exec.workoutType || exec.workout_type || (body && body.today && body.today.workout_type) || null,
    checkinOverride: exec.checkinOverride || exec.checkin_override || (body && body.today && body.today.checkin_override) || null,
    recoveryGuidance: !hasExecutableSibling
      && exec.recoveryGuidance
      && typeof exec.recoveryGuidance === 'object'
      ? exec.recoveryGuidance
      : null,
    date: exec.date || null,
    day: exec.day || null,
    sessions,
    run: acceptedRun,
    lift: acceptedLift,
    legacyToday: (body && body.today) || null,
    surface,
  };
}

function isPendingSession(session) {
  return Boolean(session) && session.completed !== true;
}

function isExecutableSession(session) {
  return isPendingSession(session)
    && (!session.executability || session.executability === 'EXECUTABLE');
}

// A check-in safety override keeps the original calendar slot/id so the plan
// remains auditable, but changes the session prescription to `rest`. That
// recovery guidance must never remain executable just because the retained
// slot still has kind="run" (or kind="lift").
export function isRestSession(session) {
  if (!session || typeof session !== 'object') return false;
  return [
    session.type,
    session.workout_type,
    session.prescription?.type,
    session.prescription?.workout_type,
  ].some((value) => String(value || '').trim().toLowerCase() === 'rest');
}

function recoveryGuidanceSession(execution) {
  if (!execution || typeof execution !== 'object') return null;
  if (execution.restSource === 'removed') return null;
  const candidates = [
    execution.recoveryGuidance,
    execution.run,
    execution.lift,
    ...(Array.isArray(execution.sessions) ? execution.sessions : []),
  ];
  const session = candidates.find(isRestSession);
  if (session) return session;

  const normalized = (value) => String(value || '').trim().toLowerCase();
  const checkinOverride = execution.checkinOverride || execution.checkin_override || null;
  if (normalized(checkinOverride?.action) !== 'rest') return null;
  return {
    type: 'rest',
    workout_type: 'rest',
    description: checkinOverride?.label
      || execution.legacyToday?.description
      || "Recovery is today's guidance.",
  };
}

// A current-day execution response is the safety authority for workout entry
// points. A check-in rest override may deliberately retain the original
// session id/kind for auditability, so consumers must inspect both session and
// day-level guidance before exposing any start/export action.
export function isRestExecutionAuthority(execution) {
  return Boolean(
    execution
    && execution.hasPlan === true
    && execution.hasDay === true
    && (
      execution.isPlannedRest === true
      || execution.restSource === 'planned'
      || recoveryGuidanceSession(execution)
    ),
  );
}

function executionCandidates(execution) {
  return [
    execution?.run,
    execution?.lift,
    ...(Array.isArray(execution?.sessions) ? execution.sessions : []),
  ];
}

// Recognition and execution are deliberately separate. Completed sessions
// remain canonical and reviewable (including reversible completion), while
// only unfinished sessions may expose start/export actions.
export function executionHasSession(execution, session, expectedKind = null) {
  if (!execution || execution.hasPlan !== true || execution.hasDay !== true) return false;
  if (execution.surface?.status === 'blocked'
    || isRestExecutionAuthority(execution)
    || !session
    || typeof session !== 'object') return false;
  const id = String(session.id ?? '').trim();
  const kind = String(expectedKind || session.kind || '').trim().toLowerCase();
  if (!id || !kind) return false;
  return executionCandidates(execution).some((candidate) => (
    candidate
    && String(candidate.id ?? '').trim() === id
    && String(candidate.kind || '').trim().toLowerCase() === kind
    && !isRestSession(candidate)
  ));
}

// Fail closed for current-day actions unless the exact unfinished session is
// still present in canonical GET /plans/today output. Future-day previews are
// handled by the caller and intentionally do not use this today-only gate.
export function executionAllowsSession(execution, session, expectedKind = null) {
  if (!executionHasSession(execution, session, expectedKind)) return false;
  const id = String(session.id ?? '').trim();
  const kind = String(expectedKind || session.kind || '').trim().toLowerCase();
  return executionCandidates(execution).some((candidate) => (
    candidate
    && String(candidate.id ?? '').trim() === id
    && String(candidate.kind || '').trim().toLowerCase() === kind
    && isExecutableSession(candidate)
    && !isRestSession(candidate)
  ));
}

// True when there is an unfinished scheduled session today. Completed sessions
// remain reviewable, but they must never reopen from Today's primary action.
export function hasExecutableSession(execution) {
  if (execution?.surface?.status === 'blocked') return false;
  if (!execution || !execution.hasDay || isRestExecutionAuthority(execution)) return false;
  return isExecutableSession(execution.run) || isExecutableSession(execution.lift);
}

// Human-readable HR-zone string, or the plain plan zone label when the user has
// no calibrated profile. NEVER fabricates a bpm range.
export function formatHrZone(session) {
  if (!session) return null;
  const hz = session.hrZone;
  if (hz && Number.isFinite(hz.minBpm) && Number.isFinite(hz.maxBpm)) {
    const range = hz.openEnded ? `${hz.minBpm}+` : `${hz.minBpm}-${hz.maxBpm}`;
    return `${hz.zoneLabel || `Zone ${hz.zone}`} · ${range} bpm`;
  }
  if (session.target_zone) {
    const raw = String(session.target_zone).trim();
    if (/^z\s*[1-5](?:\s*[-–]\s*[1-5])?$/i.test(raw)) return raw.replace(/^z/i, 'Zone ');
    return raw;
  }
  return null;
}

// Build the idempotent completion request body for PUT /plans/my/progress.
// Ownership is enforced server-side by req.user.id scoping.
export function completionBody(sessionId, currentWeek) {
  const body = { completed_session_id: sessionId };
  const week = Number(currentWeek);
  if (currentWeek !== null && currentWeek !== undefined && currentWeek !== '' && Number.isInteger(week) && week >= 1) {
    body.current_week = week;
  }
  return body;
}

// The scheduled run session for today, or null when there is no executable
// calendar run (rest day, lift-only day, or no plan). Never fabricates a run.
export function scheduledRunFromExecution(execution) {
  return hasExecutableSession(execution) && isExecutableSession(execution.run) ? execution.run : null;
}

// The scheduled lift session for today, or null when there is no executable
// calendar lift. Never fabricates a lift.
export function scheduledLiftFromExecution(execution) {
  return hasExecutableSession(execution) && isExecutableSession(execution.lift) ? execution.lift : null;
}

// Map today's executable calendar session into the `recommendation` shape the
// Home coach/detail surfaces already consume. An active calendar rest day is
// explicit so callers do not replace it with an unrelated legacy suggestion.
// A run is preferred over a lift for the run-centric coach card.
export function recommendationFromExecution(execution) {
  if (!execution || !execution.hasPlan || !execution.hasDay) return null;
  const recovery = recoveryGuidanceSession(execution);
  if (recovery) {
    const policyReason = recovery.recovery_alternative
      ? [recovery.title, recovery.description].filter(Boolean).join('. ')
      : recovery.description || recovery.notes || "Recovery is today's guidance."
    return {
      recommendationType: 'rest',
      type: 'rest',
      reason: policyReason,
      structure: [],
      planSessionId: recovery.id || null,
      source: 'calendar',
    };
  }
  if (execution.isRest && execution.isPlannedRest) {
    return {
      recommendationType: 'rest',
      type: 'rest',
      reason: 'Rest and recovery are scheduled today.',
      structure: [],
      source: 'calendar',
    };
  }
  if (execution.isRest) return null;
  if (!hasExecutableSession(execution)) return null;
  const run = scheduledRunFromExecution(execution);
  if (run) {
    const type = run.type || run.workout_type || 'run';
    const dist = Number(run.distance_miles || run.distance || 0);
    const durationMinutes = Number(run.duration_min || run.durationMinutes || run.duration_minutes || 0) || 0;
    return {
      recommendationType: run.type || run.workout_type || 'run',
      type,
      suggestedDistance: dist || undefined,
      durationMinutes: durationMinutes || undefined,
      durationIsEstimated: run.durationIsEstimated === true || run.duration_is_estimate === true,
      suggestedPace: run.pace_target || run.pace || run.target_pace || undefined,
      targetZone: run.hrZone?.zoneLabel || run.target_zone || (run.hrZone ? `Zone ${run.hrZone.zone}` : '') || '',
      intensity: run.intensity || '',
      progression: run.progression || '',
      structure: Array.isArray(run.structure) ? run.structure : Array.isArray(run.steps) ? run.steps : [],
      reason: run.description || run.notes || '',
      planSessionId: run.id || null,
      source: 'calendar',
    };
  }
  const lift = scheduledLiftFromExecution(execution);
  return {
    recommendationType: 'strength',
    type: 'strength',
    planSessionId: lift ? lift.id || null : null,
    reason: lift ? lift.description || lift.notes || '' : '',
    structure: [],
    source: 'calendar',
  };
}

// Build the navigation state the run flow (LogRun → Warmup → ActiveRun) carries
// so the scheduled run + its plan session id survive every hop. Null when there
// is no executable scheduled run.
export function runRouteState(execution) {
  const run = scheduledRunFromExecution(execution);
  if (!run) return null;
  return {
    planSessionId: run.id || null,
    currentWeek: execution && execution.week != null ? execution.week : null,
    scheduledRun: run,
    prescription: {
      type: run.type || run.workout_type || 'run',
      distanceMiles: Number(run.distance_miles || run.distance || 0) || null,
      pace: run.pace_target || run.pace || run.target_pace || null,
      zone: run.target_zone || null,
      hrZone: run.hrZone || null,
    },
  };
}

// Build an explicitly ad-hoc run handoff. The null plan identifiers are
// intentional: an extra run must never complete or rewrite a scheduled day.
export function unplannedRunRouteState({
  countdown = 3,
  runType = 'easy',
  surface = 'road',
  mapMyRun = true,
} = {}) {
  const safeCountdown = Number(countdown);
  const safeRunType = typeof runType === 'string' && runType.trim() ? runType.trim() : 'easy';
  const safeSurface = ['road', 'track', 'trail', 'other'].includes(surface) ? surface : 'road';
  return {
    source: 'unplanned',
    planSessionId: null,
    currentWeek: null,
    scheduledRun: null,
    countdown: Number.isInteger(safeCountdown) && safeCountdown >= 0 && safeCountdown <= 10 ? safeCountdown : 3,
    runType: safeRunType,
    runEnvironment: 'outdoor',
    surface: safeSurface,
    mapMyRun: mapMyRun !== false,
    trackMode: safeSurface === 'track',
    startAfterWarmup: true,
    workoutTarget: null,
  };
}

// Build a make-up handoff from the owner-scoped /plans/compliance response.
// Unlike an extra run, this intentionally preserves the missed session ID so
// the saved activity completes that exact calendar prescription.
export function makeupRunRouteState(missedSession, {
  countdown = 3,
  environment = 'outdoor',
  surface = 'road',
  treadmillBrand = null,
} = {}) {
  const missed = missedSession && typeof missedSession === 'object' ? missedSession : {};
  const raw = missed.raw && typeof missed.raw === 'object' ? missed.raw : {};
  const sessionId = missed.sessionId ?? raw.id;
  if (sessionId === null || sessionId === undefined || String(sessionId).trim() === '') return null;
  const scheduledRun = {
    ...raw,
    id: String(sessionId),
    kind: 'run',
    original_date: missed.date || raw.date || null,
  };
  const distanceMiles = Number(raw.distance_miles ?? raw.distance ?? missed.distance ?? 0) || null;
  const pace = raw.pace_target || raw.pace || raw.target_pace || null;
  const zone = raw.target_zone || raw.zone || null;
  const isIndoor = environment === 'indoor';
  const safeCountdown = Number(countdown);
  const safeSurface = isIndoor
    ? 'treadmill'
    : ['road', 'track', 'trail', 'other'].includes(surface) ? surface : 'road';
  return {
    source: 'makeup',
    planSessionId: String(sessionId),
    currentWeek: null,
    scheduledRun,
    countdown: Number.isInteger(safeCountdown) && safeCountdown >= 0 && safeCountdown <= 10 ? safeCountdown : 3,
    runType: raw.type || raw.workout_type || 'run',
    runEnvironment: isIndoor ? 'indoor' : 'outdoor',
    surface: safeSurface,
    mapMyRun: !isIndoor,
    trackMode: safeSurface === 'track',
    treadmillBrand: isIndoor && treadmillBrand ? String(treadmillBrand) : null,
    startAfterWarmup: true,
    workoutTarget: { distanceMiles, pace, zone },
  };
}

// Read the plan session id back out of an incoming navigation state so warmup /
// active handoffs keep the canonical scheduled session. Returns a String id or
// null.
export function planSessionIdFromState(state) {
  if (!state || typeof state !== 'object') return null;
  if (state.source === 'group_run') return null;
  if (Object.prototype.hasOwnProperty.call(state, 'planSessionId')) {
    const explicitId = state.planSessionId;
    return explicitId !== null && explicitId !== undefined && explicitId !== '' ? String(explicitId) : null;
  }
  const id = (state.scheduledRun && state.scheduledRun.id) || null;
  return id != null ? String(id) : null;
}

// Read the plan week back out of an incoming navigation state. Returns a finite
// Number or null.
export function currentWeekFromState(state) {
  if (!state || typeof state !== 'object') return null;
  if (state.currentWeek === null || state.currentWeek === undefined || state.currentWeek === '') return null;
  const n = Number(state.currentWeek);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Completion retries belong in the offline queue only for network/server
// failures. A 4xx response is deterministic and would otherwise become a
// permanently stuck queue item.
export function isRetryableCompletionFailure(error) {
  const status = Number(error?.response?.status || 0);
  return !Number.isFinite(status) || status === 0 || status >= 500;
}
