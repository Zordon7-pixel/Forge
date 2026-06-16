function parseZoneNumber(zone) {
  if (zone === null || zone === undefined) return null;
  const match = String(zone).match(/\bZ(?:one)?\s*([1-5])\b/i) || String(zone).match(/\b([1-5])\b/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

function formatZone(zoneNumber) {
  return `Z${zoneNumber}`;
}

function assessHeatDrift({ actualZone, targetZone, weather } = {}) {
  const actual = parseZoneNumber(actualZone);
  const target = parseZoneNumber(targetZone);

  if (!actual || !target || actual < target + 1) {
    return { drifted: false };
  }

  const actualLabel = formatZone(actual);
  const targetLabel = formatZone(target);
  const safeWeather = weather && typeof weather === 'object' ? weather : {};

  if (!safeWeather.available) {
    return {
      drifted: true,
      severity: 'low',
      label: 'drift-unknown',
      reason: `You drifted to ${actualLabel} on a ${targetLabel} day; weather was not available to tell if heat explains it.`,
    };
  }

  const heatIndex = Number.isFinite(Number(safeWeather.feelsLikeF))
    ? Number(safeWeather.feelsLikeF)
    : Number(safeWeather.tempF);

  if (Number.isFinite(heatIndex) && heatIndex >= 80) {
    return {
      drifted: true,
      severity: 'low',
      label: 'heat-expected',
      reason: `You drifted to ${actualLabel} but it was ${Math.round(heatIndex)}F - cardiac drift in heat, your effort was right. Keep it easy and stay aerobic.`,
    };
  }

  return {
    drifted: true,
    severity: 'medium',
    label: 'overreach',
    reason: `You ran ${actualLabel} on a ${targetLabel} day in mild weather - ease off your next easy run to protect recovery.`,
  };
}

module.exports = { assessHeatDrift };
