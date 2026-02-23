import { useState, useEffect } from 'react'
import LoadingRunner from '../components/LoadingRunner'
import AchievementUnlock from '../components/AchievementUnlock'
import {
  Flame, Trophy, Star, Zap, Award, Medal, Crown, Lock, Sun, Heart, Snowflake, Flower2, Leaf, Ghost, Gift, Flag, Mountain, Utensils, Wind
} from 'lucide-react'
import api from '../lib/api'

const ICON_MAP = {
  Flame,
  Trophy,
  Star,
  Zap,
  Award,
  Medal,
  Crown,
}

const FALLBACK_ICON = Award

function getSeasonalIcon(badge) {
  const s = ((badge.name || '') + ' ' + (badge.slug || '')).toLowerCase()
  if (s.includes('winter') || s.includes('frost') || s.includes('snow') || s.includes('blizzard')) return Snowflake
  if (s.includes('spring') || s.includes('bloom') || s.includes('cherry') || s.includes('flower')) return Flower2
  if (s.includes('summer') || s.includes('solstice') || s.includes('heat')) return Sun
  if (s.includes('fall') || s.includes('autumn') || s.includes('harvest') || s.includes('leaf')) return Leaf
  if (s.includes('valentine') || s.includes('heart') || s.includes('love')) return Heart
  if (s.includes('halloween') || s.includes('spooky') || s.includes('hustle') || s.includes('ghost')) return Ghost
  if (s.includes('holiday') || s.includes('christmas') || s.includes('gift') || s.includes('new year') || s.includes('warrior')) return Gift
  if (s.includes('independence') || s.includes('sprint') || s.includes('july') || s.includes('patriot')) return Flag
  if (s.includes('marathon') || s.includes('race') || s.includes('trophy') || s.includes('trot') || s.includes('turkey')) return Trophy
  if (s.includes('trail') || s.includes('mountain') || s.includes('hike')) return Mountain
  if (s.includes('thanks') || s.includes('turkey')) return Utensils
  return FALLBACK_ICON
}

function BadgeIcon({ name, size = 28, color }) {
  const Icon = ICON_MAP[name] || Award
  return <Icon size={size} color={color} strokeWidth={2} />
}

