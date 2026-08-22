import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { isLoggedIn, getUser } from './lib/auth'
import { clearToken, rememberPostAuthRedirect } from './lib/tokenStore'
import track from './lib/track'
import Layout from './components/Layout'
import { ProProvider } from './context/ProContext'
import HealthService from './services/HealthService'
import NativeNotificationService from './services/NativeNotificationService'
import SmartStartMotionService, { toManualLogRunPrefill } from './services/SmartStartMotionService'
import { normalizeForgedDeepLink } from './lib/nativeDeepLink'
import { emitAppOpenTelemetry } from './lib/appOpenTelemetry'
import api, { acceptWaiver } from './lib/api'
import ConsentWaiver from './components/ConsentWaiver'
import { markChunkBoundaryError, recoverFromChunkError } from './lib/chunkRecovery'
import { getServiceWorkerUpdateState, requestServiceWorkerUpdate, SERVICE_WORKER_UPDATE_EVENT } from './lib/serviceWorkerUpdate'
import PlanCandidateDecisionSheet from './components/PlanCandidateDecisionSheet'

function lazyWithRetry(factory) {
  return lazy(async () => {
    try {
      return await factory()
    } catch (err) {
      markChunkBoundaryError(err)
      if (recoverFromChunkError(err, { allowGenericLoadFailure: true })) {
        console.warn('[lazyWithRetry] stale chunk detected; loading the current app shell:', err?.message)
        return new Promise(() => {})
      }
      throw err
    }
  })
}

const Login = lazyWithRetry(() => import('./pages/Login'))
const Register = lazyWithRetry(() => import('./pages/Register'))
const Onboarding = lazyWithRetry(() => import('./pages/Onboarding'))
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'))
const Landing = lazyWithRetry(() => import('./pages/Landing'))
const Privacy = lazyWithRetry(() => import('./pages/Privacy'))
const Terms = lazyWithRetry(() => import('./pages/Terms'))
const LogRun = lazyWithRetry(() => import('./pages/LogRun'))
const LogLift = lazyWithRetry(() => import('./pages/LogLift'))
const Plan = lazyWithRetry(() => import('./pages/Plan'))
const PlanCatalog = lazyWithRetry(() => import('./pages/PlanCatalog'))
const RunHub = lazyWithRetry(() => import('./pages/RunHub'))
const Warmup = lazyWithRetry(() => import('./pages/Warmup'))
const Prep = lazyWithRetry(() => import('./pages/Prep'))
const History = lazyWithRetry(() => import('./pages/History'))
const Profile = lazyWithRetry(() => import('./pages/Profile'))
const Settings = lazyWithRetry(() => import('./pages/Settings'))
const HealthData = lazyWithRetry(() => import('./pages/HealthData'))
const ActiveWorkout = lazyWithRetry(() => import('./pages/ActiveWorkout'))
const WorkoutSummary = lazyWithRetry(() => import('./pages/WorkoutSummary'))
const ActiveRun = lazyWithRetry(() => import('./pages/ActiveRun'))
const RunRecap = lazyWithRetry(() => import('./pages/RunRecap'))
const TreadmillRun = lazyWithRetry(() => import('./pages/TreadmillRun'))
const DailyCheckIn = lazyWithRetry(() => import('./pages/DailyCheckIn'))
const Stretches = lazyWithRetry(() => import('./pages/Stretches'))
const StretchSession = lazyWithRetry(() => import('./pages/StretchSession'))
const PRWall = lazyWithRetry(() => import('./pages/PRWall'))
const Races = lazyWithRetry(() => import('./pages/Races'))
const Gear = lazyWithRetry(() => import('./pages/Gear'))
const HrZones = lazyWithRetry(() => import('./pages/HrZones'))
const More = lazyWithRetry(() => import('./pages/More'))
const WhatsNew = lazyWithRetry(() => import('./pages/WhatsNew'))
const Community = lazyWithRetry(() => import('./pages/Community'))
const ResetPassword = lazyWithRetry(() => import('./pages/ResetPassword'))
const Injury = lazyWithRetry(() => import('./pages/Injury'))
const WeeklyRecap = lazyWithRetry(() => import('./pages/WeeklyRecap'))
const Upgrade = lazyWithRetry(() => import('./pages/Upgrade'))

