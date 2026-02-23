import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Trophy, SlidersHorizontal } from 'lucide-react'
import { getUser } from '../lib/auth'
import { useTheme } from '../context/ThemeContext'
import HelpDesk from './HelpDesk'
import FeedbackButton from './FeedbackButton'

const NAV_ITEMS = [
  { to: '/', end: true, icon: '/nav-home.png', label: 'Home' },
  { to: '/log-run', icon: '/nav-run.png', label: 'Run' },
  { to: '/log-lift', icon: '/nav-lift.png', label: 'Lift' },
  { to: '/prs', label: 'PR Wall', iconComponent: Trophy },
  { to: '/settings', label: 'Settings', iconComponent: SlidersHorizontal },
  { to: '/history', icon: '/nav-history.png', label: 'History' },
  { to: '/profile', icon: '/nav-profile.png', label: 'Profile' },
]

export default function Layout({ children }) {
  const user = getUser()
  const firstName = user?.name?.split(' ')[0] || 'Athlete'
  const [showHelp, setShowHelp] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const { theme, toggle } = useTheme()
  const location = useLocation()
  const isWorkout = location.pathname.startsWith('/workout/')

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="mx-auto w-full max-w-[480px] px-4">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b py-4 backdrop-blur" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-base) 90%, transparent)' }}>
          <img src="/icon-192.png" alt="FORGE" className="w-9 h-9 rounded-xl object-cover" />
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
        </header>

        <main className="pb-24 pt-4">{children}</main>
      </div>

      <HelpDesk externalOpen={showHelp} onClose={() => setShowHelp(false)} />
      <FeedbackButton externalOpen={showFeedback} onClose={() => setShowFeedback(false)} />

      {!isWorkout && (
        <nav className="fixed bottom-0 left-1/2 z-30 grid w-full max-w-[480px] -translate-x-1/2 grid-cols-7 border-t px-1 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          {NAV_ITEMS.map(({ to, end, icon, iconComponent: IconComponent, label }) => (
            <NavLink key={to} to={to} end={end} className="flex flex-col items-center justify-center">
              {({ isActive }) => (
                <span className="flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-xl transition-all duration-200 w-full" style={isActive ? { background: 'rgba(234,179,8,0.18)', boxShadow: '0 0 0 1px rgba(234,179,8,0.3)' } : {}}>
                  {IconComponent ? (
                    <IconComponent
                      className={`w-6 h-6 transition-all duration-200 ${isActive ? 'scale-110' : 'opacity-50'}`}
                      style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}
                    />
                  ) : (
                    <img
                      src={icon}
                      alt={label}
                      className={`w-7 h-7 object-contain transition-all duration-200 mix-blend-lighten ${isActive ? 'scale-110' : 'opacity-50'}`}
                      style={isActive ? { filter: 'drop-shadow(0 0 6px rgba(234,179,8,0.8)) sepia(1) saturate(5) hue-rotate(0deg)' } : {}}
                    />
                  )}
                  <span className="text-[10px] font-medium transition-colors duration-200" style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}>
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
