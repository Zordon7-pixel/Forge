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
import { normalizeForgedDeepLink } from './lib/nativeDeepLink'
import api, { acceptWaiver } from './lib/api'
import ConsentWaiver from './components/ConsentWaiver'
import { markChunkBoundaryError, recoverFromChunkError } from './lib/chunkRecovery'
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

export default function App() {
  useEffect(() => {
    track('app_open')
  }, [])

  return (
    <BrowserRouter>
      <ProProvider>
        <AutoHealthSync />
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
