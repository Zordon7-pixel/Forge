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

function isOverRecommendedMiles(shoe) {
  return wearRatio(shoe) >= 1;
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

function formatCategory(category) {
  return String(category || '').replace(/_/g, ' ');
}

function shoeSurface(shoe) {
  const surface = String(shoe?.surface || '').toLowerCase();
  if (['road', 'trail', 'both'].includes(surface)) return surface;
  return shoe?.category === 'trail' ? 'trail' : 'road';
}

function matchesSurface(shoe, requestedSurface) {
  const surface = shoeSurface(shoe);
  return surface === 'both' || requestedSurface === 'both' || surface === requestedSurface;
}

function getCategoryPriority(runType) {
  const normalized = String(runType || 'easy').toLowerCase();
  return RUN_CATEGORY_PRIORITIES[normalized] || RUN_CATEGORY_PRIORITIES.easy;
}

function scoreCandidate(shoe, { runType, surface, weather, categoryPriority, hasRotation }) {
  const reasonCodes = [];
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
  } else {
    score -= 45;
    reasonCodes.push('WRONG_SURFACE');
  }

  if (weather?.isPrecip) {
    if (isTruthyFlag(shoe.wet_ok)) {
      score += 18;
      reasonCodes.push('WET_READY');
    } else if (shoe.wet_ok === 0 || shoe.wet_ok === false || shoe.wet_ok === '0') {
      score -= 30;
      reasonCodes.push('WET_LIMITED');
    } else {
      reasonCodes.push('WET_UNKNOWN');
    }
  }

  const ratio = wearRatio(shoe);
  score += Math.max(0, 20 - ratio * 20);
  if (ratio >= 0.8) reasonCodes.push('INSPECT_WEAR');
  if (hasRotation) reasonCodes.push('ROTATE_LOAD');

  return { shoe, score: Number(score.toFixed(2)), reason_codes: reasonCodes };
}

function reasonText(result, runType, surface) {
  const codes = new Set(result.reason_codes);
  const pieces = [];
  if (codes.has('INTENT_MATCH') || codes.has('CATEGORY_MATCH')) {
    pieces.push(`matches your ${runType} session`);
  }
  if (codes.has('SURFACE_MATCH')) pieces.push(`built for ${surface}`);
  if (codes.has('SURFACE_VERSATILE')) pieces.push(`works across ${surface} conditions`);
  if (codes.has('WET_READY')) pieces.push('has verified wet-condition traction');
  if (codes.has('ROTATE_LOAD')) pieces.push('helps spread wear across your rotation');
  if (codes.has('INSPECT_WEAR')) pieces.push('is nearing its mileage estimate, so inspect comfort and tread');
  return pieces.length
    ? `${pieces[0][0].toUpperCase()}${pieces[0].slice(1)}${pieces.length > 1 ? `; ${pieces.slice(1).join('; ')}` : ''}.`
    : `Best available match for this ${runType} session.`;
}

function recommendShoe(shoes, runType = 'easy', weather = {}, requestedSurface = 'road') {
  const normalizedRunType = String(runType || 'easy').toLowerCase();
  const surface = ['road', 'trail', 'both'].includes(String(requestedSurface).toLowerCase())
    ? String(requestedSurface).toLowerCase()
    : 'road';
  const activeShoes = (Array.isArray(shoes) ? shoes : []).filter(isActiveShoe);
  if (!activeShoes.length) {
    return {
      shoe: null,
      alternatives: [],
      reason: 'No active shoes found in your closet.',
      reason_codes: ['NO_ACTIVE_SHOES'],
      warning: null,
    };
  }

  const overMileage = activeShoes.filter(isOverRecommendedMiles);
  let candidates = activeShoes.filter((shoe) => !isOverRecommendedMiles(shoe));
  const warnings = [];
  if (overMileage.length) {
    warnings.push(`${overMileage.length} pair${overMileage.length === 1 ? ' is' : 's are'} at or over the mileage estimate and ${overMileage.length === 1 ? 'was' : 'were'} left out.`);
  }
  if (!candidates.length) {
    return {
      shoe: null,
      alternatives: [],
      reason: 'All active shoes are at or over their mileage estimate. Inspect cushioning, tread, and comfort before the next run.',
      reason_codes: ['ALL_OVER_MILEAGE'],
      warning: warnings.join(' '),
    };
  }

  const surfaceMatches = candidates.filter((shoe) => matchesSurface(shoe, surface));
  if (surfaceMatches.length) {
    candidates = surfaceMatches;
  } else {
    warnings.push(`No ${surface} shoe is available, so this is the closest fallback.`);
  }

  if (weather?.isPrecip) {
    const wetReady = candidates.filter((shoe) => isTruthyFlag(shoe.wet_ok));
    if (wetReady.length) candidates = wetReady;
    else warnings.push('Wet traction is not verified for the available pairs. Use your judgment before heading out.');
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
      hasRotation: candidates.length > 1,
    }))
    .sort((a, b) => b.score - a.score || wearRatio(a.shoe) - wearRatio(b.shoe) || String(a.shoe.id).localeCompare(String(b.shoe.id)));

  const [top, ...rest] = ranked;
  return {
    shoe: top.shoe,
    alternatives: rest.slice(0, 2).map((result) => ({
      shoe: result.shoe,
      reason_codes: result.reason_codes,
      reason: reasonText(result, normalizedRunType, surface),
    })),
    reason: reasonText(top, normalizedRunType, surface),
    reason_codes: top.reason_codes,
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
