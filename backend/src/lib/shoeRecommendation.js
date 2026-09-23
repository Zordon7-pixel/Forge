const RUN_CATEGORY_PRIORITIES = {
  easy: ['daily_trainer', 'stability'],
  recovery: ['daily_trainer', 'stability'],
  long: ['daily_trainer', 'stability', 'tempo'],
  tempo: ['tempo', 'daily_trainer', 'race'],
  threshold: ['tempo', 'race', 'daily_trainer'],
  intervals: ['tempo', 'race'],
  speed: ['tempo', 'race'],
  race: ['race', 'tempo'],
  trail: ['trail'],
};

const DEFAULT_CATEGORY_PRIORITY = ['daily_trainer', 'stability', 'tempo', 'race', 'trail'];

function isTruthyFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function isActiveShoe(shoe) {
  return !isTruthyFlag(shoe?.is_retired)
    && shoe?.is_active !== 0
    && shoe?.is_active !== false
    && shoe?.is_active !== '0';
}

function shoeMiles(shoe) {
  return Number(shoe?.total_miles ?? shoe?.current_miles ?? shoe?.miles ?? 0) || 0;
}

function recommendedMiles(shoe) {
  return Number(shoe?.recommended_miles || 0) || 0;
}

function wearRatio(shoe) {
  const recommended = recommendedMiles(shoe);
  return recommended > 0 ? shoeMiles(shoe) / recommended : 0;
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map((tag) => String(tag).toLowerCase());
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((tag) => String(tag).toLowerCase()) : [];
  } catch (err) {
    console.error('[shoe-recommendation/intent-tags]', err.message);
    return [];
  }
}

function shoeSurface(shoe) {
  const surface = String(shoe?.surface || '').toLowerCase();
  if (['road', 'trail', 'both'].includes(surface)) return surface;
  return null;
}

function matchesSurface(shoe, requestedSurface) {
  const surface = shoeSurface(shoe);
  return surface !== null && (surface === 'both' || surface === requestedSurface);
}

function getCategoryPriority(runType) {
  const normalized = String(runType || 'easy').toLowerCase();
  return RUN_CATEGORY_PRIORITIES[normalized] || RUN_CATEGORY_PRIORITIES.easy;
}

function scoreCandidate(shoe, { runType, surface, weather, categoryPriority }) {
  // Existing mutable profile fields have no field-level provenance ledger.
  // A catalog identity never verifies an athlete override or legacy default.
  const reasonCodes = ['UNVERIFIED_PROFILE'];
  const categoryIndex = categoryPriority.indexOf(shoe.category);
  let score = categoryIndex >= 0 ? 50 - categoryIndex * 8 : 12;

  if (categoryIndex === 0) reasonCodes.push('CATEGORY_MATCH');
  const tags = parseTags(shoe.intent_tags);
  if (tags.includes(runType)) {
    score += 28;
    reasonCodes.push('INTENT_MATCH');
  }

  const normalizedSurface = shoeSurface(shoe);
  if (normalizedSurface === surface) {
    score += 22;
    reasonCodes.push('SURFACE_MATCH');
  } else if (normalizedSurface === 'both' || surface === 'both') {
    score += 14;
    reasonCodes.push('SURFACE_VERSATILE');
  }

  if (weather?.isPrecip) {
    if (isTruthyFlag(shoe.wet_ok)) {
      reasonCodes.push('WET_PREFERENCE_RECORDED');
    } else if (shoe.wet_ok === 0 || shoe.wet_ok === false || shoe.wet_ok === '0') {
      reasonCodes.push('WET_LIMITED');
    } else {
      reasonCodes.push('WET_UNKNOWN');
    }
  }

  const ratio = wearRatio(shoe);
  if (ratio >= 0.8) reasonCodes.push('INSPECT_WEAR');

  return { shoe, score, confidence: 'LOW', metadata_basis: 'UNVERIFIED_PROFILE', reason_codes: reasonCodes };
}

function reasonText(result, runType, surface) {
  const codes = new Set(result.reason_codes);
  const pieces = [];
  if (codes.has('INTENT_MATCH') || codes.has('CATEGORY_MATCH')) {
    pieces.push(`recorded category or tags match your ${runType} session`);
  }
  if (codes.has('SURFACE_MATCH')) pieces.push(`recorded surface matches ${surface}`);
  if (codes.has('SURFACE_VERSATILE')) pieces.push('profile lists road and trail use');
  if (codes.has('WET_PREFERENCE_RECORDED')) pieces.push('profile marks wet use positively; traction is not independently verified');
  if (codes.has('WET_LIMITED')) pieces.push('profile advises avoiding wet use');
  if (codes.has('WET_UNKNOWN')) pieces.push('wet suitability is unknown');
  if (codes.has('ROTATE_LOAD')) pieces.push('helps spread wear across your rotation');
  if (codes.has('INSPECT_WEAR')) pieces.push('mileage suggests reviewing comfort and tread, not automatic retirement');
  pieces.push('profile metadata is unverified');
  return pieces.length
    ? `${pieces[0][0].toUpperCase()}${pieces[0].slice(1)}${pieces.length > 1 ? `; ${pieces.slice(1).join('; ')}` : ''}.`
    : `Best available match for this ${runType} session.`;
}

