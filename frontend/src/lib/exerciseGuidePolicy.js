const VETTED_EXERCISE_GUIDES = [
  {
    match: /^(?:barbell )?(?:romanian deadlift|rdl)$/,
    src: '/exercises/romanian-deadlift.webp',
    cue: 'Keep a soft knee bend, push the hips back, and keep the bar close without rounding your back.',
  },
  {
    match: /^(?:dumbbell )?single[- ]leg (?:romanian deadlift|rdl)$/,
    src: '/exercises/single-leg-romanian-deadlift.webp',
    cue: 'Keep your hips square, hinge over the planted leg, and reach the free leg long behind you.',
  },
  {
    match: /^(?:dumbbell )?(?:(?:rear[- ]foot[- ]elevated|bulgarian) split squat|rfess)$/,
    src: '/exercises/rear-foot-elevated-split-squat.webp',
    cue: 'Plant the front foot, lower the back knee under control, and keep the front knee tracking over the toes.',
  },
  {
    match: /^(?:hex|trap)[- ]bar deadlift$/,
    src: '/exercises/trap-bar-deadlift.webp',
    cue: 'Stand inside the frame, brace with straight arms, and drive the floor away until you stand tall.',
  },
]

function normalizeExerciseName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
}

export function getVettedExerciseGuide(name = '') {
  const normalized = normalizeExerciseName(name)
  return VETTED_EXERCISE_GUIDES.find((guide) => guide.match.test(normalized)) || null
}

export function isVettedExerciseAsset(name = '', imageUrl = '') {
  const guide = getVettedExerciseGuide(name)
  return Boolean(guide && guide.src === String(imageUrl || '').trim())
}

export const SCREENSHOT_PROVEN_GUIDE_CASES = Object.freeze([
  'Romanian Deadlift',
  'Single-Leg Romanian Deadlift',
  'Rear-Foot-Elevated Split Squat',
  'Trap Bar Deadlift',
])
