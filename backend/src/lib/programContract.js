const { canonicalHash, addDays, mondayFor } = require('./racePlanPolicy');
const { resolveRunSchedule, resolveLiftSchedule } = require('./runSchedule');
const { aggregateWeeklyStress, evaluateStressBudget } = require('./goalBackwardLoad');

const PROGRAM_CONTRACT_VERSION = 'complete-road-program-v1';

function buildProgramContract({ target = {}, profile = {}, planningDateLocal, constraints = {}, evidenceRevision = 0,
  ownedGoals = [], evidenceFingerprint = null, activeIdentity = null }) {
  const runs = resolveRunSchedule(profile, target);
  const lifts = resolveLiftSchedule(profile, target);
  if (!runs.valid || !lifts.valid) throw new Error(runs.error || lifts.error);
  const start = mondayFor(planningDateLocal);
  const end = target.raceDate || addDays(start, Number(target.weeks || 8) * 7 - 1);
  const contract = {
    version: PROGRAM_CONTRACT_VERSION,
    generator_revision: process.env.RAILWAY_GIT_COMMIT_SHA || PROGRAM_CONTRACT_VERSION,
    start_date: start, planning_date: planningDateLocal, end_date: end,
    timezone: profile.timezone || 'UTC',
    run_days_per_week: runs.runDaysPerWeek, lift_days_per_week: lifts.liftDaysPerWeek,
    run_eligible_weekdays: runs.trainingDays, lift_eligible_weekdays: lifts.liftEligibleWeekdays,
    goals: ownedGoals,
    constraints, evidence_revision: evidenceRevision, evidence_fingerprint: evidenceFingerprint, active_identity: activeIdentity,
  };
  return { ...contract, fingerprint: canonicalHash(contract) };
}

function sourceBoundTaperRunAdjustment(week, source, contextHash, completedRuns = 0) {
  if (week.phase !== 'taper' || week.runFrequencyAdjustment?.policy !== 'TAPER_RUNNING_VOLUME_DISTRIBUTION') return null;
  const sessions = source?.canonical_session_set?.sessions || [];
  if (!require('./canonicalCombinedLoad').evaluateCanonicalCombinedLoad(sessions, source, contextHash).valid) return null;
  const runs = sessions.filter(session => session.kind === 'run');
  const dates = new Set(runs.map(session => session.scheduled_local_date));
  if (runs.length !== dates.size || runs.some(session => session.scheduled_local_date < week.startDate
    || session.scheduled_local_date > addDays(week.startDate, 6))
    || !Number.isInteger(completedRuns) || completedRuns < 0) return null;
  return { ...week.runFrequencyAdjustment, prescribed: dates.size + completedRuns,
    constructor_prescribed: week.runFrequencyAdjustment.prescribed,
    authoritative_source_hash: source.content_hash,
    authoritative_session_ids: runs.map(session => session.session_id) };
}

