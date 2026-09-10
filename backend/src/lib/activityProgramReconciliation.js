const { canonicalHash, addDays } = require('./racePlanPolicy');
const { validateActivitySet, predecessorFor } = require('./activityCanonicalSuccessor');
const { resolveSessionStress, aggregateWeeklyStress, validateRollingHardDays } = require('./goalBackwardLoad');
const { validateInterference, validateConstraints, validatePresentationFloor } = require('./goalBackwardValidators');
const clone = value => JSON.parse(JSON.stringify(value));
function validateFutureProtection({ parent, successor, observationArtifact, completedIds = [], planningDate,
  recentRunLoad = {}, constraints = {}, training_age_class }) {
  if (!validateActivitySet(successor, { authenticatedParent: parent })
    || !require('./activityObservation').validateObservation(observationArtifact, successor.activity_adaptation.context)
    || planningDate !== successor.activity_adaptation.context.planning_date
    || canonicalHash(recentRunLoad) !== successor.activity_adaptation.context.recent_run_load_hash
    || canonicalHash([...new Set(completedIds)].sort()) !== canonicalHash(observationArtifact.qualified_completed_session_ids)) {
    return { valid: false, reason_codes: ['ACTIVITY_PARENT_IDENTITY_INVALID'] };
  }
  const completed = new Set(completedIds);
  const future = successor.sessions.filter(session => session.scheduled_local_date >= planningDate && !completed.has(session.session_id));
  const all = future; // Raw observations never receive prescribed family vectors.
  const futureIds = new Set(future.filter(session => session.workout_family !== 'rest').map(session => session.session_id));
  const interference = validateInterference(all, { training_age_class });
  const futureInterference = interference.violations.filter(violation => (violation.session_ids || []).some(id => futureIds.has(id)));
  const rolling = validateRollingHardDays(all, { training_age_class, spacing_valid: futureInterference.length === 0 });
  const futureRolling = rolling.violations || [];
  const protection = recentRunLoad.protection || {};
  const protectionViolations = future.flatMap(session => {
    if (session.workout_family === 'rest') return [];
    const date = session.scheduled_local_date, family = session.workout_family;
    const stress = resolveSessionStress(session);
    const hardRunning = ['long_aerobic', 'threshold_run', 'interval_run', 'race_rhythm_run', 'assessment'].includes(family);
    const blocked = session.kind === 'run' && date === protection.noAdditionalRunOnDate
      || session.kind === 'run' && protection.postRunSevere && protection.hardRunsThrough && date <= protection.hardRunsThrough
      || hardRunning && protection.hardRunsThrough && date <= protection.hardRunsThrough
      || ['strength_lower', 'strength_full_body'].includes(family) && protection.lowerBodyThrough && date <= protection.lowerBodyThrough;
    return blocked || !stress.valid ? [{ code: 'ACTIVITY_RECOVERY_PROTECTION', session_id: session.session_id }] : [];
  });
  const locks = validateConstraints(successor.sessions, { planning_constraints: constraints });
  // Unaffected accepted prescriptions keep their original presentation/phase
  // authority. Revalidate every altered session using its original group.
  const changedIds = new Set(successor.activity_adaptation.context.affected_session_ids);
  const floors = validatePresentationFloor(successor.sessions, { training_age_class });
  const changedFloors = floors.violations.filter(violation => changedIds.has(violation.session_id));
  const aggregate = aggregateWeeklyStress(all);
  const combined = require('./canonicalCombinedLoad').evaluateActivityCombinedLoad(successor, parent, { planningDate, completedIds });
  let physicalMaterial;
  try {
    physicalMaterial = require('./activityObservation').currentWeekPhysicalMaterial(observationArtifact,
      { sessions: future }, successor.activity_adaptation.context);
  } catch (error) {
    if (!['ACTIVITY_PHYSICAL_MATERIAL_SOURCE_INVALID', 'ACTIVITY_PHYSICAL_MATERIAL_BOUND_EXCEEDED'].includes(error.message)) throw error;
    return { valid: false, reason_codes: [error.message] };
  }
  const violations = [...futureInterference, ...futureRolling, ...protectionViolations, ...locks.violations,
    ...changedFloors, ...(aggregate.violations || []), ...(!combined.valid ? [{ code: 'CROSS_MODAL_FATIGUE_LIMIT' }] : [])];
  return { valid: !violations.length, violations, reason_codes: [...new Set(violations.map(violation => violation.code))],
    historical_overages: { current_week_physical: clone(observationArtifact.current_week),
      physical_windows: clone(observationArtifact.physical_windows), load_ratio: recentRunLoad.loadRatio ?? null,
      description: 'Observed physical workload is retained, not converted into a prescribed stress vector or new capacity.' },
    observed_activity_count: observationArtifact.canonical_activity_count,
    future_executable_session_count: futureIds.size, recovery_protection: clone(protection), combined_load: combined,
    physical_material: physicalMaterial };
}

