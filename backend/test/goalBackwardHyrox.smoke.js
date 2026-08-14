#!/usr/bin/env node

const assert = require('node:assert/strict');
const canonicalWorkout = require('../src/lib/canonicalWorkout');
const hyroxPlan = require('../src/lib/hyroxPlan');
const standards = require('../src/lib/hyroxStandards');
const targets = require('../src/lib/goalBackwardTargets');
const policy = require('../src/lib/racePlanPolicy');

const RULESET = {
  ruleset_id: 'hyrox-global',
  ruleset_version: '2026-2027',
};

function singlesInput(overrides = {}) {
  return {
    athlete_id: 'fixture-singles-athlete',
    format: 'singles',
    event_format: 'individual_open',
    registered_division: 'men',
    ...RULESET,
    transition_behavior: { evidence_ids: ['singles-transition'] },
    roxzone: { evidence_ids: ['singles-roxzone'] },
    compromised_running_evidence: [{ evidence_id: 'singles-compromised' }],
    station_performance_evidence: [{ evidence_id: 'singles-station' }],
    ...overrides,
  };
}

function doublesInput(overrides = {}) {
  return {
    athlete_id: 'fixture-doubles-athlete',
    format: 'doubles',
    registered_division: 'men',
    ...RULESET,
    partner_id: null,
    partner_placeholder: 'Partner TBD',
    team_station_time: {
      ski_erg: 240,
      row: 255,
    },
    planned_station_split: {
      ski_erg: { athlete: { distance_m: 600 }, partner: { distance_m: 400 } },
      row: null,
    },
    actual_station_split: {
      ski_erg: { athlete: { distance_m: 620, time_s: 142 }, partner: { distance_m: 380, time_s: 98 } },
      row: null,
    },
    transition_behavior: { team_time_s: 310, athlete_time_s: null, evidence_ids: ['team-transition'] },
    roxzone: { team_time_s: 310, athlete_time_s: null, evidence_ids: ['team-roxzone'] },
    compromised_running_evidence: [{ evidence_id: 'doubles-compromised' }],
    team_performance_evidence: [{ evidence_id: 'doubles-team' }],
    athlete_specific_fatigue_evidence: [{ evidence_id: 'doubles-athlete-fatigue' }],
    ...overrides,
  };
}

