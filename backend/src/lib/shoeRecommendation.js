const RUN_CATEGORY_PRIORITIES = {
  easy: ['daily_trainer'],
  recovery: ['daily_trainer'],
  long: ['daily_trainer'],
  tempo: ['tempo', 'daily_trainer'],
  threshold: ['tempo', 'daily_trainer'],
  intervals: ['race', 'tempo'],
  speed: ['race', 'tempo'],
  race: ['race', 'tempo'],
  trail: ['trail', 'stability', 'daily_trainer'],
};

const DEFAULT_CATEGORY_PRIORITY = ['daily_trainer', 'stability', 'tempo', 'race', 'trail'];
const WET_CATEGORY_PRIORITY = ['trail', 'stability', 'daily_trainer'];

function isTruthyFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function isActiveShoe(shoe) {
  return !isTruthyFlag(shoe?.is_retired) && shoe?.is_active !== 0 && shoe?.is_active !== false && shoe?.is_active !== '0';
}

function shoeMiles(shoe) {
  return Number(shoe?.total_miles ?? shoe?.current_miles ?? shoe?.miles ?? 0) || 0;
}

function recommendedMiles(shoe) {
  return Number(shoe?.recommended_miles || 0) || 0;
}

function isOverRecommendedMiles(shoe) {
  const recommended = recommendedMiles(shoe);
  return recommended > 0 && shoeMiles(shoe) >= recommended;
}

function formatCategory(category) {
  return String(category || '').replace(/_/g, ' ');
}

function chooseLowestMileage(shoes) {
  return [...shoes].sort((a, b) => {
    const milesDiff = shoeMiles(a) - shoeMiles(b);
    if (milesDiff !== 0) return milesDiff;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  })[0] || null;
}

function getCategoryPriority(runType, weather) {
  const normalizedRunType = String(runType || 'easy').toLowerCase();
  if (weather?.isPrecip || normalizedRunType === 'trail') return WET_CATEGORY_PRIORITY;
  return RUN_CATEGORY_PRIORITIES[normalizedRunType] || RUN_CATEGORY_PRIORITIES.easy;
}

function recommendShoe(shoes, runType = 'easy', weather = {}) {
  const activeShoes = (Array.isArray(shoes) ? shoes : []).filter(isActiveShoe);
  if (!activeShoes.length) {
    return {
      shoe: null,
      reason: 'No active shoes found in your locker.',
      warning: null,
    };
  }

  const skipped = activeShoes.filter(isOverRecommendedMiles);
  const availableShoes = activeShoes.filter((shoe) => !isOverRecommendedMiles(shoe));
  const warning = skipped.length
    ? `${skipped.length} shoe${skipped.length === 1 ? ' is' : 's are'} at or over recommended mileage and ${skipped.length === 1 ? 'was' : 'were'} skipped.`
    : null;

  if (!availableShoes.length) {
    return {
      shoe: null,
      reason: 'All active shoes are at or over their recommended mileage.',
      warning,
    };
  }

  const categoryPriority = getCategoryPriority(runType, weather);
  const idealCategory = categoryPriority[0];
  const fullPriority = [...categoryPriority, ...DEFAULT_CATEGORY_PRIORITY.filter((category) => !categoryPriority.includes(category))];

  for (const category of fullPriority) {
    const matches = availableShoes.filter((shoe) => shoe.category === category);
    if (!matches.length) continue;

    const shoe = chooseLowestMileage(matches);
    const fallbackNote = category === idealCategory
      ? null
      : `No ${formatCategory(idealCategory)} shoe in your locker - using ${formatCategory(category)}.`;
    return {
      shoe,
      reason: fallbackNote || `Best match for ${String(runType || 'easy').toLowerCase()} run: ${formatCategory(category)}.`,
      warning,
    };
  }

  const shoe = chooseLowestMileage(availableShoes);
  return {
    shoe,
    reason: `No categorized match found - using your lowest-mileage available shoe.`,
    warning,
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
  if (Number(weather.windMph || 0) >= 15) {
    notes.push('Wind is high: add a windbreak layer.');
  }

  return { items, summary, notes };
}

module.exports = { recommendShoe, recommendApparel };
