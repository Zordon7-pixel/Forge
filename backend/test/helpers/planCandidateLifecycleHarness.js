const path = require('node:path');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createPlanCandidateLifecycleHarness({
  ownerId = '11111111-1111-4111-8111-111111111111',
  planningDate,
  profile = {},
  races = [],
  runs = [],
} = {}) {
  const dbModulePath = require.resolve('../../src/db');
  const plansRoutePath = require.resolve('../../src/routes/plans');
  const originalDb = require.cache[dbModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];
  const RealDate = global.Date;
  const priorMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  const user = {
    id: ownerId,
    weekly_miles_current: 20,
    run_days_per_week: 4,
    lift_days_per_week: 3,
    preferred_workout_days: JSON.stringify(['Mon', 'Tue', 'Thu', 'Sat']),
    goal_type: 'race',
    comeback_mode: 0,
    injury_notes: '',
    planning_input_revision: 0,
    ...clone(profile),
  };
  const raceRows = new Map(races.map((race) => [String(race.id), { user_id: ownerId, ...clone(race) }]));
  const runRows = clone(runs);
  const candidates = new Map();
  const trainingPlans = new Map();
  const userPlans = new Map();
  const ownerLockReceipts = [];
  const transportReceipts = [];
  let rejectCandidateStatusWrite = false;

  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [`${planningDate}T16:00:00.000Z`]));
    }
    static now() { return new RealDate(`${planningDate}T16:00:00.000Z`).getTime(); }
  }

  function activeAssignment() {
    return [...userPlans.values()]
      .filter((row) => row.user_id === ownerId && row.status === 'active')
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0] || null;
  }

  function joinedAssignment(assignment) {
    const plan = assignment && trainingPlans.get(assignment.plan_id);
    return plan ? {
      ...plan,
      ...assignment,
      id: plan.id,
      plan_id: assignment.plan_id,
      user_plan_id: assignment.id,
    } : null;
  }

  async function get(sql, params = []) {
    if (sql.includes('FROM users WHERE id=?') || sql.includes('FROM users WHERE id = ?')) {
      return params[0] === ownerId ? clone(user) : null;
    }
    if (sql.includes('FROM race_events WHERE id=? AND user_id=?') || sql.includes('FROM race_events WHERE id = ? AND user_id = ?')) {
      const race = raceRows.get(String(params[0]));
      return race?.user_id === params[1] ? clone(race) : null;
    }
    if (sql.includes('FROM plan_generation_candidates WHERE id=? AND user_id=?')) {
      const row = candidates.get(String(params[0]));
      return row?.user_id === params[1] ? clone(row) : null;
    }
    if (sql.includes("up.status='active'") || sql.includes("up.status = 'active'")) {
      const assignment = activeAssignment();
      if (!assignment || assignment.user_id !== params[0]) return null;
      return sql.includes('JOIN training_plans') ? clone(joinedAssignment(assignment)) : clone(assignment);
    }
    if (sql.includes('FROM user_plans up') && sql.includes('WHERE up.id=? AND up.user_id=?')) {
      const assignment = userPlans.get(String(params[0]));
      return assignment?.user_id === params[1] ? clone(joinedAssignment(assignment)) : null;
    }
    if (sql.includes('FROM training_plans') && sql.includes('WHERE user_id')) return null;
    if (sql.includes('FROM health_sync') || sql.includes('FROM injury_logs') || sql.includes('FROM daily_checkins')) return null;
    if (sql.includes('SELECT MAX(date) AS last_date FROM runs')) {
      return { last_date: runRows.map((run) => run.date).sort().at(-1) || null };
    }
    if (sql.includes('SELECT MAX(date) AS last_date FROM lifts') || sql.includes('MAX(substr(started_at')) return { last_date: null };
    if (sql.includes('SELECT max_hr') || sql.includes('SELECT max_heart_rate')) return clone(user);
    return null;
  }

  async function all(sql) {
    if (sql.includes('FROM runs')) return clone(runRows);
    if (sql.includes('FROM workout_sessions') || sql.includes('FROM lifts') || sql.includes('FROM workout_sets')) return [];
    if (sql.includes('FROM planning_constraints') || sql.includes('FROM planning_evidence_corrections')) return [];
    if (sql.includes('FROM user_plans up') && sql.includes('up.lineage_id=?')) return [];
    return [];
  }

  async function run(sql, params = []) {
    if (sql.includes('INSERT INTO plan_generation_candidates')) {
      candidates.set(params[0], {
        id: params[0], user_id: params[1], status: params[2], training_plan_id: params[3],
        user_plan_id: params[4], active_plan_version: params[5], planning_input_revision: params[6],
        planning_date_local: params[7], timezone_offset_minutes: params[8], input_hash: params[9],
        candidate_hash: params[10], engine_version: params[11], policy_version: params[12],
        invariant_version: params[13], planning_snapshot_json: params[14], candidate_plan_json: params[15],
        generation_trace_json: params[16], expires_at: params[17],
      });
      return { changes: 1 };
    }
    if (sql.includes("UPDATE user_plans SET status='superseded'")) {
      const assignment = userPlans.get(String(params[0]));
      if (!assignment || assignment.user_id !== params[1] || assignment.status !== 'active') return { changes: 0 };
      assignment.status = 'superseded';
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO training_plans')) {
      trainingPlans.set(params[0], {
        id: params[0], user_id: params[1], week_start: params[2], plan_json: params[3],
        name: params[4], type: params[5], weeks: params[6], description: params[7], plan_data: params[8],
        created_at: `${planningDate}T16:00:${String(trainingPlans.size).padStart(2, '0')}.000Z`,
      });
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO user_plans')) {
      userPlans.set(params[0], {
        id: params[0], user_id: params[1], plan_id: params[2], started_at: params[3],
        current_week: params[4], status: params[5], progress_json: params[6], plan_version: params[7],
        lineage_id: params[8], supersedes_user_plan_id: params[9], effective_from: params[10],
        created_at: `${planningDate}T16:01:${String(userPlans.size).padStart(2, '0')}.000Z`,
      });
      return { changes: 1 };
    }
    if (sql.includes("SET status='applied'")) {
      if (rejectCandidateStatusWrite) return { changes: 0 };
      const row = candidates.get(String(params[4]));
      if (!row || row.user_id !== params[5] || row.status !== 'preview') return { changes: 0 };
      Object.assign(row, {
        status: 'applied', applied_choice: params[0], applied_training_plan_id: params[1],
        applied_user_plan_id: params[2], replay_result_json: params[3], applied_at: `${planningDate}T16:02:00.000Z`,
      });
      return { changes: 1 };
    }
    if (sql.includes('UPDATE users SET run_days_per_week=')) {
      user.run_days_per_week = params[0];
      user.preferred_workout_days = params[1];
      return { changes: 1 };
    }
    if (sql.includes('DELETE FROM plan_generation_candidates')) return { changes: 0 };
    return { changes: 1 };
  }

  const tx = { get, all, run };
  const db = {
    dbGet: get,
    dbAll: all,
    dbRun: run,
    runWithUserContext: (_userId, fn) => fn(),
    withUserMutation: async (_userId, fn) => fn(tx),
    withPlanningInputMutation: async (userId, fn) => {
      ownerLockReceipts.push({ userId, stage: 'entered' });
      const snapshot = clone({
        user,
        candidates: [...candidates],
        trainingPlans: [...trainingPlans],
        userPlans: [...userPlans],
      });
      try {
        const result = await fn(tx);
        ownerLockReceipts.push({ userId, stage: 'committed' });
        return result?.marker && Object.hasOwn(result, 'value') ? result.value : result;
      } catch (error) {
        Object.assign(user, snapshot.user);
        for (const [target, entries] of [
          [candidates, snapshot.candidates],
          [trainingPlans, snapshot.trainingPlans],
          [userPlans, snapshot.userPlans],
        ]) {
          target.clear();
          for (const [key, value] of entries) target.set(key, value);
        }
        ownerLockReceipts.push({ userId, stage: 'rolled_back' });
        throw error;
      }
    },
  };

  require.cache[dbModulePath] = {
    id: dbModulePath, filename: dbModulePath, loaded: true, exports: db, children: [], paths: [],
  };
  global.Date = FixedDate;
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'off';
  delete require.cache[plansRoutePath];
  const plansRouter = require('../../src/routes/plans');

  const clock = { planning_date_local: planningDate, timezone_offset_minutes: 240 };
  return {
    ownerId,
    clock,
    ownerLockReceipts,
    transportReceipts,
    state: { candidates, raceRows, trainingPlans, userPlans, user },
    setRejectCandidateStatusWrite(value) { rejectCandidateStatusWrite = Boolean(value); },
    updateRace(raceId, updates) { Object.assign(raceRows.get(String(raceId)), clone(updates)); },
    async preview(body) {
      return plansRouter._test.previewPlanForUser(ownerId, { ...body, ...clock });
    },
    async apply(preview, choice) {
      return plansRouter._test.applyPlanCandidate(ownerId, preview.id, {
        candidate_hash: preview.candidateHash,
        choice,
        ...clock,
      });
    },
    readApplied(result) {
      const assignment = userPlans.get(result.payload.user_plan_id);
      const plan = assignment && trainingPlans.get(assignment.plan_id);
      return plan ? { assignment: clone(assignment), plan: JSON.parse(plan.plan_data) } : null;
    },
    async post(pathname, body) {
      transportReceipts.push({ pathname: String(pathname), body: clone(body) });
      const match = String(pathname).match(/^\/plans\/candidates\/([^/]+)\/apply$/);
      if (match) {
        const result = await plansRouter._test.applyPlanCandidate(ownerId, decodeURIComponent(match[1]), body);
        return { data: result.payload || result };
      }
      const preview = await plansRouter._test.previewPlanForUser(ownerId, body);
      return {
        data: {
          requires_apply: true,
          candidate_id: preview.id,
          candidate_hash: preview.candidateHash,
          choice: preview.choice,
          plan: { plan_data: preview.plan },
        },
      };
    },
    cleanup() {
      global.Date = RealDate;
      if (priorMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
      else process.env.FORGE_GOAL_BACKWARD_V24_MODE = priorMode;
      delete require.cache[plansRoutePath];
      if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
      if (originalDb) require.cache[dbModulePath] = originalDb;
      else delete require.cache[dbModulePath];
    },
  };
}

module.exports = { createPlanCandidateLifecycleHarness };
