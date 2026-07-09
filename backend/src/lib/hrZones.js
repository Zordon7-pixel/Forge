const ZONE_LABELS = {
  1: 'Recovery',
  2: 'Easy',
  3: 'Aerobic',
  4: 'Threshold',
  5: 'Maximum',
};

const STANDARD_PCTS = [
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0],
];

const LTHR_PCTS = [
  [0, 0.8],
  [0.81, 0.89],
  [0.9, 0.94],
  [0.95, 0.99],
  [1.0, 1.05],
];

function validHr(value) {
  return Number.isInteger(value) && value >= 30 && value <= 230;
}

function buildZones(pairs, toBpm) {
  return pairs.map(([minPct, maxPct], index) => {
    const zone = index + 1;
    return {
      zone,
      minBpm: Math.round(toBpm(minPct)),
      maxBpm: Math.round(toBpm(maxPct)),
      label: ZONE_LABELS[zone],
    };
  });
}

function computeZones({ maxHr, restingHr, lthr, model } = {}) {
  const selectedModel = ['hrr', 'maxhr', 'lthr'].includes(model) ? model : 'hrr';

  try {
    if (selectedModel === 'maxhr') {
      if (!validHr(maxHr)) return { model: selectedModel, zones: [] };
      return {
        model: selectedModel,
        zones: buildZones(STANDARD_PCTS, pct => pct * maxHr),
      };
    }

    if (selectedModel === 'lthr') {
      if (!validHr(lthr)) return { model: selectedModel, zones: [] };
      return {
        model: selectedModel,
        zones: buildZones(LTHR_PCTS, pct => pct * lthr),
      };
    }

    if (!validHr(maxHr) || !validHr(restingHr) || maxHr <= restingHr) {
      return { model: selectedModel, zones: [] };
    }

    const reserve = maxHr - restingHr;
    return {
      model: selectedModel,
      zones: buildZones(STANDARD_PCTS, pct => restingHr + pct * reserve),
    };
  } catch {
    return { model: selectedModel, zones: [] };
  }
}

module.exports = { computeZones };
