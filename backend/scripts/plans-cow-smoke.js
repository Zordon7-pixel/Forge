#!/usr/bin/env node
const assert = require('assert');

function clonePlanForUser({ trainingPlans, userPlans, userId, activeUserPlanId, mutate }) {
  const userPlan = userPlans.find((row) => row.id === activeUserPlanId && row.user_id === userId);
  if (!userPlan) throw new Error('active user plan not found');
  const activePlan = trainingPlans.find((row) => row.id === userPlan.plan_id);
  if (!activePlan) throw new Error('active plan not found');

  let writablePlan = activePlan;
  if (activePlan.user_id === null || activePlan.user_id === undefined) {
    writablePlan = {
      ...activePlan,
      id: `${activePlan.id}-clone-${userId}`,
      user_id: userId,
      plan_data: JSON.parse(JSON.stringify(activePlan.plan_data)),
    };
    trainingPlans.push(writablePlan);
    userPlan.plan_id = writablePlan.id;
  }

  writablePlan.plan_data = mutate(JSON.parse(JSON.stringify(writablePlan.plan_data)));
  return writablePlan;
}

const templatePlan = {
  id: 'template-5k',
  user_id: null,
  plan_data: {
    weeks: [
      { week: 1, sessions: [{ id: 'mon-run', day: 'Mon', workout_type: 'run', distance_miles: 3 }] },
    ],
  },
};

const trainingPlans = [JSON.parse(JSON.stringify(templatePlan))];
const userPlans = [
  { id: 'up-a', user_id: 'user-a', plan_id: 'template-5k' },
  { id: 'up-b', user_id: 'user-b', plan_id: 'template-5k' },
];

const clone = clonePlanForUser({
  trainingPlans,
  userPlans,
  userId: 'user-a',
  activeUserPlanId: 'up-a',
  mutate(planData) {
    planData.weeks[0].sessions[0].description = 'Rescheduled recovery day';
    return planData;
  },
});

const templateAfter = trainingPlans.find((row) => row.id === 'template-5k');
const userA = userPlans.find((row) => row.id === 'up-a');
const userB = userPlans.find((row) => row.id === 'up-b');

assert.strictEqual(templateAfter.plan_data.weeks[0].sessions[0].description, undefined);
assert.notStrictEqual(userA.plan_id, 'template-5k');
assert.strictEqual(userA.plan_id, clone.id);
assert.strictEqual(userB.plan_id, 'template-5k');
assert.strictEqual(trainingPlans.length, 2);

console.log('plans copy-on-write smoke OK');
