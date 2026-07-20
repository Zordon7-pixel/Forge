import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Trash2, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import GroupRunPanel from './GroupRunPanel'

function formatWhen(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

function formatPace(stats) {
  const miles = Number(stats?.distance_miles || 0)
  const seconds = Number(stats?.duration_seconds || 0)
  if (!(miles > 0) || !(seconds > 0)) return '--'
  const pace = Math.round(seconds / miles)
  return `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}/mi`
}

export default function CommunityActivityPanel({ friends = [] }) {
  const { t } = useTranslation()
  const [view, setView] = useState('feed')
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setNotice('')
    try {
      const response = await api.get('/social/activity-posts?limit=20')
      const rows = Array.isArray(response.data?.posts) ? response.data.posts : []
      const hydrated = await Promise.all(rows.map(async (post) => {
        if (!post.has_card) return post
        try {
          const cardResponse = await api.get(`/social/activity-posts/${post.id}/card`)
          return { ...post, card: cardResponse.data?.card?.data || '' }
        } catch (error) {
          console.error('[CommunityActivityPanel] card load failed:', error?.message || error)
          return post
        }
      }))
      setPosts(hydrated)
    } catch (error) {
      console.error('[CommunityActivityPanel] feed load failed:', error?.message || error)
      setNotice(t('community.activityLoadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  const removePost = async (post) => {
    if (!window.confirm(t('community.activityDeleteConfirm'))) return
    try {
      await api.delete(`/social/activity-posts/${post.id}`)
      setPosts((current) => current.filter((item) => item.id !== post.id))
    } catch (error) {
      console.error('[CommunityActivityPanel] delete failed:', error?.message || error)
      setNotice(error?.response?.data?.error || t('community.actionError'))
    }
  }

  return (
    <div style={{ minWidth: 0, width: '100%' }}>
      <div role="tablist" aria-label={t('community.activityViews')} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4, padding: 4, marginBottom: 14, borderRadius: 8, background: 'var(--bg-input)' }}>
        <button type="button" role="tab" aria-selected={view === 'feed'} className="pressable" onClick={() => setView('feed')} style={{ minHeight: 44, border: 'none', borderRadius: 6, background: view === 'feed' ? 'var(--accent)' : 'transparent', color: view === 'feed' ? 'var(--on-accent)' : 'var(--text-muted)', fontSize: 12, fontWeight: 900 }}>{t('community.friendActivity')}</button>
        <button type="button" role="tab" aria-selected={view === 'groups'} className="pressable" onClick={() => setView('groups')} style={{ minHeight: 44, border: 'none', borderRadius: 6, background: view === 'groups' ? 'var(--accent)' : 'transparent', color: view === 'groups' ? 'var(--on-accent)' : 'var(--text-muted)', fontSize: 12, fontWeight: 900 }}>{t('community.groupRuns')}</button>
      </div>

      {view === 'groups' ? <GroupRunPanel friends={friends} /> : (
        <section aria-label={t('community.friendActivity')}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
            <div>
              <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 17, fontWeight: 900 }}>{t('community.friendActivity')}</h2>
              <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>{t('community.activityPrivacy')}</p>
            </div>
            <button type="button" onClick={load} disabled={loading} aria-label={t('community.refresh')} className="pressable" style={{ width: 40, height: 40, flex: '0 0 auto', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button>
          </div>

          {notice && <p role="status" style={{ color: 'var(--danger)', fontSize: 12 }}>{notice}</p>}
          {loading ? (
            <div style={{ minHeight: 180, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}><RefreshCw size={24} className="animate-spin" /></div>
          ) : posts.length === 0 ? (
            <div style={{ minHeight: 220, display: 'grid', placeItems: 'center', padding: 24, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', textAlign: 'center' }}>
              <div>
                <Users size={30} color="var(--accent)" style={{ margin: '0 auto 10px' }} />
                <h3 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 16 }}>{t('community.activityEmptyTitle')}</h3>
                <p style={{ maxWidth: 320, margin: '7px auto 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.55 }}>{t('community.activityEmptyBody')}</p>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              {posts.map((post) => (
                <article key={post.id} style={{ minWidth: 0, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', overflow: 'hidden' }}>
                  <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
                    <span aria-hidden="true" style={{ width: 38, height: 38, flex: '0 0 auto', borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--accent)', fontSize: 11, fontWeight: 900 }}>{String(post.athlete?.name || 'A').slice(0, 2).toUpperCase()}</span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontSize: 13 }}>{post.athlete?.name || t('community.athleteFallback')}</strong>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{formatWhen(post.created_at)} · {post.template}</span>
                    </span>
                    {post.is_owner && <button type="button" onClick={() => removePost(post)} aria-label={t('community.activityDelete')} className="pressable" style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><Trash2 size={17} /></button>}
                  </header>
                  {post.card ? <img src={post.card} alt={t('community.activityCardAlt', { name: post.athlete?.name || t('community.athleteFallback') })} style={{ display: 'block', width: '100%', aspectRatio: '4 / 5', objectFit: 'contain', background: '#090909' }} /> : (
                    <div style={{ aspectRatio: '4 / 3', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', background: 'var(--bg-input)', fontSize: 12 }}>{t('community.activityCardUnavailable')}</div>
                  )}
                  <div style={{ padding: 12 }}>
                    {post.caption && <p style={{ margin: '0 0 10px', color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{post.caption}</p>}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}><strong style={{ display: 'block', color: 'var(--text-primary)', fontSize: 13 }}>{Number(post.stats?.distance_miles || 0).toFixed(2)} mi</strong>{t('community.miles')}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}><strong style={{ display: 'block', color: 'var(--text-primary)', fontSize: 13 }}>{formatDuration(post.stats?.duration_seconds)}</strong>{t('community.activityTime')}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}><strong style={{ display: 'block', color: 'var(--text-primary)', fontSize: 13 }}>{formatPace(post.stats)}</strong>{t('community.activityPace')}</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
