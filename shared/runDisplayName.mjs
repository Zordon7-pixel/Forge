const CURATED_NAMES = Object.freeze({
  easy: Object.freeze(['Cruise Control', 'Miles and Smiles', 'Easy Does It']),
  recovery: Object.freeze(['Reset Run', 'Fresh Legs Loading', 'Shake It Out']),
  long: Object.freeze(['The Long Game', 'Endurance Earned', 'Miles of Confidence']),
  hills: Object.freeze(['Hills Pay the Bills']),
  intervals: Object.freeze(['Fast Lane Focus', 'Repeat After Me', 'Speed Deposit']),
  tempo: Object.freeze(['Comfortably Bold', 'Threshold of Awesome', 'Hold the Line']),
  race_pace: Object.freeze(['Dress Rehearsal', 'Goal Pace Groove', 'Race Rhythm']),
  progression: Object.freeze(['Finish With Fire', 'Build the Burn', 'Strong to the Finish']),
  race: Object.freeze(['Earned This Start Line', 'Race Day Ready']),
  run: Object.freeze(['Forward Is a Pace', 'Make Today Count', 'Run the Day']),
})

const GENERIC_TITLES = new Set([
  'run', 'easy run', 'easy aerobic run', 'recovery run', 'shakeout run',
  'long run', 'long aerobic run', 'hill run', 'hill repeats', 'controlled hill repeats',
  'short hill sprints', 'uphill threshold repeats', 'interval run', 'intervals',
  'short speed intervals', 'long aerobic intervals', 'track workout', 'speed workout',
  'tempo run', 'threshold run', 'threshold intervals', 'controlled fartlek',
  'race pace', 'race pace run', 'goal pace intervals', 'race pace sharpening',
  'progression run', 'steady run', 'steady aerobic run', 'taper strides',
  'easy run with strides', 'benchmark run', 'race day',
])

function normalizedText(value) {
  return String(value || '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

function isRun(session = {}) {
  const kind = normalizedText(session.kind)
  if (kind) return kind === 'run'
  const type = normalizedText(session.workout_type || session.type)
  return !/(rest|lift|strength|cross train)/.test(type)
}

export function runNameCategory(session = {}) {
  const text = [session.type, session.workout_type, session.workout_id, session.workout_family, session.title, session.description]
    .map(normalizedText).filter(Boolean).join(' ')
  if (/race pace|goal pace/.test(text)) return 'race_pace'
  if (/recovery|shakeout|shake out/.test(text)) return 'recovery'
  if (/\blong\b|endurance/.test(text)) return 'long'
  if (/hill|climb|uphill/.test(text)) return 'hills'
  if (/tempo|threshold/.test(text)) return 'tempo'
  if (/progression|progressive|\bsteady\b/.test(text)) return 'progression'
  if (/interval|speed|track|fartlek|stride|sharpen/.test(text)) return 'intervals'
  if (/\brace\b/.test(text)) return 'race'
  if (/easy|aerobic|conversational/.test(text)) return 'easy'
  return 'run'
}

function explicitDisplayName(session = {}, ignorePersisted = false) {
  const candidates = [...(ignorePersisted ? [] : [session.display_name, session.displayName]), session.name]
  for (const value of candidates) {
    const clean = String(value || '').trim()
    if (clean && !GENERIC_TITLES.has(normalizedText(clean))) return clean
  }
  return ''
}

function stableHash(value) {
  let hash = 2166136261
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function motivationalRunName(session = {}, context = {}) {
  if (!isRun(session)) return ''
  const explicit = explicitDisplayName(session, Boolean(context.refreshDerived))
  if (explicit) return explicit
  const category = runNameCategory(session)
  const choices = CURATED_NAMES[category] || CURATED_NAMES.run
  const seed = [category, context.date, context.sessionId || session.id, session.workout_id, session.type]
    .map((value) => String(value || '')).join('|')
  return choices[stableHash(seed) % choices.length]
}

export { CURATED_NAMES }
