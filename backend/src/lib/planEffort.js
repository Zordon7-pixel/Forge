// Plan-session effort annotation backed by the existing calibrated HR profile.

const { zoneForHr } = require('./hrZones');
const { resolveHrZone } = require('./dailyExecution');
const planSchema = require('./planSchema');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function hasDate(session = {}) {
  return ISO_DATE.test(String(session.date || session.scheduled_date || session.scheduledDate || ''));
}

function firstFiniteBpm(session = {}) {
  const prescription = session.prescription && typeof session.prescription === 'object'
    ? session.prescription
    : {};
  for (const value of [
    session.target_bpm,
    session.targetBpm,
    session.average_target_bpm,
    prescription.target_bpm,
    prescription.targetBpm,
  ]) {
    const bpm = Number(value);
    if (Number.isFinite(bpm) && bpm > 0) return bpm;
  }
  return null;
}

function crudeZoneLabel(session = {}) {
  const prescription = session.prescription && typeof session.prescription === 'object'
    ? session.prescription
    : {};
  const prescribed = session.target_zone
    ?? session.targetZone
    ?? session.zone
    ?? prescription.target_zone
    ?? prescription.targetZone
    ?? prescription.zone;
  if (prescribed !== null && prescribed !== undefined && String(prescribed).trim()) return prescribed;

  return inferredZoneLabel(session);
}

function inferredZoneLabel(session = {}) {
  const prescription = session.prescription && typeof session.prescription === 'object'
    ? session.prescription
    : {};
  const description = [
    session.type,
    session.workout_type,
    session.title,
    session.intensity,
    session.description,
    prescription.type,
    prescription.workout_type,
    prescription.title,
    prescription.intensity,
    prescription.description,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/recovery|shakeout/.test(description)) return 'Zone 1-2';
  if (/race|vo2|maximum|speed/.test(description)) return 'Zone 4-5';
  if (/threshold|tempo|interval|quality|hill|hard/.test(description)) return 'Zone 3-4';
  if (/steady|moderate|progression/.test(description)) return 'Zone 2-3';
  return 'Zone 2';
}

function crudeEffortLabel(session = {}, calibratedLabel) {
  const prescription = session.prescription && typeof session.prescription === 'object'
    ? session.prescription
    : {};
  return session.effortLabel
    || session.intensity
    || session.pace_target
    || session.paceTarget
    || prescription.effortLabel
    || prescription.intensity
    || prescription.pace_target
    || prescription.paceTarget
    || calibratedLabel
    || session.type
    || prescription.type
    || 'Run';
}

function resolveSessionZone(session, userHrProfile) {
  const targetBpm = firstFiniteBpm(session);
  const zoneFromBpm = targetBpm === null ? null : zoneForHr(targetBpm, userHrProfile);
  const prescribed = resolveHrZone(zoneFromBpm || crudeZoneLabel(session), userHrProfile);
  return prescribed || resolveHrZone(inferredZoneLabel(session), userHrProfile);
}

function annotatePlanEffort(planSessions, userHrProfile) {
  if (!Array.isArray(planSessions)) return [];
  const hasCalibratedProfile = Boolean(resolveHrZone('Zone 1', userHrProfile));

  return planSessions.map((session) => {
    const copy = session && typeof session === 'object' ? { ...session } : session;
    if (!copy || typeof copy !== 'object' || !hasCalibratedProfile) return copy;
    if (!hasDate(copy) || planSchema.kindFromSession(copy) !== 'run') return copy;

    const resolved = resolveSessionZone(copy, userHrProfile);
    if (!resolved) return copy;
    return {
      ...copy,
      targetZone: resolved.zoneLabel,
      targetBpmRange: {
        minBpm: resolved.minBpm,
        maxBpm: resolved.maxBpm,
      },
      effortLabel: crudeEffortLabel(copy, resolved.label),
    };
  });
}

module.exports = { annotatePlanEffort };
