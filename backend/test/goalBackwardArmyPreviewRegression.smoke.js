#!/usr/bin/env node

const assert = require('node:assert/strict');

process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';

const plansRouter = require('../src/routes/plans');
const { HARD_VALIDATOR_NAMES } = require('../src/lib/goalBackwardValidators');
const { canonicalHash } = require('../src/lib/racePlanPolicy');

const PLANNING_DATE = '2026-08-29';
const TIMEZONE = 'America/New_York';
const RACE_DATE = '2026-10-11';
const TRAINING_DAYS = Object.freeze(['Tue', 'Thu', 'Sat', 'Sun']);
const BASELINE_RUNNING_M = Math.round(20 * 1609.344);

function validatorResult(candidate, validator) {
  return candidate?.validation?.validator_results?.find((entry) => entry.validator === validator) || null;
}

function compactDiagnostic(result) {
  return {
    phase: result.decision.phase,
    training_age_class: result.decision.training_age_class,
    recovery_state: result.decision.recovery_state,
    selected: result.selected_candidate?.candidate_hash || null,
    roles: result.decision.role_multiset,
    required_running_m: result.required_running_dose_receipt?.required_running_m ?? null,
    candidates: result.candidates.length,
    running_m: [...new Set(result.candidates.map((candidate) => (
      validatorResult(candidate, 'material_dose')?.receipt?.candidate_running_m ?? null
    )))],
    violations: [...new Set(result.candidates.flatMap((candidate) => (
      candidate.validation.violations.map((violation) => violation.code || violation.reason)
    )))],
    search: result.search_diagnostics,
  };
}

function buildScenario(options = {}) {
  const baselineRunningM = options.baselineRunningM || BASELINE_RUNNING_M;
  const race = {
    id: 'army-ten-miler-2026',
    user_id: 'army-preview-athlete',
    race_name: 'Army 10-Miler',
    race_date: RACE_DATE,
    event_local_date: RACE_DATE,
    event_timezone: TIMEZONE,
    event_kind: 'run_race',
    distance_miles: 10,
    location: 'Washington, DC',
    goal_time_seconds: 5340,
    status: 'upcoming',
  };
  const target = {
    raceDate: RACE_DATE,
    raceId: race.id,
    raceName: race.race_name,
    distanceMiles: 10,
    goalTimeSeconds: 5340,
    goalType: 'pr',
    raceTargets: [{
      raceDate: RACE_DATE,
      raceId: race.id,
      raceName: race.race_name,
      distanceMiles: 10,
      goalTimeSeconds: 5340,
      goalType: 'pr',
    }],
    trainingDays: [...TRAINING_DAYS],
    runDaysPerWeek: 4,
    liftingEnabled: true,
    liftDaysPerWeek: 4,
    planMode: 'hybrid_maintain',
    strengthGoal: 'maintain',
    equipment: ['barbell', 'dumbbell', 'rack', 'bench', 'cable', 'machines'],
    weeks: 7,
    startDate: '2026-08-24',
    todayISO: PLANNING_DATE,
    nowISO: `${PLANNING_DATE}T12:00:00.000Z`,
  };
  const currentWeek = options.currentWeek || {
    startDate: '2026-08-24',
    miles: 0,
    knownDistanceLowerBoundMiles: 0,
    distanceState: 'KNOWN',
    unknownDistanceRunCount: 0,
    runCount: 0,
    runDates: [],
    longRunCompleted: false,
  };
  const context = {
    todayISO: PLANNING_DATE,
    profile: {
      id: race.user_id,
      timezone: TIMEZONE,
      weekly_miles_current: baselineRunningM / 1609.344,
      run_days_per_week: 4,
      lift_days_per_week: 4,
      training_age_class: options.trainingAgeClass || 'DEVELOPING',
    },
    target,
    history: {
      weeklyMileageBaseline: baselineRunningM / 1609.344,
      mileageBaseline: {
        observedLowerBoundWeeklyMiles: baselineRunningM / 1609.344,
        meaningfulRunCount: 8,
      },
      recentRunCount: 8,
      recentLiftCount: 8,
      acuteRunLoad: {
        latestRun: { date: '2026-08-27', paceSecondsPerMile: 600 },
        currentWeek,
      },
      runLoadInput: {
        load_input_state: 'COMPLETE',
        load_input_confidence: 'HIGH',
        recent_normal_confidence: 'HIGH',
        recent_normal: {
          status: 'ESTABLISHED',
          median_distance_m: baselineRunningM,
        },
        windows: [],
        unresolved_conflicts: [],
        reason_codes: [],
      },
      previousTwoWeeksPassed: true,
      modalityHistory: {},
      performanceProfile: {
        targetAnchor: {
          equivalentTimeSeconds: 5700,
          date: '2026-08-01',
          kind: 'observed_distance_band',
          runId: 'ten-mile-anchor',
        },
      },
    },
    recovery: { state: options.recoveryState || 'NORMAL', available: true, metrics: {} },
    safety: { activeInjury: false, comebackMode: false, injuryNotesPresent: false },
  };
  const built = plansRouter._test.buildDeterministicCandidate(context, {
    planningDateLocal: PLANNING_DATE,
  });
  assert.equal(built.validation.valid, true, built.validation.errors?.join('; '));
  const planningConstraints = {
    locks: [],
    manual_edits: [],
    lock_revision: 0,
    edit_revision: 0,
    constraint_fingerprint: null,
  };
  const state = {
    target,
    context,
    races: [race],
    inputHash: `sha256:${canonicalHash({ race, target, currentWeek })}`,
    planningInputRevision: 1,
    planningConstraints,
    active: null,
    activePlan: null,
    activeCanonicalCarryForwardSource: null,
    request: {
      race_ids: [race.id],
      planning_date_local: PLANNING_DATE,
      timezone_offset_minutes: 240,
    },
  };
  const result = plansRouter._test.computeGoalBackwardShadowDiagnostics({
    userId: race.user_id,
    state,
    built,
    planningDateLocal: PLANNING_DATE,
  });
  return { built, result };
}

