// Display-only adapters. Inputs remain untouched; no defaults stand in for evidence.
const KM_PER_MILE = 1.60934
const KG_PER_LB = 0.453592
const META = Symbol('share source')
const FORBIDDEN = /^(--|0:00|NaN|undefined|null|NOT SHARED)$/i

function number(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function positive(value) {
  const result = number(value)
  return result > 0 ? result : null
}

function text(value) {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result && !FORBIDDEN.test(result) && !/forgedhybrid/i.test(result) ? result : null
}

function id(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value)
}

// Same local-date prefix semantics as hybridReconciliation.reconciliationKey:
// never convert an offset timestamp to UTC (which can change its recorded day).
function dateKey(value) {
  if (typeof value !== 'string') return null
  const key = value.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const parsed = new Date(`${key}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key ? key : null
}

function activityDate(activity, prefs) {
  // local_date is an optional caller-supplied activity date, not today's date.
  for (const local of [activity?.local_date, prefs?.local_date]) {
    if (typeof local === 'string' && local.length === 10 && dateKey(local)) return local
  }
  const value = activity?.date || activity?.started_at || activity?.created_at
  const prefix = dateKey(value)
  // Date-only and offset-bearing local records retain their recorded day.
  // Only UTC instants need the explicit user timezone; never use the host TZ.
  if (!prefix || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/i.test(value) || !text(prefs?.timezone)) return prefix
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime())) return prefix
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: prefs.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(instant)
    const part = type => parts.find(item => item.type === type)?.value
    return dateKey(`${part('year')}-${part('month')}-${part('day')}`)
  } catch {
    // An invalid user timezone falls back to reconciliationKey's date prefix.
    return prefix
  }
}

function unitFor(prefs) {
  return prefs?.distance_unit === 'km' || (!prefs?.distance_unit && prefs?.units === 'metric') ? 'km' : 'mi'
}

function handleFor(prefs) {
  const handle = text(prefs?.friend_handle)?.replace(/^@+/, '')
  return handle && /^[a-z0-9_.-]+$/i.test(handle) ? `@${handle}` : null
}

function decimal(value, digits = 1) {
  // Preserve very small positive measurements instead of rounding them to zero.
  const rounded = Number(value.toFixed(digits))
  return String(rounded > 0 ? rounded : value)
}

function duration(value) {
  if (!positive(value)) return null
  const seconds = Math.round(value)
  if (seconds === 0) return `${decimal(value, 3)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = String(seconds % 60).padStart(2, '0')
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`
}

function stat(stats, key, label, source, value, unit) {
  if (!positive(source) || !text(value)) return
  stats.push({ key, label, value, ...(unit ? { unit } : {}) })
}

function metadata(model, source) {
  return Object.defineProperty(model, META, { value: Object.freeze(source), enumerable: false })
}

function base(kind, source, prefs, stats, heroKey, date) {
  return {
    kind,
    title: text(source?.name) || text(source?.title) || (kind === 'lift' ? null : text(source?.type)),
    dateLabel: date,
    handle: handleFor(prefs),
    unit: unitFor(prefs),
    stats,
    hero: stats.find(item => item.key === heroKey) || null,
    pr: null,
  }
}

function routeData(raw, metric) {
  let points = raw
  if (typeof raw === 'string') {
    try { points = JSON.parse(raw) } catch { return { route: null, elevationProfile: null } }
  }
  if (!Array.isArray(points)) return { route: null, elevationProfile: null }
  const route = [], elevationProfile = []
  for (const point of points) {
    const lat = number(Array.isArray(point) ? point[0] : point?.lat)
    const lng = number(Array.isArray(point) ? point[1] : point?.lon ?? point?.lng)
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
    route.push([lat, lng])
    const altitude = number(Array.isArray(point) ? point[2] : point?.alt ?? point?.altitude)
    if (altitude !== null) {
      const display = metric ? altitude : altitude / 0.3048
      if (Number.isFinite(display)) elevationProfile.push(display)
    }
  }
  return { route: route.length ? route : null, elevationProfile: elevationProfile.length ? elevationProfile : null }
}

export function fromRun(run, prefs, options = { showRoute: true }) {
  const unit = unitFor(prefs), metric = unit === 'km', stats = []
  const miles = positive(run?.distance_miles), seconds = positive(run?.duration_seconds)
  const distance = miles === null ? null : positive(miles * (metric ? KM_PER_MILE : 1))
  const elevation = positive(run?.elevation_gain) * (metric ? 0.3048 : 1)
  const calories = positive(run?.calories), hr = positive(run?.avg_heart_rate ?? run?.avg_hr)
  stat(stats, 'distance', 'Distance', distance, distance === null ? null : decimal(distance, 2), unit)
  stat(stats, 'pace', 'Pace', seconds && distance ? seconds / distance : null, duration(seconds && distance ? seconds / distance : null), `/${unit}`)
  stat(stats, 'time', 'Time', seconds, duration(seconds))
  stat(stats, 'elevation', 'Elevation', elevation >= 1 ? elevation : null, decimal(elevation, 0), metric ? 'm' : 'ft')
  stat(stats, 'calories', 'Calories', calories, calories === null ? null : decimal(calories, 0), 'kcal')
  stat(stats, 'avgHr', 'Avg HR', hr, hr === null ? null : decimal(hr, 0), 'bpm')
  const date = activityDate(run, prefs)
  const model = base('run', run, prefs, stats, 'distance', date)
  // OFF never reads or retains geometry, even in metadata. Restore by calling
  // fromRun again with the caller-owned raw run; the model stores no raw source.
  model.run = { stats, ...(options?.showRoute === false
    ? { route: null, elevationProfile: null } : routeData(run?.route_coords, metric)) }
  return metadata(model, { date, seconds, calories, runIds: [id(run?.id)].filter(Boolean), liftIds: [] })
}

// Legacy imports repeat whole-workout metrics on exercise rows. Only a single
// consistent recorded total is usable; differing/partial totals stay unknown.
function legacyMetric(session, rows, key) {
  if (session?.[key] !== undefined) return positive(session[key])
  const values = rows.map(row => positive(row[key]))
  return values.length && values.every(value => value !== null && value === values[0]) ? values[0] : null
}

export function fromStrength(session, setsOrLiftRows, prefs) {
  const rows = (Array.isArray(setsOrLiftRows) ? setsOrLiftRows : []).filter(row => row && typeof row === 'object')
  // workout_sets have session_id/set_number; legacy lifts have a sets count.
  const legacy = !rows.some(row => 'session_id' in row || 'set_number' in row)
    && (rows.some(row => 'sets' in row || 'workout_duration_seconds' in row) || 'sets' in (session || {}))
  const metric = unitFor(prefs) === 'km', weightUnit = metric ? 'kg' : 'lbs'
  const weightFactor = metric ? KG_PER_LB : 1
  let sets = legacy ? 0 : rows.length, reps = 0, volume = 0, top = null
  const exercises = new Map()
  for (const row of rows) {
    const count = legacy ? positive(row.sets) : 1
    const repetitions = positive(row.reps), weight = positive(row.weight_lbs)
    if (legacy && count) sets += count
    if (count && repetitions) reps += count * repetitions
    if (!count || !repetitions || !weight) continue
    const rowVolume = count * repetitions * weight
    volume += rowVolume
    if (!top || weight > top.weight) top = { weight, reps: repetitions }
    const name = text(row.exercise_name)
    if (!name || !positive(rowVolume)) continue
    const exercise = exercises.get(name) || { name, volume: 0, groups: new Map() }
    exercise.volume += rowVolume
    const key = `${weight}:${repetitions}`
    const group = exercise.groups.get(key) || { weight, reps: repetitions, count: 0 }
    group.count += count
    exercise.groups.set(key, group)
    exercises.set(name, exercise)
  }
  const topLifts = [...exercises.values()].filter(exercise => positive(exercise.volume))
    .sort((a, b) => b.volume - a.volume || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 3).flatMap(exercise => {
      // Show an actual repeated set scheme, never assign the heaviest weight to
      // lighter sets or invent uniform reps for a mixed-rep exercise.
      const group = [...exercise.groups.values()].sort((a, b) => b.weight - a.weight || b.reps - a.reps)[0]
      const weight = positive(group.weight * weightFactor)
      return weight && positive(group.count) ? [{ name: exercise.name, scheme: `${group.count} × ${group.reps}`, weight: `${decimal(weight)} ${weightUnit}` }] : []
    })
  const seconds = legacy ? legacyMetric(session, rows, 'workout_duration_seconds') : positive(session?.total_seconds)
  const calories = legacy ? legacyMetric(session, rows, 'calories') : positive(session?.calories_burned)
  const hr = legacy ? legacyMetric(session, rows, 'avg_heart_rate') : positive(session?.avg_heart_rate ?? session?.avg_hr)
  const stats = [], displayVolume = positive(volume * weightFactor), topWeight = top && positive(top.weight * weightFactor)
  stat(stats, 'volume', 'Volume', displayVolume, displayVolume === null ? null : decimal(displayVolume), weightUnit)
  stat(stats, 'sets', 'Sets', sets, String(sets))
  stat(stats, 'reps', 'Reps', reps, String(reps))
  stat(stats, 'topSet', 'Top set', topWeight, topWeight ? `${decimal(topWeight)} × ${top.reps}` : null, weightUnit)
  stat(stats, 'time', 'Time', seconds, duration(seconds))
  stat(stats, 'calories', 'Calories', calories, calories === null ? null : decimal(calories, 0), 'kcal')
  stat(stats, 'avgHr', 'Avg HR', hr, hr === null ? null : decimal(hr, 0), 'bpm')
  stat(stats, 'topLifts', 'Top lifts', topLifts.length, topLifts.map(lift => `${lift.name} ${lift.scheme} @ ${lift.weight}`).join(' · '))
  const source = session || (legacy ? rows[0] : null)
  let date = activityDate(source, prefs)
  if (legacy && rows.some(row => activityDate(row, prefs) !== date)) date = null
  const model = base('lift', source, prefs, stats, 'volume', date)
  model.lift = { stats, topLifts }
  // A workout_session/set ID is not a personal_records.lift_id (legacy lifts).
  return metadata(model, { date, seconds, calories, runIds: [], liftIds: legacy ? rows.map(row => id(row.id)).filter(Boolean) : [] })
}

export function fromHybrid(runShare, liftShare, options = { showRoute: true }) {
  const run = runShare?.[META], lift = liftShare?.[META]
  if (runShare?.kind !== 'run' || liftShare?.kind !== 'lift' || !run?.date || run.date !== lift?.date
    || !runShare.run?.stats.length || !liftShare.lift?.stats.length || runShare.unit !== liftShare.unit) return null
  const seconds = run.seconds && lift.seconds ? positive(run.seconds + lift.seconds) : null
  const calories = run.calories && lift.calories ? positive(run.calories + lift.calories) : null
  const stats = []
  stat(stats, 'totalTime', 'Total time', seconds, duration(seconds))
  stat(stats, 'calories', 'Calories', calories, calories === null ? null : decimal(calories, 0), 'kcal')
  const titles = [runShare.title, liftShare.title].filter(Boolean)
  return metadata({
    kind: 'hybrid', title: titles.length ? titles.join(' + ') : null, dateLabel: runShare.dateLabel,
    handle: runShare.handle || liftShare.handle, unit: runShare.unit, stats,
    hero: stats.find(item => item.key === 'totalTime') || null,
    // Build a fresh allowlisted block when OFF, dropping extra own/hidden keys.
    // ON can only use geometry already present in the supplied ShareModel.
    run: options?.showRoute === false ? {
      stats: runShare.run.stats.map(({ key, label, value, unit }) => ({ key, label, value, ...(unit ? { unit } : {}) })),
      route: null, elevationProfile: null,
    } : runShare.run,
    lift: liftShare.lift, pr: null,
  }, { date: run.date, seconds, calories,
    runIds: Array.from(run.runIds, id).filter(Boolean), liftIds: Array.from(lift.liftIds, id).filter(Boolean) })
}

export function fromPr(prRow, activity) {
  if (!activity) return null
  const source = activity[META]
  const linked = source && ((id(prRow?.run_id) && source.runIds.includes(id(prRow.run_id)))
    || (id(prRow?.lift_id) && source.liftIds.includes(id(prRow.lift_id))))
  const label = text(prRow?.label), value = positive(prRow?.value), unit = text(prRow?.unit)
  const delta = number(prRow?.delta) ?? text(prRow?.delta)
  const pr = linked && label && value && unit ? { label, value, unit, delta } : null
  // Spread intentionally omits metadata; explicitly restore its descriptors.
  return Object.defineProperties({ ...activity, pr }, Object.fromEntries(
    Reflect.ownKeys(activity).filter(key => !Object.getOwnPropertyDescriptor(activity, key).enumerable)
      .map(key => [key, Object.getOwnPropertyDescriptor(activity, key)])
  ))
}

function dayFlag(day) {
  if (typeof day === 'boolean') return day
  if (!day || typeof day !== 'object') return null
  const result = {}
  if (dateKey(day.date)) result.date = dateKey(day.date)
  for (const key of ['hasRun', 'hasLift', 'active', 'qualifies', 'grace', 'isToday', 'isFuture']) {
    if (typeof day[key] === 'boolean') result[key] = day[key]
  }
  // The streak library's actualTypes are observed history, unlike qualifies
  // (which can also mean a planned rest/grace day).
  if (Array.isArray(day.actualTypes) && Array.from(day.actualTypes).every(type => ['run', 'lift'].includes(type))) {
    result.hasRun = day.actualTypes.includes('run')
    result.hasLift = day.actualTypes.includes('lift')
  }
  return ['hasRun', 'hasLift', 'active', 'qualifies'].some(key => key in result) ? result : null
}

function dayFlags(days, length) {
  if (!Array.isArray(days) || (length && days.length !== length)) return null
  const flags = Array.from(days, dayFlag)
  return flags.every(flag => flag !== null) ? flags : null
}

function lifetimeStats(totals) {
  // /api/milestones/streak currently supplies no lifetime totals. Accept only
  // an explicit optional lifetime payload; never infer it from days/history.
  // Counts are runs/lifts; measurements require { value, unit } so no source
  // unit is guessed. Preserve supplied units without implicit conversion.
  const stats = []
  for (const key of ['runs', 'lifts']) {
    const value = positive(totals?.[key])
    if (Number.isInteger(value)) stat(stats, key, key === 'runs' ? 'Runs' : 'Lifts', value, String(value))
  }
  for (const [key, label, units] of [['distance', 'Distance', ['mi', 'km']], ['volume', 'Volume', ['lbs', 'kg']]]) {
    const value = positive(totals?.[key]?.value), unit = totals?.[key]?.unit
    if (value !== null && units.includes(unit)) stat(stats, key, label, value, decimal(value, 2), unit)
  }
  return stats
}

export function fromStreak(streakResp) {
  const days = positive(streakResp?.current_streak ?? streakResp?.currentStreak ?? streakResp?.streak?.current ?? streakResp?.days)
  if (!Number.isInteger(days)) return null
  const supplied = positive(streakResp?.milestone_just_hit ?? streakResp?.milestone)
  const milestone = Number.isInteger(supplied) && supplied <= days ? supplied : [7, 30, 50, 100, 365].includes(days) ? days : null
  const lifetime = lifetimeStats(streakResp?.lifetime)
  return { days, week: dayFlags(streakResp?.week, 7), monthDays: dayFlags(streakResp?.monthDays), milestone,
    ...(lifetime.length ? { lifetime } : {}) }
}
