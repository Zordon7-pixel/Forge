import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CircleMarker, MapContainer, Polyline, TileLayer, useMapEvents } from 'react-leaflet'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { LocateFixed, MapPinned, Pause, Play } from 'lucide-react'
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
import { resolveRunCompletion, RUN_PROVENANCE } from '../lib/runCompletionPolicy'
import { getAuthenticatedUserId } from '../lib/auth'
import { ZONE_HEAT_PALETTE } from '../lib/athleteLanguage'
import { buildLiveActivityStart, buildLiveActivityUpdate } from '../lib/liveActivityState'
import LiveActivityService from '../services/LiveActivityService'
import {
  requestNativeRunLocation,
  requestWebRunLocation,
  RUN_LOCATION_STATUS,
  runLocationErrorStatus,
  runLocationStatusMessage,
} from '../lib/runLocationAccess'
import {
  canRestoreGroupRunNavigation,
  groupRunIdFromNavigationState,
  groupRunNavigationProvenance,
  groupRunWarmupState,
  isGroupRunNavigationState,
} from '../lib/groupRuns'
import {
  ACTIVE_RUN_MAP_LAYOUTS,
  activeRunBackDecision,
  activeRunMapCommand,
  loadActiveRunMapLayout,
  normalizeMapPosition,
  resolveActiveRunReturnTarget,
  saveActiveRunMapLayout,
  shouldProtectActiveRunNavigation,
  validMapPositions,
} from '../lib/activeRunControls'

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation')
const LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 10_000

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

const ZONES = [
  { key: 'Z1', min: 0.5, max: 0.6, name: 'Recovery' },
  { key: 'Z2', min: 0.6, max: 0.7, name: 'Aerobic Base' },
  { key: 'Z3', min: 0.7, max: 0.8, name: 'Tempo' },
  { key: 'Z4', min: 0.8, max: 0.9, name: 'Threshold' },
  { key: 'Z5', min: 0.9, max: 1.01, name: 'Max Effort' },
].map((zone, index) => ({ ...zone, ...ZONE_HEAT_PALETTE[index] }))

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
      textColor: ZONES[resolvedIndex].textColor || ZONES[resolvedIndex].color,
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
      .map((point) => {
        const position = normalizeMapPosition(point)
        return position ? [...position, optionalNumber(point[2])] : null
      })
      .filter(Boolean)
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

