// Deterministic travel/no-gym strength translation.
//
// This module is deliberately pure: it accepts an owner-validated stored lift
// session and returns a bodyweight-only alternative without mutating the plan,
// consulting a database, or calling an AI service.

const { adjustStrengthForEquipment, EQUIPMENT } = require('./strengthAdjunct');

const BODYWEIGHT_ONLY = Object.freeze([EQUIPMENT.BODYWEIGHT]);

const MOVEMENTS = Object.freeze({
  squat: Object.freeze({
    name: 'Tempo bodyweight squat',
    reps: '10-12',
    rest: '60 sec',
    cue: 'Lower for three seconds, keep the full foot planted, and stand with control.',
  }),
  lunge: Object.freeze({
    name: 'Reverse lunge',
    reps: '8 each side',
    rest: '60 sec',
    cue: 'Step back softly and keep the front knee tracking over the toes.',
  }),
  bridge: Object.freeze({
    name: 'Single-leg hip bridge',
    reps: '8 each side',
    rest: '60 sec',
    cue: 'Keep the pelvis level and finish each repetition through the glute.',
  }),
  calf: Object.freeze({
    name: 'Standing calf raise',
    reps: '12-15',
    rest: '45 sec',
    cue: 'Pause at the top and lower slowly through the full available range.',
  }),
  push: Object.freeze({
    name: 'Push-up',
    reps: '6-12',
    rest: '60 sec',
    cue: 'Keep a straight line from shoulders through heels; use knees if needed.',
  }),
  pike: Object.freeze({
    name: 'Pike push-up',
    reps: '6-10',
    rest: '60 sec',
    cue: 'Keep the ribs stacked and lower with control; shorten the range if needed.',
  }),
  pull: Object.freeze({
    name: 'Prone pull-down',
    reps: '10-12',
    rest: '45 sec',
    cue: 'Lie face down, draw elbows toward the ribs, and avoid shrugging.',
  }),
  side_plank: Object.freeze({
    name: 'Side plank',
    reps: '20-30 sec each side',
    rest: '45 sec',
    cue: 'Stack the ribs over the pelvis and stop before the hips sag.',
  }),
  dead_bug: Object.freeze({
    name: 'Dead bug',
    reps: '6-8 each side',
    rest: '45 sec',
    cue: 'Keep the low back gently supported and move only as far as control allows.',
  }),
});

const FOCUS_ORDER = Object.freeze({
  lower: Object.freeze(['squat', 'lunge', 'bridge', 'calf']),
  upper: Object.freeze(['push', 'pull', 'pike', 'side_plank']),
  full: Object.freeze(['squat', 'push', 'bridge', 'dead_bug']),
});

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function movementName(movement) {
  if (typeof movement === 'string') return movement;
  if (!movement || typeof movement !== 'object') return '';
  return movement.name || movement.exercise_name || movement.exerciseName || '';
}

function sourceMovements(session) {
  if (Array.isArray(session?.main)) return session.main;
  if (Array.isArray(session?.exercises)) return session.exercises;
  if (Array.isArray(session?.movements)) return session.movements;
  return [];
}

function focusKey(focus) {
  const normalized = normalizeName(focus);
  if (normalized.includes('lower') || normalized.includes('leg')) return 'lower';
  if (normalized.includes('upper')) return 'upper';
  return 'full';
}

function movementKeyForName(value) {
  const name = normalizeName(value);
  if (/calf|heel raise/.test(name)) return 'calf';
  if (/lunge|split squat|bulgarian/.test(name)) return 'lunge';
  if (/deadlift|hinge|good morning|hip bridge|glute bridge/.test(name)) return 'bridge';
  if (/squat|leg press/.test(name)) return 'squat';
  if (/overhead|shoulder press|pike/.test(name)) return 'pike';
  if (/row|pull|pulldown|pull down|chin/.test(name)) return 'pull';
  if (/bench|chest press|push up|pushup/.test(name)) return 'push';
  if (/side plank/.test(name)) return 'side_plank';
  if (/plank|dead bug|core|carry/.test(name)) return 'dead_bug';
  return null;
}

function boundedSets(value, phase) {
  if (['taper', 'race'].includes(normalizeName(phase))) return 2;
  const sets = Number(value);
  return Number.isInteger(sets) ? Math.max(2, Math.min(3, sets)) : 2;
}

function prescribedMovement(key, source, phase) {
  const template = MOVEMENTS[key] || MOVEMENTS.dead_bug;
  const from = movementName(source);
  return {
    name: template.name,
    sets: boundedSets(source?.sets, phase),
    reps: template.reps,
    rest: template.rest,
    load: 'Bodyweight only',
    rpe: '6-7 (3-4 reps in reserve)',
    cue: template.cue,
    progression: 'Add one controlled repetition per set next time; stop before form or speed changes.',
    equipment: [...BODYWEIGHT_ONLY],
    ...(from && normalizeName(from) !== normalizeName(template.name) ? { substitutedFrom: from } : {}),
  };
}

function buildBodyweightAlternative(options = {}) {
  const source = options.session;
  const sessionId = String(options.sessionId || source?.id || '').trim();
  if (!source || typeof source !== 'object' || !sessionId) return null;

  // Reuse the shipped deterministic substitution chain first, then replace
  // unknown or impractical floor/fixture movements with conservative options.
  const adjusted = adjustStrengthForEquipment(source, BODYWEIGHT_ONLY);
  const adjustedMovements = sourceMovements(adjusted);
  const focus = source.focus || source.target || 'Full body';
  const focusOrder = FOCUS_ORDER[focusKey(focus)];
  const targetCount = ['taper', 'race'].includes(normalizeName(options.phase)) ? 3 : 4;
  const selected = [];
  const used = new Set();

  for (const movement of adjustedMovements) {
    const key = movementKeyForName(movementName(movement));
    if (!key || used.has(key)) continue;
    selected.push(prescribedMovement(key, movement, options.phase));
    used.add(key);
    if (selected.length >= targetCount) break;
  }

  for (const key of focusOrder) {
    if (selected.length >= targetCount) break;
    if (used.has(key)) continue;
    selected.push(prescribedMovement(key, null, options.phase));
    used.add(key);
  }

  return {
    id: sessionId,
    sessionId,
    kind: 'lift',
    type: 'strength',
    workout_type: 'strength',
    date: options.date || source.date || null,
    week: options.week ?? null,
    phase: options.phase || null,
    title: 'Runner strength — no equipment',
    focus,
    originalTitle: source.title || null,
    adjustedForTravel: true,
    equipment: [...BODYWEIGHT_ONLY],
    duration_min: 22,
    warmup: [
      '2 min easy marching in place',
      'Bodyweight squat x 8',
      'Alternating reverse lunge x 4 each side',
      'Scapular push-up x 8',
    ],
    main: selected,
    recovery: [
      'Keep every set submaximal and leave three to four good repetitions available.',
      'Stop if pain changes movement; mobility or rest remains a valid choice.',
    ],
    progression: 'Repeat with smooth control. Add repetitions before adding a harder variation.',
    description: 'A 20-25 minute bodyweight translation of today\'s scheduled lift for training away from the gym.',
  };
}

module.exports = {
  BODYWEIGHT_ONLY,
  buildBodyweightAlternative,
};
