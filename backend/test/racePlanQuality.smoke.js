const assert = require('node:assert/strict');
const fixture = require('./fixtures/racePlanQuality.2026-08-07.json');
const {
  buildConcurrentPlan,
  validateConcurrentPlan,
} = require('../src/lib/concurrentPlan');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runSummary(plan) {
  return (plan.weeks?.[0]?.days || [])
    .flatMap((day) => (day.sessions || []).map((session) => ({
      date: day.date,
      type: session.type,
      workout_id: session.workout_id,
      miles: session.distance_miles,
      min: session.duration_min,
    })))
    .filter((session) => session.type !== 'strength');
}

function semanticLongRunErrors(plan) {
  const errors = [];
  for (const [weekIndex, week] of (plan.weeks || []).entries()) {
    for (const [dayIndex, day] of (week.days || []).entries()) {
      for (const [sessionIndex, session] of (day.sessions || []).entries()) {
        if (session.type !== 'long' && session.workout_id !== 'long_aerobic') continue;
        if (Number(session.distance_miles || 0) < 2) {
          errors.push({
            code: 'LONG_SEMANTIC_MINIMUM',
            path: `weeks[${weekIndex}].days[${dayIndex}].sessions[${sessionIndex}]`,
          });
        }
      }
    }
  }
  return errors;
}

const plan = buildConcurrentPlan(clone(fixture));
const validation = validateConcurrentPlan(plan, clone(fixture));
const summary = runSummary(plan);

if (process.argv.includes('--semantic-acceptance')) {
  const errors = semanticLongRunErrors(plan);
  if (errors.length) {
    console.error(`RACE PLAN QUALITY ACCEPTANCE RED: ${errors[0].code} at ${errors[0].path}`);
    process.exitCode = 1;
  } else {
    console.log('RACE PLAN QUALITY ACCEPTANCE OK');
  }
} else {
  assert.deepEqual(summary, [
    { date: '2026-08-07', type: 'quality', workout_id: 'strides', miles: 1.3, min: 35 },
    { date: '2026-08-09', type: 'long', workout_id: 'long_aerobic', miles: 0.9, min: 30 },
  ]);
  assert.deepEqual(validation, { valid: true, errors: [] });

  const variants = [
    ['low-data', { history: { ...fixture.history, weeklyMileageBaseline: 4, recentRunCount: 2 } }],
    ['no-data', { history: {} }],
    ['established', { history: { ...fixture.history, weeklyMileageBaseline: 35, recentRunCount: 30 } }],
    ['comeback', { safety: { comebackMode: true, activeInjury: true } }],
    ['dual-race', {}],
  ];
  for (const [name, patch] of variants) {
    const context = clone(fixture);
    Object.assign(context, clone(patch));
    const generated = buildConcurrentPlan(context);
    assert.equal(Array.isArray(generated.weeks), true, `${name} fixture should generate weeks`);
  }

  console.log('RACE PLAN QUALITY CHARACTERIZATION OK (5 variants + exact regression)');
}

module.exports = { semanticLongRunErrors };