function run() {
  const scenario = buildScenario();
  const diagnostic = compactDiagnostic(scenario.result);
  assert.ok(
    scenario.result.selected_candidate,
    `the exact Army 10-Miler preview must select a candidate; diagnostic=${JSON.stringify(diagnostic)}`,
  );
  assert.equal(scenario.result.selected_candidate.validation.valid, true);
  assert.deepEqual(
    scenario.result.selected_candidate.validation.validator_results.map((entry) => entry.validator),
    HARD_VALIDATOR_NAMES,
  );
  assert.equal(
    scenario.result.selected_candidate.validation.validator_results.every((entry) => entry.valid),
    true,
  );
  assert.equal(
    new Set(scenario.result.selected_candidate.canonical_sessions.map((session) => (
      session.scheduled_local_date
    ))).size,
    scenario.result.selected_candidate.canonical_sessions.length,
    'the four requested runs must occupy four distinct eligible dates',
  );
  const projectedQuality = scenario.result.selected_candidate.canonical_sessions.find((session) => (
    ['threshold_run', 'interval_run', 'race_rhythm_run'].includes(session.workout_family)
  ));
  assert.ok(projectedQuality, 'the race-specific quality exposure must be present');
  assert.ok(
    projectedQuality.derived_totals.distance_m > 0,
    'the projected quality exposure must contribute canonical running distance',
  );
  assert.ok(
    projectedQuality.steps.some((step) => Number(step.target?.distance_m || 0) > 0),
    'the projected distance must live in executable canonical steps',
  );
  const applicable = plansRouter._test.applicableGoalBackwardPlan(
    scenario.built.plan,
    scenario.result,
  );
  assert.ok(applicable, 'the selected Army preview must remain persistable on the real replacement path');

  const completedSaturday = buildScenario({
    currentWeek: {
      startDate: '2026-08-24',
      miles: 10,
      knownDistanceLowerBoundMiles: 10,
      distanceState: 'KNOWN',
      unknownDistanceRunCount: 0,
      runCount: 3,
      runDates: ['2026-08-25', '2026-08-27', '2026-08-29'],
      longRunCompleted: false,
    },
  });
  assert.ok(
    completedSaturday.result.selected_candidate,
    `a completed Saturday run must not make the rolling preview impossible; diagnostic=${JSON.stringify(
      compactDiagnostic(completedSaturday.result),
    )}`,
  );
  assert.equal(completedSaturday.result.decision.role_multiset.length, 3);
  assert.equal(
    completedSaturday.result.selected_candidate.canonical_sessions.every((session) => (
      session.scheduled_local_date > PLANNING_DATE
    )),
    true,
    'completed dates are credit, never duplicate placements',
  );
  assert.equal(
    new Set(completedSaturday.result.selected_candidate.canonical_sessions.map((session) => (
      session.scheduled_local_date
    ))).size,
    completedSaturday.result.selected_candidate.canonical_sessions.length,
  );
  assert.ok(
    plansRouter._test.applicableGoalBackwardPlan(
      completedSaturday.built.plan,
      completedSaturday.result,
    ),
    'the completed-current-week variant must also survive the persistence gate',
  );
  console.log('GOAL BACKWARD ARMY PREVIEW REGRESSION SMOKE OK');
}

if (require.main === module) run();

module.exports = { buildScenario, run };
