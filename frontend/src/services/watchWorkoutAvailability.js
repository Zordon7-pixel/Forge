export const MIN_WATCH_WORKOUT_BUILD = 16

export function normalizeBuildNumber(value) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function isInternalWatchDiagnostic(reason = '') {
  return /build|plugin|installed app|did not load/i.test(String(reason || ''))
}

export function athleteWatchAvailabilityMessage(reason = '') {
  if (/only works in the Forged Hybrid iPhone app/i.test(reason)) {
    return 'Open Forged Hybrid on iPhone to send this workout. Manual entry still works.'
  }
  if (isInternalWatchDiagnostic(reason)) {
    return 'Apple Watch delivery is coming in the next app update. Manual entry still works.'
  }
  return 'Apple Watch delivery is unavailable right now. Manual entry still works.'
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