function MapViewController({
  command,
  followPaused,
  onFollowPaused,
  recenterToken,
  reduceMotion,
}) {
  const map = useMapEvents({
    dragstart: () => {
      if (command.type === 'follow') onFollowPaused()
    },
  })

  useEffect(() => {
    map.invalidateSize({ animate: false })
    if (command.type === 'fit') {
      if (command.positions.length === 1) map.setView(command.positions[0], 15, { animate: false })
      else if (command.positions.length > 1) map.fitBounds(command.positions, { padding: [24, 24], animate: !reduceMotion })
    }
    if (command.type === 'follow' && !followPaused) {
      map.panTo(command.position, { animate: !reduceMotion, duration: reduceMotion ? 0 : 0.35 })
    }
  }, [command, followPaused, map, recenterToken, reduceMotion])
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
  const [countingDown, setCountingDown] = useState(false)
  const [running, setRunning] = useState(restoredSession?.phase === 'running')
  const [pausedRun, setPausedRun] = useState(restoredSession?.phase === 'paused')
  const [elapsed, setElapsed] = useState(() => elapsedFromSession(restoredSession))
  const [distanceMiles, setDistanceMiles] = useState(restoredSession?.distanceMiles || 0)
  const [gpsError, setGpsError] = useState('')
  const [gpsAvailable, setGpsAvailable] = useState(restoredSession ? restoredSession.gpsAvailable : true)
  const [locationStatus, setLocationStatus] = useState(() => (
    restoredSession?.gpsStarted ? RUN_LOCATION_STATUS.READY : RUN_LOCATION_STATUS.IDLE
  ))
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
  const [mapMyRun, setMapMyRun] = useState(restoredSession?.mapMyRun ?? true)
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
  const [mapLayout, setMapLayout] = useState(() => loadActiveRunMapLayout())
  const [followPaused, setFollowPaused] = useState(false)
  const [recenterToken, setRecenterToken] = useState(0)
  const [backWarningOpen, setBackWarningOpen] = useState(false)
  const reduceMotion = useMemo(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ), [])
  const activeRunReturnTarget = useMemo(() => (
    resolveActiveRunReturnTarget(incomingNavigationState.activeRunReturnTo)
  ), [incomingNavigationState.activeRunReturnTo])
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
  const pausedDurationMsRef = useRef(restoredSession?.pausedDurationMs || 0)
  const pauseStartedAtRef = useRef(restoredSession?.pauseStartedAt || null)
  const clientRunIdRef = useRef(restoredSession?.clientRunId || createClientRunId())
  const resumeAttemptedRef = useRef(false)
  const sessionStateRef = useRef(null)
  const liveActivityAttributesRef = useRef(null)
  const liveActivityContentRef = useRef(null)
  const historyGuardRef = useRef(false)
  const pendingExitRef = useRef(null)
  const navigationProtectedRef = useRef(false)
  const activeRunReturnTargetRef = useRef(activeRunReturnTarget)
  const requestBackRef = useRef(null)
  const actualElevation = useMemo(() => calculateElevationStats(routeCoords), [routeCoords])
  const plannedRoutePositions = useMemo(() => (
    validMapPositions(plannedRoute?.coordinates)
  ), [plannedRoute])
  const recordedRoutePositions = useMemo(() => validMapPositions(routeCoords), [routeCoords])
  const allMapPositions = useMemo(() => (
    [...recordedRoutePositions, ...plannedRoutePositions]
  ), [plannedRoutePositions, recordedRoutePositions])
  const currentPosition = recordedRoutePositions.at(-1) || null
  const currentAccuracy = routeCoords.at(-1)?.[4]
  const mapCommand = useMemo(() => (
    activeRunMapCommand(mapLayout, { recordedPositions: recordedRoutePositions, plannedPositions: plannedRoutePositions })
  ), [mapLayout, plannedRoutePositions, recordedRoutePositions])
  const mapControlsMeaningful = mapMyRun && (running || pausedRun || allMapPositions.length > 0)
  const navigationProtected = shouldProtectActiveRunNavigation({
    running,
    paused: pausedRun,
    countingDown,
    awaitingManualDistance,
    saving,
  })

  navigationProtectedRef.current = navigationProtected
  activeRunReturnTargetRef.current = activeRunReturnTarget

  const exitActiveRun = useCallback((to, options = { replace: true }) => {
    pendingExitRef.current = { to, options }
    if (historyGuardRef.current && typeof window !== 'undefined') {
      window.history.back()
      return
    }
    pendingExitRef.current = null
    navigate(to, options)
  }, [navigate])

  const requestBack = useCallback(() => {
    const decision = activeRunBackDecision({
      protectedNavigation: navigationProtectedRef.current,
      returnTarget: activeRunReturnTargetRef.current,
    })
    if (decision.action === 'block') {
      setBackWarningOpen(true)
      return
    }
    exitActiveRun(decision.to, decision.options)
  }, [exitActiveRun])

  requestBackRef.current = requestBack

  sessionStateRef.current = {
    phase: running ? 'running' : pausedRun ? 'paused' : awaitingManualDistance ? 'awaiting_distance' : null,
    startedAt: startTimestampRef.current,
    elapsed,
    pausedDurationMs: pausedDurationMsRef.current,
    pauseStartedAt: pauseStartedAtRef.current,
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
    if (typeof window === 'undefined') return undefined
    let active = true

    const pushGuard = () => {
      try {
        window.history.pushState(
          { ...(window.history.state || {}), forgeActiveRunGuard: true },
          '',
          `${window.location.pathname}${window.location.search}${window.location.hash}`,
        )
        historyGuardRef.current = true
      } catch (error) {
        historyGuardRef.current = false
        console.warn('[ActiveRun] navigation guard setup failed:', error?.message || error)
      }
    }

    const onPopState = () => {
      if (!active || !historyGuardRef.current) return
      historyGuardRef.current = false
      const pendingExit = pendingExitRef.current
      pendingExitRef.current = null
      const decision = activeRunBackDecision({
        pendingExit,
        protectedNavigation: navigationProtectedRef.current,
        returnTarget: activeRunReturnTargetRef.current,
      })
      if (decision.action === 'block') {
        setBackWarningOpen(true)
        pushGuard()
        return
      }
      navigate(decision.to, decision.options)
    }

    pushGuard()
    window.addEventListener('popstate', onPopState)
    return () => {
      active = false
      window.removeEventListener('popstate', onPopState)
    }
  }, [navigate])

  useEffect(() => {
    if (!navigationProtected || typeof window === 'undefined') return undefined
    const warnBeforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [navigationProtected])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined
    let active = true
    let listenerHandle = null
    CapacitorApp.addListener('backButton', () => requestBackRef.current?.())
      .then((handle) => {
        if (!active) handle?.remove?.()
        else listenerHandle = handle
      })
      .catch((error) => {
        console.warn('[ActiveRun] native back listener setup failed:', error?.message || error)
      })
    return () => {
      active = false
      listenerHandle?.remove?.()
    }
  }, [])

  useEffect(() => {
    if (!isGroupRunNavigation) return undefined

    let active = true
    let verificationInFlight = false
    let authorizationRevoked = false
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
        && ['running', 'paused', 'awaiting_distance'].includes(currentSession?.phase)
      if (!canPreserveStats) {
        sessionStateRef.current = { ...currentSession, navigationState: {} }
        void LiveActivityService.end()
        clearActiveRunSession()
        return
      }
      const redactedSession = { ...currentSession, navigationState: {} }
      sessionStateRef.current = redactedSession
      saveActiveRunSession(redactedSession, activeRunOwnerId)
    }

    const hidePrivateNavigation = () => {
      if (!active || authorizationRevoked) return
      setAuthorizedGroupRunState(null)
      setGroupRunAuthorization('unavailable')
      setGroupRunNotice('Group run access could not be verified. The private course is hidden; your run stats are still available.')
      navigate(activeRunPath, { replace: true, state: groupRunProvenance })
      const currentSession = sessionStateRef.current
      if (getAuthenticatedUserId() === activeRunOwnerId && ['running', 'paused', 'awaiting_distance'].includes(currentSession?.phase)) {
        const redactedSession = { ...currentSession, navigationState: groupRunProvenance }
        sessionStateRef.current = redactedSession
        saveActiveRunSession(redactedSession, activeRunOwnerId)
      }
    }

    if (!groupRunId) {
      clearPrivateNavigation()
      return () => {
        active = false
      }
    }

    const verifyAccess = async () => {
      if (!active || authorizationRevoked || verificationInFlight) return
      verificationInFlight = true
      try {
        const response = await api.get(`/group-runs/${encodeURIComponent(groupRunId)}`)
        if (!active) return
        const groupRun = response.data?.group_run
        if (!canRestoreGroupRunNavigation(groupRun, groupRunId)) {
          authorizationRevoked = true
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
        if (getAuthenticatedUserId() === activeRunOwnerId && ['running', 'paused', 'awaiting_distance'].includes(currentSession?.phase)) {
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
      } catch (error) {
        if (!active) return
        const status = Number(error?.response?.status || 0)
        if ([400, 401, 403, 404, 409, 410].includes(status)) {
          authorizationRevoked = true
          clearPrivateNavigation({ authFailure: status === 401 || status === 403 })
          return
        }
        hidePrivateNavigation()
      } finally {
        verificationInFlight = false
      }
    }

    verifyAccess()
    const verificationTimer = window.setInterval(verifyAccess, 60_000)
    const verifyWhenVisible = () => {
      if (document.visibilityState === 'visible') verifyAccess()
    }
    document.addEventListener('visibilitychange', verifyWhenVisible)

    return () => {
      active = false
      window.clearInterval(verificationTimer)
      document.removeEventListener('visibilitychange', verifyWhenVisible)
    }
  }, [activeRunOwnerId, groupRunId, groupRunProvenance, isGroupRunNavigation, location.hash, location.pathname, location.search, navigate])

  useEffect(() => {
    if (!running && !pausedRun && !awaitingManualDistance) return
    const persist = () => {
      if (!activeRunOwnerId || getAuthenticatedUserId() !== activeRunOwnerId) {
        void LiveActivityService.end()
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
  }, [awaitingManualDistance, pausedRun, running])

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

  liveActivityAttributesRef.current = buildLiveActivityStart({
    clientRunId: clientRunIdRef.current,
    startedAt: startTimestampRef.current,
    units,
    runType,
    workoutTarget,
  })
  liveActivityContentRef.current = buildLiveActivityUpdate({
    startedAt: startTimestampRef.current,
    elapsed,
    distanceMiles,
    units,
    liveHr,
    hrLastUpdated,
    hrZone,
    mapMyRun,
    gpsStarted,
    gpsAvailable,
    currentAccuracy,
    paused: pausedRun,
  })

  useEffect(() => {
    if ((!running && !pausedRun) || !LiveActivityService.isPluginAvailable()) return undefined
    let cancelled = false
    let operationInFlight = false
    const listenerHandles = []

    const syncLiveActivity = async () => {
      if (cancelled || operationInFlight) return
      operationInFlight = true
      try {
        if (!await LiveActivityService.isAvailable()) return
        const currentActivityId = await LiveActivityService.currentActivityId()
        if (cancelled) return
        if (currentActivityId) {
          await LiveActivityService.update(liveActivityContentRef.current)
        } else {
          await LiveActivityService.start(liveActivityAttributesRef.current, liveActivityContentRef.current)
        }
      } finally {
        operationInFlight = false
      }
    }

    syncLiveActivity()
    const interval = window.setInterval(syncLiveActivity, LIVE_ACTIVITY_UPDATE_INTERVAL_MS)
    Promise.all([
      CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) syncLiveActivity()
      }),
      CapacitorApp.addListener('resume', syncLiveActivity),
    ]).then((handles) => {
      if (cancelled) handles.forEach((handle) => handle?.remove?.())
      else listenerHandles.push(...handles)
    }).catch((error) => {
      console.warn('[LiveActivity] resume listener setup failed:', error?.message || error)
    })

    return () => {
      cancelled = true
      window.clearInterval(interval)
      listenerHandles.forEach((handle) => handle?.remove?.())
    }
  }, [pausedRun, running])

  useEffect(() => {
    if (!['running', 'paused', 'awaiting_distance'].includes(restoredSession?.phase)) void LiveActivityService.end()
  }, [restoredSession?.phase])

  const handlePoint = useCallback((lat, lon, alt, accuracy, timestamp) => {
    const latitude = Number(lat)
    const longitude = Number(lon)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return
    setGpsAvailable(true)
    setGpsStarted(true)
    setLocationStatus(RUN_LOCATION_STATUS.READY)
    setGpsError('')

    const parsedTimestamp = Number(timestamp)
    const parsedDateTimestamp = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN
    const fixAt = Number.isFinite(parsedTimestamp)
      ? parsedTimestamp
      : Number.isFinite(parsedDateTimestamp) ? parsedDateTimestamp : Date.now()
    if (lastFixAtRef.current) {
      const gapSeconds = Math.round((fixAt - lastFixAtRef.current) / 1000)
      if (gapSeconds > 15) {
        gpsGapSecondsRef.current += gapSeconds
        gpsGapCountRef.current += 1
      }
    }
    const parsedAltitude = alt === null || alt === undefined || alt === '' ? Number.NaN : Number(alt)
    const parsedAccuracy = accuracy === null || accuracy === undefined || accuracy === '' ? Number.NaN : Number(accuracy)
    const point = {
      lat: latitude,
      lon: longitude,
      alt: Number.isFinite(parsedAltitude) && parsedAltitude >= -2000 && parsedAltitude <= 100000 ? parsedAltitude : null,
      accuracy: Number.isFinite(parsedAccuracy) && parsedAccuracy >= 0 && parsedAccuracy <= 10000 ? parsedAccuracy : null,
    }
    if (lastPointRef.current) {
      const segment = haversineMiles(lastPointRef.current, point)
      if (segment > 0 && segment < 0.25) {
        setDistanceMiles(v => v + segment)
      } else if (segment >= 0.25) {
        discardedSegmentRef.current = true
      }
    }
    setRouteCoords((prev) => [...prev, [point.lat, point.lon, point.alt, fixAt, point.accuracy]])
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

  const setLocationFailure = useCallback((status) => {
    const normalizedStatus = Object.values(RUN_LOCATION_STATUS).includes(status)
      ? status
      : RUN_LOCATION_STATUS.UNAVAILABLE
    setLocationStatus(normalizedStatus)
    setGpsAvailable(false)
    setGpsStarted(false)
    setGpsError(runLocationStatusMessage(normalizedStatus))
  }, [])

  const startWebGeolocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationFailure(RUN_LOCATION_STATUS.UNAVAILABLE)
      return false
    }

    nativeWatchRef.current = false
    watchRef.current = navigator.geolocation.watchPosition(
      pos => {
        handlePoint(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude, pos.coords.accuracy, Date.now())
      },
      (error) => {
        setLocationFailure(runLocationErrorStatus(error))
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
    )
    return true
  }, [handlePoint, setLocationFailure])

  const activateRunTimer = useCallback(() => {
    const now = Date.now()
    if (!startTimestampRef.current) startTimestampRef.current = now
    if (pauseStartedAtRef.current) {
      pausedDurationMsRef.current += Math.max(0, now - pauseStartedAtRef.current)
      pauseStartedAtRef.current = null
    }
    setPausedRun(false)
    setRunning(true)
  }, [])

  const startGPS = useCallback(async ({ resume = false, recordRoute = mapMyRun } = {}) => {
    setSaveError('')
    setQueuedOffline(false)
    setGpsGapSummary(null)
    if (!resume) {
      lastFixAtRef.current = null
      gpsGapSecondsRef.current = 0
      gpsGapCountRef.current = 0
      discardedSegmentRef.current = false
    }
    if (!recordRoute) {
      setGpsStarted(false)
      setGpsAvailable(false)
      setLocationStatus(RUN_LOCATION_STATUS.IDLE)
      setGpsError('Route recording is off — enter your distance when you finish')
      activateRunTimer()
      return
    }

    setGpsError('')
    setGpsAvailable(true)
    setLocationStatus(RUN_LOCATION_STATUS.CHECKING)
    if (Capacitor.isNativePlatform()) {
      try {
        let registrationError = null
        const id = await BackgroundGeolocation.addWatcher({
          backgroundMessage: 'Forged Hybrid is recording your run',
          backgroundTitle: 'Forged Hybrid',
          requestPermissions: true,
          stale: false,
          distanceFilter: 5,
        }, (loc, err) => {
          if (err) {
            console.error('[ActiveRun] bg-geo error', err.message)
            registrationError = err
            setLocationFailure(runLocationErrorStatus(err))
            return
          }
          if (!loc) return
          handlePoint(loc.latitude, loc.longitude, loc.altitude, loc.accuracy, loc.time || Date.now())
        })
        if (registrationError) {
          await BackgroundGeolocation.removeWatcher({ id }).catch((error) => {
            console.error('[ActiveRun] failed to remove rejected native GPS watcher:', error?.message || error)
          })
          return
        }
        watchRef.current = id
        nativeWatchRef.current = true
        activateRunTimer()
        return
      } catch (err) {
        console.warn('[ActiveRun] background geolocation unavailable, falling back to web GPS:', err?.message)
      }
    }

    if (startWebGeolocation()) activateRunTimer()
  }, [activateRunTimer, handlePoint, mapMyRun, setLocationFailure, startWebGeolocation])

  const checkLocationBeforeRun = useCallback(async () => {
    setLocationStatus(RUN_LOCATION_STATUS.CHECKING)
    setGpsError('')
    const result = Capacitor.isNativePlatform()
      ? await requestNativeRunLocation(BackgroundGeolocation)
      : await requestWebRunLocation(typeof navigator === 'undefined' ? null : navigator.geolocation)
    if (result.status !== RUN_LOCATION_STATUS.READY) {
      setLocationFailure(result.status)
      return false
    }
    setLocationStatus(RUN_LOCATION_STATUS.READY)
    setGpsAvailable(true)
    setGpsError('')
    return true
  }, [setLocationFailure])

  const launchRun = useCallback(async ({ recordRoute = mapMyRun } = {}) => {
    setCountdownVal(selectedCountdown)
    if (selectedCountdown > 0) {
      setCountingDown(true)
      return
    }
    await startGPS({ recordRoute })
  }, [mapMyRun, selectedCountdown, startGPS])

  const beginRun = useCallback(async () => {
    if (mapMyRun && !await checkLocationBeforeRun()) return
    await launchRun({ recordRoute: mapMyRun })
  }, [checkLocationBeforeRun, launchRun, mapMyRun])

  const continueWithoutRoute = useCallback(async () => {
    setMapMyRun(false)
    setGpsStarted(false)
    setGpsAvailable(false)
    setLocationStatus(RUN_LOCATION_STATUS.IDLE)
    setGpsError('Route recording is off — enter your distance when you finish')
    await launchRun({ recordRoute: false })
  }, [launchRun])

  const openLocationSettings = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) return
    try {
      await BackgroundGeolocation.openSettings()
    } catch (error) {
      console.error('[ActiveRun] failed to open location settings:', error?.message || error)
    }
  }, [])

  useEffect(() => {
    const command = new URLSearchParams(location.search).get('command')
    if (restoredSession?.phase !== 'running' || resumeAttemptedRef.current || command === 'pause') return
    resumeAttemptedRef.current = true
    startGPS({ resume: true })
  }, [location.search, restoredSession, startGPS])

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
      setElapsed(Math.max(0, Math.round((Date.now() - startTimestampRef.current - pausedDurationMsRef.current) / 1000)))
    }
    updateElapsed()
    const t = setInterval(updateElapsed, 1000)
    return () => clearInterval(t)
  }, [running])

  const pauseRun = useCallback(async () => {
    if (!running || !startTimestampRef.current) return
    const now = Date.now()
    const frozenElapsed = Math.max(0, Math.round((now - startTimestampRef.current - pausedDurationMsRef.current) / 1000))
    setElapsed(frozenElapsed)
    pauseStartedAtRef.current = now
    lastPointRef.current = null
    lastFixAtRef.current = null
    setRunning(false)
    setPausedRun(true)
    await clearActiveWatch()
  }, [clearActiveWatch, running])

  const resumeRun = useCallback(async () => {
    if (!pausedRun) return
    await startGPS({ resume: true })
  }, [pausedRun, startGPS])

  useEffect(() => {
    const command = new URLSearchParams(location.search).get('command')
    if (command === 'pause' && running) void pauseRun()
    else if (command === 'resume' && pausedRun) void resumeRun()
    else if (!['pause', 'resume'].includes(command)) return
    navigate(location.pathname, { replace: true, state: location.state })
  }, [location.pathname, location.search, location.state, navigate, pauseRun, pausedRun, resumeRun, running])

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
    const startedAt = Number(startTimestampRef.current || 0)
    const endedAt = startedAt > 0 ? Math.max(startedAt, startedAt + (elapsed * 1000)) : 0
    return {
      id: clientRunIdRef.current,
      date: runDate,
      type: runType,
      run_surface: runSurface,
      surface: runSurface,
      distance_miles: finalDistance,
      duration_seconds: elapsed,
      activity_start_at: startedAt > 0 ? new Date(startedAt).toISOString() : null,
      activity_end_at: endedAt > 0 ? new Date(endedAt).toISOString() : null,
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
      route_coords: routeCoords.map(([lat, lon, alt, time, accuracy]) => ({
        lat,
        lon,
        alt: alt ?? null,
        time: time ?? null,
        accuracy: accuracy ?? null,
      })),
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
        const completion = resolveRunCompletion({
          provenance: RUN_PROVENANCE.LIVE_TRACKED,
          runId,
        })
        clearActiveRunSession()
        setSavedRunId(runId)
        setAwaitingManualDistance(false)
        setSavedHeatDrift(res.data?.heatDrift || null)
        savePostRunCheckInDraft({
          runId,
          heatDrift: res.data?.heatDrift || null,
          runQueued: false,
          provenance: completion.provenance,
        })
        setShowPostCheckIn(completion.requiresImmediateCheckIn)
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
        const completion = resolveRunCompletion({
          provenance: RUN_PROVENANCE.LIVE_TRACKED,
          runId: payload.id,
          queued: true,
        })
        savePostRunCheckInDraft({
          runId: payload.id,
          heatDrift: null,
          runQueued: true,
          provenance: completion.provenance,
        })
        setShowPostCheckIn(completion.requiresImmediateCheckIn)
        setSaveError(`Saved offline — Forged Hybrid will sync this run when your connection is back.${progressNotice}`)
      } else {
        setSaveError(err?.response?.data?.error || 'Could not save this run. Check the details and try again.')
      }
    } finally { setSaving(false) }
  }

  const finishRun = async () => {
    setRunning(false)
    setPausedRun(false)
    pauseStartedAtRef.current = null
    await LiveActivityService.end()
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

  const selectMapLayout = (layout) => {
    const selectedLayout = saveActiveRunMapLayout(layout)
    setMapLayout(selectedLayout)
    if (selectedLayout === 'follow') {
      setFollowPaused(false)
      setRecenterToken((value) => value + 1)
    }
  }

  return (
    <div
      className="rounded-2xl p-4"
      style={{
        background: 'var(--bg-card)',
        minHeight: '100dvh',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        boxSizing: 'border-box',
      }}
    >
      {countingDown && <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: '#000' }}><div className="text-center"><p className="text-9xl font-black" style={{ color: 'var(--accent)' }}>{countdownVal}</p><p className="text-xl mt-4" style={{ color: 'var(--text-muted)' }}>Get ready...</p></div></div>}
      {backWarningOpen && (
        <div className="fixed inset-0 z-[60] grid place-items-center p-5" style={{ background: 'rgba(0,0,0,0.82)' }}>
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="active-run-back-warning-title"
            data-testid="active-run-navigation-warning"
            className="w-full max-w-sm rounded-2xl p-5"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: '0 18px 60px rgba(0,0,0,0.5)' }}
          >
            <h2 id="active-run-back-warning-title" className="text-xl font-black" style={{ color: 'var(--text-primary)' }}>
              {running || pausedRun || countingDown ? (pausedRun ? 'Run is paused' : 'Run still recording') : 'Run not saved yet'}
            </h2>
            <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
              {running || pausedRun || countingDown
                ? 'Stay on this screen to finish safely. Back will not stop or discard your recording.'
                : 'Enter and save the distance before leaving so this run is not lost.'}
            </p>
            <button
              type="button"
              autoFocus
              onClick={() => setBackWarningOpen(false)}
              className="pressable mt-5 w-full rounded-xl px-4 py-3 font-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ minHeight: 48, background: 'var(--accent)', color: 'var(--on-accent)', outlineColor: 'var(--accent)' }}
            >
              {running || pausedRun || countingDown ? (pausedRun ? 'Keep run paused' : 'Keep recording') : 'Continue run'}
            </button>
          </section>
        </div>
      )}
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
              {hrZone && <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: `${hrZone.color}22`, color: hrZone.textColor || hrZone.color }}>{hrZone.key} · {hrZone.name}</span>}
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

      {mapControlsMeaningful && (
        <div className="mb-3" data-testid="active-run-map-layout">
          <div
            role="group"
            aria-label="Live map view"
            className="grid grid-cols-3 gap-1 rounded-xl p-1"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
          >
            {ACTIVE_RUN_MAP_LAYOUTS.map((layout) => {
              const label = layout[0].toUpperCase() + layout.slice(1)
              const selected = mapLayout === layout
              return (
                <button
                  key={layout}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${label} live map view`}
                  data-testid={`map-layout-${layout}`}
                  onClick={() => selectMapLayout(layout)}
                  className="pressable rounded-lg px-2 py-2 text-sm font-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{
                    minHeight: 44,
                    background: selected ? 'var(--accent)' : 'transparent',
                    color: selected ? 'var(--on-accent)' : 'var(--text-primary)',
                    outlineColor: 'var(--accent)',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {mapMyRun && mapLayout !== 'stats' && allMapPositions.length > 0 && (
        <div
          className="mb-2 overflow-hidden"
          data-testid="active-run-map"
          style={{ minHeight: 210, height: 'clamp(210px, 34vh, 280px)', borderRadius: 10, position: 'relative', border: '1px solid var(--border-subtle)' }}
        >
          <MapContainer center={currentPosition || plannedRoutePositions[0]} zoom={15} style={{ height: '100%', width: '100%' }}>
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapViewController
              command={mapCommand}
              followPaused={followPaused}
              onFollowPaused={() => setFollowPaused(true)}
              recenterToken={recenterToken}
              reduceMotion={reduceMotion}
            />
            {plannedRoutePositions.length > 0 && <Polyline positions={plannedRoutePositions} pathOptions={{ color: '#D1D5DB', weight: 4, opacity: 0.9, dashArray: '7 9' }} />}
            {recordedRoutePositions.length > 0 && <Polyline positions={recordedRoutePositions} pathOptions={{ color: '#EAB308', weight: 6, opacity: 1 }} />}
            {currentPosition && <CircleMarker center={currentPosition} radius={15} pathOptions={{ color: '#EAB308', fillColor: '#EAB308', fillOpacity: 0.2, weight: 2 }} />}
            {currentPosition && <CircleMarker center={currentPosition} radius={8} pathOptions={{ color: '#FFFFFF', fillColor: '#EAB308', fillOpacity: 1, weight: 3 }} />}
          </MapContainer>
          {currentPosition && !followPaused && mapLayout === 'follow' && (
            <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 500, display: 'flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '7px 10px', background: 'rgba(0,0,0,0.86)', color: '#FFFFFF', fontSize: 11, fontWeight: 800, pointerEvents: 'none' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#EAB308', border: '2px solid #FFFFFF' }} /> You are here
            </div>
          )}
          {currentPosition && followPaused && mapLayout === 'follow' && (
            <button
              type="button"
              aria-label="Recenter map on current position"
              data-testid="map-recenter"
              onClick={() => {
                setFollowPaused(false)
                setRecenterToken((value) => value + 1)
              }}
              className="pressable focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ position: 'absolute', top: 10, right: 10, zIndex: 500, minWidth: 44, minHeight: 44, borderRadius: 999, padding: '0 12px', border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.9)', color: '#FFFFFF', fontSize: 12, fontWeight: 900, display: 'flex', alignItems: 'center', gap: 7, outlineColor: 'var(--accent)' }}
            >
              <LocateFixed size={17} aria-hidden="true" /> Recenter
            </button>
          )}
        </div>
      )}
      {mapMyRun && mapLayout !== 'stats' && running && allMapPositions.length === 0 && (
        <div className="mb-3 grid min-h-[150px] place-items-center rounded-xl p-5 text-center" data-testid="active-run-map-empty" role="status" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
          <div>
            <MapPinned size={28} aria-hidden="true" style={{ color: 'var(--accent)', margin: '0 auto 8px' }} />
            <p className="font-black" style={{ color: 'var(--text-primary)' }}>Acquiring GPS</p>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>The live route appears after the first valid location.</p>
          </div>
        </div>
      )}
      {mapControlsMeaningful && mapLayout === 'stats' && (
        <div className="mb-3 rounded-xl p-3 text-sm font-semibold" data-testid="active-run-map-hidden" role="status" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
          Map hidden for Stats view · GPS recording and run metrics continue.
        </div>
      )}
      {mapMyRun && !running && !pausedRun && !countingDown && !awaitingManualDistance && !plannedRoute && (
        <div className="mb-3 flex min-h-[92px] items-center gap-3 rounded-xl p-3" data-testid="active-run-map-ready" role="status" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
          <MapPinned size={26} aria-hidden="true" style={{ color: 'var(--accent)', flex: '0 0 auto' }} />
          <div>
            <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{locationStatus === RUN_LOCATION_STATUS.READY ? 'Location connected' : 'Live map ready'}</p>
            <p className="mt-1 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{runLocationStatusMessage(locationStatus)}</p>
          </div>
        </div>
      )}
      {allMapPositions.length > 0 && mapLayout !== 'stats' && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] font-bold" aria-label="Map route legend" style={{ color: 'var(--text-muted)' }}>
          {recordedRoutePositions.length > 0 && <span><span aria-hidden="true" style={{ display: 'inline-block', width: 18, borderTop: '4px solid #EAB308', marginRight: 6, verticalAlign: 'middle' }} />Recorded</span>}
          {plannedRoutePositions.length > 0 && <span><span aria-hidden="true" style={{ display: 'inline-block', width: 18, borderTop: '3px dashed #D1D5DB', marginRight: 6, verticalAlign: 'middle' }} />Planned</span>}
        </div>
      )}

      {!running && !pausedRun && !countingDown && !awaitingManualDistance && (
        <div>
          {plannedRoute && <div className="w-full py-2 text-center text-sm font-semibold mb-2" style={{ borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)' }}>Planned course loaded · GPS recording ready</div>}
          <div className="rounded-xl p-3 mb-3" role="status" data-testid="run-location-preflight" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Your iPhone records the route. Keep your watch running too — Forged Hybrid will combine the data after sync.</p>
            <p className="text-xs mt-1" style={{ color: locationStatus === RUN_LOCATION_STATUS.DENIED ? 'var(--danger)' : 'var(--text-muted)' }}>{runLocationStatusMessage(locationStatus)}</p>
            {locationStatus === RUN_LOCATION_STATUS.DENIED && Capacitor.isNativePlatform() && (
              <button type="button" onClick={openLocationSettings} className="pressable mt-3 rounded-lg border px-3 py-2 text-xs font-black" style={{ minHeight: 44, borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                Open iPhone Settings
              </button>
            )}
          </div>
          <button type="button" disabled={groupRunAuthorization === 'pending' || locationStatus === RUN_LOCATION_STATUS.CHECKING} onClick={beginRun} className="pressable w-full rounded-xl py-3 font-black" style={{ minHeight: 52, background: 'var(--accent)', color: 'var(--on-accent)', opacity: groupRunAuthorization === 'pending' || locationStatus === RUN_LOCATION_STATUS.CHECKING ? 0.55 : 1 }}>{groupRunAuthorization === 'pending' ? 'Verifying Group Run...' : locationStatus === RUN_LOCATION_STATUS.CHECKING ? 'Checking Location...' : locationStatus === RUN_LOCATION_STATUS.DENIED ? 'Try Location Again' : 'Start Run'}</button>
          {[RUN_LOCATION_STATUS.DENIED, RUN_LOCATION_STATUS.TIMEOUT, RUN_LOCATION_STATUS.UNAVAILABLE].includes(locationStatus) && (
            <button type="button" onClick={continueWithoutRoute} className="pressable mt-2 w-full rounded-xl border px-3 py-3 text-sm font-black" style={{ minHeight: 48, borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
              Continue without route
            </button>
          )}
        </div>
      )}
      {running && mapMyRun && gpsStarted && gpsAvailable && locationStatus === RUN_LOCATION_STATUS.READY && (
        <div className="rounded-xl p-3 mb-3 text-sm font-semibold" role="status" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: 'var(--success)' }}>
          Route connected · iPhone recording in the background{currentAccuracy !== null && currentAccuracy !== undefined && Number.isFinite(Number(currentAccuracy)) ? ` · GPS ±${Math.round(Number(currentAccuracy))} m` : ''}
        </div>
      )}
      {running && mapMyRun && !gpsStarted && (
        <div className="rounded-xl p-3 mb-3 text-sm font-semibold" role="status" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}>
          Connecting to GPS · route tracking is not confirmed yet
        </div>
      )}
      {pausedRun && (
        <div className="rounded-xl p-3 mb-3 text-sm font-semibold" role="status" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}>
          Run paused · timer and GPS recording are stopped
        </div>
      )}
      {(running || pausedRun) && (
        <div className="grid grid-cols-2 gap-2" data-testid="active-run-controls">
          <button type="button" data-testid={pausedRun ? 'resume-run' : 'pause-run'} onClick={pausedRun ? resumeRun : pauseRun} disabled={saving} className="pressable flex items-center justify-center gap-2 rounded-xl border py-3 font-black" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', minHeight: 56 }}>
            {pausedRun ? <Play size={19} aria-hidden="true" /> : <Pause size={19} aria-hidden="true" />}
            {pausedRun ? 'Resume' : 'Pause'}
          </button>
          <button type="button" data-testid="finish-run" onClick={finishRun} disabled={saving} className="pressable rounded-xl py-3 font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', opacity: saving ? 0.5 : 1, minHeight: 56 }}>{saving ? 'Saving...' : 'Finish Run'}</button>
        </div>
      )}

      {awaitingManualDistance && (
        <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)' }}>
          <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>How far did you run? ({fmt.distanceLabel})</p>
          {distanceMiles > 0 && <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Forged Hybrid measured {fmt.distance(distanceMiles, 2)} before GPS stopped or route recording ended. Adjust if needed.</p>}
          <input aria-label={`Run distance in ${fmt.distanceLabel}`} value={manualDistance} onChange={e => setManualDistance(e.target.value)} type="number" min="0" step="0.01" className="w-full rounded-xl px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} placeholder={fmt.distanceLabel} />
          <button type="button" onClick={saveRun} className="w-full mt-2 rounded-xl py-2 font-semibold" style={{ minHeight: 44, background: 'var(--accent)', color: 'var(--on-accent)' }}>Save Run</button>
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
        exitActiveRun(result?.queued ? '/' : `/run/recap/${savedRunId}`)
      }} />}
      <button
        type="button"
        data-testid="active-run-back"
        onClick={requestBack}
        className="pressable mt-4 flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ minHeight: 48, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', outlineColor: 'var(--accent)' }}
      >
        ← Back
      </button>
    </div>
  )
}
