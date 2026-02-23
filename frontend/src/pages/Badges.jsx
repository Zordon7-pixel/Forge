import { useState, useEffect } from 'react'
import LoadingRunner from '../components/LoadingRunner'
import {
  Flame, Trophy, Star, Zap, Award, Medal, Crown, Lock
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

export default function Badges() {
  const [badges, setBadges] = useState([])
  const [leaderboard, setLeaderboard] = useState([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [badgesRes, lbRes] = await Promise.all([
        api.get('/badges'),
        api.get('/badges/leaderboard'),
      ])
      setBadges(badgesRes.data.badges || [])
      setLeaderboard(lbRes.data.leaderboard || [])
    } catch (e) {
      // silently fail
    } finally {
      setLoading(false)
    }
  }

  async function checkBadges() {
    setChecking(true)
    try {
      await api.post('/badges/check', {})
      await loadData()
    } finally {
      setChecking(false)
    }
  }

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
            {earnedCount} of {badges.length} earned
          </p>
        </div>
        <button
          onClick={checkBadges}
          disabled={checking}
          className="text-xs font-bold px-3 py-1.5 rounded-xl transition-all disabled:opacity-50"
          style={{ background: '#EAB308', color: '#000' }}
        >
          {checking ? 'Checking...' : 'Check Progress'}
        </button>
      </div>

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
