// Deterministic strength-movement substitutions for the equipment a user owns.

const EQUIPMENT = Object.freeze({
  BODYWEIGHT: 'bodyweight',
  BARBELL: 'barbell',
  DUMBBELL: 'dumbbell',
  KETTLEBELL: 'kettlebell',
  RACK: 'rack',
  BENCH: 'bench',
  CABLE: 'cable',
  MACHINE: 'machine',
  RESISTANCE_BANDS: 'resistance_bands',
  PULL_UP_BAR: 'pull_up_bar',
});

const EQUIPMENT_SET = new Set(Object.values(EQUIPMENT));
const GEAR_ADJUSTMENT_NOTE = 'Adjusted for your gear.';

function variant(name, equipment, aliases = []) {
  return Object.freeze({ name, equipment: Object.freeze(equipment), aliases: Object.freeze(aliases) });
}

const MOVEMENT_SUBSTITUTIONS = Object.freeze({
  squat: Object.freeze([
    variant('Barbell back squat', [EQUIPMENT.BARBELL, EQUIPMENT.RACK], ['Back squat', 'Barbell squat']),
    variant('Goblet squat', [EQUIPMENT.DUMBBELL], ['Dumbbell goblet squat']),
    variant('Kettlebell goblet squat', [EQUIPMENT.KETTLEBELL]),
    variant('Resistance-band squat', [EQUIPMENT.RESISTANCE_BANDS], ['Banded squat']),
    variant('Tempo bodyweight squat', [EQUIPMENT.BODYWEIGHT], ['Bodyweight squat']),
  ]),
  hinge: Object.freeze([
    variant('Romanian deadlift', [EQUIPMENT.BARBELL], ['Barbell Romanian deadlift', 'Barbell RDL', 'RDL']),
    variant('Dumbbell Romanian deadlift', [EQUIPMENT.DUMBBELL], ['Dumbbell RDL']),
    variant('Kettlebell Romanian deadlift', [EQUIPMENT.KETTLEBELL], ['Kettlebell RDL']),
    variant('Banded good morning', [EQUIPMENT.RESISTANCE_BANDS], ['Resistance-band good morning']),
    variant('Single-leg hip bridge', [EQUIPMENT.BODYWEIGHT], ['Hip bridge', 'Glute bridge']),
  ]),
  horizontal_press: Object.freeze([
    variant('Barbell bench press', [EQUIPMENT.BARBELL, EQUIPMENT.BENCH], ['Bench press']),
    variant('Dumbbell bench press', [EQUIPMENT.DUMBBELL, EQUIPMENT.BENCH], ['Dumbbell chest press', 'Dumbbell flat bench press']),
    variant('Machine chest press', [EQUIPMENT.MACHINE], ['Chest press']),
    variant('Resistance-band chest press', [EQUIPMENT.RESISTANCE_BANDS], ['Band chest press']),
    variant('Push-up', [EQUIPMENT.BODYWEIGHT], ['Push up']),
  ]),
  horizontal_pull: Object.freeze([
    variant('One-arm dumbbell row', [EQUIPMENT.DUMBBELL], ['Single-arm dumbbell row', 'Dumbbell row']),
    variant('Seated cable row', [EQUIPMENT.CABLE], ['Cable row']),
    variant('Machine row', [EQUIPMENT.MACHINE], ['Seated row']),
    variant('Resistance-band row', [EQUIPMENT.RESISTANCE_BANDS], ['Band row']),
    variant('Inverted row', [EQUIPMENT.BODYWEIGHT], ['Bodyweight row']),
  ]),
  vertical_press: Object.freeze([
    variant('Standing overhead press', [EQUIPMENT.BARBELL], ['Barbell overhead press', 'Military press']),
    variant('Standing dumbbell overhead press', [EQUIPMENT.DUMBBELL], ['Dumbbell overhead press', 'Dumbbell shoulder press']),
    variant('Kettlebell overhead press', [EQUIPMENT.KETTLEBELL]),
    variant('Resistance-band overhead press', [EQUIPMENT.RESISTANCE_BANDS], ['Band overhead press']),
    variant('Pike push-up', [EQUIPMENT.BODYWEIGHT], ['Pike push up']),
  ]),
  vertical_pull: Object.freeze([
    variant('Lat pulldown', [EQUIPMENT.CABLE], ['Cable lat pulldown', 'Pull down', 'Pulldown']),
    variant('Machine lat pulldown', [EQUIPMENT.MACHINE]),
    variant('Resistance-band pulldown', [EQUIPMENT.RESISTANCE_BANDS], ['Band pulldown', 'Band pull down']),
    variant('Pull-up', [EQUIPMENT.PULL_UP_BAR], ['Pull up', 'Chin-up', 'Chin up']),
    variant('Prone lat pulldown', [EQUIPMENT.BODYWEIGHT], ['Prone pull-down']),
  ]),
  split_squat: Object.freeze([
    variant('Dumbbell rear-foot elevated split squat', [EQUIPMENT.DUMBBELL, EQUIPMENT.BENCH], ['Dumbbell Bulgarian split squat']),
    variant('Rear-foot elevated split squat', [EQUIPMENT.BENCH], ['Bulgarian split squat']),
    variant('Split squat', [EQUIPMENT.BODYWEIGHT], ['Bodyweight split squat']),
  ]),
  leg_press: Object.freeze([
    variant('Leg press', [EQUIPMENT.MACHINE], ['Machine leg press']),
    variant('Goblet squat', [EQUIPMENT.DUMBBELL], ['Dumbbell goblet squat']),
    variant('Tempo bodyweight squat', [EQUIPMENT.BODYWEIGHT], ['Bodyweight squat']),
  ]),
  calf_raise: Object.freeze([
    variant('Dumbbell standing calf raise', [EQUIPMENT.DUMBBELL], ['Weighted calf raise']),
    variant('Standing calf raise', [EQUIPMENT.BODYWEIGHT], ['Calf raise', 'Bodyweight calf raise']),
  ]),
});

