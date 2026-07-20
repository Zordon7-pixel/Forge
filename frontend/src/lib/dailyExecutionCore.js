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
  return hasExecutableSession(execution) && execution.run ? execution.run : null;
}

// The scheduled lift session for today, or null when there is no executable
// calendar lift. Never fabricates a lift.
export function scheduledLiftFromExecution(execution) {
  return hasExecutableSession(execution) && execution.lift ? execution.lift : null;
}

// Map today's executable calendar session into the `recommendation` shape the
// Home coach/detail surfaces already consume. An active calendar rest day is
// explicit so callers do not replace it with an unrelated legacy suggestion.
// A run is preferred over a lift for the run-centric coach card.
export function recommendationFromExecution(execution) {
  if (!execution || !execution.hasPlan || !execution.hasDay) return null;
  if (execution.isRest) {
    return {
      recommendationType: 'rest',
      type: 'rest',
      reason: 'Rest and recovery are scheduled today.',
      structure: [],
      source: 'calendar',
    };
  }
  if (!hasExecutableSession(execution)) return null;
  const run = execution.run || null;
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
