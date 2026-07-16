#!/usr/bin/env node

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const {
  ACCOUNT_DELETE_QUERIES,
  ACCOUNT_SOCIAL_DELETE_QUERIES,
} = require('../src/lib/accountDataCoverage');

const USER_ID = 'account-delete-user';
const CHALLENGE_ID = 'account-delete-challenge';
const PASSWORD = 'correct-password';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, '$2a$04$abcdefghijklmnopqrstuu');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createScenario({ failOnSql = null } = {}) {
  const initialState = {
    user: true,
    challenge: true,
    ownerMembership: true,
    groupRun: true,
    passwordResetToken: true,
    pushSubscription: true,
    aiUsage: true,
    readinessScore: true,
    appFeedback: true,
  };
  const durableState = clone(initialState);
  const transactionRuns = [];
  let commits = 0;
  let rollbacks = 0;
  let outsideTransactionRuns = 0;
  let stateAtFailure = null;

  function applyRun(state, sql) {
    if (/^DELETE FROM challenges c/.test(sql)) state.challenge = false;
    if (/^DELETE FROM user_challenges target_uc/.test(sql)) state.ownerMembership = false;
    if (/^DELETE FROM group_runs /.test(sql)) state.groupRun = false;
    if (/^DELETE FROM password_reset_tokens /.test(sql)) state.passwordResetToken = false;
    if (/^DELETE FROM push_subscriptions /.test(sql)) state.pushSubscription = false;
    if (/^DELETE FROM ai_usage /.test(sql)) state.aiUsage = false;
    if (/^DELETE FROM readiness_scores /.test(sql)) state.readinessScore = false;
    if (/^DELETE FROM app_feedback /.test(sql)) state.appFeedback = false;
    if (/^DELETE FROM users /.test(sql)) state.user = false;
  }

  const db = {
    dbGet: async (sql, params) => {
      assert.match(sql, /^SELECT id, password_hash FROM users WHERE id = \?$/);
      assert.deepEqual(params, [USER_ID]);
      return durableState.user ? { id: USER_ID, password_hash: PASSWORD_HASH } : null;
    },
    dbAll: async () => [],
    dbRun: async () => {
      outsideTransactionRuns += 1;
      throw new Error('Account deletion wrote outside its transaction');
    },
    withTransaction: async (fn) => {
      const workingState = clone(durableState);
      const tx = {
        all: async (sql, params) => {
          assert.match(sql, /FROM challenges c/);
          assert.deepEqual(params, [USER_ID]);
          return workingState.challenge && workingState.ownerMembership
            ? [{ id: CHALLENGE_ID, template_type: 'running_distance' }]
            : [];
        },
        get: async (sql, params) => {
          assert.match(sql, /FROM user_challenges/);
          assert.deepEqual(params, [CHALLENGE_ID, USER_ID]);
          return null;
        },
        run: async (sql, params = []) => {
          const normalizedSql = sql.trim();
          transactionRuns.push({ sql: normalizedSql, params: [...params] });
          assert.ok(params.includes(USER_ID), `Destructive query must bind ${USER_ID}: ${normalizedSql}`);

          if (failOnSql && normalizedSql.startsWith(failOnSql)) {
            stateAtFailure = clone(workingState);
            throw new Error(`relation \"${failOnSql.split(' ')[2]}\" does not exist`);
          }

          applyRun(workingState, normalizedSql);
          return { changes: 1 };
        },
      };

      try {
        const result = await fn(tx);
        Object.assign(durableState, workingState);
        commits += 1;
        return result;
      } catch (err) {
        rollbacks += 1;
        throw err;
      }
    },
  };

  return {
    db,
    durableState,
    initialState,
    transactionRuns,
    metrics: () => ({ commits, rollbacks, outsideTransactionRuns, stateAtFailure }),
  };
}