const AUTO_HEALTH_SYNC_LAST_SYNC_KEY = 'forge_auto_health_sync_last_sync_at'
const AUTO_HEALTH_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000
const AUTO_STRAVA_SYNC_LAST_SYNC_KEY = 'forge_auto_strava_sync_last_sync_at'
const AUTO_STRAVA_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000

function isNativeRuntime() {
  return typeof Capacitor !== 'undefined'
    && typeof Capacitor.isNativePlatform === 'function'
    && Capacitor.isNativePlatform()
}

function shouldAttemptSync() {
  try {
    const lastSyncAt = Number(localStorage.getItem(AUTO_HEALTH_SYNC_LAST_SYNC_KEY) || 0)
    return !lastSyncAt || Date.now() - lastSyncAt >= AUTO_HEALTH_SYNC_MIN_INTERVAL_MS
  } catch {
    return true
  }
}

function shouldAttemptStravaSync() {
  try {
    const lastSyncAt = Number(localStorage.getItem(AUTO_STRAVA_SYNC_LAST_SYNC_KEY) || 0)
    return !lastSyncAt || Date.now() - lastSyncAt >= AUTO_STRAVA_SYNC_MIN_INTERVAL_MS
  } catch {
    return true
  }
}

function AppOpenTelemetry() {
  const location = useLocation()
  const sentRef = useRef(false)

  useEffect(() => {
    if (sentRef.current || !isLoggedIn()) return undefined
    let active = true
    emitAppOpenTelemetry({ capacitor: Capacitor, capacitorApp: CapacitorApp, track })
      .then(() => {
        if (active) sentRef.current = true
      })
      .catch((error) => {
        console.warn('[AppOpenTelemetry] native identity unavailable:', error?.message || error)
      })
    return () => { active = false }
  }, [location.pathname])

  return null
}

async function syncConnectedStrava() {
  if (!shouldAttemptStravaSync()) return
  const status = await api.get('/strava/status')
  if (status.data?.connected) await api.post('/strava/sync')
  try {
    localStorage.setItem(AUTO_STRAVA_SYNC_LAST_SYNC_KEY, String(Date.now()))
  } catch (error) {
    console.warn('[AutoHealthSync] Strava sync timestamp save failed:', error?.message || error)
  }
}

function AutoHealthSync() {
  const lastForegroundSyncAtRef = useRef(0)
  const syncInFlightRef = useRef(false)

  useEffect(() => {
    if (!isNativeRuntime()) return undefined

    let cancelled = false
    const listenerHandles = []

    const sync = async ({ force = false, bypassInterval = false } = {}) => {
      if (cancelled || syncInFlightRef.current || !isLoggedIn()) return

      const now = Date.now()
      if (force && now - lastForegroundSyncAtRef.current < AUTO_HEALTH_SYNC_MIN_INTERVAL_MS) return
      if (!bypassInterval && !shouldAttemptSync()) return

      if (force) lastForegroundSyncAtRef.current = now
      syncInFlightRef.current = true
      try {
        await HealthService.syncNativeData()
      } catch (error) {
        console.warn('[AutoHealthSync] sync failed:', error?.message)
      }
      try {
        await syncConnectedStrava()
      } catch (error) {
        console.warn('[AutoHealthSync] Strava enrichment failed:', error?.message || error)
      } finally {
        syncInFlightRef.current = false
      }
    }

    // A cold launch must attempt an incremental sync even if the previous process synced recently.
    sync({ force: true, bypassInterval: true })
    const interval = window.setInterval(() => sync(), AUTO_HEALTH_SYNC_MIN_INTERVAL_MS)

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') sync({ force: true })
    }
    document.addEventListener('visibilitychange', handleVisibility)

    try {
      const appStateHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) sync({ force: true })
      })
      const resumeHandle = CapacitorApp.addListener('resume', () => sync({ force: true }))
      const workoutHandle = HealthService.addWorkoutObserverListener(() => sync({ force: true, bypassInterval: true }))

      Promise.all([appStateHandle, resumeHandle, workoutHandle].filter(Boolean))
        .then((handles) => {
          if (cancelled) {
            handles.forEach((handle) => handle?.remove?.())
            return
          }
          listenerHandles.push(...handles)
        })
        .catch((error) => {
          console.warn('[AutoHealthSync] app listener setup failed:', error?.message)
        })
    } catch (error) {
      console.warn('[AutoHealthSync] app listener setup failed:', error?.message)
    }

    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
      listenerHandles.forEach((handle) => handle?.remove?.())
    }
  }, [])

  return null
}

