#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function routeHandler(router, path, method) {
  return router.stack.find((layer) => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))?.route?.stack?.at(-1)?.handle;
}

async function legacyCheckinIsPassive() {
  const ownerId = 'phase-c-checkin-owner';
  const planningDate = todayISO();
  const planJson = {
    schemaVersion: 2,
    weeks: [{
      week: 1,
      days: [{
        date: planningDate,
        day: 'Tue',
        sessions: [{ id: 'phase-c-run', kind: 'run', type: 'quality', distance_miles: 5 }],
      }],
    }],
  };
  const planRow = {
    user_plan_id: 'phase-c-user-plan',
    id: 'phase-c-plan',
    status: 'active',
    started_at: planningDate,
    effective_from: planningDate,
    progress_json: '{}',
    plan_data: JSON.stringify(planJson),
  };
  const writes = [];
  const tx = {
    async get(sql, params = []) {
      assert.equal(params.includes(ownerId), true, 'legacy compatibility reads stay owner-scoped');
      if (/SELECT id FROM daily_checkins/.test(sql)) return null;
      if (/FROM health_sync/.test(sql)) return null;
      if (/FROM user_plans up/.test(sql)) return { ...planRow };
      if (/FROM training_plans WHERE user_id/.test(sql)) return null;
      throw new Error(`unexpected transaction read: ${sql}`);
    },
    async run(sql, params = []) {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };

  const dbPath = require.resolve('../src/db');
  const routePath = require.resolve('../src/routes/checkin');
  const originalDb = require.cache[dbPath];
  const originalRoute = require.cache[routePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dbGet: tx.get,
      withUserMutation: async (userId, callback) => {
        assert.equal(userId, ownerId, 'legacy check-in mutation lock stays owner-scoped');
        return callback(tx);
      },
      withPlanningInputMutation: async () => {
        throw new Error('subjective compatibility storage must not advance planning authority');
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/checkin');
    const handler = routeHandler(router, '/', 'post');
    assert.equal(typeof handler, 'function');
    let statusCode = 200;
    let payload;
    await handler({
      user: { id: ownerId },
      body: {
        date: planningDate,
        feeling: 1,
        legs: 1,
        drive: 1,
        time_available: 10,
        sleep_hours: 2,
        life_flags: ['sick', 'injured', 'sore'],
      },
      query: {},
      headers: { 'x-forged-local-date': planningDate },
    }, {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; },
    });

    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'keep', 'stale subjective input has no execution action');
    assert.equal(payload.readiness_delta, 0, 'stale subjective input has no readiness authority');
    assert.deepEqual(payload.drivers, [], 'stale subjective input supplies no planning drivers');
    assert.match(payload.adjustment, /saved/i);
    assert.match(payload.adjustment, /does not change|unchanged/i);
    assert(writes.some(({ sql }) => /INSERT INTO daily_checkins/.test(sql)), 'legacy row remains export-compatible');
    assert.equal(
      writes.some(({ sql }) => /checkin_overrides/i.test(sql)),
      false,
      'legacy POST never creates, updates, or deletes an override row',
    );
    assert.equal(
      writes.some(({ sql }) => /(?:UPDATE|INSERT INTO)\s+(?:user_plans|training_plans)/i.test(sql)),
      false,
      'legacy POST never mutates the accepted plan',
    );
  } finally {
    delete require.cache[routePath];
    if (originalRoute) require.cache[routePath] = originalRoute;
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
  }
}

