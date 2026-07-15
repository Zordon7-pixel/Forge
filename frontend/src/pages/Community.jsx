import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Ban,
  Check,
  Copy,
  Flag,
  Link as LinkIcon,
  MoreVertical,
  RefreshCw,
  Share2,
  ShieldCheck,
  UserMinus,
  Users,
  X,
} from 'lucide-react'
import api from '../lib/api'

const EMPTY_DATA = {
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
  limits: { active_invite_count: 0, active_invites: 5, friends: 100 },
}

const REPORT_OPTIONS = [
  ['harassment', 'community.categoryHarassment'],
  ['spam', 'community.categorySpam'],
  ['impersonation', 'community.categoryImpersonation'],
  ['unsafe_content', 'community.categoryUnsafe'],
  ['other', 'community.categoryOther'],
]

function avatarLabel(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function copyWithFallback(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  const textArea = document.createElement('textarea')
  textArea.value = value
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  document.body.appendChild(textArea)
  textArea.select()
  document.execCommand('copy')
  textArea.remove()
  return Promise.resolve()
}

function PersonRow({ item, subtitle, children }) {
  const { t } = useTranslation()
  const name = item.user?.name || item.name || t('community.athleteFallback')
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr) auto', alignItems: 'center', gap: 12, minHeight: 66, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)', position: 'relative' }}>
      <span aria-hidden="true" style={{ width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--accent)', fontSize: 12, fontWeight: 900 }}>
        {avatarLabel(name)}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 14, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {subtitle && <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>{subtitle}</span>}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>{children}</span>
    </div>
  )
}

function SectionHeading({ icon: Icon, title, count }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 2 }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, color: 'var(--text-primary)', fontSize: 16, fontWeight: 900 }}>
        <Icon size={18} color="var(--accent)" /> {title}
      </h2>
      <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 800 }}>{count}</span>
    </div>
  )
}