function activityProgramReconciliation(parentPlan, successor, { completedIds = [] } = {}) {
  if (!validateActivitySet(successor)) throw new Error('ACTIVITY_PROGRAM_RECONCILIATION_AUTHORITY_INVALID');
  const parent = predecessorFor(successor), context = successor.activity_adaptation.context;
  const completed = new Set(successor.activity_adaptation.observation_artifact.qualified_completed_session_ids), changed = new Set(context.affected_session_ids);
  const byId = new Map(successor.sessions.map(session => [session.session_id, session]));
  const plan = clone(parentPlan);
  plan.weeks = plan.weeks.map(week => ({ ...week, days: week.days.map(day => ({ ...day,
    sessions: day.sessions.map(session => byId.get(session.session_id || session.id)) })) }));
  plan.plan_revision = successor.plan_revision;
  plan.canonical_session_set_hash = successor.content_hash;
  plan.selected_candidate_hash = successor.candidate_hash;
  const { sessions, ...identity } = successor;
  plan.programCanonicalIdentity = identity;
  const prior = Array.isArray(parentPlan.programReconciliation) ? parentPlan.programReconciliation
    : parentPlan.programReconciliation?.weeks || [];
  const receipt = plan.weeks.map((week, index) => {
    const start = week.startDate, end = addDays(start, 6);
    const original = parent.sessions.filter(session => session.scheduled_local_date >= start && session.scheduled_local_date <= end);
    const current = sessions.filter(session => session.scheduled_local_date >= start && session.scheduled_local_date <= end);
    if (!current.some(session => changed.has(session.session_id))) return clone(prior[index]);
    const old = prior[index];
    const entries = ['run', 'lift'].map(kind => {
      const originals = original.filter(session => session.kind === kind && session.workout_family !== 'rest');
      const retained = current.filter(session => session.kind === kind && session.workout_family !== 'rest');
      const originalEntry = old?.entries?.find(entry => entry.modality === kind);
      const withheld = originals.filter(session => byId.get(session.session_id)?.workout_family === 'rest');
      const converted = retained.filter(session => changed.has(session.session_id));
      const qualified = originals.filter(session => completed.has(session.session_id));
      const countChanged = withheld.length > 0;
      return { ...clone(originalEntry || {}), modality: kind,
        requested: kind === 'run' ? plan.programContract.run_days_per_week : plan.programContract.lift_days_per_week,
        delivered: new Set(retained.map(session => session.scheduled_local_date)).size,
        original_delivered: originals.length, completed_qualified: qualified.length,
        retained_future: retained.filter(session => !completed.has(session.session_id) && session.scheduled_local_date >= context.planning_date).length,
        converted: converted.length, withheld_as_rest: withheld.length,
        final_delivered: retained.length, outcome: countChanged ? 'DISCLOSED_ADJUSTMENT' : originalEntry?.outcome || 'EXACT',
        rule: countChanged ? 'ACTIVITY_AWARE_RECOVERY_WITHHOLDING' : originalEntry?.rule || null,
        explanation: `${originals.length} ${kind} days were prescribed; ${retained.length} remain, ${withheld.length} are withheld as recovery with no make-up debt. ${qualified.length} have qualified completion evidence.`,
        adjustment_evidence: { version: context.version, authority_receipt_hash: successor.activity_adaptation.receipt_hash,
          session_ids: [...converted, ...withheld].map(session => session.session_id), original_requested_unchanged: true } };
    });
    const runDates = [...new Set(current.filter(session => session.kind === 'run' && session.workout_family !== 'rest').map(session => session.scheduled_local_date))].sort();
    const liftDates = [...new Set(current.filter(session => session.kind === 'lift' && session.workout_family !== 'rest').map(session => session.scheduled_local_date))].sort();
    const occupiedDates = [...new Set([...runDates, ...liftDates])].sort();
    return { ...clone(old || {}), start_date: start, valid: true, entries,
      actual_calendar_occupancy: { run_dates: runDates, lift_dates: liftDates, occupied_dates: occupiedDates,
        rest_dates: Array.from({ length: 7 }, (_, index) => addDays(start, index)).filter(date => !occupiedDates.includes(date)),
        authority_receipt_hash: successor.activity_adaptation.receipt_hash },
      activity_authority_hash: successor.activity_adaptation.receipt_hash };
  });
  plan.programReconciliation = Array.isArray(parentPlan.programReconciliation) ? receipt
    : { ...clone(parentPlan.programReconciliation || {}), weeks: receipt };
  if (!validateActivityProgramReconciliation(plan, successor)) throw new Error('ACTIVITY_PROGRAM_RECONCILIATION_INVALID');
  return plan;
}

