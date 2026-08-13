#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const planSchema = require('../src/lib/planSchema');
const { assertPersistablePlan } = require('../src/lib/planCandidateLifecycle');

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function assertFilteringContract() {
  const source = {
    schemaVersion: 2,
    weeks: [{ days: [{
      date: localDate(1),
      day: 'Thu',
      sessions: [
        { id: 'run-kept', kind: 'run' },
        { id: 'lift-removed', kind: 'lift' },
      ],
    }] }],
  };
  const identified = planSchema.withRemovalSessionIdentities(source);
  const removalId = identified.weeks[0].days[0].sessions[1].removal_session_id;
  const filtered = planSchema.withoutRemovedSessions(identified, [removalId]);
  assert.deepEqual(filtered.weeks[0].days[0].sessions.map((session) => session.id), ['run-kept']);
  assert.equal(source.weeks[0].days[0].sessions.length, 2, 'immutable source plan is preserved');
  assert.strictEqual(planSchema.withoutRemovedSessions(source, []), source, 'empty removal set preserves identity');
}

function assertStoredCompletionContract() {
  assert.equal(planSchema.isStoredSessionCompleted({}, { kind: 'lift', completed: true }), true);
  assert.equal(planSchema.isStoredSessionCompleted({}, { kind: 'lift', status: 'completed' }), true);
  assert.equal(planSchema.isStoredSessionCompleted({ status: 'completed' }, { kind: 'lift' }), true);
  assert.equal(planSchema.isStoredSessionCompleted({ completed: true }, { kind: 'lift' }), true);
  assert.equal(planSchema.isStoredSessionCompleted({ status: 'planned' }, { kind: 'lift' }), false);
}

