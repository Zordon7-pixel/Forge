import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { Home, Plus, Calendar, History, LogOut } from 'lucide-react'
import { getUser, logout } from '../lib/auth'

export default function Layout() {
  const user = getUser()
  const navigate = useNavigate()

  function handleLogout() { logout(); navigate('/login') }

  return (
    <div className="flex flex-col min-h-screen bg-[#09090f]" style={{ paddingBottom: 'calc(64px + env(safe-area-inset-bottom))' }}>
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3 bg-[#09090f] border-b border-[#1f2028] sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <span className="text-xl">🔥</span>
          <span className="font-black text-white tracking-tight text-lg">FORGE</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-400">{user?.name}</span>
          <button onClick={handleLogout} className="text-slate-600 hover:text-slate-400 transition-colors">
            <LogOut size={16}/>
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-lg mx-auto px-4 py-4">
          <Outlet />
        </div>
      </main>

      {/* Bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-[#111318] border-t border-[#1f2028] z-20"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center justify-around max-w-lg mx-auto">
          <NavLink to="/" end className={({ isActive }) =>
            `flex flex-col items-center gap-0.5 py-3 px-4 text-xs transition-colors ${isActive ? 'text-orange-400' : 'text-slate-600'}`}>
            <Home size={22}/><span>Home</span>
          </NavLink>

          <NavLink to="/log-run" className={({ isActive }) =>
            `flex flex-col items-center gap-0.5 py-2 px-4 transition-colors ${isActive ? 'text-orange-400' : 'text-slate-600'}`}>
            <div className="w-12 h-12 bg-orange-500 rounded-full flex items-center justify-center shadow-lg shadow-orange-900/50 -mt-3">
              <Plus size={24} className="text-white"/>
            </div>
          </NavLink>

          <NavLink to="/plan" className={({ isActive }) =>
            `flex flex-col items-center gap-0.5 py-3 px-4 text-xs transition-colors ${isActive ? 'text-orange-400' : 'text-slate-600'}`}>
            <Calendar size={22}/><span>Plan</span>
          </NavLink>

          <NavLink to="/history" className={({ isActive }) =>
            `flex flex-col items-center gap-0.5 py-3 px-4 text-xs transition-colors ${isActive ? 'text-orange-400' : 'text-slate-600'}`}>
            <History size={22}/><span>History</span>
          </NavLink>
        </div>
      </nav>
    </div>
  )
}
