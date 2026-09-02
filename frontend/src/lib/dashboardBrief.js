import { humanizeMachineValue } from './goalBackwardPresentation.js'

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function hasOwn(source, key) {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key))
}

export function dashboardCustomerText(value, { casing = 'sentence' } = {}) {
  const raw = String(value ?? '').trim()
  if (!raw || raw === '--' || /\b(?:sha256:)?[a-f0-9]{32,}\b/i.test(raw) || /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(raw)) return ''
  if (/^[A-Z0-9_]+$/.test(raw) || /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(raw)) {
    return humanizeMachineValue(raw, { casing, fallback: '' })
  }
  return raw
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, (token) => humanizeMachineValue(token))
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (token) => humanizeMachineValue(token))
}

function displayMiles(value) {
  const miles = finiteNumber(value)
  return miles === null ? '' : `${miles.toFixed(1)} mi`
}

function displayDate(value) {
  if (!value) return ''
  const raw = String(value)
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw)
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function buildDailyBriefContext({ weeklyRecap, readinessData, nextRace } = {}) {
  const context = []

  if (readinessData?.available !== false) {
    const readinessScore = finiteNumber(readinessData?.score)
    const readinessBand = dashboardCustomerText(readinessData?.band, { casing: 'title' })
    const readinessDriver = Array.isArray(readinessData?.drivers)
      ? readinessData.drivers.map((value) => dashboardCustomerText(value)).find(Boolean)
      : ''
    const readinessValue = [
      readinessScore !== null ? String(Math.round(readinessScore)) : '',
      readinessBand,
    ].filter(Boolean).join(' · ')
    if (readinessValue || readinessDriver) {
      context.push({
        key: 'readiness',
        label: 'Readiness',
        value: readinessValue,
        detail: readinessDriver,
      })
    }
  }

  const recapMiles = finiteNumber(weeklyRecap?.totalMiles)
  const recapRuns = finiteNumber(weeklyRecap?.totalRuns)
  const recentTraining = [
    recapMiles !== null ? displayMiles(recapMiles) : '',
    recapRuns !== null ? `${recapRuns} run${recapRuns === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ')
  if (recentTraining) {
    context.push({
      key: 'recent-training',
      label: 'Recent training',
      value: recentTraining,
      detail: dashboardCustomerText(weeklyRecap?.weekLabel, { casing: 'title' }),
    })
  }

  const raceName = dashboardCustomerText(nextRace?.race_name || nextRace?.name, { casing: 'title' })
  const raceDate = displayDate(nextRace?.race_date || nextRace?.date)
  if (raceName || raceDate) {
    context.push({
      key: 'next-event',
      label: 'Next event',
      value: raceName,
      detail: raceDate,
    })
  }

  return context
}

function recapHighlight(recap) {
  const pr = Array.isArray(recap?.prsThisWeek)
    ? recap.prsThisWeek.map((value) => dashboardCustomerText(value)).find(Boolean)
    : ''
  if (pr) return { label: 'Personal best', text: pr }

  const bestMiles = finiteNumber(recap?.bestRun?.miles)
  if (bestMiles !== null && bestMiles > 0) {
    const date = displayDate(recap.bestRun.date)
    return {
      label: 'Longest run',
      text: `${displayMiles(bestMiles)}${date ? ` on ${date}` : ''}`,
    }
  }

  const longestRun = finiteNumber(recap?.longestRun)
  if (longestRun !== null && longestRun > 0) {
    return { label: 'Longest run', text: displayMiles(longestRun) }
  }

  const liftSessions = finiteNumber(recap?.liftSessions)
  if (liftSessions !== null && liftSessions > 0) {
    return {
      label: 'Strength consistency',
      text: `${liftSessions} lift session${liftSessions === 1 ? '' : 's'} completed`,
    }
  }

  return null
}

export function buildWeeklyRecapView(recap) {
  if (!recap || typeof recap !== 'object') return null

  const totalMiles = finiteNumber(recap.totalMiles)
  const totalRuns = finiteNumber(recap.totalRuns)
  const totalMinutes = finiteNumber(recap.totalMinutes)
  const totalCalories = finiteNumber(recap.totalCalories)
  const streak = finiteNumber(recap.streak)
  const liftSessions = finiteNumber(recap.liftSessions)
  const avgPace = dashboardCustomerText(recap.avgPace)
  const metrics = []

  if (hasOwn(recap, 'totalMiles') && totalMiles !== null) {
    metrics.push({ key: 'distance', label: 'Distance', value: displayMiles(totalMiles) })
  }
  if (hasOwn(recap, 'totalRuns') && totalRuns !== null) {
    metrics.push({ key: 'runs', label: 'Runs', value: String(totalRuns) })
  }
  if (totalMinutes !== null && totalMinutes > 0) {
    metrics.push({ key: 'duration', label: 'Duration', value: `${totalMinutes} min` })
  } else if (streak !== null && streak > 0) {
    metrics.push({ key: 'consistency', label: 'Consistency', value: `${streak} day${streak === 1 ? '' : 's'}` })
  } else if (liftSessions !== null && liftSessions > 0) {
    metrics.push({ key: 'strength', label: 'Strength', value: `${liftSessions} session${liftSessions === 1 ? '' : 's'}` })
  }
  if (totalCalories !== null && totalCalories > 0) {
    metrics.push({ key: 'calories', label: 'Calories', value: `${totalCalories.toLocaleString('en-US')} cal` })
  }
  if (avgPace) metrics.push({ key: 'pace', label: 'Average pace', value: `${avgPace}/mi` })

  const teaserItems = [
    totalMiles !== null ? displayMiles(totalMiles) : '',
    totalRuns !== null ? `${totalRuns} run${totalRuns === 1 ? '' : 's'}` : '',
    totalCalories !== null && totalCalories > 0 ? `${totalCalories.toLocaleString('en-US')} cal` : '',
  ].filter(Boolean)

  return {
    weekLabel: dashboardCustomerText(recap.weekLabel, { casing: 'title' }) || 'Last 7 days',
    mileageDelta: finiteNumber(recap.mileageVsLastWeek),
    teaserItems,
    metrics,
    highlight: recapHighlight(recap),
    nextWeek: dashboardCustomerText(recap.insight),
    riskReason: recap.injuryRiskFlag ? dashboardCustomerText(recap.injuryRiskReason) : '',
  }
}

function isRestDay({ recommendation, execution }) {
  const recommendationType = String(recommendation?.recommendationType || recommendation?.type || '').toLowerCase()
  return execution?.isRest === true
    || execution?.isPlannedRest === true
    || ['planned', 'checkin', 'safety', 'recovery'].includes(String(execution?.restSource || '').toLowerCase())
    || recommendationType === 'rest'
}

export function buildRestDayReasons({ recommendation, execution, weeklyRecap, readinessData, nextRace } = {}) {
  if (!isRestDay({ recommendation, execution })) return []

  const reasons = []
  const planned = execution?.isPlannedRest === true || execution?.restSource === 'planned'
  const recommendationReason = dashboardCustomerText(recommendation?.reason)
  reasons.push({
    key: 'plan',
    label: planned ? 'Planned recovery' : 'Recovery adjustment',
    detail: recommendationReason || (planned
      ? 'Your active plan schedules recovery today.'
      : 'Today’s active plan is set to recovery.'),
  })

  const recapMiles = finiteNumber(weeklyRecap?.totalMiles)
  const recapRuns = finiteNumber(weeklyRecap?.totalRuns)
  if (recapMiles !== null && recapMiles > 0 && recapRuns !== null && recapRuns > 0) {
    const range = dashboardCustomerText(weeklyRecap?.weekLabel, { casing: 'title' })
    reasons.push({
      key: 'recent-work',
      label: 'Absorb recent work',
      detail: `${displayMiles(recapMiles)} across ${recapRuns} run${recapRuns === 1 ? '' : 's'}${range ? ` · ${range}` : ''}`,
    })
  } else {
    const driver = Array.isArray(readinessData?.drivers)
      ? readinessData.drivers.map((value) => dashboardCustomerText(value)).find(Boolean)
      : ''
    if (driver) reasons.push({ key: 'recovery-signal', label: 'Recovery signal', detail: driver })
  }

  const raceName = dashboardCustomerText(nextRace?.race_name || nextRace?.name, { casing: 'title' })
  const raceDate = displayDate(nextRace?.race_date || nextRace?.date)
  if (raceName) {
    reasons.push({
      key: 'forward-purpose',
      label: 'Protect the build',
      detail: `${raceName}${raceDate ? ` · ${raceDate}` : ''}`,
    })
  }

  return reasons.slice(0, 3)
}
