import { liftRecoveryMovements, liftWarmupMovements } from '../data/liftMobility.js'
import { postRunStretches, preRunStretches } from '../data/stretches.js'

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

// These exact name/asset pairs are emitted by the server stretch catalog but
// are not duplicated in the smaller client-side warm-up/recovery catalogs.
// Keeping the pair together is intentional: a trusted local path alone is not
// enough to prove that an image matches a movement.
const SERVER_CATALOG_ONLY_GUIDES = Object.freeze([
  ['Hip Flexor Lunge', '/stretches/hip-flexor-male.png'],
  ['Figure-4 Stretch', '/stretches/figure-four.png'],
  ['Standing Hip Circle', '/stretches/hip-circles.png'],
  ['Seated Hip Rotation', '/stretches/seated-hip-rotation.webp'],
  ['Quad Stretch', '/stretches/standing-quad.png'],
  ['Seated Hamstring Stretch', '/stretches/hamstring-stretch.png'],
  ['Calf Wall Stretch', '/stretches/calf-stretch.png'],
  ['Standing Forward Fold', '/stretches/hamstring-stretch.png'],
  ['Seated Toe Touch', '/stretches/hamstring-stretch.png'],
  ['Standing Side Bend', '/stretches/standing-side-bend.webp'],
  ['Chest Opener', '/stretches/chest-opener.webp'],
  ['Neck Tilt', '/stretches/neck-tilt.webp'],
  ['Bridge Hold', '/stretches/bridge-hold.webp'],
])

function normalizeExerciseName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
}

const CLIENT_CATALOG_GUIDES = [
  ...preRunStretches,
  ...postRunStretches,
  ...liftWarmupMovements,
  ...liftRecoveryMovements,
].map((movement) => [movement.name, movement.image_url])

const TRUSTED_CATALOG_ASSETS = (() => {
  const byName = new Map()
  for (const [name, src] of [...CLIENT_CATALOG_GUIDES, ...SERVER_CATALOG_ONLY_GUIDES]) {
    const normalizedName = normalizeExerciseName(name)
    const normalizedSrc = String(src || '').trim()
    if (!normalizedName || !normalizedSrc.startsWith('/stretches/')) continue
    const assets = byName.get(normalizedName) || new Set()
    assets.add(normalizedSrc)
    byName.set(normalizedName, assets)
  }
  return byName
})()

export function getVettedExerciseGuide(name = '') {
  const normalized = normalizeExerciseName(name)
  return VETTED_EXERCISE_GUIDES.find((guide) => guide.match.test(normalized)) || null
}

export function isVettedExerciseAsset(name = '', imageUrl = '') {
  const guide = getVettedExerciseGuide(name)
  return Boolean(guide && guide.src === String(imageUrl || '').trim())
}

export function getTrustedCatalogExerciseAsset(name = '', imageUrl = '') {
  const normalizedName = normalizeExerciseName(name)
  const src = String(imageUrl || '').trim()
  return TRUSTED_CATALOG_ASSETS.get(normalizedName)?.has(src) ? src : ''
}

export function normalizeProfileSex(sex = '') {
  const normalized = String(sex || '').toLowerCase()
  if (normalized === 'female') return 'female'
  if (normalized === 'male') return 'male'
  return ''
}

function photoConfig(photoDemo, sex) {
  if (!photoDemo) return { src: '', cropToSex: false, maleSide: 'right' }
  const normalizedSex = normalizeProfileSex(sex)
  // A trusted paired-composite asset is truthful in full when profile sex is
  // unknown. Do not guess a crop; separate male/female files still fail closed.
  if (!normalizedSex && photoDemo.src) {
    return { src: photoDemo.src, cropToSex: false, maleSide: photoDemo.maleSide || 'right' }
  }
  if (!normalizedSex && (photoDemo.male || photoDemo.female || photoDemo.cropToSex)) {
    return { src: '', cropToSex: false, maleSide: photoDemo.maleSide || 'right' }
  }
  if (photoDemo?.[normalizedSex]) {
    return { src: photoDemo[normalizedSex], cropToSex: false, maleSide: photoDemo.maleSide || 'right' }
  }
  if (photoDemo.src) {
    return { src: photoDemo.src, cropToSex: Boolean(photoDemo.cropToSex), maleSide: photoDemo.maleSide || 'right' }
  }
  return { src: photoDemo?.male || '', cropToSex: false, maleSide: photoDemo.maleSide || 'right' }
}

export function resolveExerciseGuidePhoto({ name = '', imageUrl = '', sex = '', localPhotoDemo = null } = {}) {
  const vettedGuide = getVettedExerciseGuide(name)
  const normalizedSex = normalizeProfileSex(sex)
  const catalogSrc = getTrustedCatalogExerciseAsset(name, imageUrl)

  if (vettedGuide) {
    return {
      ...photoConfig({
        src: vettedGuide.src,
        cropToSex: true,
        maleSide: 'right',
      }, normalizedSex),
      cue: vettedGuide.cue,
      source: 'screenshot_proven',
    }
  }

  // Before profile sex resolves, a trusted exact catalog image is safer than
  // either a blank guide or guessing which half of a paired composite to crop.
  if (!normalizedSex && catalogSrc) {
    return {
      src: catalogSrc,
      cropToSex: false,
      maleSide: 'right',
      cue: '',
      source: 'catalog_exact',
    }
  }

  const selected = localPhotoDemo || (catalogSrc ? { src: catalogSrc } : null)
  return {
    ...photoConfig(selected, normalizedSex),
    cue: '',
    source: localPhotoDemo ? 'local_exact' : (catalogSrc ? 'catalog_exact' : 'fallback'),
  }
}

export const SCREENSHOT_PROVEN_GUIDE_CASES = Object.freeze([
  'Romanian Deadlift',
  'Single-Leg Romanian Deadlift',
  'Rear-Foot-Elevated Split Squat',
  'Trap Bar Deadlift',
])
