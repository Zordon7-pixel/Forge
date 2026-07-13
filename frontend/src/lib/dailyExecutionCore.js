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
