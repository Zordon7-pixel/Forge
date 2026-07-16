const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _test: workflow } = require('../src/lib/feedbackWorkflow');
const { _test: images } = require('../src/lib/exerciseImageRequests');

assert.deepEqual(workflow.parseStatuses(undefined), ['new', 'assigned']);
assert.deepEqual(workflow.parseStatuses('ready_for_qa,shipped'), ['ready_for_qa', 'shipped']);
assert.throws(() => workflow.parseStatuses('new,invalid'), /Invalid feedback status filter/);
assert.equal(workflow.normalizeLimit(500), 100);
assert.equal(workflow.normalizeLimit(0), 1);

const assigned = workflow.normalizeWorkflowPatch(
  { status: 'assigned', assigned_to: 'codex', support_note: ' Reproducing   on iOS ', linked_ref: ' issue/123 ' },
  { status: 'new' }
);
assert.deepEqual(assigned, {
  status: 'assigned',
  assignedTo: 'codex',
  supportNote: 'Reproducing on iOS',
  linkedRef: 'issue/123',
  markReviewed: false,
});
assert.equal(workflow.normalizeWorkflowPatch({ status: 'shipped' }, assigned).markReviewed, true);
assert.throws(() => workflow.normalizeWorkflowPatch({ status: 'assigned', assigned_to: 'unknown' }), /Invalid feedback assignee/);

assert.equal(images.canonicalizeExerciseName('5-10 minutes easy walk or bike to downshift heart rate'), null);
assert.equal(images.canonicalizeExerciseName('Hydrate and refuel with carbs plus protein within 1 hour'), null);
assert.equal(images.canonicalizeExerciseName('Short hill sprints or flat sprints'), null);
assert.equal(images.canonicalizeExerciseName('QA Full Update'), null);
assert.equal(images.canonicalizeExerciseName('Test Exercise'), null);
assert.equal(images.canonicalizeExerciseName('Placeholder move'), null);
assert.equal(images.canonicalizeExerciseName('Core Accessory'), null);
assert.equal(images.canonicalizeExerciseName('Dynamic mobility x 5 min'), null);
assert.equal(images.canonicalizeExerciseName('Light stretch 5 min'), null);
assert.equal(images.canonicalizeExerciseName('6 x 200m fast but controlled'), null);
assert.equal(images.canonicalizeExerciseName('4 x 400m at strong mile/5K effort'), null);
assert.equal(images.canonicalizeExerciseName('Speed maintenance'), null);
assert.equal(images.canonicalizeExerciseName('Fast relaxed running mechanics focus'), null);
assert.equal(images.canonicalizeExerciseName('Short speed repeats'), null);
assert.equal(images.canonicalizeExerciseName('2 x 20m high-knee march into skip'), 'A-March');
assert.equal(images.canonicalizeExerciseName('A-skips x 2 x 20 meters'), 'A-Skips');
assert.equal(images.canonicalizeExerciseName('2 x 20m A-skip with tall posture'), 'A-Skips');
assert.equal(images.canonicalizeExerciseName('4 x 8 Mountain Climbers'), 'Mountain Climbers');
assert.equal(images.canonicalizeExerciseName('3 x 8 Mini-band walks'), 'Mini-band walks');
assert.equal(images.canonicalizeExerciseName('3 x 5 Muscle-ups'), 'Muscle-ups');
assert.equal(images.canonicalizeExerciseName('Dead Bug with Reach'), 'Dead Bug');
assert.equal(images.canonicalizeExerciseName('Pallof Press March'), 'Pallof Press');
assert.equal(images.canonicalizeExerciseName('Single-Leg Calf Raise'), 'Standing Calf Raise');
assert.equal(images.canonicalizeExerciseName('Seated Calf Raise'), 'Seated Calf Raise');
assert.equal(images.canonicalizeExerciseName('Low Box Jump'), 'Low Box Jump');
assert.equal(images.canonicalizeExerciseName('Box Jump'), 'Box Jump');
assert.equal(images.canonicalizeExerciseName('Thoracic rotations 8/side'), 'Trunk Rotation');
assert.equal(images.canonicalizeExerciseName('Band pull-aparts x 20'), 'Band Pull-Apart');
assert.equal(images.canonicalKey("World's Greatest Stretch"), 'worlds-greatest-stretch');
assert.equal(images.hasLocalFormImage(images.canonicalizeExerciseName("World’s greatest stretch x 4/side")), true);
assert.equal(images.hasLocalFormImage(images.canonicalizeExerciseName('Dynamic leg swings x 8/side')), true);

const newFormAssets = [
  ['A-Skips', 'a-skips.jpg'],
  ['Standing Calf Raise', 'standing-calf-raise.jpg'],
  ['Pogo Hops', 'pogo-hops.jpg'],
  ['Dead Bug', 'dead-bug.jpg'],
  ['Pallof Press', 'pallof-press.jpg'],
  ['Box Jump', 'box-jump.jpg'],
  ['Low Box Jump', 'low-box-jump.jpg'],
  ['90/90 Breathing', '90-90-breathing.jpg'],
  ['90/90 Hip Switch', '90-90-hip-switch.jpg'],
  ['Kettlebell Swing', 'kettlebell-swing.jpg'],
  ['Band Pull-Apart', 'band-pull-apart.jpg'],
  ['Shoulder Circles', 'shoulder-circles.jpg'],
  ['A-March', 'a-march.jpg'],
  ['Foam Rolling', 'foam-rolling.jpg'],
  ['Barbell Bench Press', 'barbell-bench-press.jpg'],
  ['Chest-Supported Row', 'chest-supported-row.jpg'],
  ['Incline Dumbbell Press', 'incline-dumbbell-press.jpg'],
  ['Seated Calf Raise', 'seated-calf-raise.jpg'],
];
for (const [movement, filename] of newFormAssets) {
  assert.equal(images.hasLocalFormImage(movement), true, `${movement} must resolve to a local form image`);
  assert.equal(
    fs.existsSync(path.join(__dirname, '../../frontend/public/exercises', filename)),
    true,
    `${filename} must exist`
  );
}

const root = path.join(__dirname, '..');
const feedbackRoute = fs.readFileSync(path.join(root, 'src/routes/feedback.js'), 'utf8');
const workflowSource = fs.readFileSync(path.join(root, 'src/lib/feedbackWorkflow.js'), 'utf8');
const imageSource = fs.readFileSync(path.join(root, 'src/lib/exerciseImageRequests.js'), 'utf8');

assert.match(feedbackRoute, /message\.length < MIN_MESSAGE_LENGTH/);
assert.match(feedbackRoute, /type IN \('bug', 'feature_request'\)/);
assert.match(feedbackRoute, /withTransaction\(async \(tx\)/);
assert.match(feedbackRoute, /userIds: \[req\.user\.id\]/);
assert.match(feedbackRoute, /requireUserIds: \[req\.user\.id\]/);
assert.match(feedbackRoute, /userLock: 'update'/);
assert.doesNotMatch(feedbackRoute, /SELECT \* FROM app_feedback/);
assert.match(workflowSource, /WHERE id=\? AND user_id=\?/);
assert.match(imageSource, /INSERT INTO exercise_image_requests/);
assert.match(imageSource, /ON CONFLICT \(canonical_key\) DO UPDATE/);
assert.match(imageSource, /exercise\?\.how_to_image_url/);
assert.doesNotMatch(imageSource, /INSERT INTO app_feedback/);

console.log('Feedback workflow smoke passed');
