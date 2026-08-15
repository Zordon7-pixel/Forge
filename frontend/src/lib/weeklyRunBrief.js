import { canonicalWorkoutLabel, dayStatus } from './planCalendar.js'

const RUN_CATEGORY_PRIORITIES = Object.freeze({
  easy: ['daily_trainer', 'stability'],
  recovery: ['daily_trainer', 'stability'],
  long: ['daily_trainer', 'stability', 'tempo'],
  tempo: ['tempo', 'daily_trainer', 'race'],
  threshold: ['tempo', 'race', 'daily_trainer'],
  intervals: ['tempo', 'race'],
  speed: ['tempo', 'race'],
  race: ['race', 'tempo'],
  trail: ['trail'],
})

const PHASE_STORIES = Object.freeze({
  base: 'Build repeatable aerobic rhythm and durable movement.',
  build: 'Add controlled quality while protecting the easy days.',
  deload: 'Absorb the recent work with less training stress.',
  peak: 'Practice the goal demands without chasing extra fatigue.',
  taper: 'Keep race rhythm while arriving fresher.',
  race: 'Execute the prepared race plan with confidence.',
})

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function list(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function localDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function dateRangeLabel(days = []) {
  const dates = days.map((day) => localDate(day.dateISO)).filter(Boolean)
  if (!dates.length) return 'Dates unavailable'
  const first = dates[0]
  const last = dates[dates.length - 1]
  const firstLabel = first.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const lastLabel = last.toLocaleDateString(undefined, {
    month: first.getMonth() === last.getMonth() ? undefined : 'short',
    day: 'numeric',
    year: first.getFullYear() === last.getFullYear() ? undefined : 'numeric',
  })
  return `${firstLabel}–${lastLabel}`
}

function formatMinutes(minutes) {
  const rounded = Math.round(Number(minutes || 0))
  if (rounded <= 0) return ''
  const hours = Math.floor(rounded / 60)
  const remainder = rounded % 60
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${remainder} min`
}

function sessionText(session) {
  return [
    session?.type,
    session?.title,
    session?.raw?.workout_id,
    session?.prescription?.intensity,
  ].filter(Boolean).join(' ').toLowerCase()
}

export function sessionIntensity(session) {
  if (!session) return { key: 'rest', label: 'Rest' }
  if (session.kind === 'lift') return { key: 'strength', label: 'Strength' }
  if (session.kind === 'hyrox') return { key: 'hyrox', label: 'HYROX' }
  const identity = sessionText(session)
  if (/(race)/.test(identity)) return { key: 'race', label: 'Race' }
  if (/(interval|repeat|speed|hill|tempo|threshold|race.?pace|benchmark|fartlek)/.test(identity)) {
    return { key: 'quality', label: 'Quality' }
  }
  if (/(long)/.test(identity)) return { key: 'long', label: 'Long' }
  if (/(recovery)/.test(identity)) return { key: 'recovery', label: 'Recovery' }
  return { key: 'easy', label: 'Easy' }
}

function runType(session) {
  const intensity = sessionIntensity(session).key
  if (intensity === 'quality') {
    const identity = sessionText(session)
    if (/threshold/.test(identity)) return 'threshold'
    if (/tempo/.test(identity)) return 'tempo'
    if (/speed/.test(identity)) return 'speed'
    return 'intervals'
  }
  if (['race', 'long', 'recovery', 'easy'].includes(intensity)) return intensity
  return 'easy'
}

function sessionSurface(session) {
  const candidate = String(
    session?.prescription?.surface
      || session?.raw?.surface
      || session?.prescription?.terrain
      || session?.raw?.terrain
      || '',
  ).toLowerCase()
  if (['road', 'trail', 'both'].includes(candidate)) return candidate
  return /trail/.test(sessionText(session)) ? 'trail' : null
}

function shoeName(shoe) {
  return String(shoe?.nickname || [shoe?.brand, shoe?.model].filter(Boolean).join(' ') || '').trim()
}

function activeShoe(shoe) {
  return ![true, 1, '1', 'true'].includes(shoe?.is_retired)
    && ![false, 0, '0'].includes(shoe?.is_active)
}

function shoeWear(shoe) {
  const miles = finite(shoe?.total_miles ?? shoe?.current_miles ?? shoe?.miles) || 0
  const recommended = finite(shoe?.recommended_miles) || 0
  return {
    miles,
    recommended,
    ratio: recommended > 0 ? miles / recommended : null,
  }
}

function shoeSurface(shoe) {
  const surface = String(shoe?.surface || '').toLowerCase()
  if (['road', 'trail', 'both'].includes(surface)) return surface
  return String(shoe?.category || '').toLowerCase() === 'trail' ? 'trail' : null
}

function rankShoes(shoes, session, avoidIds = new Set()) {
  const type = runType(session)
  const requestedSurface = sessionSurface(session)
  const priorities = RUN_CATEGORY_PRIORITIES[type] || RUN_CATEGORY_PRIORITIES.easy
  const candidates = (Array.isArray(shoes) ? shoes : [])
    .filter(activeShoe)
    .filter((shoe) => {
      const wear = shoeWear(shoe)
      return wear.ratio === null || wear.ratio < 1
    })
    .map((shoe) => {
      const category = String(shoe.category || '').toLowerCase()
      const categoryIndex = priorities.indexOf(category)
      const tags = list(shoe.intent_tags).map((tag) => tag.toLowerCase())
      const surface = shoeSurface(shoe)
      const wear = shoeWear(shoe)
      const exactSurface = requestedSurface && surface === requestedSurface
      const versatileSurface = requestedSurface && (surface === 'both' || requestedSurface === 'both')
      const wrongSurface = requestedSurface && surface && !exactSurface && !versatileSurface
      const categoryMatched = categoryIndex >= 0
      const tagMatched = tags.includes(type)
      let score = categoryIndex >= 0 ? 60 - categoryIndex * 8 : 20
      if (tagMatched) score += 28
      if (exactSurface) score += 20
      else if (versatileSurface) score += 12
      else if (wrongSurface) score -= 45
      if (wear.ratio !== null) score += Math.max(0, 16 - wear.ratio * 16)
      if (avoidIds.has(String(shoe.id))) score -= 34
      return {
        shoe,
        score,
        type,
        requestedSurface,
        wrongSurface,
        wear,
        categoryMatched,
        tagMatched,
        desiredCategory: priorities[0],
      }
    })
    .sort((left, right) => right.score - left.score
      || Number(left.wear.ratio || 0) - Number(right.wear.ratio || 0)
      || String(left.shoe.id || '').localeCompare(String(right.shoe.id || '')))
  return candidates
}

function reasonForShoe(candidate, rotated) {
  if (!candidate) return ''
  const supportedMatch = candidate.categoryMatched || candidate.tagMatched
  const desiredCategory = String(candidate.desiredCategory || 'recommended shoe').replaceAll('_', ' ')
  const pieces = [supportedMatch
    ? `Matches this ${candidate.type} session`
    : `Closest available pair — no ${desiredCategory} saved`]
  if (candidate.requestedSurface && !candidate.wrongSurface) pieces.push(`fits the saved ${candidate.requestedSurface} surface`)
  if (rotated) pieces.push('spreads the hard-day load across your rotation')
  if (candidate.wear.ratio !== null) pieces.push(`${Math.round(candidate.wear.ratio * 100)}% of its mileage estimate used`)
  return `${pieces.join('; ')}.`
}

function shoePick(shoes, session, avoidIds) {
  const active = (Array.isArray(shoes) ? shoes : []).filter(activeShoe)
  if (!active.length) return { state: 'empty', primary: null, alternate: null, warning: '' }
  const ranked = rankShoes(shoes, session, avoidIds)
  if (!ranked.length) {
    return {
      state: 'wear-review',
      primary: null,
      alternate: null,
      warning: 'Every active pair is at or over its mileage estimate. Review Gear before this run.',
    }
  }
  const primary = ranked[0]
  const alternate = ranked[1] || null
  const bestWithoutAvoidance = rankShoes(shoes, session, new Set())[0]
  const rotated = Boolean(bestWithoutAvoidance && String(bestWithoutAvoidance.shoe.id) !== String(primary.shoe.id))
  const warnings = []
  if (!primary.categoryMatched && !primary.tagMatched) {
    const category = String(primary.shoe.category || 'shoe').replaceAll('_', ' ')
    warnings.push(`The closest available ${category} is not saved as a match for this ${primary.type} session.`)
  }
  if (primary.wrongSurface) warnings.push(`No verified ${primary.requestedSurface} match is available in Gear.`)
  if (primary.wear.ratio !== null && primary.wear.ratio >= 0.8) warnings.push('Primary pair is near its mileage estimate; inspect comfort and tread.')
  return {
    state: 'ready',
    primary: {
      id: String(primary.shoe.id || ''),
      name: shoeName(primary.shoe),
      reason: reasonForShoe(primary, rotated),
      miles: primary.wear.miles,
      recommendedMiles: primary.wear.recommended,
    },
    alternate: alternate ? {
      id: String(alternate.shoe.id || ''),
      name: shoeName(alternate.shoe),
      reason: reasonForShoe(alternate, false),
      miles: alternate.wear.miles,
      recommendedMiles: alternate.wear.recommended,
    } : null,
    warning: warnings.join(' '),
  }
}

function sessionTarget(session) {
  if (!session) return ''
  const miles = finite(session.distanceMiles)
  const minutes = finite(session.durationMinutes)
  if (session.prescriptionBasis === 'time' && minutes > 0) return `${Math.round(minutes)} min`
  const parts = [miles > 0 ? `${session.distanceIsEstimate ? '~' : ''}${miles.toFixed(1)} mi` : '', minutes > 0 ? formatMinutes(minutes) : ''].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  return session.kind === 'lift' ? 'Strength' : session.kind === 'hyrox' ? 'HYROX' : 'Planned'
}

function dayTarget(day) {
  const targets = (day.sessions || []).map(sessionTarget).filter(Boolean)
  return targets.join(' + ') || 'Recovery'
}

function primarySession(day) {
  return day.sessions?.find((session) => session.kind === 'run')
    || day.sessions?.find((session) => session.kind === 'hyrox')
    || day.sessions?.find((session) => session.kind === 'lift')
    || null
}

function dayTitle(day) {
  if (day.isRest) return 'Rest day'
  return (day.sessions || []).map((session) => canonicalWorkoutLabel(session)).filter(Boolean).join(' + ') || 'Session'
}

function dayPurpose(day, session) {
  if (session?.canonical) {
    return (session.purposeReasonCodes || []).join(' · ')
  }
  return String(
    session?.prescription?.purpose
      || session?.prescription?.description
      || session?.raw?.purpose
      || session?.raw?.description
      || day?.whyToday
      || '',
  ).trim()
}

function canonicalTargetValue(target = {}) {
  if (!target || typeof target !== 'object') return ''
  return Object.entries(target).map(([key, value]) => {
    if (value === null || value === undefined || value === '') return ''
    const label = String(key).replaceAll('_', ' ')
    const rendered = Array.isArray(value) ? value.join('–') : String(value)
    return `${label}: ${rendered}`
  }).filter(Boolean).join(' · ')
}

function canonicalTargets(session) {
  if (!session?.canonical || !Array.isArray(session.steps)) return ''
  const walk = (steps) => steps.flatMap((step) => [
    canonicalTargetValue(step?.target),
    ...(Array.isArray(step?.children) ? walk(step.children) : []),
  ]).filter(Boolean)
  return walk(session.steps).join(' · ')
}

function canonicalBriefFields(session) {
  if (!session?.canonical) return null
  return {
    sessionId: session.id,
    sessionRevision: session.sessionRevision,
    planRevision: session.planRevision,
    contentHash: session.contentHash,
    role: session.role,
    steps: session.steps,
    targetProvenance: session.targetProvenance,
    purposeReasonCodes: session.purposeReasonCodes,
    adjustmentCriteria: session.adjustmentCriteria,
    stopCriteria: session.stopCriteria,
    safetyScope: session.safetyScope,
    executability: session.executability,
    capability: session.capability,
  }
}

function trustedHrTarget(session, hrContext = {}) {
  const profile = hrContext?.profile
  const zones = Array.isArray(hrContext?.zones) ? hrContext.zones : []
  if (!profile || zones.length !== 5) return null
  const zoneModel = String(profile.zoneModel || profile.zone_model || profile.model || '').toLowerCase()
  const zoneMap = new Map()
  for (const zone of zones) {
    const number = Number(zone?.zone)
    const minBpm = finite(zone?.minBpm ?? zone?.min_bpm)
    const rawMaxBpm = zone?.maxBpm ?? zone?.max_bpm
    const maxBpm = finite(rawMaxBpm)
    const openEnded = number === 5 && zoneModel === 'lthr'
      && (rawMaxBpm === null || rawMaxBpm === undefined || Number(rawMaxBpm) === Infinity)
    if (!Number.isInteger(number) || number < 1 || number > 5
      || !Number.isInteger(minBpm)
      || (!openEnded && (!Number.isInteger(maxBpm) || minBpm >= maxBpm))
      || zoneMap.has(number)) return null
    zoneMap.set(number, { ...zone, minBpm, maxBpm: openEnded ? null : maxBpm, openEnded })
  }
  if (![1, 2, 3, 4, 5].every((number) => zoneMap.has(number))) return null
  for (let number = 2; number <= 5; number += 1) {
    if (zoneMap.get(number - 1).maxBpm > zoneMap.get(number).minBpm) return null
  }
  const target = String(
    session?.prescription?.target_zone
      || session?.prescription?.zone
      || session?.prescription?.hrZone
      || session?.raw?.target_zone
      || session?.raw?.zone
      || '',
  )
  const matches = [...target.matchAll(/(?:zone|z)\s*([1-5])(?:\s*[-–]\s*(?:(?:zone|z)\s*)?([1-5]))?/gi)]
  const numbers = matches.flatMap((match) => [match[1], match[2]]).filter(Boolean).map(Number)
  if (!numbers.length) return null
  const low = Math.min(...numbers)
  const high = Math.max(...numbers)
  const minBpm = zoneMap.get(low)?.minBpm
  const maxBpm = zoneMap.get(high)?.maxBpm
  const openEnded = zoneMap.get(high)?.openEnded === true
  if (!Number.isInteger(minBpm)
    || (!openEnded && (!Number.isInteger(maxBpm) || minBpm >= maxBpm))) return null
  return {
    zoneLabel: low === high ? `Zone ${low}` : `Zones ${low}–${high}`,
    bpmLabel: openEnded ? `${minBpm}+ bpm` : `${minBpm}–${maxBpm} bpm`,
    sourceLabel: 'Saved HR profile',
  }
}

function readinessLabel(day, completedSet, todayISO) {
  const status = dayStatus(day, completedSet)
  if (status === 'completed') return 'Complete'
  if (status === 'adjusted') return 'Adjusted'
  if (status === 'skipped') return 'Skipped'
  if (day.isRest) return 'Recovery'
  if (day.dateISO === todayISO) return 'Ready today'
  return 'Planned'
}

function mixLabel(counts) {
  return [
    counts.quality ? `${counts.quality} quality` : '',
    counts.long ? `${counts.long} long` : '',
    counts.easy ? `${counts.easy} easy` : '',
    counts.strength ? `${counts.strength} strength` : '',
    counts.hyrox ? `${counts.hyrox} HYROX` : '',
    counts.rest ? `${counts.rest} rest` : '',
  ].filter(Boolean).join(' · ')
}

export function buildWeeklyRunBrief({
  week,
  completedSet = new Set(),
  todayISO = '',
  gear = { available: true, shoes: [] },
  hrContext = { profile: null, zones: [] },
} = {}) {
  if (!week) return null
  if (week.surface?.status === 'blocked') return null
  const canonicalSurface = week.surface?.status === 'accepted'
  const hardDayShoes = new Set()
  const days = (week.days || []).map((day) => {
    const session = primarySession(day)
    const intensity = sessionIntensity(session)
    const isHard = ['quality', 'long', 'race', 'hyrox'].includes(intensity.key)
    const footwear = session?.canonical
      ? null
      : session?.kind === 'run' && gear.available
      ? shoePick(gear.shoes, session, isHard ? hardDayShoes : new Set())
      : session?.kind === 'run'
        ? { state: 'unavailable', primary: null, alternate: null, warning: 'Gear is unavailable right now. No shoe was guessed.' }
        : null
    if (isHard && footwear?.primary?.id) hardDayShoes.add(footwear.primary.id)
    const savedAdjustmentReason = String(
      session?.raw?.adjustmentReason
        || session?.raw?.adjustment_reason
        || session?.prescription?.adjustmentReason
        || session?.prescription?.adjustment_reason
        || '',
    ).trim()
    const adjustmentReason = session?.adjusted && savedAdjustmentReason ? savedAdjustmentReason : ''
    return {
      dateISO: day.dateISO,
      dayLabel: day.dayLabel,
      date: day.date,
      title: dayTitle(day),
      target: dayTarget(day),
      intensity,
      state: dayStatus(day, completedSet),
      readiness: readinessLabel(day, completedSet, todayISO),
      isToday: day.dateISO === todayISO,
      isRest: day.isRest,
      mission: dayPurpose(day, session),
      footwear,
      hrTarget: session?.canonical ? null : session?.kind === 'run' ? trustedHrTarget(session, hrContext) : null,
      effortTarget: session?.canonical ? canonicalTargets(session) : session?.kind === 'run' ? String(
        session?.prescription?.pace_target
          || session?.prescription?.pace
          || session?.prescription?.intensity
          || session?.prescription?.target_zone
          || session?.raw?.pace_target
          || session?.raw?.intensity
          || session?.raw?.target_zone
          || '',
      ).trim() : '',
      adjustmentReason,
      canonical: canonicalBriefFields(session),
      rawDay: day,
    }
  })

  const sessions = (week.days || []).flatMap((day) => day.sessions || [])
  const runs = sessions.filter((session) => session.kind === 'run')
  const totalMiles = runs.reduce((sum, session) => sum + (finite(session.distanceMiles) || 0), 0)
  const totalMilesIsEstimate = runs.some((session) => (
    (finite(session.distanceMiles) || 0) > 0 && session.distanceIsEstimate === true
  ))
  const totalMinutes = sessions.reduce((sum, session) => sum + (finite(session.durationMinutes) || 0), 0)
  const counts = { quality: 0, long: 0, easy: 0, strength: 0, hyrox: 0, rest: 0 }
  for (const day of days) {
    if (day.isRest) {
      counts.rest += 1
      continue
    }
    for (const session of day.rawDay?.sessions || []) {
      const key = sessionIntensity(session).key
      if (key === 'quality' || key === 'race') counts.quality += 1
      if (key === 'long') counts.long += 1
      if (['easy', 'recovery'].includes(key)) counts.easy += 1
      if (key === 'strength') counts.strength += 1
      if (key === 'hyrox') counts.hyrox += 1
    }
  }
  const purpose = String(week.purpose || PHASE_STORIES[week.phase] || 'Follow the scheduled balance of training and recovery.').trim()
  const today = days.find((day) => day.isToday) || null
  const duplicateHardShoe = [...hardDayShoes].length > 0
    && days.filter((day) => ['quality', 'long', 'race', 'hyrox'].includes(day.intensity.key) && day.footwear?.primary).length > hardDayShoes.size
  const gearWarnings = [...new Set([
    ...days.map((day) => day.footwear?.warning).filter(Boolean),
    duplicateHardShoe ? 'The same primary pair covers more than one hard day because the current Gear rotation has no safer distinct match.' : '',
  ].filter(Boolean))]

  return {
    surface: week.surface || { status: 'legacy', reasonCodes: [] },
    dateRange: dateRangeLabel(week.days),
    purpose,
    feasibility: canonicalSurface ? {
      status: week.surface.manifest?.feasibility?.status || null,
      reasonCodes: Array.isArray(week.surface.manifest?.feasibility?.reason_codes)
        ? week.surface.manifest.feasibility.reason_codes : [],
    } : null,
    totalMiles,
    totalMilesLabel: totalMiles > 0 ? `${totalMilesIsEstimate ? '~' : ''}${totalMiles.toFixed(1)} mi` : '',
    totalTimeLabel: formatMinutes(totalMinutes),
    mix: counts,
    mixLabel: mixLabel(counts),
    days,
    today,
    gearAvailable: gear.available !== false,
    gearWarnings,
    safetyRules: canonicalSurface ? [] : [
      { if: 'pain is sharp, worsening, or changes your movement', then: 'stop the session and use the injury check-in before resuming' },
      { if: 'soreness does not improve during the warm-up', then: 'choose recovery or rest and check in so Forge can adapt safely' },
      { if: 'normal effort feels unexpectedly hard', then: 'stay within the saved effort target instead of forcing pace' },
    ],
  }
}
