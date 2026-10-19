import { fromRun } from './shareStats.js'

// Export boundary: retain display fields only, never copy symbols, descriptors,
// raw activity records, HR zones, identity fields or source metadata.
function displayText(value) {
  return typeof value === 'string' && value.trim() && !/^(--|0:00|NaN|undefined|null|NOT SHARED)$/i.test(value.trim()) ? value.trim() : null
}
function statsFor(stats) {
  return Array.isArray(stats) ? stats.flatMap(item => {
    const key = displayText(item?.key), label = displayText(item?.label), value = displayText(item?.value), unit = displayText(item?.unit)
    return key && label && value ? [{ key, label, value, ...(unit ? { unit } : {}) }] : []
  }) : []
}
export function rendererModel(model, showRoute) {
  if (typeof showRoute !== 'boolean') throw new TypeError('showRoute must be a boolean')
  const stats = statsFor(model?.stats)
  const handle = model?.handle
  const clean = {
    kind: model?.kind, title: displayText(model?.title), dateLabel: displayText(model?.dateLabel),
    handle: typeof handle === 'string' && /^@[a-z0-9_.-]+$/i.test(handle) && !/forgedhybrid/i.test(handle) ? handle : null,
    unit: model?.unit === 'km' ? 'km' : 'mi', stats,
    hero: stats.find(item => item.key === model?.hero?.key) || null,
    pr: model?.pr ? { label: displayText(model.pr.label), value: typeof model.pr.value === 'number' && Number.isFinite(model.pr.value) ? model.pr.value : displayText(model.pr.value), unit: displayText(model.pr.unit), delta: typeof model.pr.delta === 'number' && Number.isFinite(model.pr.delta) ? model.pr.delta : displayText(model.pr.delta) } : null,
  }
  if (model?.run) {
    clean.run = { stats: statsFor(model.run.stats), route: null, elevationProfile: null }
    if (showRoute) {
      const route = model.run.route
      clean.run.route = Array.isArray(route) ? route.filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
        .map(point => [point[0], point[1]]) : null
      clean.run.elevationProfile = Array.isArray(model.run.elevationProfile) ? Array.from(model.run.elevationProfile).filter(Number.isFinite) : null
    }
  }
  if (model?.lift) clean.lift = { stats: statsFor(model.lift.stats), topLifts: (model.lift.topLifts || []).slice(0, 3)
    .map(item => ({ name: displayText(item.name), scheme: displayText(item.scheme), weight: displayText(item.weight) })) }
  return clean
}

export function sharePreferences(preferences = {}, alternateTimezone) {
  preferences = preferences || {}
  const validTimezone = value => {
    if (typeof value !== 'string' || !value.trim()) return null
    try { return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone }
    catch { return null } // Invalid preference is expected input; try the device next.
  }
  let timezone = validTimezone(preferences.timezone) || validTimezone(alternateTimezone)
  if (!timezone) {
    try { timezone = validTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone) }
    catch (error) { console.warn('[ActivityShareStudio] device timezone unavailable:', error?.message || error) }
  }
  return {
    timezone: timezone || 'UTC', friend_handle: preferences.friend_handle ?? null,
    // Existing /users/settings uses both "miles" and mi, with units as its UI preference.
    distance_unit: ['mi', 'km'].includes(preferences.distance_unit) ? preferences.distance_unit
      : preferences.distance_unit === 'kilometers' || preferences.units === 'metric' ? 'km' : 'mi',
  }
}

export function studioModel({ run, model, prefs, showRoute, title }) {
  if (typeof showRoute !== 'boolean') throw new TypeError('showRoute must be a boolean')
  // Released A takes an options object; its showRoute FIELD is strictly boolean.
  // A bare false argument is not its contract and would keep geometry enabled.
  const source = model || fromRun(run, sharePreferences(prefs), { showRoute })
  const safe = rendererModel(source, showRoute)
  const customTitle = displayText(title)
  if (customTitle) safe.title = customTitle.slice(0, 48)
  return safe
}