function assertRegistryPolicy() {
  assert.equal(standards.HYROX_RULESET_ID, 'hyrox-global');
  assert.equal(standards.HYROX_RULESET_VERSION, '2026-2027');
  assert.equal(standards.REGISTRY.rulesetId, standards.HYROX_RULESET_ID);
  assert.equal(standards.REGISTRY.rulesetVersion, standards.HYROX_RULESET_VERSION);
  assert.match(standards.REGISTRY.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(standards.REGISTRY.effectiveThrough, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(policy.HYROX_EVENT_MODEL_POLICY_V1.ruleset_id, standards.HYROX_RULESET_ID);
  assert.equal(policy.HYROX_EVENT_MODEL_POLICY_V1.ruleset_version, standards.HYROX_RULESET_VERSION);
  assert.equal(policy.HYROX_EVENT_MODEL_POLICY_V1.unknown_is_zero, false);
  assert.deepEqual(policy.HYROX_EVENT_MODEL_POLICY_V1.formats.singles.ownership, [
    'official_runs', 'official_stations', 'transitions_roxzone',
    'compromised_running', 'fatigue_recovery',
  ]);
}

function assertSinglesOwnership() {
  const state = canonicalWorkout.buildCanonicalHyroxEventState(singlesInput());
  assert.equal(state.format, 'singles');
  assert.equal(state.event_format, 'individual_open');
  assert.equal(state.partner_id, null);
  assert.equal(state.partner_placeholder, null);
  assert.equal(state.ruleset_status, 'exact');
  assert.equal(state.exact_loads_available, true);
  assert.equal(state.official_run_requirements.length, 8);
  assert.equal(state.official_run_requirements.every((run) => run.ownership === 'athlete'), true);
  assert.equal(state.official_station_requirements.length, 8);
  assert.equal(state.official_station_requirements.every((station) => station.ownership === 'athlete'), true);
  assert.equal(state.individual_training_burden.run_distance_m, 8000);
  assert.equal(state.individual_training_burden.run_ownership, 'athlete');
  assert.equal(state.individual_training_burden.station_ownership, 'athlete_full');
  assert.equal(state.individual_training_burden.transition_ownership, 'athlete');
  assert.equal(state.team_performance_burden, null);
  assert.deepEqual(state.compromised_running_evidence, [{ evidence_id: 'singles-compromised' }]);
  assert.deepEqual(state.station_performance_evidence, [{ evidence_id: 'singles-station' }]);
  assert.deepEqual(state.transition_behavior, { evidence_ids: ['singles-transition'] });
}

function assertDoublesBurdenAndUnknownSplit() {
  const state = hyroxPlan.buildHyroxEventState(doublesInput());
  assert.equal(state.format, 'doubles');
  assert.equal(state.partner_id, null);
  assert.equal(state.partner_placeholder, 'Partner TBD');
  assert.equal(state.official_run_requirements.length, 8);
  assert.equal(
    state.official_run_requirements.every((run) => run.ownership === 'athlete_required_with_partner'),
    true,
  );
  assert.equal(state.official_station_requirements.every((station) => station.ownership === 'team_shared'), true);
  assert.deepEqual(state.planned_station_split.ski_erg, {
    athlete: { distance_m: 600 }, partner: { distance_m: 400 },
  });
  assert.deepEqual(state.actual_station_split.ski_erg, {
    athlete: { distance_m: 620, time_s: 142 }, partner: { distance_m: 380, time_s: 98 },
  });
  assert.equal(state.planned_station_split.row, null);
  assert.equal(state.actual_station_split.row, null);
  assert.deepEqual(state.athlete_station_contribution.ski_erg, { distance_m: 620, time_s: 142 });
  assert.equal(state.athlete_station_contribution.row, null);
  assert.deepEqual(state.partner_station_contribution.ski_erg, { distance_m: 380, time_s: 98 });
  assert.equal(state.partner_station_contribution.row, null);
  assert.equal(state.team_performance_burden.station_time_s.ski_erg, 240);
  assert.equal(state.team_performance_burden.station_time_s.row, 255);
  assert.equal(state.individual_training_burden.station_time_s.ski_erg, 142);
  assert.equal(state.individual_training_burden.station_time_s.row, null);
  assert.equal(state.individual_training_burden.transition_roxzone_time_s, null);
  assert.equal(state.individual_training_burden.contribution_coherent, false);
  assert.deepEqual(state.team_performance_evidence, [{ evidence_id: 'doubles-team' }]);
  assert.deepEqual(state.athlete_specific_fatigue_evidence, [{ evidence_id: 'doubles-athlete-fatigue' }]);
}

function assertUnknownRulesAndDivision() {
  const unknownRulesetId = canonicalWorkout.buildCanonicalHyroxEventState(singlesInput({
    ruleset_id: null,
  }));
  assert.equal(unknownRulesetId.ruleset_status, 'incomplete');
  assert.equal(unknownRulesetId.exact_loads_available, false);
  assert.equal(
    unknownRulesetId.official_station_requirements.every((station) => station.exact_load === null),
    true,
  );

  const unsupportedRules = canonicalWorkout.buildCanonicalHyroxEventState(singlesInput({
    ruleset_version: 'invented-season',
  }));
  assert.equal(unsupportedRules.ruleset_status, 'unsupported_rules_version');
  assert.equal(unsupportedRules.exact_loads_available, false);
  assert.equal(
    unsupportedRules.official_station_requirements.every((station) => (
      station.official_standard === null
      && station.exact_load === null
      && station.load_instruction === 'registered_load_or_relative_technique'
    )),
    true,
  );

  const unknownDivision = canonicalWorkout.buildCanonicalHyroxEventState(doublesInput({
    registered_division: 'unknown',
  }));
  assert.equal(unknownDivision.ruleset_status, 'unsupported_division_category');
  assert.equal(unknownDivision.exact_loads_available, false);
  assert.equal(
    unknownDivision.official_station_requirements.every((station) => station.exact_load === null),
    true,
  );
}

function assertNullPreservingBudget() {
  const state = hyroxPlan.buildHyroxEventState(doublesInput());
  const budget = targets.buildHyroxPerformanceBudget({
    target_total_time_s: 3600,
    projected_run_time_s: 1800,
    run_confidence: 'MEDIUM',
    stations: [
      { station_id: 'ski_erg', projected_time_s: 240, evidence_ids: ['ski'], confidence: 'MEDIUM' },
      { station_id: 'row', projected_time_s: null, evidence_ids: [], confidence: 'INSUFFICIENT' },
    ],
    transition_roxzone_time_s: null,
    transition_confidence: 'INSUFFICIENT',
    team_budget: state.team_performance_burden,
    individual_training_burden: state.individual_training_burden,
  });
  assert.equal(budget.projected_run_time_s, 1800);
  assert.equal(budget.stations.length, 8);
  assert.equal(budget.stations.find((station) => station.station_id === 'ski_erg').projected_time_s, 240);
  assert.equal(budget.stations.find((station) => station.station_id === 'row').projected_time_s, null);
  assert.equal(budget.transition_roxzone_time_s, null);
  assert.equal(budget.known_component_sum_s, 2040);
  assert.equal(budget.unknown_unallocated_time_s, 1560);
  assert.equal(budget.mandatory_components_known, false);
  assert.equal(budget.supported, false);
  assert.equal(budget.confidence, 'INSUFFICIENT');
  assert.equal(budget.team_budget.station_time_s.row, 255);
  assert.equal(budget.individual_training_burden.station_time_s.row, null);

  const emptyBudget = hyroxPlan.buildHyroxPerformanceBudget({ target_total_time_s: 3600 });
  assert.equal(emptyBudget.projected_run_time_s, null);
  assert.equal(emptyBudget.stations.every((station) => station.projected_time_s === null), true);
  assert.equal(emptyBudget.transition_roxzone_time_s, null);
  assert.equal(emptyBudget.known_component_sum_s, 0);
  assert.equal(emptyBudget.unknown_unallocated_time_s, null);

  const completeComponents = {
    target_total_time_s: 3600,
    projected_run_time_s: 1800,
    run_confidence: 'MEDIUM',
    stations: standards.STATION_ORDER.map((stationId) => ({
      station_id: stationId,
      projected_time_s: 150,
      evidence_ids: [`${stationId}-benchmark`],
      confidence: 'MEDIUM',
    })),
    transition_roxzone_time_s: 300,
    transition_confidence: 'MEDIUM',
  };
  const noBurden = targets.buildHyroxPerformanceBudget(completeComponents);
  assert.equal(noBurden.mandatory_components_known, true);
  assert.equal(noBurden.burden_coherent, false);
  assert.equal(noBurden.supported, false, 'complete times cannot support a target without coherent burden');

  const singlesState = hyroxPlan.buildHyroxEventState(singlesInput());
  const supportedSingles = targets.buildHyroxPerformanceBudget({
    ...completeComponents,
    individual_training_burden: singlesState.individual_training_burden,
  });
  assert.equal(supportedSingles.known_component_sum_s, 3300);
  assert.equal(supportedSingles.unknown_unallocated_time_s, 300);
  assert.equal(supportedSingles.mandatory_components_known, true);
  assert.equal(supportedSingles.burden_coherent, true);
  assert.equal(supportedSingles.confidence, 'MEDIUM');
  assert.equal(supportedSingles.supported, true);

  const unknownDoublesBurden = targets.buildHyroxPerformanceBudget({
    ...completeComponents,
    team_budget: state.team_performance_burden,
    individual_training_burden: state.individual_training_burden,
  });
  assert.equal(unknownDoublesBurden.mandatory_components_known, true);
  assert.equal(unknownDoublesBurden.burden_coherent, false);
  assert.equal(unknownDoublesBurden.supported, false);
}

function assertEquipmentSubstitutionTruth() {
  const exact = standards.resolveHyroxStandard({
    rulesetId: RULESET.ruleset_id,
    rulesetVersion: RULESET.ruleset_version,
    format: 'individual_open',
    category: 'men',
  });
  const push = exact.stations.find((station) => station.id === 'sled_push');
  const substituted = hyroxPlan.buildHyroxStationPrescription({
    standard: push,
    equipment: [],
    dose_fraction: 0.5,
    ruleset_status: 'exact',
    exact_loads_available: true,
  });
  assert.equal(substituted.exactStation, false);
  assert.equal(substituted.readinessClaim, 'pattern_only');
  assert.equal(substituted.exactStationReadiness, false);
  assert.equal(substituted.prescribedLoadKg, null);
  assert.equal(substituted.officialStandard, undefined);
  assert.match(substituted.substitute, /pattern training only/i);

  const exactEquipment = hyroxPlan.buildHyroxStationPrescription({
    standard: push,
    equipment: ['sled_push'],
    dose_fraction: 0.5,
    ruleset_status: 'exact',
    exact_loads_available: true,
  });
  assert.equal(exactEquipment.exactStation, true);
  assert.equal(exactEquipment.readinessClaim, 'station_specific');
  assert.equal(exactEquipment.exactStationReadiness, true);
  assert.equal(exactEquipment.officialStandard.loadKgIncludingSled, 152);

  const unsupportedRules = hyroxPlan.buildHyroxStationPrescription({
    standard: push,
    equipment: ['sled_push'],
    dose_fraction: 0.5,
    ruleset_status: 'unsupported_rules_version',
    exact_loads_available: false,
  });
  assert.equal(unsupportedRules.exactStation, true, 'the actual station equipment remains available');
  assert.equal(unsupportedRules.exactStationReadiness, false);
  assert.equal(unsupportedRules.readinessClaim, 'relative_technique');
  assert.equal(unsupportedRules.prescribedLoadKg, null);
  assert.equal(unsupportedRules.officialStandard, undefined);
}

function run() {
  assertRegistryPolicy();
  assertSinglesOwnership();
  assertDoublesBurdenAndUnknownSplit();
  assertUnknownRulesAndDivision();
  assertNullPreservingBudget();
  assertEquipmentSubstitutionTruth();
  console.log('GOAL BACKWARD HYROX SMOKE OK');
}

if (require.main === module) run();
module.exports = { run };
