const KM_TO_MILES = 0.621371
const METERS_TO_MILES = 0.000621371

function parseCsvLine(line) {
  const out = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const next = line[i + 1]

    if (char === '"' && inQuotes && next === '"') {
      current += '"'
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (char === ',' && !inQuotes) {
      out.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  out.push(current.trim())
  return out
}

function parseCsvRows(csvText) {
  const lines = String(csvText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0)

  if (!lines.length) return []

  const headers = parseCsvLine(lines[0]).map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line)
    const row = {}
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? ''
    })
    return row
  })
}

function asNumber(value) {
  if (value === null || value === undefined) return null
  const cleaned = String(value).replace(/[^0-9.+-]/g, '')
  if (!cleaned) return null
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

function parseDurationToSeconds(value) {
  if (value === null || value === undefined) return 0
  const raw = String(value).trim()
  if (!raw) return 0

  if (/^\d+$/.test(raw)) return Number(raw)

  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(raw)) {
    const parts = raw.split(':').map((n) => Number(n))
    if (parts.length === 2) return (parts[0] * 60) + parts[1]
    if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2]
  }

  const h = /(\d+)\s*h/i.exec(raw)?.[1]
  const m = /(\d+)\s*m/i.exec(raw)?.[1]
  const s = /(\d+)\s*s/i.exec(raw)?.[1]
  if (h || m || s) {
    return (Number(h || 0) * 3600) + (Number(m || 0) * 60) + Number(s || 0)
  }

  return 0
}

function normalizeDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function normalizeType(rawType) {
  const value = String(rawType || '').toLowerCase()
  if (!value) return 'run'
  if (value.includes('run') || value.includes('jog') || value.includes('walk')) return 'run'
  if (value.includes('strength') || value.includes('lift') || value.includes('weight')) return 'strength'
  return value
}

function parseDistanceMiles(value, assume = 'miles') {
  if (!value) return 0
  const text = String(value).toLowerCase()
  const num = asNumber(text)
  if (!num) return 0

  if (text.includes('km')) return num * KM_TO_MILES
  if (text.includes('m ') || text.endsWith('m')) return num * METERS_TO_MILES
  if (text.includes('mi')) return num
  if (assume === 'km') return num * KM_TO_MILES
  return num
}

export function parseGarminCSV(csvText) {
  const rows = parseCsvRows(csvText)
  return rows.map((row) => {
    const date = normalizeDate(row.date || row.Date || row['Start Time'] || row.start_time)
    const distanceKm = asNumber(row.distance || row['distance (km)'] || row['Distance (km)'] || row.Distance)
    const durationSeconds = parseDurationToSeconds(row.duration || row.Duration || row['Elapsed Time'] || row.elapsed_time)
    const avgHeartRate = asNumber(row.avg_heart_rate || row['Average Heart Rate'] || row['Avg Heart Rate'])
    const type = normalizeType(row.type || row.Type || row.activity_type || row['Activity Type'])

    return {
      date,
      type,
      distanceMiles: Number(((distanceKm || 0) * KM_TO_MILES).toFixed(3)),
      durationSeconds,
      avgHeartRate: avgHeartRate || null,
      source: 'garmin_csv',
    }
  }).filter((row) => row.date && (row.distanceMiles > 0 || row.durationSeconds > 0))
}

export function parseStravaCSV(csvText) {
  const rows = parseCsvRows(csvText)
  return rows.map((row) => {
    const date = normalizeDate(row['Activity Date'] || row.date || row.Date)
    const type = normalizeType(row['Activity Type'] || row.type || row.Type)
    const distanceMiles = parseDistanceMiles(row.Distance || row.distance, 'miles')
    const durationSeconds = parseDurationToSeconds(row['Elapsed Time'] || row.duration || row.Duration)
    const avgHeartRate = asNumber(row['Average Heart Rate'] || row.avg_heart_rate || row['Avg Heart Rate'])

    return {
      date,
      type,
      distanceMiles: Number(distanceMiles.toFixed(3)),
      durationSeconds,
      avgHeartRate: avgHeartRate || null,
      source: 'strava_csv',
    }
  }).filter((row) => row.date && (row.distanceMiles > 0 || row.durationSeconds > 0))
}

async function requestPermission(health, permissions) {
  if (typeof health.requestAuthorization === 'function') {
    return health.requestAuthorization({ read: permissions })
  }
  if (typeof health.requestPermissions === 'function') {
    return health.requestPermissions({ read: permissions })
  }
  if (typeof health.requestPermission === 'function') {
    return health.requestPermission(permissions)
  }
  throw new Error('Apple Health permissions API not available in this Safari version.')
}

async function fetchWorkouts(health, startDate, endDate) {
  if (typeof health.queryWorkouts === 'function') {
    return health.queryWorkouts({ startDate, endDate })
  }
  if (typeof health.getWorkouts === 'function') {
    return health.getWorkouts({ startDate, endDate })
  }
  if (typeof health.readWorkouts === 'function') {
    return health.readWorkouts({ startDate, endDate })
  }
  if (typeof health.querySamples === 'function') {
    const result = await health.querySamples({ type: 'workout', startDate, endDate })
    return result?.samples || result || []
  }
  throw new Error('Apple Health workout query API is not available.')
}

export async function requestAppleHealth() {
  if (typeof navigator === 'undefined' || !navigator.health) {
    throw new Error('Apple Health import is only supported in Safari on iOS 16+.')
  }

  const health = navigator.health
  const endDate = new Date()
  const startDate = new Date(endDate.getTime() - (30 * 24 * 60 * 60 * 1000))
  const permissions = ['steps', 'distance', 'heartRate', 'workouts']

  await requestPermission(health, permissions)
  const workouts = await fetchWorkouts(health, startDate, endDate)

  return (Array.isArray(workouts) ? workouts : []).map((workout) => {
    const activityType = normalizeType(workout.activityType || workout.type || workout.workoutActivityType)
    const distanceMiles = Number(parseDistanceMiles(
      workout.distanceMiles
      || workout.distance
      || workout.totalDistance
      || workout.distance_miles
      || 0,
      workout.distanceUnit === 'km' ? 'km' : 'miles'
    ).toFixed(3))
    const durationSeconds = parseDurationToSeconds(
      workout.durationSeconds
      || workout.duration
      || workout.elapsedTime
      || workout.elapsed_time
      || 0
    )
    const avgHeartRate = asNumber(
      workout.avgHeartRate
      || workout.averageHeartRate
      || workout.avg_heart_rate
      || null
    )

    return {
      date: normalizeDate(workout.startDate || workout.date || workout.start || workout.endDate) || new Date().toISOString().slice(0, 10),
      type: activityType,
      distanceMiles,
      durationSeconds,
      avgHeartRate: avgHeartRate || null,
      source: 'apple_health',
      raw: workout,
    }
  }).filter((item) => item.distanceMiles > 0 || item.durationSeconds > 0)
}
