const invalidRoute = () => new Error('The route provider returned an invalid route. Please try again.')

function finiteNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function validPoint(latitude, longitude) {
  return latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
}

export function normalizePlannerRoute(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.coordinates) || value.coordinates.length < 2) throw invalidRoute()
  const distanceMiles = finiteNumber(value.distanceMiles)
  if (distanceMiles === null || distanceMiles <= 0) throw invalidRoute()
  const coordinates = value.coordinates.map(point => {
    if (!Array.isArray(point)) throw invalidRoute()
    const latitude = finiteNumber(point[0])
    const longitude = finiteNumber(point[1])
    if (!validPoint(latitude, longitude)) throw invalidRoute()
    return [latitude, longitude]
  })
  if (value.elevationProfile != null && !Array.isArray(value.elevationProfile)) throw invalidRoute()
  const elevationProfile = (value.elevationProfile || []).map(point => {
    const distanceMiles = finiteNumber(point?.distanceMiles)
    const elevationFeet = finiteNumber(point?.elevationFeet)
    if (distanceMiles === null || distanceMiles < 0 || elevationFeet === null) throw invalidRoute()
    return { distanceMiles, elevationFeet }
  })
  if (value.notice != null && typeof value.notice !== 'string') throw invalidRoute()
  if (!['flat', 'balanced', 'hilly'].includes(value.elevationPreference)) throw invalidRoute()
  return {
    ...value, coordinates, distanceMiles, elevationProfile,
    elevationGainFeet: finiteNumber(value.elevationGainFeet),
    distanceVariancePercent: finiteNumber(value.distanceVariancePercent),
  }
}

export function normalizePlannerPlaces(value) {
  if (!Array.isArray(value)) throw new Error('Starting places could not be read. Please search again.')
  return value.map(place => {
    const latitude = finiteNumber(place?.latitude)
    const longitude = finiteNumber(place?.longitude)
    if (!validPoint(latitude, longitude) || typeof place?.label !== 'string' || !place.label.trim()) {
      throw new Error('Starting places could not be read. Please search again.')
    }
    return { latitude, longitude, label: place.label }
  })
}

export function plannerErrorMessage(error, fallback) {
  const message = error?.response?.data?.error
  return typeof message === 'string' && message.trim() ? message : fallback
}
