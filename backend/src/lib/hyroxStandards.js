const HYROX_RUN_DISTANCE_MILES = 8 / 1.609344;

const STATION_ORDER = Object.freeze([
  'ski_erg',
  'sled_push',
  'sled_pull',
  'burpee_broad_jump',
  'row',
  'farmers_carry',
  'sandbag_lunge',
  'wall_ball',
]);

const STATIONS = [
  { id: 'ski_erg', name: 'SkiErg', runBeforeMeters: 1000, equipmentKey: 'ski_erg', distanceMeters: 1000 },
  { id: 'sled_push', name: 'Sled push', runBeforeMeters: 1000, equipmentKey: 'sled_push', distanceMeters: 50 },
  { id: 'sled_pull', name: 'Sled pull', runBeforeMeters: 1000, equipmentKey: 'sled_pull', distanceMeters: 50 },
  { id: 'burpee_broad_jump', name: 'Burpee broad jumps', runBeforeMeters: 1000, equipmentKey: null, distanceMeters: 80 },
  { id: 'row', name: 'Row', runBeforeMeters: 1000, equipmentKey: 'row_erg', distanceMeters: 1000 },
  { id: 'farmers_carry', name: 'Farmers carry', runBeforeMeters: 1000, equipmentKey: 'farmers_carry', distanceMeters: 200 },
  { id: 'sandbag_lunge', name: 'Sandbag lunges', runBeforeMeters: 1000, equipmentKey: 'sandbag', distanceMeters: 100 },
  { id: 'wall_ball', name: 'Wall balls', runBeforeMeters: 1000, equipmentKey: 'wall_ball_target', repetitions: 100 },
];

function loads(push, pull, carry, lunge, ball, target) {
  return {
    sled_push: { loadKgIncludingSled: push },
    sled_pull: { loadKgIncludingSled: pull },
    farmers_carry: { implements: 2, loadKgPerImplement: carry },
    sandbag_lunge: { loadKg: lunge },
    wall_ball: { ballKg: ball, targetHeightMeters: target },
  };
}

const OPEN_WOMEN = loads(102, 78, 16, 10, 4, 2.7);
const OPEN_MEN = loads(152, 103, 24, 20, 6, 3.0);
const PRO_WOMEN = loads(152, 103, 24, 20, 6, 2.7);
const PRO_MEN = loads(202, 153, 32, 30, 9, 3.0);
const MIXED_RELAY = Object.fromEntries(STATION_ORDER.map((stationId) => {
  const women = OPEN_WOMEN[stationId];
  const men = OPEN_MEN[stationId];
  if (!women && !men) return [stationId, {}];
  return [stationId, {
    loadsByAthleteCategory: {
      women: clone(women || {}),
      men: clone(men || {}),
    },
  }];
}));

const REGISTRY = {
  schemaVersion: 1,
  rulesVersion: '2026-2027',
  reviewedAt: '2026-08-10',
  sourceUrl: 'https://hyrox.com/rulebook/',
  rulebookUrls: {
    singles: 'https://hyrox.com/wp-content/uploads/2025/06/25_26-Singles-Rulebook_en_R1.pdf',
    doubles: 'https://hyrox.com/wp-content/uploads/2025/06/25-26-Doubles-Rulebook_en-R1.pdf',
    relay: 'https://hyrox.com/wp-content/uploads/2025/06/25-26-Relay-Rulebook_en-R1.pdf',
    judgesTraining: 'https://hyrox.com/judges-training/',
  },
  canonicalUnits: 'metric',
  stationOrder: STATION_ORDER,
  stations: STATIONS,
  divisions: {
    individual_open: { women: OPEN_WOMEN, men: OPEN_MEN },
    individual_pro: { women: PRO_WOMEN, men: PRO_MEN },
    doubles: { women: OPEN_WOMEN, men: OPEN_MEN, mixed: OPEN_MEN },
    // Mixed Doubles uses Open Men's loads for both athletes. Mixed Relay does
    // not: each working athlete uses the load for their own category.
    relay: { women: OPEN_WOMEN, men: OPEN_MEN, mixed: MIXED_RELAY },
  },
};

const EQUIPMENT_KEYS = Object.freeze([
  'ski_erg', 'row_erg', 'sled_push', 'sled_pull', 'wall_ball_target',
  'sandbag', 'farmers_carry', 'treadmill',
]);

const FORMAT_ALIASES = Object.freeze({
  open: 'individual_open',
  individual: 'individual_open',
  individual_open: 'individual_open',
  pro: 'individual_pro',
  individual_pro: 'individual_pro',
  doubles: 'doubles',
  relay: 'relay',
});

const CATEGORY_ALIASES = Object.freeze({
  female: 'women',
  woman: 'women',
  women: 'women',
  male: 'men',
  man: 'men',
  men: 'men',
  mixed: 'mixed',
});

function normalizeHyroxFormat(value) {
  return FORMAT_ALIASES[String(value || '').trim().toLowerCase()] || null;
}

function normalizeHyroxCategory(value) {
  return CATEGORY_ALIASES[String(value || '').trim().toLowerCase()] || null;
}

function normalizeEquipment(value) {
  const raw = Array.isArray(value) ? value : [];
  const available = new Set(raw.map((item) => String(item || '').trim().toLowerCase()));
  return EQUIPMENT_KEYS.filter((key) => available.has(key));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveHyroxStandard({ format, category, rulesVersion } = {}) {
  if (!format || !category) return { status: 'incomplete', stations: null };
  if (rulesVersion !== REGISTRY.rulesVersion) {
    return { status: 'unsupported_rules_version', stations: null };
  }
  const normalizedFormat = normalizeHyroxFormat(format);
  const normalizedCategory = normalizeHyroxCategory(category);
  if (!normalizedFormat || !normalizedCategory) return { status: 'incomplete', stations: null };
  const division = REGISTRY.divisions[normalizedFormat]?.[normalizedCategory];
  if (!division) return { status: 'unsupported_division_category', stations: null };
  return {
    status: 'exact',
    rulesVersion: REGISTRY.rulesVersion,
    format: normalizedFormat,
    category: normalizedCategory,
    sourceUrl: REGISTRY.sourceUrl,
    reviewedAt: REGISTRY.reviewedAt,
    canonicalUnits: REGISTRY.canonicalUnits,
    stations: REGISTRY.stations.map((station) => ({
      ...clone(station),
      ...clone(division[station.id] || {}),
    })),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

deepFreeze(REGISTRY);

module.exports = {
  EQUIPMENT_KEYS,
  HYROX_RUN_DISTANCE_MILES,
  REGISTRY,
  STATION_ORDER,
  normalizeEquipment,
  normalizeHyroxCategory,
  normalizeHyroxFormat,
  resolveHyroxStandard,
};
