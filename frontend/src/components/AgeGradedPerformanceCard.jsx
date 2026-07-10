import React from 'react'

function formatDuration(totalSeconds) {
  const safe = Number(totalSeconds || 0)
  if (!(safe > 0)) return '--'
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function formatDate(dateStr) {
  if (!dateStr) return '--'
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const tierStyle = {
  elite_masters: { text: 'var(--success)', bg: 'rgba(34,197,94,0.14)', border: 'rgba(34,197,94,0.4)' },
  national_class: { text: 'var(--accent)', bg: 'var(--accent-dim)', border: 'var(--border-subtle)' },
  regional_contender: { text: '#60a5fa', bg: 'rgba(96,165,250,0.14)', border: 'rgba(96,165,250,0.35)' },
  local_competitive: { text: 'var(--warning)', bg: 'rgba(249,115,22,0.14)', border: 'var(--warning-dim)' },
  developing: { text: 'var(--text-muted)', bg: 'var(--bg-input)', border: 'var(--border-subtle)' },
}

export default function AgeGradedPerformanceCard({ data, onOpenProfile }) {
  if (!data) return null
  const distances = Array.isArray(data.distances) ? data.distances : []

  return (
    <section className="rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>Senior Competitive Benchmark</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>Age-graded 5K/10K scoring with peer bracket tracking</p>
        </div>
        <p className="text-xs text-right" style={{ color: 'var(--text-muted)' }}>
          {Number(data.community?.activeSeniorRunners90d || 0)} active seniors in 90 days
        </p>
      </div>

      {!data.ageProvided && (
        <div className="mt-3 rounded-xl p-3" style={{ background: 'var(--accent-dim)', border: '1px solid var(--border-subtle)' }}>
          <p className="text-xs" style={{ color: 'var(--text-primary)' }}>Add your age in Profile to unlock age-graded scoring and senior bracket ranking.</p>
          <button
            onClick={onOpenProfile}
            className="mt-2 rounded-lg px-3 py-1.5 text-xs font-bold"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
          >
            Update Profile
          </button>
        </div>
      )}

      {data.ageProvided && !data.seniorEligible && (
        <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
          Senior peer brackets begin at age 40. Your age-graded scores are still tracked here for progression.
        </p>
      )}

      <div className="mt-3 space-y-3">
        {distances.map((item) => {
          if (!item?.hasResult) {
            return (
              <div key={item.key} className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{item.label}</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>No recent {item.label} effort logged.</p>
              </div>
            )
          }

          const style = tierStyle[item.competitiveTierKey] || tierStyle.developing
          return (
            <div key={item.key} className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{item.label}</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Best: {formatDuration(item.normalizedDurationSeconds)} ({formatDate(item.bestDate)})</p>
                </div>
                <p className="text-lg font-black" style={{ color: 'var(--accent)' }}>
                  {item.ageGradedScore ? `${Number(item.ageGradedScore).toFixed(1)}%` : '--'}
                </p>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold rounded-full px-2 py-1" style={{ color: style.text, background: style.bg, border: `1px solid ${style.border}` }}>
                  {item.competitiveTier || 'Score unavailable'}
                </span>
                {item.rank && item.fieldSize ? (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Rank {item.rank}/{item.fieldSize} • {item.percentile}th percentile • {item.peerGroup}
                  </span>
                ) : (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Peer ranking unlocks at age 40+</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
