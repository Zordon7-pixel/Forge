const DISTANCE_CONFIG = Object.freeze({
  '5k': { label: '5K', miles: 3.10686, toleranceMiles: 0.2 },
  '10k': { label: '10K', miles: 6.21371, toleranceMiles: 0.35 },
});

const OPEN_STANDARD_SECONDS = Object.freeze({
  male: { '5k': (12 * 60) + 35, '10k': (26 * 60) + 11 },
  female: { '5k': (14 * 60) + 6, '10k': (29 * 60) + 1 },
});

const AGE_FACTORS = Object.freeze({
  male: {
    '5k': [[35, 1.0], [40, 1.05], [45, 1.11], [50, 1.18], [55, 1.26], [60, 1.35], [65, 1.46], [70, 1.59], [75, 1.76], [80, 1.96], [85, 2.2], [90, 2.5]],
    '10k': [[35, 1.0], [40, 1.06], [45, 1.12], [50, 1.2], [55, 1.29], [60, 1.39], [65, 1.52], [70, 1.66], [75, 1.84], [80, 2.05], [85, 2.31], [90, 2.62]],
  },
  female: {
    '5k': [[35, 1.0], [40, 1.06], [45, 1.13], [50, 1.22], [55, 1.32], [60, 1.44], [65, 1.58], [70, 1.75], [75, 1.95], [80, 2.2], [85, 2.49], [90, 2.86]],
    '10k': [[35, 1.0], [40, 1.07], [45, 1.15], [50, 1.25], [55, 1.36], [60, 1.49], [65, 1.65], [70, 1.84], [75, 2.07], [80, 2.34], [85, 2.68], [90, 3.08]],
  },
});

const COMPETITIVE_TIERS = Object.freeze([
  { minScore: 90, key: 'elite_masters', label: 'Elite Masters' },
  { minScore: 80, key: 'national_class', label: 'National Class' },
  { minScore: 70, key: 'regional_contender', label: 'Regional Contender' },
  { minScore: 60, key: 'local_competitive', label: 'Local Competitive' },
  { minScore: 0, key: 'developing', label: 'Developing' },
]);

function normalizeSex(sex) {
  const raw = String(sex || '').toLowerCase();
  return raw.startsWith('f') ? 'female' : 'male';
}

function interpolateAgeFactor(points, age) {
  if (!Array.isArray(points) || points.length === 0) return 1;
  if (age <= points[0][0]) return points[0][1];
  if (age >= points[points.length - 1][0]) return points[points.length - 1][1];

  for (let i = 1; i < points.length; i += 1) {
    const [ageUpper, factorUpper] = points[i];
    const [ageLower, factorLower] = points[i - 1];
    if (age <= ageUpper) {
      const ratio = (age - ageLower) / (ageUpper - ageLower);
      return factorLower + ((factorUpper - factorLower) * ratio);
    }
  }

  return points[points.length - 1][1];
}

function getAgeFactor(distanceKey, sex, age) {
  const normalizedSex = normalizeSex(sex);
  const points = AGE_FACTORS[normalizedSex]?.[distanceKey];
  return interpolateAgeFactor(points, Number(age));
}

function getAgeBracket(age) {
  if (!Number.isFinite(Number(age))) return null;
  const parsedAge = Number(age);
  if (parsedAge < 40) return 'Open';
  const start = Math.floor(parsedAge / 5) * 5;
  if (start >= 85) return '85+';
  return `${start}-${start + 4}`;
}

function equivalentRaceSeconds(rawSeconds, rawMiles, distanceKey) {
  const config = DISTANCE_CONFIG[distanceKey];
  if (!config) return null;

  const seconds = Number(rawSeconds || 0);
  const miles = Number(rawMiles || 0);
  if (!(seconds > 0) || !(miles > 0)) return null;
  if (Math.abs(miles - config.miles) > config.toleranceMiles) return null;

  // Riegel exponent keeps slightly off-distance efforts comparable to exact 5K/10K.
  return seconds * Math.pow(config.miles / miles, 1.06);
}

function computeAgeGradedScore(distanceKey, sex, age, equivalentSeconds) {
  const seconds = Number(equivalentSeconds || 0);
  const parsedAge = Number(age);
  if (!(seconds > 0) || !Number.isFinite(parsedAge) || parsedAge < 10 || parsedAge > 110) return null;

  const normalizedSex = normalizeSex(sex);
  const openStandard = OPEN_STANDARD_SECONDS[normalizedSex]?.[distanceKey];
  if (!openStandard) return null;

  const ageStandard = openStandard * getAgeFactor(distanceKey, normalizedSex, parsedAge);
  return Number(((ageStandard / seconds) * 100).toFixed(1));
}

function getCompetitiveTier(score) {
  const parsed = Number(score);
  if (!Number.isFinite(parsed)) return null;
  return COMPETITIVE_TIERS.find((tier) => parsed >= tier.minScore) || COMPETITIVE_TIERS[COMPETITIVE_TIERS.length - 1];
}

module.exports = {
  DISTANCE_CONFIG,
  normalizeSex,
  getAgeBracket,
  equivalentRaceSeconds,
  computeAgeGradedScore,
  getCompetitiveTier,
};
