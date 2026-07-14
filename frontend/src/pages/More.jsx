import { Link } from 'react-router-dom'
import {
  CalendarDays,
  ChevronRight,
  Footprints,
  HeartPulse,
  Medal,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import HealthSourceManager from '../components/HealthSourceManager'

const sections = [
  {
    title: 'Training',
    items: [
      { to: '/gear', label: 'Gear', sub: 'Shoes and mileage', icon: Footprints, color: '#94A3B8' },
      { to: '/hr-zones', label: 'HR Zones', sub: 'Calibrate your training zones', icon: HeartPulse, color: 'var(--danger)' },
      { to: '/plan', label: 'Plan', sub: 'Calendar, create/manage, races', icon: Sparkles, color: 'var(--accent)' },
      { to: '/history', label: 'History', sub: 'Runs, lifts, imports', icon: CalendarDays, color: '#3B82F6' },
      { to: '/injury', label: 'Injury Mode', sub: 'Pain, limitations, PT', icon: ShieldAlert, color: 'var(--warning)' },
    ],
  },
  {
    title: 'Progress',
    items: [
      { to: '/prs', label: 'PR Wall', sub: 'Personal records', icon: Medal, color: '#A855F7' },
    ],
  },
]

export default function More() {
  return (
    <div style={{ paddingBottom: 96 }}>
      <header style={{ marginBottom: 18 }}>
        <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Forged Hybrid</p>
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
        <section>
          <h2 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            Health & data
          </h2>
          <HealthSourceManager />
        </section>
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
