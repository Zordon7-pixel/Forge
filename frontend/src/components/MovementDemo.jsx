import { getVettedExerciseGuide } from '../lib/exerciseGuidePolicy'

const ACCENT = '#EAB308'
const BODY = '#d1d5db'
const MUTED = '#6b7280'
const PANEL = 'rgba(234,179,8,0.08)'
const PHOTO_DEMOS = [
  // Paired sources are female-left/male-right and cropped to the profile sex.
  {
    match: (lower) => /^90\/90 breathing$/.test(lower),
    src: '/exercises/90-90-breathing.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^90\/90 hip switch(?:es)?$/.test(lower),
    src: '/exercises/90-90-hip-switch.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^low box jumps?$/.test(lower),
    src: '/exercises/low-box-jump.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^box jumps?$/.test(lower),
    src: '/exercises/box-jump.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^a[- ]skips?$/.test(lower),
    src: '/exercises/a-skips.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^a[- ]march(?:es)?$/.test(lower),
    src: '/exercises/a-march.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^pogo (?:hops?|jumps?)$/.test(lower),
    src: '/exercises/pogo-hops.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^dead bug$/.test(lower),
    src: '/exercises/dead-bug.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^pallof press$/.test(lower),
    src: '/exercises/pallof-press.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^seated calf raises?$/.test(lower),
    src: '/exercises/seated-calf-raise.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:bodyweight )?standing calf raises?$/.test(lower),
    src: '/exercises/standing-calf-raise.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^kettlebell swings?$/.test(lower),
    src: '/exercises/kettlebell-swing.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^band pull[- ]aparts?$/.test(lower),
    src: '/exercises/band-pull-apart.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^shoulder circles?$/.test(lower),
    src: '/exercises/shoulder-circles.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^foam rolling$/.test(lower),
    src: '/exercises/foam-rolling.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:flat )?(?:barbell )?bench press$/.test(lower),
    src: '/exercises/barbell-bench-press.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^chest[- ]supported rows?$/.test(lower),
    src: '/exercises/chest-supported-row.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^incline dumbbell press$/.test(lower),
    src: '/exercises/incline-dumbbell-press.jpg',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:flat )?dumbbell bench press$/.test(lower),
    male: '/exercises/dumbbell-bench-press-male.png',
    female: '/exercises/dumbbell-bench-press-female.png',
  },
  {
    match: (lower) => /^(?:barbell )?(?:back )?squat$/.test(lower),
    src: '/exercises/squat.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:conventional |barbell )?deadlift$/.test(lower),
    src: '/exercises/deadlift.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^barbell (?:bent[- ]over )?row$/.test(lower),
    src: '/exercises/barbell-row.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:standing )?dumbbell (?:overhead|shoulder) press$/.test(lower),
    src: '/exercises/overhead-press.png',
    cropToSex: true,
    maleSide: 'left',
  },
  {
    match: (lower) => /^(?:standard )?push[- ]?ups?$/.test(lower),
    src: '/exercises/push-ups.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:front |forearm )?plank(?: hold)?$/.test(lower),
    src: '/exercises/plank.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^barbell (?:biceps )?curl$/.test(lower),
    src: '/exercises/barbell-curl.png',
    cropToSex: true,
    maleSide: 'left',
  },
  {
    match: (lower) => /^(?:rope )?triceps? pushdown$/.test(lower),
    src: '/exercises/tricep-pushdown.png',
    cropToSex: true,
    maleSide: 'left',
  },
  {
    match: (lower) => /^(?:strict )?pull[- ]?ups?$/.test(lower),
    src: '/exercises/pull-ups.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^lat pulldown$/.test(lower),
    src: '/exercises/lat-pulldown.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:dynamic )?leg swings?$/.test(lower),
    male: '/stretches/leg-swings-male.png',
    female: '/stretches/leg-swings-female.png',
  },
  {
    match: (lower) => /^(?:kneeling )?hip flexor (?:stretch|lunge)$/.test(lower),
    male: '/stretches/hip-flexor-male.png',
    female: '/stretches/hip-flexor-female.png',
  },
  {
    match: (lower) => /^hip circles?$/.test(lower),
    src: '/stretches/hip-circles.png',
    cropToSex: true,
    maleSide: 'left',
  },
  {
    match: (lower) => /^high knees$/.test(lower),
    src: '/stretches/high-knees.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^butt kicks$/.test(lower),
    src: '/stretches/butt-kicks.png',
    cropToSex: true,
    maleSide: 'left',
  },
  {
    match: (lower) => /^(?:ankle rolls?|ankle circles?)$/.test(lower),
    src: '/stretches/ankle-rolls.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^arm swings?$/.test(lower),
    src: '/stretches/arm-swings.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^walking lunges$/.test(lower),
    src: '/stretches/walking-lunges.png',
    cropToSex: true,
    maleSide: 'left',
  },
  {
    match: (lower) => /^(?:standing )?quad stretch$/.test(lower),
    src: '/stretches/standing-quad.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^hamstring stretch$/.test(lower),
    src: '/stretches/hamstring-stretch.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^calf stretch$/.test(lower),
    src: '/stretches/calf-stretch.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:figure[- ]?four(?: \(piriformis\))?|piriformis stretch)$/.test(lower),
    src: '/stretches/figure-four.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^child'?s pose$/.test(lower),
    src: '/stretches/childs-pose.png',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^inchworms?$/.test(lower),
    src: '/stretches/inchworm.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^world'?s greatest stretch$/.test(lower),
    src: '/stretches/worlds-greatest.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:seated )?trunk rotations?$/.test(lower),
    male: '/stretches/trunk-rotation-male.png',
    female: '/stretches/trunk-rotation-female.png',
  },
  {
    match: (lower) => /^cat[- ]cow(?: flow)?$/.test(lower),
    src: '/stretches/cat-cow.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:glute )?bridge (?:hold|reps)$/.test(lower),
    src: '/stretches/bridge-hold.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^chest opener(?: (?:pulses|stretch))?$/.test(lower),
    src: '/stretches/chest-opener.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^cross[- ]body shoulder (?:sweeps|stretch)$/.test(lower),
    src: '/stretches/cross-body-shoulder.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^overhead lat (?:reaches|stretch)$/.test(lower),
    src: '/stretches/overhead-lat.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^wrist flexor (?:pulses|stretch)$/.test(lower),
    src: '/stretches/wrist-flexor.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^pelvic tilts?$/.test(lower),
    src: '/stretches/pelvic-tilt.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^lateral lunge (?:shift|hold)$/.test(lower),
    src: '/stretches/lateral-lunge-hold.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^doorway chest stretch$/.test(lower),
    src: '/stretches/doorway-chest.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^overhead triceps? stretch$/.test(lower),
    src: '/stretches/overhead-tricep.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^upper trap stretch$/.test(lower),
    src: '/stretches/upper-trap.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^cobra stretch$/.test(lower),
    src: '/stretches/cobra.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^(?:supine spinal twist|supine twist)$/.test(lower),
    src: '/stretches/supine-twist.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^knee[- ]to[- ]chest stretch$/.test(lower),
    src: '/stretches/knee-to-chest.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^kneeling quad stretch$/.test(lower),
    src: '/stretches/kneeling-quad.webp',
    cropToSex: true,
    maleSide: 'right',
  },
  {
    match: (lower) => /^butterfly stretch$/.test(lower),
    src: '/stretches/butterfly.webp',
    cropToSex: true,
    maleSide: 'right',
  },
]

