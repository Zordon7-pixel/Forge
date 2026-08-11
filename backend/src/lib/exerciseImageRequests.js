const { dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');

const LOCAL_FORM_IMAGE_MATCHERS = [
  (name) => /^90\/90 breathing$/.test(name),
  (name) => /^90\/90 hip switch(?:es)?$/.test(name),
  (name) => /^low box jumps?$/.test(name),
  (name) => /^box jumps?$/.test(name),
  (name) => /^a[- ]skips?$/.test(name),
  (name) => /^a[- ]march(?:es)?$/.test(name),
  (name) => /^pogo (?:hops?|jumps?)$/.test(name),
  (name) => /^dead bug$/.test(name),
  (name) => /^pallof press$/.test(name),
  (name) => /^seated calf raises?$/.test(name),
  (name) => /^(?:bodyweight )?standing calf raises?$/.test(name),
  (name) => /^kettlebell swings?$/.test(name),
  (name) => /^band pull[- ]aparts?$/.test(name),
  (name) => /^shoulder circles?$/.test(name),
  (name) => /^foam rolling$/.test(name),
  (name) => /^(?:flat )?(?:barbell )?bench press$/.test(name),
  (name) => /^chest[- ]supported rows?$/.test(name),
  (name) => /^incline dumbbell press$/.test(name),
  (name) => /^(?:flat )?dumbbell bench press$/.test(name),
  (name) => /^(?:barbell )?(?:back )?squat$/.test(name),
  (name) => /^(?:conventional |barbell )?deadlift$/.test(name),
  (name) => /^barbell (?:bent[- ]over )?row$/.test(name),
  (name) => /^(?:standing )?dumbbell (?:overhead|shoulder) press$/.test(name),
  (name) => /^(?:standard )?push[- ]?ups?$/.test(name),
  (name) => /^(?:front |forearm )?plank(?: hold)?$/.test(name),
  (name) => /^barbell (?:biceps )?curl$/.test(name),
  (name) => /^(?:rope )?triceps? pushdown$/.test(name),
  (name) => /^(?:strict )?pull[- ]?ups?$/.test(name),
  (name) => /^lat pulldown$/.test(name),
  (name) => /^(?:dynamic )?leg swings?$/.test(name),
  (name) => /^(?:kneeling )?hip flexor (?:stretch|lunge)$/.test(name),
  (name) => /^hip circles?$/.test(name),
  (name) => /^high knees$/.test(name),
  (name) => /^butt kicks$/.test(name),
  (name) => /^(?:ankle rolls?|ankle circles?)$/.test(name),
  (name) => /^arm swings?$/.test(name),
  (name) => /^walking lunges$/.test(name),
  (name) => /^(?:standing )?quad stretch$/.test(name),
  (name) => /^hamstring stretch$/.test(name),
  (name) => /^calf stretch$/.test(name),
  (name) => /^(?:figure[- ]?four(?: \(piriformis\))?|piriformis stretch)$/.test(name),
  (name) => /^child'?s pose$/.test(name),
  (name) => /^inchworms?$/.test(name),
  (name) => /^world'?s greatest stretch$/.test(name),
  (name) => /^(?:seated )?trunk rotations?$/.test(name),
  (name) => /^cat[- ]cow(?: flow)?$/.test(name),
  (name) => /^(?:glute )?bridge (?:hold|reps)$/.test(name),
  (name) => /^chest opener(?: (?:pulses|stretch))?$/.test(name),
  (name) => /^cross[- ]body shoulder (?:sweeps|stretch)$/.test(name),
  (name) => /^overhead lat (?:reaches|stretch)$/.test(name),
  (name) => /^wrist flexor (?:pulses|stretch)$/.test(name),
  (name) => /^pelvic tilts?$/.test(name),
  (name) => /^lateral lunge (?:shift|hold)$/.test(name),
  (name) => /^doorway chest stretch$/.test(name),
  (name) => /^overhead triceps? stretch$/.test(name),
  (name) => /^upper trap stretch$/.test(name),
  (name) => /^cobra stretch$/.test(name),
  (name) => /^(?:supine spinal twist|supine twist)$/.test(name),
  (name) => /^knee[- ]to[- ]chest stretch$/.test(name),
  (name) => /^kneeling quad stretch$/.test(name),
  (name) => /^butterfly stretch$/.test(name),
];

const CANONICAL_MOVEMENTS = [
  { match: /^world'?s greatest stretch$/, name: "World's Greatest Stretch" },
  { match: /^a[- ]?skips?(?: with tall posture)?$/, name: 'A-Skips' },
  { match: /^(?:a[- ]?march(?:es|ing)?|high[- ]knee march into skip)$/, name: 'A-March' },
  { match: /^pogo (?:hops?|jumps?|snaps?)$/, name: 'Pogo Hops' },
  { match: /^90\/90 breathing$/, name: '90/90 Breathing' },
  { match: /^90\/90 hip switch(?:es)?$/, name: '90/90 Hip Switch' },
  { match: /^band pull[- ]?aparts?$/, name: 'Band Pull-Apart' },
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
  if (/^(?:speed maintenance|short speed repeats?|fast (?:but controlled|relaxed running mechanics focus|controlled (?:reps?|effort))|(?:at )?strong mile\/5k effort)$/.test(lower)) return true;
  const generalMovement = /\b(walk|walking|jog|jogging|bike|biking|cycle|cycling|spin|row|rowing|movement)\b/;
  const guidance = /\b(easy|light|brisk|downshift|raise temperature|nasal breathing|cool ?down|warm ?up)\b/;
  return generalMovement.test(lower) && guidance.test(lower);
}

function canonicalizeExerciseName(name) {
  const normalized = normalizeExerciseName(name);
  if (!normalized || isNonVisualGuidance(normalized)) return null;
  const withoutLeadingDose = normalized
    .replace(/^\d+\s*x\s*\d+(?:\s*[-/]\s*\d+)?\s*(?:(?:kilometers?|kilometres?|meters?|metres?|miles?|km|mi|m)(?=\s|$))?\s*/i, '')
    .replace(/^\d+(?:\.\d+)?\s*(?:min(?:ute)?s?|sec(?:ond)?s?)\s*/i, '');
  const withoutTrailingDose = withoutLeadingDose
    .replace(/\s+(?:x|for)\s+\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?.*$/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:reps?|meters?|metres?|m|seconds?|secs?|s|minutes?|mins?)(?:\s*\/\s*side)?.*$/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*\/\s*side.*$/i, '')
    .replace(/\s*[-:]\s*\d+(?:\.\d+)?.*$/i, '')
    .trim();
  if (!withoutTrailingDose || isNonVisualGuidance(withoutTrailingDose)) return null;
  const mapped = CANONICAL_MOVEMENTS.find((entry) => entry.match.test(withoutTrailingDose.toLowerCase()));
  if (mapped) return mapped.name;
  return withoutTrailingDose.slice(0, 100);
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

function isLocalFormAsset(src = '') {
  const value = String(src || '').trim();
  return value.startsWith('/exercises/') || value.startsWith('/stretches/');
}

function exerciseNameFromItem(item) {
  if (typeof item === 'string') return item;
  return item?.name || item?.exercise || item?.exercise_name;
}

async function requestExerciseImageIfMissing({ userId, exerciseName, source = 'workout', ensureOnly = false }) {
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
    if (isLocalFormAsset(exercise?.how_to_image_url)) {
      return { queued: false, reason: 'catalog_image' };
    }
    const key = canonicalKey(name);
    if (!key) return { queued: false, reason: 'invalid_name' };
    const cleanSource = normalizeExerciseName(source).slice(0, 80) || 'workout';
    const insert = ensureOnly
      ? await dbRun(
        `INSERT INTO exercise_image_requests
           (id, canonical_key, display_name, example_text, source, known_exercise)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (canonical_key) DO NOTHING`,
        [uuidv4(), key, name, exampleText.slice(0, 180), cleanSource, exercise ? 1 : 0]
      )
      : await dbRun(
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
    if (ensureOnly && insert.changes === 0) {
      return { queued: false, reason: 'already_requested' };
    }
    return { queued: true, canonicalKey: key, displayName: name };
  } catch (err) {
    console.error('[exercise-image-request]', err.message);
    return { queued: false, reason: 'storage_error' };
  }
}

async function requestImagesForWorkoutItems({ userId, items, source, ensureOnly = false }) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const exerciseName = exerciseNameFromItem(item);
    await requestExerciseImageIfMissing({ userId, exerciseName, source, ensureOnly });
  }
}

module.exports = {
  requestExerciseImageIfMissing,
  requestImagesForWorkoutItems,
  _test: { canonicalizeExerciseName, canonicalKey, exerciseNameFromItem, hasLocalFormImage, isLocalFormAsset, isNonVisualGuidance, normalizeExerciseName },
};