async function legacyOverridesAreAuditOnly() {
  const ownerId = 'phase-c-plan-owner';
  const planningDate = todayISO();
  const planRow = {
    user_plan_id: 'phase-c-assignment',
    plan_id: 'phase-c-plan',
    id: 'phase-c-plan',
    status: 'active',
    started_at: planningDate,
    effective_from: planningDate,
    current_week: 1,
    progress_json: '{}',
    plan_data: JSON.stringify({
      schemaVersion: 2,
      weeks: [{
        week: 1,
        days: [{
          date: planningDate,
          day: 'Tue',
          sessions: [{
            id: 'accepted-quality-run',
            kind: 'run',
            type: 'quality',
            workout_type: 'run',
            title: 'Accepted quality run',
            distance_miles: 5,
            duration_min: 45,
          }],
        }],
      }],
    }),
  };
  const reads = [];
  const db = {
    async dbGet(sql, params = []) {
      reads.push({ sql, params });
      if (/checkin_overrides/i.test(sql)) {
        throw new Error('legacy override table must not be read by execution');
      }
      if (/FROM user_plans up/.test(sql)) return { ...planRow };
      if (/FROM training_plans WHERE user_id/.test(sql)) return null;
      if (/FROM user_hr_profile/.test(sql)) return null;
      return null;
    },
    async dbAll() { return []; },
    async dbRun() { return { changes: 0 }; },
    async withPlanningInputMutation(_userId, callback) { return callback(this); },
    async withUserMutation(_userId, callback) { return callback(this); },
  };
  const dbPath = require.resolve('../src/db');
  const routePath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbPath];
  const originalRoute = require.cache[routePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: db,
    children: [],
    paths: [],
  };
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/plans');
    const handler = routeHandler(router, '/today', 'get');
    assert.equal(typeof handler, 'function');
    let statusCode = 200;
    let payload;
    await handler({
      user: { id: ownerId },
      body: {},
      query: { date: planningDate },
      headers: { 'x-forged-local-date': planningDate },
    }, {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; },
    });
    assert.equal(statusCode, 200);
    assert.equal(payload.today.title, 'Accepted quality run');
    assert.equal(payload.execution.run.title, 'Accepted quality run');
    assert.equal(payload.execution.checkinOverride, null);
    assert.equal(reads.some(({ params }) => params.includes(ownerId)), true, 'plan reads remain owner-scoped');

    const plansSource = fs.readFileSync(routePath, 'utf8');
    const aiSource = fs.readFileSync(require.resolve('../src/routes/ai'), 'utf8');
    assert.doesNotMatch(plansSource, /FROM checkin_overrides/i, 'all plan execution surfaces ignore legacy overrides');
    assert.doesNotMatch(aiSource, /FROM checkin_overrides/i, 'AI workout context ignores legacy overrides');
  } finally {
    delete require.cache[routePath];
    if (originalRoute) require.cache[routePath] = originalRoute;
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
  }
}

async function adaptationUsesPassiveEvidenceOnly() {
  const adaptation = require('../src/lib/adaptationEngine');
  const planningDate = '2026-08-25';
  const plan = {
    schemaVersion: 2,
    weeks: [{
      week: 1,
      days: [{
        date: planningDate,
        day: 'Tue',
        sessions: [{
          id: 'passive-quality-run',
          kind: 'run',
          type: 'quality',
          workout_type: 'run',
          title: 'Quality run',
          distance_miles: 5,
          duration_min: 45,
          intensity: 'Hard',
        }],
      }],
    }],
  };
  const baseline = adaptation.buildAdaptationProposal({
    plan,
    planningDateISO: planningDate,
    planVersion: 'passive-v1',
  });
  const subjective = adaptation.buildAdaptationProposal({
    plan,
    planningDateISO: planningDate,
    planVersion: 'passive-v1',
    checkin: {
      evidence_id: 'legacy-checkin',
      linked_session_id: 'passive-quality-run',
      post_run: true,
      feeling: 1,
      legs: 1,
      drive: 1,
      sleep_hours: 2,
      time_available: 5,
      life_flags: ['sick', 'injured', 'sore'],
      pain_level: 10,
    },
    recentRunLoad: {
      latestRun: {
        evidence_id: 'legacy-run-subjective',
        session_id: 'passive-quality-run',
        postRunPain: 'severe',
        postRunEnergy: 'low',
        perceivedEffort: 10,
      },
      protection: { active: false },
    },
  });
  assert.deepEqual(subjective, baseline, 'subjective check-in/run fields cannot create an adaptation');

  const classified = adaptation.classifyCompletionOutcome({
    observation: {
      evidence_id: 'passive-completion',
      target_met: true,
      pain_level: 10,
      perceived_effort: 10,
      rpe: 10,
    },
    prescribedSession: { session_id: 'passive-quality-run' },
  });
  assert.equal(classified.outcome, 'ON_TARGET', 'subjective pain and rated effort cannot classify completion');

  const translated = adaptation.translateCompletionEvidence({
    completionObservations: [{
      evidence_id: 'objective-completion',
      linked_session_id: 'passive-quality-run',
      target_met: true,
    }],
    checkin: {
      evidence_id: 'legacy-post-run',
      linked_session_id: 'passive-quality-run',
      post_run: true,
      life_flags: ['sore'],
      pain_level: 8,
    },
    recentRunLoad: {
      latestRun: {
        evidence_id: 'legacy-run-fields',
        session_id: 'passive-quality-run',
        postRunPain: 'severe',
        postRunEnergy: 'low',
        perceivedEffort: 10,
      },
    },
  }, [{ session_id: 'passive-quality-run' }]);
  assert.deepEqual(
    translated.map(({ outcome }) => outcome),
    ['ON_TARGET', 'ON_TARGET'],
    'durable run evidence remains usable without translating its subjective fields into strain or pain',
  );

  const plansSource = fs.readFileSync(require.resolve('../src/routes/plans'), 'utf8');
  assert.doesNotMatch(plansSource, /FROM daily_checkins/i, 'planner and adaptation assembly never read legacy check-ins');
}

