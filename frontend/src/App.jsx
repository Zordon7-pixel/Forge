import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { isLoggedIn, getUser } from './lib/auth'
import Layout from './components/Layout'
import Login from './pages/Login'
import Register from './pages/Register'
import Onboarding from './pages/Onboarding'
import Dashboard from './pages/Dashboard'
import LogRun from './pages/LogRun'
import LogLift from './pages/LogLift'
import Plan from './pages/Plan'
import History from './pages/History'
import Profile from './pages/Profile'
import ActiveWorkout from './pages/ActiveWorkout'
import WorkoutSummary from './pages/WorkoutSummary'
import ActiveRun from './pages/ActiveRun'
import TreadmillRun from './pages/TreadmillRun'
import DailyCheckIn from './pages/DailyCheckIn'

function PrivateRoute({ children }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />

  const user = getUser()
  if (user && !user.onboarded) return <Navigate to="/onboarding" replace />

  return <Layout>{children}</Layout>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/onboarding" element={<Onboarding />} />

        <Route
          path="/"
          element={
            <PrivateRoute>
              <Dashboard />
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
          path="/profile"
          element={
            <PrivateRoute>
              <Profile />
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
    </BrowserRouter>
  )
}