function reconcileProgramWeek(contract, week, { completedRuns = 0, completedLifts = 0, raceRunPrescription = null } = {}) {
  const start = week.startDate;
  const end = addDays(start, 6);
  const partial = start < contract.planning_date;
  const raceWeek = contract.end_date >= start && contract.end_date <= end
    || contract.goals.some(goal => {
      const date = goal.event_local_date || goal.race_date;
      return typeof date === 'string' && date >= start && date <= end;
    });
  const sessions = (week.days || []).flatMap((day) => (day.sessions || []).map((session) => ({ ...session, date: day.date })));
  const entries = [['run', contract.run_days_per_week, completedRuns], ['lift', contract.lift_days_per_week, completedLifts]].map(([kind, requested, completed]) => {
    const selected = sessions.filter((session) => session.kind === kind);
    const dates = new Set(selected.map((session) => session.date));
    const delivered = dates.size;
    const frequencyDoseAdjusted = kind === 'run' && week.runFrequencyAdjustment?.policy === 'EXPLICIT_SINGLE_RUNNING_DAY_DOSE';
    const phaseReplanned = kind === 'run' && week.roadPhaseAdjustment?.version === 'owned-road-phase-replan-v1';
    const exact = delivered + completed === requested && !frequencyDoseAdjusted && !phaseReplanned;
    const weekday = date => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(`${date}T12:00:00Z`).getUTCDay()];
    const eligible = kind === 'run' ? contract.run_eligible_weekdays : contract.lift_eligible_weekdays;
    const capacity = (week.days || []).filter(day => day.date >= contract.planning_date && eligible.includes(weekday(day.date))).length;
    const phaseLift = kind === 'lift' ? week.liftFrequencyAdjustment : week.runFrequencyAdjustment;
    const partialExpected = Math.max(0, Math.min(requested - completed, capacity));
    const phaseExpected = kind === 'run' && raceWeek && raceRunPrescription ? raceRunPrescription.expected
      : phaseLift ? Math.max(0, phaseLift.prescribed - completed)
      : raceWeek && kind === 'run' && raceRunPrescription ? raceRunPrescription.expected : null;
    const rule = phaseReplanned && delivered + completed === requested ? 'OWNED_RACE_PHASE_REPLAN'
      : exact ? null : phaseExpected !== null && delivered === phaseExpected
      ? kind === 'run' && raceWeek && raceRunPrescription ? 'RACE_WEEK_USEFUL_PRESCRIPTIONS'
        : phaseLift ? phaseLift.policy : 'RACE_WEEK_USEFUL_PRESCRIPTIONS'
      : partial && delivered === partialExpected ? 'REMAINING_ELIGIBLE_DATES' : null;
    const outcome = exact ? 'EXACT' : rule && delivered + completed <= requested ? 'DISCLOSED_ADJUSTMENT' : 'UNSATISFIABLE';
    return { modality: kind, requested, delivered, completed, outcome, rule,
      explanation: exact ? `${requested} ${kind} days delivered.` : rule
        ? `${requested} ${kind} days requested; ${delivered} remaining plus ${completed} completed. ${phaseReplanned ? week.roadPhaseAdjustment.explanation : rule === 'REMAINING_ELIGIBLE_DATES' ? 'This starting week is already in progress; no eligible dates remain for the missing sessions.' : phaseLift ? phaseLift.explanation : 'The exact race and useful preparation remain; below-floor training fragments are not counted as runs.'}`
        : `Requested ${requested} ${kind} days but generated ${delivered}. This program cannot be accepted.`,
      duplicate_modality_dates: selected.length !== dates.size,
      adjustment_evidence: phaseReplanned ? week.roadPhaseAdjustment : rule === 'RACE_WEEK_USEFUL_PRESCRIPTIONS' ? raceRunPrescription : phaseLift || null,
    };
  });
  return { start_date: start, entries,
    valid: entries.every((entry) => entry.outcome !== 'UNSATISFIABLE' && !entry.duplicate_modality_dates) };
}

function validateRollingProgramDose(sessions, ceilings) {
  const windows = [...new Set(sessions.map(session => session.scheduled_local_date))].sort().map(start => {
    const end = addDays(start, 6);
    const aggregate = aggregateWeeklyStress(sessions.filter(session => session.scheduled_local_date >= start && session.scheduled_local_date <= end));
    const result = evaluateStressBudget(aggregate, ceilings);
    return { start_date: start, end_date: end, valid: aggregate.valid && result.valid,
      weekly_dimension_sum: aggregate.weekly_dimension_sum,
      violations: [...(aggregate.violations || []), ...(result.violations || [])] };
  });
  return { valid: windows.every(window => window.valid), windows };
}

module.exports = { PROGRAM_CONTRACT_VERSION, buildProgramContract, sourceBoundTaperRunAdjustment, reconcileProgramWeek, validateRollingProgramDose };