function SmartMissedStartHost() {
  const navigate = useNavigate()
  const location = useLocation()
  const [candidate, setCandidate] = useState(null)
  const checkInFlightRef = useRef(false)
  const lastCheckAtRef = useRef(0)

  const checkRecentMotion = useCallback(async () => {
    const blockedPath = ['/run/active', '/run/treadmill', '/warmup', '/prep', '/log-run']
      .some((path) => location.pathname.startsWith(path))
    if (
      blockedPath
      || candidate
      || checkInFlightRef.current
      || !isLoggedIn()
      || !SmartStartMotionService.isEnabled()
      || !SmartStartMotionService.isPluginAvailable()
    ) return

    const now = Date.now()
    if (now - lastCheckAtRef.current < 60_000) return
    lastCheckAtRef.current = now
    checkInFlightRef.current = true
    try {
      const result = await SmartStartMotionService.findRecentCandidate({ now: new Date(now) })
      if (result.ok && result.candidate) setCandidate(result.candidate)
    } catch (error) {
      console.warn('[SmartStart] foreground history check failed:', error?.message || error)
    } finally {
      checkInFlightRef.current = false
    }
  }, [candidate, location.pathname])

  useEffect(() => {
    if (!SmartStartMotionService.isPluginAvailable()) return undefined
    let cancelled = false
    const listenerHandles = []
    const check = () => {
      if (!cancelled) checkRecentMotion()
    }

    check()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    try {
      const appStateHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) check()
      })
      const resumeHandle = CapacitorApp.addListener('resume', check)
      Promise.all([appStateHandle, resumeHandle])
        .then((handles) => {
          if (cancelled) handles.forEach((handle) => handle?.remove?.())
          else listenerHandles.push(...handles)
        })
        .catch((error) => console.warn('[SmartStart] foreground listener setup failed:', error?.message || error))
    } catch (error) {
      console.warn('[SmartStart] foreground listener setup failed:', error?.message || error)
    }

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      listenerHandles.forEach((handle) => handle?.remove?.())
    }
  }, [checkRecentMotion])

  if (!candidate) return null
  const startedAt = new Date(candidate.startDate)
  const timeLabel = Number.isNaN(startedAt.getTime())
    ? 'Recent activity'
    : startedAt.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const distanceMiles = candidate.distanceMeters / 1609.344
  const durationMinutes = Math.round(candidate.durationSeconds / 60)

  const dismiss = () => {
    SmartStartMotionService.suppressCandidate(candidate)
    setCandidate(null)
  }

  const addToManualLog = () => {
    const smartStartPrefill = toManualLogRunPrefill(candidate)
    SmartStartMotionService.suppressCandidate(candidate)
    setCandidate(null)
    if (smartStartPrefill) navigate('/log-run?tab=manual', { state: { smartStartPrefill } })
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.74)' }}>
      <section role="dialog" aria-modal="true" aria-labelledby="smart-start-title" className="w-full max-w-sm rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <p className="text-xs font-black uppercase" style={{ color: 'var(--accent)', letterSpacing: 0.8 }}>Missed-start recovery</p>
        <h2 id="smart-start-title" className="mt-1 text-xl font-black" style={{ color: 'var(--text-primary)' }}>It looks like you ran. Add or match this workout?</h2>
        <div className="mt-4 rounded-xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{timeLabel}</p>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{distanceMiles.toFixed(2)} mi · {durationMinutes} min · {candidate.steps.toLocaleString()} steps</p>
        </div>
        <p className="mt-3 text-sm leading-5" style={{ color: 'var(--text-muted)' }}>{candidate.routeMessage}</p>
        <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>This is a non-counting summary until you review and save it. A later provider import can still match or enrich the saved workout.</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={addToManualLog} className="rounded-xl px-3 py-3 text-sm font-black" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}>Add workout</button>
          <button type="button" onClick={dismiss} className="rounded-xl px-3 py-3 text-sm font-bold" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>Not now</button>
        </div>
      </section>
    </div>
  )
}