const EQUIPMENT_ALIASES = Object.freeze({
  bands: EQUIPMENT.RESISTANCE_BANDS,
  band: EQUIPMENT.RESISTANCE_BANDS,
  resistance_band: EQUIPMENT.RESISTANCE_BANDS,
  dumbbells: EQUIPMENT.DUMBBELL,
  kettlebells: EQUIPMENT.KETTLEBELL,
  cables: EQUIPMENT.CABLE,
  machines: EQUIPMENT.MACHINE,
  pullup_bar: EQUIPMENT.PULL_UP_BAR,
});

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeMovementName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeOwnedEquipment(ownedEquipment) {
  const source = ownedEquipment instanceof Set
    ? [...ownedEquipment]
    : Array.isArray(ownedEquipment) ? ownedEquipment : [];
  const normalized = new Set([EQUIPMENT.BODYWEIGHT]);
  let fullGym = false;
  for (const item of source) {
    const token = normalizeToken(item);
    if (token === 'full_gym' || token === 'gym') {
      fullGym = true;
      continue;
    }
    const canonical = EQUIPMENT_ALIASES[token] || token;
    if (EQUIPMENT_SET.has(canonical)) normalized.add(canonical);
  }
  if (fullGym) EQUIPMENT_SET.forEach((item) => normalized.add(item));
  return normalized;
}

function movementName(movement) {
  if (typeof movement === 'string') return movement;
  return movement && typeof movement === 'object'
    ? movement.name || movement.exercise_name || movement.exerciseName || ''
    : '';
}

function findRule(name) {
  const normalized = normalizeMovementName(name);
  for (const [movementKey, chain] of Object.entries(MOVEMENT_SUBSTITUTIONS)) {
    for (const candidate of chain) {
      const names = [candidate.name, ...candidate.aliases].map(normalizeMovementName);
      if (names.includes(normalized)) return { movementKey, chain, original: candidate };
    }
  }
  return null;
}

function equipmentAvailable(requirements, owned) {
  return requirements.every((item) => owned.has(item));
}

function copyMovementWithName(movement, name, fromName, equipment) {
  if (typeof movement === 'string') return name;
  const nameKey = movement.exercise_name !== undefined
    ? 'exercise_name'
    : movement.exerciseName !== undefined ? 'exerciseName' : 'name';
  return {
    ...movement,
    [nameKey]: name,
    substitutedFrom: fromName,
    substitutionEquipment: [...equipment],
  };
}

function movementArrayKey(session = {}) {
  if (Array.isArray(session.main)) return 'main';
  if (Array.isArray(session.exercises)) return 'exercises';
  if (Array.isArray(session.movements)) return 'movements';
  return null;
}

function adjustStrengthForEquipment(strengthSession, ownedEquipment) {
  if (!strengthSession || typeof strengthSession !== 'object' || Array.isArray(strengthSession)) return strengthSession;
  const arrayKey = movementArrayKey(strengthSession);
  if (!arrayKey) return { ...strengthSession };

  const owned = normalizeOwnedEquipment(ownedEquipment);
  const substitutions = [];
  const movements = strengthSession[arrayKey].map((movement) => {
    const fromName = movementName(movement);
    const rule = findRule(fromName);
    if (!rule || equipmentAvailable(rule.original.equipment, owned)) {
      return movement && typeof movement === 'object' ? { ...movement } : movement;
    }

    const replacement = rule.chain.find((candidate) => equipmentAvailable(candidate.equipment, owned));
    if (!replacement) return movement && typeof movement === 'object' ? { ...movement } : movement;
    substitutions.push({
      movement: rule.movementKey,
      from: fromName,
      to: replacement.name,
      requiredEquipment: [...rule.original.equipment],
      usingEquipment: [...replacement.equipment],
    });
    return copyMovementWithName(movement, replacement.name, fromName, replacement.equipment);
  });

  const adjusted = { ...strengthSession, [arrayKey]: movements };
  if (!substitutions.length) return adjusted;
  return {
    ...adjusted,
    adjustedForGear: true,
    gearAdjustmentNote: GEAR_ADJUSTMENT_NOTE,
    substitutedMovements: substitutions,
  };
}

module.exports = {
  EQUIPMENT,
  EQUIPMENT_SET,
  MOVEMENT_SUBSTITUTIONS,
  GEAR_ADJUSTMENT_NOTE,
  adjustStrengthForEquipment,
};