function assertRemovalIdentityContract() {
  const legacy = {
    startDate: '2026-07-13',
    weeks: [
      { sessions: [{ day: 'Mon', type: 'run', title: 'Week one' }] },
      { sessions: [{ day: 'Mon', type: 'run', title: 'Week two' }] },
    ],
  };
  const identified = planSchema.withRemovalSessionIdentities(legacy);
  const weekOneId = identified.weeks[0].sessions[0].removal_session_id;
  const weekTwoId = identified.weeks[1].sessions[0].removal_session_id;
  assert.match(weekOneId, /^remove:v1:2026-07-13:/);
  assert.match(weekTwoId, /^remove:v1:2026-07-20:/);
  assert.notEqual(weekOneId, weekTwoId, 'legacy no-ID sessions in different weeks never collide');
  const filtered = planSchema.withoutRemovedSessions(identified, [weekTwoId]);
  assert.equal(filtered.weeks[0].sessions[0].title, 'Week one');
  assert.equal(filtered.weeks[1].sessions[0].status, 'removed');

  const assignmentAnchored = planSchema.withRemovalSessionIdentities({
    weeks: [{ days: [{ day: 'Wed', sessions: [{ kind: 'lift', title: 'Anchored lift' }] }] }],
  }, { assignmentStart: '2026-07-13' });
  assert.equal(assignmentAnchored.weeks[0].days[0].date, '2026-07-15');
  assert.match(assignmentAnchored.weeks[0].days[0].sessions[0].removal_session_id, /^remove:v1:2026-07-15:/);

  const duplicate = planSchema.withRemovalSessionIdentities({
    weeks: [{ days: [{
      date: '2026-07-13',
      day: 'Mon',
      sessions: [
        { id: 'duplicate', kind: 'run' },
        { id: 'duplicate', kind: 'run' },
      ],
    }] }],
  });
  assert.equal(duplicate.weeks[0].days[0].sessions[0].removal_session_id, undefined);
  assert.equal(duplicate.weeks[0].days[0].sessions[1].removal_session_id, undefined);

  const unanchored = planSchema.withRemovalSessionIdentities({
    weeks: [{ days: [{ day: 'Wed', sessions: [{ id: 'unanchored', kind: 'lift' }] }] }],
  });
  assert.equal(unanchored.weeks[0].days[0].sessions[0].removal_session_id, undefined);

  const historical = {
    schemaVersion: 2,
    startDate: '2026-07-13',
    weeks: [{ days: [{
      date: '2026-07-14',
      day: 'Tue',
      sessions: [{ kind: 'run', title: 'Historical run' }, { kind: 'lift', title: 'Historical lift' }],
    }] }],
  };
  const oldHistorical = planSchema.withRemovalSessionIdentities(historical, { assignmentStart: '2026-07-13' });
  const oldCompletedId = planSchema.sessionIdentifier(historical.weeks[0].days[0], historical.weeks[0].days[0].sessions[0], 0, 0);
  const oldRemovedId = oldHistorical.weeks[0].days[0].sessions[1].removal_session_id;
  const normalized = planSchema.normalizePersistedPlanIdentities(historical, {
    week_start: '2026-07-13',
    progress_json: JSON.stringify({ completedSessionIds: [oldCompletedId], removedSessionIds: [oldRemovedId] }),
  });
  assert.doesNotThrow(() => assertPersistablePlan(normalized.plan), 'historical schema-v2 plan becomes persistable');
  assert.deepEqual(normalized.plan.weeks[0].days[0].sessions.map((session) => session.id), [
    '2026-07-14-run-0',
    '2026-07-14-lift-1',
  ]);
  assert.deepEqual(normalized.progress.completedSessionIds, ['2026-07-14-run-0'], 'unique completion fallback is preserved');
  assert.match(normalized.progress.removedSessionIds[0], /id%3A2026-07-14-lift-1$/, 'slot removal marker is remapped to the stable id');
  const historicalVisible = planSchema.visiblePlanForAssignment(normalized.plan, {
    week_start: '2026-07-13',
    progress_json: normalized.progress,
  });
  assert.deepEqual(historicalVisible.weeks[0].days[0].sessions.map((session) => session.id), ['2026-07-14-run-0']);
  assert.equal(planSchema.normalizePersistedPlanIdentities(normalized.plan, {
    week_start: '2026-07-13',
    progress_json: normalized.progress,
  }).changed, false, 'identity backfill is replay-safe');

  const ambiguousHistorical = {
    schemaVersion: 2,
    startDate: '2026-07-13',
    weeks: [
      { days: [{ day: 'Tue', sessions: [{ kind: 'run' }] }] },
      { days: [{ day: 'Tue', sessions: [{ kind: 'run' }] }] },
    ],
  };
  const ambiguousNormalized = planSchema.normalizePersistedPlanIdentities(ambiguousHistorical, {
    progress_json: { completedSessionIds: ['Tue-run-0'] },
  });
  const ambiguousIds = ambiguousNormalized.plan.weeks.map((week) => week.days[0].sessions[0].id);
  assert.equal(new Set(ambiguousIds).size, 2, 'cross-week id-less fallbacks receive unique deterministic ids');
  assert.deepEqual(ambiguousNormalized.progress.completedSessionIds, ['Tue-run-0'],
    'ambiguous historical completion evidence is preserved but never guessed onto multiple workouts');

  const preBackfillWeek = {
    week: 1,
    startDate: '2026-07-13',
    days: [
      { day: 'Mon', sessions: [{ kind: 'run', title: 'Missed run' }] },
      { date: '2026-07-14', day: 'Tue', sessions: [{ kind: 'rest', title: 'Recovery' }] },
    ],
  };
  const rescheduled = planSchema.rescheduleSessionInWeek(preBackfillWeek, 'Mon-run-0', {
    targetDate: '2026-07-14',
  });
  assert.equal(rescheduled.error, undefined, 'historical reschedule succeeds before identity backfill');
  assert.equal(rescheduled.week.days[1].sessions[0].id, 'Mon-run-0',
    'reschedule stamps the historical fallback as the moved session explicit id');
  const postRescheduleHistorical = {
    schemaVersion: 2,
    startDate: '2026-07-13',
    weeks: [
      rescheduled.week,
      {
        week: 2,
        startDate: '2026-07-20',
        days: [{
          day: 'Mon',
          sessions: [{ kind: 'run', title: 'Untouched id-less sibling' }],
        }],
      },
    ],
  };
  const beforeCollisionBackfill = planSchema.withRemovalSessionIdentities(postRescheduleHistorical, {
    assignmentStart: '2026-07-13',
  });
  const siblingOldRemovalId = beforeCollisionBackfill.weeks[1].days[0].sessions[0].removal_session_id;
  const collisionNormalized = planSchema.normalizePersistedPlanIdentities(postRescheduleHistorical, {
    week_start: '2026-07-13',
    progress_json: {
      completedSessionIds: ['Mon-run-0'],
      removedSessionIds: [siblingOldRemovalId],
    },
  });
  const movedOwner = collisionNormalized.plan.weeks[0].days[1].sessions[0];
  const normalizedSibling = collisionNormalized.plan.weeks[1].days[0].sessions[0];
  assert.equal(movedOwner.id, 'Mon-run-0');
  assert.notEqual(normalizedSibling.id, movedOwner.id, 'id-less sibling receives its own stable identity');
  assert.deepEqual(collisionNormalized.progress.completedSessionIds, ['Mon-run-0'],
    'completed rescheduled session retains ownership when a sibling fallback collides');
  assert.match(collisionNormalized.progress.removedSessionIds[0], new RegExp(`id%3A${normalizedSibling.id}$`),
    'the sibling slot removal marker remaps independently without touching the explicit owner');
  const collisionVisible = planSchema.visiblePlanForAssignment(collisionNormalized.plan, {
    week_start: '2026-07-13',
    progress_json: collisionNormalized.progress,
  });
  assert.equal(collisionVisible.weeks[0].days[1].sessions[0].id, 'Mon-run-0');
  assert.deepEqual(collisionVisible.weeks[1].days[0].sessions, [],
    'removed id-less sibling stays filtered after backfill while completed owner remains visible');
  assert.doesNotThrow(() => assertPersistablePlan(collisionNormalized.plan));
}