function NativeNotificationNavigation() {
  const navigate = useNavigate()
  const handledRef = useRef(new Set())

  const findImportedRun = useCallback(async (sourceWorkoutId) => {
    const normalizedId = String(sourceWorkoutId || '').toLowerCase()
    if (!normalizedId) return null
    const { data } = await api.get('/runs')
    const runs = Array.isArray(data) ? data : data?.runs || []
    return runs.find((run) => (
      String(run.health_source || '').toLowerCase() === 'apple_health'
      && String(run.health_source_workout_id || '').toLowerCase() === normalizedId
    )) || null
  }, [])

  const handleNavigation = useCallback(async (payload) => {
    if (!payload) return
    const eventKey = payload.notificationId || `${payload.source}:${payload.sourceWorkoutId}:${payload.path}`
    if (handledRef.current.has(eventKey)) return
    handledRef.current.add(eventKey)

    const fallbackPath = payload.path || '/history'
    if (!isLoggedIn()) {
      rememberPostAuthRedirect(fallbackPath)
      navigate('/login')
      return
    }

    if (payload.source === 'apple_health' && payload.sourceWorkoutId) {
      navigate('/history')
      try {
        let run = await findImportedRun(payload.sourceWorkoutId)
        if (!run) {
          await HealthService.syncNativeData()
          run = await findImportedRun(payload.sourceWorkoutId)
        }
        if (run?.id) {
          navigate(`/run/recap/${encodeURIComponent(run.id)}`)
          return
        }
      } catch (error) {
        console.warn('[NativeNotification] workout recap resolution failed:', error?.message || error)
      }
    }

    navigate(fallbackPath)
  }, [findImportedRun, navigate])

  useEffect(() => {
    if (!NativeNotificationService.isAvailable()) return undefined
    let cancelled = false
    let listenerHandle = null

    ;(async () => {
      try {
        listenerHandle = await NativeNotificationService.addNavigationListener((payload) => {
          if (!cancelled) handleNavigation(payload)
        })
        const pending = await NativeNotificationService.consumePendingNavigation()
        if (!cancelled && pending) await handleNavigation(pending)
      } catch (error) {
        console.warn('[NativeNotification] listener setup failed:', error?.message || error)
      }
    })()

    return () => {
      cancelled = true
      listenerHandle?.remove?.()
    }
  }, [handleNavigation])

  useEffect(() => {
    if (!isNativeRuntime()) return undefined
    let cancelled = false
    let urlHandle = null

    const openDeepLink = (url) => {
      const path = normalizeForgedDeepLink(url)
      if (!path || cancelled) return
      if (!isLoggedIn()) {
        rememberPostAuthRedirect(path)
        navigate('/login')
        return
      }
      navigate(path)
    }

    ;(async () => {
      try {
        urlHandle = await CapacitorApp.addListener('appUrlOpen', ({ url }) => openDeepLink(url))
        const launch = await CapacitorApp.getLaunchUrl()
        if (launch?.url) openDeepLink(launch.url)
      } catch (error) {
        console.warn('[NativeDeepLink] listener setup failed:', error?.message || error)
      }
    })()

    return () => {
      cancelled = true
      urlHandle?.remove?.()
    }
  }, [navigate])

  return null
}

