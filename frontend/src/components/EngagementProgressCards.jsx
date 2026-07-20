import { Award, Minus, TrendingDown, TrendingUp, Trophy } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

function formatPrValue(pr) {
  const value = Number(pr?.value || 0)
  const unit = String(pr?.unit || '').toLowerCase()
  if (unit === 'min/mi') {
    const minutes = Math.floor(value)
    const seconds = Math.round((value - minutes) * 60)
    return `${minutes}:${String(seconds).padStart(2, '0')} /mi`
  }
  if (unit === 'seconds') {
    const hours = Math.floor(value / 3600)
    const minutes = Math.floor((value % 3600) / 60)
    const seconds = Math.round(value % 60)
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`
  }
  if (unit === 'mi') return `${value.toFixed(1)} mi`
  if (unit === 'lbs' || unit === 'lb') return `${Math.round(value).toLocaleString()} lb`
  if (unit === 'reps' || unit === 'rep') return `${Math.round(value)} reps`
  return `${Number.isFinite(value) ? value.toLocaleString() : '--'} ${pr?.unit || ''}`.trim()
}

function formatShortDate(value) {
  if (!value) return 'Recent'
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return 'Recent'
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function signedNumber(value, formatter) {
  const number = Number(value || 0)
  const formatted = formatter ? formatter(Math.abs(number)) : Math.abs(number).toLocaleString()
  if (number > 0) return `+${formatted}`
  if (number < 0) return `-${formatted}`
  return formatted
}

function DeltaPill({ value, formatter }) {
  const delta = Number(value || 0)
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus
  const color = delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--text-muted)'
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-black" style={{ background: 'var(--bg-input)', color }}>
      <Icon size={12} />
      {signedNumber(delta, formatter)}
    </span>
  )
}

export function YouVsLastMonthCard({ comparison }) {
  if (!comparison) return null
  const rows = [
    {
      label: 'Mileage',
      value: `${Number(comparison.mileage?.current || 0).toFixed(1)} mi`,
      delta: comparison.mileage?.delta,
      formatter: (value) => `${Number(value || 0).toFixed(1)} mi`,
    },
    {
      label: 'Lift tonnage',
      value: `${Math.round(Number(comparison.liftTonnage?.current || 0)).toLocaleString()} lb`,
      delta: comparison.liftTonnage?.delta,
      formatter: (value) => `${Math.round(Number(value || 0)).toLocaleString()} lb`,
    },
    {
      label: 'Lift sessions',
      value: Math.round(Number(comparison.liftSessions?.current || 0)).toLocaleString(),
      delta: comparison.liftSessions?.delta,
      formatter: (value) => Math.round(Number(value || 0)).toLocaleString(),
    },
    {
      label: 'Hybrid consistency',
      value: `${Math.round(Number(comparison.consistency?.current || 0))}%`,
      delta: comparison.consistency?.delta,
      formatter: (value) => `${Math.round(Number(value || 0))}%`,
      sub: `${comparison.consistency?.currentHybridWeeks || 0}/${comparison.consistency?.targetWeeks || 4} hybrid weeks`,
    },
    {
      label: 'Hybrid Score',
      value: Math.round(Number(comparison.hybridScore?.current || 0)).toLocaleString(),
      delta: comparison.hybridScore?.delta,
      formatter: (value) => Math.round(Number(value || 0)).toLocaleString(),
    },
  ]

  return (
    <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 16 }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>You vs last month</p>
          <p className="mt-1 text-sm font-bold" style={{ color: 'var(--text-primary)', marginBottom: 0 }}>
            Last {comparison.windowDays || 28} days
          </p>
        </div>
        <p className="text-right text-[11px] leading-5" style={{ color: 'var(--text-muted)', margin: 0 }}>
          {formatShortDate(comparison.currentWindow?.start)} - {formatShortDate(comparison.currentWindow?.end)}
        </p>
      </div>
      <div className="mt-4 space-y-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="min-w-0">
              <p className="text-sm font-black" style={{ color: 'var(--text-primary)', margin: 0 }}>{row.value}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)', margin: '2px 0 0' }}>{row.label}{row.sub ? ` · ${row.sub}` : ''}</p>
            </div>
            <DeltaPill value={row.delta} formatter={row.formatter} />
          </div>
        ))}
      </div>
    </section>
  )
}

export function EngagementHighlights({ engagement }) {
  const navigate = useNavigate()
  const recentPrs = Array.isArray(engagement?.recentPrs) ? engagement.recentPrs : []
  const earnedBadges = Array.isArray(engagement?.earnedBadges) ? engagement.earnedBadges : []
  const nextBadges = Array.isArray(engagement?.nextBadges) ? engagement.nextBadges : []
  if (!recentPrs.length && !earnedBadges.length && !nextBadges.length) return null

  const latestPr = recentPrs[0]
  const badgeRows = earnedBadges.length
    ? earnedBadges.slice(0, 3).map((badge) => ({ ...badge, state: 'Earned' }))
    : nextBadges.slice(0, 3).map((badge) => ({ ...badge, state: 'Next' }))

  return (
    <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 16 }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>PRs and badges</p>
          <p className="mt-1 text-sm font-bold" style={{ color: 'var(--text-primary)', marginBottom: 0 }}>Hybrid progress</p>
        </div>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs font-black"
          style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          onClick={() => navigate('/prs')}
        >
          PR Wall
        </button>
      </div>

      {latestPr && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg p-3" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex min-w-0 items-center gap-3">
            <Trophy size={18} color="var(--accent)" style={{ flex: '0 0 auto' }} />
            <div className="min-w-0">
              <p className="truncate text-sm font-black" style={{ color: 'var(--text-primary)', margin: 0 }}>{latestPr.label}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)', margin: '2px 0 0' }}>{formatShortDate(latestPr.achieved_at)}</p>
            </div>
          </div>
          <p className="shrink-0 text-right text-sm font-black" style={{ color: 'var(--text-primary)', margin: 0 }}>{formatPrValue(latestPr)}</p>
        </div>
      )}

      {badgeRows.length > 0 && (
        <div className="mt-4 space-y-3">
          {badgeRows.map((badge) => (
            <div key={badge.id} className="flex items-center justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <Award size={17} color={badge.earned ? 'var(--success)' : 'var(--accent)'} style={{ flex: '0 0 auto' }} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-black" style={{ color: 'var(--text-primary)', margin: 0 }}>{badge.label}</p>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)', margin: '2px 0 0' }}>
                    {badge.earned ? formatShortDate(badge.earnedAt) : badge.progress?.label || 'In progress'}
                  </p>
                </div>
              </div>
              <span className="shrink-0 rounded-md px-2 py-1 text-[10px] font-black uppercase" style={{ background: 'var(--bg-input)', color: badge.earned ? 'var(--success)' : 'var(--text-muted)' }}>
                {badge.state}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
