const HYROX_FORMAT_LABELS = {
  individual_open: 'Open',
  individual_pro: 'Pro',
  doubles: 'Doubles',
  relay: 'Relay',
}

const HYROX_CATEGORY_LABELS = {
  women: 'Women',
  men: 'Men',
  mixed: 'Mixed',
}

const SUPPORTED_EQUIPMENT = new Set([
  'ski_erg',
  'row_erg',
  'sled_push',
  'sled_pull',
  'wall_ball_target',
  'sandbag',
  'farmers_carry',
  'treadmill',
])

const RUNNING_PRIORITIES = new Set(['maintain', 'improve', 'race_pr'])

function safeObject(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeTrainingDays(value) {
  const valid = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  return Array.isArray(value) ? [...new Set(value.filter((day) => valid.has(day)))] : []
}

export function isHyroxRace(race = {}) {
  return String(race?.event_kind || '').toLowerCase() === 'hyrox'
}

export function hyroxDivisionLabel(race = {}) {
  const format = HYROX_FORMAT_LABELS[String(race.event_format || '').toLowerCase()] || ''
  const category = HYROX_CATEGORY_LABELS[String(race.event_category || '').toLowerCase()] || ''
  return format && category ? `${format} ${category}` : 'Division not set'
}

export function hyroxSetupInitialState(initialRace = null, initialSecondaryRaceId = '', fallbackTimezone = 'UTC') {
  const race = isHyroxRace(initialRace) ? initialRace : null
  const config = safeObject(race?.event_config_json)
  const configuredDays = normalizeTrainingDays(config.trainingDays)
  const configuredRunDays = Number(config.runDaysPerWeek)
  return {
    eventName: String(race?.race_name || ''),
    eventLocalDate: String(race?.event_local_date || race?.race_date || ''),
    eventTimezone: String(race?.event_timezone || fallbackTimezone || 'UTC'),
    location: String(race?.location || ''),
    // New plans fail closed until the athlete explicitly chooses a division.
    eventFormat: String(race?.event_format || ''),
    eventCategory: String(race?.event_category || ''),
    runningPriority: RUNNING_PRIORITIES.has(String(config.runningPriority)) ? String(config.runningPriority) : 'maintain',
    equipment: Array.isArray(config.equipment)
      ? [...new Set(config.equipment.map(String).filter((item) => SUPPORTED_EQUIPMENT.has(item)))]
      : [],
    runDaysPerWeek: [3, 4].includes(configuredRunDays) ? configuredRunDays : 3,
    trainingDays: configuredDays.length ? configuredDays : ['Tue', 'Thu', 'Sat', 'Sun'],
    secondaryRaceId: String(initialSecondaryRaceId || ''),
    ownedHyroxRace: race,
  }
}

function daysBetween(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end || ''))) return null
  const startMs = new Date(`${start}T12:00:00`).getTime()
  const endMs = new Date(`${end}T12:00:00`).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return Math.round((endMs - startMs) / 86400000)
}

export function preferredActiveSecondaryRaceId({ hyroxRace, savedRaces = [], activePlanRaceIds = [] } = {}) {
  if (!isHyroxRace(hyroxRace)) return ''
  const active = new Set(activePlanRaceIds.map(String))
  const candidates = savedRaces
    .filter((race) => (
      active.has(String(race?.id || ''))
      && String(race?.event_kind || 'run_race') === 'run_race'
      && String(race?.status || '') === 'upcoming'
    ))
    .map((race) => ({ race, gap: daysBetween(hyroxRace.race_date, race.race_date) }))
    .filter(({ gap }) => Number.isFinite(gap) && gap >= 21)
    .sort((a, b) => String(a.race.race_date).localeCompare(String(b.race.race_date)))
  return candidates.length ? String(candidates[0].race.id) : ''
}

export function hyroxCombinedPlanGuidance({
  hyroxRace,
  savedRaces = [],
  activePlanRaceIds = [],
  selectedSecondaryRaceId = '',
} = {}) {
  if (!isHyroxRace(hyroxRace)) return { selectedRace: null, excludedActiveRaces: [] }
  const active = new Set(activePlanRaceIds.map(String))
  const runningRaces = savedRaces.filter((race) => String(race?.event_kind || 'run_race') === 'run_race')
  const selectedRace = runningRaces.find((race) => String(race?.id || '') === String(selectedSecondaryRaceId || '')) || null
  const excludedActiveRaces = runningRaces
    .filter((race) => active.has(String(race?.id || '')) && String(race?.id || '') !== String(selectedSecondaryRaceId || ''))
    .map((race) => {
      const gap = daysBetween(hyroxRace.race_date, race.race_date)
      if (!Number.isFinite(gap) || gap < 21) {
        const gapCopy = Number.isFinite(gap) ? `${gap} days` : 'not a valid dated gap'
        return {
          race,
          reasonCode: 'race_spacing_conflict',
          explanation: `${race.race_name} is not included because it is ${gapCopy} after HYROX; at least 21 days is required. Change either event date or choose a later running race.`,
        }
      }
      if (selectedRace) {
        return {
          race,
          reasonCode: 'one_secondary_limit',
          explanation: `${race.race_name} is not included because a supported HYROX rebuild can protect only one secondary running race. Choose which running race to combine with HYROX.`,
        }
      }
      return {
        race,
        reasonCode: 'not_selected',
        explanation: `${race.race_name} is not included in this HYROX-only preview. Select one supported secondary running race to include it in the rebuild.`,
      }
    })
  return { selectedRace, excludedActiveRaces }
}
