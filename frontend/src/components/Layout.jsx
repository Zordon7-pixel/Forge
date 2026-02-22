import { NavLink } from 'react-router-dom'
import { Clock3, Dumbbell, Home, User, Zap } from 'lucide-react'
import { getUser } from '../lib/auth'
import HelpDesk from './HelpDesk'
import FeedbackButton from './FeedbackButton'

export default function Layout({ children }) {
  const user = getUser()
  const firstName = user?.name?.split(' ')[0] || 'Athlete'

  const navClass = ({ isActive }) =>
    `flex flex-col items-center justify-center gap-1 text-xs ${isActive ? 'text-orange-500' : 'text-gray-500'}`

  return (
    <div className="min-h-screen bg-[#09090f] text-white">
      <div className="mx-auto w-full max-w-[480px] px-4">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-[#09090f]/90 py-4 backdrop-blur">
          <h1 className="text-lg font-bold text-orange-500">🔥 FORGE</h1>
          <p className="text-sm text-gray-300">{firstName}</p>
        </header>

        <main className="pb-20 pt-4">{children}</main>
      </div>

      <HelpDesk />
      <FeedbackButton />

      <nav className="fixed bottom-0 left-1/2 z-30 grid w-full max-w-[480px] -translate-x-1/2 grid-cols-5 border-t border-white/10 bg-[#111318] px-2 py-2">
        <NavLink to="/" className={navClass}>
          <Home size={18} />
          <span>Home</span>
        </NavLink>

        <NavLink to="/log-run" className={navClass}>
          <Zap size={18} />
          <span>Run</span>
        </NavLink>

        <NavLink to="/log-lift" className={navClass}>
          <Dumbbell size={18} />
          <span>Lift</span>
        </NavLink>

        <NavLink to="/history" className={navClass}>
          <Clock3 size={18} />
          <span>History</span>
        </NavLink>

        <NavLink to="/profile" className={navClass}>
          <User size={18} />
          <span>Profile</span>
        </NavLink>
      </nav>
    </div>
  )
}
