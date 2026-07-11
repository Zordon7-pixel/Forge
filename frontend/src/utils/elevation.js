const FEET_PER_METER = 3.28084

function smoothElevations(values) {
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return null
    const window = values
      .slice(Math.max(0, index - 2), Math.min(values.length, index + 3))
      .filter(Number.isFinite)
    return window.reduce((sum, item) => sum + item, 0) / window.length
  })
}

export function calculateElevationStats(routeCoords = []) {
  const rawElevations = routeCoords.map((point) => {
    const rawValue = Array.isArray(point) ? point[2] : point?.alt ?? point?.ele
    if (rawValue === undefined || rawValue === null || rawValue === '') return null
    const value = Number(rawValue)
    return Number.isFinite(value) ? value : null
  })
  const elevations = smoothElevations(rawElevations)
  const validElevations = elevations.filter(Number.isFinite)
  if (validElevations.length < 2) {
    return { available: false, gainFeet: 0, lossFeet: 0, minFeet: null, maxFeet: null }
  }

  let gainMeters = 0
  let lossMeters = 0
  let anchor = validElevations[0]
  for (let index = 1; index < validElevations.length; index += 1) {
    const value = validElevations[index]
    const delta = value - anchor
    if (Math.abs(delta) < 1.5) continue
    if (Math.abs(delta) > 50) {
      anchor = value
      continue
    }
    if (delta > 0) gainMeters += delta
    if (delta < 0) lossMeters += Math.abs(delta)
    anchor = value
  }

  return {
    available: true,
    gainFeet: Math.round(gainMeters * FEET_PER_METER),
    lossFeet: Math.round(lossMeters * FEET_PER_METER),
    minFeet: Math.round(Math.min(...validElevations) * FEET_PER_METER),
    maxFeet: Math.round(Math.max(...validElevations) * FEET_PER_METER),
  }
}
