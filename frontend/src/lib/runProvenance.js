function text(value, maxLength) {
  if (value === undefined || value === null) return null
  const normalized = String(value).replace(/[\r\n]+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function number(value, minimum, maximum) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

function textList(value) {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, 20)
    .map((item) => text(typeof item === 'string' ? item : item?.description || item?.label, 240))
    .filter(Boolean)
}

export function buildPlannedSessionSnapshot({ planSessionId, scheduledRun, workoutTarget, date } = {}) {
  const session = scheduledRun && typeof scheduledRun === 'object' ? scheduledRun : {}
  const prescription = session.prescription && typeof session.prescription === 'object' ? session.prescription : {}
  const target = workoutTarget && typeof workoutTarget === 'object' ? workoutTarget : {}
  const snapshot = {
    schemaVersion: 1,
    sessionId: text(planSessionId || session.id, 160),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(session.date || date || '')) ? String(session.date || date) : null,
    title: text(session.title || session.typeLabel, 120),
    type: text(session.type || session.rawType || prescription.type, 40),
    workoutType: text(session.workout_type || prescription.workout_type, 40),
    prescriptionBasis: text(target.prescriptionBasis || session.prescriptionBasis || prescription.prescription_basis, 30),
    distanceMiles: number(target.distanceMiles ?? session.distanceMiles ?? session.distance_miles ?? prescription.distance_miles, 0, 500),
    durationMinutes: number(target.durationMinutes ?? session.durationMinutes ?? session.duration_min ?? prescription.duration_min, 0, 1440),
    paceTarget: text(target.pace || session.pace || session.pace_target || prescription.pace_target, 100),
    targetZone: text(target.zone || session.zone || session.targetZone || session.target_zone || prescription.target_zone, 40),
    intensity: text(session.intensity || prescription.intensity, 80),
    warmup: textList(session.warmup || prescription.warmup),
    steps: textList(session.steps || session.structure || prescription.steps),
    cooldown: textList(session.cooldown || prescription.cooldown),
  }
  return Object.entries(snapshot).some(([key, value]) => (
    key !== 'schemaVersion'
    && value !== null
    && value !== undefined
    && (!Array.isArray(value) || value.length > 0)
  )) ? snapshot : null
}

export default { buildPlannedSessionSnapshot }