function validateActivityProgramReconciliation(plan, successor) {
  try {
    if (!validateActivitySet(successor) || canonicalHash(plan.programContract) !== canonicalHash(successor.program_contract)) return false;
    const parent = predecessorFor(successor), context = successor.activity_adaptation.context;
    const completed = new Set(successor.activity_adaptation.observation_artifact.qualified_completed_session_ids);
    const changed = new Set(context.affected_session_ids), byId = new Map(successor.sessions.map(session => [session.session_id, session]));
    const rows = plan.weeks.flatMap(week => week.days.flatMap(day => day.sessions));
    if (rows.length !== successor.sessions.length || new Set(rows.map(session => session.session_id)).size !== rows.length
      || rows.some(session => { const { removal_session_id, ...prescription } = session;
        return canonicalHash(prescription) !== canonicalHash(byId.get(session.session_id)); })) return false;
    const receipts = Array.isArray(plan.programReconciliation) ? plan.programReconciliation : plan.programReconciliation.weeks;
    return plan.weeks.every((week, index) => {
      const start = week.startDate, end = addDays(start, 6), within = rows => rows.filter(session => session.scheduled_local_date >= start && session.scheduled_local_date <= end);
      const current = within(successor.sessions), original = within(parent.sessions);
      if (!current.some(session => changed.has(session.session_id))) return true;
      const receipt = receipts[index];
      if (!receipt?.valid || receipt.activity_authority_hash !== successor.activity_adaptation.receipt_hash) return false;
      const modalities = ['run','lift'].map(kind => {
        const before = original.filter(session => session.kind === kind && session.workout_family !== 'rest');
        const after = current.filter(session => session.kind === kind && session.workout_family !== 'rest');
        const withheld = before.filter(session => byId.get(session.session_id).workout_family === 'rest');
        const entry = receipt.entries.find(entry => entry.modality === kind);
        return entry && entry.requested === (kind === 'run' ? plan.programContract.run_days_per_week : plan.programContract.lift_days_per_week)
          && entry.delivered === new Set(after.map(session => session.scheduled_local_date)).size
          && entry.original_delivered === before.length && entry.final_delivered === after.length
          && entry.withheld_as_rest === withheld.length && (!withheld.length || entry.outcome === 'DISCLOSED_ADJUSTMENT')
          && entry.converted === after.filter(session => changed.has(session.session_id)).length
          && entry.completed_qualified === before.filter(session => completed.has(session.session_id)).length
          && entry.retained_future === after.filter(session => !completed.has(session.session_id) && session.scheduled_local_date >= context.planning_date).length
          && entry.adjustment_evidence.authority_receipt_hash === successor.activity_adaptation.receipt_hash;
      });
      const run = [...new Set(current.filter(session => session.kind === 'run' && session.workout_family !== 'rest').map(session => session.scheduled_local_date))].sort();
      const lift = [...new Set(current.filter(session => session.kind === 'lift' && session.workout_family !== 'rest').map(session => session.scheduled_local_date))].sort();
      const occupied = [...new Set([...run, ...lift])].sort();
      const actual = { run_dates: run, lift_dates: lift, occupied_dates: occupied,
        rest_dates: Array.from({ length: 7 }, (_, offset) => addDays(start, offset)).filter(date => !occupied.includes(date)),
        authority_receipt_hash: successor.activity_adaptation.receipt_hash };
      return modalities.every(Boolean) && canonicalHash(actual) === canonicalHash(receipt.actual_calendar_occupancy);
    });
  } catch { return false; }
}

module.exports = { validateFutureProtection, activityProgramReconciliation, validateActivityProgramReconciliation };
