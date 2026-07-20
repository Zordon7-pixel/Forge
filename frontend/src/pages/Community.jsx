import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AtSign,
  Ban,
  Check,
  Copy,
  Eye,
  EyeOff,
  Flag,
  Link as LinkIcon,
  Medal,
  MoreVertical,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  Trophy,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import api from '../lib/api'
import ChallengePanel from '../components/ChallengePanel'
import CommunityActivityPanel from '../components/CommunityActivityPanel'
import FriendLeaderboard from '../components/FriendLeaderboard'
import { isContactMatchingAvailable, readPermittedContactEmails } from '../services/ContactService'

const EMPTY_DATA = {
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
  discovery: { handle: '', discoverable: false, contact_discoverable: false },
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

function normalizeHandle(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '')
}

function isHandleShape(value) {
  return /^[a-z0-9][a-z0-9._]{2,23}$/.test(normalizeHandle(value))
}

function buildInviteUrl(value) {
  const normalized = normalizeHandle(value)
  if (!isHandleShape(normalized)) return ''
  return new URL(`/invite/${encodeURIComponent(normalized)}`, window.location.origin).toString()
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
  const handle = item.user?.handle || item.handle || ''
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr) auto', alignItems: 'center', gap: 12, width: '100%', maxWidth: '100%', minWidth: 0, minHeight: 66, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)', position: 'relative' }}>
      <span aria-hidden="true" style={{ width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--accent)', fontSize: 12, fontWeight: 900 }}>
        {avatarLabel(name)}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 14, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {(handle || subtitle) && (
          <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {handle ? `@${handle}` : ''}{handle && subtitle ? ' · ' : ''}{subtitle || ''}
          </span>
        )}
      </span>
      <span style={{ display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>{children}</span>
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
  const [inviteError, setInviteError] = useState('')
  const [handleDraft, setHandleDraft] = useState('')
  const [handleDiscoverable, setHandleDiscoverable] = useState(false)
  const [contactDiscoverable, setContactDiscoverable] = useState(false)
  const [contactSuggestions, setContactSuggestions] = useState([])
  const [contactMessage, setContactMessage] = useState('')
  const [searchHandle, setSearchHandle] = useState('')
  const [searchResult, setSearchResult] = useState(null)
  const [searchMessage, setSearchMessage] = useState('')
  const [friendDiscoveryMode, setFriendDiscoveryMode] = useState('handle')
  const [menuFor, setMenuFor] = useState('')
  const [reportTarget, setReportTarget] = useState(null)
  const [reportCategory, setReportCategory] = useState('harassment')
  const [reportNote, setReportNote] = useState('')
  const [activeTab, setActiveTab] = useState(() => {
    const requestedTab = searchParams.get('tab')
    if (requestedTab === 'runs') return 'activity'
    return ['activity', 'challenges', 'leaderboard', 'friends'].includes(requestedTab) ? requestedTab : 'activity'
  })
  const processedInviteRef = useRef('')
  const processedHandleRef = useRef('')
  const inviteHandleInputRef = useRef(null)
  const scrollToInviteHandleRef = useRef(false)

  const selectTab = (tab) => {
    setActiveTab(tab)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('tab', tab)
    setSearchParams(nextParams, { replace: true })
  }

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const response = await api.get('/social/friends')
      const nextData = { ...EMPTY_DATA, ...(response.data || {}) }
      setData(nextData)
      setHandleDraft(nextData.discovery?.handle || '')
      setHandleDiscoverable(Boolean(nextData.discovery?.discoverable))
      setContactDiscoverable(Boolean(nextData.discovery?.contact_discoverable))
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
    if (friendDiscoveryMode !== 'handle' || !scrollToInviteHandleRef.current) return
    scrollToInviteHandleRef.current = false
    inviteHandleInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [friendDiscoveryMode])

  useEffect(() => {
    const token = searchParams.get('invite') || ''
    if (!token || processedInviteRef.current === token) return
    processedInviteRef.current = token
    setActiveTab('friends')
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
        nextParams.set('tab', 'friends')
        setSearchParams(nextParams, { replace: true })
        setBusy('')
        await load({ quiet: true })
      }
    }

    resolveInvite()
    return () => { active = false }
  }, [load, searchParams, setSearchParams, t])

  useEffect(() => {
    if (searchParams.get('invite')) return
    const handle = normalizeHandle(searchParams.get('handle') || '')
    if (!isHandleShape(handle) || processedHandleRef.current === handle) return
    processedHandleRef.current = handle
    setActiveTab('friends')
    setFriendDiscoveryMode('handle')
    setSearchHandle(handle)
    setSearchResult(null)
    setSearchMessage('')
    let active = true

    const resolveHandle = async () => {
      setBusy('friend-search')
      try {
        const response = await api.post('/social/friend-search', { handle })
        if (!active) return
        setSearchResult(response.data?.athlete || null)
        if (!response.data?.athlete) setSearchMessage(t('community.searchEmpty'))
      } catch (error) {
        if (!active) return
        if (error?.response?.status === 404) setSearchMessage(t('community.searchEmpty'))
        else setNotice({ type: 'error', text: error?.response?.data?.error || t('community.actionError') })
      } finally {
        if (!active) return
        const nextParams = new URLSearchParams(searchParams)
        nextParams.delete('handle')
        nextParams.set('tab', 'friends')
        setSearchParams(nextParams, { replace: true })
        setBusy('')
      }
    }

    resolveHandle()
    return () => { active = false }
  }, [searchParams, setSearchParams, t])

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

  const createInvite = () => {
    const url = buildInviteUrl(data.discovery?.handle)
    if (!data.discovery?.discoverable || !url) {
      setInvite(null)
      setInviteError(t('community.inviteHandleRequired'))
      return
    }
    setInviteError('')
    setNotice(null)
    setInvite({ url })
  }

  const openInviteHandleSetup = () => {
    setInviteError('')
    scrollToInviteHandleRef.current = true
    setFriendDiscoveryMode('handle')
  }

  const saveDiscoveryProfile = async () => {
    setBusy('save-handle')
    setNotice(null)
    try {
      const response = await api.put('/social/friend-discovery-profile', {
        handle: handleDraft,
        discoverable: handleDiscoverable,
      })
      setHandleDraft(response.data?.handle || '')
      setHandleDiscoverable(Boolean(response.data?.discoverable))
      setInvite(null)
      setInviteError('')
      setNotice({ type: 'success', text: t('community.handleSaved') })
      await load({ quiet: true })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('community.actionError') })
    } finally {
      setBusy('')
    }
  }

  const findFriend = async (event) => {
    event.preventDefault()
    const handle = normalizeHandle(searchHandle)
    setSearchResult(null)
    setSearchMessage('')
    if (!isHandleShape(handle)) {
      setSearchMessage(t('community.searchInvalid'))
      return
    }
    setBusy('friend-search')
    try {
      const response = await api.post('/social/friend-search', { handle })
      setSearchResult(response.data?.athlete || null)
      if (!response.data?.athlete) setSearchMessage(t('community.searchEmpty'))
    } catch (error) {
      if (error?.response?.status === 404) setSearchMessage(t('community.searchEmpty'))
      else setNotice({ type: 'error', text: error?.response?.data?.error || t('community.actionError') })
    } finally {
      setBusy('')
    }
  }

  const saveContactDiscoverability = async (discoverable) => {
    setBusy('contact-discovery')
    setNotice(null)
    try {
      const response = await api.put('/social/contact-discovery-profile', { discoverable })
      setContactDiscoverable(Boolean(response.data?.discoverable))
      setNotice({ type: 'success', text: t('community.contactDiscoverySaved') })
      await load({ quiet: true })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('community.actionError') })
    } finally {
      setBusy('')
    }
  }

  const findContactSuggestions = async () => {
    setBusy('contact-scan')
    setNotice(null)
    setContactMessage('')
    setContactSuggestions([])
    try {
      const emails = (await readPermittedContactEmails()).slice(0, 500)
      if (!emails.length) {
        setContactMessage(t('community.contactEmailsEmpty'))
        return
      }
      const response = await api.post('/social/contact-suggestions', { emails })
      const suggestions = response.data?.suggestions || []
      setContactSuggestions(suggestions)
      setContactMessage(suggestions.length
        ? t('community.contactMatches', { count: suggestions.length })
        : t('community.contactMatchesEmpty'))
    } catch (error) {
      console.error('[Community] contact suggestion scan failed:', error?.message)
      setContactMessage(error?.response?.data?.error || error?.message || t('community.contactMatchError'))
    } finally {
      setBusy('')
    }
  }

  const sendContactRequest = async (index) => {
    const suggestion = contactSuggestions[index]
    if (!suggestion?.request_token) return
    setBusy(`contact-request-${index}`)
    setNotice(null)
    try {
      const response = await api.post('/social/contact-suggestions/request', { token: suggestion.request_token })
      const relationship = response.data?.direction
        || (response.data?.status === 'already_friends' ? 'friends' : 'outgoing')
      setContactSuggestions((current) => current.map((item, itemIndex) => (
        itemIndex === index ? { ...item, relationship, request_token: null } : item
      )))
      setNotice({ type: 'success', text: t('community.requestSent') })
      await load({ quiet: true })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('community.actionError') })
    } finally {
      setBusy('')
    }
  }

  const sendHandleRequest = async () => {
    if (!searchResult?.handle) return
    setBusy('handle-request')
    setNotice(null)
    try {
      const response = await api.post('/social/friend-requests', { handle: searchResult.handle })
      const relationship = response.data?.direction
        || (response.data?.status === 'already_friends' ? 'friends' : 'outgoing')
      setSearchResult((current) => current ? { ...current, relationship } : current)
      setNotice({
        type: 'success',
        text: response.data?.status === 'already_friends'
          ? t('community.alreadyFriends')
          : response.data?.status === 'request_exists'
            ? t('community.requestExists')
            : t('community.requestSent'),
      })
      await load({ quiet: true })
    } catch (error) {
      if (error?.response?.status === 404) {
        setSearchResult(null)
        setSearchMessage(t('community.searchEmpty'))
      } else {
        setNotice({ type: 'error', text: error?.response?.data?.error || t('community.actionError') })
      }
    } finally {
      setBusy('')
    }
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
      await navigator.share({ title: 'Forged Hybrid', text: t('community.inviteShareText'), url: invite.url })
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
  const contactMatchingAvailable = isContactMatchingAvailable()
  const relationshipLabel = searchResult
    ? {
        friends: t('community.searchFriends'),
        incoming: t('community.searchIncoming'),
        outgoing: t('community.searchOutgoing'),
      }[searchResult.relationship]
    : ''

  return (
    <div style={{ width: '100%', maxWidth: '100%', minWidth: 0, paddingBottom: 96, overflowX: 'clip' }}>
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

      <div role="tablist" aria-label={t('community.title')} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', width: '100%', maxWidth: '100%', minWidth: 0, gap: 3, padding: 4, marginBottom: 16, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)' }}>
        <button type="button" role="tab" aria-selected={activeTab === 'activity'} className="pressable" onClick={() => selectTab('activity')} style={{ minWidth: 0, minHeight: 54, padding: '4px 2px', border: 'none', borderRadius: 6, background: activeTab === 'activity' ? 'var(--accent)' : 'transparent', color: activeTab === 'activity' ? 'var(--on-accent)' : 'var(--text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 10, fontWeight: 900 }}><Activity size={15} />{t('community.activityTab')}</button>
        <button type="button" role="tab" aria-selected={activeTab === 'challenges'} className="pressable" onClick={() => selectTab('challenges')} style={{ minWidth: 0, minHeight: 54, padding: '4px 2px', border: 'none', borderRadius: 6, background: activeTab === 'challenges' ? 'var(--accent)' : 'transparent', color: activeTab === 'challenges' ? 'var(--on-accent)' : 'var(--text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 10, fontWeight: 900 }}><Trophy size={15} />{t('community.challengesTab')}</button>
        <button type="button" role="tab" aria-selected={activeTab === 'leaderboard'} className="pressable" onClick={() => selectTab('leaderboard')} style={{ minWidth: 0, minHeight: 54, padding: '4px 2px', border: 'none', borderRadius: 6, background: activeTab === 'leaderboard' ? 'var(--accent)' : 'transparent', color: activeTab === 'leaderboard' ? 'var(--on-accent)' : 'var(--text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 10, fontWeight: 900 }}><Medal size={15} />{t('community.leaderboardTab')}</button>
        <button type="button" role="tab" aria-selected={activeTab === 'friends'} className="pressable" onClick={() => selectTab('friends')} style={{ minWidth: 0, minHeight: 54, padding: '4px 2px', border: 'none', borderRadius: 6, background: activeTab === 'friends' ? 'var(--accent)' : 'transparent', color: activeTab === 'friends' ? 'var(--on-accent)' : 'var(--text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 10, fontWeight: 900 }}><Users size={15} />{t('community.friendsTab')}</button>
      </div>

      {activeTab === 'activity' ? (
        <CommunityActivityPanel friends={data.friends} />
      ) : activeTab === 'challenges' ? (
        <ChallengePanel friends={data.friends} />
      ) : activeTab === 'leaderboard' ? (
        <FriendLeaderboard />
      ) : (
        <>
      <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ flex: '0 0 auto', width: 38, height: 38, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}><Search size={19} /></span>
          <span style={{ minWidth: 0 }}>
            <h2 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}>{t('community.findTitle')}</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '4px 0 0' }}>{t('community.findBody')}</p>
          </span>
        </div>

        <div role="tablist" aria-label={t('community.friendDiscoveryTabs')} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', width: '100%', gap: 4, padding: 4, marginTop: 16, borderRadius: 8, background: 'var(--bg-input)' }}>
          <button type="button" role="tab" aria-selected={friendDiscoveryMode === 'handle'} className="pressable" onClick={() => setFriendDiscoveryMode('handle')} style={{ minWidth: 0, minHeight: 42, border: 'none', borderRadius: 6, background: friendDiscoveryMode === 'handle' ? 'var(--accent)' : 'transparent', color: friendDiscoveryMode === 'handle' ? 'var(--on-accent)' : 'var(--text-muted)', fontSize: 12, fontWeight: 900 }}>{t('community.handleTab')}</button>
          <button type="button" role="tab" aria-selected={friendDiscoveryMode === 'contacts'} className="pressable" onClick={() => setFriendDiscoveryMode('contacts')} style={{ minWidth: 0, minHeight: 42, border: 'none', borderRadius: 6, background: friendDiscoveryMode === 'contacts' ? 'var(--accent)' : 'transparent', color: friendDiscoveryMode === 'contacts' ? 'var(--on-accent)' : 'var(--text-muted)', fontSize: 12, fontWeight: 900 }}>{t('community.contactsTab')}</button>
        </div>

        {friendDiscoveryMode === 'handle' ? (
          <>
            <div style={{ marginTop: 16 }}>
              <label htmlFor="friend-handle" style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, fontWeight: 850, marginBottom: 6, textTransform: 'uppercase' }}>{t('community.yourHandle')}</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', width: '100%', maxWidth: '100%', minWidth: 0, gap: 8 }}>
                <label style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 5, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', padding: '0 11px' }}>
                  <AtSign size={16} color="var(--text-muted)" aria-hidden="true" />
                  <input ref={inviteHandleInputRef} id="friend-handle" value={handleDraft} maxLength={25} autoCapitalize="none" autoCorrect="off" spellCheck="false" onChange={(event) => setHandleDraft(event.target.value)} placeholder={t('community.handlePlaceholder')} style={{ minWidth: 0, width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 14 }} />
                </label>
                <button type="button" className="pressable" onClick={saveDiscoveryProfile} disabled={Boolean(busy)} style={{ minWidth: 72, minHeight: 44, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 850, opacity: Boolean(busy) ? 0.55 : 1 }}>{busy === 'save-handle' ? t('community.saving') : t('community.saveHandle')}</button>
              </div>
              <label style={{ minHeight: 44, marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-primary)', fontSize: 12, fontWeight: 750 }}>
                <input type="checkbox" checked={handleDiscoverable} disabled={!isHandleShape(handleDraft)} onChange={(event) => setHandleDiscoverable(event.target.checked)} style={{ width: 19, height: 19, accentColor: 'var(--accent)' }} />
                {handleDiscoverable ? <Eye size={17} color="var(--success)" /> : <EyeOff size={17} color="var(--text-muted)" />}
                <span>{t('community.discoverableLabel')}</span>
              </label>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45, margin: '2px 0 0' }}>{t('community.handleRules')}</p>
            </div>

            <form onSubmit={findFriend} style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 14, paddingTop: 14 }}>
              <label htmlFor="friend-search" style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, fontWeight: 850, marginBottom: 6, textTransform: 'uppercase' }}>{t('community.exactSearch')}</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 44px', width: '100%', maxWidth: '100%', minWidth: 0, gap: 8 }}>
                <label style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 5, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', padding: '0 11px' }}>
                  <AtSign size={16} color="var(--text-muted)" aria-hidden="true" />
                  <input id="friend-search" value={searchHandle} maxLength={25} autoCapitalize="none" autoCorrect="off" spellCheck="false" onChange={(event) => { setSearchHandle(event.target.value); setSearchResult(null); setSearchMessage('') }} placeholder={t('community.searchPlaceholder')} style={{ minWidth: 0, width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 14 }} />
                </label>
                <button type="submit" className="pressable" title={t('community.search')} aria-label={t('community.search')} disabled={Boolean(busy)} style={{ width: 44, height: 44, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', opacity: Boolean(busy) ? 0.55 : 1 }}><Search size={19} /></button>
              </div>
            </form>
            <p style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45, margin: '8px 0 0' }}>{t('community.searchCaseHint')}</p>

            {searchMessage && <p role="status" style={{ color: 'var(--text-muted)', fontSize: 12, margin: '12px 0 0' }}>{searchMessage}</p>}
            {searchResult && (
              <PersonRow item={searchResult} subtitle={relationshipLabel}>
                {searchResult.relationship === 'available' ? (
                  <button type="button" className="pressable" onClick={sendHandleRequest} disabled={Boolean(busy)} style={{ minHeight: 40, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', fontSize: 12, fontWeight: 850 }}><UserPlus size={16} />{t('community.addFriend')}</button>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 800, textAlign: 'right' }}>{relationshipLabel}</span>
                )}
              </PersonRow>
            )}
          </>
        ) : (
          <div style={{ marginTop: 16, borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 14, fontWeight: 900, margin: 0 }}><Users size={18} color="var(--accent)" />{t('community.findBetaFriends')}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '6px 0 0' }}>{t('community.contactDiscoveryBody')}</p>
            <label style={{ minHeight: 44, marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-primary)', fontSize: 12, fontWeight: 750 }}>
              <input type="checkbox" checked={contactDiscoverable} disabled={busy === 'contact-discovery'} onChange={(event) => saveContactDiscoverability(event.target.checked)} style={{ width: 19, height: 19, accentColor: 'var(--accent)' }} />
              {contactDiscoverable ? <Eye size={17} color="var(--success)" /> : <EyeOff size={17} color="var(--text-muted)" />}
              <span>{t('community.contactDiscoverableLabel')}</span>
            </label>
            <button type="button" className="pressable" onClick={findContactSuggestions} disabled={Boolean(busy) || !contactMatchingAvailable} style={{ width: '100%', minHeight: 44, marginTop: 8, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: Boolean(busy) || !contactMatchingAvailable ? 0.55 : 1 }}>
              {busy === 'contact-scan' ? <RefreshCw size={17} className="animate-spin" /> : <Search size={17} />}
              {busy === 'contact-scan' ? t('community.checkingContacts') : contactMatchingAvailable ? t('community.findBetaFriendsButton') : t('community.contactMatchingNextBuild')}
            </button>
            <p style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45, margin: '8px 0 0' }}>{t('community.contactPrivacy')}</p>
            {contactMessage && <p role="status" style={{ color: contactSuggestions.length ? 'var(--success)' : 'var(--text-muted)', fontSize: 12, lineHeight: 1.45, margin: '10px 0 0' }}>{contactMessage}</p>}
            {contactSuggestions.map((suggestion, index) => {
              const relationship = {
                friends: t('community.searchFriends'),
                incoming: t('community.searchIncoming'),
                outgoing: t('community.searchOutgoing'),
              }[suggestion.relationship] || ''
              return (
                <PersonRow key={`${suggestion.user?.handle || suggestion.user?.name}-${index}`} item={suggestion} subtitle={relationship}>
                  {suggestion.relationship === 'available' ? (
                    <button type="button" className="pressable" onClick={() => sendContactRequest(index)} disabled={Boolean(busy)} style={{ minHeight: 40, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', fontSize: 12, fontWeight: 850 }}><UserPlus size={16} />{t('community.addFriend')}</button>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 800, textAlign: 'right' }}>{relationship}</span>
                  )}
                </PersonRow>
              )
            })}

            <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 18, paddingTop: 14 }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 14, fontWeight: 900, margin: 0 }}><LinkIcon size={18} color="var(--accent)" />{t('community.contactInviteTitle')}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '6px 0 0' }}>{t('community.contactInviteBody')}</p>
            {invite ? (
              <div style={{ marginTop: 14 }}>
                <p style={{ color: 'var(--success)', fontSize: 12, fontWeight: 850, margin: '0 0 8px' }}>{t('community.inviteReady')}</p>
                <p style={{ color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>{invite.url}</p>
                {invite.expiresAt && <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '7px 0 0' }}>{t('community.inviteExpires', { date: new Date(invite.expiresAt).toLocaleDateString() })}</p>}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 10 }}>
                  <button type="button" className="pressable" onClick={shareInvite} style={{ minWidth: 0, minHeight: 44, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, fontSize: 12 }}><Share2 size={17} />{t('community.chooseContact')}</button>
                  <button type="button" className="pressable" onClick={copyInvite} style={{ minWidth: 0, minHeight: 44, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, fontSize: 12 }}><Copy size={17} />{t('community.copyInvite')}</button>
                </div>
              </div>
            ) : (
              <>
                <button type="button" className="pressable" onClick={createInvite} disabled={Boolean(busy)} style={{ width: '100%', minHeight: 44, marginTop: 14, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, opacity: Boolean(busy) ? 0.55 : 1 }}>
                  {busy === 'create-invite' ? t('community.creating') : t('community.createContactInvite')}
                </button>
                {inviteError && (
                  <div role="alert" style={{ marginTop: 10, padding: 10, borderRadius: 8, border: '1px solid color-mix(in srgb, var(--danger) 45%, transparent)', background: 'color-mix(in srgb, var(--danger) 12%, transparent)' }}>
                    <p style={{ color: 'var(--danger)', fontSize: 12, lineHeight: 1.45, margin: 0 }}>{inviteError}</p>
                    <button type="button" className="pressable" onClick={openInviteHandleSetup} style={{ minHeight: 40, marginTop: 8, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 12px', fontSize: 12, fontWeight: 850 }}>
                      {t('community.setupInviteHandle')}
                    </button>
                  </div>
                )}
              </>
            )}
            </div>
          </div>
        )}
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
                    <div style={{ position: 'absolute', right: 0, top: 56, zIndex: 15, width: 180, maxWidth: 'calc(100vw - 24px)', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', boxShadow: '0 12px 30px rgba(0,0,0,0.35)', padding: 6 }}>
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
                  <div style={{ position: 'absolute', right: 0, top: 56, zIndex: 15, width: 180, maxWidth: 'calc(100vw - 24px)', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', boxShadow: '0 12px 30px rgba(0,0,0,0.35)', padding: 6 }}>
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
        </>
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
