import { useMemo } from 'react'
import { resolveReadiness } from '../lib/truthConsistency'

const RADIUS = 42
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function getBandColor(band) {
  if (band === 'GREEN') return 'var(--accent)'
  if (band === 'AMBER') return 'color-mix(in srgb, var(--accent) 78%, orange)'
  if (band === 'RED') return 'color-mix(in srgb, var(--text-primary) 28%, red)'
  return 'var(--text-muted)'
}

export default function ReadinessCard({ onOpenDetail, readinessState }) {
  const state = readinessState || { loading: true, error: false, locked: false, data: null }
  const readiness = state.data || {}
  const readinessTruth = resolveReadiness(readiness)
  const score = readinessTruth.score ?? 0
  const bandColor = getBandColor(readiness.band)
  const ringColor = bandColor
  const dashOffset = useMemo(() => CIRCUMFERENCE - (Math.max(0, Math.min(score, 100)) / 100) * CIRCUMFERENCE, [score])
  const drivers = Array.isArray(readiness.drivers) && readiness.drivers.length
    ? readiness.drivers.slice(0, 2).join(' ')
    : 'Recovery signals look steady.'

  if (state.loading) {
    return (
      <section className="rounded-2xl border border-subtle bg-card p-4">
        <div className="flex items-center gap-4">
          <div className="h-24 w-24 rounded-full" style={{ background: 'var(--border-subtle)' }} />
          <div className="min-w-0 flex-1">
            <div className="mb-3 h-4 w-24 rounded-full" style={{ background: 'var(--border-subtle)' }} />
            <div className="h-3 w-3/4 rounded-full" style={{ background: 'var(--border-subtle)' }} />
          </div>
        </div>
      </section>
    )
  }

  if (state.locked) {
    return (
      <section className="rounded-2xl border border-subtle bg-card p-4">
        <p className="text-sm font-black text-primary" style={{ margin: 0 }}>Recovery readiness</p>
        <p className="mt-1 text-sm text-muted" style={{ marginBottom: 0 }}>Upgrade to Forged Hybrid Pro to unlock today&apos;s readiness score.</p>
      </section>
    )
  }

  if (state.error) {
    return (
      <section className="rounded-2xl border border-subtle bg-card p-4">
        <p className="text-sm text-muted" style={{ margin: 0 }}>Couldn&apos;t load recovery readiness.</p>
      </section>
    )
  }

  if (!readinessTruth.available) {
    return (
      <section className="rounded-2xl border border-subtle bg-card p-4">
        <p className="text-sm font-black text-primary" style={{ margin: 0 }}>Recovery readiness</p>
        <p className="mt-1 text-sm text-muted" style={{ marginBottom: 0 }}>Sync Health data to unlock today&apos;s readiness score.</p>
      </section>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpenDetail}
      className="w-full rounded-2xl border border-subtle bg-card p-4 text-left"
      style={{ color: 'var(--text-primary)' }}
    >
      <style>{`
        @keyframes readinessRingFill {
          from { stroke-dashoffset: ${CIRCUMFERENCE}; }
          to { stroke-dashoffset: ${dashOffset}; }
        }
      `}</style>
      <div className="flex items-center gap-4">
        <div className="relative h-28 w-28 shrink-0">
          <svg className="h-full w-full -rotate-90" viewBox="0 0 112 112" aria-hidden="true">
            <circle cx="56" cy="56" r={RADIUS} fill="none" stroke="var(--border-subtle)" strokeWidth="9" />
            <circle
              cx="56"
              cy="56"
              r={RADIUS}
              fill="none"
              stroke={ringColor}
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              style={{ animation: 'readinessRingFill 850ms ease-out both' }}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            <span className="text-3xl font-black text-primary">{Math.round(score)}</span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase text-muted" style={{ margin: 0, letterSpacing: 0 }}>Recovery readiness</p>
          <p className="mt-1 text-2xl font-black" style={{ color: bandColor, marginBottom: 0, lineHeight: 1 }}>
            {readiness.verdict}
          </p>
          <p className="mt-3 text-sm text-muted" style={{ marginBottom: 0, lineHeight: 1.35 }}>{drivers}</p>
        </div>
      </div>
    </button>
  )
}
