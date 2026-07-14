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
  [0.8, 0.89],
  [0.89, 0.94],
  [0.94, 0.99],
  [0.99, Infinity],
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

function parseCustomMinimums(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      console.error('[hrZones] custom zones JSON parse failed:', err.message);
      return [];
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) return [];
  const minimums = parsed.map((entry) => Number(entry?.minBpm ?? entry?.min_bpm ?? entry));
  if (!minimums.every(validHr)) return [];
  if (!minimums.every((value, index) => index === 0 || value > minimums[index - 1])) return [];
  return minimums;
}

function buildCustomZones(customMinimums, maxHr) {
  const minimums = parseCustomMinimums(customMinimums);
  if (minimums.length !== 5) return [];
  const upperLimit = validHr(maxHr) && maxHr >= minimums[4] ? maxHr : 230;
  return minimums.map((minBpm, index) => ({
    zone: index + 1,
    minBpm,
    maxBpm: index < 4 ? minimums[index + 1] - 1 : upperLimit,
    openEnded: index === 4,
    label: ZONE_LABELS[index + 1],
  }));
}

function computeZones({ maxHr, restingHr, lthr, model, customMinimums } = {}) {
  const selectedModel = ['hrr', 'maxhr', 'lthr', 'custom'].includes(model) ? model : 'hrr';

  try {
    if (selectedModel === 'custom') {
      return { model: selectedModel, zones: buildCustomZones(customMinimums, maxHr) };
    }

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
  } catch (err) {
    console.error('[hrZones] computeZones threw:', err.message);
    return { model: selectedModel, zones: [] };
  }
}

function zoneForHr(bpm, profile) {
  if (bpm === null || bpm === undefined) return null;

  try {
    if (!profile) return null;

    const value = Number(bpm);
    if (!Number.isFinite(value)) return null;
    const model = profile.zone_model;
    if (!['hrr', 'maxhr', 'lthr', 'custom'].includes(model)) return null;
    if (model === 'hrr' && (!validHr(profile.max_hr) || !validHr(profile.resting_hr) || profile.max_hr <= profile.resting_hr)) return null;
    if (model === 'maxhr' && !validHr(profile.max_hr)) return null;
    if (model === 'lthr' && !validHr(profile.lthr)) return null;
    if (model === 'custom' && parseCustomMinimums(profile.custom_zones_json).length !== 5) return null;

    const result = computeZones({
      maxHr: profile.max_hr,
      restingHr: profile.resting_hr,
      lthr: profile.lthr,
      model,
      customMinimums: profile.custom_zones_json,
    });
    const zones = Array.isArray(result?.zones) ? result.zones : [];
    if (zones.length === 0) return null;

    if (value < zones[0].minBpm) return 'Z1';

    const matchedZone = zones.find((zone, index) => (
      value >= zone.minBpm && (index === zones.length - 1 || value < zones[index + 1].minBpm)
    ));

    return matchedZone ? `Z${matchedZone.zone}` : null;
  } catch (err) {
    console.error('[hrZones] zoneForHr threw:', err.message);
    return null;
  }
}

async function getHrProfile(userId, dbGet) {
  if (!userId || typeof dbGet !== 'function') return null;

  try {
    return await dbGet(
      `SELECT max_hr, resting_hr, lthr, custom_zones_json, zone_model, source, updated_at
       FROM user_hr_profile
       WHERE user_id = ?`,
      [userId]
    ) || null;
  } catch (err) {
    console.error('[hrZones] getHrProfile failed:', err.message);
    return null;
  }
}

module.exports = { buildCustomZones, computeZones, parseCustomMinimums, zoneForHr, getHrProfile };
