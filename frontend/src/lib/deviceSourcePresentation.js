export const GARMIN_BETA_PRESENTATION = Object.freeze({
  provider: 'garmin',
  state: 'direct_unavailable',
  label: 'Garmin',
  status: 'Direct connection unavailable in beta',
  detail: 'Direct Garmin connection is unavailable in this beta. Garmin workouts may enter Forge through Apple Health when Garmin Connect writes them there.',
  canConnect: false,
})

const UNAVAILABLE_SOURCE = Object.freeze({
  kind: 'unavailable',
  label: 'Source unavailable',
  detail: 'Source metadata is unavailable.',
})

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function explicitGarminViaAppleHealth(source, evidence = {}) {
  if (source === 'garmin_via_apple_health' || source === 'garmin_through_apple_health') return true
  if (source !== 'apple_health' && source !== 'healthkit') return false

  const upstream = normalized(
    evidence.upstreamProvider
    || evidence.upstream_provider
    || evidence.originalProvider
    || evidence.original_provider
  )
  return upstream === 'garmin' || upstream === 'garmin_connect'
}

export function providerSourcePresentation(value, evidence = {}) {
  const input = value && typeof value === 'object' ? value : { source: value }
  const source = normalized(
    input.source
    || input.provider
    || input.healthSource
    || input.health_source
    || input.metricSource
    || input.metric_source
  )
  const combinedEvidence = { ...input, ...evidence }

  if (explicitGarminViaAppleHealth(source, combinedEvidence)) {
    return {
      kind: 'garmin_via_apple_health',
      label: 'Garmin via Apple Health',
      detail: 'Garmin Connect wrote this workout to Apple Health.',
    }
  }

  if (source === 'apple_health' || source === 'healthkit' || source === 'apple') {
    return {
      kind: 'apple_health',
      label: 'Apple Health',
      detail: 'Imported from Apple Health.',
    }
  }

  if (source === 'strava' || source === 'strava_csv' || source === 'strava_file') {
    return {
      kind: 'strava',
      label: 'Strava',
      detail: source === 'strava' ? 'Synced from Strava.' : 'Imported from a Strava file.',
    }
  }

  if (source === 'garmin_csv' || source === 'garmin_file') {
    return {
      kind: 'garmin_file',
      label: 'Garmin file',
      detail: 'Imported from a Garmin file.',
    }
  }

  if (source === 'garmin') {
    return {
      kind: 'garmin',
      label: 'Garmin',
      detail: 'Garmin is explicitly recorded as the source.',
    }
  }

  if (['forge', 'forged_hybrid', 'logged', 'manual', 'manual_json'].includes(source)) {
    const isForge = source === 'forge' || source === 'forged_hybrid'
    return {
      kind: 'forge_manual',
      label: isForge ? 'Forge' : 'Forge / manual',
      detail: isForge ? 'Recorded in Forge.' : 'Added manually in Forge.',
    }
  }

  return UNAVAILABLE_SOURCE
}

export function formatFreshness(value, { prefix = 'Last synced' } = {}) {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const hour24 = date.getUTCHours()
  const hour = hour24 % 12 || 12
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const meridiem = hour24 >= 12 ? 'PM' : 'AM'
  return `${prefix} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour}:${minute} ${meridiem} UTC`
}

function profileNumber(profile, camelKey, snakeKey) {
  const value = profile?.[camelKey] ?? profile?.[snakeKey]
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function hrDerivationDetail(profile) {
  const model = normalized(profile?.zoneModel || profile?.zone_model)
  const maxHr = profileNumber(profile, 'maxHr', 'max_hr')
  const restingHr = profileNumber(profile, 'restingHr', 'resting_hr')
  const lthr = profileNumber(profile, 'lthr', 'lthr')
  const customMinimums = profile?.customMinimums ?? profile?.custom_zones_json

  if (model === 'custom' && customMinimums) return 'Uses the zone boundaries saved in your profile.'
  if (model === 'lthr' && lthr !== null) return 'Calculated from your saved lactate-threshold heart rate.'
  if (model === 'maxhr' && maxHr !== null) return 'Calculated from your saved max heart rate.'
  if (model === 'hrr' && maxHr !== null && restingHr !== null) return 'Calculated from your saved max and resting heart rates.'
  return 'Uses the HR values currently saved in your profile.'
}

export function hrZoneSourcePresentation(profile = {}) {
  const source = normalized(profile.source)
  const detail = hrDerivationDetail(profile)

  if (source === 'manual_watch') return { kind: 'manual_watch', label: 'Manual watch zones', detail }
  if (source === 'field_test') return { kind: 'field_test', label: 'Field test', detail }
  if (source === 'manual') return { kind: 'manual', label: 'Manual profile', detail }
  if (['calibrated', 'workout_history', 'workout_data'].includes(source)) {
    return { kind: 'workout_data', label: 'Workout calibration', detail }
  }
  if (source === 'apple_health' || source === 'healthkit') {
    return { kind: 'apple_health', label: 'Apple Health', detail }
  }

  return {
    kind: 'unavailable',
    label: 'Source unavailable',
    detail,
  }
}

export default {
  GARMIN_BETA_PRESENTATION,
  formatFreshness,
  hrZoneSourcePresentation,
  providerSourcePresentation,
}
