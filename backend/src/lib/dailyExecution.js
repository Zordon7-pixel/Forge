// Forged Hybrid H5 — Unified Daily Execution.
//
// Pure helpers that turn an active plan + a phone-local date into ONE canonical
// daily-execution object consumed by Home, Run, Lift, and Plan. This replaces
// the four divergent per-surface parsers with a single source of truth.
//
// Rules baked in here:
//   - Select the EXACT dated schema-v2 day; only fall back to legacy weekday
//     matching for undated (legacy) plans. Never return the first weekday match
//     across all weeks.
//   - Expose ALL run/lift sessions with their stable IDs and full prescriptions;
//     do not flatten a hybrid day toward one primary session.
//   - Resolve a run's plan Zone label to the user's calibrated BPM range via
//     computeZones. Never mutate the stored plan and never invent BPM when the
//     HR profile cannot produce a range.
//   - No AI calls. Deterministic and DB-free (callers pass in the data).

const { computeZones } = require('./hrZones');
const planSchema = require('./planSchema');
const { repairPlanPrescriptions } = require('./prescriptionIntegrity');

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayShortForDate(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return null;
  const d = new Date(`${dateISO}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAY_SHORT[d.getDay()];
}

// Parse a plan-prescribed zone label into an integer 1-5. Accepts number,
// "Z2", "Zone 2", "zone2", "2". Returns null when there is no clear zone.
function zoneNumbersFromLabel(val) {
  if (val === null || val === undefined) return [];
  if (typeof val === 'number') return val >= 1 && val <= 5 ? [Math.trunc(val)] : [];
  const s = String(val).trim();
  if (!s) return [];
  const match = s.match(/^(?:zone|z)?\s*([1-5])(?:\s*[-–]\s*(?:zone|z)?\s*([1-5]))?$/i);
  if (!match) return [];
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function zoneNumberFromLabel(val) {
  return zoneNumbersFromLabel(val)[0] || null;
}

// Resolve a plan zone label to the user's calibrated BPM band. Returns null
// (never a fabricated band) when the profile cannot produce a valid range.
function resolveHrZone(targetZone, hrProfile) {
  const zoneNumbers = zoneNumbersFromLabel(targetZone);
  if (!zoneNumbers.length || !hrProfile) return null;
  const model = hrProfile.zone_model;
  if (!['hrr', 'maxhr', 'lthr', 'custom'].includes(model)) return null;
  const result = computeZones({
    maxHr: hrProfile.max_hr,
    restingHr: hrProfile.resting_hr,
    lthr: hrProfile.lthr,
    model,
    customMinimums: hrProfile.custom_zones_json,
  });
  const zones = Array.isArray(result && result.zones) ? result.zones : [];
  const selected = zoneNumbers.map((zone) => zones.find((entry) => entry.zone === zone));
  if (selected.some((zone) => !zone || !Number.isFinite(zone.minBpm) || !Number.isFinite(zone.maxBpm))) return null;
  const first = selected[0];
  const last = selected[selected.length - 1];
  const zoneLabel = zoneNumbers.length === 1
    ? `Zone ${zoneNumbers[0]}`
    : `Zone ${zoneNumbers[0]}-${zoneNumbers[zoneNumbers.length - 1]}`;
  return {
    zone: zoneNumbers.length === 1 ? zoneNumbers[0] : `${zoneNumbers[0]}-${zoneNumbers[zoneNumbers.length - 1]}`,
    zones: zoneNumbers,
    zoneLabel,
    label: zoneNumbers.length === 1 ? first.label : `${first.label} to ${last.label}`,
    minBpm: first.minBpm,
    maxBpm: last.maxBpm,
    openEnded: Boolean(last.openEnded),
    model,
    source: 'calibrated',
  };
}

// Collect the stable session identifiers accepted by plan-progress updates.
// Uses the same identifier rules as compliance/calendar rendering for both
// schema-v2 and legacy plans, so clients cannot add arbitrary JSON entries.
function collectSessionIds(plan) {
  const ids = new Set();
  const weeks = Array.isArray(plan && plan.weeks) ? plan.weeks : [];
  for (const week of weeks) {
    const days = planSchema.getDayEntries(week);
    days.forEach((day, dayIndex) => {
      if (Array.isArray(day && day.sessions)) {
        day.sessions.forEach((session, sessionIndex) => {
          if (planSchema.kindFromSession(session) === 'rest') return;
          ids.add(planSchema.sessionIdentifier(day, session, sessionIndex, dayIndex));
        });
        return;
      }
      if (!planSchema.isRestEntry(day)) {
        ids.add(planSchema.sessionIdentifier(day, day, 0, dayIndex));
      }
    });
  }
  return ids;
}

// Select the plan day for a given date.
//   1. Exact schema-v2 dated day (authoritative).
//   2. Legacy weekday match among UNDATED days only (byte-compatible fallback).
// Returns { entry, week, weekIndex, dayIndex } or null.
function selectDayForDate(plan, dateISO, weekdayShort) {
  if (!plan || !Array.isArray(plan.weeks)) return null;
  const wanted = String(dateISO || '');
  for (let weekIndex = 0; weekIndex < plan.weeks.length; weekIndex += 1) {
    const week = plan.weeks[weekIndex];
    const days = planSchema.getDayEntries(week);
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      const entry = days[dayIndex];
      if (entry && entry.date === wanted) return { entry, week, weekIndex, dayIndex };
    }
  }
  const dow = weekdayShort || weekdayShortForDate(dateISO);
  if (dow) {
    for (let weekIndex = 0; weekIndex < plan.weeks.length; weekIndex += 1) {
      const week = plan.weeks[weekIndex];
      const days = planSchema.getDayEntries(week);
      for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
        const entry = days[dayIndex];
        if (entry && !entry.date && entry.day === dow) return { entry, week, weekIndex, dayIndex };
      }
    }
  }
  return null;
}

function parseCheckinOverridePatch(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Shared resolution contract for canonical /plans/today and any internal
// consumer that needs today's training truth. Repair stored prescriptions
// first, select the exact dated day, then apply the persisted check-in patch.
function resolvePlanDayForDate({ plan, dateISO, patch = null } = {}) {
  const repairedPlan = repairPlanPrescriptions(plan);
  const weekdayShort = weekdayShortForDate(dateISO);
  const selection = selectDayForDate(repairedPlan, dateISO, weekdayShort);
  const baseEntry = selection?.entry || null;
  const selectedEntry = baseEntry && patch
    ? planSchema.applyOverrideToDay(baseEntry, patch)
    : baseEntry;
  return {
    plan: repairedPlan,
    dateISO,
    weekdayShort,
    patch,
    baseEntry,
    selectedEntry,
    selectedWeek: selection?.week || null,
    selectedDayIndex: Number.isInteger(selection?.dayIndex) ? selection.dayIndex : null,
    weekIndex: Number.isInteger(selection?.weekIndex) ? selection.weekIndex : null,
  };
}

function trainingContextFromResolvedDay(resolved, dateISO = null) {
  if (!resolved?.selectedEntry) return null;
  const sessions = planSchema.daySessions(resolved.selectedEntry);
  const plan = resolved.plan || {};
  const strengthPolicy = plan.strengthPolicy || plan.strength_policy || {};
  return {
    date: dateISO || resolved.dateISO || null,
    week: Number(resolved.selectedWeek?.week || (Number.isInteger(resolved.weekIndex) ? resolved.weekIndex + 1 : 0)) || null,
    phase: resolved.selectedWeek?.phase || null,
    orderGuidance: resolved.selectedEntry.orderGuidance || null,
    isRest: sessions.length === 0,
    checkinOverride: resolved.patch?.checkin_override || resolved.selectedEntry.checkin_override || null,
    availableEquipment: Array.isArray(strengthPolicy.equipment) ? strengthPolicy.equipment : null,
    run: sessions.find((session) => session.kind === 'run') || null,
    lift: sessions.find((session) => session.kind === 'lift') || null,
  };
}

// Build the canonical daily-execution object. Callers supply the already
// override-merged day entry, its week, the user's completed session ids, and
// the HR profile row (or null). Everything here is pure.
function buildDailyExecution(opts) {
  const {
    plan,
    dateISO,
    weekdayShort,
    selectedEntry,
    selectedWeek,
    selectedDayIndex,
    completedSessionIds,
    hrProfile,
  } = opts || {};

  const dow = weekdayShort || weekdayShortForDate(dateISO);
  const completed = new Set((Array.isArray(completedSessionIds) ? completedSessionIds : []).map(String));

  if (!plan || !Array.isArray(plan.weeks)) {
    return { hasPlan: false, hasDay: false, date: dateISO || null, isRest: false, sessions: [], run: null, lift: null };
  }

  const mode = planSchema.getPlanMode(plan);
  const goal = plan.goal && typeof plan.goal === 'object' ? plan.goal : null;

  if (!selectedEntry) {
    return { hasPlan: true, hasDay: false, date: dateISO || null, day: dow, mode, goal, isRest: false, sessions: [], run: null, lift: null };
  }

  const sourceSessions = Array.isArray(selectedEntry.sessions)
    ? selectedEntry.sessions
      .map((source, sourceIndex) => ({ source, sourceIndex }))
      .filter(({ source }) => planSchema.kindFromSession(source) !== 'rest')
    : [{ source: selectedEntry, sourceIndex: 0 }];
  const sessions = planSchema.daySessions(selectedEntry).map((session, sessionIndex) => {
    const source = sourceSessions[sessionIndex] || { source: session, sourceIndex: sessionIndex };
    const id = String(session.id || planSchema.sessionIdentifier(
      selectedEntry,
      source.source,
      source.sourceIndex,
      Number.isInteger(selectedDayIndex) ? selectedDayIndex : 0
    ));
    const out = Object.assign({}, session, id ? { id } : {}, { completed: id ? completed.has(id) : false });
    if (session.kind === 'run') {
      out.hrZone = resolveHrZone(session.target_zone, hrProfile);
    }
    return out;
  });

  const run = sessions.find((s) => s.kind === 'run') || null;
  const lift = sessions.find((s) => s.kind === 'lift') || null;

  return {
    hasPlan: true,
    hasDay: true,
    date: selectedEntry.date || dateISO || null,
    day: selectedEntry.day || dow,
    mode,
    phase: selectedWeek ? selectedWeek.phase : undefined,
    week: selectedWeek ? selectedWeek.week : undefined,
    goal,
    orderGuidance: selectedEntry.orderGuidance,
    status: selectedEntry.status,
    isRest: sessions.length === 0,
    sessions,
    run,
    lift,
  };
}

module.exports = {
  weekdayShortForDate,
  zoneNumbersFromLabel,
  zoneNumberFromLabel,
  resolveHrZone,
  collectSessionIds,
  selectDayForDate,
  parseCheckinOverridePatch,
  resolvePlanDayForDate,
  trainingContextFromResolvedDay,
  buildDailyExecution,
};