export default function Community() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState(EMPTY_DATA)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState(null)
  const [invite, setInvite] = useState(null)
  const [menuFor, setMenuFor] = useState('')
  const [reportTarget, setReportTarget] = useState(null)
  const [reportCategory, setReportCategory] = useState('harassment')
  const [reportNote, setReportNote] = useState('')
  const processedInviteRef = useRef('')

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const response = await api.get('/social/friends')
      setData({ ...EMPTY_DATA, ...(response.data || {}) })
    } catch (error) {
      console.error('[Community] load failed:', error?.message)
      setNotice({ type: 'error', text: t('community.loadError') })
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const token = searchParams.get('invite') || ''
    if (!token || processedInviteRef.current === token) return
    processedInviteRef.current = token
    let active = true

    const resolveInvite = async () => {
      setBusy('resolve-invite')
      try {
        const response = await api.post(`/social/friend-invites/${encodeURIComponent(token)}/request`)
        if (!active) return
        setNotice({
          type: 'success',
          text: response.data?.status === 'already_friends'
            ? t('community.alreadyFriends')
            : response.data?.status === 'request_exists'
              ? t('community.requestExists')
              : t('community.requestSent'),
        })
      } catch (error) {
        if (!active) return
        setNotice({ type: 'error', text: error?.response?.data?.error || t('community.actionError') })
      } finally {
        if (!active) return
        const nextParams = new URLSearchParams(searchParams)
        nextParams.delete('invite')
        setSearchParams(nextParams, { replace: true })
        setBusy('')
        await load({ quiet: true })
      }
    }

    resolveInvite()
    return () => { active = false }
  }, [load, searchParams, setSearchParams, t])

  const runAction = async (key, request, successText = '') => {
    setBusy(key)
    setNotice(null)
    try {
      await request()
      if (successText) setNotice({ type: 'success', text: successText })
      setMenuFor('')
      await load({ quiet: true })
      return true
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('community.actionError') })
      return false
    } finally {
      setBusy('')
    }
  }

  const createInvite = async () => {
    await runAction('create-invite', async () => {
      const response = await api.post('/social/friend-invites')
      const url = new URL('/community', window.location.origin)
      url.searchParams.set('invite', response.data.token)
      setInvite({ url: url.toString(), expiresAt: response.data.expires_at })
    })
  }

  const copyInvite = async () => {
    if (!invite?.url) return
    try {
      await copyWithFallback(invite.url)
      setNotice({ type: 'success', text: t('community.copied') })
    } catch (error) {
      console.error('[Community] copy failed:', error?.message)
      setNotice({ type: 'error', text: t('community.actionError') })
    }
  }

  const shareInvite = async () => {
    if (!invite?.url) return
    if (!navigator.share) return copyInvite()
    try {
      await navigator.share({ title: 'Forged Hybrid', text: t('community.inviteBody'), url: invite.url })
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('[Community] share failed:', error?.message)
        setNotice({ type: 'error', text: t('community.actionError') })
      }
    }
  }

  const removeFriend = (item) => {
    const name = item.user?.name || t('community.athleteFallback')
    if (!window.confirm(t('community.removeConfirm', { name }))) return
    runAction(`remove-${item.id}`, () => api.delete(`/social/friendships/${item.id}`))
  }

  const blockFriend = (item) => {
    const name = item.user?.name || t('community.athleteFallback')
    if (!window.confirm(t('community.blockConfirm', { name }))) return
    runAction(`block-${item.id}`, () => api.post(`/social/blocks/${item.user.id}`))
  }

  const openReport = (item, contextType = 'friendship') => {
    setReportTarget({
      user: item.user || { id: item.user_id, name: item.name },
      contextType,
      contextId: contextType === 'friendship' ? item.id : null,
    })
    setMenuFor('')
  }

  const submitReport = async () => {
    if (!reportTarget) return
    const success = await runAction('submit-report', () => api.post('/social/reports', {
      subject_user_id: reportTarget.user.id,
      category: reportCategory,
      context_type: reportTarget.contextType,
      context_id: reportTarget.contextId,
      note: reportNote,
    }), t('community.reportSuccess'))
    if (success) {
      setReportTarget(null)
      setReportCategory('harassment')
      setReportNote('')
    }
  }

  const friendCount = data.friends.length
  const inviteLimitReached = Number(data.limits?.active_invite_count || 0) >= Number(data.limits?.active_invites || 5)

  return (
    <div style={{ paddingBottom: 96 }}>
      <header style={{ marginBottom: 18 }}>
        <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Forged Hybrid</p>
        <h1 style={{ color: 'var(--text-primary)', fontSize: 28, fontWeight: 900, margin: 0 }}>{t('community.title')}</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.55, margin: '8px 0 0' }}>{t('community.subtitle')}</p>
      </header>

      {notice && (
        <div role="status" style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 8, border: `1px solid ${notice.type === 'success' ? 'color-mix(in srgb, var(--success) 45%, transparent)' : 'color-mix(in srgb, var(--danger) 45%, transparent)'}`, background: notice.type === 'success' ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--danger) 12%, transparent)', color: notice.type === 'success' ? 'var(--success)' : 'var(--danger)', fontSize: 13, fontWeight: 750 }}>
          {notice.text}
        </div>
      )}

      <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 14, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ flex: '0 0 auto', width: 38, height: 38, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}><LinkIcon size={19} /></span>
          <span style={{ minWidth: 0 }}>
            <h2 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}>{t('community.inviteTitle')}</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '4px 0 0' }}>{t('community.inviteBody')}</p>
          </span>
        </div>

        {invite ? (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: 'var(--success)', fontSize: 12, fontWeight: 850, margin: '0 0 8px' }}>{t('community.inviteReady')}</p>
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', padding: '10px 12px', color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{invite.url}</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '7px 0 0' }}>{t('community.inviteExpires', { date: new Date(invite.expiresAt).toLocaleDateString() })}</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
              <button type="button" className="pressable" onClick={shareInvite} style={{ minHeight: 42, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Share2 size={17} />{t('community.shareInvite')}</button>
              <button type="button" className="pressable" onClick={copyInvite} style={{ minHeight: 42, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Copy size={17} />{t('community.copyInvite')}</button>
            </div>
          </div>
        ) : (
          <button type="button" className="pressable" onClick={createInvite} disabled={Boolean(busy) || inviteLimitReached} style={{ width: '100%', minHeight: 44, marginTop: 14, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, opacity: Boolean(busy) || inviteLimitReached ? 0.55 : 1 }}>
            {busy === 'create-invite' ? t('community.creating') : t('community.createInvite')}
          </button>
        )}
        {!invite && inviteLimitReached && <p style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45, margin: '8px 0 0' }}>{t('community.inviteLimit')}</p>}
      </section>

      {loading ? (
        <div style={{ minHeight: 180, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
          <RefreshCw size={24} className="animate-spin" aria-label={t('community.loading')} />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 24 }}>
          {data.incoming.length > 0 && (
            <section>
              <SectionHeading icon={ShieldCheck} title={t('community.incomingTitle')} count={data.incoming.length} />
              {data.incoming.map((item) => (
                <PersonRow key={item.id} item={item} subtitle={t('community.pending')}>
                  <button type="button" className="pressable" title={t('community.accept')} aria-label={`${t('community.accept')} ${item.user.name}`} disabled={Boolean(busy)} onClick={() => runAction(`accept-${item.id}`, () => api.patch(`/social/friendships/${item.id}`, { action: 'accept' }))} style={{ minWidth: 40, height: 40, borderRadius: 8, border: 'none', background: 'var(--success)', color: '#06130a', display: 'grid', placeItems: 'center' }}><Check size={18} /></button>
                  <button type="button" className="pressable" title={t('community.decline')} aria-label={`${t('community.decline')} ${item.user.name}`} disabled={Boolean(busy)} onClick={() => runAction(`decline-${item.id}`, () => api.patch(`/social/friendships/${item.id}`, { action: 'decline' }))} style={{ minWidth: 40, height: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><X size={18} /></button>
                  <button type="button" className="pressable" aria-label={t('community.actionsFor', { name: item.user.name })} title={t('community.actionsFor', { name: item.user.name })} onClick={() => setMenuFor((current) => current === `incoming-${item.id}` ? '' : `incoming-${item.id}`)} style={{ minWidth: 40, height: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><MoreVertical size={18} /></button>
                  {menuFor === `incoming-${item.id}` && (
                    <div style={{ position: 'absolute', right: 0, top: 56, zIndex: 15, width: 180, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', boxShadow: '0 12px 30px rgba(0,0,0,0.35)', padding: 6 }}>
                      <button type="button" onClick={() => openReport(item)} style={{ width: '100%', minHeight: 40, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', fontSize: 13, fontWeight: 750 }}><Flag size={16} />{t('community.report')}</button>
                      <button type="button" onClick={() => blockFriend(item)} style={{ width: '100%', minHeight: 40, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', fontSize: 13, fontWeight: 750 }}><Ban size={16} />{t('community.block')}</button>
                    </div>
                  )}
                </PersonRow>
              ))}
            </section>
          )}

          {data.outgoing.length > 0 && (
            <section>
              <SectionHeading icon={Share2} title={t('community.outgoingTitle')} count={data.outgoing.length} />
              {data.outgoing.map((item) => (
                <PersonRow key={item.id} item={item} subtitle={t('community.pending')}>
                  <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => runAction(`cancel-${item.id}`, () => api.delete(`/social/friendships/${item.id}`))} style={{ minHeight: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)', padding: '0 10px', fontSize: 12, fontWeight: 800 }}>{t('community.cancel')}</button>
                </PersonRow>
              ))}
            </section>
          )}

          <section>
            <SectionHeading icon={Users} title={t('community.friendsTitle')} count={`${friendCount}/${data.limits?.friends || 100}`} />
            {friendCount === 0 ? (
              <div style={{ padding: '24px 8px 8px', textAlign: 'center' }}>
                <Users size={28} color="var(--text-muted)" style={{ margin: '0 auto 10px' }} />
                <h3 style={{ color: 'var(--text-primary)', fontSize: 15, margin: 0 }}>{t('community.noFriendsTitle')}</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.55, maxWidth: 330, margin: '6px auto 0' }}>{t('community.noFriendsBody')}</p>
              </div>
            ) : data.friends.map((item) => (
              <PersonRow key={item.id} item={item} subtitle={t('community.friendSubtitle')}>
                <button type="button" className="pressable" aria-label={t('community.actionsFor', { name: item.user.name })} title={t('community.actionsFor', { name: item.user.name })} onClick={() => setMenuFor((current) => current === item.id ? '' : item.id)} style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><MoreVertical size={18} /></button>
                {menuFor === item.id && (
                  <div style={{ position: 'absolute', right: 0, top: 56, zIndex: 15, width: 180, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', boxShadow: '0 12px 30px rgba(0,0,0,0.35)', padding: 6 }}>
                    <button type="button" onClick={() => removeFriend(item)} style={{ width: '100%', minHeight: 40, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', fontSize: 13, fontWeight: 750 }}><UserMinus size={16} />{t('community.remove')}</button>
                    <button type="button" onClick={() => openReport(item)} style={{ width: '100%', minHeight: 40, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', fontSize: 13, fontWeight: 750 }}><Flag size={16} />{t('community.report')}</button>
                    <button type="button" onClick={() => blockFriend(item)} style={{ width: '100%', minHeight: 40, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', fontSize: 13, fontWeight: 750 }}><Ban size={16} />{t('community.block')}</button>
                  </div>
                )}
              </PersonRow>
            ))}
          </section>

          {data.blocked.length > 0 && (
            <section>
              <SectionHeading icon={Ban} title={t('community.blockedTitle')} count={data.blocked.length} />
              {data.blocked.map((item) => (
                <PersonRow key={item.id} item={item} subtitle={t('community.blockedTitle')}>
                  <button type="button" className="pressable" title={t('community.report')} aria-label={`${t('community.report')} ${item.name}`} disabled={Boolean(busy)} onClick={() => openReport(item, 'profile')} style={{ minWidth: 40, height: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><Flag size={16} /></button>
                  <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => runAction(`unblock-${item.id}`, () => api.delete(`/social/blocks/${item.user_id}`))} style={{ minHeight: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-primary)', padding: '0 10px', fontSize: 12, fontWeight: 800 }}>{t('community.unblock')}</button>
                </PersonRow>
              ))}
            </section>
          )}

          <button type="button" className="pressable" onClick={() => load()} disabled={loading || Boolean(busy)} style={{ justifySelf: 'center', minHeight: 40, border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800 }}><RefreshCw size={15} />{t('community.refresh')}</button>
        </div>
      )}

      {reportTarget && (
        <div role="dialog" aria-modal="true" aria-labelledby="report-title" style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.76)', display: 'grid', alignItems: 'end', justifyItems: 'center', padding: 12 }}>
          <div style={{ width: 'min(456px, 100%)', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', padding: 18, paddingBottom: 'calc(18px + env(safe-area-inset-bottom, 0px))' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <h2 id="report-title" style={{ color: 'var(--text-primary)', fontSize: 18, fontWeight: 900, margin: 0 }}>{t('community.reportTitle')}</h2>
              <button type="button" onClick={() => setReportTarget(null)} aria-label={t('community.close')} style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><X size={20} /></button>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '5px 0 14px' }}>{reportTarget.user.name}</p>
            <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, marginBottom: 6 }}>{t('community.reportCategory')}</label>
            <select value={reportCategory} onChange={(event) => setReportCategory(event.target.value)} style={{ width: '100%', minHeight: 44, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 12px' }}>
              {REPORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
            <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, margin: '14px 0 6px' }}>{t('community.reportNote')}</label>
            <textarea value={reportNote} maxLength={500} rows={4} onChange={(event) => setReportNote(event.target.value)} style={{ width: '100%', resize: 'vertical', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: 12, boxSizing: 'border-box' }} />
            <button type="button" className="pressable" onClick={submitReport} disabled={busy === 'submit-report'} style={{ width: '100%', minHeight: 46, marginTop: 14, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, opacity: busy === 'submit-report' ? 0.6 : 1 }}>{busy === 'submit-report' ? t('community.submitting') : t('community.reportSubmit')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
