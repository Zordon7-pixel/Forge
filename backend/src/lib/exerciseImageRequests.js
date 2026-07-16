const { dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');

const LOCAL_FORM_IMAGE_MATCHERS = [
  (name) => name.includes('dumbbell bench press'),
  (name) => name.includes('squat') || name.includes('leg press'),
  (name) => name.includes('deadlift') || name.includes('romanian deadlift'),
  (name) => name.includes('barbell row') || name.includes('dumbbell row') || name.includes('cable row') || name.includes('single-arm dumbbell row'),
  (name) => name.includes('overhead press') || name.includes('arnold press') || name.includes('shoulder press'),
  (name) => name.includes('push-up') || name.includes('push up'),
  (name) => name.includes('plank'),
  (name) => name.includes('barbell curl') || name.includes('hammer curl') || name.includes('preacher curl') || name.includes('curl'),
  (name) => name.includes('tricep pushdown') || name.includes('tricep') || name.includes('skull crusher'),
  (name) => name.includes('pull-up') || name.includes('pull up'),
  (name) => name.includes('lat pulldown') || name.includes('pulldown'),
  (name) => name.includes('leg swing'),
  (name) => name.includes('hip flexor'),
  (name) => name.includes('hip circle'),
  (name) => name.includes('high knee'),
  (name) => name.includes('butt kick'),
  (name) => name.includes('ankle roll'),
  (name) => name.includes('walking lunge') || name === 'lunges' || name.includes('lunge'),
  (name) => name.includes('standing quad') || name.includes('quad stretch'),
  (name) => name.includes('hamstring stretch'),
  (name) => name.includes('calf stretch'),
  (name) => name.includes('figure four') || name.includes('figure-4') || name.includes('piriformis'),
  (name) => name.includes("child's pose") || name.includes('childs pose'),
  (name) => name.includes('inchworm'),
  (name) => name.includes("world's greatest") || name.includes('worlds greatest'),
  (name) => name.includes('trunk rotation'),
  (name) => name.includes('cat-cow') || name.includes('cat cow'),
  (name) => name.includes('bridge hold') || name.includes('glute bridge'),
  (name) => name.includes('chest opener'),
  (name) => name.includes('cross-body shoulder') || name.includes('cross body shoulder'),
  (name) => name.includes('overhead lat'),
  (name) => name.includes('wrist flexor'),
  (name) => name.includes('pelvic tilt'),
  (name) => name.includes('lateral lunge'),
  (name) => name.includes('doorway chest'),
  (name) => name.includes('overhead tricep'),
  (name) => name.includes('upper trap'),
  (name) => name.includes('cobra'),
  (name) => name.includes('supine spinal twist') || name.includes('supine twist'),
  (name) => name.includes('knee-to-chest') || name.includes('knee to chest'),
  (name) => name.includes('kneeling quad'),
  (name) => name.includes('butterfly'),
];

const CANONICAL_MOVEMENTS = [
  { match: /world'?s greatest/, name: "World's Greatest Stretch" },
  { match: /\ba[- ]?skips?\b/, name: 'A-Skips' },
  { match: /\ba[- ]?march(?:es|ing)?\b/, name: 'A-March' },
  { match: /\bpogo (?:hop|jump|snap)/, name: 'Pogo Hops' },
  { match: /90\/90.*breath/, name: '90/90 Breathing' },
  { match: /90\/90.*(?:hip|switch)/, name: '90/90 Hip Switch' },
  { match: /dead bug/, name: 'Dead Bug' },
  { match: /pallof press/, name: 'Pallof Press' },
  { match: /seated calf raise/, name: 'Seated Calf Raise' },
  { match: /(?:standing|single[- ]leg|bodyweight)?\s*calf raise/, name: 'Standing Calf Raise' },
  { match: /low box jump/, name: 'Low Box Jump' },
  { match: /\bbox jump\b/, name: 'Box Jump' },
  { match: /kettlebell swing/, name: 'Kettlebell Swing' },
  { match: /single[- ]leg.*(?:rdl|romanian deadlift)/, name: 'Single-Leg Romanian Deadlift' },
  { match: /foam roll/, name: 'Foam Rolling' },
  { match: /thoracic rotation/, name: 'Trunk Rotation' },
  { match: /band pull[- ]?apart/, name: 'Band Pull-Apart' },
];

function normalizeExerciseName(name) {
  return String(name || '')
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function isNonVisualGuidance(name) {
  const lower = normalizeExerciseName(name).toLowerCase();
  if (!lower) return true;
  if (/^(?:qa\b|zordon form test|\d+$|sec\b|m\b)/.test(lower)) return true;
  if (/^(?:(?:test|placeholder|example|sample|dummy)(?: exercise| movement| move| workout| item)?|arms?|core accessory|stability finisher|core hold|dynamic mobility|light stretch|warm[- ]?up|cool[- ]?down)$/.test(lower)) return true;
  if (/\b(hydrate|refuel|recovery meal|recovery snack|carbs?|protein|next run)\b/.test(lower)) return true;
  if (/\b(strides?|sprints?|intervals?|fast finish|speed endurance|race pace|running form|accelerations?|fast efforts?|fast reps?|hill repeats?)\b/.test(lower)) return true;
  const generalMovement = /\b(walk|walking|jog|jogging|bike|biking|cycle|cycling|spin|row|rowing|movement)\b/;
  const guidance = /\b(easy|light|brisk|downshift|raise temperature|nasal breathing|cool ?down|warm ?up)\b/;
  return generalMovement.test(lower) && guidance.test(lower);
}

function canonicalizeExerciseName(name) {
  const normalized = normalizeExerciseName(name);
  if (!normalized || isNonVisualGuidance(normalized)) return null;
  const lower = normalized.toLowerCase();
  const mapped = CANONICAL_MOVEMENTS.find((entry) => entry.match.test(lower));
  if (mapped) return mapped.name;

  const withoutLeadingDose = normalized
    .replace(/^\d+\s*x\s*\d+(?:\s*[-/]\s*\d+)?\s*/i, '')
    .replace(/^\d+(?:\.\d+)?\s*(?:min(?:ute)?s?|sec(?:ond)?s?)\s*/i, '');
  const withoutTrailingDose = withoutLeadingDose
    .replace(/\s+(?:x|for)\s+\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?.*$/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:reps?|meters?|metres?|m|seconds?|secs?|s|minutes?|mins?)(?:\s*\/\s*side)?.*$/i, '')
    .replace(/\s*[-:]\s*\d+(?:\.\d+)?.*$/i, '')
    .trim();
  return withoutTrailingDose.slice(0, 100) || null;
}

function canonicalKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function hasLocalFormImage(name) {
  const normalized = normalizeExerciseName(name).toLowerCase();
  return LOCAL_FORM_IMAGE_MATCHERS.some((matcher) => matcher(normalized));
}

async function requestExerciseImageIfMissing({ userId, exerciseName, source = 'workout' }) {
  const exampleText = normalizeExerciseName(exerciseName);
  const name = canonicalizeExerciseName(exampleText);
  if (!userId || !name || name.toLowerCase() === 'unknown') {
    return { queued: false, reason: 'not_visual' };
  }
  if (hasLocalFormImage(name)) return { queued: false, reason: 'local_image' };

  try {
    const exercise = await dbGet(
      'SELECT id, how_to_image_url FROM exercises WHERE LOWER(name)=LOWER(?) AND approved=1 LIMIT 1',
      [name]
    );
    if (String(exercise?.how_to_image_url || '').trim()) {
      return { queued: false, reason: 'catalog_image' };
    }
    const key = canonicalKey(name);
    if (!key) return { queued: false, reason: 'invalid_name' };
    const cleanSource = normalizeExerciseName(source).slice(0, 80) || 'workout';

    await dbRun(
      `INSERT INTO exercise_image_requests
         (id, canonical_key, display_name, example_text, source, known_exercise)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (canonical_key) DO UPDATE SET
         display_name=EXCLUDED.display_name,
         example_text=EXCLUDED.example_text,
         source=EXCLUDED.source,
         known_exercise=CASE
           WHEN exercise_image_requests.known_exercise=1 OR EXCLUDED.known_exercise=1 THEN 1
           ELSE 0
         END,
         occurrence_count=exercise_image_requests.occurrence_count + 1,
         status=CASE
           WHEN exercise_image_requests.status IN ('reviewed', 'shipped', 'closed') THEN 'new'
           ELSE exercise_image_requests.status
         END,
         last_seen_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP`,
      [uuidv4(), key, name, exampleText.slice(0, 180), cleanSource, exercise ? 1 : 0]
    );
    return { queued: true, canonicalKey: key, displayName: name };
  } catch (err) {
    console.error('[exercise-image-request]', err.message);
    return { queued: false, reason: 'storage_error' };
  }
}

async function requestImagesForWorkoutItems({ userId, items, source }) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const exerciseName = typeof item === 'string' ? item : item?.name || item?.exercise_name;
    await requestExerciseImageIfMissing({ userId, exerciseName, source });
  }
}

module.exports = {
  requestExerciseImageIfMissing,
  requestImagesForWorkoutItems,
  _test: { canonicalizeExerciseName, canonicalKey, hasLocalFormImage, isNonVisualGuidance, normalizeExerciseName },
};