function recommendShoe(shoes, runType = 'easy', weather = {}, requestedSurface = 'road') {
  const normalizedRunType = String(runType || 'easy').toLowerCase();
  const surface = ['road', 'trail', 'both'].includes(String(requestedSurface).toLowerCase())
    ? String(requestedSurface).toLowerCase()
    : null;
  if (!surface) return {
    shoe: null, alternatives: [], confidence: 'LOW', training_unchanged: true, warning: null,
    reason_codes: ['UNKNOWN_REQUESTED_SURFACE'],
    reason: 'No recommendation: workout surface is unknown. Training is unchanged.',
  };
  const activeShoes = (Array.isArray(shoes) ? shoes : []).filter(isActiveShoe);
  if (!activeShoes.length) {
    return {
      shoe: null,
      alternatives: [],
      reason: 'No active shoes found in your closet.',
      reason_codes: ['NO_ACTIVE_SHOES'],
      warning: null,
      confidence: 'LOW',
      training_unchanged: true,
    };
  }

  const candidates = activeShoes.filter((shoe) => matchesSurface(shoe, surface));
  const warnings = [];
  if (!candidates.length) {
    const unknown = activeShoes.some(shoe => shoeSurface(shoe) === null);
    return {
      shoe: null,
      alternatives: [],
      reason: unknown
        ? `No recommendation: surface information is missing or does not match ${surface}. You can update your shoe profiles; training is unchanged.`
        : `No recommendation: no active shoe profile matches ${surface}. Training is unchanged.`,
      reason_codes: ['NO_COMPATIBLE_SHOE', ...(unknown ? ['UNKNOWN_SHOE_METADATA'] : [])],
      warning: null,
      confidence: 'LOW',
      training_unchanged: true,
    };
  }

  if (weather?.isPrecip) {
    warnings.push('Wet traction is not independently verified by these profile settings.');
  }

  const categoryPriority = [
    ...getCategoryPriority(normalizedRunType),
    ...DEFAULT_CATEGORY_PRIORITY.filter((category) => !getCategoryPriority(normalizedRunType).includes(category)),
  ];
  const ranked = candidates
    .map((shoe) => scoreCandidate(shoe, {
      runType: normalizedRunType,
      surface,
      weather,
      categoryPriority,
    }))
    .sort((a, b) => b.score - a.score
      || (weather?.isPrecip ? Number(isTruthyFlag(b.shoe.wet_ok)) - Number(isTruthyFlag(a.shoe.wet_ok)) : 0)
      || shoeMiles(a.shoe) - shoeMiles(b.shoe) || String(a.shoe.id).localeCompare(String(b.shoe.id)));

  const [top, ...rest] = ranked;
  if (rest.some(result => result.score === top.score
    && (!weather?.isPrecip || isTruthyFlag(result.shoe.wet_ok) === isTruthyFlag(top.shoe.wet_ok))
    && shoeMiles(result.shoe) > shoeMiles(top.shoe))) top.reason_codes.push('ROTATE_LOAD');
  if (top.reason_codes.includes('INSPECT_WEAR')) warnings.push('Mileage estimate is informational: review condition and comfort; mileage alone does not make a shoe unsafe.');
  return {
    shoe: top.shoe,
    alternatives: rest.slice(0, 2).map((result) => ({
      shoe: result.shoe,
      reason_codes: result.reason_codes,
      confidence: result.confidence,
      reason: reasonText(result, normalizedRunType, surface),
    })),
    reason: reasonText(top, normalizedRunType, surface),
    reason_codes: top.reason_codes,
    confidence: top.confidence,
    metadata_basis: top.metadata_basis,
    training_unchanged: true,
    warning: warnings.length ? warnings.join(' ') : null,
  };
}

function recommendApparel(weather = {}) {
  if (!weather.available) {
    return {
      items: ['Comfortable running top', 'Running shorts or tights', 'Weather-appropriate outer layer if needed'],
      summary: 'Use a flexible running kit and adjust at the door.',
      notes: [`Live weather unavailable${weather.reason ? `: ${weather.reason}` : ''}.`],
    };
  }

  const feelsLike = Number.isFinite(Number(weather.feelsLikeF)) ? Number(weather.feelsLikeF) : Number(weather.tempF);
  const adjustedTemp = feelsLike + 15;
  let items;
  let summary;

  if (adjustedTemp > 70) {
    items = ['Singlet', 'Shorts', 'Light hat'];
    summary = 'Warm run kit: singlet and shorts.';
  } else if (adjustedTemp >= 55) {
    items = ['T-shirt', 'Shorts'];
    summary = 'Mild run kit: t-shirt and shorts.';
  } else if (adjustedTemp >= 40) {
    items = ['Long-sleeve top or light layer', 'Shorts or capris'];
    summary = 'Cool run kit: light upper layer with shorts or capris.';
  } else if (adjustedTemp >= 25) {
    items = ['Thermal long-sleeve top', 'Tights', 'Light gloves', 'Headband'];
    summary = 'Cold run kit: thermal top, tights, light gloves, and headband.';
  } else {
    items = ['Layered top', 'Running jacket', 'Tights', 'Gloves', 'Hat', 'Buff'];
    summary = 'Very cold run kit: layered top, jacket, tights, gloves, hat, and buff.';
  }

  const notes = [];
  if (adjustedTemp > 70) notes.push('Use sunscreen.');
  if (weather.isPrecip) {
    items.push('Water-resistant layer', 'Brim hat');
    notes.push('Wet conditions: reduce chafe and blister risk.');
  }
  if (Number(weather.windMph || 0) >= 15) notes.push('Wind is high: add a windbreak layer.');

  return { items, summary, notes };
}

module.exports = { recommendShoe, recommendApparel, _test: { wearRatio, matchesSurface, parseTags } };