const PageFallback = () => (
  <div style={{
    minHeight: '100vh',
    background: '#000',
    color: '#E5E7EB',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  }}>
    <div style={{ width: 32, height: 32, border: '3px solid #EAB308', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
    <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#9CA3AF' }}>
      Loading Forged Hybrid
    </p>
    <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
  </div>
)

function PrivateRoute({ children }) {
  const location = useLocation()
  if (!isLoggedIn()) {
    rememberPostAuthRedirect(`${location.pathname}${location.search}`)
    return <Navigate to="/login" replace />
  }

  const user = getUser()
  if (user && !user.onboarded) {
    rememberPostAuthRedirect(`${location.pathname}${location.search}`)
  }

  return (
    <WaiverGate>
      {user && !user.onboarded ? <Navigate to="/onboarding" replace /> : <Layout>{children}</Layout>}
    </WaiverGate>
  )
}

function WaiverGate({ children }) {
  const [checking, setChecking] = useState(true)
  const [showWaiver, setShowWaiver] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    api.get('/auth/me')
      .then(({ data }) => {
        if (!active) return
        setShowWaiver(data?.user?.waiver_current === false)
      })
      .catch((err) => {
        console.error('[WaiverGate] /me check failed:', err)
        if (active) setShowWaiver(true)
      })
      .finally(() => {
        if (active) setChecking(false)
      })

    return () => { active = false }
  }, [])

  if (checking) return <PageFallback />

  if (showWaiver) {
    return (
      <>
        <ConsentWaiver
          loading={saving}
          onAgree={async (version) => {
            setSaving(true)
            try {
              await acceptWaiver(version)
              setShowWaiver(false)
            } finally {
              setSaving(false)
            }
          }}
          onCancel={() => {
            clearToken()
            window.location.href = '/login'
          }}
        />
      </>
    )
  }

  return children
}

