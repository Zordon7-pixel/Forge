const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  GOAL_BACKWARD_V24_AUDIENCES,
  authoritativePlanTarget,
  assertApplyAuthorized,
  assertRedactedBackup,
  buildBackupManifest,
  buildGoalBackwardReleaseTelemetry,
  clearGoalBackwardReleaseTelemetry,
  emitGoalBackwardReleaseTelemetry,
  evaluateGoalBackwardReleaseAlerts,
  getGoalBackwardV24Audience,
  isCurrentRolloutPlan,
  localDateForOffset,
  preservedPlanTarget,
  redactedBackupEntry,
  resolveOperationalGoalBackwardV24Mode,
  selectProtectedRaces,
  targetRef,
} = require('../src/lib/betaPlanRollout');
const { RACE_PLAN_POLICY_V1 } = require('../src/lib/racePlanPolicy');
const { resolveRunSchedule } = require('../src/lib/runSchedule');
const rolloutScript = require('../scripts/upgrade-beta-race-plans');
const plansRouter = require('../src/routes/plans');

async function run() {
  const disposableId = '00000000-0000-4000-8000-000000000024';
  const disposableRef = targetRef(disposableId);
  const cohort = { userId: disposableId, cohortRefs: [disposableRef], alertEntries: [] };
  const publicAccountId = '6f1d5c70-7bd7-4dce-8f20-e599ca5e73f2';
  assert.deepEqual(GOAL_BACKWARD_V24_AUDIENCES, ['cohort', 'all']);
  assert.equal(getGoalBackwardV24Audience('cohort'), 'cohort');
  assert.equal(getGoalBackwardV24Audience('all'), 'all');
  for (const invalidAudience of [null, false, [], new String('all'), ' all ', 'public', 'ALL']) {
    assert.equal(
      getGoalBackwardV24Audience(invalidAudience),
      'cohort',
      `invalid audience fails closed: ${JSON.stringify(invalidAudience)}`,
    );
  }
  assert.equal(resolveOperationalGoalBackwardV24Mode(), 'off');
  assert.equal(resolveOperationalGoalBackwardV24Mode('off'), 'off');
  assert.equal(resolveOperationalGoalBackwardV24Mode('shadow'), 'off', 'non-off modes require cohort authority');
  assert.equal(resolveOperationalGoalBackwardV24Mode('shadow', cohort), 'shadow');
  assert.equal(resolveOperationalGoalBackwardV24Mode('preview', cohort), 'preview');
  assert.equal(resolveOperationalGoalBackwardV24Mode('on', cohort), 'on');
  assert.equal(
    resolveOperationalGoalBackwardV24Mode('on', {
      userId: publicAccountId,
      audience: 'all',
      alertEntries: [],
    }),
    'on',
    'the public audience authorizes a production-shaped UUID account',
  );
  for (const syntheticId of ['', 'synthetic-athlete', 'test-user', 'user-123']) {
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', {
        userId: syntheticId,
        audience: 'all',
        alertEntries: [],
      }),
      'off',
      `the public audience rejects a synthetic account ID: ${JSON.stringify(syntheticId)}`,
    );
  }
  for (const invalidAudience of [' all ', 'public', 'ALL']) {
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', {
        userId: publicAccountId,
        audience: invalidAudience,
        cohortRefs: [],
        alertEntries: [],
      }),
      'off',
      `an invalid audience is never promoted to public: ${JSON.stringify(invalidAudience)}`,
    );
  }
  const originalAuthorityEnvironment = {
    mode: process.env.FORGE_GOAL_BACKWARD_V24_MODE,
    audience: process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE,
    cohortRefs: process.env.FORGE_GOAL_BACKWARD_V24_DISPOSABLE_COHORT_REFS,
  };
  try {
    delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    delete process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE;
    delete process.env.FORGE_GOAL_BACKWARD_V24_DISPOSABLE_COHORT_REFS;

    const inheritedAudienceOptions = Object.assign(Object.create({ audience: 'all' }), {
      userId: publicAccountId,
      cohortRefs: [],
      alertEntries: [],
    });
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', inheritedAudienceOptions),
      'off',
      'an inherited public audience cannot widen an injected cohort decision',
    );

    let audienceGetterCalls = 0;
    const getterAudienceOptions = { userId: publicAccountId, cohortRefs: [], alertEntries: [] };
    Object.defineProperty(getterAudienceOptions, 'audience', {
      enumerable: true,
      get() {
        audienceGetterCalls += 1;
        return 'all';
      },
    });
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', getterAudienceOptions),
      'off',
      'an audience accessor cannot authorize the public rollout',
    );
    assert.equal(audienceGetterCalls, 0, 'audience accessors are not invoked during authority validation');
    let throwingGetterCalls = 0;
    const throwingAudienceOptions = { userId: publicAccountId, cohortRefs: [], alertEntries: [] };
    Object.defineProperty(throwingAudienceOptions, 'audience', {
      enumerable: true,
      get() {
        throwingGetterCalls += 1;
        throw new Error('authority getter must not run');
      },
    });
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', throwingAudienceOptions),
      'off',
      'a throwing audience accessor fails closed without escaping',
    );
    assert.equal(throwingGetterCalls, 0, 'throwing authority accessors are not invoked');

    let proxyTrapCalls = 0;
    const proxyAuthority = new Proxy({
      userId: publicAccountId,
      audience: 'all',
      alertEntries: [],
    }, {
      get() {
        proxyTrapCalls += 1;
        throw new Error('authority get trap must not run');
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error('authority descriptor trap must not run');
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error('authority prototype trap must not run');
      },
    });
    let proxyResolution = 'threw';
    try {
      proxyResolution = resolveOperationalGoalBackwardV24Mode('on', proxyAuthority);
    } catch (_error) {
      // The assertion below records the fail-closed contract without allowing the hostile trap to escape.
    }
    assert.equal(proxyResolution, 'off', 'a Proxy authority object fails closed');
    assert.equal(proxyTrapCalls, 0, 'Proxy traps are not invoked during authority validation');

    class NonPlainAuthority {
      constructor() {
        this.userId = publicAccountId;
        this.audience = 'all';
        this.alertEntries = [];
      }
    }
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', new NonPlainAuthority()),
      'off',
      'a non-plain authority object cannot authorize the public rollout',
    );
    let audienceCoercionCalls = 0;
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', {
        userId: publicAccountId,
        audience: {
          [Symbol.toPrimitive]() {
            audienceCoercionCalls += 1;
            return 'all';
          },
        },
        alertEntries: [],
      }),
      'off',
      'a coercible audience value cannot authorize the public rollout',
    );
    assert.equal(audienceCoercionCalls, 0, 'audience coercion hooks are not invoked');
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', {
        userId: publicAccountId,
        audience: 'all',
        alertEntries: [],
      }),
      'on',
      'an exact own public audience data property remains authorized for a production UUID',
    );

    const resolveInjectedMode = plansRouter._test.resolvePlanGoalBackwardV24Mode;
    const inheritedModeDependencies = Object.assign(Object.create({ mode: 'on' }), {
      audience: 'all',
      alertEntries: [],
    });
    assert.equal(
      resolveInjectedMode(publicAccountId, inheritedModeDependencies),
      'off',
      'an inherited injected mode cannot activate the public rollout',
    );
    let modeGetterCalls = 0;
    const getterModeDependencies = { audience: 'all', alertEntries: [] };
    Object.defineProperty(getterModeDependencies, 'mode', {
      enumerable: true,
      get() {
        modeGetterCalls += 1;
        return 'on';
      },
    });
    assert.equal(
      resolveInjectedMode(publicAccountId, getterModeDependencies),
      'off',
      'an injected mode accessor cannot activate the public rollout',
    );
    assert.equal(modeGetterCalls, 0, 'mode accessors are not invoked during authority validation');

    const inheritedUserOptions = Object.assign(Object.create({ userId: publicAccountId }), {
      audience: 'all',
      alertEntries: [],
    });
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', inheritedUserOptions),
      'off',
      'an inherited user ID cannot authorize the public rollout',
    );
    let userCoercionCalls = 0;
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', {
        userId: {
          [Symbol.toPrimitive]() {
            userCoercionCalls += 1;
            return publicAccountId;
          },
        },
        audience: 'all',
        alertEntries: [],
      }),
      'off',
      'a coercible user ID cannot authorize the public rollout',
    );
    assert.equal(userCoercionCalls, 0, 'user ID coercion hooks are not invoked during authority validation');

    const inheritedCohortOptions = Object.assign(Object.create({ cohortRefs: [disposableRef] }), {
      userId: disposableId,
      audience: 'cohort',
      alertEntries: [],
    });
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', inheritedCohortOptions),
      'off',
      'inherited cohort refs cannot authorize an injected cohort decision',
    );
    let cohortCoercionCalls = 0;
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', {
        userId: disposableId,
        audience: 'cohort',
        cohortRefs: {
          [Symbol.toPrimitive]() {
            cohortCoercionCalls += 1;
            return disposableRef;
          },
        },
        alertEntries: [],
      }),
      'off',
      'coercible cohort refs cannot authorize an injected cohort decision',
    );
    assert.equal(cohortCoercionCalls, 0, 'cohort ref coercion hooks are not invoked during authority validation');

    const inheritedSyntheticOptions = Object.assign(Object.create({ allowSyntheticShadow: true }), {
      userId: 'synthetic-shadow-athlete',
      audience: 'cohort',
      cohortRefs: [],
      alertEntries: [],
    });
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('shadow', inheritedSyntheticOptions),
      'off',
      'inherited synthetic-shadow authority cannot widen a cohort decision',
    );
    let syntheticGetterCalls = 0;
    const getterSyntheticOptions = {
      userId: 'synthetic-shadow-athlete',
      audience: 'cohort',
      cohortRefs: [],
      alertEntries: [],
    };
    Object.defineProperty(getterSyntheticOptions, 'allowSyntheticShadow', {
      enumerable: true,
      get() {
        syntheticGetterCalls += 1;
        return true;
      },
    });
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('shadow', getterSyntheticOptions),
      'off',
      'a synthetic-shadow accessor cannot widen a cohort decision',
    );
    assert.equal(syntheticGetterCalls, 0, 'synthetic-shadow accessors are not invoked during authority validation');

    const originalPrototypeAudience = Object.getOwnPropertyDescriptor(Object.prototype, 'audience');
    try {
      Object.defineProperty(Object.prototype, 'audience', {
        configurable: true,
        value: 'all',
      });
      const pollutedDependencies = { mode: 'on', cohortRefs: [], alertEntries: [] };
      const previewMode = resolveInjectedMode(publicAccountId, pollutedDependencies, {
        allowSyntheticShadow: true,
      });
      const applyMode = resolveInjectedMode(publicAccountId, pollutedDependencies);
      assert.deepEqual(
        { previewMode, applyMode },
        { previewMode: 'off', applyMode: 'off' },
        'preview and apply remain equally non-public under prototype pollution',
      );
    } finally {
      if (originalPrototypeAudience) {
        Object.defineProperty(Object.prototype, 'audience', originalPrototypeAudience);
      } else {
        delete Object.prototype.audience;
      }
    }
  } finally {
    for (const [key, value] of Object.entries(originalAuthorityEnvironment)) {
      const environmentKey = {
        mode: 'FORGE_GOAL_BACKWARD_V24_MODE',
        audience: 'FORGE_GOAL_BACKWARD_V24_AUDIENCE',
        cohortRefs: 'FORGE_GOAL_BACKWARD_V24_DISPOSABLE_COHORT_REFS',
      }[key];
      if (value === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = value;
    }
  }
  const originalAudience = process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE;
  try {
    delete process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE;
    assert.equal(getGoalBackwardV24Audience(), 'cohort');
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', {
        userId: publicAccountId,
        cohortRefs: [],
        alertEntries: [],
      }),
      'off',
      'a missing audience is not public',
    );
  } finally {
    if (originalAudience === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE;
    else process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE = originalAudience;
  }
  assert.equal(
    resolveOperationalGoalBackwardV24Mode('on', {
      userId: publicAccountId,
      audience: 'all',
      alertEntries: [{}],
    }),
    'off',
    'a zero-tolerance release alert forces the public audience off',
  );
  const hermesBreachedAlertEntries = [{}];
  let hermesAlertProxyTrapCalls = 0;
  const hermesHiddenBreachedAlerts = new Proxy(hermesBreachedAlertEntries, {
    get(target, property, receiver) {
      hermesAlertProxyTrapCalls += 1;
      if (property === Symbol.iterator) return function* hiddenAlerts() {};
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual({
    plainOperational: resolveOperationalGoalBackwardV24Mode('on', {
      userId: publicAccountId,
      audience: 'all',
      alertEntries: hermesBreachedAlertEntries,
    }),
    proxyOperational: resolveOperationalGoalBackwardV24Mode('on', {
      userId: publicAccountId,
      audience: 'all',
      alertEntries: hermesHiddenBreachedAlerts,
    }),
    proxyRoute: plansRouter._test.resolvePlanGoalBackwardV24Mode(publicAccountId, {
      mode: 'on',
      audience: 'all',
      alertEntries: hermesHiddenBreachedAlerts,
    }),
    proxyTrapCalls: hermesAlertProxyTrapCalls,
  }, {
    plainOperational: 'off',
    proxyOperational: 'off',
    proxyRoute: 'off',
    proxyTrapCalls: 0,
  }, 'a Proxy cannot hide the same breached alert history from either resolver');
  assert.deepEqual(
    evaluateGoalBackwardReleaseAlerts(hermesHiddenBreachedAlerts),
    {
      threshold_policy: 'goal_backward_release_zero_tolerance_v1',
      breached_thresholds: ['TELEMETRY_REDACTION_VIOLATION'],
      rollback_required: true,
    },
    'an invalid alert history is an explicit rollback-required condition',
  );
  assert.equal(hermesAlertProxyTrapCalls, 0, 'alert evaluation does not invoke the hiding Proxy');

  const resolvePublicAlertModes = (alertEntries) => {
    const capture = (operation) => {
      try {
        return operation();
      } catch (_error) {
        return 'threw';
      }
    };
    return {
      operational: capture(() => resolveOperationalGoalBackwardV24Mode('on', {
        userId: publicAccountId,
        audience: 'all',
        alertEntries,
      })),
      route: capture(() => plansRouter._test.resolvePlanGoalBackwardV24Mode(publicAccountId, {
        mode: 'on',
        audience: 'all',
        alertEntries,
      })),
    };
  };
  const safeReleaseEvent = buildGoalBackwardReleaseTelemetry({
    targetRef: targetRef(publicAccountId),
    eventType: 'mode_resolution',
    mode: 'on',
    outcome: 'candidate_selected',
    candidateSelected: true,
    passReasonCodes: ['PASS'],
    surfaceCapability: 'PREVIEW_ONLY',
  });
  const breachedReleaseEvent = buildGoalBackwardReleaseTelemetry({
    targetRef: targetRef(publicAccountId),
    eventType: 'candidate_outcome',
    mode: 'on',
    outcome: 'apply_rejected',
    failReasonCodes: ['HARD_VALIDATOR_BYPASS'],
    surfaceCapability: 'BLOCKED',
  });
  const revisionMismatchReleaseEvent = buildGoalBackwardReleaseTelemetry({
    targetRef: targetRef(publicAccountId),
    eventType: 'surface_capability',
    mode: 'on',
    outcome: 'revision_mismatch',
    failReasonCodes: ['REVISION_MISMATCH'],
    surfaceCapability: 'BLOCKED',
    revisionMismatch: true,
  });
  assert.deepEqual(
    resolvePublicAlertModes([]),
    { operational: 'on', route: 'on' },
    'a safe exact empty injected alert history leaves public authority on',
  );
  assert.equal(
    evaluateGoalBackwardReleaseAlerts([]).rollback_required,
    false,
    'a safe exact empty alert history does not request rollback',
  );
  assert.deepEqual(
    resolvePublicAlertModes([safeReleaseEvent]),
    { operational: 'on', route: 'on' },
    'legitimate safe release telemetry leaves both resolvers on',
  );
  assert.deepEqual(
    resolvePublicAlertModes([breachedReleaseEvent]),
    { operational: 'off', route: 'off' },
    'legitimate zero-tolerance release telemetry forces both resolvers off',
  );
  assert.deepEqual(
    resolvePublicAlertModes([revisionMismatchReleaseEvent]),
    { operational: 'off', route: 'off' },
    'legitimate revision-mismatch telemetry forces both resolvers off',
  );
  clearGoalBackwardReleaseTelemetry();
  try {
    emitGoalBackwardReleaseTelemetry(breachedReleaseEvent, { sink: () => {} });
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('on', {
        userId: publicAccountId,
        audience: 'all',
      }),
      'off',
      'trusted runtime telemetry in the bounded internal buffer still forces rollback',
    );
  } finally {
    clearGoalBackwardReleaseTelemetry();
  }

  let forbiddenAlertHookCalls = 0;
  const alertArrayProxy = new Proxy([safeReleaseEvent], {
    get(target, property, receiver) {
      forbiddenAlertHookCalls += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const revokedAlertArray = Proxy.revocable([safeReleaseEvent], {});
  revokedAlertArray.revoke();
  class AlertHistorySubclass extends Array {}
  const sparseAlertArray = new Array(1);
  const accessorAlertArray = [];
  Object.defineProperty(accessorAlertArray, '0', {
    configurable: true,
    enumerable: true,
    get() {
      forbiddenAlertHookCalls += 1;
      return safeReleaseEvent;
    },
  });
  const iteratorOverrideAlertArray = [safeReleaseEvent];
  Object.defineProperty(iteratorOverrideAlertArray, Symbol.iterator, {
    configurable: true,
    value() {
      forbiddenAlertHookCalls += 1;
      return [][Symbol.iterator]();
    },
  });
  const coercibleAlertHistory = {
    [Symbol.iterator]() {
      forbiddenAlertHookCalls += 1;
      return [safeReleaseEvent][Symbol.iterator]();
    },
    [Symbol.toPrimitive]() {
      forbiddenAlertHookCalls += 1;
      return '';
    },
  };
  const invalidAlertHistories = [
    ['array Proxy', alertArrayProxy],
    ['revoked array Proxy', revokedAlertArray.proxy],
    ['array subclass', new AlertHistorySubclass()],
    ['sparse array', sparseAlertArray],
    ['array index accessor', accessorAlertArray],
    ['array iterator override', iteratorOverrideAlertArray],
    ['over-limit array', new Array(257).fill(safeReleaseEvent)],
    ['non-array object', {}],
    ['coercible iterable object', coercibleAlertHistory],
  ];
  for (const [label, alertEntries] of invalidAlertHistories) {
    assert.deepEqual(
      resolvePublicAlertModes(alertEntries),
      { operational: 'off', route: 'off' },
      `${label} alert history fails closed in both resolvers`,
    );
  }

  const cloneReleaseEvent = (overrides = {}) => ({
    ...safeReleaseEvent,
    policy_versions: { ...safeReleaseEvent.policy_versions },
    reason_counts: Object.fromEntries(Object.entries(safeReleaseEvent.reason_counts).map(
      ([code, counts]) => [code, { ...counts }],
    )),
    ...overrides,
  });
  const eventProxy = new Proxy(safeReleaseEvent, {
    get(target, property, receiver) {
      forbiddenAlertHookCalls += 1;
      return Reflect.get(target, property, receiver);
    },
    ownKeys(target) {
      forbiddenAlertHookCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  class ReleaseEventSubclass {}
  const nonPlainEvent = Object.assign(new ReleaseEventSubclass(), cloneReleaseEvent());
  const accessorEvent = cloneReleaseEvent();
  Object.defineProperty(accessorEvent, 'mode', {
    configurable: true,
    enumerable: true,
    get() {
      forbiddenAlertHookCalls += 1;
      return 'on';
    },
  });
  const policyProxy = new Proxy({ ...safeReleaseEvent.policy_versions }, {
    get(target, property, receiver) {
      forbiddenAlertHookCalls += 1;
      return Reflect.get(target, property, receiver);
    },
    ownKeys(target) {
      forbiddenAlertHookCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  const accessorPolicy = { ...safeReleaseEvent.policy_versions };
  Object.defineProperty(accessorPolicy, 'planning_policy_version', {
    configurable: true,
    enumerable: true,
    get() {
      forbiddenAlertHookCalls += 1;
      return safeReleaseEvent.policy_versions.planning_policy_version;
    },
  });
  const reasonCountsProxy = new Proxy(safeReleaseEvent.reason_counts, {
    get(target, property, receiver) {
      forbiddenAlertHookCalls += 1;
      return Reflect.get(target, property, receiver);
    },
    ownKeys(target) {
      forbiddenAlertHookCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  const accessorCount = { pass: 1 };
  Object.defineProperty(accessorCount, 'fail', {
    configurable: true,
    enumerable: true,
    get() {
      forbiddenAlertHookCalls += 1;
      return 0;
    },
  });
  const invalidReleaseEvents = [
    ['event Proxy', eventProxy],
    ['non-plain event', nonPlainEvent],
    ['event accessor', accessorEvent],
    ['event unknown key', { ...cloneReleaseEvent(), payload: {} }],
    ['policy Proxy', cloneReleaseEvent({ policy_versions: policyProxy })],
    ['policy accessor', cloneReleaseEvent({ policy_versions: accessorPolicy })],
    ['sparse nested policy array', cloneReleaseEvent({ policy_versions: new Array(11) })],
    ['unknown policy shape', cloneReleaseEvent({
      policy_versions: { ...safeReleaseEvent.policy_versions, unexpected_version: 1 },
    })],
    ['reason-counts Proxy', cloneReleaseEvent({ reason_counts: reasonCountsProxy })],
    ['sparse nested reason-counts array', cloneReleaseEvent({ reason_counts: new Array(1) })],
    ['count accessor', cloneReleaseEvent({ reason_counts: { PASS: accessorCount } })],
    ['invalid negative count', cloneReleaseEvent({
      reason_counts: { PASS: { pass: 1, fail: -1 } },
    })],
    ['unknown count shape', cloneReleaseEvent({
      reason_counts: { PASS: { pass: 1, fail: 0, total: 1 } },
    })],
  ];
  for (const [label, event] of invalidReleaseEvents) {
    assert.deepEqual(
      resolvePublicAlertModes([event]),
      { operational: 'off', route: 'off' },
      `${label} fails closed in both resolvers`,
    );
  }
  assert.equal(
    forbiddenAlertHookCalls,
    0,
    'alert histories and nested telemetry are validated without invoking forbidden hooks',
  );
  assert.equal(
    resolveOperationalGoalBackwardV24Mode('shadow', {
      userId: 'hyrox-army-owner',
      cohortRefs: [],
      allowSyntheticShadow: true,
    }),
    'shadow',
    'the explicit test-only compatibility path retains shipped shadow diagnostics for synthetic IDs',
  );
  assert.equal(
    resolveOperationalGoalBackwardV24Mode('shadow', {
      userId: disposableId,
      cohortRefs: [],
      allowSyntheticShadow: true,
    }),
    'off',
    'the compatibility path cannot bypass cohort isolation for production-shaped IDs',
  );
  const smokeEntryPoint = process.argv[1];
  try {
    process.argv[1] = path.resolve(__dirname, '../src/app.js');
    assert.equal(
      resolveOperationalGoalBackwardV24Mode('shadow', {
        userId: 'hyrox-army-owner',
        cohortRefs: [],
        allowSyntheticShadow: true,
      }),
      'off',
      'a normal application process cannot enter the synthetic smoke compatibility path',
    );
  } finally {
    process.argv[1] = smokeEntryPoint;
  }
  assert.equal(resolveOperationalGoalBackwardV24Mode('garbage'), 'off');

  const races = [
    { id: 'race-early', race_date: '2026-09-01', status: 'upcoming' },
    { id: 'race-a1', race_date: '2026-09-20', status: 'upcoming' },
    { id: 'race-a2', race_date: '2026-10-11', status: 'upcoming' },
    { id: 'race-past', race_date: '2026-07-01', status: 'upcoming' },
  ];
  const activePlan = {
    planMode: 'hybrid_maintain',
    goals: [{ raceId: 'race-a1' }, { raceId: 'race-a2' }],
    schedulePreferences: { trainingDays: [1, 3, 5, 6], runDaysPerWeek: 4 },
    strengthPolicy: { enabled: true, sessionsPerWeek: 3, goal: 'maintain', equipment: ['dumbbells'] },
  };
  const currentProfile = {
    run_days_per_week: 5,
    lift_days_per_week: 1,
    preferred_workout_days: JSON.stringify(['Mon', 'Tue', 'Wed', 'Thu', 'Sat']),
  };
  assert.deepEqual(
    selectProtectedRaces(races, activePlan, '2026-08-08').map((race) => race.id),
    ['race-a1', 'race-a2'],
    'existing protected race goals take precedence over an unrelated earlier race',
  );
  assert.deepEqual(
    selectProtectedRaces(races, { goals: [{ raceId: 'race-a2' }] }, '2026-08-08').map((race) => race.id),
    ['race-a2'],
    'a one-race plan stays a one-race plan during rollout',
  );
  assert.deepEqual(selectProtectedRaces(races, {}, '2026-08-08'), [], 'rollout never guesses a race for an unanchored plan');
  assert.deepEqual(
    selectProtectedRaces(races, { goals: [{ raceId: 'missing-race' }] }, '2026-08-08'),
    [],
    'rollout refuses a plan whose protected race no longer belongs to the account',
  );

  const target = preservedPlanTarget(activePlan, currentProfile);
  assert.equal(Object.hasOwn(target, 'trainingDays'), false, 'rollout never sends stale plan weekdays as an explicit target');
  assert.equal(Object.hasOwn(target, 'runDaysPerWeek'), false, 'rollout never sends stale plan frequency as an explicit target');
  assert.equal(Object.hasOwn(target, 'liftDaysPerWeek'), false, 'rollout never sends stale plan lift frequency as an explicit target');
  assert.equal(target.planMode, 'hybrid_maintain');
  assert.equal(target.liftingEnabled, true);
  assert.deepEqual(target.equipment, ['dumbbells']);
  assert.deepEqual(resolveRunSchedule(currentProfile, target, { requireCompleteSelection: true }), {
    valid: true,
    runDaysPerWeek: 5,
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
    runDaysSource: 'profile',
    trainingDaysSource: 'profile',
    explicitSelection: false,
    legacyAdjusted: false,
  }, 'candidate generation reads the current profile without creating an apply-time profile write');
  assert.equal(
    Number(target.liftDaysPerWeek || currentProfile.lift_days_per_week),
    1,
    'candidate generation reads current profile lift frequency instead of the stale active plan',
  );
  assert.equal(authoritativePlanTarget(activePlan, { ...currentProfile, preferred_workout_days: null }).valid, false);
  assert.equal(authoritativePlanTarget(activePlan, { ...currentProfile, lift_days_per_week: null }).valid, false);
  assert.equal(authoritativePlanTarget({ ...activePlan, planMode: '' }, currentProfile).valid, false);
  assert.equal(authoritativePlanTarget({ ...activePlan, strengthPolicy: { enabled: false } }, currentProfile).valid, false);
  assert.equal(
    authoritativePlanTarget({
      ...activePlan,
      strengthPolicy: { enabled: true, sessionsPerWeek: 2, goal: 'maintain' },
    }, currentProfile).valid,
    false,
    'lifting rollout requires an authoritative equipment selection',
  );
  assert.deepEqual(
    preservedPlanTarget({
      ...activePlan,
      planMode: 'run_only',
      strengthPolicy: {},
    }, currentProfile).equipment,
    [],
    'run-only rollout does not require strength equipment',
  );
  assert.equal(isCurrentRolloutPlan({
    ...activePlan,
    engineVersion: RACE_PLAN_POLICY_V1.engineVersion,
    invariantVersion: RACE_PLAN_POLICY_V1.invariantVersion,
    policyVersion: RACE_PLAN_POLICY_V1.version,
  }, ['race-a2', 'race-a1']), true);
  assert.equal(isCurrentRolloutPlan({
    ...activePlan,
    engineVersion: RACE_PLAN_POLICY_V1.engineVersion,
    policyVersion: RACE_PLAN_POLICY_V1.version,
  }, ['race-a2', 'race-a1']), false, 'rollout invariant version is part of current-plan identity');
  assert.equal(isCurrentRolloutPlan(activePlan, ['race-a1', 'race-a2']), false);

  assert.equal(localDateForOffset('2026-08-08T02:00:00.000Z', 240), '2026-08-07');
  assert.equal(localDateForOffset('2026-08-08T02:00:00.000Z', -600), '2026-08-08');
  assert.throws(() => localDateForOffset(new Date(), 900), /between -840 and 840/);

  assert.doesNotThrow(() => assertApplyAuthorized({ apply: false }));
  assert.throws(
    () => assertApplyAuthorized({ apply: true, confirmation: RACE_PLAN_POLICY_V1.rollout.betaApplyConfirmation, betaAccessEnabled: false }),
    /FORGE_BETA_ACCESS/,
  );
  assert.throws(
    () => assertApplyAuthorized({ apply: true, confirmation: 'WRONG', betaAccessEnabled: true }),
    /Apply requires/,
  );
  assert.doesNotThrow(() => assertApplyAuthorized({
    apply: true,
    confirmation: RACE_PLAN_POLICY_V1.rollout.betaApplyConfirmation,
    betaAccessEnabled: true,
  }));

  assert.equal(rolloutScript.parseArgs([]).apply, false, 'rollout defaults to a no-write dry run');
  assert.throws(() => rolloutScript.parseArgs(['--apply']), /explicit --user-id/);
  assert.throws(() => rolloutScript.parseArgs(['--apply', `--user-id=${disposableId}`]), /--backup-dir is required/);
  assert.throws(() => rolloutScript.parseArgs([
    '--apply',
    `--user-id=${disposableId}`,
    `--backup-dir=${path.resolve(__dirname, '../rollout-backup')}`,
  ]), /outside the repository checkout/);
  const parsed = rolloutScript.parseArgs([
    '--apply',
    '--backup-dir=/tmp/forged-rollout-test',
    '--confirm=APPLY_GOAL_BACKWARD_V24',
    `--user-id=${disposableId}`,
    `--user-id=${disposableId}`,
  ]);
  assert.equal(parsed.apply, true);
  assert.deepEqual(parsed.userIds, [disposableId]);
  assert.throws(
    () => rolloutScript.parseArgs(['--planning-date=2026-08-08']),
    /Operator-supplied planning clocks are not accepted/,
  );
  assert.throws(
    () => rolloutScript.parseArgs(['--timezone-offset-minutes=240']),
    /Operator-supplied planning clocks are not accepted/,
  );

  const now = new Date('2026-08-08T16:00:00.000Z');
  const nativeProps = {
    app_id: 'com.zordontech.forge',
    app_version: '1.0.5',
    build_number: 19,
    native_runtime: true,
    platform: 'ios_native',
    timezone_offset_minutes: 240,
  };
  assert.deepEqual(
    rolloutScript.clockFromNativeAppOpen({ props: nativeProps, created_at: '2026-08-08T15:00:00.000Z' }, now),
    {
      authoritative: true,
      planningDateLocal: '2026-08-08',
      timezoneOffsetMinutes: 240,
      source: 'fresh_native_ios_app_open',
    },
  );
  assert.equal(
    rolloutScript.clockFromNativeAppOpen({ props: nativeProps, created_at: '2026-08-07T15:59:59.000Z' }, now),
    null,
    'native timezone authority expires after the observation window',
  );
  for (const malformedOffset of ['   ', '\t', false, [], {}]) {
    assert.equal(
      rolloutScript.clockFromNativeAppOpen({
        props: { ...nativeProps, timezone_offset_minutes: malformedOffset },
        created_at: '2026-08-08T15:00:00.000Z',
      }, now),
      null,
      `rollout rejects malformed native timezone authority: ${JSON.stringify(malformedOffset)}`,
    );
  }
  assert.ok(rolloutScript.clockFromNativeAppOpen({
    props: { ...nativeProps, timezone_offset_minutes: 0 },
    created_at: '2026-08-08T15:00:00.000Z',
  }, now));
  assert.ok(rolloutScript.clockFromNativeAppOpen({
    props: { ...nativeProps, timezone_offset_minutes: '0' },
    created_at: '2026-08-08T15:00:00.000Z',
  }, now));

  const candidateClockRow = {
    planning_date_local: '2026-08-08',
    timezone_offset_minutes: 240,
    status: 'preview',
    created_at: '2026-08-08T15:30:00.000Z',
    expires_at: '2026-08-08T16:30:00.000Z',
  };
  assert.deepEqual(
    rolloutScript.clockFromUnexpiredCandidate(candidateClockRow, now),
    {
      authoritative: true,
      planningDateLocal: '2026-08-08',
      timezoneOffsetMinutes: 240,
      source: 'unexpired_current_candidate',
    },
  );
  assert.equal(rolloutScript.clockFromUnexpiredCandidate({ ...candidateClockRow, status: 'applied' }, now), null);
  assert.equal(rolloutScript.clockFromUnexpiredCandidate({ ...candidateClockRow, expires_at: now.toISOString() }, now), null);
  assert.equal(rolloutScript.clockFromUnexpiredCandidate({ ...candidateClockRow, planning_date_local: '2026-08-07' }, now), null);

  const nativeClock = await rolloutScript.planningClockForUser('user-1', {}, now, {
    dbAll: async (sql) => sql.includes('FROM events')
      ? [{ props: nativeProps, created_at: '2026-08-08T15:00:00.000Z' }]
      : [],
  });
  assert.equal(nativeClock.source, 'fresh_native_ios_app_open');
  const candidateClock = await rolloutScript.planningClockForUser('user-1', {}, now, {
    dbAll: async (sql) => sql.includes('FROM events') ? [] : [candidateClockRow],
  });
  assert.equal(candidateClock.source, 'unexpired_current_candidate');
  const missingClock = await rolloutScript.planningClockForUser('user-1', {}, now, { dbAll: async () => [] });
  assert.equal(missingClock.authoritative, false);

  const rawUserId = disposableId;
  const entry = redactedBackupEntry({
    userId: rawUserId,
    active: { row: { user_plan_id: 'up-old', id: 'tp-old', plan_version: 3, lineage_id: 'lineage-1', effective_from: '2026-07-01' } },
    activePlan: { weeks: [{ health: 'forbidden' }] },
    candidate: { candidateHash: 'sha256:candidate' },
    raceIds: ['race-a1', 'race-a2'],
    planningDateLocal: '2026-08-08',
  });
  const manifest = buildBackupManifest({ entries: [entry], createdAt: '2026-08-08T12:00:00Z' });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes(rawUserId), false);
  assert.equal(serialized.includes('forbidden'), false);
  assert.equal(manifest.schema_version, 2);
  assert.match(entry.target_ref, /^sha256:/);
  assert.equal(entry.candidate.expected_effective_from, '2026-08-09');
  assert.throws(() => assertRedactedBackup({ phone_number: '555-0100' }), /Forbidden backup field/);
  assert.equal(targetRef(rawUserId), entry.target_ref);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forged-rollout-smoke-'));
  try {
    const filename = rolloutScript.writePrivateJson(temp, 'manifest', manifest);
    assert.equal(fs.statSync(temp).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    rolloutScript.replacePrivateJson(filename, { schema_version: 1, status: 'updated' });
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { schema_version: 1, status: 'updated' });
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  assert.equal(
    rolloutScript.assertPlanningDateStable({ clock: { planningDateLocal: '2026-08-08', timezoneOffsetMinutes: 0 } }, new Date('2026-08-08T12:00:00Z')),
    '2026-08-08',
  );
  assert.throws(
    () => rolloutScript.assertPlanningDateStable({ clock: { planningDateLocal: '2026-08-08', timezoneOffsetMinutes: 0 } }, new Date('2026-08-09T00:00:01Z')),
    /PLANNING_DATE_CHANGED/,
  );
  assert.doesNotThrow(() => rolloutScript.assertSupportedCandidate({ plan: { overall_feasibility: 'supported' } }));
  assert.throws(() => rolloutScript.assertSupportedCandidate({ plan: { overall_feasibility: 'stretch' } }), /CANDIDATE_FEASIBILITY_REVIEW_REQUIRED/);
  assert.throws(() => rolloutScript.assertSupportedCandidate({ plan: { overall_feasibility: 'unsafe' } }), /CANDIDATE_FEASIBILITY_REVIEW_REQUIRED/);
  assert.deepEqual(
    rolloutScript.safeFailure('sha256:test', new Error('private database detail'), 'ROLLOUT_APPLY_FAILED'),
    { target_ref: 'sha256:test', code: 'ROLLOUT_APPLY_FAILED' },
    'unknown errors are reduced to a safe operational code',
  );

  const scriptSource = fs.readFileSync(path.join(__dirname, '../scripts/upgrade-beta-race-plans.js'), 'utf8');
  assert.match(scriptSource, /u\.onboarded=1/);
  assert.match(scriptSource, /up\.user_id=u\.id AND up\.status='active'/);
  assert.doesNotMatch(scriptSource, /OR EXISTS \(SELECT 1 FROM training_plans tp WHERE tp\.user_id=u\.id\)/);
  assert.match(scriptSource, /race\.user_id=u\.id AND race\.status='upcoming'/);
  assert.match(scriptSource, /WHERE user_id=\? AND status='upcoming' AND race_date>=\?/);
  assert.match(scriptSource, /skipReason: 'missing_timezone_authority'/);
  assert.match(scriptSource, /event_name='app_open'/);
  assert.match(scriptSource, /status='preview' AND expires_at>\?/);
  assert.doesNotMatch(scriptSource, /operator_default_offset|operator_explicit_offset/);
  assert.match(scriptSource, /previewPlanForUser\(row\.id, request, \{[\s\S]*store: false,[\s\S]*goalBackwardDependencies:/);
  assert.match(scriptSource, /writePrivateJson\(options\.backupDir, 'pre-apply'/);
  assert.match(scriptSource, /previewPlanForUser\(context\.userId, context\.request, \{ store: true \}\)/);
  assert.match(scriptSource, /applyPlanCandidate\(context\.userId, stored\.id/);
  assert.match(scriptSource, /assertDisposableUserIds\(options\.userIds/);
  assert.match(scriptSource, /assertDeployedArtifactIdentity/);
  assert.match(scriptSource, /verifyGoalBackwardArtifacts/);
  assert.match(scriptSource, /restorePreviousAssignment/);
  assert.match(scriptSource, /buildCleanupEvidence/);
  assert.match(scriptSource, /stored\.candidateHash !== context\.candidate\.candidateHash/);
  assert.match(scriptSource, /throw rolloutError\('CANDIDATE_HASH_DRIFT'\)/);
  assert.match(scriptSource, /assertSupportedCandidate\(stored\)/);
  assert.match(scriptSource, /unmatchedUserIds[\s\S]*EXPLICIT_TARGET_NOT_ELIGIBLE/);
  assert.doesNotMatch(scriptSource, /err\.message|error:\s*err/);
  assert.ok(
    scriptSource.indexOf("writePrivateJson(options.backupDir, 'pre-apply'")
      < scriptSource.indexOf('previewPlanForUser(context.userId, context.request, { store: true })'),
    'redacted rollback manifest must be durable before the first write',
  );
  assert.ok(
    scriptSource.indexOf("writePrivateJson(options.backupDir, 'apply-result'")
      < scriptSource.indexOf('for (const context of contexts)'),
    'the durable result journal exists before the first account write',
  );
  assert.match(scriptSource, /finally \{[\s\S]*replacePrivateJson\(resultFile, resultJournal\)/);
  assert.doesNotMatch(scriptSource, /(?:UPDATE|DELETE)\s+(?:users|training_plans|race_events)/i);
  assert.match(scriptSource, /UPDATE user_plans SET status='superseded'[\s\S]*WHERE user_id=\?/);
  assert.match(scriptSource, /UPDATE user_plans SET status='active'[\s\S]*WHERE user_id=\?/);
  assert.doesNotMatch(
    String(rolloutScript.verifyApply),
    /assertPlanningDateStable/,
    'post-commit verification does not mislabel a successful apply when midnight follows the transaction'
  );

  console.log('BETA PLAN ROLLOUT SMOKE OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
