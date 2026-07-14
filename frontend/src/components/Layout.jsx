import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Activity, Dumbbell, HeartPulse, MessageSquarePlus, MoreHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getUser } from '../lib/auth'
import PullToRefresh from './PullToRefresh'
import FeedbackButton from './FeedbackButton'

// hex required: consumed by `${color}XX` alpha templates — do not tokenize
const NAV_ITEMS = (t) => [
  { to: '/', end: true, icon: '/nav-home.png', label: t('nav.home'), color: '#EAB308' },
  { to: '/run', label: t('nav.run'), iconComponent: Activity, color: '#EAB308' },
  { to: '/log-lift', iconComponent: Dumbbell, label: t('nav.lift'), color: '#F97316' },
  { to: '/health', label: t('nav.body'), iconComponent: HeartPulse, color: '#22C55E' },
  { to: '/more', label: 'More', iconComponent: MoreHorizontal, color: '#A855F7' },
]

function getAvatarLabel(user) {
  const name = String(user?.name || user?.full_name || '').trim()
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase()
  }
  const email = String(user?.email || '').trim()
  if (email) return email[0].toUpperCase()
  return '?'
}

export default function Layout({ children }) {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const isWorkout = location.pathname.startsWith('/workout/')
  const isImmersive = isWorkout
    || location.pathname.startsWith('/stretches/session')
    || location.pathname.startsWith('/run/active')
  const avatarLabel = getAvatarLabel(getUser())

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [location.pathname])

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', minHeight: '100dvh', '--app-bottom-nav-height': 'calc(59px + env(safe-area-inset-bottom, 0px))' }}>
      <div className={`mx-auto w-full max-w-[480px] px-3 sm:px-4 ${isImmersive ? 'pb-0' : 'pb-28'}`} style={{ maxWidth: 'min(480px, 100vw)', overflowX: 'hidden', boxSizing: 'border-box' }}>
        {!isImmersive && (
          <header
            className="sticky top-0 z-20 border-b backdrop-blur"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--bg-base) 90%, transparent)',
              paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.9rem)',
              paddingBottom: '0.75rem',
            }}
          >
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => navigate('/')}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
              aria-label="Go Home"
              className="pressable"
            >
              <img src="/icon-192.png" alt="Forged Hybrid" className="w-9 h-9 rounded-xl object-cover" />
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFeedbackOpen(true)}
                className="pressable flex h-8 w-8 items-center justify-center rounded-full transition-opacity hover:opacity-85"
                style={{ background: 'var(--bg-card)', color: 'var(--accent)', border: '1px solid var(--border-subtle)', position: 'relative', zIndex: 15 }}
                aria-label="Send feedback"
                title="Send feedback"
              >
                <MessageSquarePlus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => navigate('/profile')}
                className="pressable flex h-8 w-8 items-center justify-center rounded-full text-xs font-black transition-opacity hover:opacity-85"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid var(--border-subtle)', position: 'relative', zIndex: 15 }}
                aria-label="Go to profile"
                title="Profile"
              >
                {avatarLabel}
              </button>
            </div>
          </div>
          </header>
        )}

        <PullToRefresh>
          <main className={isImmersive ? 'pb-0 pt-0' : 'pb-24 pt-4'} style={{ minWidth: 0 }}>{children}</main>
        </PullToRefresh>
      </div>

      {!isImmersive && (
        <nav className="fixed bottom-0 left-1/2 z-30 grid w-full max-w-[480px] -translate-x-1/2 grid-cols-5 border-t px-1 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.25rem)', height: 'var(--app-bottom-nav-height)' }}>
          {NAV_ITEMS(t).map(({ to, end, icon, iconComponent: IconComponent, label, color }) => (
            <NavLink key={to} to={to} end={end} className="flex flex-col items-center justify-center"
              onClick={to === '/' ? (e) => { e.preventDefault(); navigate('/') } : undefined}>
              {({ isActive }) => (
                <span className="pressable flex flex-col items-center justify-center gap-0.5 px-1 py-1.5 rounded-xl transition-all duration-200 w-full"
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
                  <span className="text-[8px] font-medium transition-colors duration-200" style={{ color: isActive ? color : `${color}99` }}>
                    {label}
                  </span>
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      )}

      {isImmersive && (
        <button
          type="button"
          onClick={() => setFeedbackOpen(true)}
          className="pressable fixed right-3 top-3 z-40 flex h-9 w-9 items-center justify-center rounded-full shadow-lg"
          style={{ background: 'var(--bg-card)', color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}
          aria-label="Send feedback"
          title="Send feedback"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
      )}

      <FeedbackButton externalOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  )
}