function ServiceWorkerUpdateNotice() {
  const [updateState, setUpdateState] = useState(() => getServiceWorkerUpdateState())

  useEffect(() => {
    const onUpdateState = (event) => setUpdateState(event.detail || getServiceWorkerUpdateState())
    window.addEventListener(SERVICE_WORKER_UPDATE_EVENT, onUpdateState)
    setUpdateState(getServiceWorkerUpdateState())
    return () => window.removeEventListener(SERVICE_WORKER_UPDATE_EVENT, onUpdateState)
  }, [])

  if (!updateState.actionRequired) return null
  const activeActivity = ['active-interaction', 'active-run', 'run-handoff', 'post-run-draft'].includes(updateState.reason)
  const message = activeActivity
    ? 'Update ready. Finish your current activity, then update.'
    : 'Update ready. Save or finish what you are doing, then update.'

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="service-worker-update-notice"
      className="fixed left-1/2 z-[80] grid -translate-x-1/2 items-center gap-3 rounded-xl p-3 shadow-xl"
      style={{
        top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)',
        width: 'calc(100vw - 1.5rem)',
        maxWidth: 456,
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        background: 'var(--bg-card)',
        color: 'var(--text-primary)',
        border: '1px solid var(--accent)',
      }}
    >
      <span className="min-w-0 text-sm font-semibold leading-snug">{message}</span>
      <button
        type="button"
        onClick={() => requestServiceWorkerUpdate()}
        className="pressable whitespace-nowrap rounded-lg px-3 py-2 text-xs font-black"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
      >
        Update now
      </button>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ServiceWorkerUpdateNotice />
      <AppOpenTelemetry />
      <ProProvider>
        <AutoHealthSync />
        <SmartMissedStartHost />
        <NativeNotificationNavigation />
        <PlanCandidateDecisionSheet />
        <Suspense fallback={<PageFallback />}>
          <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/onboarding" element={isLoggedIn() ? <WaiverGate><Onboarding /></WaiverGate> : <Navigate to="/login" replace />} />

        <Route
          path="/"
          element={isLoggedIn() ? (
            <PrivateRoute>
              <Dashboard />
            </PrivateRoute>
          ) : <Landing />}
        />
        <Route
          path="/run"
          element={
            <PrivateRoute>
              <RunHub />
            </PrivateRoute>
          }
        />
        <Route
          path="/warmup"
          element={
            <PrivateRoute>
              <Warmup />
            </PrivateRoute>
          }
        />
        <Route
          path="/prep"
          element={
            <PrivateRoute>
              <Prep />
            </PrivateRoute>
          }
        />
        <Route
          path="/log-run"
          element={
            <PrivateRoute>
              <LogRun />
            </PrivateRoute>
          }
        />
        <Route
          path="/log-lift"
          element={
            <PrivateRoute>
              <LogLift />
            </PrivateRoute>
          }
        />
        <Route
          path="/run/treadmill"
          element={
            <PrivateRoute>
              <TreadmillRun />
            </PrivateRoute>
          }
        />
        <Route
          path="/checkin"
          element={
            <PrivateRoute>
              <DailyCheckIn />
            </PrivateRoute>
          }
        />
        <Route
          path="/run/active"
          element={
            <PrivateRoute>
              <ActiveRun />
            </PrivateRoute>
          }
        />
        <Route
          path="/run/recap/:id"
          element={
            <PrivateRoute>
              <RunRecap />
            </PrivateRoute>
          }
        />
        <Route
          path="/plan"
          element={
            <PrivateRoute>
              <Plan />
            </PrivateRoute>
          }
        />
        <Route
          path="/plan-catalog"
          element={
            <PrivateRoute>
              <PlanCatalog />
            </PrivateRoute>
          }
        />
        <Route
          path="/history"
          element={
            <PrivateRoute>
              <History />
            </PrivateRoute>
          }
        />
        <Route
          path="/races"
          element={
            <PrivateRoute>
              <Races />
            </PrivateRoute>
          }
        />
        <Route
          path="/gear"
          element={
            <PrivateRoute>
              <Gear />
            </PrivateRoute>
          }
        />
        <Route
          path="/hr-zones"
          element={
            <PrivateRoute>
              <HrZones />
            </PrivateRoute>
          }
        />
        <Route
          path="/prs"
          element={
            <PrivateRoute>
              <PRWall />
            </PrivateRoute>
          }
        />
        <Route
          path="/more"
          element={
            <PrivateRoute>
              <More />
            </PrivateRoute>
          }
        />
        <Route
          path="/whats-new"
          element={
            <PrivateRoute>
              <WhatsNew />
            </PrivateRoute>
          }
        />
        <Route
          path="/community"
          element={
            <PrivateRoute>
              <Community />
            </PrivateRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <PrivateRoute>
              <Profile />
            </PrivateRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <PrivateRoute>
              <Settings />
            </PrivateRoute>
          }
        />
        <Route
          path="/health"
          element={
            <PrivateRoute>
              <HealthData />
            </PrivateRoute>
          }
        />
        <Route
          path="/stretches"
          element={
            <PrivateRoute>
              <Stretches />
            </PrivateRoute>
          }
        />
        <Route
          path="/stretches/session"
          element={
            <PrivateRoute>
              <StretchSession />
            </PrivateRoute>
          }
        />
        <Route
          path="/injury"
          element={
            <PrivateRoute>
              <Injury />
            </PrivateRoute>
          }
        />
        <Route
          path="/upgrade"
          element={
            <PrivateRoute>
              <Upgrade />
            </PrivateRoute>
          }
        />
        <Route
          path="/recap"
          element={
            <PrivateRoute>
              <WeeklyRecap />
            </PrivateRoute>
          }
        />
        <Route
          path="/recap/weekly"
          element={
            <PrivateRoute>
              <WeeklyRecap />
            </PrivateRoute>
          }
        />
        <Route
          path="/workout/active/:id"
          element={
            <PrivateRoute>
              <ActiveWorkout />
            </PrivateRoute>
          }
        />
        <Route
          path="/workout/summary/:id"
          element={
            <PrivateRoute>
              <WorkoutSummary />
            </PrivateRoute>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ProProvider>
    </BrowserRouter>
  )
}