function assertRaceOwnershipRouteContract() {
  const races = fs.readFileSync(path.join(__dirname, '../src/routes/races.js'), 'utf8');
  const plans = fs.readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');
  assert.match(races, /router\.post\('\/:id\/removal-apply', auth, async/);
  assert.doesNotMatch(races, /router\.post\('\/:id\/removal-apply', auth, requirePremium/);
  assert.doesNotMatch(races, /withRequestPlanningClock\(req, req\.body \|\| \{\}\)/,
    'race removal endpoints never forward an open-ended client body');
  assert.match(races, /planning_date_local: req\.body\?\.planning_date_local,[\s\S]*timezone_offset_minutes: req\.body\?\.timezone_offset_minutes/);
  assert.match(races, /requiredOperation:\s*'remove_race', requiredRaceId:/);
  assert.match(plans, /constraints\.requiredOperation[\s\S]*CANDIDATE_OPERATION_MISMATCH/);
  assert.match(plans, /constraints\.requiredRaceId[\s\S]*CANDIDATE_RACE_MISMATCH/);
}

async function assertScheduledWorkoutRoute() {
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbModulePath];
  const originalPlans = require.cache[plansRoutePath];

  const plan = {
    schemaVersion: 2,
    planMode: 'hybrid_maintain',
    weeks: [{
      week: 1,
      startDate: localDate(-1),
      days: [
        { date: localDate(-1), day: 'Tue', sessions: [{ id: 'past-run', kind: 'run', title: 'Past run' }] },
        { date: localDate(0), day: 'Wed', sessions: [
          { id: 'today-run', kind: 'run', title: 'Today run' },
          { id: 'today-lift', kind: 'lift', title: 'Today lift' },
          { id: 'stored-flag-complete', kind: 'lift', title: 'Stored flag', completed: true },
          { id: 'stored-status-complete', kind: 'lift', title: 'Stored status', status: 'completed' },
        ] },
        { date: localDate(1), day: 'Thu', status: 'completed', sessions: [
          { id: 'completed-day-lift', kind: 'lift', title: 'Completed day lift' },
        ] },
      ],
    }],
  };
  let activePlan = plan;
  let assignment;
  let updateCount = 0;
  let planWriteCount = 0;
  let identityBackfillCount = 0;
  let proposalRow = null;
  const reset = (progress = {}) => {
    assignment = {
      user_plan_id: 'assignment-owner',
      plan_id: 'plan-owner',
      current_week: 1,
      started_at: localDate(-1),
      status: 'active',
      progress_json: JSON.stringify(progress),
      plan_version: 1,
      lineage_id: 'lineage-owner',
      supersedes_user_plan_id: null,
      effective_from: localDate(-1),
    };
    updateCount = 0;
    planWriteCount = 0;
    identityBackfillCount = 0;
  };
  reset();

  const tx = {
    async get(sql) {
      if (/FROM plan_adjustment_proposals/.test(sql)) return proposalRow;
      if (/FROM user_plans up/.test(sql)) return assignment;
      if (/FROM training_plans tp/.test(sql)) {
        return {
          id: 'plan-owner',
          user_id: 'owner',
          name: 'Owner plan',
          type: 'hybrid_maintain',
          weeks: 1,
          plan_data: activePlan,
          plan_json: null,
        };
      }
      throw new Error(`unexpected get: ${sql}`);
    },
    async run(sql, params) {
      if (/UPDATE training_plans SET plan_data/.test(sql)) {
        activePlan = JSON.parse(params[0]);
        planWriteCount += 1;
        return { changes: 1 };
      }
      if (/UPDATE user_plans SET progress_json=\?, plan_version=plan_version\+1/.test(sql)) {
        assignment.progress_json = params[0];
        assignment.plan_version += 1;
        identityBackfillCount += 1;
        return { changes: 1 };
      }
      if (/UPDATE user_plans SET plan_version=plan_version\+1/.test(sql)) {
        assignment.plan_version += 1;
        return { changes: 1 };
      }
      if (/UPDATE plan_adjustment_proposals SET status='accepted'/.test(sql)) {
        proposalRow.status = 'accepted';
        return { changes: 1 };
      }
      if (/UPDATE plan_adjustment_proposals SET status='superseded'/.test(sql)) {
        proposalRow.status = 'superseded';
        return { changes: 1 };
      }
      if (/UPDATE user_plans SET progress_json/.test(sql)) {
        assert.equal(params[1], 'assignment-owner');
        assert.equal(params[2], 'owner');
        assignment.progress_json = params[0];
        updateCount += 1;
        return { changes: 1 };
      }
      throw new Error(`unexpected run: ${sql}`);
    },
  };
  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
      dbGet: async (sql) => {
        if (/FROM plan_adjustment_proposals/.test(sql)) return proposalRow;
        if (/FROM user_plans up/.test(sql) && /JOIN training_plans tp/.test(sql)) {
          return {
            ...assignment,
            id: 'plan-owner',
            user_id: 'owner',
            name: 'Owner plan',
            type: 'hybrid_maintain',
            weeks: activePlan.weeks.length,
            plan_data: activePlan,
            plan_json: null,
          };
        }
        if (/FROM training_plans WHERE user_id/.test(sql)) return null;
        return null;
      },
      dbAll: async () => [],
      dbRun: async (sql, params) => {
        if (/UPDATE plan_adjustment_proposals[\s\S]*status='pending'/.test(sql) && proposalRow) {
          proposalRow = {
            ...proposalRow,
            user_plan_id: params[0],
            plan_id: params[1],
            plan_version: params[2],
            window_start: params[3],
            window_end: params[4],
            planning_date: params[5],
            status: 'pending',
            safety_exception: params[6],
            original_json: params[7],
            proposed_json: params[8],
            changes_json: params[9],
            evidence_json: params[10],
            reason: params[11],
            decided_at: null,
          };
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      withUserMutation: async (_userId, fn) => fn(tx),
      withPlanningInputMutation: async (_userId, fn) => {
        const result = await fn(tx);
        return result && Object.prototype.hasOwnProperty.call(result, 'marker') ? result.value : result;
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[plansRoutePath];

  try {
    const plansRouter = require('../src/routes/plans');
    const layer = plansRouter.stack.find((item) => item.route?.path === '/my/sessions/:sessionId' && item.route?.methods?.delete);
    const handler = layer?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof handler, 'function');

    const invoke = async (sessionId) => {
      let statusCode = 200;
      let payload = null;
      const response = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
      };
      await handler({ params: { sessionId }, user: { id: 'owner' }, body: {}, headers: { 'x-forged-local-date': localDate(0) } }, response);
      return { statusCode, payload };
    };
    const invokeHandler = async (routeHandler, request) => {
      let statusCode = 200;
      let payload = null;
      const routeResponse = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
      };
      await routeHandler({ user: { id: 'owner' }, headers: {}, query: {}, body: {}, ...request }, routeResponse);
      return { statusCode, payload };
    };

    const identified = planSchema.withRemovalSessionIdentities(plan, { assignmentStart: localDate(-1) });
    const sessionRemovalId = (sessionId) => identified.weeks
      .flatMap((week) => week.days)
      .flatMap((day) => day.sessions)
      .find((session) => session.id === sessionId)?.removal_session_id;
    const todayLiftRemovalId = sessionRemovalId('today-lift');
    const todayRunRemovalId = sessionRemovalId('today-run');
    const pastRunRemovalId = sessionRemovalId('past-run');
    const storedFlagRemovalId = sessionRemovalId('stored-flag-complete');
    const storedStatusRemovalId = sessionRemovalId('stored-status-complete');
    const completedDayRemovalId = sessionRemovalId('completed-day-lift');

    const raceRequest = plansRouter._test.raceRemovalCandidateRequest('server-race', ['server-remaining'], {
      planning_date_local: localDate(0),
      timezone_offset_minutes: 240,
      target: { raceDate: '2099-01-01', runDaysPerWeek: 7 },
      operation: 'plan_preview',
      remove_race_id: 'attacker-race',
      race_ids: ['attacker-race'],
    });
    assert.deepEqual(raceRequest, {
      planning_date_local: localDate(0),
      timezone_offset_minutes: 240,
      operation: 'remove_race',
      remove_race_id: 'server-race',
      race_ids: ['server-remaining'],
    }, 'race removal preview admits only planning clock and server-derived race inputs');

    let response = await invoke(todayLiftRemovalId);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.removedSessionIds, [todayLiftRemovalId]);
    assert.equal(updateCount, 1);
    assert.deepEqual(JSON.parse(assignment.progress_json).removedSessionIds, [todayLiftRemovalId]);

    response = await invoke(todayLiftRemovalId);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.idempotent, true);
    assert.equal(updateCount, 1, 'idempotent replay does not write again');

    reset({ completedSessionIds: ['today-run'] });
    response = await invoke(todayRunRemovalId);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'PLAN_SESSION_COMPLETED');
    assert.equal(updateCount, 0);

    for (const storedRemovalId of [storedFlagRemovalId, storedStatusRemovalId, completedDayRemovalId]) {
      reset();
      response = await invoke(storedRemovalId);
      assert.equal(response.statusCode, 409);
      assert.equal(response.payload.code, 'PLAN_SESSION_COMPLETED');
      assert.equal(updateCount, 0);
    }

    reset();
    response = await invoke(pastRunRemovalId);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'PLAN_SESSION_IN_PAST');
    assert.equal(updateCount, 0);

    response = await invoke('remove:v1:2099-01-01:id%3Aforeign-session');
    assert.equal(response.statusCode, 404);
    assert.equal(response.payload.code, 'PLAN_SESSION_NOT_FOUND');
    assert.equal(updateCount, 0);

    const historicalPlan = {
      schemaVersion: 2,
      planMode: 'hybrid_maintain',
      weeks: [{
        week: 1,
        startDate: localDate(-1),
        days: [{
          date: localDate(0),
          day: 'Wed',
          sessions: [
            { kind: 'run', title: 'Historical completed run' },
            { kind: 'lift', title: 'Historical already removed lift' },
            { kind: 'lift', title: 'Historical removable lift' },
          ],
        }],
      }],
    };
    activePlan = historicalPlan;
    const historicalIdentified = planSchema.withRemovalSessionIdentities(historicalPlan, { assignmentStart: localDate(-1) });
    const historicalDay = historicalPlan.weeks[0].days[0];
    const oldCompletedId = planSchema.sessionIdentifier(historicalDay, historicalDay.sessions[0], 0, 0);
    const oldRemovedId = historicalIdentified.weeks[0].days[0].sessions[1].removal_session_id;
    reset({ completedSessionIds: [oldCompletedId], removedSessionIds: [oldRemovedId] });
    const preBackfillVisible = planSchema.visiblePlanForAssignment(historicalPlan, {
      ...assignment,
      week_start: localDate(-1),
    });
    const preBackfillSessions = preBackfillVisible.weeks[0].days[0].sessions;
    assert.deepEqual(preBackfillSessions.map((session) => session.title), [
      'Historical completed run',
      'Historical removable lift',
    ], 'refetch filters the old slot marker while serving deterministic ids before persistence');
    const completedHistoricalMarker = preBackfillSessions[0].removal_session_id;
    const targetHistoricalMarker = preBackfillSessions[1].removal_session_id;

    response = await invoke(targetHistoricalMarker);
    assert.equal(response.statusCode, 200, 'historical id-less schema-v2 workout can be removed');
    assert.equal(planWriteCount, 1, 'historical session ids are persisted before removal');
    assert.equal(identityBackfillCount, 1, 'historical progress markers are remapped atomically');
    assert.doesNotThrow(() => assertPersistablePlan(activePlan));
    const historicalProgress = JSON.parse(assignment.progress_json);
    assert.ok(historicalProgress.removedSessionIds.includes(targetHistoricalMarker));
    assert.ok(historicalProgress.removedSessionIds.every((id) => id.includes('id%3A')),
      'slot removal markers are remapped to stable persisted ids');
    const afterHistoricalRemoval = planSchema.visiblePlanForAssignment(activePlan, assignment);
    assert.deepEqual(afterHistoricalRemoval.weeks[0].days[0].sessions.map((session) => session.title), [
      'Historical completed run',
    ], 'refetch cannot resurrect either removed historical sibling');

    response = await invoke(targetHistoricalMarker);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.idempotent, true, 'historical removal replay stays idempotent');
    assert.equal(planWriteCount, 1, 'replay does not repeat structural backfill');

    response = await invoke(completedHistoricalMarker);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'PLAN_SESSION_COMPLETED', 'remapped historical completion remains immutable');

    activePlan = historicalPlan;
    reset({ completedSessionIds: [oldCompletedId], removedSessionIds: [oldRemovedId] });
    const historicalProposal = JSON.parse(JSON.stringify(historicalPlan));
    historicalProposal.weeks[0].days[0].sessions[2].title = 'Accepted historical adaptation';
    const normalizedForProposal = planSchema.normalizePersistedPlanIdentities(historicalPlan, {
      ...assignment,
      week_start: localDate(-1),
    });
    proposalRow = {
      id: 'historical-proposal',
      user_id: 'owner',
      status: 'pending',
      planning_date: localDate(0),
      plan_version: plansRouter._test.planVersionFor({
        source: 'assigned',
        row: { ...assignment, id: 'plan-owner', user_plan_id: 'assignment-owner' },
      }, normalizedForProposal.plan),
      proposed_json: JSON.stringify(historicalProposal),
      changes_json: JSON.stringify([{ kind: 'calendar_update' }]),
      evidence_json: '[]',
      reason: JSON.stringify({ headline: 'Historical adaptation', reason: 'Regression' }),
      plan_id: 'plan-owner',
      user_plan_id: 'assignment-owner',
      trigger_run_id: null,
    };
    const acceptLayer = plansRouter.stack.find((item) => item.route?.path === '/adaptation/:proposalId/accept' && item.route?.methods?.post);
    response = await invokeHandler(acceptLayer.route.stack.at(-1).handle, {
      params: { proposalId: proposalRow.id },
    });
    assert.equal(response.statusCode, 200, 'adaptation acceptance succeeds after historical identity backfill');
    assert.equal(response.payload.status, 'accepted');
    assert.doesNotThrow(() => assertPersistablePlan(activePlan));
    assert.equal(activePlan.weeks[0].days[0].sessions[2].title, 'Accepted historical adaptation');

    const currentVersion = plansRouter._test.planVersionFor({
      source: 'assigned',
      row: { ...assignment, id: 'plan-owner', user_plan_id: 'assignment-owner' },
    }, activePlan);
    assert.equal(plansRouter._test.adaptationEpisodeDisposition(null, currentVersion), 'none');
    assert.equal(plansRouter._test.adaptationEpisodeDisposition({ status: 'pending', plan_version: currentVersion }, currentVersion), 'reuse');
    assert.equal(plansRouter._test.adaptationEpisodeDisposition({ status: 'accepted', plan_version: 'older' }, currentVersion), 'decided');
    assert.equal(plansRouter._test.adaptationEpisodeDisposition({ status: 'superseded', plan_version: 'older' }, currentVersion), 'refresh');

    proposalRow = {
      id: 'stale-accept-proposal',
      user_id: 'owner',
      status: 'pending',
      planning_date: localDate(0),
      plan_version: 'older-plan-version',
      proposed_json: JSON.stringify(activePlan),
      changes_json: JSON.stringify([{ kind: 'calendar_update' }]),
      evidence_json: '[]',
      reason: JSON.stringify({ headline: 'Outdated adjustment', reason: 'Regression' }),
      plan_id: 'plan-owner',
      user_plan_id: 'assignment-owner',
      trigger_run_id: null,
    };
    response = await invokeHandler(acceptLayer.route.stack.at(-1).handle, {
      params: { proposalId: proposalRow.id },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'ADAPTATION_STALE');
    assert.equal(response.payload.refresh_required, true);
    assert.equal(proposalRow.status, 'superseded', 'stale proposal cannot remain pending and trap repeated accepts');

    const keepLayer = plansRouter.stack.find((item) => item.route?.path === '/adaptation/:proposalId/keep' && item.route?.methods?.post);
    proposalRow = { ...proposalRow, id: 'stale-keep-proposal', status: 'pending' };
    response = await invokeHandler(keepLayer.route.stack.at(-1).handle, {
      params: { proposalId: proposalRow.id },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'ADAPTATION_STALE');
    assert.equal(proposalRow.status, 'superseded');

    const refreshedEpisodeProposal = {
      planningDate: localDate(0),
      windowStart: localDate(0),
      windowEnd: localDate(3),
      safetyException: false,
      proposedPlan: activePlan,
      changes: [{ kind: 'calendar_update' }],
      evidence: [{ signal: 'run_gap', episodeKey: 'run-gap:2026-08-01' }],
      headline: 'Updated calendar adjustment',
      reason: 'The current plan needs a newly reviewed proposal.',
    };
    proposalRow = {
      ...proposalRow,
      id: 'run-gap-episode',
      episode_key: 'run-gap:2026-08-01',
      status: 'superseded',
      plan_version: 'older-plan-version',
    };
    const refreshedEpisode = await plansRouter._test.persistAdaptationProposal(
      'owner',
      { row: { id: 'plan-owner', user_plan_id: 'assignment-owner' } },
      currentVersion,
      activePlan,
      refreshedEpisodeProposal,
    );
    assert.equal(refreshedEpisode.id, 'run-gap-episode');
    assert.equal(refreshedEpisode.decisionStatus, 'pending');
    assert.equal(proposalRow.status, 'pending');
    assert.equal(proposalRow.plan_version, currentVersion, 'a stale run-gap episode is refreshed in place for the current plan');
    proposalRow = null;

    const hybridPlan = {
      schemaVersion: 2,
      planMode: 'hybrid_maintain',
      weeks: [{
        week: 1,
        startDate: localDate(-1),
        days: [
          { date: localDate(-1), day: 'Tue', sessions: [
            { kind: 'run', title: 'Paired run' },
            { kind: 'lift', title: 'Paired lift' },
          ] },
          { date: localDate(1), day: 'Thu', sessions: [{ kind: 'rest' }] },
        ],
      }],
    };
    activePlan = hybridPlan;
    const identifiedHybrid = planSchema.visiblePlanForAssignment(hybridPlan, {
      week_start: localDate(-1),
      progress_json: {},
    });
    const pairedDay = identifiedHybrid.weeks[0].days[0];
    const pairedRunId = planSchema.sessionIdentifier(pairedDay, pairedDay.sessions[0], 0, 0);
    const pairedLiftId = planSchema.sessionIdentifier(pairedDay, pairedDay.sessions[1], 1, 0);
    const pairedLiftRemovalId = pairedDay.sessions[1].removal_session_id;
    reset({ completedSessionIds: [pairedRunId], removedSessionIds: [pairedLiftRemovalId] });

    const currentLayer = plansRouter.stack.find((item) => item.route?.path === '/reconciliation/current' && item.route?.methods?.get);
    const currentHandler = currentLayer?.route?.stack?.at(-1)?.handle;
    const respondLayer = plansRouter.stack.find((item) => item.route?.path === '/reconciliation/respond' && item.route?.methods?.post);
    const respondHandler = respondLayer?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof currentHandler, 'function');
    assert.equal(typeof respondHandler, 'function');

    response = await invokeHandler(currentHandler, {
      query: { date: localDate(0), hour: 21, timezone: 'UTC' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.reconciliation, null, 'removed lift cannot create a hybrid prompt');

    response = await invokeHandler(respondHandler, {
      body: {
        current_date: localDate(0),
        session_date: localDate(-1),
        lift_session_id: pairedLiftId,
        response: 'life_event',
        timezone: 'UTC',
      },
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /planned hybrid session changed/i);
    assert.equal(updateCount, 0, 'crafted response cannot move or update a removed lift');
    const servedAgain = planSchema.withoutRemovedSessions(identifiedHybrid, [pairedLiftRemovalId]);
    assert.deepEqual(servedAgain.weeks[0].days[0].sessions.map((session) => session.id), [pairedRunId],
      'refetch remains filtered after rejected reconciliation');

    const reschedulePlan = {
      schemaVersion: 2,
      planMode: 'run_only',
      weeks: [{
        week: 1,
        startDate: localDate(-1),
        days: [
          { date: localDate(-1), day: 'Tue', sessions: [{ kind: 'run' }] },
          { date: localDate(0), day: 'Wed', sessions: [{ kind: 'rest' }] },
        ],
      }],
    };
    activePlan = reschedulePlan;
    const identifiedReschedule = planSchema.visiblePlanForAssignment(reschedulePlan, {
      week_start: localDate(-1),
      progress_json: {},
    });
    const removedMissed = identifiedReschedule.weeks[0].days[0].sessions[0];
    reset({ removedSessionIds: [removedMissed.removal_session_id] });
    const rescheduleLayer = plansRouter.stack.find((item) => item.route?.path === '/reschedule-missed' && item.route?.methods?.post);
    const rescheduleHandler = rescheduleLayer?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof rescheduleHandler, 'function');
    response = await invokeHandler(rescheduleHandler, {
      body: { sessionId: removedMissed.id, targetDate: localDate(0) },
    });
    assert.equal(response.statusCode, 404);
    assert.match(response.payload.error, /session not found/i);
    assert.equal(updateCount, 0, 'stale client cannot move a removed missed run');
    assert.equal(activePlan.weeks[0].days[0].sessions[0].id, removedMissed.id,
      'historical source was normalized but the removed missed run was not moved');
  } finally {
    delete require.cache[plansRoutePath];
    if (originalPlans) require.cache[plansRoutePath] = originalPlans;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

async function run() {
  assertFilteringContract();
  assertStoredCompletionContract();
  assertRemovalIdentityContract();
  assertRaceOwnershipRouteContract();
  await assertScheduledWorkoutRoute();
  console.log('SELF-SERVICE REMOVAL BACKEND SMOKE OK');
}

if (require.main === module) run().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = { run };
