import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Trophy, Users, Activity } from 'lucide-react'
import { isLoggedIn } from '../lib/auth'
import { useTheme } from '../context/ThemeContext'
import HelpDesk from './HelpDesk'
import FeedbackButton from './FeedbackButton'
import PullToRefresh from './PullToRefresh'
import api from '../lib/api'

const NAV_ITEMS = [
  { to: '/run', label: 'Run', iconComponent: Activity, color: '#EAB308' },
  { to: '/', end: true, icon: '/nav-home.png', label: 'Home', color: '#EAB308' },
  { to: '/log-lift', icon: '/nav-lift.png', label: 'Lift', color: '#F97316' },
  { to: '/challenges', label: 'Challenges', iconComponent: Trophy, color: '#A855F7' },
  { to: '/community', label: 'Community', iconComponent: Users, color: '#EAB308' },
  { to: '/history', icon: '/nav-history.png', label: 'History', color: '#3B82F6' },
  { to: '/profile', icon: '/nav-profile.png', label: 'Profile', color: '#EC4899' },
]

function TrainingReadinessWidget() {
  const navigate = useNavigate()
  const [score, setScore] = useState(null)

  useEffect(() => {
    if (!isLoggedIn()) return
    let active = true

    const fetchScore = async () => {
      try {
        const [statsRes, checkinRes] = await Promise.all([
          api.get('/auth/me/stats').catch(() => ({ data: null })),
          api.get('/checkin/today').catch(() => ({ data: null })),
        ])

        if (!active) return
        const stats = statsRes?.data
        const checkedIn = Boolean(checkinRes?.data)

        if (!stats || !checkedIn) {
          setScore(null)
          return
        }

        const weekMiles = Number(stats?.week?.miles || 0)
        const totalMiles = Number(stats?.all?.miles || 0)
        const trendWeeks = Array.isArray(stats?.weeklyTrend)
          ? stats.weeklyTrend.filter(w => Number(w.miles) > 0).length
          : 0
        const avgWeekly = trendWeeks > 0 ? totalMiles / trendWeeks : 0

        let readinessScore = 50
        const streakBonus = Math.min(Number(stats?.streak || 0) * 4, 20)
        readinessScore += streakBonus

        if (avgWeekly > 0) {
          const ratio = weekMiles / avgWeekly
          if (ratio < 0.5) readinessScore += 15
          else if (ratio > 1.3) readinessScore -= 15
        }

        setScore(Math.max(1, Math.min(99, Math.round(readinessScore))))
      } catch {
        if (active) setScore(null)
      }
    }

    fetchScore()
    return () => {
      active = false
    }
  }, [])

  return (
    <button
      type="button"
      onClick={() => navigate('/checkin')}
      className="text-center"
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-input)',
        borderRadius: 10,
        padding: '4px 12px',
        minWidth: 120,
        cursor: 'pointer',
      }}
    >
      <p style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-muted)' }}>Training Readiness</p>
      {score !== null ? (
        <p style={{ fontSize: 13, fontWeight: 800, color: '#EAB308' }}>{score}</p>
      ) : (
        <div style={{ height: 3, width: 32, background: '#EAB308', margin: '3px auto 0', borderRadius: 999 }} />
      )}
    </button>
  )
}

export default function Layout({ children }) {
  const [showHelp, setShowHelp] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const { theme, toggle } = useTheme()
  const location = useLocation()
  const navigate = useNavigate()
  const isWorkout = location.pathname.startsWith('/workout/')

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="mx-auto w-full max-w-[480px] px-4">
        <header className="sticky top-0 z-20 border-b py-4 backdrop-blur" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-base) 90%, transparent)' }}>
          <div className="relative flex items-center justify-between">
            <img src="/icon-192.png" alt="FORGE" className="w-9 h-9 rounded-xl object-cover" />
            <TrainingReadinessWidget />
            <div className="flex items-center gap-3">
              <button onClick={toggle} className="transition-colors hover:opacity-80 text-xs" style={{ color: 'var(--text-muted)' }} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
                {theme === 'dark' ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                )}
              </button>
              <button onClick={() => setShowFeedback(true)} className="transition-colors hover:opacity-80" style={{ color: 'var(--text-muted)' }} title="Send feedback">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </button>
              <button onClick={() => setShowHelp(true)} className="transition-colors hover:opacity-80 text-xs font-bold" style={{ color: 'var(--text-muted)' }} title="Help & diagnostics">?</button>
            </div>
          </div>
        </header>

        <PullToRefresh>
          <main className="pb-24 pt-4">{children}</main>
        </PullToRefresh>
      </div>

      <HelpDesk externalOpen={showHelp} onClose={() => setShowHelp(false)} />
      <FeedbackButton externalOpen={showFeedback} onClose={() => setShowFeedback(false)} />

      {!isWorkout && (
        <nav className="fixed bottom-0 left-1/2 z-30 grid w-full max-w-[480px] -translate-x-1/2 grid-cols-7 border-t px-1 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          {NAV_ITEMS.map(({ to, end, icon, iconComponent: IconComponent, label, color }) => (
            <NavLink key={to} to={to} end={end} className="flex flex-col items-center justify-center"
              onClick={to === '/' ? (e) => { e.preventDefault(); navigate('/') } : undefined}>
              {({ isActive }) => (
                <span className="flex flex-col items-center justify-center gap-0.5 px-1 py-1.5 rounded-xl transition-all duration-200 w-full"
                  style={isActive ? { background: `${color}22`, boxShadow: `0 0 0 1px ${color}55` } : {}}>
                  {IconComponent ? (
                    <IconComponent
                      className={`w-5 h-5 transition-all duration-200 ${isActive ? 'scale-110' : ''}`}
                      style={{ color: isActive ? color : `${color}99` }}
                    />
                  ) : (
                    <img
                      src={icon}
                      alt={label}
                      className={`w-6 h-6 object-contain transition-all duration-200 mix-blend-lighten ${isActive ? 'scale-110' : ''}`}
                      style={{ filter: isActive ? `drop-shadow(0 0 6px ${color})` : 'none', opacity: isActive ? 1 : 0.45 }}
                    />
                  )}
                  <span className="text-[9px] font-medium transition-colors duration-200" style={{ color: isActive ? color : `${color}99` }}>
                    {label}
                  </span>
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  )
}
