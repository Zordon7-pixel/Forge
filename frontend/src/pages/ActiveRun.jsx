import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useUnits } from '../context/UnitsContext'
import api from '../lib/api'
import { queueRequest } from '../lib/offlineQueue'
import { planSessionIdFromState, currentWeekFromState, markSessionComplete, queueSessionComplete, isRetryableCompletionFailure } from '../lib/dailyExecution'
import PostRunCheckIn from '../components/PostRunCheckIn'
import WorkoutCard from '../components/WorkoutCard'
import { calculateElevationStats } from '../utils/elevation'
import { clearActiveRunSession, elapsedFromSession, loadActiveRunSession, saveActiveRunSession } from '../lib/activeRunSession'
import { loadPostRunCheckInDraft, savePostRunCheckInDraft } from '../lib/postRunCheckInDraft'
import { buildPlannedSessionSnapshot } from '../lib/runProvenance'
import { getAuthenticatedUserId } from '../lib/auth'
import {
  canRestoreGroupRunNavigation,
  groupRunIdFromNavigationState,
  groupRunNavigationProvenance,
  groupRunWarmupState,
  isGroupRunNavigationState,
} from '../lib/groupRuns'

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation')

function haversineMiles(a, b) {
  const R = 3958.8
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

// hex required: consumed by `${color}XX` alpha templates — do not tokenize
const ZONES = [
  { key: 'Z1', min: 0.5, max: 0.6, name: 'Recovery', color: '#6B7280' },
  { key: 'Z2', min: 0.6, max: 0.7, name: 'Aerobic Base', color: '#3B82F6' },
  { key: 'Z3', min: 0.7, max: 0.8, name: 'Tempo', color: '#22C55E' },
  { key: 'Z4', min: 0.8, max: 0.9, name: 'Threshold', color: '#EAB308' },
  { key: 'Z5', min: 0.9, max: 1.01, name: 'Max Effort', color: '#EF4444' },
]

function getZone(hr, maxHr, savedZones = []) {
  if (!hr) return null
  if (Array.isArray(savedZones) && savedZones.length === 5) {
    const value = Number(hr)
    const index = savedZones.findIndex((zone, zoneIndex) => (
      value >= Number(zone.minBpm)
      && (zoneIndex === savedZones.length - 1 || value < Number(savedZones[zoneIndex + 1].minBpm))
    ))
    const resolvedIndex = index >= 0 ? index : value < Number(savedZones[0]?.minBpm) ? 0 : 4
    const savedZone = savedZones[resolvedIndex]
    return {
      key: `Z${resolvedIndex + 1}`,
      name: savedZone?.label || ZONES[resolvedIndex].name,
      color: ZONES[resolvedIndex].color,
      pct: Math.min(1, Math.max(0, value / (Number(maxHr) || 230))),
    }
  }
  if (!maxHr) return null
  const pct = hr / maxHr
  if (pct < ZONES[0].min) return { key: 'Z0', min: 0, max: ZONES[0].min, name: 'Below Z1', color: '#9CA3AF', pct }
  const zone = ZONES.find(z => pct >= z.min && pct < z.max) || ZONES[4]
  return { ...zone, pct }
}

function todayISO() {
  const now = new Date()
  const offsetDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return offsetDate.toISOString().slice(0, 10)
}

function createClientRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    const nibble = char === 'x' ? value : (value & 0x3) | 0x8
    return nibble.toString(16)
  })
}

function displayDistanceForUnit(miles, units, fmt) {
  const distance = Number(miles || 0)
  if (units === 'metric') return (distance * 1.60934).toFixed(2)
  return distance.toFixed(2)
}

function formatGapDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)))
  const minutes = Math.floor(total / 60)
  const remaining = total % 60
  if (minutes <= 0) return `${remaining}s`
  if (remaining <= 0) return `${minutes}m`
  return `${minutes}m ${remaining}s`
}

function formatElevationForUnit(feet, units) {
  if (feet === undefined || feet === null || feet === '') return '--'
  if (!Number.isFinite(Number(feet))) return '--'
  if (units === 'metric') return `${Math.round(Number(feet) * 0.3048).toLocaleString()} m`
  return `${Math.round(Number(feet)).toLocaleString()} ft`
}

function normalizePlannedRoute(value) {
  if (!value || typeof value !== 'object') return null
  const optionalNumber = (numberValue) => {
    if (numberValue === undefined || numberValue === null || numberValue === '') return null
    const number = Number(numberValue)
    return Number.isFinite(number) ? number : null
  }
  const coordinates = Array.isArray(value.coordinates)
    ? value.coordinates
      .slice(0, 800)
      .filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
      .map((point) => [Number(point[0]), Number(point[1]), optionalNumber(point[2])])
    : []
  if (coordinates.length < 2) return null
  return {
    coordinates,
    distanceMiles: optionalNumber(value.distanceMiles),
    targetDistanceMiles: optionalNumber(value.targetDistanceMiles),
    elevationGainFeet: optionalNumber(value.elevationGainFeet),
    elevationPreference: ['flat', 'balanced', 'hilly'].includes(value.elevationPreference) ? value.elevationPreference : 'balanced',
    surface: value.surface === 'trail' ? 'trail' : 'road',
  }
}

