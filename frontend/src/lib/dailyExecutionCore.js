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
      mode: null,
      phase: null,
      week: null,
      goal: null,
      orderGuidance: null,
      status: null,
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
    mode: exec.mode || null,
    phase: exec.phase !== undefined ? exec.phase : null,
    week: exec.week !== undefined ? exec.week : null,
    goal: exec.goal || null,
    orderGuidance: exec.orderGuidance || null,
    status: exec.status || null,
    date: exec.date || null,
    day: exec.day || null,
    sessions,
    run,
    lift,
    legacyToday: (body && body.today) || null,
  };
}

// True when there is an executable scheduled session today (run or lift that is
// not a rest day). Home uses this to prefer the calendar over the legacy
// next-recommendation fallback. A rest day is never executable.
export function hasExecutableSession(execution) {
  if (!execution || !execution.hasDay || execution.isRest) return false;
  return Boolean(execution.run || execution.lift);
}

// Human-readable HR-zone string, or the plain plan zone label when the user has
// no calibrated profile. NEVER fabricates a bpm range.
export function formatHrZone(session) {
  if (!session) return null;
  const hz = session.hrZone;
  if (hz && Number.isFinite(hz.minBpm) && Number.isFinite(hz.maxBpm)) {
    return `Zone ${hz.zone} · ${hz.minBpm}-${hz.maxBpm} bpm`;
  }
  if (session.target_zone) {
    const n = String(session.target_zone).replace(/[^0-9]/g, '');
    return n ? `Zone ${n}` : `Zone ${session.target_zone}`;
  }
  return null;
}

// Build the idempotent completion request body for PUT /plans/my/progress.
// Ownership is enforced server-side by req.user.id scoping.
export function completionBody(sessionId, currentWeek) {
  const body = { completed_session_id: sessionId };
  if (Number.isFinite(Number(currentWeek))) body.current_week = Number(currentWeek);
  return body;
}

// The scheduled run session for today, or null when there is no executable
// calendar run (rest day, lift-only day, or no plan). Never fabricates a run.
export function scheduledRunFromExecution(execution) {
  return hasExecutableSession(execution) && execution.run ? execution.run : null;
}

// The scheduled lift session for today, or null when there is no executable
// calendar lift. Never fabricates a lift.
export function scheduledLiftFromExecution(execution) {
  return hasExecutableSession(execution) && execution.lift ? execution.lift : null;
}

// Map today's executable calendar session into the `recommendation` shape the
// Home coach/detail surfaces already consume. Returns null when there is no
// executable session so callers fall back to the legacy next-recommendation.
// A run is preferred over a lift for the run-centric coach card.
export function recommendationFromExecution(execution) {
  if (!hasExecutableSession(execution)) return null;
  const run = execution.run || null;
  if (run) {
    const type = run.type || run.workout_type || 'run';
    const dist = Number(run.distance_miles || run.distance || 0);
    return {
      recommendationType: run.type || run.workout_type || 'run',
      type,
      suggestedDistance: dist || undefined,
      suggestedPace: run.pace_target || run.pace || run.target_pace || undefined,
      targetZone: run.target_zone || (run.hrZone ? `Zone ${run.hrZone.zone}` : '') || '',
      intensity: run.intensity || '',
      progression: run.progression || '',
      structure: Array.isArray(run.structure) ? run.structure : [],
      reason: run.description || run.notes || '',
      planSessionId: run.id || null,
      source: 'calendar',
    };
  }
  const lift = execution.lift || null;
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

// Read the plan session id back out of an incoming navigation state so warmup /
// active handoffs keep the canonical scheduled session. Returns a String id or
// null.
export function planSessionIdFromState(state) {
  if (!state || typeof state !== 'object') return null;
  const id = state.planSessionId || (state.scheduledRun && state.scheduledRun.id) || null;
  return id != null ? String(id) : null;
}

// Read the plan week back out of an incoming navigation state. Returns a finite
// Number or null.
export function currentWeekFromState(state) {
  if (!state || typeof state !== 'object') return null;
  const n = Number(state.currentWeek);
  return Number.isFinite(n) ? n : null;
}