function BadgeCard({ badge }) {
  const earned = !!badge.earned
  const earnedDate = badge.earned_at
    ? new Date(badge.earned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  return (
    <div
      className="relative flex flex-col items-center rounded-2xl p-4 transition-all"
      style={{
        background: earned ? 'rgba(234,179,8,0.08)' : '#1a1a1a',
        border: `1.5px solid ${earned ? '#EAB308' : '#2a2a2a'}`,
        boxShadow: earned ? '0 0 16px rgba(234,179,8,0.35)' : 'none',
        minHeight: 120,
      }}
    >
      {/* Lock overlay for unearned */}
      {!earned && (
        <div className="absolute top-2 right-2 opacity-50">
          <Lock size={12} color="#6b7280" />
        </div>
      )}

      {/* Icon */}
      <div className="mb-2 flex items-center justify-center rounded-full"
        style={{
          width: 52,
          height: 52,
          background: earned ? 'rgba(234,179,8,0.15)' : 'rgba(255,255,255,0.04)',
        }}
      >
        <BadgeIcon
          name={badge.icon}
          size={26}
          color={earned ? '#EAB308' : '#4b5563'}
        />
      </div>

      {/* Name */}
      <p className="text-xs font-bold text-center leading-tight"
        style={{ color: earned ? '#EAB308' : '#6b7280' }}>
        {badge.name}
      </p>

      {/* Description */}
      {badge.description && (
        <p className="text-[10px] text-center mt-0.5 leading-snug"
          style={{ color: earned ? '#a3a3a3' : '#4b5563' }}>
          {badge.description}
        </p>
      )}

      {/* Earned date */}
      {earned && earnedDate && (
        <p className="text-[10px] mt-1 font-medium" style={{ color: '#EAB308', opacity: 0.7 }}>
          {earnedDate}
        </p>
      )}
    </div>
  )
}

function SeasonalBadgeCard({ badge, onClick }) {
  const pct = badge.requirement_value > 0 ? Math.min(100, (badge.progress / badge.requirement_value) * 100) : 0
  const color = badge.color || '#EAB308'
  const isEarned = badge.status === 'earned'
  const isActive = badge.status === 'active'

  const statusLabel = isEarned ? 'Earned' :
    isActive ? `${badge.days_remaining}d left` :
    badge.status === 'upcoming' ? `Starts in ${badge.days_until_start}d` :
    'Past'

  const reqLabel = badge.requirement_type === 'miles_in_window'
    ? `${badge.progress.toFixed(1)} / ${badge.requirement_value} miles`
    : `${badge.progress} / ${badge.requirement_value} workouts`

  const windowLabel = (() => {
    const fmt = (s) => {
      const d = new Date(s + 'T12:00:00')
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
    return `${fmt(badge.window_start_full)} - ${fmt(badge.window_end_full)}`
  })()

  const Icon = getSeasonalIcon(badge) || FALLBACK_ICON

  return (
    <div style={{
      borderRadius: 16,
      padding: 16,
      background: isEarned ? `${color}18` : 'var(--bg-input)',
      border: `1.5px solid ${isEarned ? color : isActive ? color + '55' : 'var(--border-subtle)'}`,
      boxShadow: isEarned ? `0 0 20px ${color}44` : isActive ? `0 0 10px ${color}22` : 'none',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Active glow top bar */}
      {isActive && !isEarned && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color, borderRadius: '16px 16px 0 0' }} />
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        {/* Icon circle */}
        <div style={{
          width: 52, height: 52, borderRadius: '50%', flexShrink: 0,
          background: isEarned ? color : `${color}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: isEarned ? `0 0 12px ${color}66` : 'none',
        }}>
          <Icon size={24} color={isEarned ? '#000' : color} strokeWidth={2} />
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <p style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.2 }}>{badge.name}</p>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: isEarned ? color : isActive ? `${color}33` : 'var(--bg-base)',
              color: isEarned ? '#000' : isActive ? color : 'var(--text-muted)',
            }}>{statusLabel}</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{badge.description}</p>
          <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, fontWeight: 600 }}>{windowLabel}</p>
        </div>
      </div>

      {/* Progress bar */}
      {!isEarned && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{reqLabel}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: isActive ? color : 'var(--text-muted)' }}>{Math.round(pct)}%</span>
          </div>
          <div style={{ height: 5, background: 'var(--bg-base)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.6s ease' }} />
          </div>
        </div>
      )}

      {isEarned && (
        <p style={{ fontSize: 11, color, fontWeight: 700, marginTop: 10 }}>
          Completed {badge.earned_at ? new Date(badge.earned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
        </p>
      )}
    </div>
  )
}

export default function Badges() {
  const [tab, setTab] = useState('achievements')
  const [badges, setBadges] = useState([])
  const [seasonal, setSeasonal] = useState([])
  const [leaderboard, setLeaderboard] = useState([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [unlockQueue, setUnlockQueue] = useState([])
  const [selectedSeasonal, setSelectedSeasonal] = useState(null)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [badgesRes, seasonalRes, lbRes] = await Promise.all([
        api.get('/badges'),
        api.get('/badges/seasonal'),
        api.get('/badges/leaderboard'),
      ])
      setBadges(badgesRes.data.badges || [])
      setSeasonal(seasonalRes.data.badges || [])
      setLeaderboard(lbRes.data.leaderboard || [])
    } catch (e) {
      // silently fail
    } finally {
      setLoading(false)
    }
  }

  async function checkBadges() {
    setChecking(true)
    const prevEarned = new Set(badges.filter(b => b.earned).map(b => b.id))
    try {
      const res = await api.post('/badges/check', {})
      const awarded = res.data?.awarded || []
      if (awarded.length > 0) {
        setUnlockQueue(awarded)
      }
      await loadData()
    } finally {
      setChecking(false)
    }
  }

  const dismissUnlock = () => setUnlockQueue(prev => prev.slice(1))

  const achievements = badges.filter(b => b.category === 'achievement')
  const monthly = badges.filter(b => b.category === 'monthly')
  const holiday = badges.filter(b => b.category === 'holiday')

  const earnedCount = badges.filter(b => b.earned).length

  if (loading) {
    return <LoadingRunner message="Loading badges" />
  }

  return (
    <div className="space-y-6 py-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>Badge Wall</h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {tab === 'achievements' ? `${earnedCount} of ${badges.length} earned` : `${seasonal.filter(b => b.earned).length} of ${seasonal.length} seasonal`}
          </p>
        </div>
        {tab === 'achievements' && (
          <button
            onClick={checkBadges}
            disabled={checking}
            className="text-xs font-bold px-3 py-1.5 rounded-xl transition-all disabled:opacity-50"
            style={{ background: '#EAB308', color: '#000' }}
          >
            {checking ? 'Checking...' : 'Check Progress'}
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {['achievements', 'seasonal'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '8px 0', borderRadius: 10, fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer',
              background: tab === t ? 'var(--accent)' : 'var(--bg-input)',
              color: tab === t ? '#000' : 'var(--text-muted)',
            }}>
            {t === 'achievements' ? 'Achievements' : 'Seasonal'}
          </button>
        ))}
      </div>

      {/* Achievements Tab */}
      {tab === 'achievements' && (
        <div className="space-y-6">
          {/* Achievements */}
          <section>
            <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
              Achievements
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {achievements.map(b => <BadgeCard key={b.id} badge={b} />)}
            </div>
          </section>

          {/* Monthly */}
          {monthly.length > 0 && (
            <section>
              <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
                Monthly
              </h3>
              <div className="grid grid-cols-3 gap-3">
                {monthly.map(b => <BadgeCard key={b.id} badge={b} />)}
              </div>
            </section>
          )}

          {/* Holiday */}
          {holiday.length > 0 && (
            <section>
              <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
                Holiday
              </h3>
              <div className="grid grid-cols-3 gap-3">
                {holiday.map(b => <BadgeCard key={b.id} badge={b} />)}
              </div>
            </section>
          )}

        </div>
      )}

      {/* Seasonal Tab */}
      {tab === 'seasonal' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
            Complete challenges tied to real events and seasons. Active challenges are live right now.
          </p>
          {seasonal.map(b => <SeasonalBadgeCard key={b.slug} badge={b} />)}
        </div>
      )}

      {/* Leaderboard */}
      <section className="pb-4">
        <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          Leaderboard
        </h3>
        <div className="rounded-2xl overflow-hidden" style={{ border: '1.5px solid var(--border-subtle)' }}>
          {/* Header row */}
          <div className="grid grid-cols-4 px-4 py-2"
            style={{ background: 'rgba(234,179,8,0.08)', borderBottom: '1px solid var(--border-subtle)' }}>
            <span className="text-xs font-bold" style={{ color: '#EAB308' }}>Rank</span>
            <span className="text-xs font-bold col-span-2" style={{ color: '#EAB308' }}>Runner</span>
            <span className="text-xs font-bold text-right" style={{ color: '#EAB308' }}>Miles</span>
          </div>
          {leaderboard.length === 0 && (
            <div className="px-4 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No data yet. Log some runs to appear here.
            </div>
          )}
          {leaderboard.map((row, i) => (
            <div
              key={row.id}
              className="grid grid-cols-4 px-4 py-3 items-center"
              style={{
                background: i % 2 === 0 ? 'var(--bg-card)' : 'transparent',
                borderBottom: i < leaderboard.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              }}
            >
              {/* Rank */}
              <span className="text-sm font-black" style={{ color: i < 3 ? '#EAB308' : 'var(--text-muted)' }}>
                {i + 1}
              </span>
              {/* Runner name */}
              <span className="text-sm font-semibold col-span-2 truncate" style={{ color: 'var(--text-primary)' }}>
                {row.runner || 'Athlete'}
                {row.badge_count > 0 && (
                  <span className="ml-1 text-xs font-normal" style={{ color: '#EAB308' }}>
                    {row.badge_count} badges
                  </span>
                )}
              </span>
              {/* Miles */}
              <span className="text-sm font-bold text-right" style={{ color: 'var(--text-primary)' }}>
                {Number(row.total_miles).toFixed(1)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