async function bodyAndCoachUsePassiveDataOnly() {
  const ownerId = 'phase-c-coach-owner';
  const dbPath = require.resolve('../src/db');
  const aiServicePath = require.resolve('../src/services/ai');
  const bodyRoutePath = require.resolve('../src/routes/bodyDrivers');
  const coachRoutePath = require.resolve('../src/routes/coach');
  const originals = {
    db: require.cache[dbPath],
    ai: require.cache[aiServicePath],
    body: require.cache[bodyRoutePath],
    coach: require.cache[coachRoutePath],
  };
  const reads = [];
  let recoveryInput;
  const db = {
    async dbGet(sql, params = []) {
      reads.push({ sql, params });
      assert.equal(params.includes(ownerId), true, 'body/coach reads remain owner-scoped');
      if (/daily_checkins/i.test(sql)) throw new Error('subjective check-ins are unavailable to body/coach');
      if (/FROM users/.test(sql)) return { id: ownerId, goal_type: 'hybrid fitness' };
      if (/COUNT\(\*\).*workout_sessions/i.test(sql)) return { count: 0 };
      if (/SUM\(distance_miles\)/i.test(sql)) return { miles: 0 };
      return null;
    },
    async dbAll(sql, params = []) {
      reads.push({ sql, params });
      assert.equal(params.includes(ownerId), true, 'body/coach list reads remain owner-scoped');
      if (/daily_checkins/i.test(sql)) throw new Error('subjective check-ins are unavailable to body/coach');
      return [];
    },
    async dbRun() { return { changes: 0 }; },
    async withTransaction(callback) { return callback(this); },
  };
  const passthrough = async () => null;
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true, exports: db, children: [], paths: [],
  };
  require.cache[aiServicePath] = {
    id: aiServicePath,
    filename: aiServicePath,
    loaded: true,
    exports: {
      sanitize: (value) => String(value || ''),
      generateExerciseSubstitutions: passthrough,
      generateNextGoalSuggestions: passthrough,
      async generateRecoveryAdjustment(input) {
        recoveryInput = input;
        return {
          recommendation: 'Passive recovery data is unavailable; keep the accepted plan unchanged.',
          adjusted_intensity: 'moderate',
          skip_reason: null,
        };
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[bodyRoutePath];
  delete require.cache[coachRoutePath];

  const responseFor = () => {
    const state = { statusCode: 200, payload: undefined };
    return {
      state,
      response: {
        status(code) { state.statusCode = code; return this; },
        json(value) { state.payload = value; return this; },
      },
    };
  };

  try {
    const bodyRouter = require('../src/routes/bodyDrivers');
    const bodyHandler = routeHandler(bodyRouter, '/drivers', 'get');
    const bodyResponse = responseFor();
    await bodyHandler({ user: { id: ownerId } }, bodyResponse.response);
    assert.equal(bodyResponse.state.statusCode, 200);
    assert.deepEqual(bodyResponse.state.payload.drivers, []);
    assert.match(bodyResponse.state.payload.summary, /passive data.*unavailable/i);
    assert.doesNotMatch(bodyResponse.state.payload.summary, /check-?in/i);

    const coachRouter = require('../src/routes/coach');
    const coachHandler = routeHandler(coachRouter, '/adjust-today', 'post');
    const coachResponse = responseFor();
    await coachHandler({ user: { id: ownerId }, body: {} }, coachResponse.response);
    assert.equal(coachResponse.state.statusCode, 200);
    assert.equal(Object.hasOwn(coachResponse.state.payload, 'checkin_summary'), false);
    assert.equal(recoveryInput.checkin, undefined);
    assert.equal(recoveryInput.readinessScore, null, 'missing passive readiness remains unknown');

    const bodySource = fs.readFileSync(bodyRoutePath, 'utf8');
    const coachSource = fs.readFileSync(coachRoutePath, 'utf8');
    assert.doesNotMatch(bodySource, /daily_checkins|complete today['’]s check-?in/i);
    assert.doesNotMatch(coachSource, /daily_checkins|perceived_effort|checkin_summary/i);
  } finally {
    for (const [path, original] of [
      [bodyRoutePath, originals.body],
      [coachRoutePath, originals.coach],
      [aiServicePath, originals.ai],
      [dbPath, originals.db],
    ]) {
      delete require.cache[path];
      if (original) require.cache[path] = original;
    }
  }
}

async function durableRunSaveClaimsPassiveFeedbackOnce() {
  const ownerId = 'phase-c-run-owner';
  const runId = '11111111-1111-4111-8111-111111111111';
  const planningDate = todayISO();
  const dbPath = require.resolve('../src/db');
  const aiServicePath = require.resolve('../src/services/ai');
  const prServicePath = require.resolve('../src/services/prAuto');
  const routePath = require.resolve('../src/routes/runs');
  const originals = {
    db: require.cache[dbPath],
    ai: require.cache[aiServicePath],
    pr: require.cache[prServicePath],
    route: require.cache[routePath],
  };
  let inserted = false;
  let run = null;
  let feedbackCalls = 0;
  let usageWrites = 0;
  const sqlWrites = [];

  const transaction = {
    async get(sql, params = []) {
      if (/FROM users/.test(sql)) return { id: ownerId, weight_lbs: 170, max_heart_rate: 190 };
      if (/FROM runs/.test(sql)) {
        return params.includes(ownerId) && params.includes(runId) ? run : null;
      }
      return null;
    },
    async all() { return []; },
    async run(sql, params = []) {
      sqlWrites.push({ sql, params });
      if (/INSERT INTO runs/.test(sql)) {
        if (inserted) return { changes: 0 };
        inserted = true;
        run = {
          id: runId,
          user_id: ownerId,
          date: planningDate,
          type: 'run',
          distance_miles: 3,
          duration_seconds: 1800,
          perceived_effort: 10,
          pain_level: 'severe',
          post_energy: 'low',
          notes: 'Subjective legacy note',
          heart_rate_zones: JSON.stringify({ z1: 0, z2: 900, z3: 600, z4: 300, z5: 0 }),
          workout_metrics_json: JSON.stringify({ hr_sample_coverage_pct: 100, workout_effort_user_rated: 1 }),
          ai_feedback: null,
          ai_feedback_requested_at: null,
        };
        return { changes: 1 };
      }
      return { changes: 1 };
    },
  };
  const db = {
    async dbGet(sql, params = []) {
      if (/FROM ai_usage/.test(sql)) return { cnt: usageWrites };
      if (/FROM users/.test(sql)) return { id: ownerId, is_pro: 1, weekly_miles_current: 20, goal_type: 'hybrid' };
      if (/FROM user_hr_profile/.test(sql)) return null;
      if (/FROM runs/.test(sql)) return params.includes(ownerId) && params.includes(runId) ? run : null;
      return null;
    },
    async dbAll() { return []; },
    async dbRun(sql, params = []) {
      sqlWrites.push({ sql, params });
      if (/INSERT INTO ai_usage/.test(sql)) {
        usageWrites += 1;
        assert.equal(params[1], ownerId);
        return { changes: 1 };
      }
      if (/SET ai_feedback_requested_at=\?/.test(sql)) {
        assert.match(sql, /WHERE id=\? AND user_id=\? AND ai_feedback IS NULL/);
        assert.match(sql, /ai_feedback_requested_at IS NULL/);
        if (!run || run.user_id !== params[2] || run.ai_feedback || run.ai_feedback_requested_at) return { changes: 0 };
        run.ai_feedback_requested_at = params[0];
        return { changes: 1 };
      }
      if (/UPDATE runs SET ai_feedback=\?/.test(sql)) {
        assert.match(sql, /WHERE id=\? AND user_id=\? AND ai_feedback IS NULL AND ai_feedback_requested_at=\?/);
        if (run.user_id !== params[2] || run.ai_feedback || run.ai_feedback_requested_at !== params[3]) return { changes: 0 };
        run.ai_feedback = params[0];
        return { changes: 1 };
      }
      throw new Error(`unexpected feedback write: ${sql}`);
    },
    async withPlanningInputMutation(userId, callback) {
      assert.equal(userId, ownerId);
      const result = await callback(transaction);
      return typeof result?.marker === 'symbol' ? result.value : result;
    },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true, exports: db, children: [], paths: [],
  };
  require.cache[aiServicePath] = {
    id: aiServicePath,
    filename: aiServicePath,
    loaded: true,
    exports: {
      async generateRunFeedback(passiveRun) {
        feedbackCalls += 1;
        assert.equal(passiveRun.perceived_effort, undefined);
        assert.equal(passiveRun.pain_level, undefined);
        assert.equal(passiveRun.post_energy, undefined);
        assert.equal(passiveRun.notes, undefined);
        return 'Passive metrics feedback';
      },
      async generateLoadWarning() { return null; },
      async generateRunBrief() { return null; },
    },
    children: [],
    paths: [],
  };
  const prAuto = async () => ({ newPRs: [], discrepancies: [] });
  prAuto.recomputeRunPrCategories = async () => {};
  require.cache[prServicePath] = {
    id: prServicePath, filename: prServicePath, loaded: true, exports: prAuto, children: [], paths: [],
  };
  delete require.cache[routePath];

  const responseFor = () => {
    const state = { statusCode: 200, payload: undefined };
    return {
      state,
      response: {
        headersSent: false,
        status(code) { state.statusCode = code; return this; },
        json(value) { state.payload = value; this.headersSent = true; return this; },
      },
    };
  };
  const requestBody = {
    id: runId,
    date: planningDate,
    type: 'run',
    distance_miles: 3,
    duration_seconds: 1800,
    perceived_effort: 10,
    notes: 'Subjective legacy note',
    target_zone: 'Zone 2',
    plan_session_id: null,
  };

  try {
    const router = require('../src/routes/runs');
    const saveHandler = routeHandler(router, '/', 'post');
    const first = responseFor();
    await saveHandler({ user: { id: ownerId }, body: requestBody }, first.response);
    assert.equal(first.state.statusCode, 201);
    assert.equal(run.ai_feedback, 'Passive metrics feedback', 'durable save stores feedback without waiting for a check-in');
    assert.equal(feedbackCalls, 1);
    assert.equal(usageWrites, 1);

    const replay = responseFor();
    await saveHandler({ user: { id: ownerId }, body: requestBody }, replay.response);
    assert.equal(replay.state.statusCode, 200);
    assert.equal(feedbackCalls, 1, 'durable save replay does not duplicate the AI call');
    assert.equal(usageWrites, 1, 'durable save replay does not duplicate AI usage');
    assert.equal(run.ai_feedback, 'Passive metrics feedback');

    const checkinHandler = routeHandler(router, '/:id/check-in', 'patch');
    const legacyCheckin = responseFor();
    await checkinHandler({
      user: { id: ownerId },
      params: { id: runId },
      body: { perceived_effort: 3, pain_level: 'none', post_energy: 'high' },
    }, legacyCheckin.response);
    assert.equal(legacyCheckin.state.statusCode, 200);
    assert.equal(feedbackCalls, 1, 'legacy subjective update never retriggers feedback');
    assert.equal(run.ai_feedback, 'Passive metrics feedback', 'legacy subjective update cannot overwrite newer feedback');
  } finally {
    for (const [path, original] of [
      [routePath, originals.route],
      [prServicePath, originals.pr],
      [aiServicePath, originals.ai],
      [dbPath, originals.db],
    ]) {
      delete require.cache[path];
      if (original) require.cache[path] = original;
    }
  }
}

async function runFeedbackPromptIsPassive() {
  const ai = require('../src/services/ai');
  let prompt = '';
  ai._test.setClient({
    messages: {
      async create(request) {
        prompt = request.messages?.[0]?.content || '';
        return { content: [{ text: 'Passive response' }] };
      },
    },
  });
  try {
    const result = await ai.generateRunFeedback({
      id: 'passive-prompt-run',
      type: 'run',
      distance_miles: 3,
      duration_seconds: 1800,
      perceived_effort: 10,
      pain_level: 'severe-subjective-token',
      post_energy: 'low-subjective-token',
      notes: 'subjective-note-token',
      heart_rate_zones: JSON.stringify({ z1: 0, z2: 900, z3: 600, z4: 300, z5: 0 }),
      workout_metrics_json: JSON.stringify({ hr_sample_coverage_pct: 100, workout_effort_user_rated: 1 }),
      planned_session_json: JSON.stringify({ id: 'accepted-run', kind: 'run', type: 'easy', distance_miles: 3 }),
    }, {
      weekly_miles_current: 99,
      goal_type: 'subjective-goal-token',
      injury_notes: 'subjective-injury-token',
    });
    assert.equal(result, 'Passive response');
    assert.match(prompt, /3 miles in 30 min/);
    assert.match(prompt, /calculated training effort/i);
    assert.doesNotMatch(prompt, /athlete-rated|post-run check-in|subjective-note-token|severe-subjective-token|low-subjective-token|subjective-injury-token|subjective-goal-token/i);
  } finally {
    ai._test.resetClient();
  }
}

async function runCoachingSurfacesIgnoreSubjectiveRows() {
  const runsSource = fs.readFileSync(require.resolve('../src/routes/runs'), 'utf8');
  const aiRouteSource = fs.readFileSync(require.resolve('../src/routes/ai'), 'utf8');
  const aiServiceSource = fs.readFileSync(require.resolve('../src/services/ai'), 'utf8');

  assert.doesNotMatch(runsSource, /FROM daily_checkins/i, 'next-run coaching never reads legacy check-ins');
  assert.doesNotMatch(
    runsSource,
    /SELECT date, duration_seconds, perceived_effort|resolveRunEffort\(r\)/,
    'load coaching never reads or resolves user-rated effort',
  );
  assert.doesNotMatch(aiRouteSource, /SELECT distance_miles, duration_seconds, perceived_effort|effort:\s*run\.perceived_effort/);
  assert.doesNotMatch(aiRouteSource, /SELECT \* FROM runs/i, 'AI coaching loads only passive run columns');
  assert.doesNotMatch(aiRouteSource, /generated once after the post-run check-in/i);
  assert.doesNotMatch(aiServiceSource, /effort \$\{c\.effort\}\/10/);
}

async function coachingPromptsUsePassiveRunsOnly() {
  const ai = require('../src/services/ai');
  const prompts = [];
  ai._test.setClient({
    messages: {
      async create(request) {
        prompts.push(request.messages?.[0]?.content || '');
        return { content: [{ text: '{}' }] };
      },
    },
  });
  const legacyRun = {
    id: 'passive-coaching-run',
    date: todayISO(),
    type: 'run',
    distance_miles: 4,
    duration_seconds: 2400,
    avg_heart_rate: 145,
    perceived_effort: 10,
    pain_level: 'coach-pain-token',
    post_energy: 'coach-energy-token',
    notes: 'coach-note-token',
    workout_metrics_json: JSON.stringify({
      hr_sample_coverage_pct: 100,
      workout_effort_user_rated: 10,
      subjective_marker: 'coach-metrics-token',
    }),
  };
  try {
    await ai.generateRunBrief({
      run: legacyRun,
      profile: { name: 'Athlete', goal_type: 'fitness' },
      recentRuns: [legacyRun],
      recentLifts: [],
      userId: 'passive-coaching-brief',
    });
    await ai.generateLiftPlan({
      bodyPart: 'legs',
      timeAvailable: 30,
      profile: { name: 'Athlete' },
      recentSets: [],
      recentRuns: [legacyRun],
      userId: 'passive-coaching-lift',
    });
    await ai.generateWorkoutRecommendation({
      profile: { name: 'Athlete', goal_type: 'fitness' },
      recentRuns: [legacyRun],
      recentWorkouts: [],
      todayTraining: null,
      userId: 'passive-coaching-workout',
    });
    assert.equal(prompts.length, 3);
    for (const prompt of prompts) {
      assert.doesNotMatch(
        prompt,
        /coach-pain-token|coach-energy-token|coach-note-token|coach-metrics-token|perceived_effort|post_energy|workout_effort_user_rated/i,
        'AI coaching prompt excludes legacy subjective run fields',
      );
    }
  } finally {
    ai._test.resetClient();
  }
}

async function adaptationDecisionsFailClosed() {
  const routePath = require.resolve('../src/routes/plans');
  const source = fs.readFileSync(routePath, 'utf8');
  const currentStart = source.indexOf("router.get('/adaptation/current'");
  const runStart = source.indexOf("router.get('/adaptation/run/:runId'");
  const acceptStart = source.indexOf("router.post('/adaptation/:proposalId/accept'");
  assert(currentStart >= 0 && runStart > currentStart && acceptStart > runStart);
  assert.doesNotMatch(
    source.slice(currentStart, runStart),
    /persistAdaptationProposal|(?:INSERT|UPDATE|DELETE)\s+/i,
    'reading the current proposal cannot mutate persistence',
  );
  assert.doesNotMatch(
    source.slice(runStart, acceptStart),
    /persistRunAdaptation|(?:INSERT|UPDATE|DELETE)\s+/i,
    'reading run impact cannot mutate persistence',
  );

  const ownerId = 'phase-c-decision-owner';
  const wrongOwnerId = 'phase-c-wrong-owner';
  const planningDate = todayISO();
  const originalPlan = {
    schemaVersion: 2,
    weeks: [{ week: 1, days: [{
      date: planningDate,
      day: 'Tue',
      sessions: [{ kind: 'run', type: 'quality', title: 'Original run', distance_miles: 5 }],
    }] }],
  };
  const proposedPlan = JSON.parse(JSON.stringify(originalPlan));
  proposedPlan.weeks[0].days[0].sessions[0].title = 'Accepted replacement';
  const activeRow = {
    user_plan_id: 'decision-assignment',
    plan_id: 'decision-plan',
    id: 'decision-plan',
    user_id: ownerId,
    status: 'active',
    started_at: planningDate,
    effective_from: planningDate,
    progress_json: '{}',
    plan_data: JSON.stringify(originalPlan),
    plan_version: 1,
  };
  const proposalRow = {
    id: 'decision-proposal',
    user_id: ownerId,
    status: 'pending',
    trigger_run_id: null,
    planning_date: planningDate,
    window_start: planningDate,
    window_end: planningDate,
    safety_exception: 0,
    original_json: JSON.stringify(originalPlan),
    proposed_json: JSON.stringify(proposedPlan),
    changes_json: JSON.stringify([{ sessionId: 'decision-run', date: planningDate }]),
    evidence_json: '[]',
    reason: JSON.stringify({ headline: 'Proposal', reason: 'Passive evidence' }),
    plan_id: activeRow.id,
    user_plan_id: activeRow.user_plan_id,
  };
  const writes = [];
  const tx = {
    async get(sql, params = []) {
      if (/FROM plan_adjustment_proposals/.test(sql)) {
        return params.includes(ownerId) && params.includes(proposalRow.id) ? { ...proposalRow } : null;
      }
      if (/FROM user_plans up/.test(sql)) return params.includes(ownerId) ? { ...activeRow } : null;
      if (/FROM training_plans tp\s+JOIN user_plans owner_up/.test(sql)) {
        return params.includes(ownerId) && params.includes(activeRow.id) ? { ...activeRow } : null;
      }
      if (/FROM training_plans WHERE user_id/.test(sql)) return null;
      if (/FROM runs/.test(sql)) return null;
      throw new Error(`unexpected adaptation decision read: ${sql}`);
    },
    async run(sql, params = []) {
      writes.push({ sql, params });
      assert.match(sql, /user_id=\?|user_id = \?/i, 'every adaptation mutation stays owner-scoped');
      if (/plan_adjustment_proposals SET status='accepted'/.test(sql)) proposalRow.status = 'accepted';
      if (/plan_adjustment_proposals SET status='kept'/.test(sql)) proposalRow.status = 'kept';
      if (/UPDATE training_plans SET plan_data/.test(sql)) activeRow.plan_data = params[0];
      return { changes: 1 };
    },
  };
  const dbPath = require.resolve('../src/db');
  const originalDb = require.cache[dbPath];
  const originalRoute = require.cache[routePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dbGet: async () => null,
      dbAll: async () => [],
      dbRun: async () => ({ changes: 0 }),
      withUserMutation: async (_userId, callback) => callback(tx),
      withPlanningInputMutation: async (_userId, callback) => {
        const result = await callback(tx);
        return typeof result?.marker === 'symbol' ? result.value : result;
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[routePath];
  const responseFor = () => {
    const state = { statusCode: 200, payload: undefined };
    return {
      state,
      response: {
        status(code) { state.statusCode = code; return this; },
        json(value) { state.payload = value; return this; },
      },
    };
  };

  try {
    const router = require('../src/routes/plans');
    const active = { source: 'assigned', row: activeRow };
    proposalRow.plan_version = router._test.planVersionFor(
      active,
      router._test.canonicalAdaptationPlan(active),
    );
    const decisionBody = () => ({
      proposal_revision: router._test.proposalDecisionRevision(proposalRow),
      proposal_plan_version: proposalRow.plan_version,
    });
    const acceptHandler = routeHandler(router, '/adaptation/:proposalId/accept', 'post');
    const keepHandler = routeHandler(router, '/adaptation/:proposalId/keep', 'post');

    const accepted = responseFor();
    await acceptHandler({
      user: { id: ownerId }, params: { proposalId: proposalRow.id }, body: decisionBody(),
    }, accepted.response);
    assert.equal(accepted.state.statusCode, 200, JSON.stringify(accepted.state.payload));
    assert.equal(JSON.parse(activeRow.plan_data).weeks[0].days[0].sessions[0].title, 'Accepted replacement');
    assert(writes.some(({ sql }) => /UPDATE training_plans SET plan_data/.test(sql)), 'valid accept writes the reviewed replacement');

    const writesAfterAccept = writes.length;
    const acceptReplay = responseFor();
    await acceptHandler({
      user: { id: ownerId }, params: { proposalId: proposalRow.id }, body: decisionBody(),
    }, acceptReplay.response);
    assert.equal(acceptReplay.state.statusCode, 409, 'accepted proposal replay fails closed');
    assert.equal(writes.length, writesAfterAccept, 'accepted proposal replay is zero-write');

    proposalRow.status = 'pending';
    activeRow.plan_data = JSON.stringify(originalPlan);
    const keepWritesStart = writes.length;
    const kept = responseFor();
    await keepHandler({
      user: { id: ownerId }, params: { proposalId: proposalRow.id }, body: decisionBody(),
    }, kept.response);
    assert.equal(kept.state.statusCode, 200);
    assert.equal(activeRow.plan_data, JSON.stringify(originalPlan), 'keep leaves the accepted plan byte-equivalent');
    assert.equal(
      writes.slice(keepWritesStart).some(({ sql }) => /UPDATE (?:training_plans|user_plans)/.test(sql)),
      false,
      'keep never writes a plan row',
    );

    const writesAfterKeep = writes.length;
    const keepReplay = responseFor();
    await keepHandler({
      user: { id: ownerId }, params: { proposalId: proposalRow.id }, body: decisionBody(),
    }, keepReplay.response);
    assert.equal(keepReplay.state.statusCode, 409, 'kept proposal replay fails closed');
    assert.equal(writes.length, writesAfterKeep, 'kept proposal replay is zero-write');

    const wrongOwner = responseFor();
    await acceptHandler({
      user: { id: wrongOwnerId }, params: { proposalId: proposalRow.id }, body: decisionBody(),
    }, wrongOwner.response);
    assert.equal(wrongOwner.state.statusCode, 404, 'wrong-owner decision reveals no proposal');
    assert.equal(writes.length, writesAfterKeep, 'wrong-owner decision is zero-write');
  } finally {
    delete require.cache[routePath];
    if (originalRoute) require.cache[routePath] = originalRoute;
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
  }
}

const cases = {
  'legacy-checkin': legacyCheckinIsPassive,
  'legacy-overrides': legacyOverridesAreAuditOnly,
  'passive-adaptation': adaptationUsesPassiveEvidenceOnly,
  'passive-body-coach': bodyAndCoachUsePassiveDataOnly,
  'durable-run-feedback': durableRunSaveClaimsPassiveFeedbackOnce,
  'passive-feedback-prompt': runFeedbackPromptIsPassive,
  'passive-run-coaching': runCoachingSurfacesIgnoreSubjectiveRows,
  'passive-coaching-prompts': coachingPromptsUsePassiveRunsOnly,
  'adaptation-decisions': adaptationDecisionsFailClosed,
};

async function main() {
  const selected = process.argv[2];
  if (selected) {
    assert.equal(typeof cases[selected], 'function', `unknown Phase C case: ${selected}`);
    await cases[selected]();
    console.log(`STABLE PLAN PASSIVE AUTHORITY SMOKE OK (${selected})`);
    return;
  }
  for (const runCase of Object.values(cases)) await runCase();
  console.log(`STABLE PLAN PASSIVE AUTHORITY SMOKE OK (${Object.keys(cases).length})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
