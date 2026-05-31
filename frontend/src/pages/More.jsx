import { Link } from 'react-router-dom'
import {
  CalendarDays,
  ChevronRight,
  Footprints,
  Medal,
  ShieldAlert,
  Sparkles,
  Trophy,
} from 'lucide-react'

const sections = [
  {
    title: 'Training',
    items: [
      { to: '/plan', label: 'Adaptive Plan', sub: 'Weekly training direction', icon: Sparkles, color: '#EAB308' },
      { to: '/history', label: 'History', sub: 'Runs, lifts, imports', icon: CalendarDays, color: '#3B82F6' },
      { to: '/injury', label: 'Injury Mode', sub: 'Pain, limitations, PT', icon: ShieldAlert, color: '#F97316' },
      { to: '/gear', label: 'Gear', sub: 'Shoes and mileage', icon: Footprints, color: '#94A3B8' },
    ],
  },
  {
    title: 'Progress',
    items: [
      { to: '/races', label: 'Races', sub: 'Upcoming events', icon: Trophy, color: '#EAB308' },
      { to: '/prs', label: 'PR Wall', sub: 'Personal records', icon: Medal, color: '#A855F7' },
    ],
  },
]

export default function More() {
  return (
    <div style={{ paddingBottom: 96 }}>
      <header style={{ marginBottom: 18 }}>
        <p style={{ color: '#EAB308', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Forge</p>
        <h1 style={{ color: 'var(--text-primary)', fontSize: 28, fontWeight: 900, margin: 0 }}>More</h1>
      </header>

      <div style={{ display: 'grid', gap: 18 }}>
        {sections.map((section) => (
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
                  <span style={{ width: 40, height: 40, borderRadius: 10, background: `${color}1f`, display: 'grid', placeItems: 'center' }}>
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
        <Link
          to="/settings"
          style={{
            justifySelf: 'start',
            color: 'var(--text-muted)',
            fontSize: 13,
            fontWeight: 800,
            textDecoration: 'none',
          }}
        >
          Settings →
        </Link>
      </div>
    </div>
  )
}
