import React, { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { isLoggedIn, getUser } from './lib/auth'
import Layout from './components/Layout'

const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Landing = lazy(() => import('./pages/Landing'))
const Privacy = lazy(() => import('./pages/Privacy'))
const Terms = lazy(() => import('./pages/Terms'))
const LogRun = lazy(() => import('./pages/LogRun'))
const LogLift = lazy(() => import('./pages/LogLift'))
const Plan = lazy(() => import('./pages/Plan'))
const RunHub = lazy(() => import('./pages/RunHub'))
const Warmup = lazy(() => import('./pages/Warmup'))
const History = lazy(() => import('./pages/History'))
const Profile = lazy(() => import('./pages/Profile'))
const Settings = lazy(() => import('./pages/Settings'))
const ActiveWorkout = lazy(() => import('./pages/ActiveWorkout'))
const WorkoutSummary = lazy(() => import('./pages/WorkoutSummary'))
const ActiveRun = lazy(() => import('./pages/ActiveRun'))
const TreadmillRun = lazy(() => import('./pages/TreadmillRun'))
const DailyCheckIn = lazy(() => import('./pages/DailyCheckIn'))
const Stretches = lazy(() => import('./pages/Stretches'))
const StretchSession = lazy(() => import('./pages/StretchSession'))
const PRWall = lazy(() => import('./pages/PRWall'))
const Badges = lazy(() => import('./pages/Badges'))
const Challenges = lazy(() => import('./pages/Challenges'))
const Community = lazy(() => import('./pages/Community'))
const Journal = lazy(() => import('./pages/Journal'))
const Races = lazy(() => import('./pages/Races'))
const Gear = lazy(() => import('./pages/Gear'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const Injury = lazy(() => import('./pages/Injury'))
const WeeklyRecap = lazy(() => import('./pages/WeeklyRecap'))

const PageFallback = () => (
  <div style={{ minHeight: '100vh', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ width: 32, height: 32, border: '3px solid #EAB308', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
    <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
  </div>
)

function PrivateRoute({ children }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />

  const user = getUser()
  if (user && !user.onboarded) return <Navigate to="/onboarding" replace />

  return <Layout>{children}</Layout>
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/onboarding" element={<Onboarding />} />

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
          path="/plan"
          element={
            <PrivateRoute>
              <Plan />
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
          path="/prs"
          element={
            <PrivateRoute>
              <PRWall />
            </PrivateRoute>
          }
        />
        <Route
          path="/badges"
          element={
            <PrivateRoute>
              <Badges />
            </PrivateRoute>
          }
        />
        <Route
          path="/challenges"
          element={
            <PrivateRoute>
              <Challenges />
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
          path="/journal"
          element={
            <PrivateRoute>
              <Journal />
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
          path="/recap"
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
    </BrowserRouter>
  )
}
