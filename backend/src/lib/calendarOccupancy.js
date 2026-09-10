const { DAY_ORDER } = require('./runSchedule');
const { canonicalHash } = require('./racePlanPolicy');
const VERSION = 'calendar-occupancy-policy-v2';

function calendarOccupancy({ runCount, liftCount, runEligibleWeekdays, liftEligibleWeekdays,
  weekKind = 'ORDINARY', timezone = 'UTC' }) {
  const runDays = DAY_ORDER.filter(day => runEligibleWeekdays.includes(day));
  const liftDays = DAY_ORDER.filter(day => liftEligibleWeekdays.includes(day));
  const intersection = runDays.filter(day => liftDays.includes(day));
  const insufficient = [['run', runCount, runDays], ['lift', liftCount, liftDays]]
    .filter(([, count, days]) => !Number.isInteger(count) || count < 0 || count > days.length)
    .map(([modality, requested, days]) => ({ modality, requested, available: days.length, eligible_weekdays: days }));
  const maximumOverlap = Math.min(runCount, liftCount, intersection.length);
  const minimumOccupiedDates = runCount + liftCount - maximumOverlap;
  const content = { policy_version: VERSION, requested_run_count: runCount, requested_lift_count: liftCount,
    run_eligible_weekdays: runDays, lift_eligible_weekdays: liftDays, intersection,
    maximum_overlap: maximumOverlap, minimum_occupied_dates: minimumOccupiedDates,
    classification: insufficient.length ? 'MODALITY_AVAILABILITY_INSUFFICIENT'
      : minimumOccupiedDates === 7 ? 'FULL_WEEK_OCCUPANCY_REQUESTED' : 'REST_DATE_FEASIBLE',
    effective_week_kind: weekKind, timezone, ...(insufficient.length ? { insufficient } : {}) };
  const receipt = { ...content, contract_fingerprint: canonicalHash(content) };
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return freeze(receipt);
}

function scheduleOccupancy(runs, lifts, timezone = 'UTC', weekKind = 'ORDINARY') {
  return calendarOccupancy({ runCount: runs.runDaysPerWeek, liftCount: lifts.liftDaysPerWeek,
    runEligibleWeekdays: runs.trainingDays, liftEligibleWeekdays: lifts.liftEligibleWeekdays, timezone, weekKind });
}

function sharedRestDay(receipt, preferredRunDays = [], excludedRestDays = []) {
  if (receipt.classification !== 'REST_DATE_FEASIBLE') return null;
  const feasible = DAY_ORDER.filter(day => !excludedRestDays.includes(day)
    && receipt.run_eligible_weekdays.filter(value => value !== day).length >= receipt.requested_run_count
    && receipt.lift_eligible_weekdays.filter(value => value !== day).length >= receipt.requested_lift_count);
  return feasible.find(day => !preferredRunDays.includes(day)) || feasible[0] || null;
}

module.exports = { VERSION, calendarOccupancy, scheduleOccupancy, sharedRestDay };