function getDemoKind(name = '') {
  const lower = String(name).toLowerCase()
  if (lower.includes('leg swing')) return 'leg-swing'
  if (lower.includes('high knee')) return 'high-knees'
  if (lower.includes('butt kick')) return 'quad'
  if (lower.includes('ankle') || lower.includes('calf raise')) return 'ankle'
  if (lower.includes('hip circle')) return 'hip-circle'
  if (lower.includes('arm swing')) return 'arm-swing'
  if (lower.includes('walking lunge') || lower === 'lunges' || lower.includes('lunge')) return 'lunge'
  if (lower.includes('pigeon') || lower.includes('butterfly') || lower.includes('inner thigh') || lower.includes('sumo')) return 'figure-four'
  if (lower.includes('quad')) return 'quad'
  if (lower.includes('hamstring') || lower.includes('romanian deadlift') || lower.includes('forward fold') || lower.includes('toe touch')) return 'hamstring'
  if (lower.includes('calf') || lower.includes('it band')) return 'calf'
  if (lower.includes('hip flexor')) return 'hip-flexor'
  if (lower.includes('figure') || lower.includes('piriformis') || lower.includes('glute')) return 'figure-four'
  if (lower.includes('child')) return 'childs-pose'
  if (lower.includes('cat-cow')) return 'core'
  if (lower.includes('downward') || lower.includes('cobra') || lower.includes('inchworm')) return 'plank'
  if (lower.includes('world') || lower.includes('side bend') || lower.includes('trunk rotation') || lower.includes('supine') || lower.includes('knee-to-chest') || lower.includes('bridge') || lower.includes('pelvic')) return 'core'
  if (lower.includes('shoulder') || lower.includes('chest') || lower.includes('lat') || lower.includes('wrist') || lower.includes('trap')) return 'raise'
  if (lower.includes('bench') || lower.includes('press') || lower.includes('skull')) return 'press'
  if (lower.includes('push-up') || lower.includes('push up') || lower.includes('dips')) return 'push'
  if (lower.includes('pull-up') || lower.includes('pulldown')) return 'pull'
  if (lower.includes('row')) return 'row'
  if (lower.includes('deadlift')) return 'deadlift'
  if (lower.includes('squat') || lower.includes('leg press')) return 'squat'
  if (lower.includes('curl')) return 'curl'
  if (lower.includes('tricep')) return 'tricep'
  if (lower.includes('plank') || lower.includes('wheel')) return 'plank'
  if (lower.includes('crunch') || lower.includes('twist') || lower.includes('leg raise')) return 'core'
  if (lower.includes('raise') || lower.includes('fly')) return 'raise'
  if (lower.includes('neck')) return 'neck'
  return 'stand'
}

