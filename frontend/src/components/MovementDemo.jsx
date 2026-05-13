const ACCENT = '#EAB308'
const BODY = '#d1d5db'
const MUTED = '#6b7280'
const PANEL = 'rgba(234,179,8,0.08)'
const PHOTO_DEMOS = [
  {
    match: (lower) => lower.includes('dumbbell bench press') || (lower.includes('bench') && lower.includes('press')),
    male: '/exercises/dumbbell-bench-press-male.png',
    female: '/exercises/dumbbell-bench-press-female.png',
  },
  {
    match: (lower) => lower.includes('leg swing'),
    male: '/stretches/leg-swings-male.png',
    female: '/stretches/leg-swings-female.png',
  },
  {
    match: (lower) => lower.includes('hip flexor'),
    male: '/stretches/hip-flexor-male.png',
    female: '/stretches/hip-flexor-female.png',
  },
]

function getDemoKind(name = '') {
  const lower = String(name).toLowerCase()
  if (lower.includes('leg swing')) return 'leg-swing'
  if (lower.includes('high knee')) return 'high-knees'
  if (lower.includes('ankle') || lower.includes('calf raise')) return 'ankle'
  if (lower.includes('hip circle')) return 'hip-circle'
  if (lower.includes('arm swing')) return 'arm-swing'
  if (lower.includes('walking lunge') || lower === 'lunges' || lower.includes('lunge')) return 'lunge'
  if (lower.includes('quad')) return 'quad'
  if (lower.includes('hamstring') || lower.includes('romanian deadlift')) return 'hamstring'
  if (lower.includes('calf')) return 'calf'
  if (lower.includes('hip flexor')) return 'hip-flexor'
  if (lower.includes('figure four') || lower.includes('piriformis') || lower.includes('glute')) return 'figure-four'
  if (lower.includes('child')) return 'childs-pose'
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
  }
  return cues[kind] || 'Use the picture to set your body position before starting.'
}

function normalizeSex(sex) {
  return String(sex || '').toLowerCase() === 'female' ? 'female' : 'male'
}

export default function MovementDemo({ name, label, compact = false, sex = 'male' }) {
  const kind = getDemoKind(name)
  const title = label || name || 'Movement demo'
  const lower = String(title || '').toLowerCase()
  const photoDemo = PHOTO_DEMOS.find((demo) => demo.match(lower))
  const photoSrc = photoDemo?.[normalizeSex(sex)] || photoDemo?.male
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
        <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 10, aspectRatio: '4 / 3', background: '#050505' }}>
          <img src={photoSrc} alt={`${title} demonstration`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          <div style={{ position: 'absolute', left: 12, top: 10, display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '5px 9px', background: 'rgba(0,0,0,0.58)', color: ACCENT, fontSize: 10, fontWeight: 900, letterSpacing: 1.2 }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: ACCENT }} />
            FORM GUIDE
          </div>
        </div>
      ) : (
        <svg viewBox="0 0 240 210" width="100%" role="img" aria-label={title} style={{ display: 'block', maxHeight: compact ? 210 : 250 }}>
          <rect x="16" y="14" width="208" height="182" rx="22" fill="rgba(0,0,0,0.22)" stroke="rgba(255,255,255,0.08)" />
          <Line x1={38} y1={178} x2={202} y2={178} width={3} />
          <BodyPose kind={kind} />
          <Joint cx={38} cy={28} />
          <text x="50" y="32" fill={ACCENT} fontSize="11" fontWeight="800" letterSpacing="1.4">FORM GUIDE</text>
        </svg>
      )}
      <div style={{ display: 'grid', gap: 4 }}>
        <p style={{ margin: 0, color: 'var(--text-primary)', fontWeight: 900, fontSize: compact ? 14 : 16 }}>{title}</p>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: compact ? 12 : 13, lineHeight: 1.45 }}>{getSetupCue(kind)}</p>
      </div>
    </div>
  )
}
