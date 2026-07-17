import { useCallback, useEffect, useState } from 'react'
import { Medal, RefreshCw, Route, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'

function avatarLabel(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function phoneMonthKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function rankColor(rank) {
  if (rank === 1) return 'var(--accent)'
  if (rank === 2) return '#CBD5E1'
  if (rank === 3) return '#D97706'
  return 'var(--text-muted)'
}

export default function FriendLeaderboard() {
  const { t } = useTranslation()
  const [monthKey, setMonthKey] = useState(phoneMonthKey)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get('/social/friends/leaderboard', { params: { month: monthKey } })
      setData(response.data || null)
    } catch (requestError) {
      console.error('[FriendLeaderboard] load failed:', requestError?.message)
      setError(requestError?.response?.data?.error || t('community.leaderboardError'))
    } finally {
      setLoading(false)
    }
  }, [monthKey, t])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => setMonthKey(phoneMonthKey()), 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <section aria-labelledby="friend-mileage-title" style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 850, textTransform: 'uppercase', margin: '0 0 4px' }}>{data?.month?.label || t('community.thisMonth')}</p>
          <h2 id="friend-mileage-title" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 20, fontWeight: 900, margin: 0 }}><Medal size={21} color="var(--accent)" />{t('community.monthlyMileage')}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '6px 0 0' }}>{t('community.leaderboardPrivacy')}</p>
        </div>
        <button type="button" className="pressable" onClick={load} disabled={loading} title={t('community.refresh')} aria-label={t('community.refresh')} style={{ flex: '0 0 auto', width: 42, height: 42, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center', opacity: loading ? 0.55 : 1 }}><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      {loading ? (
        <div style={{ minHeight: 180, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}><RefreshCw size={24} className="animate-spin" aria-label={t('community.leaderboardLoading')} /></div>
      ) : error ? (
        <div role="alert" style={{ border: '1px solid color-mix(in srgb, var(--danger) 45%, transparent)', borderRadius: 8, background: 'color-mix(in srgb, var(--danger) 10%, transparent)', color: 'var(--danger)', padding: 14, fontSize: 13 }}>{error}</div>
      ) : (
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', overflow: 'hidden' }}>
          <ol aria-label={t('community.monthlyMileage')} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {(data?.rows || []).map((row) => (
              <li key={`${row.rank}-${row.user?.handle || row.user?.name}`} style={{ display: 'grid', gridTemplateColumns: '34px 42px minmax(0, 1fr) auto', alignItems: 'center', gap: 9, minHeight: 68, padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', background: row.is_self ? 'color-mix(in srgb, var(--accent) 9%, var(--bg-card))' : 'transparent' }}>
                <span aria-label={t('community.rankLabel', { rank: row.rank })} style={{ color: rankColor(row.rank), fontSize: 16, fontWeight: 950, textAlign: 'center' }}>{row.rank}</span>
                <span aria-hidden="true" style={{ width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--accent)', fontSize: 12, fontWeight: 900 }}>{avatarLabel(row.user?.name)}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 14, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.user?.name || t('community.athleteFallback')}{row.is_self ? ` · ${t('community.you')}` : ''}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}><Route size={13} />{t('community.runCount', { count: row.run_count })}{row.user?.handle ? ` · @${row.user.handle}` : ''}</span>
                </span>
                <span style={{ minWidth: 64, textAlign: 'right' }}>
                  <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 18, fontWeight: 950 }}>{Number(row.miles || 0).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}</span>
                  <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{t('community.miles')}</span>
                </span>
              </li>
            ))}
          </ol>
          {Number(data?.participant_count || 0) <= 1 && (
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: 14, color: 'var(--text-muted)' }}>
              <Users size={18} style={{ flex: '0 0 auto', marginTop: 1 }} />
              <p style={{ fontSize: 12, lineHeight: 1.5, margin: 0 }}>{t('community.leaderboardSolo')}</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
