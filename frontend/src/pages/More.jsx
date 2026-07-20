import { Link } from 'react-router-dom'
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Footprints,
  HeartPulse,
  Settings,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import HealthSourceManager from '../components/HealthSourceManager'
import { useReleaseNotes } from '../context/ReleaseNotesContext'
import WorkoutNotificationControl from '../components/WorkoutNotificationControl'

const sections = (t) => [
  {
    title: t('community.moreSection'),
    items: [
      { to: '/community', label: t('community.moreLabel'), sub: t('community.moreSubtitle'), icon: Users, color: '#38BDF8' },
    ],
  },
  {
    title: 'Training',
    items: [
      { to: '/gear', label: 'Forged Closet', sub: "Shoes, wear, and today's pick", icon: Footprints, color: '#94A3B8' },
      { to: '/hr-zones', label: 'HR Zones', sub: 'Calibrate your training zones', icon: HeartPulse, color: 'var(--danger)' },
      { to: '/history', label: 'History', sub: 'Runs, lifts, imports', icon: CalendarDays, color: '#3B82F6' },
      { to: '/injury', label: 'Injury Mode', sub: 'Pain, limitations, PT', icon: ShieldAlert, color: 'var(--warning)' },
    ],
  },
]

export default function More() {
  const { t } = useTranslation()
  const { unread } = useReleaseNotes()
  return (
    <div style={{ paddingBottom: 96 }}>
      <header style={{ marginBottom: 18 }}>
        <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Forged Hybrid</p>
        <h1 style={{ color: 'var(--text-primary)', fontSize: 28, fontWeight: 900, margin: 0 }}>More</h1>
      </header>

      <div style={{ display: 'grid', gap: 18 }}>
        {sections(t).map((section) => (
          <section key={section.title}>
            <h2 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
              {section.title}
            </h2>
            <div style={{ display: 'grid', gap: 8 }}>
              {section.items.map(({ to, label, sub, icon: Icon, color }) => (
                <Link
                  key={to}
                  to={to}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '40px minmax(0, 1fr) 20px',
                    alignItems: 'center',
                    gap: 12,
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 12,
                    background: 'var(--bg-card)',
                    padding: 12,
                    textDecoration: 'none',
                  }}
                >
                  <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--bg-input)', display: 'grid', placeItems: 'center' }}>
                    <Icon size={20} color={color} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', color: 'var(--text-primary)', fontWeight: 850, fontSize: 14 }}>{label}</span>
                    <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>
                  </span>
                  <ChevronRight size={18} color="var(--text-muted)" />
                </Link>
              ))}
            </div>
          </section>
        ))}
        <section>
          <h2 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            App
          </h2>
          <div style={{ display: 'grid', gap: 8 }}>
            <Link
              to="/whats-new"
              style={{ display: 'grid', gridTemplateColumns: '40px minmax(0, 1fr) 20px', alignItems: 'center', gap: 12, border: '1px solid var(--border-subtle)', borderRadius: 12, background: 'var(--bg-card)', padding: 12, textDecoration: 'none' }}
            >
              <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent-dim)', display: 'grid', placeItems: 'center' }}>
                <Sparkles size={20} color="var(--accent)" />
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontWeight: 850, fontSize: 14 }}>
                  What's New
                  {unread && <span aria-label="Unread product updates" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)', flexShrink: 0 }} />}
                </span>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {unread ? 'New improvements are ready' : 'Recent improvements and new features'}
                </span>
              </span>
              <ChevronRight size={18} color="var(--text-muted)" />
            </Link>
            <Link
              to="/settings"
              style={{ display: 'grid', gridTemplateColumns: '40px minmax(0, 1fr) 20px', alignItems: 'center', gap: 12, border: '1px solid var(--border-subtle)', borderRadius: 12, background: 'var(--bg-card)', padding: 12, textDecoration: 'none' }}
            >
              <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--bg-input)', display: 'grid', placeItems: 'center' }}>
                <Settings size={20} color="var(--text-muted)" />
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', color: 'var(--text-primary)', fontWeight: 850, fontSize: 14 }}>Settings</span>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Profile, privacy, and preferences</span>
              </span>
              <ChevronRight size={18} color="var(--text-muted)" />
            </Link>
          </div>
        </section>
        <section>
          <details>
            <summary style={{ display: 'grid', gridTemplateColumns: '40px minmax(0, 1fr) 20px', alignItems: 'center', gap: 12, border: '1px solid var(--border-subtle)', borderRadius: 12, background: 'var(--bg-card)', padding: 12, cursor: 'pointer', listStyle: 'none' }}>
              <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--bg-input)', display: 'grid', placeItems: 'center' }}>
                <HeartPulse size={20} color="var(--success)" />
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', color: 'var(--text-primary)', fontWeight: 850, fontSize: 14 }}>Data & alerts</span>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Health sync and activity notifications</span>
              </span>
              <ChevronDown size={18} color="var(--text-muted)" />
            </summary>
            <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
              <WorkoutNotificationControl />
              <HealthSourceManager />
            </div>
          </details>
        </section>
      </div>
    </div>
  )
}
