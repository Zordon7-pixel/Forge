// Explicit server-prescription intent. Not a stress classifier, dose authority,
// completion receipt, or inference from names/fastest steps.
const { canonicalHash, canonicalStringify } = require('./racePlanPolicy');
const VERSION = 'canonical-workout-intent-v1';
const PURPOSES = new Set(['recovery_run', 'easy_run', 'long_aerobic', 'steady_run',
  'threshold_run', 'interval_run', 'race_rhythm_run', 'race']);
const ROLES = new Set(['WORK', 'WARMUP', 'RECOVERY', 'COOLDOWN', 'MOBILITY', 'MANUAL_INSTRUCTION', 'ACCESSORY']);
const plain = v => v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const keys = (v, allowed) => plain(v) && Object.keys(v).every(k => allowed.includes(k));
function leaves(steps, output = [], depth = 0) {
  if (!Array.isArray(steps) || depth > 8 || steps.length > 64) throw Error('SEMANTICS_GRAPH_BOUNDS');
  for (const s of steps) {
    if (s?.type === 'repeat') leaves(s.children, output, depth + 1);
    else output.push(s);
    if (output.length > 64) throw Error('SEMANTICS_GRAPH_BOUNDS');
  }
  return output;
}
function binding(session) {
  const refs = session.objective_ids || [];
  const ids = a => Array.isArray(a) && a.length <= 64 && new Set(a).size === a.length
    && a.every(id => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 512);
  if (!ids(refs)) throw Error('SEMANTICS_OBJECTIVE_BINDING_INVALID');
  const evidence = [...new Set(leaves(session.steps).flatMap(s => (s.provenance || [])
    .flatMap(p => p.source_evidence_ids || [])))].sort();
  if (!ids(evidence)) throw Error('SEMANTICS_EVIDENCE_BINDING_INVALID');
  return { authority: 'SERVER_STRUCTURED_PRESCRIPTION', decision_id: session.decision_id,
    objective_ids: [...(session.objective_ids || [])], source_evidence_ids: evidence,
    prescribed_steps_hash: canonicalHash(session.steps) };
}
function validateWorkoutSemantics(session) {
  const intent = session.workout_semantics;
  if (intent === undefined) return [];
  const bad = reason => [{ code: 'CANONICAL_SCHEMA_INVALID', path: 'workout_semantics', reason }];
  try {
    if (!keys(intent, ['version', 'primary_purpose', 'primary_step_ids', 'accessories', 'source'])
      || intent.version !== VERSION || !PURPOSES.has(intent.primary_purpose)
      || intent.primary_purpose !== session.workout_family
      || !Array.isArray(intent.primary_step_ids) || !intent.primary_step_ids.length || intent.primary_step_ids.length > 64
      || !Array.isArray(intent.accessories) || intent.accessories.length > 64
      || canonicalStringify(intent.source) !== canonicalStringify(binding(session))) return bad('SEMANTICS_SOURCE_OR_PURPOSE_INVALID');
    const graph = leaves(session.steps), byId = new Map(graph.map(s => [s.step_id, s]));
    const used = new Set();
    const accept = (ids, role) => Array.isArray(ids) && ids.length > 0 && ids.length <= 64 && ids.every(id => {
      const s = byId.get(id);
      if (typeof id !== 'string' || !s || used.has(id) || !['run', 'interval'].includes(s.type)
        || s.step_role !== role || s.workout_family !== intent.primary_purpose) return false;
      used.add(id); return true;
    });
    if (!accept(intent.primary_step_ids, 'WORK')) return bad('SEMANTICS_PRIMARY_REFS_INVALID');
    for (const accessory of intent.accessories) {
      if (!keys(accessory, ['kind', 'step_ids', 'source_ref']) || accessory.kind !== 'CADENCE_TECHNIQUE'
        || typeof accessory.source_ref !== 'string' || !accessory.source_ref || accessory.source_ref.length > 512
        || !accept(accessory.step_ids, 'ACCESSORY')
        || accessory.step_ids.some(id => !byId.get(id).target?.cadence_range_spm
          || !(byId.get(id).provenance || []).some(p => (p.source_evidence_ids || []).includes(accessory.source_ref)))) {
        return bad('SEMANTICS_ACCESSORY_REFS_INVALID');
      }
    }
    if (graph.some(s => ['run', 'interval'].includes(s.type) && !used.has(s.step_id))) return bad('SEMANTICS_WORK_COVERAGE_INCOMPLETE');
    return [];
  } catch { return bad('SEMANTICS_GRAPH_OR_BINDING_INVALID'); }
}
// Only server-owned materializers call this; request payloads are not an intent
// authority. The enclosing accepted canonical/artifact chain authenticates it.
function buildWorkoutSemantics(session, accessories = []) {
  if (!PURPOSES.has(session.workout_family)) return undefined;
  const graph = leaves(session.steps);
  const primary = graph.filter(s => ['run', 'interval'].includes(s.type) && s.step_role === 'WORK').map(s => s.step_id);
  if (!primary.length) return undefined;
  const intent = { version: VERSION, primary_purpose: session.workout_family,
    primary_step_ids: primary, accessories: JSON.parse(JSON.stringify(accessories)), source: binding(session) };
  const errors = validateWorkoutSemantics({ ...session, workout_semantics: intent });
  if (errors.length) throw Object.assign(Error(errors[0].reason), { code: 'CANONICAL_INTENT_UNAVAILABLE' });
  return intent;
}
function hasAccessory(steps) { return leaves(steps).some(s => s.step_role === 'ACCESSORY'); }
// A cadence target does not establish accessory intent. It does establish a
// prescription that the current target-regenerating reconstruction would lose.
function requiresLosslessReconstruction(steps) {
  return leaves(steps).some(s => s.step_role === 'ACCESSORY' || s.target?.cadence_range_spm !== undefined);
}
function validateStepRole(step) {
  if (step.step_role === undefined) return true;
  if (!ROLES.has(step.step_role)) return false;
  const type = { WARMUP: 'warmup', RECOVERY: 'recovery', COOLDOWN: 'cooldown', MOBILITY: 'mobility', MANUAL_INSTRUCTION: 'manual_instruction' }[step.step_role];
  if (type) return step.type === type;
  return step.step_role === 'ACCESSORY' ? ['run', 'interval'].includes(step.type)
    : ['run', 'interval', 'station', 'strength_exercise'].includes(step.type);
}
module.exports = { VERSION, ROLES, buildWorkoutSemantics, validateWorkoutSemantics, validateStepRole, hasAccessory, requiresLosslessReconstruction };
