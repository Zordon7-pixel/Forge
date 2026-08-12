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
assert.equal(images.canonicalizeExerciseName('Dead Bug with Reach'), 'Dead Bug with Reach');
assert.equal(images.canonicalizeExerciseName('Pallof Press March'), 'Pallof Press March');
assert.equal(images.canonicalizeExerciseName('Single-Leg Calf Raise'), 'Single-Leg Calf Raise');
assert.equal(images.canonicalizeExerciseName('Seated Calf Raise'), 'Seated Calf Raise');
assert.equal(images.canonicalizeExerciseName('Low Box Jump'), 'Low Box Jump');
assert.equal(images.canonicalizeExerciseName('Box Jump'), 'Box Jump');
assert.equal(images.canonicalizeExerciseName('Thoracic rotations 8/side'), 'Thoracic rotations');
assert.equal(images.canonicalizeExerciseName('Band pull-aparts x 20'), 'Band Pull-Apart');
assert.equal(images.canonicalKey("World's Greatest Stretch"), 'worlds-greatest-stretch');
assert.equal(images.hasLocalFormImage(images.canonicalizeExerciseName("World’s greatest stretch x 4/side")), true);
assert.equal(images.hasLocalFormImage(images.canonicalizeExerciseName('Dynamic leg swings x 8/side')), true);
assert.equal(images.hasLocalFormImage('Barbell Back Squat'), true);
assert.equal(images.hasLocalFormImage('Conventional Deadlift'), true);
assert.equal(images.hasLocalFormImage('Dumbbell Shoulder Press'), true);
assert.equal(images.hasLocalFormImage('Bench Press'), true, 'unmodified Bench Press is an explicit standard-barbell alias');
assert.equal(images.hasLocalFormImage('Ankle Circle'), true, 'frontend and backend agree on the ankle-circle alias');
assert.equal(images.hasLocalFormImage('Romanian Deadlift'), true, 'screenshot-proven Romanian Deadlift media is not re-queued');
assert.equal(images.hasLocalFormImage('Barbell RDL'), true, 'the catalog barbell-RDL alias is recognized without broadening to other implements');
assert.equal(images.hasLocalFormImage('Single-Leg Romanian Deadlift'), true, 'screenshot-proven unilateral RDL media is not re-queued');
assert.equal(images.hasLocalFormImage('Dumbbell Single-Leg RDL'), true, 'the abbreviated unilateral alias preserves its exact implement');
assert.equal(images.hasLocalFormImage('Dumbbell Bulgarian Split Squat'), true, 'screenshot-proven rear-foot-elevated split-squat media is not re-queued');
assert.equal(images.hasLocalFormImage('Dumbbell RFESS'), true, 'the abbreviated RFESS alias preserves its exact elevation and implement');
assert.equal(images.hasLocalFormImage('Trap Bar Deadlift'), true, 'screenshot-proven trap-bar media is not re-queued');
assert.equal(images.hasLocalFormImage('Leg Press'), false, 'Leg Press must not reuse a squat image');
assert.equal(images.hasLocalFormImage('Dumbbell Romanian Deadlift'), false, 'a dumbbell RDL must not inherit the barbell RDL image');
assert.equal(images.hasLocalFormImage('Kettlebell Romanian Deadlift'), false, 'a kettlebell RDL must not inherit the barbell RDL image');
assert.equal(images.hasLocalFormImage('Sumo Deadlift'), false, 'stance variants must not reuse a conventional or trap-bar deadlift image');
assert.equal(images.hasLocalFormImage('Deficit Trap Bar Deadlift'), false, 'elevation variants must not reuse the standard trap-bar image');
assert.equal(images.hasLocalFormImage('Barbell Rear-Foot Elevated Split Squat'), false, 'an unproven implement variant must not reuse the dumbbell/bodyweight RFESS image');
assert.equal(images.hasLocalFormImage('One-arm Dumbbell Row'), false, 'Dumbbell rows must not reuse a barbell-row image');
assert.equal(images.hasLocalFormImage('Hammer Curl'), false, 'Hammer curls must not reuse a barbell-curl image');
assert.equal(images.hasLocalFormImage('Skull Crusher'), false, 'Skull crushers must not reuse a pushdown image');
assert.equal(images.hasLocalFormImage('Band Pulldown'), false, 'Band pulldowns must not reuse a lat-pulldown image');
assert.equal(images.hasLocalFormImage('Landmine Barbell Row'), false, 'Landmine rows must not reuse a bent-over barbell-row image');
assert.equal(images.hasLocalFormImage('Single-Arm Dumbbell Shoulder Press'), false, 'Single-arm presses must not reuse a bilateral press image');
assert.equal(images.hasLocalFormImage('Seated Dumbbell Shoulder Press'), false, 'Seated presses must not reuse a standing press image');
assert.equal(images.hasLocalFormImage('Reverse-Grip Lat Pulldown'), false, 'Grip variants must not reuse a different pulldown image');
assert.equal(images.hasLocalFormImage('Pallof Press March'), false, 'Pallof variants must not reuse the standard static-press image');
assert.equal(images.hasLocalFormImage('Dead Bug with Reach'), false, 'Dead Bug variants must not reuse the standard dead-bug image');
assert.equal(images.hasLocalFormImage('Single-Leg Calf Raise'), false, 'single-leg calf raises must not reuse the bilateral standing image');
assert.equal(images.hasLocalFormImage('Reverse Lunge'), false, 'reverse lunges must not reuse the walking-lunge image');
assert.equal(images.hasLocalFormImage('Close-Grip Barbell Bench Press'), false, 'grip variants must not reuse the standard bench image');
assert.equal(images.hasLocalFormImage('Incline Barbell Bench Press'), false, 'incline barbell presses must not reuse the flat bench image');
assert.equal(images.hasLocalFormImage('Paused Barbell Bench Press'), false, 'paused variants must not reuse the standard bench image');
assert.equal(images.hasLocalFormImage('Walking Lunges'), true, 'the exact walking-lunge movement keeps its vetted image');
assert.equal(images.hasLocalFormImage('Pallof Press'), true, 'the exact standard Pallof Press keeps its vetted image');
assert.equal(images.isVettedLocalFormAsset('Romanian Deadlift', '/exercises/romanian-deadlift.webp'), true, 'the exact screenshot-proven name/asset pair is accepted');
assert.equal(images.isVettedLocalFormAsset('Romanian Deadlift', '/exercises/deadlift.png'), false, 'a conventional deadlift asset cannot satisfy an RDL request');
assert.equal(images.isVettedLocalFormAsset('Trap Bar Deadlift', '/exercises/romanian-deadlift.webp'), false, 'a different vetted local asset cannot satisfy a trap-bar request');
assert.equal(images.isVettedLocalFormAsset('Goblet Squat', '/exercises/squat.png'), false, 'a plausible local path is not vetted without an exact name/asset policy pair');
assert.equal(images.isVettedLocalFormAsset('Romanian Deadlift', 'https://example.com/romanian-deadlift.webp'), false, 'external catalog diagrams are never accepted as vetted form images');
assert.equal(images.exerciseNameFromItem({ exercise: 'Goblet Squat' }), 'Goblet Squat', 'plan exercise field is recognized by the review queue');

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
const plansSource = fs.readFileSync(path.join(root, 'src/routes/plans.js'), 'utf8');

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
assert.match(imageSource, /ON CONFLICT \(canonical_key\) DO NOTHING/);
assert.match(imageSource, /exercise\?\.how_to_image_url/);
assert.doesNotMatch(imageSource, /INSERT INTO app_feedback/);
assert.match(plansSource, /source: 'scheduled_plan_today'/);
assert.match(plansSource, /source: 'scheduled_plan_current'/);
assert.equal((plansSource.match(/ensureOnly: true/g) || []).length, 2, 'scheduled plan image review registration is idempotent and non-counting');
assert.match(plansSource, /res\.json\([\s\S]*void requestImagesForWorkoutItems/);

console.log('Feedback workflow smoke passed');