function Line({ x1, y1, x2, y2, accent = false, width = 7 }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={accent ? ACCENT : BODY} strokeWidth={width} strokeLinecap="round" />
}

function Circle({ cx, cy, r = 11, accent = false }) {
  return <circle cx={cx} cy={cy} r={r} fill="none" stroke={accent ? ACCENT : BODY} strokeWidth="6" />
}

function Joint({ cx, cy }) {
  return <circle cx={cx} cy={cy} r="4" fill={ACCENT} />
}

function Arrow({ x1, y1, x2, y2 }) {
  return (
    <g opacity="0.9">
      <Line x1={x1} y1={y1} x2={x2} y2={y2} accent width={4} />
      <path d={`M ${x2} ${y2} l -8 -5 l 3 9 z`} fill={ACCENT} />
    </g>
  )
}

function BodyPose({ kind }) {
  switch (kind) {
    case 'leg-swing':
      return (
        <>
          <Circle cx={116} cy={40} />
          <Line x1={116} y1={52} x2={116} y2={110} />
          <Line x1={116} y1={68} x2={86} y2={82} />
          <Line x1={116} y1={68} x2={144} y2={82} />
          <Line x1={116} y1={110} x2={98} y2={170} />
          <Line x1={116} y1={110} x2={170} y2={116} accent />
          <path d="M 154 98 Q 180 112 154 132" fill="none" stroke={ACCENT} strokeWidth="4" strokeLinecap="round" />
        </>
      )
    case 'high-knees':
      return (
        <>
          <Circle cx={118} cy={36} />
          <Line x1={118} y1={48} x2={118} y2={98} />
          <Line x1={118} y1={66} x2={90} y2={48} />
          <Line x1={118} y1={66} x2={148} y2={84} />
          <Line x1={118} y1={98} x2={92} y2={168} />
          <Line x1={118} y1={98} x2={160} y2={104} accent />
          <Line x1={160} y1={104} x2={172} y2={146} accent />
          <Arrow x1={170} y1={136} x2={170} y2={96} />
        </>
      )
    case 'ankle':
      return (
        <>
          <Circle cx={118} cy={38} />
          <Line x1={118} y1={50} x2={118} y2={106} />
          <Line x1={118} y1={68} x2={92} y2={82} />
          <Line x1={118} y1={68} x2={144} y2={82} />
          <Line x1={118} y1={106} x2={100} y2={168} />
          <Line x1={118} y1={106} x2={150} y2={156} accent />
          <circle cx={150} cy={156} r="18" fill="none" stroke={ACCENT} strokeWidth="4" strokeDasharray="8 7" />
        </>
      )
    case 'hip-circle':
      return (
        <>
          <Circle cx={120} cy={38} />
          <Line x1={120} y1={50} x2={120} y2={104} />
          <Line x1={120} y1={68} x2={88} y2={68} />
          <Line x1={120} y1={68} x2={152} y2={68} />
          <Line x1={120} y1={104} x2={98} y2={170} />
          <Line x1={120} y1={104} x2={144} y2={170} />
          <circle cx={120} cy={104} r="28" fill="none" stroke={ACCENT} strokeWidth="4" strokeDasharray="10 8" />
        </>
      )
    case 'arm-swing':
    case 'raise':
      return (
        <>
          <Circle cx={120} cy={38} />
          <Line x1={120} y1={50} x2={120} y2={108} />
          <Line x1={120} y1={68} x2={72} y2={48} accent />
          <Line x1={120} y1={68} x2={168} y2={48} accent />
          <Line x1={120} y1={108} x2={98} y2={170} />
          <Line x1={120} y1={108} x2={144} y2={170} />
          <path d="M 80 70 Q 120 28 160 70" fill="none" stroke={ACCENT} strokeWidth="4" strokeLinecap="round" />
        </>
      )
    case 'lunge':
    case 'hip-flexor':
      return (
        <>
          <Circle cx={114} cy={36} />
          <Line x1={114} y1={48} x2={120} y2={102} />
          <Line x1={120} y1={66} x2={94} y2={90} />
          <Line x1={120} y1={66} x2={148} y2={82} />
          <Line x1={120} y1={102} x2={166} y2={132} accent />
          <Line x1={166} y1={132} x2={188} y2={172} accent />
          <Line x1={120} y1={102} x2={86} y2={142} />
          <Line x1={86} y1={142} x2={54} y2={170} />
        </>
      )
    case 'quad':
      return (
        <>
          <Circle cx={118} cy={36} />
          <Line x1={118} y1={48} x2={118} y2={106} />
          <Line x1={118} y1={66} x2={92} y2={84} />
          <Line x1={118} y1={66} x2={150} y2={128} accent />
          <Line x1={118} y1={106} x2={98} y2={170} />
          <Line x1={118} y1={106} x2={150} y2={136} accent />
          <Line x1={150} y1={136} x2={136} y2={174} accent />
        </>
      )
    case 'hamstring':
      return (
        <>
          <Circle cx={94} cy={44} />
          <Line x1={94} y1={56} x2={126} y2={102} />
          <Line x1={112} y1={80} x2={166} y2={148} accent />
          <Line x1={126} y1={102} x2={76} y2={170} />
          <Line x1={126} y1={102} x2={184} y2={172} accent />
          <Line x1={166} y1={172} x2={198} y2={172} accent />
        </>
      )
    case 'calf':
      return (
        <>
          <rect x="42" y="32" width="10" height="144" rx="5" fill={MUTED} opacity="0.5" />
          <Circle cx={116} cy={36} />
          <Line x1={116} y1={48} x2={122} y2={100} />
          <Line x1={122} y1={66} x2={52} y2={84} />
          <Line x1={122} y1={100} x2={92} y2={170} accent />
          <Line x1={122} y1={100} x2={172} y2={168} />
        </>
      )
    case 'figure-four':
      return (
        <>
          <Line x1={62} y1={140} x2={178} y2={140} />
          <Circle cx={80} cy={126} />
          <Line x1={92} y1={128} x2={132} y2={128} />
          <Line x1={132} y1={128} x2={168} y2={104} accent />
          <Line x1={132} y1={128} x2={164} y2={160} />
          <Line x1={132} y1={128} x2={98} y2={160} />
        </>
      )
    case 'childs-pose':
      return (
        <>
          <Circle cx={74} cy={130} />
          <Line x1={86} y1={132} x2={140} y2={132} />
          <Line x1={140} y1={132} x2={188} y2={118} accent />
          <Line x1={132} y1={136} x2={104} y2={170} />
          <Line x1={104} y1={170} x2={72} y2={170} />
        </>
      )
    case 'press':
      return (
        <>
          <rect x="54" y="156" width="132" height="10" rx="5" fill={MUTED} opacity="0.6" />
          <Circle cx={82} cy={132} />
          <Line x1={94} y1={132} x2={142} y2={132} />
          <Line x1={112} y1={120} x2={112} y2={78} accent />
          <Line x1={154} y1={120} x2={154} y2={78} accent />
          <Line x1={96} y1={78} x2={170} y2={78} accent width={5} />
        </>
      )
    case 'push':
    case 'plank':
      return (
        <>
          <Circle cx={66} cy={112} />
          <Line x1={78} y1={114} x2={172} y2={142} accent />
          <Line x1={104} y1={122} x2={92} y2={170} />
          <Line x1={150} y1={136} x2={192} y2={170} />
          <Line x1={192} y1={170} x2={208} y2={170} />
        </>
      )
    case 'pull':
      return (
        <>
          <Line x1={62} y1={38} x2={178} y2={38} accent width={5} />
          <Circle cx={120} cy={86} />
          <Line x1={120} y1={74} x2={96} y2={40} accent />
          <Line x1={120} y1={74} x2={144} y2={40} accent />
          <Line x1={120} y1={98} x2={120} y2={142} />
          <Line x1={120} y1={142} x2={96} y2={178} />
          <Line x1={120} y1={142} x2={144} y2={178} />
        </>
      )
    case 'row':
    case 'deadlift':
      return (
        <>
          <Line x1={52} y1={166} x2={188} y2={166} accent width={5} />
          <Circle cx={92} cy={72} />
          <Line x1={100} y1={84} x2={142} y2={120} />
          <Line x1={126} y1={108} x2={76} y2={160} accent />
          <Line x1={126} y1={108} x2={176} y2={160} />
          <Line x1={142} y1={120} x2={168} y2={166} accent />
        </>
      )
    case 'squat':
      return (
        <>
          <Line x1={74} y1={56} x2={166} y2={56} accent width={5} />
          <Circle cx={120} cy={42} />
          <Line x1={120} y1={54} x2={124} y2={104} />
          <Line x1={124} y1={104} x2={96} y2={146} accent />
          <Line x1={96} y1={146} x2={74} y2={176} accent />
          <Line x1={124} y1={104} x2={154} y2={146} />
          <Line x1={154} y1={146} x2={174} y2={176} />
        </>
      )
    case 'curl':
    case 'tricep':
      return (
        <>
          <Circle cx={120} cy={38} />
          <Line x1={120} y1={50} x2={120} y2={106} />
          <Line x1={120} y1={66} x2={92} y2={112} accent />
          <Line x1={120} y1={66} x2={148} y2={112} accent />
          <Line x1={92} y1={112} x2={82} y2={84} accent />
          <Line x1={148} y1={112} x2={158} y2={84} accent />
          <Line x1={120} y1={106} x2={98} y2={170} />
          <Line x1={120} y1={106} x2={144} y2={170} />
        </>
      )
    case 'core':
      return (
        <>
          <Circle cx={72} cy={134} />
          <Line x1={84} y1={136} x2={132} y2={124} accent />
          <Line x1={132} y1={124} x2={174} y2={150} />
          <Line x1={132} y1={124} x2={102} y2={168} />
          <Line x1={132} y1={124} x2={170} y2={170} />
        </>
      )
    default:
      return (
        <>
          <Circle cx={120} cy={38} />
          <Line x1={120} y1={50} x2={120} y2={108} />
          <Line x1={120} y1={68} x2={92} y2={92} />
          <Line x1={120} y1={68} x2={148} y2={92} />
          <Line x1={120} y1={108} x2={98} y2={170} />
          <Line x1={120} y1={108} x2={144} y2={170} />
        </>
      )
  }
}