function FitMapBounds({ positions, enabled = true }) {
  const map = useMap()
  useEffect(() => {
    if (enabled && positions.length > 1) map.fitBounds(positions, { padding: [18, 18] })
  }, [enabled, map, positions])
  return null
}

function FollowCurrentLocation({ position, enabled }) {
  const map = useMap()
  useEffect(() => {
    if (enabled && position) map.panTo(position, { animate: true, duration: 0.5 })
  }, [enabled, map, position])
  return null
}

export default function ActiveRun() {
  const location = useLocation()
  const navigate = useNavigate()
  const { fmt, units } = useUnits()
  const [activeRunOwnerId] = useState(() => getAuthenticatedUserId())
  const [restoreContext] = useState(() => {
    const session = loadActiveRunSession(activeRunOwnerId)
    const locationState = location?.state && typeof location.state === 'object' && !Array.isArray(location.state)
      ? location.state
      : {}
    const incomingState = session?.navigationState || locationState
    const isGroupRunNavigation = isGroupRunNavigationState(incomingState)
    const groupRunId = groupRunIdFromNavigationState(incomingState)
    const groupRunProvenance = isGroupRunNavigation ? groupRunNavigationProvenance(incomingState) : null
    if (!session || !isGroupRunNavigation) return { session, isGroupRunNavigation, groupRunId, groupRunProvenance }

    const redactedSession = { ...session, navigationState: groupRunProvenance }
    saveActiveRunSession(redactedSession, activeRunOwnerId)
    return { session: redactedSession, isGroupRunNavigation, groupRunId, groupRunProvenance }
  })
  const restoredSession = restoreContext.session
  const [pendingPostRunDraft] = useState(() => restoredSession ? null : loadPostRunCheckInDraft())
  const incomingNavigationState = useMemo(() => (
    restoredSession?.navigationState
    || (location?.state && typeof location.state === 'object' && !Array.isArray(location.state) ? location.state : {})
  ), [location?.state, restoredSession])
  const groupRunId = restoreContext.groupRunId
  const groupRunProvenance = restoreContext.groupRunProvenance
  const isGroupRunNavigation = restoreContext.isGroupRunNavigation
  const [groupRunAuthorization, setGroupRunAuthorization] = useState(isGroupRunNavigation ? (groupRunId ? 'pending' : 'denied') : 'not_required')
  const [authorizedGroupRunState, setAuthorizedGroupRunState] = useState(null)
  const [groupRunNotice, setGroupRunNotice] = useState('')
  const navigationState = useMemo(() => {
    if (!isGroupRunNavigation) return incomingNavigationState
    if (groupRunAuthorization === 'authorized') return authorizedGroupRunState || groupRunProvenance
    if (groupRunAuthorization === 'denied') return {}
    return groupRunProvenance
  }, [authorizedGroupRunState, groupRunAuthorization, groupRunProvenance, incomingNavigationState, isGroupRunNavigation])
  const selectedCountdown = navigationState.countdown ?? 0
  const plannedRoute = useMemo(() => normalizePlannedRoute(navigationState.plannedRoute), [navigationState.plannedRoute])
  const workoutTarget = navigationState.workoutTarget || null
  const [countdownVal, setCountdownVal] = useState(selectedCountdown)
  const [countingDown, setCountingDown] = useState(!restoredSession && selectedCountdown > 0)
  const [running, setRunning] = useState(restoredSession?.phase === 'running')
  const [elapsed, setElapsed] = useState(() => elapsedFromSession(restoredSession))
  const [distanceMiles, setDistanceMiles] = useState(restoredSession?.distanceMiles || 0)
  const [gpsError, setGpsError] = useState('')
  const [gpsAvailable, setGpsAvailable] = useState(restoredSession ? restoredSession.gpsAvailable : true)
  const [manualDistance, setManualDistance] = useState(restoredSession?.manualDistance || '')
  const [awaitingManualDistance, setAwaitingManualDistance] = useState(restoredSession?.phase === 'awaiting_distance')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [restoredNotice, setRestoredNotice] = useState(Boolean(restoredSession))
  const [planProgressNotice, setPlanProgressNotice] = useState('')
  const [queuedOffline, setQueuedOffline] = useState(false)
  const [showPostCheckIn, setShowPostCheckIn] = useState(Boolean(pendingPostRunDraft))
  const [savedRunId, setSavedRunId] = useState(pendingPostRunDraft?.runId || null)
  // H5: canonical plan session carried from LogRun/Warmup so a durable run save
  // marks the exact calendar session complete. Null for ad-hoc/manual runs.
  const planSessionId = isGroupRunNavigation ? null : planSessionIdFromState(navigationState)
  const planCurrentWeek = currentWeekFromState(navigationState)
  const [savedHeatDrift, setSavedHeatDrift] = useState(pendingPostRunDraft?.heatDrift || null)
  const [mapMyRun, setMapMyRun] = useState(restoredSession?.mapMyRun ?? navigationState.mapMyRun ?? false)
  const [routeCoords, setRouteCoords] = useState(restoredSession?.routeCoords || [])
  const [runEnvironment, setRunEnvironment] = useState(restoredSession?.runEnvironment ?? navigationState.runEnvironment ?? 'outdoor')
  const [surface, setSurface] = useState(restoredSession?.surface ?? navigationState.surface ?? 'road')
  const [runType, setRunType] = useState(restoredSession?.runType ?? navigationState.runType ?? 'run')
  const [treadmillBrand, setTreadmillBrand] = useState(restoredSession?.treadmillBrand ?? navigationState.treadmillBrand ?? null)
  const [userProfile, setUserProfile] = useState(null)
  const [savedHrProfile, setSavedHrProfile] = useState(null)
  const [savedHrZones, setSavedHrZones] = useState([])
  const [liveHr, setLiveHr] = useState(null)
  const [hrLastUpdated, setHrLastUpdated] = useState(null)
  const [gpsStarted, setGpsStarted] = useState(Boolean(restoredSession?.gpsStarted || restoredSession?.routeCoords?.length))
  const [gpsGapSummary, setGpsGapSummary] = useState(null)
  const watchRef = useRef(null)
  const nativeWatchRef = useRef(false)
  const lastPointRef = useRef(restoredSession?.routeCoords?.length ? {
    lat: restoredSession.routeCoords.at(-1)[0],
    lon: restoredSession.routeCoords.at(-1)[1],
    alt: restoredSession.routeCoords.at(-1)[2],
  } : null)
  const lastFixAtRef = useRef(restoredSession?.lastFixAt || restoredSession?.savedAt || null)
  const gpsGapSecondsRef = useRef(restoredSession?.gpsGapSeconds || 0)
  const gpsGapCountRef = useRef(restoredSession?.gpsGapCount || 0)
  const discardedSegmentRef = useRef(Boolean(restoredSession?.discardedSegment))
  const startTimestampRef = useRef(restoredSession?.startedAt || null)
  const clientRunIdRef = useRef(restoredSession?.clientRunId || createClientRunId())
  const resumeAttemptedRef = useRef(false)
  const sessionStateRef = useRef(null)
  const actualElevation = useMemo(() => calculateElevationStats(routeCoords), [routeCoords])
  const plannedRoutePositions = useMemo(() => (
    plannedRoute?.coordinates?.map(([lat, lon]) => [lat, lon]) || []
  ), [plannedRoute])
  const recordedRoutePositions = useMemo(() => routeCoords.map(([lat, lon]) => [lat, lon]), [routeCoords])
  const allMapPositions = useMemo(() => (
    plannedRoutePositions.length ? [...plannedRoutePositions, ...recordedRoutePositions] : recordedRoutePositions
  ), [plannedRoutePositions, recordedRoutePositions])
  const mapBoundsPositions = plannedRoutePositions.length ? plannedRoutePositions : recordedRoutePositions
  const currentPosition = recordedRoutePositions.at(-1) || null

  sessionStateRef.current = {
    phase: running ? 'running' : awaitingManualDistance ? 'awaiting_distance' : null,
    startedAt: startTimestampRef.current,
    elapsed,
    distanceMiles,
    routeCoords,
    manualDistance,
    mapMyRun,
    gpsStarted,
    gpsAvailable,
    runEnvironment,
    surface,
    runType,
    treadmillBrand,
    clientRunId: clientRunIdRef.current,
    gpsGapSeconds: gpsGapSecondsRef.current,
    gpsGapCount: gpsGapCountRef.current,
    lastFixAt: lastFixAtRef.current,
    discardedSegment: discardedSegmentRef.current,
    navigationState,
  }

  useEffect(() => {
    if (!isGroupRunNavigation) return undefined

    let active = true
    const activeRunPath = `${location.pathname}${location.search}${location.hash}`
    navigate(activeRunPath, { replace: true, state: groupRunProvenance })

    const clearPrivateNavigation = ({ authFailure = false } = {}) => {
      if (!active) return
      setAuthorizedGroupRunState(null)
      setGroupRunAuthorization('denied')
      setGroupRunNotice('Group run details are no longer available. Your elapsed time, distance, and recorded route were kept.')
      navigate(activeRunPath, { replace: true, state: null })

      const currentSession = sessionStateRef.current
      const canPreserveStats = !authFailure
        && getAuthenticatedUserId() === activeRunOwnerId
        && ['running', 'awaiting_distance'].includes(currentSession?.phase)
      if (!canPreserveStats) {
        sessionStateRef.current = { ...currentSession, navigationState: {} }
        clearActiveRunSession()
        return
      }
      const redactedSession = { ...currentSession, navigationState: {} }
      sessionStateRef.current = redactedSession
      saveActiveRunSession(redactedSession, activeRunOwnerId)
    }

    if (!groupRunId) {
      clearPrivateNavigation()
      return () => {
        active = false
      }
    }

    api.get(`/group-runs/${encodeURIComponent(groupRunId)}`)
      .then((response) => {
        if (!active) return
        const groupRun = response.data?.group_run
        if (!canRestoreGroupRunNavigation(groupRun, groupRunId)) {
          clearPrivateNavigation()
          return
        }

        const authorizedState = groupRunWarmupState(groupRun)
        setAuthorizedGroupRunState(authorizedState)
        setGroupRunAuthorization('authorized')
        setGroupRunNotice('')
        setMapMyRun(true)
        setRunEnvironment('outdoor')
        setSurface(groupRun.route?.surface || 'road')
        setRunType(groupRun.run_type || 'social')
        const currentSession = sessionStateRef.current
        if (getAuthenticatedUserId() === activeRunOwnerId && ['running', 'awaiting_distance'].includes(currentSession?.phase)) {
          const authorizedSession = {
            ...currentSession,
            mapMyRun: true,
            runEnvironment: 'outdoor',
            surface: groupRun.route?.surface || 'road',
            runType: groupRun.run_type || 'social',
            navigationState: authorizedState,
          }
          sessionStateRef.current = authorizedSession
          saveActiveRunSession(authorizedSession, activeRunOwnerId)
        }
      })
      .catch((error) => {
        if (!active) return
        const status = Number(error?.response?.status || 0)
        if ([400, 401, 403, 404, 409, 410].includes(status)) {
          clearPrivateNavigation({ authFailure: status === 401 || status === 403 })
          return
        }
        setGroupRunAuthorization('unavailable')
        setGroupRunNotice('Group run access could not be verified. The private course is hidden; your run stats are still available.')
      })

    return () => {
      active = false
    }
  }, [activeRunOwnerId, groupRunId, groupRunProvenance, isGroupRunNavigation, location.hash, location.pathname, location.search, navigate])

  useEffect(() => {
    if (!running && !awaitingManualDistance) return
    const persist = () => {
      if (!activeRunOwnerId || getAuthenticatedUserId() !== activeRunOwnerId) {
        clearActiveRunSession()
        return
      }
      saveActiveRunSession(sessionStateRef.current, activeRunOwnerId)
    }
    persist()
    const timer = setInterval(persist, 5000)
    window.addEventListener('pagehide', persist)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', persist)
      persist()
    }
  }, [awaitingManualDistance, running])

  useEffect(() => {
    api.get('/auth/me')
      .then(r => setUserProfile(r.data?.user || null))
      .catch((err) => { console.error('[ActiveRun] Failed to load profile:', err.message) })
    api.get('/profile/hr-zones')
      .then((response) => {
        setSavedHrProfile(response.data?.profile || null)
        setSavedHrZones(Array.isArray(response.data?.zones) ? response.data.zones : [])
      })
      .catch((err) => { console.error('[ActiveRun] Failed to load HR zones:', err.message) })
  }, [])
  
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await api.get('/watch-sync/status')
        if (res.data?.avg_heart_rate) {
          setLiveHr(Number(res.data.avg_heart_rate))
          setHrLastUpdated(Date.now())
        }
      } catch (err) {
        console.error('[ActiveRun] Failed to poll watch status:', err.message)
      }
    }
    if (!running) return
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [running])

  const maxHr = savedHrProfile?.maxHr || userProfile?.max_heart_rate || (userProfile?.age ? 220 - Number(userProfile.age) : null)
  const hrZone = getZone(liveHr, maxHr, savedHrZones)

  const handlePoint = useCallback((lat, lon, alt, tsMillis) => {
    const latitude = Number(lat)
    const longitude = Number(lon)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return
    setGpsAvailable(true)
    setGpsStarted(true)

    const parsedTs = Number(tsMillis)
    const fixAt = Number.isFinite(parsedTs) ? parsedTs : Date.now()
    if (lastFixAtRef.current) {
      const gapSeconds = Math.round((fixAt - lastFixAtRef.current) / 1000)
      if (gapSeconds > 15) {
        gpsGapSecondsRef.current += gapSeconds
        gpsGapCountRef.current += 1
      }
    }
    const point = { lat: latitude, lon: longitude, alt: alt ?? null }
    if (lastPointRef.current) {
      const segment = haversineMiles(lastPointRef.current, point)
      if (segment > 0 && segment < 0.25) {
        setDistanceMiles(v => v + segment)
      } else if (segment >= 0.25) {
        discardedSegmentRef.current = true
      }
    }
    setRouteCoords((prev) => [...prev, [point.lat, point.lon, point.alt, fixAt]])
    lastPointRef.current = point
    lastFixAtRef.current = fixAt
  }, [])

  const clearActiveWatch = useCallback(async () => {
    const id = watchRef.current
    if (id == null) return
    watchRef.current = null
    const wasNative = nativeWatchRef.current
    nativeWatchRef.current = false
    if (wasNative) {
      try {
        await BackgroundGeolocation.removeWatcher({ id })
      } catch (err) {
        console.error('[ActiveRun] failed to remove native GPS watcher:', err)
      }
    } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        navigator.geolocation.clearWatch(id)
      } catch (err) {
        console.error('[ActiveRun] failed to clear web GPS watcher:', err)
      }
    }
  }, [])

  const startWebGeolocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('GPS unavailable — tracking time and effort only')
      setGpsAvailable(false)
      setGpsStarted(false)
      return false
    }

    nativeWatchRef.current = false
    watchRef.current = navigator.geolocation.watchPosition(
      pos => {
        handlePoint(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude, Date.now())
      },
      () => {
        setGpsError('GPS unavailable — tracking time and effort only')
        setGpsAvailable(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
    )
    return true
  }, [handlePoint])

  const startGPS = useCallback(async ({ resume = false } = {}) => {
    setSaveError('')
    setQueuedOffline(false)
    setGpsGapSummary(null)
    if (!resume) {
      lastFixAtRef.current = null
      gpsGapSecondsRef.current = 0
      gpsGapCountRef.current = 0
      discardedSegmentRef.current = false
    }
    if (!startTimestampRef.current) startTimestampRef.current = Date.now() - (elapsed * 1000)
    setRunning(true)
    if (!mapMyRun) {
      setGpsStarted(false)
      setGpsAvailable(false)
      setGpsError('Route recording is off — enter your distance when you finish')
      return
    }

    if (Capacitor.isNativePlatform()) {
      try {
        const id = await BackgroundGeolocation.addWatcher({
          backgroundMessage: 'Forged Hybrid is recording your run',
          backgroundTitle: 'Forged Hybrid',
          requestPermissions: true,
          stale: false,
          distanceFilter: 5,
        }, (loc, err) => {
          if (err) {
            console.error('[ActiveRun] bg-geo error', err.message)
            return
          }
          if (!loc) return
          handlePoint(loc.latitude, loc.longitude, loc.altitude, loc.time || Date.now())
        })
        watchRef.current = id
        nativeWatchRef.current = true
        return
      } catch (err) {
        console.warn('[ActiveRun] background geolocation unavailable, falling back to web GPS:', err?.message)
      }
    }

    startWebGeolocation()
  }, [elapsed, handlePoint, mapMyRun, startWebGeolocation])

  useEffect(() => {
    if (restoredSession?.phase !== 'running' || resumeAttemptedRef.current) return
    resumeAttemptedRef.current = true
    startGPS({ resume: true })
  }, [restoredSession, startGPS])

  useEffect(() => {
    if (!countingDown) return
    if (countdownVal <= 0) { setCountingDown(false); startGPS(); return }
    const t = setTimeout(() => setCountdownVal(v => v - 1), 1000)
    return () => clearTimeout(t)
  }, [countingDown, countdownVal, startGPS])

  useEffect(() => {
    if (!running) return
    const updateElapsed = () => {
      if (!startTimestampRef.current) return
      setElapsed(Math.max(0, Math.round((Date.now() - startTimestampRef.current) / 1000)))
    }
    updateElapsed()
    const t = setInterval(updateElapsed, 1000)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => () => { clearActiveWatch() }, [clearActiveWatch])

  const pace = useMemo(() => {
    const dist = gpsAvailable ? distanceMiles : Number(manualDistance || distanceMiles || 0)
    if (!dist || !elapsed) return '--'
    const secondsPerMile = elapsed / dist
    return fmt.pace(secondsPerMile)
  }, [distanceMiles, elapsed, manualDistance, gpsAvailable, fmt])

  const timeDisplay = useMemo(() => {
    const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }, [elapsed])

  const getGpsGapSummary = () => {
    if (!mapMyRun || !gpsStarted) return null
    const totalGapSeconds = gpsGapSecondsRef.current
    const discardedCatchUp = discardedSegmentRef.current
    if (totalGapSeconds <= 60 && !discardedCatchUp) return null
    return {
      seconds: totalGapSeconds,
      count: gpsGapCountRef.current,
      discardedCatchUp,
    }
  }

  const buildGpsGapNote = () => {
    const summary = getGpsGapSummary()
    if (!summary) return ''
    const pieces = []
    if (summary.seconds > 0) pieces.push(`GPS signal paused for about ${formatGapDuration(summary.seconds)} across ${summary.count} gap${summary.count === 1 ? '' : 's'}`)
    if (summary.discardedCatchUp) pieces.push('one or more large catch-up segments were excluded from distance')
    return `[gps_gap_notice:${pieces.join('; ')}. Distance/route may be incomplete.]`
  }

  const buildRunPayload = () => {
    const runSurface = runEnvironment === 'indoor' && surface === 'treadmill' ? 'treadmill' : surface
    const shouldUseManualDistance = !gpsStarted || !gpsAvailable || distanceMiles <= 0
    let finalDistance = shouldUseManualDistance ? Number(manualDistance || 0) : distanceMiles
    if (shouldUseManualDistance && units === 'metric') {
      finalDistance = fmt.milesFromKm(finalDistance)
    }
    const runDate = todayISO()
    return {
      id: clientRunIdRef.current,
      date: runDate,
      type: runType,
      run_surface: runSurface,
      surface: runSurface,
      distance_miles: finalDistance,
      duration_seconds: elapsed,
      notes: buildGpsGapNote(),
      target_zone: workoutTarget?.zone || null,
      plan_session_id: planSessionId,
      planned_session: buildPlannedSessionSnapshot({
        planSessionId,
        scheduledRun: navigationState.scheduledRun,
        workoutTarget,
        date: runDate,
      }),
      gps_available: gpsStarted && gpsAvailable,
      avg_heart_rate: liveHr || null,
      elevation_gain: actualElevation.available ? actualElevation.gainFeet : null,
      elevation_loss: actualElevation.available ? actualElevation.lossFeet : null,
      route_coords: routeCoords.map(([lat, lon, alt, time]) => ({ lat, lon, alt: alt ?? null, time: time ?? null })),
      treadmill_brand: treadmillBrand || null
    }
  }
  
  const saveRun = async () => {
    setSaveError('')
    setPlanProgressNotice('')
    setQueuedOffline(false)
    const payload = buildRunPayload()
    if (!Number.isFinite(payload.distance_miles) || payload.distance_miles <= 0) {
      setSaveError(`Enter a distance greater than 0 ${fmt.distanceLabel} before saving.`)
      return
    }

    setSaving(true)
    try {
      const res = await api.post('/runs', payload)
      const runId = res.data?.id || res.data?.run?.id
      if (runId) {
        clearActiveRunSession()
        setSavedRunId(runId)
        setAwaitingManualDistance(false)
        setSavedHeatDrift(res.data?.heatDrift || null)
        savePostRunCheckInDraft({ runId, heatDrift: res.data?.heatDrift || null, runQueued: false })
        setShowPostCheckIn(true)
        // H5: mark the scheduled calendar session complete ONLY after the run
        // durably saved. A failed completion must never roll back the run.
        if (planSessionId) {
          try {
            await markSessionComplete(planSessionId, planCurrentWeek)
          } catch (completionErr) {
            console.error('[ActiveRun] plan completion failed:', completionErr?.message || completionErr)
            if (isRetryableCompletionFailure(completionErr)) {
              try {
                await queueSessionComplete(planSessionId, planCurrentWeek)
                setPlanProgressNotice('Run saved. Plan progress is queued for sync.')
              } catch (queueErr) {
                console.error('[ActiveRun] failed to queue completion retry:', queueErr?.message || queueErr)
                setPlanProgressNotice('Run saved. Open Plan to mark this session complete.')
              }
            } else {
              setPlanProgressNotice('Run saved. Open Plan to mark this session complete.')
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to save run:', err)
      if (!err?.response || Number(err?.response?.status || 0) >= 500) {
        await queueRequest('/api/runs', 'POST', payload)
        // H5: order completion AFTER the queued run so it replays second.
        let progressNotice = ''
        if (planSessionId) {
          try {
            await queueSessionComplete(planSessionId, planCurrentWeek)
          } catch (completionErr) {
            console.error('[ActiveRun] failed to queue plan completion:', completionErr?.message || completionErr)
            progressNotice = ' Open Plan after the run syncs to mark this session complete.'
          }
        }
        setQueuedOffline(true)
        clearActiveRunSession()
        setSavedRunId(payload.id)
        setAwaitingManualDistance(false)
        savePostRunCheckInDraft({ runId: payload.id, heatDrift: null, runQueued: true })
        setShowPostCheckIn(true)
        setSaveError(`Saved offline — Forged Hybrid will sync this run when your connection is back.${progressNotice}`)
      } else {
        setSaveError(err?.response?.data?.error || 'Could not save this run. Check the details and try again.')
      }
    } finally { setSaving(false) }
  }

  const finishRun = async () => {
    setRunning(false)
    const gapSummary = getGpsGapSummary()
    if (gapSummary) setGpsGapSummary(gapSummary)
    if (!gpsStarted || !gpsAvailable || distanceMiles <= 0) {
      setManualDistance((current) => current || displayDistanceForUnit(distanceMiles, units, fmt))
      setAwaitingManualDistance(true)
      await clearActiveWatch()
      return
    }
    const savePromise = saveRun()
    await clearActiveWatch()
    await savePromise
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--bg-card)' }}>
      {countingDown && <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: '#000' }}><div className="text-center"><p className="text-9xl font-black" style={{ color: 'var(--accent)' }}>{countdownVal}</p><p className="text-xl mt-4" style={{ color: 'var(--text-muted)' }}>Get ready...</p></div></div>}
      <h2 className="t-micro mb-4">Active Run</h2>

      {plannedRoute && (
        <div className="mb-4 p-3" style={{ borderRadius: 8, background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase" style={{ color: 'var(--accent)' }}>Planned course</p>
              <p className="text-sm font-bold capitalize" style={{ color: 'var(--text-primary)' }}>
                {fmt.distance(plannedRoute.distanceMiles || plannedRoute.targetDistanceMiles, 1)} · {plannedRoute.elevationPreference === 'balanced' ? 'rolling' : plannedRoute.elevationPreference}
              </p>
            </div>
            <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{formatElevationForUnit(plannedRoute.elevationGainFeet, units)} gain</p>
          </div>
          {(workoutTarget?.pace || workoutTarget?.zone) && <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{workoutTarget?.pace ? `${workoutTarget.pace} target` : ''}{workoutTarget?.pace && workoutTarget?.zone ? ' · ' : ''}{workoutTarget?.zone || ''}</p>}
        </div>
      )}

      <div className="mb-5 text-center">
        <p className="t-micro">Elapsed</p>
        <p className="stat-num mt-1" style={{ color: 'var(--text-primary)', fontSize: 64, lineHeight: 1 }}>{timeDisplay}</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <p className="t-micro">Distance</p>
            <p className="stat-num mt-1" style={{ color: 'var(--text-primary)', fontSize: 28, lineHeight: 1.1 }}>{fmt.distance(distanceMiles, 2)}</p>
          </div>
          <div>
            <p className="t-micro">Pace</p>
            <p className="stat-num mt-1" style={{ color: 'var(--text-primary)', fontSize: 28, lineHeight: 1.1 }}>{pace}</p>
          </div>
        </div>
        {(actualElevation.available || plannedRoute) && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <p className="t-micro">Elevation gain</p>
            <p className="stat-num mt-1" style={{ color: 'var(--text-primary)', fontSize: 22, lineHeight: 1.1 }}>
              {actualElevation.available ? formatElevationForUnit(actualElevation.gainFeet, units) : 'Waiting for GPS altitude'}
            </p>
          </div>
        )}
      </div>

      <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--bg-input)' }}>
        <p className="t-micro">Heart Rate</p>
        {liveHr ? (
          <>
            <div className="flex items-center gap-2">
              <p className="stat-num" style={{ color: 'var(--text-primary)', fontSize: 24, lineHeight: 1 }}>{liveHr} bpm</p>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: hrLastUpdated && Date.now() - hrLastUpdated < 10000 ? 'var(--success)' : '#6b7280', animation: hrLastUpdated && Date.now() - hrLastUpdated < 10000 ? 'pulse 2s infinite' : 'none' }} />
              {hrLastUpdated && Date.now() - hrLastUpdated > 60000 && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>(last known)</span>}
              {hrZone && <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: `${hrZone.color}22`, color: hrZone.color }}>{hrZone.key} · {hrZone.name}</span>}
            </div>
            {hrZone && <div className="mt-3 h-2 rounded-full" style={{ background: 'var(--bg-base)' }}><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, (hrZone.pct * 100))) }%`, background: hrZone.color, transition: 'width var(--dur-med) var(--ease-out)' }} /></div>}
            <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
          </>
        ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Connect watch for live HR</p>}
      </div>

      {(!gpsAvailable || gpsError) && <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}>{gpsError || 'GPS unavailable — tracking time and effort only'}</div>}
      {restoredNotice && (
        <button type="button" onClick={() => setRestoredNotice(false)} className="w-full rounded-xl p-3 mb-3 text-left" role="status" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: 'var(--success)' }}>
          Run restored after the app reloaded. Time, distance, and recorded route were kept. Tap to dismiss.
        </button>
      )}
      {groupRunNotice && (
        <div className="rounded-xl p-3 mb-3" role="status" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
          {groupRunNotice}
        </div>
      )}
      {gpsGapSummary && (
        <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}>
          GPS paused during this run{gpsGapSummary.seconds > 0 ? ` for about ${formatGapDuration(gpsGapSummary.seconds)}` : ''}. Review the distance; Forged Hybrid saves a note that the route may be incomplete.
        </div>
      )}
      {saveError && <div className="rounded-xl p-3 mb-3" style={{ background: queuedOffline ? 'rgba(34,197,94,0.12)' : 'var(--danger-dim)', border: `1px solid ${queuedOffline ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, color: queuedOffline ? 'var(--success)' : 'var(--danger)' }}>{saveError}</div>}
      {planProgressNotice && <div className="rounded-xl p-3 mb-3" role="status" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>{planProgressNotice}</div>}

      {mapMyRun && allMapPositions.length > 0 && (
        <div className="mb-4 overflow-hidden" style={{ minHeight: 280, height: 280, borderRadius: 8, position: 'relative' }}>
          <MapContainer center={recordedRoutePositions.at(-1) || plannedRoutePositions[0]} zoom={15} style={{ height: '100%', width: '100%' }}>
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <FitMapBounds positions={mapBoundsPositions} enabled={!running || plannedRoutePositions.length > 0} />
            <FollowCurrentLocation position={currentPosition} enabled={running} />
            {plannedRoutePositions.length > 0 && <Polyline positions={plannedRoutePositions} pathOptions={{ color: '#9CA3AF', weight: 5, opacity: 0.85, dashArray: '8 8' }} />}
            {recordedRoutePositions.length > 0 && <Polyline positions={recordedRoutePositions} pathOptions={{ color: '#EAB308', weight: 5 }} />}
            {currentPosition && <CircleMarker center={currentPosition} radius={15} pathOptions={{ color: '#EAB308', fillColor: '#EAB308', fillOpacity: 0.2, weight: 2 }} />}
            {currentPosition && <CircleMarker center={currentPosition} radius={8} pathOptions={{ color: '#FFFFFF', fillColor: '#EAB308', fillOpacity: 1, weight: 3 }} />}
          </MapContainer>
          {currentPosition && (
            <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 500, display: 'flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '6px 9px', background: 'rgba(0,0,0,0.82)', color: '#FFFFFF', fontSize: 11, fontWeight: 800, pointerEvents: 'none' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#EAB308', border: '2px solid #FFFFFF' }} /> You are here
            </div>
          )}
        </div>
      )}

      {!running && !countingDown && !awaitingManualDistance && <>{plannedRoute ? <div className="w-full py-2 text-center text-sm font-semibold mb-2" style={{ borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)' }}>Planned course loaded · GPS recording on</div> : <button onClick={() => setMapMyRun(v => !v)} className="pressable w-full rounded-xl py-2 font-semibold mb-2" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}>{mapMyRun ? 'Record route: On' : 'Record route: Off'}</button>}<button disabled={groupRunAuthorization === 'pending'} onClick={() => { setCountdownVal(selectedCountdown); setCountingDown(selectedCountdown > 0); if (selectedCountdown === 0) startGPS() }} className="pressable w-full rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', opacity: groupRunAuthorization === 'pending' ? 0.55 : 1 }}>{groupRunAuthorization === 'pending' ? 'Verifying Group Run...' : 'Start Run'}</button></>}
      {running && <button onClick={finishRun} disabled={saving} className="pressable w-full rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', opacity: saving ? 0.5 : 1, minHeight: 56 }}>{saving ? 'Saving...' : 'Finish Run'}</button>}

      {awaitingManualDistance && (
        <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
          <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>How far did you run? ({fmt.distanceLabel})</p>
          {distanceMiles > 0 && <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Forged Hybrid measured {fmt.distance(distanceMiles, 2)} before GPS stopped or route recording ended. Adjust if needed.</p>}
          <input aria-label={`Run distance in ${fmt.distanceLabel}`} value={manualDistance} onChange={e => setManualDistance(e.target.value)} type="number" min="0" step="0.01" className="w-full rounded-xl px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} placeholder={fmt.distanceLabel} />
          <button onClick={saveRun} className="w-full mt-2 rounded-xl py-2 font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>Save Run</button>
        </div>
      )}

      {!running && !countingDown && savedRunId && (
        <WorkoutCard
          workoutType="Run"
          date={new Date().toISOString()}
          stats={{
            distance: fmt.distance(gpsAvailable ? distanceMiles : Number(manualDistance || 0), 2),
            pace,
            duration: timeDisplay,
          }}
          summaryText={`Forged Hybrid Run · ${fmt.distance(gpsAvailable ? distanceMiles : Number(manualDistance || 0), 2)} · ${pace} · ${timeDisplay}`}
        />
      )}

      {showPostCheckIn && savedRunId && <PostRunCheckIn runId={savedRunId} heatDrift={savedHeatDrift} onDone={(result) => {
        setShowPostCheckIn(false)
        navigate(result?.queued ? '/' : `/run/recap/${savedRunId}`, { replace: true })
      }} />}
      <Link to="/log-run" className="mt-5 inline-block text-sm" style={{ color: 'var(--text-muted)' }}>← Back</Link>
    </div>
  )
}
