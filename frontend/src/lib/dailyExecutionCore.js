// Forged Hybrid H5 — pure daily-execution helpers (frontend, dependency-free).
//
// These are the shared normalizers Home, Run, Lift, and Plan use so there is
// ONE parser of GET /plans/today instead of four. Kept free of the axios `api`
// client and the offline queue so they can be unit-tested framework-free in
// test/dailyExecution.smoke.mjs. The thin api/queue wrappers live in
// dailyExecution.js and re-export everything here.

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
    };
  }
  const sessions = Array.isArray(exec.sessions) ? exec.sessions : [];
  const run = exec.run || sessions.find((s) => s && s.kind === 'run') || null;
  const lift = exec.lift || sessions.find((s) => s && s.kind === 'lift') || null;
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
    date: exec.date || null,
    day: exec.day || null,
    sessions,
    run,
    lift,
    legacyToday: (body && body.today) || null,
  };
}

function isPendingSession(session) {
  return Boolean(session) && session.completed !== true;
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
  const candidates = [
    execution.run,
    execution.lift,
    ...(Array.isArray(execution.sessions) ? execution.sessions : []),
  ];
  const session = candidates.find(isRestSession);
  if (session) return session;

  const normalized = (value) => String(value || '').trim().toLowerCase();
  const checkinOverride = execution.checkinOverride || execution.checkin_override || null;
  const hasDayLevelRest = normalized(checkinOverride?.action) === 'rest'
    || normalized(execution.type) === 'rest'
    || normalized(execution.workoutType || execution.workout_type) === 'rest';
  if (!hasDayLevelRest) return null;
  return {
    type: 'rest',
    workout_type: 'rest',
    description: checkinOverride?.label
      || execution.legacyToday?.description
      || "Recovery is today's guidance.",
  };
}

// True when there is an unfinished scheduled session today. Completed sessions
// remain reviewable, but they must never reopen from Today's primary action.
export function hasExecutableSession(execution) {
  if (!execution || !execution.hasDay || execution.isRest || recoveryGuidanceSession(execution)) return false;
  return isPendingSession(execution.run) || isPendingSession(execution.lift);
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
  return hasExecutableSession(execution) && isPendingSession(execution.run) ? execution.run : null;
}

// The scheduled lift session for today, or null when there is no executable
// calendar lift. Never fabricates a lift.
export function scheduledLiftFromExecution(execution) {
  return hasExecutableSession(execution) && isPendingSession(execution.lift) ? execution.lift : null;
}

// Map today's executable calendar session into the `recommendation` shape the
// Home coach/detail surfaces already consume. An active calendar rest day is
// explicit so callers do not replace it with an unrelated legacy suggestion.
// A run is preferred over a lift for the run-centric coach card.
export function recommendationFromExecution(execution) {
  if (!execution || !execution.hasPlan || !execution.hasDay) return null;
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
  const recovery = recoveryGuidanceSession(execution);
  if (recovery) {
    return {
      recommendationType: 'rest',
      type: 'rest',
      reason: recovery.description || recovery.notes || "Recovery is today's guidance.",
      structure: [],
      planSessionId: recovery.id || null,
      source: 'calendar',
    };
  }
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
