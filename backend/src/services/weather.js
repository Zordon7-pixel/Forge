const WEATHER_URL = 'https://api.openweathermap.org/data/2.5/weather';
const CACHE_TTL_MS = 30 * 60 * 1000;
const WEATHER_TIMEOUT_MS = 2500;
const cache = new Map();

function unavailable(reason) {
  return {
    tempF: null,
    feelsLikeF: null,
    conditions: null,
    windMph: null,
    isPrecip: false,
    available: false,
    reason,
  };
}

function roundCoord(value) {
  return Number(value).toFixed(2);
}

function cacheKey(lat, lon, now = new Date()) {
  return `${roundCoord(lat)},${roundCoord(lon)}:${now.toISOString().slice(0, 13)}`;
}

function hasPrecip(data) {
  const condition = String(data?.weather?.[0]?.main || '').toLowerCase();
  return (
    ['rain', 'drizzle', 'snow', 'thunderstorm'].includes(condition) ||
    Boolean(data?.rain) ||
    Boolean(data?.snow)
  );
}

async function getWeather(lat, lon) {
  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) return unavailable('WEATHER_API_KEY is not configured');

  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return unavailable('Valid latitude and longitude are required');
  }

  const key = cacheKey(latNum, lonNum);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.weather;
  }

  try {
    const params = new URLSearchParams({
      lat: String(latNum),
      lon: String(lonNum),
      units: 'imperial',
      appid: apiKey,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${WEATHER_URL}?${params.toString()}`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      return unavailable(`Weather provider returned ${response.status}`);
    }

    const data = await response.json();
    const weather = {
      tempF: Number.isFinite(Number(data?.main?.temp)) ? Number(data.main.temp) : null,
      feelsLikeF: Number.isFinite(Number(data?.main?.feels_like)) ? Number(data.main.feels_like) : null,
      conditions: data?.weather?.[0]?.main || null,
      windMph: Number.isFinite(Number(data?.wind?.speed)) ? Number(data.wind.speed) : 0,
      isPrecip: hasPrecip(data),
      available: true,
      reason: null,
    };

    cache.set(key, { timestamp: Date.now(), weather });
    return weather;
  } catch (err) {
    return unavailable('Weather fetch failed');
  }
}

module.exports = { getWeather };
