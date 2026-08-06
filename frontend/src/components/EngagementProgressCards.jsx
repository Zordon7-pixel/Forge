import { useState } from 'react'
import { Award, Flame, Minus, Share2, TrendingDown, TrendingUp, Trophy } from 'lucide-react'
import { useNavigate } from 'react-router'
import { shareSummaryCard } from './ActivityShareStudio'

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

export function HybridScoreCard({ hybridScore, streakStats }) {
  const [sharing, setSharing] = useState(false)
  const [shareStatus, setShareStatus] = useState('')
  if (!hybridScore && !streakStats) return null

  const components = hybridScore?.components || {}
  const score = Math.round(Number(hybridScore?.score || 0))
  const current = Number(streakStats?.currentStreak || 0)
  const longest = Number(streakStats?.longestStreak || streakStats?.bestStreak || 0)
  const unit = streakStats?.unit === 'week' ? 'week' : 'day'
  const unitLabel = `${unit}${current === 1 ? '' : 's'}`
  const bars = [
    { label: 'Run', value: components.run || 0, color: 'var(--accent)' },
    { label: 'Lift', value: components.lift || 0, color: 'var(--success)' },
    { label: 'Consistency', value: components.consistency || 0, color: 'var(--warning)' },
  ]
  const driver = Array.isArray(hybridScore?.drivers) && hybridScore.drivers.length
    ? hybridScore.drivers.join(' ')
    : 'Run and lift balance sets the ceiling.'

  const shareHybridScore = async () => {
    setSharing(true)
    setShareStatus('')
    try {
      const result = await shareSummaryCard({
        title: 'Forged Hybrid Score',
        eyebrow: 'Hybrid Score',
        primary: `${score}/100`,
        subtitle: driver,
        filename: 'hybrid-score',
        metrics: bars.map((bar) => {
          const value = Math.max(0, Math.min(100, Math.round(Number(bar.value || 0))))
          return { label: bar.label, value, display: `${value}`, color: bar.color }
        }),
      })
      if (result?.method === 'download') setShareStatus('Share card saved.')
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('[Body] hybrid score share failed:', error?.message || error)
        setShareStatus('Share was not available.')
      }
    } finally {
      setSharing(false)
    }
  }

  return (
    <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 16 }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Hybrid Score</p>
          <div className="mt-1 flex items-end gap-2">
            <span className="text-4xl font-black leading-none" style={{ color: 'var(--text-primary)' }}>{score}</span>
            <span className="pb-1 text-sm font-bold" style={{ color: 'var(--text-muted)' }}>/100</span>
          </div>
        </div>
        <div className="flex max-w-[58%] flex-col items-end gap-2">
          <p className="text-right text-xs leading-5" style={{ color: 'var(--text-muted)', margin: 0 }}>{driver}</p>
          {hybridScore && (
            <button
              type="button"
              className="pressable flex min-h-9 items-center gap-2 rounded-md px-3 text-xs font-black"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
              disabled={sharing}
              onClick={shareHybridScore}
            >
              <Share2 size={14} />{sharing ? 'Sharing...' : 'Share'}
            </button>
          )}
        </div>
      </div>
      {shareStatus && <p role="status" className="mt-2 text-right text-[11px] font-semibold" style={{ color: 'var(--text-muted)', marginBottom: 0 }}>{shareStatus}</p>}
      <div className="mt-4 space-y-2">
        {bars.map((bar) => {
          const value = Math.max(0, Math.min(100, Math.round(Number(bar.value || 0))))
          return (
            <div key={bar.label} className="grid items-center gap-2" style={{ gridTemplateColumns: '86px 1fr 34px' }}>
              <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>{bar.label}</span>
              <div aria-hidden="true" style={{ height: 8, borderRadius: 999, background: 'var(--bg-input)', overflow: 'hidden' }}>
                <div style={{ width: `${value}%`, height: '100%', borderRadius: 999, background: bar.color }} />
              </div>
              <span className="text-right text-xs font-black" style={{ color: 'var(--text-primary)' }}>{value}</span>
            </div>
          )
        })}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex min-w-0 items-center gap-2">
          <Flame size={18} color="var(--accent)" className="shrink-0" />
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Hybrid Streak</p>
            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)', margin: '2px 0 0' }}>{current} {unitLabel}</p>
          </div>
        </div>
        <p className="shrink-0 text-right text-xs leading-5" style={{ color: 'var(--text-muted)', margin: 0 }}>
          Best {longest}<br />{streakStats?.graceUsed ? 'Grace used' : 'Grace available'}
        </p>
      </div>
    </section>
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
