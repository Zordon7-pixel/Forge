const router = require('express').Router();
const auth = require('../middleware/auth');
const db = require('../db');

/* ─── Category definitions ─── */
const CATEGORIES = [
  { id: 'hip-focused',  label: 'Hip-Focused',  icon: 'Activity'    },
  { id: 'leg-focused',  label: 'Leg-Focused',  icon: 'Footprints'  },
  { id: 'full-body',    label: 'Full-Body',    icon: 'LayoutGrid'  },
  { id: 'upper-body',   label: 'Upper-Body',   icon: 'MoveUp'      },
  { id: 'lower-back',   label: 'Lower-Back',   icon: 'RefreshCw'   },
];

/* ─── Stretch pools (8+ per category) ─── */
const POOLS = {
  'hip-focused': [
    {
      id: 'hip-flexor-lunge',
      name: 'Hip Flexor Lunge',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Step into a deep lunge with your front knee at 90 degrees and your back knee near the floor. Shift your hips forward until you feel the stretch through the front of your back hip.',
    },
    {
      id: 'pigeon-pose',
      name: 'Pigeon Pose',
      duration: 45,
      durationLabel: '45 sec each side',
      cue: 'From all fours, slide one knee forward behind your wrist and extend the opposite leg straight behind. Lower your hips toward the floor and breathe deeply into the outer hip.',
    },
    {
      id: 'butterfly',
      name: 'Butterfly Stretch',
      duration: 45,
      durationLabel: '45 sec',
      cue: 'Sit with the soles of your feet together and let your knees drop toward the floor. Hold your feet, sit tall, and gently press your knees down with your elbows.',
    },
    {
      id: 'figure-4',
      name: 'Figure-4 Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Lie on your back, cross one ankle over your opposite thigh, and pull the lower leg toward your chest. Press the crossed knee away to deepen the stretch.',
    },
    {
      id: 'lateral-lunge-hold',
      name: 'Lateral Lunge Hold',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Step wide to one side and sink into that knee, keeping the other leg straight. Keep your chest up and feel the stretch through the inner thigh and hip.',
    },
    {
      id: 'sumo-squat-hold',
      name: 'Sumo Squat Hold',
      duration: 45,
      durationLabel: '45 sec',
      cue: 'Stand with feet wider than shoulder-width and toes turned out. Squat down and use your elbows to gently press your knees open, stretching the inner hips.',
    },
    {
      id: 'standing-hip-circle',
      name: 'Standing Hip Circle',
      duration: 30,
      durationLabel: '30 sec each direction',
      cue: 'Stand with feet hip-width apart and hands on hips. Draw large slow circles with your hips, keeping your feet planted. Reverse direction halfway through.',
    },
    {
      id: 'seated-hip-rotation',
      name: 'Seated Hip Rotation',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Sit cross-legged and place one hand on your opposite knee. Gently rotate your upper body toward that side and hold, keeping your spine tall.',
    },
  ],

  'leg-focused': [
    {
      id: 'quad-stretch',
      name: 'Quad Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Stand on one leg and pull your opposite foot toward your glutes. Keep your knees together and stand tall. Use a wall for balance if needed.',
    },
    {
      id: 'hamstring-seated',
      name: 'Seated Hamstring Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Sit with one leg extended and the other bent. Hinge at your hips and reach toward the toes of the extended leg, keeping your back flat.',
    },
    {
      id: 'calf-wall',
      name: 'Calf Wall Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Press both hands on a wall and step one foot back with the heel flat on the floor. Lean in until you feel the stretch through the back of your lower leg.',
    },
    {
      id: 'standing-it-band',
      name: 'Standing IT Band Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Cross one leg behind the other and reach the opposite arm overhead, leaning away. Feel the stretch along the outer thigh and hip.',
    },
    {
      id: 'standing-hamstring-fold',
      name: 'Standing Forward Fold',
      duration: 45,
      durationLabel: '45 sec',
      cue: 'Stand with feet hip-width apart. Hinge at your hips and let your upper body hang toward the floor with soft knees. Relax your neck and breathe.',
    },
    {
      id: 'inner-thigh-stretch',
      name: 'Inner Thigh Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'From a wide stance, shift your weight to one leg and sink into a side lunge. Keep the extended leg straight and press the opposite hip down.',
    },
    {
      id: 'kneeling-quad',
      name: 'Kneeling Quad Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'From a lunge position, lower your back knee to the floor. Tuck your pelvis under and lean slightly forward to feel the front of the hip and quad open up.',
    },
    {
      id: 'toe-touch-both',
      name: 'Seated Toe Touch',
      duration: 30,
      durationLabel: '30 sec',
      cue: 'Sit with both legs extended in front of you. Flex your feet and hinge forward from your hips, reaching toward your toes while keeping your back as flat as possible.',
    },
  ],

  'full-body': [
    {
      id: 'childs-pose',
      name: "Child's Pose",
      duration: 45,
      durationLabel: '45 sec',
      cue: 'Kneel with toes together and knees wide. Sit back toward your heels and extend your arms forward on the floor. Let your torso melt toward the ground with each exhale.',
    },
    {
      id: 'cat-cow',
      name: 'Cat-Cow',
      duration: 45,
      durationLabel: '45 sec — 10 slow reps',
      cue: 'On all fours, alternate between arching your back up (cat) and dropping your belly down (cow). Move slowly and match each position with your breath.',
    },
    {
      id: 'downward-dog',
      name: 'Downward Dog',
      duration: 45,
      durationLabel: '45 sec',
      cue: 'From all fours, tuck your toes and lift your hips toward the ceiling, forming an inverted V. Press through your hands and slowly pedal your heels to stretch the calves.',
    },
    {
      id: 'cobra',
      name: 'Cobra Stretch',
      duration: 30,
      durationLabel: '30 sec',
      cue: 'Lie face down with hands under your shoulders. Press through your palms and lift your chest, keeping your elbows slightly bent. Hold and breathe into the front of your torso.',
    },
    {
      id: 'worlds-greatest',
      name: "World's Greatest Stretch",
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Step into a deep lunge, place both hands inside your front foot, then rotate and reach one arm to the ceiling. Hold at the top, then switch sides.',
    },
    {
      id: 'standing-side-bend',
      name: 'Standing Side Bend',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Stand tall with feet together. Raise one arm overhead and lean away to the opposite side, feeling the stretch along your side body from hip to fingertip.',
    },
    {
      id: 'inchworm',
      name: 'Inchworm',
      duration: 45,
      durationLabel: '45 sec — 6 reps',
      cue: 'Stand tall, hinge forward and walk your hands out to a plank, pause, then walk them back and stand. Move slowly and feel the full-body lengthening with each rep.',
    },
    {
      id: 'trunk-rotation',
      name: 'Trunk Rotation',
      duration: 45,
      durationLabel: '45 sec',
      cue: 'Sit cross-legged on the floor. Rotate your upper body to one side, placing your opposite hand on your outer knee. Keep your spine long and breathe into the twist.',
    },
  ],

  'upper-body': [
    {
      id: 'shoulder-cross',
      name: 'Cross-Body Shoulder Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Bring one arm straight across your chest and hold it just above the elbow with your opposite hand. Gently pull until you feel the stretch across the back of the shoulder.',
    },
    {
      id: 'chest-opener',
      name: 'Chest Opener',
      duration: 45,
      durationLabel: '45 sec',
      cue: 'Stand tall and interlace your fingers behind your back. Squeeze your shoulder blades together, lift your hands away from your body, and open your chest toward the ceiling.',
    },
    {
      id: 'tricep-stretch',
      name: 'Overhead Tricep Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Raise one arm overhead and bend the elbow so your hand drops behind your head. Use your other hand to gently press the elbow back and hold the stretch.',
    },
    {
      id: 'neck-tilt',
      name: 'Neck Tilt',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Sit or stand tall and slowly tilt your ear toward your shoulder. Keep both shoulders relaxed and down. Use a light hand to add a gentle assist if comfortable.',
    },
    {
      id: 'overhead-lat',
      name: 'Overhead Lat Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Raise one arm overhead and lean toward the opposite side while holding a wall or doorframe for support. Feel the stretch along the side of your torso and lats.',
    },
    {
      id: 'wrist-flexor',
      name: 'Wrist Flexor Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Extend one arm in front with palm facing up. Use your other hand to gently press the fingers toward the floor until you feel the stretch along your forearm.',
    },
    {
      id: 'doorway-chest',
      name: 'Doorway Chest Stretch',
      duration: 30,
      durationLabel: '30 sec',
      cue: 'Stand in a doorway with both elbows bent at 90 degrees and forearms on the frame. Lean forward until you feel the stretch across your chest and front shoulders.',
    },
    {
      id: 'upper-trap',
      name: 'Upper Trap Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Sit tall and tilt your head to one side. Place the same-side hand on the top of your head and apply light pressure. Keep the opposite shoulder from rising.',
    },
  ],

  'lower-back': [
    {
      id: 'cat-cow-lb',
      name: 'Cat-Cow',
      duration: 45,
      durationLabel: '45 sec — 10 slow reps',
      cue: 'On all fours, alternate between arching your back up (cat) and dropping your belly down (cow). Move slowly with your breath to mobilize the full lumbar spine.',
    },
    {
      id: 'knee-to-chest',
      name: 'Knee-to-Chest Stretch',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Lie on your back and pull one knee toward your chest. Keep the other leg flat or bent with foot on the floor. Hold the knee close and breathe into the lower back.',
    },
    {
      id: 'supine-twist',
      name: 'Supine Spinal Twist',
      duration: 45,
      durationLabel: '45 sec each side',
      cue: 'Lie on your back, pull one knee to your chest, then cross it over your body toward the floor. Extend the same-side arm out and look in the opposite direction.',
    },
    {
      id: 'childs-pose-lb',
      name: "Child's Pose",
      duration: 45,
      durationLabel: '45 sec',
      cue: 'Kneel with toes together and knees wide. Sit back toward your heels and extend your arms forward. Focus on relaxing the lower back with every exhale.',
    },
    {
      id: 'bridge-hold',
      name: 'Bridge Hold',
      duration: 30,
      durationLabel: '30 sec — 3 reps',
      cue: 'Lie on your back with knees bent. Press through your feet and lift your hips toward the ceiling, squeezing glutes at the top. Lower slowly and repeat.',
    },
    {
      id: 'pelvic-tilt',
      name: 'Pelvic Tilt',
      duration: 30,
      durationLabel: '30 sec',
      cue: 'Lie on your back with knees bent. Gently flatten your lower back against the floor by tightening your abs and tilting your pelvis. Hold for 2 seconds, release, repeat.',
    },
    {
      id: 'trunk-rotation-lb',
      name: 'Trunk Rotation',
      duration: 45,
      durationLabel: '45 sec each side',
      cue: 'Sit cross-legged and place one hand on your opposite knee. Gently rotate your upper body and hold, breathing into the lower back and obliques.',
    },
    {
      id: 'hip-flexor-back',
      name: 'Hip Flexor Release',
      duration: 30,
      durationLabel: '30 sec each side',
      cue: 'Kneel in a lunge with your back knee down. Tuck your pelvis and hold. Tight hip flexors pull on the lumbar spine — releasing them relieves back tension.',
    },
  ],
};

