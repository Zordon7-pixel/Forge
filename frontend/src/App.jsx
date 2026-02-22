import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { getUser } from './lib/auth'
import Layout from './components/Layout'
import Login from './pages/Login'
import Register from './pages/Register'
import Onboarding from './pages/Onboarding'
import Dashboard from './pages/Dashboard'
import LogRun from './pages/LogRun'
import LogLift from './pages/LogLift'
import Plan from './pages/Plan'
import History from './pages/History'

function PrivateRoute({ children }) {
  const user = getUser()
  if (!user) return <Navigate to="/login" />
  if (!user.onboarded) return <Navigate to="/onboarding" />
  return children
}

function AuthRoute({ children }) {
  return isLoggedIn() ? <Navigate to="/" /> : children
}

function isLoggedIn() { return !!getUser() }

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"      element={<Login />} />
        <Route path="/register"   element={<Register />} />
        <Route path="/onboarding" element={isLoggedIn() ? <Onboarding /> : <Navigate to="/login" />} />
        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route index         element={<Dashboard />} />
          <Route path="log-run"  element={<LogRun />} />
          <Route path="log-lift" element={<LogLift />} />
          <Route path="plan"     element={<Plan />} />
          <Route path="history"  element={<History />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
