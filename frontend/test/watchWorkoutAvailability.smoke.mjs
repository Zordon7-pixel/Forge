import {
  MIN_WATCH_WORKOUT_BUILD,
  athleteWatchAvailabilityMessage,
  isInternalWatchDiagnostic,
  normalizeBuildNumber,
  watchWorkoutUnavailableReason,
} from '../src/services/watchWorkoutAvailability.js'

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(MIN_WATCH_WORKOUT_BUILD === 16, 'native registration fix must target build 16')
check(normalizeBuildNumber('15') === 15 && normalizeBuildNumber('bad') === null, 'build numbers normalize safely')
check(
  watchWorkoutUnavailableReason(new Error('ForgeWatchWorkout plugin is not implemented'), { build: '15' })
    .includes('requires TestFlight build 16 or newer'),
  'build 15 gets an exact upgrade requirement',
)
check(
  watchWorkoutUnavailableReason(new Error('ForgeWatchWorkout plugin is not implemented'), { build: '16' })
    .includes('did not load in build 16'),
  'a post-fix plugin failure is reported as a diagnostic, not another blind update request',
)
check(
  watchWorkoutUnavailableReason(new Error('Apple Watch workout scheduling requires iOS 17 or newer.'), { build: '16' })
    === 'Apple Watch workout scheduling requires iOS 17 or newer.',
  'native device requirement messages remain intact',
)
check(isInternalWatchDiagnostic('Plugin did not load in build 15'), 'native build/plugin failures are recognized as internal diagnostics')
check(
  athleteWatchAvailabilityMessage('Apple Watch delivery requires TestFlight build 16 or newer. You have build 15; manual entry still works.')
    === 'Automatic Apple Watch delivery is not enabled in this beta. Manual entry still works.',
  'athletes never see native build numbers',
)

console.log(`WATCH AVAILABILITY SMOKE OK (${passed})`)
