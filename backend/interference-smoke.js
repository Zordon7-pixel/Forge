const assert = require('assert');
const { applyInterference } = require('./src/services/interference');

function hoursAgo(hours) {
  return new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
}

function qualityRecommendation() {
  return {
    type: 'tempo',
    recommendationType: 'moderate_run',
    suggestedDistance: 4,
    suggestedPace: '8:00/mi',
    pace: '8:00/mi',
    paceTarget: '8:00/mi',
    structure: [{ phase: 'main', label: 'Tempo', hrZone: 4, description: 'Hard tempo', paceTarget: '8:00/mi' }],
  };
}

function easyRecommendation() {
  return {
    type: 'easy_run',
    recommendationType: 'easy_run',
    suggestedDistance: 3,
    suggestedPace: '9:30/mi',
    structure: [{ phase: 'main', label: 'Main', hrZone: 2, description: 'Easy' }],
  };
}

const heavyLegRecent = [{ started_at: hoursAgo(2), muscle_groups: JSON.stringify(['quads', 'glutes']), total_seconds: 2400 }];
const heavyLegOld = [{ started_at: hoursAgo(30), muscle_groups: JSON.stringify(['legs']), total_seconds: 2400 }];
const upperRecent = [{ started_at: hoursAgo(2), muscle_groups: JSON.stringify(['chest', 'back']), total_seconds: 2400 }];

function containsValue(value, needle) {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((item) => containsValue(item, needle));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsValue(item, needle));
  return false;
}

{
  const result = applyInterference(qualityRecommendation(), heavyLegRecent);
  assert.equal(result.interference.adjusted, true);
  assert.equal(result.type, 'easy_run');
  assert.equal(result.recommendationType, 'easy_run');
  assert.ok(result.structure.every((block) => Number(block.hrZone || 0) <= 2));
  assert.equal(containsValue(result, '8:00/mi'), false);
  assert.equal(result.suggestedPace, null);
  assert.equal(result.pace, undefined);
  assert.equal(result.paceTarget, undefined);
  assert.ok(result.structure.every((block) => block.paceTarget === undefined));
  assert.ok(result.interference.reason);
  assert.equal(result.interference.reason.includes('heavy'), false);
}

{
  const result = applyInterference(qualityRecommendation(), heavyLegOld);
  assert.deepEqual(result.interference, { adjusted: false });
  assert.equal(result.type, 'tempo');
}

{
  const result = applyInterference(easyRecommendation(), heavyLegRecent);
  assert.deepEqual(result.interference, { adjusted: false });
  assert.equal(result.type, 'easy_run');
}

{
  const result = applyInterference(qualityRecommendation(), upperRecent);
  assert.deepEqual(result.interference, { adjusted: false });
  assert.equal(result.type, 'tempo');
}

{
  const result = applyInterference(qualityRecommendation(), []);
  assert.deepEqual(result.interference, { adjusted: false });
  assert.equal(result.type, 'tempo');
}

console.log('interference smoke passed');
