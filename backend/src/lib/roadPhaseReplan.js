const { addDays, mondayFor, canonicalHash } = require('./racePlanPolicy');

function projectedRoadWindow({ goals = [], athleteId, observationDate, planningDate }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(observationDate)) || planningDate <= observationDate) return null;
  const passed = goals.filter(goal => goal.athlete_id === athleteId && goal.race_id
    && ['ROAD_SHORT', 'ROAD_ENDURANCE', 'MARATHON'].includes(goal.event_kind)
    && goal.event_state === 'SCHEDULED' && goal.event_local_date >= observationDate
    && goal.event_local_date < planningDate);
  if (!passed.length) return null;
  // Reuse phasesForRaceTargets' existing one-week post-secondary-event deload.
  // This is planned recovery after a future event, never observed completion.
  const recoveryEvent = passed.find(goal => mondayFor(planningDate) === addDays(mondayFor(goal.event_local_date), 7));
  const overlapping = goals.filter(goal => goal.athlete_id === athleteId && goal.race_id
    && ['SCHEDULED', 'POSTPONED'].includes(goal.event_state)
    && goal.event_local_date >= planningDate && goal.event_local_date <= addDays(mondayFor(planningDate), 6));
  const recovering = overlapping.length ? null : recoveryEvent;
  const receipt = { version: 'projected-road-event-window-v1', athlete_id: athleteId,
    observation_date: observationDate, planning_date: planningDate,
    passed_projected_goal_ids: passed.map(goal => goal.goal_id),
    next_goal_id: goals.find(goal => !passed.some(entry => entry.goal_id === goal.goal_id)
      && ['SCHEDULED', 'POSTPONED'].includes(goal.event_state) && goal.event_local_date >= planningDate)?.goal_id || null,
    recovery_goal_id: recovering?.goal_id || null, recovery_race_id: recovering?.race_id || null,
    recovery_event_date: recovering?.event_local_date || null,
    recovery_window_start: recovering ? addDays(mondayFor(recovering.event_local_date), 7) : null,
    recovery_window_end: recovering ? addDays(mondayFor(recovering.event_local_date), 13) : null,
    state: recovering ? 'PLANNED_POST_EVENT_RECOVERY' : 'NEXT_FUTURE_GOAL',
    observed_event_state: 'SCHEDULED' };
  return { ...receipt, content_hash: canonicalHash(receipt) };
}

// Called only after the stored canonical expansion source is authenticated.
// Calendar/source identity, not a client phase flag, authorizes this transition.
function ownedRoadPhaseReplan({ userId, state, activePlan, newPlan, planningDate, projection = null }) {
  if (state.request?.operation === 'remove_race' || !activePlan?.programContract
    || !/^(?:sha256:)?[a-f0-9]{64}$/.test(String(activePlan.canonical_session_set_hash || ''))) return null;
  const start = mondayFor(planningDate), end = addDays(start, 6);
  const oldWeek = activePlan.weeks?.find(week => week.startDate === start);
  const newWeek = newPlan.weeks?.find(week => week.startDate === start);
  if (!oldWeek || !newWeek || ['taper', 'race', 'deload'].includes(oldWeek.phase)
    || !['taper', 'race', 'deload'].includes(newWeek.phase)) return null;
  const oldIds = new Set((activePlan.goals || []).map(goal => goal.raceId));
  const added = (state.races || []).filter(race => race.user_id === userId && !oldIds.has(race.id)
    && race.event_kind === 'run_race' && Number(race.distance_miles) > 0);
  const event = added.find(race => {
    const date = race.event_local_date || race.race_date;
    if (newWeek.phase === 'deload') return projection?.version === 'projected-road-event-window-v1'
      && projection.state === 'PLANNED_POST_EVENT_RECOVERY'
      && projection.athlete_id === userId && projection.recovery_race_id === race.id
      && projection.recovery_event_date === date && projection.recovery_window_start === start
      && projection.recovery_window_end === end && projection.observation_date === state.context?.todayISO
      && start === addDays(mondayFor(date), 7)
      && projection.content_hash === canonicalHash(Object.fromEntries(Object.entries(projection).filter(([key]) => key !== 'content_hash')))
      && date >= state.context?.todayISO;
    return date >= start && date <= addDays(end, 7)
      && newWeek.phase === (date <= end ? 'race' : 'taper');
  });
  if (!event || ![...oldIds].every(id => state.races.some(race => race.id === id && race.user_id === userId))) return null;
  const constraints = [...(state.planningConstraints?.locks || []), ...(state.planningConstraints?.manual_edits || [])];
  if (constraints.some(entry => {
    const date = entry.scheduled_local_date || entry.date || entry.local_date;
    return !date || date >= start && date <= end;
  })) return null;
  const receipt = { version: 'owned-road-phase-replan-v1', policy: newWeek.phase === 'deload'
    ? 'RECOVERY_VOLUME_REDUCTION' : 'TAPER_VOLUME_REDUCTION',
    input_hash: state.inputHash, accepted_session_set_hash: activePlan.canonical_session_set_hash,
    window_start: start, window_end: end, from_phase: oldWeek.phase, to_phase: newWeek.phase,
    added_race_id: event.id, event_local_date: event.event_local_date || event.race_date,
    ...(projection ? { projected_event_window_hash: projection.content_hash } : {}),
    explanation: newWeek.phase === 'deload'
      ? 'Adding this future race reserves the following week for planned recovery, not observed recovery or confirmed completion. The later race and unaffected weeks remain.'
      : 'Adding this race changes this previously ordinary week into race preparation. Training is rebuilt for the new taper/race phase; the later race and unaffected weeks remain.' };
  return { ...receipt, content_hash: canonicalHash(receipt) };
}

module.exports = { ownedRoadPhaseReplan, projectedRoadWindow };
