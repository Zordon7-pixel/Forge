import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { getUser } from '../lib/auth'
import HelpDesk from './HelpDesk'
import FeedbackButton from './FeedbackButton'

const NAV_ITEMS = [
  { to: '/', end: true,       icon: '/nav-home.png',    label: 'Home'    },
  { to: '/log-run',           icon: '/nav-run.png',     label: 'Run'     },
  { to: '/log-lift',          icon: '/nav-lift.png',    label: 'Lift'    },
  { to: '/history',           icon: '/nav-history.png', label: 'History' },
  { to: '/profile',           icon: '/nav-profile.png', label: 'Profile' },
]

export default function Layout({ children }) {
  const user = getUser()
  const firstName = user?.name?.split(' ')[0] || 'Athlete'
  const [showHelp, setShowHelp] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)

  return (
    <div className="min-h-screen bg-[#09090f] text-white">
      <div className="mx-auto w-full max-w-[480px] px-4">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-[#09090f]/90 py-4 backdrop-blur">
          <h1 className="text-lg font-bold text-violet-400">⚡ FORGE</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowFeedback(true)}
              className="text-gray-600 hover:text-gray-400 transition-colors text-xs"
              title="Send feedback"
            >💬</button>
            <button
              onClick={() => setShowHelp(true)}
              className="text-gray-600 hover:text-gray-400 transition-colors text-xs"
              title="Help & diagnostics"
            >?</button>
            <p className="text-sm text-gray-300">{firstName}</p>
          </div>
        </header>

        <main className="pb-24 pt-4">{children}</main>
      </div>

      <HelpDesk externalOpen={showHelp} onClose={() => setShowHelp(false)} />
      <FeedbackButton externalOpen={showFeedback} onClose={() => setShowFeedback(false)} />

      <nav className="fixed bottom-0 left-1/2 z-30 grid w-full max-w-[480px] -translate-x-1/2 grid-cols-5 border-t border-white/10 bg-[#111318] px-1 py-1">
        {NAV_ITEMS.map(({ to, end, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className="flex flex-col items-center justify-center"
          >
            {({ isActive }) => (
              <span className={`flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-xl transition-all duration-200 w-full ${
                isActive
                  ? 'bg-violet-600/25 ring-1 ring-violet-500/40'
                  : 'bg-transparent'
              }`}>
                <img
                  src={icon}
                  alt={label}
                  className={`w-7 h-7 object-contain transition-all duration-200 mix-blend-lighten ${
                    isActive ? 'scale-110 drop-shadow-[0_0_6px_rgba(167,139,250,0.9)]' : 'opacity-50'
                  }`}
                />
                <span className={`text-[10px] font-medium transition-colors duration-200 ${
                  isActive ? 'text-violet-300' : 'text-gray-500'
                }`}>{label}</span>
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