async function invokeDeleteHandler(handler) {
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };

  await handler({
    body: { password: PASSWORD, confirm: 'DELETE' },
    user: { id: USER_ID },
  }, res);

  return { statusCode, payload };
}

async function runAccountDeletionAtomicitySmoke() {
  const dbModulePath = require.resolve('../src/db');
  const authRoutePath = require.resolve('../src/routes/auth');
  const originalDbModule = require.cache[dbModulePath];
  const originalAuthRoute = require.cache[authRoutePath];
  const originalConsoleError = console.error;
  const failure = createScenario({ failOnSql: 'DELETE FROM app_feedback' });
  const loggedErrors = [];

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: failure.db,
    children: [],
    paths: [],
  };
  delete require.cache[authRoutePath];

  try {
    const authRouter = require('../src/routes/auth');
    const route = authRouter.stack.find((layer) => layer.route?.path === '/account' && layer.route?.methods?.delete);
    const handler = route?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof handler, 'function', 'DELETE /account handler must be registered');

    console.error = (...args) => loggedErrors.push(args.map(String).join(' '));
    const failedResponse = await invokeDeleteHandler(handler);
    console.error = originalConsoleError;

    const failedMetrics = failure.metrics();
    assert.deepEqual(failedResponse, {
      statusCode: 500,
      payload: { error: 'Failed to delete account' },
    });
    assert.equal(failedMetrics.commits, 0);
    assert.equal(failedMetrics.rollbacks, 1);
    assert.equal(failedMetrics.outsideTransactionRuns, 0);
    assert.equal(failedMetrics.stateAtFailure.challenge, false, 'challenge cleanup must run before the injected failure');
    assert.equal(failedMetrics.stateAtFailure.groupRun, false, 'social cleanup must run before the injected failure');
    assert.equal(failedMetrics.stateAtFailure.passwordResetToken, false, 'account cleanup must begin before the injected failure');
    assert.equal(failedMetrics.stateAtFailure.readinessScore, false, 'failure must occur mid-delete');
    assert.deepEqual(failure.durableState, failure.initialState, 'mid-delete failure must roll back every prior deletion');
    assert.match(loggedErrors.join('\n'), /\[auth\/delete-account\] failed deleting app_feedback: relation \"app_feedback\" does not exist/);

    const success = createScenario();
    require.cache[dbModulePath].exports = success.db;
    delete require.cache[authRoutePath];
    const successRouter = require('../src/routes/auth');
    const successRoute = successRouter.stack.find((layer) => layer.route?.path === '/account' && layer.route?.methods?.delete);
    const successHandler = successRoute?.route?.stack?.at(-1)?.handle;
    const successResponse = await invokeDeleteHandler(successHandler);
    const successMetrics = success.metrics();

    assert.deepEqual(successResponse, { statusCode: 200, payload: { ok: true } });
    assert.equal(successMetrics.commits, 1);
    assert.equal(successMetrics.rollbacks, 0);
    assert.equal(successMetrics.outsideTransactionRuns, 0);
    assert.equal(success.durableState.user, false);
    assert.equal(success.transactionRuns.at(-1)?.sql, 'DELETE FROM users WHERE id = ?');
    assert.deepEqual(success.transactionRuns.at(-1)?.params, [USER_ID]);

    const executedSql = new Set(success.transactionRuns.map(({ sql }) => sql));
    for (const [sql] of [...ACCOUNT_SOCIAL_DELETE_QUERIES, ...ACCOUNT_DELETE_QUERIES]) {
      assert.ok(executedSql.has(sql), `Transactional account deletion must execute: ${sql}`);
    }
  } finally {
    console.error = originalConsoleError;
    delete require.cache[authRoutePath];
    if (originalAuthRoute) require.cache[authRoutePath] = originalAuthRoute;
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
  }
}

if (require.main === module) {
  runAccountDeletionAtomicitySmoke()
    .then(() => console.log('Account deletion atomicity smoke OK.'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { runAccountDeletionAtomicitySmoke };
