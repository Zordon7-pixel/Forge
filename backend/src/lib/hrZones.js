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
    if (!['hrr', 'maxhr', 'lthr'].includes(model)) return null;
    if (model === 'hrr' && (!validHr(profile.max_hr) || !validHr(profile.resting_hr) || profile.max_hr <= profile.resting_hr)) return null;
    if (model === 'maxhr' && !validHr(profile.max_hr)) return null;
    if (model === 'lthr' && !validHr(profile.lthr)) return null;

    const result = computeZones({
      maxHr: profile.max_hr,
      restingHr: profile.resting_hr,
      lthr: profile.lthr,
      model,
    });
    const zones = Array.isArray(result?.zones) ? result.zones : [];
    if (zones.length === 0) return null;

    if (value < zones[0].minBpm) return 'Z1';

    const matchedZone = zones.find((zone, index) => {
      const isTopZone = index === zones.length - 1;
      return value >= zone.minBpm && (isTopZone || value < zone.maxBpm);
    });

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
      `SELECT max_hr, resting_hr, lthr, zone_model, source, updated_at
       FROM user_hr_profile
       WHERE user_id = ?`,
      [userId]
    ) || null;
  } catch (err) {
    console.error('[hrZones] getHrProfile failed:', err.message);
    return null;
  }
}

module.exports = { computeZones, zoneForHr, getHrProfile };
