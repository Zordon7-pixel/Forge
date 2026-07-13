const RECOVERY_MARKER = /(recovery|zone\s*1(?:\s*-\s*2)?|fully conversational)/i;
const HARD_WORK_MARKER = /(hill|interval|repeat|threshold|sprint|tempo|race pace|zone\s*[3-5]|hard(?:\s+but)?|comfortably steady|steady effort|moderate\s+(?:effort|pace|run(?:ning)?|intensity))/i;

const SAFE_RECOVERY = Object.freeze({
  type: 'recovery',
  workout_type: 'recovery',
  title: 'Recovery run',
  target_zone: 'Zone 1-2',
  pace_target: 'Fully conversational; walking is allowed',
  intensity: 'Recovery',
  warmup: ['5 min easy walking', 'Begin running only when your stride feels relaxed'],
  steps: ['Stay in Zone 1-2', 'Keep breathing relaxed', 'Stop if soreness changes your stride'],
  cooldown: ['5 min easy walking', 'Hydrate and refuel'],
  progression: 'Do not add pace or distance today.',
});

function stringValues(value) {
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return value === null || value === undefined ? [] : [String(value)];
}

function isRunSession(session = {}) {
  const marker = [session.kind, session.type, session.workout_type].filter(Boolean).join(' ');
  return !/(lift|strength|rest|cross)/i.test(marker);
}

function isRecoveryRun(session = {}) {
  if (!isRunSession(session)) return false;
  const nested = session.prescription && typeof session.prescription === 'object' ? session.prescription : {};
  return RECOVERY_MARKER.test([
    session.title,
    session.type,
    session.workout_type,
    session.target_zone,
    session.intensity,
    session.pace_target,
    nested.title,
    nested.type,
    nested.workout_type,
    nested.target_zone,
    nested.intensity,
    nested.pace_target,
  ].filter(Boolean).join(' '));
}

function hasConflictingHardWork(session = {}) {
  const nested = session.prescription && typeof session.prescription === 'object' ? session.prescription : {};
  return HARD_WORK_MARKER.test(stringValues([
    session.warmup,
    session.steps,
    session.blocks,
    session.structure,
    session.cooldown,
    session.pace_target,
    session.intensity,
    session.progression,
    nested.warmup,
    nested.steps,
    nested.blocks,
    nested.structure,
    nested.cooldown,
    nested.pace_target,
    nested.intensity,
    nested.progression,
  ]).join(' '));
}

function repairRecoverySession(session = {}) {
  if (!isRecoveryRun(session) || !hasConflictingHardWork(session)) return session;
  const next = {
    ...session,
    ...SAFE_RECOVERY,
    prescriptionIntegrityAdjusted: true,
  };
  if (session.prescription && typeof session.prescription === 'object') {
    next.prescription = {
      ...session.prescription,
      ...SAFE_RECOVERY,
      prescriptionIntegrityAdjusted: true,
    };
  }
  return next;
}

function repairSessionList(sessions) {
  if (!Array.isArray(sessions)) return sessions;
  return sessions.map((session) => repairRecoverySession(session));
}

function repairPlanPrescriptions(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.weeks)) return plan;
  let changed = false;
  const weeks = plan.weeks.map((week) => {
    let nextWeek = week;
    if (Array.isArray(week?.sessions)) {
      const sessions = repairSessionList(week.sessions);
      if (sessions.some((session, index) => session !== week.sessions[index])) {
        nextWeek = { ...nextWeek, sessions };
        changed = true;
      }
    }
    if (Array.isArray(week?.days)) {
      const days = week.days.map((day) => {
        if (Array.isArray(day?.sessions)) {
          const sessions = repairSessionList(day.sessions);
          if (sessions.some((session, index) => session !== day.sessions[index])) {
            changed = true;
            return { ...day, sessions };
          }
          return day;
        }
        const repaired = repairRecoverySession(day);
        if (repaired !== day) changed = true;
        return repaired;
      });
      if (days.some((day, index) => day !== week.days[index])) nextWeek = { ...nextWeek, days };
    }
    return nextWeek;
  });
  return changed ? { ...plan, weeks, prescriptionIntegrityAdjusted: true } : plan;
}

module.exports = {
  SAFE_RECOVERY,
  hasConflictingHardWork,
  isRecoveryRun,
  repairRecoverySession,
  repairPlanPrescriptions,
};
