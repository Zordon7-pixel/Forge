const router = require('express').Router();
const auth = require('../middleware/auth');
const { dbGet } = require('../db');

/* ─── Category definitions ─── */
const CATEGORIES = [
  { id: 'hip-focused',  label: 'Hip-Focused',  icon: 'Activity'    },
  { id: 'leg-focused',  label: 'Leg-Focused',  icon: 'Footprints'  },
  { id: 'full-body',    label: 'Full-Body',    icon: 'LayoutGrid'  },
  { id: 'upper-body',   label: 'Upper-Body',   icon: 'MoveUp'      },
  { id: 'lower-back',   label: 'Lower-Back',   icon: 'RefreshCw'   },
];

/* ─── Source definitions, normalized into canonical focus pools below ─── */
const BASE_POOLS = {
  'hip-focused': [
    { id: 'hip-flexor-lunge', name: 'Hip Flexor Lunge', duration: 30, durationLabel: '30 sec each side', cue: 'Step into a deep lunge with your front knee at 90 degrees and your back knee near the floor. Shift your hips forward until you feel the stretch through the front of your back hip.' },
    { id: 'pigeon-pose', name: 'Pigeon Pose', duration: 45, durationLabel: '45 sec each side', cue: 'From all fours, slide one knee forward behind your wrist and extend the opposite leg straight behind. Lower your hips toward the floor and breathe deeply into the outer hip.' },
    { id: 'butterfly', name: 'Butterfly Stretch', duration: 45, durationLabel: '45 sec', cue: 'Sit tall with the soles of your feet together and let your knees lower comfortably without pressing them.' },
    { id: 'figure-4', name: 'Figure-4 Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Cross one ankle over the opposite thigh and draw the legs closer only through a comfortable range.' },
    { id: 'lateral-lunge-hold', name: 'Lateral Lunge Hold', duration: 30, durationLabel: '30 sec each side', cue: 'Step wide to one side and sink into that knee, keeping the other leg straight. Keep your chest up and feel the stretch through the inner thigh and hip.' },
    { id: 'sumo-squat-hold', name: 'Sumo Squat Hold', duration: 45, durationLabel: '45 sec', cue: 'Use a wide stance and lower only to a comfortable depth with your knees tracking over your toes.' },
    { id: 'standing-hip-circle', name: 'Standing Hip Circle', duration: 30, durationLabel: '30 sec each direction', cue: 'Stand with feet hip-width apart and hands on hips. Draw large slow circles with your hips, keeping your feet planted. Reverse direction halfway through.' },
    { id: 'seated-hip-rotation', name: 'Seated Hip Rotation', duration: 30, durationLabel: '30 sec each side', cue: 'Sit cross-legged and place one hand on your opposite knee. Gently rotate your upper body toward that side and hold, keeping your spine tall.' },
  ],
  'leg-focused': [
    { id: 'quad-stretch', name: 'Quad Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Stand on one leg and pull your opposite foot toward your glutes. Keep your knees together and stand tall. Use a wall for balance if needed.' },
    { id: 'hamstring-seated', name: 'Seated Hamstring Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Sit with one leg extended and the other bent. Hinge at your hips and reach toward the toes of the extended leg, keeping your back flat.' },
    { id: 'calf-wall', name: 'Calf Wall Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Press both hands on a wall and step one foot back with the heel flat on the floor. Lean in until you feel the stretch through the back of your lower leg.' },
    { id: 'standing-it-band', name: 'Standing IT Band Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Cross one leg behind the other and reach the opposite arm overhead, leaning away. Feel the stretch along the outer thigh and hip.' },
    { id: 'standing-hamstring-fold', name: 'Standing Forward Fold', duration: 45, durationLabel: '45 sec', cue: 'Stand with feet hip-width apart. Hinge at your hips and let your upper body hang toward the floor with soft knees. Relax your neck and breathe.' },
    { id: 'inner-thigh-stretch', name: 'Inner Thigh Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'From a wide stance, shift your weight to one leg and sink into a side lunge. Keep the extended leg straight and press the opposite hip down.' },
    { id: 'kneeling-quad', name: 'Kneeling Quad Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'From a lunge position, lower your back knee to the floor. Tuck your pelvis under and lean slightly forward to feel the front of the hip and quad open up.' },
    { id: 'toe-touch-both', name: 'Seated Toe Touch', duration: 30, durationLabel: '30 sec', cue: 'Sit with both legs extended in front of you. Flex your feet and hinge forward from your hips, reaching toward your toes while keeping your back as flat as possible.' },
  ],
  'full-body': [
    { id: 'childs-pose', name: "Child's Pose", duration: 45, durationLabel: '45 sec', cue: 'Kneel with toes together and knees wide. Sit back toward your heels and extend your arms forward on the floor. Let your torso melt toward the ground with each exhale.' },
    { id: 'cat-cow', name: 'Cat-Cow', duration: 45, durationLabel: '45 sec — 10 slow reps', cue: 'On all fours, alternate between arching your back up (cat) and dropping your belly down (cow). Move slowly and match each position with your breath.' },
    { id: 'downward-dog', name: 'Downward Dog', duration: 45, durationLabel: '45 sec', cue: 'From all fours, tuck your toes and lift your hips toward the ceiling, forming an inverted V. Press through your hands and slowly pedal your heels to stretch the calves.' },
    { id: 'cobra', name: 'Cobra Stretch', duration: 30, durationLabel: '30 sec', cue: 'Lie face down with hands under your shoulders. Press through your palms and lift your chest, keeping your elbows slightly bent. Hold and breathe into the front of your torso.' },
    { id: 'worlds-greatest', name: "World's Greatest Stretch", duration: 30, durationLabel: '30 sec each side', cue: 'Step into a deep lunge, place both hands inside your front foot, then rotate and reach one arm to the ceiling. Hold at the top, then switch sides.' },
    { id: 'standing-side-bend', name: 'Standing Side Bend', duration: 30, durationLabel: '30 sec each side', cue: 'Stand tall with feet together. Raise one arm overhead and lean away to the opposite side, feeling the stretch along your side body from hip to fingertip.' },
    { id: 'inchworm', name: 'Inchworm', duration: 45, durationLabel: '45 sec — 6 reps', cue: 'Stand tall, hinge forward and walk your hands out to a plank, pause, then walk them back and stand. Move slowly and feel the full-body lengthening with each rep.' },
    { id: 'trunk-rotation', name: 'Trunk Rotation', duration: 45, durationLabel: '45 sec', cue: 'Sit cross-legged on the floor. Rotate your upper body to one side, placing your opposite hand on your outer knee. Keep your spine long and breathe into the twist.' },
  ],
  'upper-body': [
    { id: 'shoulder-cross', name: 'Cross-Body Shoulder Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Bring one arm straight across your chest and hold it just above the elbow with your opposite hand. Gently pull until you feel the stretch across the back of the shoulder.' },
    { id: 'chest-opener', name: 'Chest Opener', duration: 45, durationLabel: '45 sec', cue: 'Stand tall and interlace your fingers behind your back. Squeeze your shoulder blades together, lift your hands away from your body, and open your chest toward the ceiling.' },
    { id: 'tricep-stretch', name: 'Overhead Tricep Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Raise one arm overhead and bend the elbow so your hand drops behind your head. Use your other hand to gently press the elbow back and hold the stretch.' },
    { id: 'neck-tilt', name: 'Neck Tilt', duration: 30, durationLabel: '30 sec each side', cue: 'Sit or stand tall and slowly tilt your ear toward your shoulder. Keep both shoulders relaxed and down. Use a light hand to add a gentle assist if comfortable.' },
    { id: 'overhead-lat', name: 'Overhead Lat Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Raise one arm overhead and lean toward the opposite side while holding a wall or doorframe for support. Feel the stretch along the side of your torso and lats.' },
    { id: 'wrist-flexor', name: 'Wrist Flexor Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Extend one arm in front with palm facing up. Use your other hand to gently press the fingers toward the floor until you feel the stretch along your forearm.' },
    { id: 'doorway-chest', name: 'Doorway Chest Stretch', duration: 30, durationLabel: '30 sec', cue: 'Stand in a doorway with both elbows bent at 90 degrees and forearms on the frame. Lean forward until you feel the stretch across your chest and front shoulders.' },
    { id: 'upper-trap', name: 'Upper Trap Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Sit tall and tilt your head to one side. Place the same-side hand on the top of your head and apply light pressure. Keep the opposite shoulder from rising.' },
  ],
  'lower-back': [
    { id: 'cat-cow-lb', name: 'Cat-Cow', duration: 45, durationLabel: '45 sec — 10 slow reps', cue: 'On all fours, alternate between arching your back up (cat) and dropping your belly down (cow). Move slowly with your breath to mobilize the full lumbar spine.' },
    { id: 'knee-to-chest', name: 'Knee-to-Chest Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Lie on your back and pull one knee toward your chest. Keep the other leg flat or bent with foot on the floor. Hold the knee close and breathe into the lower back.' },
    { id: 'supine-twist', name: 'Supine Spinal Twist', duration: 45, durationLabel: '45 sec each side', cue: 'Lie on your back, pull one knee to your chest, then cross it over your body toward the floor. Extend the same-side arm out and look in the opposite direction.' },
    { id: 'childs-pose-lb', name: "Child's Pose", duration: 45, durationLabel: '45 sec', cue: 'Kneel with toes together and knees wide. Sit back toward your heels and extend your arms forward. Focus on relaxing the lower back with every exhale.' },
    { id: 'bridge-hold', name: 'Bridge Hold', duration: 30, durationLabel: '30 sec — 3 reps', cue: 'Lie on your back with knees bent. Press through your feet and lift your hips toward the ceiling, squeezing glutes at the top. Lower slowly and repeat.' },
    { id: 'pelvic-tilt', name: 'Pelvic Tilt', duration: 30, durationLabel: '30 sec', cue: 'Lie on your back with knees bent. Gently flatten your lower back against the floor by tightening your abs and tilting your pelvis. Hold for 2 seconds, release, repeat.' },
    { id: 'trunk-rotation-lb', name: 'Trunk Rotation', duration: 45, durationLabel: '45 sec each side', cue: 'Sit cross-legged and place one hand on your opposite knee. Gently rotate your upper body and hold, breathing into the lower back and obliques.' },
    { id: 'hip-flexor-back', name: 'Hip Flexor Stretch', duration: 30, durationLabel: '30 sec each side', cue: 'Kneel in a supported lunge, tuck your pelvis slightly, and stay within a comfortable range.' },
  ],
};

const LOCAL_IMAGE_BY_ID = Object.freeze({
  'hip-flexor-lunge': '/stretches/hip-flexor-male.png',
  'pigeon-pose': '/stretches/pigeon-pose.webp',
  butterfly: '/stretches/butterfly.webp',
  'figure-4': '/stretches/figure-four.png',
  'lateral-lunge-hold': '/stretches/lateral-lunge-hold.webp',
  'sumo-squat-hold': '/stretches/sumo-squat-hold.webp',
  'standing-hip-circle': '/stretches/hip-circles.png',
  'seated-hip-rotation': '/stretches/seated-hip-rotation.webp',
  'quad-stretch': '/stretches/standing-quad.png',
  'hamstring-seated': '/stretches/hamstring-stretch.png',
  'calf-wall': '/stretches/calf-stretch.png',
  'standing-it-band': '/stretches/standing-it-band.webp',
  'standing-hamstring-fold': '/stretches/hamstring-stretch.png',
  'inner-thigh-stretch': '/stretches/inner-thigh-stretch.webp',
  'kneeling-quad': '/stretches/kneeling-quad.webp',
  'toe-touch-both': '/stretches/hamstring-stretch.png',
  'childs-pose': '/stretches/childs-pose.png',
  'cat-cow': '/stretches/cat-cow.webp',
  'downward-dog': '/stretches/downward-dog.webp',
  cobra: '/stretches/cobra.webp',
  'worlds-greatest': '/stretches/worlds-greatest.webp',
  'standing-side-bend': '/stretches/standing-side-bend.webp',
  inchworm: '/stretches/inchworm.webp',
  'trunk-rotation': '/stretches/trunk-rotation.webp',
  'shoulder-cross': '/stretches/cross-body-shoulder.webp',
  'chest-opener': '/stretches/chest-opener.webp',
  'tricep-stretch': '/stretches/overhead-tricep.webp',
  'neck-tilt': '/stretches/neck-tilt.webp',
  'overhead-lat': '/stretches/overhead-lat.webp',
  'wrist-flexor': '/stretches/wrist-flexor.webp',
  'doorway-chest': '/stretches/doorway-chest.webp',
  'upper-trap': '/stretches/upper-trap.webp',
  'cat-cow-lb': '/stretches/cat-cow.webp',
  'knee-to-chest': '/stretches/knee-to-chest.webp',
  'supine-twist': '/stretches/supine-twist.webp',
  'childs-pose-lb': '/stretches/childs-pose.png',
  'bridge-hold': '/stretches/bridge-hold.webp',
  'pelvic-tilt': '/stretches/pelvic-tilt.webp',
  'trunk-rotation-lb': '/stretches/trunk-rotation.webp',
  'hip-flexor-back': '/stretches/hip-flexor-male.png',
});

function withLocalImage(stretch) {
  return {
    ...stretch,
    image_url: LOCAL_IMAGE_BY_ID[stretch.id] || '',
  };
}

const POOL_IDS = {
  'hip-focused': ['hip-flexor-lunge', 'pigeon-pose', 'butterfly', 'figure-4', 'lateral-lunge-hold', 'sumo-squat-hold', 'standing-hip-circle', 'seated-hip-rotation', 'knee-to-chest', 'pelvic-tilt', 'bridge-hold', 'worlds-greatest', 'inner-thigh-stretch', 'kneeling-quad', 'standing-it-band', 'supine-twist'],
  'leg-focused': ['quad-stretch', 'hamstring-seated', 'calf-wall', 'standing-it-band', 'standing-hamstring-fold', 'inner-thigh-stretch', 'kneeling-quad', 'toe-touch-both', 'downward-dog', 'lateral-lunge-hold', 'hip-flexor-lunge', 'butterfly', 'figure-4', 'standing-hip-circle', 'bridge-hold', 'worlds-greatest'],
  'full-body': ['childs-pose', 'cat-cow', 'downward-dog', 'cobra', 'worlds-greatest', 'standing-side-bend', 'inchworm', 'trunk-rotation', 'pelvic-tilt', 'bridge-hold', 'knee-to-chest', 'butterfly', 'hip-flexor-lunge', 'calf-wall', 'chest-opener', 'supine-twist'],
  'upper-body': ['shoulder-cross', 'chest-opener', 'tricep-stretch', 'neck-tilt', 'overhead-lat', 'wrist-flexor', 'doorway-chest', 'upper-trap', 'standing-side-bend', 'trunk-rotation', 'cat-cow', 'childs-pose', 'worlds-greatest', 'inchworm', 'cobra', 'downward-dog'],
  'lower-back': ['cat-cow', 'knee-to-chest', 'supine-twist', 'childs-pose', 'bridge-hold', 'pelvic-tilt', 'trunk-rotation', 'hip-flexor-lunge', 'cobra', 'downward-dog', 'seated-hip-rotation', 'figure-4', 'standing-hamstring-fold', 'hamstring-seated', 'pigeon-pose', 'worlds-greatest'],
};

const MOBILITY_IDS = new Set([
  'standing-hip-circle', 'seated-hip-rotation', 'pelvic-tilt', 'bridge-hold',
  'worlds-greatest', 'cat-cow', 'inchworm', 'trunk-rotation',
]);
const ALTERNATING_IDS = new Set(['seated-hip-rotation', 'worlds-greatest', 'trunk-rotation']);

function bodyAreaFor(stretch) {
  const name = stretch.name.toLowerCase();
  if (/wrist/.test(name)) return 'wrists & forearms';
  if (/neck|trap/.test(name)) return 'neck & upper traps';
  if (/shoulder|chest|tricep/.test(name)) return 'chest, shoulders & arms';
  if (/lat|side bend/.test(name)) return 'lats & side body';
  if (/calf|downward dog/.test(name)) return 'calves, ankles & hamstrings';
  if (/hamstring|toe touch|forward fold/.test(name)) return 'hamstrings';
  if (/quad/.test(name)) return 'quadriceps & hip flexors';
  if (/butterfly|inner thigh|lateral|sumo/.test(name)) return 'adductors, hips & glutes';
  if (/hip|pigeon|figure/.test(name)) return 'hips & glutes';
  if (/knee-to-chest|bridge/.test(name)) return 'glutes & lower back';
  if (/cat-cow|pelvic|twist|trunk|cobra/.test(name)) return 'spine, core & lower back';
  return 'full-body mobility';
}

const BASE_MOVEMENTS = Object.fromEntries(
  Object.values(BASE_POOLS).flat().map((stretch) => [stretch.id, stretch])
);

function canonicalMovement(id) {
  const source = BASE_MOVEMENTS[id];
  const type = MOBILITY_IDS.has(id) ? 'mobility' : 'static';
  const sideMode = type === 'static' && /each side/i.test(source.durationLabel)
    ? 'each-side'
    : (ALTERNATING_IDS.has(id) ? 'alternating' : 'bilateral');
  const firstCue = String(source.cue || '').split('. ')[0].replace(/\.$/, '');
  return Object.freeze({
    ...source,
    image_url: LOCAL_IMAGE_BY_ID[id],
    reps: source.durationLabel,
    type,
    muscle: bodyAreaFor(source),
    cue: `${firstCue}. Keep the range gentle and controlled.`,
    sideMode,
    sides: sideMode === 'each-side' ? 2 : 1,
  });
}

const canonicalIds = [...new Set(Object.values(POOL_IDS).flat())];
const MOVEMENTS = Object.freeze(Object.fromEntries(
  canonicalIds.map((id) => [id, canonicalMovement(id)])
));
const POOLS = Object.freeze(Object.fromEntries(
  Object.entries(POOL_IDS).map(([category, ids]) => [category, Object.freeze(ids.map((id) => MOVEMENTS[id]))])
));

/* ─── Muscle group → category mapping ─── */
const MUSCLE_MAP = {
  'glutes': 'hip-focused', 'hip flexors': 'hip-focused', 'hips': 'hip-focused',
  'quads': 'leg-focused', 'quadriceps': 'leg-focused', 'hamstrings': 'leg-focused',
  'calves': 'leg-focused', 'legs': 'leg-focused',
  'chest': 'upper-body', 'pecs': 'upper-body', 'shoulders': 'upper-body',
  'deltoids': 'upper-body', 'triceps': 'upper-body', 'biceps': 'upper-body', 'arms': 'upper-body',
  'lats': 'lower-back', 'back': 'lower-back', 'lower back': 'lower-back', 'lumbar': 'lower-back',
  'core': 'full-body', 'abs': 'full-body', 'full body': 'full-body', 'cardio': 'full-body',
};

function shuffle(arr, random = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const value = Math.max(0, Math.min(0.999999, Number(random()) || 0));
    const j = Math.floor(value * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseExcludedIds(value) {
  if (typeof value !== 'string') return [];
  const seen = new Set();
  const output = [];
  for (const rawId of value.slice(0, 4096).split(',')) {
    const id = rawId.trim();
    if (!/^[a-z0-9-]{1,64}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
    if (output.length >= 48) break;
  }
  return output;
}

function parseRoutineCount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 8;
  const normalized = String(value).trim();
  return ['5', '8', '12'].includes(normalized) ? Number(normalized) : 8;
}

function selectRoutine(pool, excludedIds = [], count = 8, random = Math.random, previousIds = []) {
  const unique = [];
  const seen = new Set();
  for (const stretch of Array.isArray(pool) ? pool : []) {
    const id = typeof stretch?.id === 'string' ? stretch.id : '';
    if (!/^[a-z0-9-]{1,64}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(stretch);
  }
  const parsedCount = typeof count === 'number'
    ? count
    : (typeof count === 'string' && /^\d+$/.test(count.trim()) ? Number(count) : 0);
  const limit = Math.max(0, Math.min(Number.isFinite(parsedCount) ? Math.trunc(parsedCount) : 0, unique.length));
  if (!limit) return [];

  const excluded = new Set(Array.isArray(excludedIds) ? excludedIds.slice(0, 48) : []);
  const previous = (Array.isArray(previousIds) ? previousIds : [])
    .filter((id) => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id))
    .slice(0, 12);
  const immediatelyPrevious = new Set(previous);
  const unseen = shuffle(unique.filter((stretch) => !excluded.has(stretch.id)), random);
  const older = shuffle(unique.filter((stretch) => (
    excluded.has(stretch.id) && !immediatelyPrevious.has(stretch.id)
  )), random);
  const justUsed = shuffle(unique.filter((stretch) => immediatelyPrevious.has(stretch.id)), random);
  const selected = [...unseen, ...older, ...justUsed].slice(0, limit);
  const selectedIds = selected.map((stretch) => stretch.id);
  const exactRepeat = selectedIds.length === previous.length
    && selectedIds.every((id, index) => id === previous[index]);
  if (exactRepeat && selected.length > 1) {
    const lastIndex = selected.length - 1;
    const swap = selected[lastIndex];
    selected[lastIndex] = selected[lastIndex - 1];
    selected[lastIndex - 1] = swap;
  } else if (exactRepeat && selected.length === 1) {
    const alternative = unique.find((stretch) => stretch.id !== previous[0]);
    if (alternative) selected[0] = alternative;
  }
  return selected.map(withLocalImage);
}

function estimateRoutineSeconds(routine) {
  return (Array.isArray(routine) ? routine : []).reduce((total, stretch) => {
    const duration = Number(stretch?.duration);
    if (!Number.isFinite(duration) || duration < 0) return total;
    return total + duration * (stretch?.sides === 2 ? 2 : 1);
  }, 0);
}

/* ─── GET /api/stretches/categories ─── */
router.get('/categories', auth, (req, res) => {
  res.json({ categories: CATEGORIES });
});

/* ─── GET /api/stretches/recommended ─── */
router.get('/recommended', auth, async (req, res) => {
  try {
    const session = await dbGet(
      'SELECT * FROM workout_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );

    let recommendedCategory = 'full-body';
    let reason = 'A general mobility routine covering several body areas';

    if (session) {
      let muscles = [];
      try {
        const parsedMuscles = JSON.parse(session.muscle_groups || '[]');
        if (Array.isArray(parsedMuscles)) {
          muscles = parsedMuscles.filter((muscle) => typeof muscle === 'string' && muscle.trim());
          if (muscles.length !== parsedMuscles.length) {
            console.warn('[stretches/recommended] ignored non-string muscle_groups values');
          }
        } else {
          console.warn('[stretches/recommended] muscle_groups was not an array');
        }
      } catch (err) {
        console.error('[stretches/recommended] invalid muscle_groups JSON:', err.message);
      }
      for (const muscle of muscles) {
        const cat = MUSCLE_MAP[muscle.toLowerCase()];
        if (cat) {
          recommendedCategory = cat;
          const catLabel = CATEGORIES.find(c => c.id === cat)?.label || cat;
          reason = `Based on your ${muscle} workout — a ${catLabel.toLowerCase()} mobility routine`;
          break;
        }
      }
      if (recommendedCategory === 'full-body' && muscles.length === 0) {
        reason = 'No muscle group data found — full-body recovery recommended';
      }
    } else {
      reason = 'No recent workout found — starting with full-body recovery';
    }

    const pool = POOLS[recommendedCategory];
    const count = parseRoutineCount(req.query.count);
    const stretches = selectRoutine(
      pool,
      parseExcludedIds(req.query.exclude),
      count,
      Math.random,
      parseExcludedIds(req.query.previous),
    );
    res.json({
      recommendedCategory,
      reason,
      stretches,
      actualCount: stretches.length,
      estimatedSeconds: estimateRoutineSeconds(stretches),
    });
  } catch (err) {
    console.error('[stretches/recommended] failed:', err.message);
    res.status(500).json({ error: 'Failed to get recommended stretches' });
  }
});

/* ─── GET /api/stretches?category=X ─── */
router.get('/', auth, (req, res) => {
  const category = req.query.category;
  if (!category || !POOLS[category]) return res.status(400).json({ error: 'Invalid or missing category' });
  const pool = POOLS[category];
  const count = parseRoutineCount(req.query.count);
  const stretches = selectRoutine(
    pool,
    parseExcludedIds(req.query.exclude),
    count,
    Math.random,
    parseExcludedIds(req.query.previous),
  );
  res.json({
    stretches,
    actualCount: stretches.length,
    estimatedSeconds: estimateRoutineSeconds(stretches),
  });
});

module.exports = router;
module.exports._test = {
  LOCAL_IMAGE_BY_ID,
  MOVEMENTS,
  POOLS,
  estimateRoutineSeconds,
  parseExcludedIds,
  parseRoutineCount,
  selectRoutine,
  withLocalImage,
};
