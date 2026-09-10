const { canonicalHash } = require('./racePlanPolicy');
const { VERSION: DOSE_VERSION, canonicalStrengthExercise, EXERCISES_BY_ID } = require('./strengthDoseAccounting');
const VERSION = 'distributed-weekly-strength-v1';
const KEYS = ['distribution_policy_version','dose_accounting_version','source_template_id','source_template_version',
  'source_template_content_hash','group_id','focus','partition_index','partition_count','original_exercises',
  'allocations','conserved_weekly_sets','allocation_hash','generator_revision'];
const core = (exercises) => exercises.map(canonicalStrengthExercise);
const totals = (exercises) => Object.fromEntries(exercises.map(exercise => [exercise.exercise_id, exercise.target.sets]));
const prescription = (exercise) => { const result = JSON.parse(JSON.stringify(exercise)); delete result.target.sets; return result; };
const SOURCE_SET_PATTERNS = Object.freeze({
  'concurrent-maintain-focus': [3,3,2], 'concurrent-build-focus': [4,4,3,3],
  'concurrent-maintain-recovery-focus': [2,2,2], 'concurrent-taper-focus': [2,2],
  'concurrent-useful-two-exercise-week-v1': [4,4],
});

function trustedTemplateExercises(id, focus, original) {
  const pattern = SOURCE_SET_PATTERNS[id];
  const region = focus === 'Upper body' ? 'upper' : focus === 'Lower body' ? 'lower' : null;
  return pattern && region && original.length === pattern.length && original.every((exercise, index) => {
    const reference = EXERCISES_BY_ID[exercise.exercise_id];
    return reference && reference.region === region && exercise.region === region
      && exercise.target.sets === pattern[index] && exercise.target.repetitions === reference.repetitions
      && Number.isFinite(exercise.target.rest_s) && exercise.target.rest_s > 0
      && Number.isFinite(exercise.target.rpe_range?.minimum) && Number.isFinite(exercise.target.rpe_range?.maximum)
      && exercise.target.rpe_range.minimum >= 6 && exercise.target.rpe_range.maximum <= 8;
  });
}

function buildDistributionReceipts(source, children, { weekStart, focus }) {
  const original = core(source);
  const allocations = children.map(child => ({ session_id: child.id, exercises: core(child.main) }));
  const templateId = Object.keys(SOURCE_SET_PATTERNS).find(id => trustedTemplateExercises(id, focus, original));
  if (!templateId) throw new Error('Distributed strength has no authoritative source template');
  const template = { id: templateId, version: 1, focus, exercises: original };
  const sourceHash = canonicalHash(template);
  const groupId = `strength-partition-${canonicalHash({ weekStart, sourceHash, allocations }).slice(0,24)}`;
  return children.map((_, index) => ({
    distribution_policy_version: VERSION, dose_accounting_version: DOSE_VERSION,
    source_template_id: template.id, source_template_version: 1, source_template_content_hash: sourceHash,
    group_id: groupId, focus, partition_index: index, partition_count: children.length,
    original_exercises: original, allocations, conserved_weekly_sets: totals(original),
    allocation_hash: canonicalHash(allocations), generator_revision: VERSION,
  }));
}

function validateDistributionReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join('|') !== KEYS.slice().sort().join('|')
    || receipt.distribution_policy_version !== VERSION || receipt.dose_accounting_version !== DOSE_VERSION
    || receipt.generator_revision !== VERSION || !Object.hasOwn(SOURCE_SET_PATTERNS, receipt.source_template_id)
    || receipt.source_template_version !== 1 || !String(receipt.group_id).startsWith('strength-partition-')
    || !Number.isInteger(receipt.partition_count) || receipt.partition_count < 2
    || !Number.isInteger(receipt.partition_index) || receipt.partition_index < 0 || receipt.partition_index >= receipt.partition_count
    || !Array.isArray(receipt.original_exercises) || !Array.isArray(receipt.allocations)
    || receipt.allocations.length !== receipt.partition_count) return false;
  const original = receipt.original_exercises;
  if (original.length < 2 || new Set(original.map(e => e.exercise_id)).size !== original.length
    || original.some(e => !Number.isInteger(e?.target?.sets) || e.target.sets < 2)) return false;
  if (!trustedTemplateExercises(receipt.source_template_id, receipt.focus, original)) return false;
  const sourceHash = canonicalHash({ id: receipt.source_template_id, version: 1, focus: receipt.focus, exercises: original });
  if (sourceHash !== receipt.source_template_content_hash || canonicalHash(receipt.allocations) !== receipt.allocation_hash) return false;
  const sums = Object.fromEntries(original.map(e => [e.exercise_id, 0]));
  if (new Set(receipt.allocations.map(a => a.session_id)).size !== receipt.partition_count) return false;
  for (const allocation of receipt.allocations) {
    if (!allocation.session_id || !Array.isArray(allocation.exercises) || !allocation.exercises.length
      || new Set(allocation.exercises.map(e => e.exercise_id)).size !== allocation.exercises.length) return false;
    for (const exercise of allocation.exercises) {
      const source = original.find(e => e.exercise_id === exercise.exercise_id);
      if (!source || !Number.isInteger(exercise?.target?.sets) || exercise.target.sets < 1
        || canonicalHash(prescription(source)) !== canonicalHash(prescription(exercise))) return false;
      sums[exercise.exercise_id] += exercise.target.sets;
    }
  }
  return canonicalHash(sums) === canonicalHash(totals(original))
    && canonicalHash(sums) === canonicalHash(receipt.conserved_weekly_sets);
}

function validateDistributedSession(session, siblings, { source = false } = {}) {
  const receipt = session.strength_distribution;
  if (!validateDistributionReceipt(receipt) || !session.supports_requirement_id && !source) return false;
  const allocation = receipt.allocations[receipt.partition_index];
  const localId = session.source_session_id || session.session_id || session.id;
  if (allocation.session_id !== localId) return false;
  let actual;
  try { actual = source ? core(session.main) : session.steps.map(step => ({ exercise_id: step.exercise_id,
    region: allocation.exercises.find(e => e.exercise_id === step.exercise_id)?.region, target: step.target })); }
  catch { return false; }
  if (canonicalHash(actual) !== canonicalHash(allocation.exercises)) return false;
  if (!Array.isArray(siblings)) return true;
  const group = siblings.filter(s => s.strength_distribution?.group_id === receipt.group_id);
  return group.length === receipt.partition_count && new Set(group.map(s => s.strength_distribution.partition_index)).size === receipt.partition_count
    && group.every(s => s.strength_distribution.allocation_hash === receipt.allocation_hash && validateDistributedSession(s, null, { source }));
}

module.exports = { VERSION, buildDistributionReceipts, validateDistributionReceipt, validateDistributedSession };