function getSetupCue(kind) {
  const cues = {
    'leg-swing': 'Stand tall, hold support, swing one leg in a controlled arc.',
    'high-knees': 'Drive one knee to hip height and keep your chest tall.',
    ankle: 'Balance on one leg and rotate the lifted ankle through a full circle.',
    'hip-circle': 'Feet planted, hands on hips, draw a smooth circle with your pelvis.',
    'arm-swing': 'Open and close the arms across the chest with relaxed shoulders.',
    lunge: 'Long step, front shin vertical, back knee tracks toward the floor.',
    'hip-flexor': 'Half-kneel, squeeze the back-side glute, shift hips forward gently.',
    quad: 'Stand tall and pull heel toward glute without arching your back.',
    hamstring: 'Hinge at the hips with a flat back and long front leg.',
    calf: 'Back heel stays heavy as your body leans toward the wall.',
    'figure-four': 'Cross ankle over opposite knee and pull the uncrossed leg in.',
    'childs-pose': 'Sit hips toward heels and reach both arms long.',
    press: 'Brace, keep wrists stacked, press in a straight path.',
    push: 'Body stays in one line; elbows track under control.',
    pull: 'Drive elbows down and back; avoid shrugging.',
    row: 'Hinge with a flat back and pull toward the ribs.',
    deadlift: 'Hinge first, brace, keep the weight close.',
    squat: 'Hips back and down; knees track over toes.',
    curl: 'Elbows stay pinned while forearms move.',
    tricep: 'Upper arms stay fixed while elbows extend.',
    plank: 'Straight line from head to heels; ribs down.',
    core: 'Move from the abs, not the neck.',
    raise: 'Lift to shoulder height with soft elbows.',
    neck: 'Keep both shoulders relaxed while the neck moves gently.',
  }
  return cues[kind] || 'Use the picture to set your body position before starting.'
}

