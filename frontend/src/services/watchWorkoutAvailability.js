export const MIN_WATCH_WORKOUT_BUILD = 16

export function normalizeBuildNumber(value) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function watchWorkoutUnavailableReason(error, appInfo = null) {
  const message = String(error?.message || error || '').trim()
  const pluginMissing = /not implemented|unimplemented|plugin|no web implementation/i.test(message)
  if (!pluginMissing) {
    return message || 'Automatic Apple Watch delivery is unavailable on this iPhone.'
  }

  const installedBuild = normalizeBuildNumber(appInfo?.build)
  if (installedBuild && installedBuild < MIN_WATCH_WORKOUT_BUILD) {
    return `Apple Watch delivery requires TestFlight build ${MIN_WATCH_WORKOUT_BUILD} or newer. You have build ${installedBuild}; manual entry still works.`
  }
  if (installedBuild) {
    return `Apple Watch delivery did not load in build ${installedBuild}. Reopen Forged Hybrid, then report this diagnostic if it continues; manual entry still works.`
  }
  return 'Apple Watch delivery is not available in this installed app. Manual entry still works.'
}
