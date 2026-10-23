import { fromRun, fromStrength, fromHybrid, fromPr, prDisplay, fromStreak } from './shareStats.js'

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
    pr: prDisplay(model?.pr),
  }
  if (model?.run) {
    clean.run = { stats: statsFor(model.run.stats), route: null, elevationProfile: null }
    if (showRoute) {
      const route = model.run.route
      clean.run.route = Array.isArray(route) ? route.filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180)
        .map(point => [point[0], point[1]]) : null
      clean.run.elevationProfile = Array.isArray(model.run.elevationProfile) ? Array.from(model.run.elevationProfile).filter(Number.isFinite) : null
    }
  }
  if (model?.lift) clean.lift = { stats: statsFor(model.lift.stats), topLifts: (model.lift.topLifts || []).slice(0, 3)
    .map(item => ({ name: displayText(item.name), scheme: displayText(item.scheme), weight: displayText(item.weight) })) }
  if (model?.streak) {
    clean.streak = fromStreak({ days: model.streak.days, week: model.streak.week, monthDays: model.streak.monthDays, milestone: model.streak.milestone })
    if (clean.streak) {
      if (![7, 30, 50, 100, 365].includes(clean.streak.milestone) || clean.streak.milestone !== clean.streak.days) clean.streak.milestone = null
      const lifetime = statsFor(model.streak.lifetime).filter(item => {
        const value = Number(item.value)
        if (!Number.isFinite(value) || value <= 0) return false
        if (['runs', 'lifts'].includes(item.key)) return Number.isInteger(value) && !item.unit
        return item.key === 'distance' ? ['mi', 'km'].includes(item.unit) : item.key === 'volume' && ['lbs', 'kg'].includes(item.unit)
      })
      if (lifetime.length) clean.streak.lifetime = lifetime
    }
  }
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

// Context is served only after authenticating and resolving the exact owned run.
// Recheck run/day linkage so stale responses cannot decorate another activity.
// Owner scoping is server-side; tolerate legacy owner fields only when consistent.
export function activityShareModels(run, context, prefs, showRoute) {
  if (typeof showRoute !== 'boolean') throw new TypeError('showRoute must be a boolean')
  const preferences = sharePreferences(prefs)
  let runShare = fromRun(run, preferences, { showRoute })
  const valid = run?.id && context?.run_id === run.id
    && (!context.user_id || context.user_id === run.user_id) && context.local_date === runShare.dateLabel
  if (!valid) return { run: runShare, hybrid: null }
  const owned = rows => (Array.isArray(rows) ? rows : []).filter(row => row && (!row.user_id || row.user_id === run.user_id))
  for (const row of owned(context.prs)) {
    const candidate = fromPr(row, runShare)
    if (candidate.pr) { runShare = candidate; break }
  }
  // Choose one actual completed session deterministically, never sum unrelated
  // sessions or repeat whole-workout metrics from legacy exercise rows.
  const candidates = owned(context.sessions).filter(session => session.ended_at)
    .map(session => fromStrength(session, owned(context.sets).filter(set => set.session_id === session.id), preferences))
  candidates.push(...owned(context.lifts).map(lift => fromStrength(lift, [lift], preferences)))
  const hybrid = candidates.map(lift => fromHybrid(runShare, lift, { showRoute })).find(Boolean) || null
  return { run: runShare, hybrid }
}

export function studioModel({ run, model, prefs, showRoute, title, context, hybrid = false }) {
  if (typeof showRoute !== 'boolean') throw new TypeError('showRoute must be a boolean')
  // Released A takes an options object; its showRoute FIELD is strictly boolean.
  // A bare false argument is not its contract and would keep geometry enabled.
  const activities = model ? null : activityShareModels(run, context, prefs, showRoute)
  const source = model || (hybrid && activities.hybrid) || activities.run
  const safe = rendererModel(source, showRoute)
  const customTitle = displayText(title)
  if (customTitle) safe.title = customTitle.slice(0, 48)
  return safe
}