/* ─── Muscle group → category mapping ─── */
const MUSCLE_MAP = {
  'glutes':        'hip-focused',
  'hip flexors':   'hip-focused',
  'hips':          'hip-focused',
  'quads':         'leg-focused',
  'quadriceps':    'leg-focused',
  'hamstrings':    'leg-focused',
  'calves':        'leg-focused',
  'legs':          'leg-focused',
  'chest':         'upper-body',
  'pecs':          'upper-body',
  'shoulders':     'upper-body',
  'deltoids':      'upper-body',
  'triceps':       'upper-body',
  'biceps':        'upper-body',
  'arms':          'upper-body',
  'lats':          'lower-back',
  'back':          'lower-back',
  'lower back':    'lower-back',
  'lumbar':        'lower-back',
  'core':          'full-body',
  'abs':           'full-body',
  'full body':     'full-body',
  'cardio':        'full-body',
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ─── GET /api/stretches/categories ─── */
router.get('/categories', auth, (req, res) => {
  res.json({ categories: CATEGORIES });
});

/* ─── GET /api/stretches/recommended ─── */
router.get('/recommended', auth, (req, res) => {
  const session = db.prepare(
    'SELECT * FROM workout_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1'
  ).get(req.user.id);

  let recommendedCategory = 'full-body';
  let reason = 'General recovery stretch for all muscle groups';

  if (session) {
    let muscles = [];
    try { muscles = JSON.parse(session.muscle_groups || '[]'); } catch (_) {}

    for (const muscle of muscles) {
      const cat = MUSCLE_MAP[muscle.toLowerCase()];
      if (cat) {
        recommendedCategory = cat;
        const catLabel = CATEGORIES.find(c => c.id === cat)?.label || cat;
        reason = `Based on your ${muscle} workout — ${catLabel} stretches will help you recover`;
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
  const count = 5 + Math.floor(Math.random() * 3); // 5–7
  const stretches = shuffle(pool).slice(0, count);

  res.json({ recommendedCategory, reason, stretches });
});

/* ─── GET /api/stretches?category=X ─── */
router.get('/', auth, (req, res) => {
  const category = req.query.category;
  if (!category || !POOLS[category]) {
    return res.status(400).json({ error: 'Invalid or missing category' });
  }
  const pool = POOLS[category];
  const count = 5 + Math.floor(Math.random() * 3); // 5–7
  const stretches = shuffle(pool).slice(0, count);
  res.json({ stretches });
});

module.exports = router;
