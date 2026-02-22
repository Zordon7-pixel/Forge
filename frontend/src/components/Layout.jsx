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

  return (
    <div className="min-h-screen bg-[#09090f] text-white">
      <div className="mx-auto w-full max-w-[480px] px-4">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-[#09090f]/90 py-4 backdrop-blur">
          <h1 className="text-lg font-bold text-violet-400">⚡ FORGE</h1>
          <p className="text-sm text-gray-300">{firstName}</p>
        </header>

        <main className="pb-24 pt-4">{children}</main>
      </div>

      <HelpDesk />
      <FeedbackButton />

      <nav className="fixed bottom-0 left-1/2 z-30 grid w-full max-w-[480px] -translate-x-1/2 grid-cols-5 border-t border-white/10 bg-[#111318] px-2 py-2">
        {NAV_ITEMS.map(({ to, end, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 text-xs transition-all ${
                isActive ? 'opacity-100 scale-110' : 'opacity-40'
              }`
            }
          >
            <img src={icon} alt={label} className="w-7 h-7 object-contain" />
            <span className="text-gray-300">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