function normalizeSex(sex) {
  const normalized = String(sex || '').toLowerCase()
  if (normalized === 'female') return 'female'
  if (normalized === 'male') return 'male'
  return ''
}

function getPhotoConfig(photoDemo, sex) {
  if (!photoDemo) return { src: '', cropToSex: false, maleSide: 'right' }
  const normalizedSex = normalizeSex(sex)
  if (!normalizedSex && (photoDemo.male || photoDemo.female || photoDemo.cropToSex)) {
    return { src: '', cropToSex: false, maleSide: photoDemo.maleSide || 'right' }
  }
  if (photoDemo?.[normalizedSex]) return { src: photoDemo[normalizedSex], cropToSex: false, maleSide: photoDemo.maleSide || 'right' }
  if (photoDemo.src) return { src: photoDemo.src, cropToSex: Boolean(photoDemo.cropToSex), maleSide: photoDemo.maleSide || 'right' }
  return { src: photoDemo?.male || '', cropToSex: false, maleSide: photoDemo.maleSide || 'right' }
}

export default function MovementDemo({ name, label, compact = false, sex = 'male', imageUrl = '', cue = '' }) {
  const kind = getDemoKind(name)
  const title = label || name || 'Movement demo'
  const lower = String(title || '').toLowerCase()
  const vettedGuide = getVettedExerciseGuide(title)
  const photoDemo = vettedGuide
    ? { src: vettedGuide.src, cropToSex: true, maleSide: 'right' }
    : PHOTO_DEMOS.find((demo) => demo.match(lower))
  const normalizedSex = normalizeSex(sex)
  // Database URLs never override the exact movement catalog. A similar-looking
  // local asset can be mechanically wrong and unsafe for this exercise.
  const photoConfig = getPhotoConfig(photoDemo, sex)
  const photoSrc = photoConfig.src
  const displayCue = vettedGuide?.cue || cue || (photoSrc
    ? getSetupCue(kind)
    : 'Follow the written prescription with a controlled range of motion. Ask a qualified coach if the setup is unfamiliar.')
  const shouldCropToSex = Boolean(photoConfig.cropToSex)
  const cropSide = normalizedSex === 'male'
    ? photoConfig.maleSide
    : (photoConfig.maleSide === 'left' ? 'right' : 'left')
  return (
    <div
      style={{
        width: '100%',
        border: '1px solid rgba(234,179,8,0.24)',
        borderRadius: 18,
        background: `linear-gradient(180deg, ${PANEL}, rgba(17,17,17,0.92))`,
        padding: compact ? 12 : 16,
        overflow: 'hidden',
      }}
      aria-label={`${title} visual demonstration`}
    >
      {photoSrc ? (
        <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 10, aspectRatio: shouldCropToSex ? '2 / 3' : '4 / 3', background: '#050505' }}>
          <img
            src={photoSrc}
            alt={`${normalizedSex || 'athlete'} ${title} demonstration`}
            data-model-sex={normalizedSex || undefined}
            style={shouldCropToSex
              ? {
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: cropSide === 'left' ? 0 : 'auto',
                  right: cropSide === 'right' ? 0 : 'auto',
                  width: '200%',
                  maxWidth: 'none',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: `${cropSide} center`,
                  display: 'block',
                }
              : { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.10), rgba(0,0,0,0.34))', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', left: 12, top: 10, display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '5px 9px', background: 'rgba(0,0,0,0.58)', color: ACCENT, fontSize: 10, fontWeight: 900, letterSpacing: 1.2 }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: ACCENT }} />
            FORM IMAGE
          </div>
        </div>
      ) : (
        <div
          role="img"
          aria-label={`A vetted ${title} form image is not available yet`}
          style={{
            minHeight: compact ? 138 : 170,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.08)',
            marginBottom: 10,
            background: 'radial-gradient(circle at 22% 20%, rgba(234,179,8,0.18), transparent 34%), linear-gradient(135deg, rgba(15,23,42,0.9), rgba(3,7,18,0.98))',
            display: 'grid',
            alignContent: 'center',
            justifyItems: 'center',
            textAlign: 'center',
            padding: compact ? 18 : 24,
          }}
        >
          <div style={{ width: 44, height: 4, borderRadius: 999, background: ACCENT, marginBottom: 14 }} />
          <p style={{ margin: 0, color: ACCENT, fontSize: 11, fontWeight: 900, letterSpacing: 1.4, textTransform: 'uppercase' }}>
            Visual guide pending review
          </p>
          <p style={{ margin: '8px 0 0', color: 'var(--text-primary)', fontSize: compact ? 14 : 16, fontWeight: 900 }}>
            {title}
          </p>
          <p style={{ margin: '6px 0 0', color: MUTED, fontSize: compact ? 12 : 13, lineHeight: 1.45, maxWidth: 260 }}>
            Use the written form cue below. No substitute image is shown.
          </p>
        </div>
      )}
      <div style={{ display: 'grid', gap: 4 }}>
        <p style={{ margin: 0, color: 'var(--text-primary)', fontWeight: 900, fontSize: compact ? 14 : 16 }}>{title}</p>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: compact ? 12 : 13, lineHeight: 1.45 }}>{displayCue}</p>
      </div>
    </div>
  )
}
