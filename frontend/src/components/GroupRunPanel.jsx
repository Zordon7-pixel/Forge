import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Bell,
  BellOff,
  CalendarClock,
  Check,
  ChevronRight,
  Clock3,
  Flag,
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  Route,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import api from '../lib/api'
import { fetchDailyExecution } from '../lib/dailyExecution'
import {
  formatGroupRunDate,
  groupRunCompatibility,
  groupRunCountdown,
  groupRunDateISO,
  groupRunWarmupState,
  workoutSummary,
} from '../lib/groupRuns'
import GroupRunComposer from './GroupRunComposer'
import RoutePreviewMap from './maps/RoutePreviewMap'

const REPORT_CATEGORIES = ['harassment', 'spam', 'unsafe_content', 'other']

function Notice({ notice }) {
  if (!notice) return null
  return (
    <div role="status" style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, border: `1px solid ${notice.type === 'success' ? 'color-mix(in srgb, var(--success) 45%, transparent)' : 'color-mix(in srgb, var(--danger) 45%, transparent)'}`, background: notice.type === 'success' ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--danger) 12%, transparent)', color: notice.type === 'success' ? 'var(--success)' : 'var(--danger)', fontSize: 12, fontWeight: 800 }}>
      {notice.text}
    </div>
  )
}

function GroupRunCard({ groupRun, busy, onOpen, onMembership }) {
  const { t } = useTranslation()
  const invited = groupRun.membership?.status === 'invited'
  return (
    <article style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ color: invited ? 'var(--accent)' : 'var(--text-muted)', fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>{invited ? t('groupRuns.invitation') : groupRunCountdown(groupRun)}</span>
          <h3 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: '4px 0 0', overflowWrap: 'anywhere' }}>{groupRun.title}</h3>
        </div>
        <span style={{ flex: '0 0 auto', color: 'var(--text-muted)', fontSize: 11, fontWeight: 800 }}>{t('groupRuns.goingCount', { count: groupRun.participant_count || 1, limit: groupRun.participant_limit || 12 })}</span>
      </div>
      <p style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850, margin: '12px 0 0', textTransform: 'capitalize' }}>{workoutSummary(groupRun)}</p>
      <p style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 11, margin: '6px 0 0' }}><CalendarClock size={14} />{formatGroupRunDate(groupRun)}</p>
      <p style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 11, margin: '5px 0 0' }}><MapPin size={14} />{groupRun.meetup_area}</p>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '5px 0 0' }}>{t('groupRuns.organizedBy', { name: groupRun.organizer?.name || t('groupRuns.athlete') })}</p>
      {invited ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => onMembership(groupRun.id, 'join')} style={{ minHeight: 44, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}><Check size={17} />{t('groupRuns.join')}</button>
            <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => onMembership(groupRun.id, 'decline')} style={{ minHeight: 44, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-muted)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}><X size={17} />{t('groupRuns.decline')}</button>
          </div>
          <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => onOpen(groupRun.id)} style={{ width: '100%', minHeight: 40, marginTop: 7, border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('groupRuns.reviewInvitation')}</button>
        </div>
      ) : (
        <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => onOpen(groupRun.id)} style={{ width: '100%', minHeight: 44, marginTop: 14, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px' }}>{t('groupRuns.open')}<ChevronRight size={18} /></button>
      )}
    </article>
  )
}

function Section({ title, count, children }) {
  return (
    <section style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 9 }}>
        <h2 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}>{title}</h2>
        <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 800 }}>{count}</span>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>{children}</div>
    </section>
  )
}

export default function GroupRunPanel({ friends = [] }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [groupRuns, setGroupRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [detail, setDetail] = useState(null)
  const [inviteeId, setInviteeId] = useState('')
  const [compatibility, setCompatibility] = useState(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportCategory, setReportCategory] = useState('other')
  const [reportNote, setReportNote] = useState('')

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const response = await api.get('/group-runs')
      setGroupRuns(response.data?.group_runs || [])
    } catch (error) {
      console.error('[GroupRunPanel] load failed:', error?.message)
      setNotice({ type: 'error', text: error?.response?.data?.error || t('groupRuns.loadError') })
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [t])

  useEffect(() => { load() }, [load])

  const invitations = useMemo(() => groupRuns.filter((run) => run.membership?.status === 'invited' && run.status === 'scheduled' && new Date(run.starts_at).getTime() > Date.now()), [groupRuns])
  const joined = useMemo(() => groupRuns.filter((run) => run.membership?.status === 'going'), [groupRuns])
  const upcoming = useMemo(() => joined.filter((run) => run.status === 'scheduled' && new Date(run.starts_at).getTime() + Number(run.duration_minutes || 60) * 60000 >= Date.now()), [joined])
  const past = useMemo(() => joined.filter((run) => run.status !== 'scheduled' || new Date(run.starts_at).getTime() + Number(run.duration_minutes || 60) * 60000 < Date.now()), [joined])

  const refreshDetail = useCallback(async (groupRunId) => {
    try {
      const response = await api.get(`/group-runs/${groupRunId}`)
      setDetail(response.data)
    } catch (error) {
      console.error('[GroupRunPanel] detail refresh failed:', error?.message)
    }
  }, [])

  const openDetail = async (groupRunId, { preserveNotice = false } = {}) => {
    setBusy(`detail-${groupRunId}`)
    if (!preserveNotice) setNotice(null)
    setCompatibility(null)
    setReportOpen(false)
    try {
      const response = await api.get(`/group-runs/${groupRunId}`)
      const nextDetail = response.data
      setDetail(nextDetail)
      const dateISO = groupRunDateISO(nextDetail.group_run)
      if (dateISO) {
        fetchDailyExecution(dateISO)
          .then((execution) => setCompatibility(groupRunCompatibility(nextDetail.group_run, execution)))
          .catch((error) => {
            console.error('[GroupRunPanel] compatibility check failed:', error?.message)
            setCompatibility({ state: 'none', label: t('groupRuns.noConflict') })
          })
      }
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('groupRuns.actionError') })
    } finally {
      setBusy('')
    }
  }

  const createGroupRun = async (payload) => {
    setBusy('create')
    setNotice(null)
    try {
      const response = await api.post('/group-runs', payload)
      setShowCreate(false)
      setNotice({ type: 'success', text: t('groupRuns.createSuccess') })
      await load({ quiet: true })
      await openDetail(response.data.group_run_id, { preserveNotice: true })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('groupRuns.actionError') })
    } finally {
      setBusy('')
    }
  }

  const membershipAction = async (groupRunId, action, muted) => {
    setBusy(`${action}-${groupRunId}`)
    setNotice(null)
    try {
      await api.patch(`/group-runs/${groupRunId}/membership`, { action, ...(action === 'mute' ? { muted } : {}) })
      setNotice({ type: 'success', text: t(`groupRuns.${action}Success`) })
      await load({ quiet: true })
      if (action === 'join' || action === 'mute') await openDetail(groupRunId, { preserveNotice: true })
      else if (detail?.group_run?.id === groupRunId) setDetail(null)
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('groupRuns.actionError') })
    } finally {
      setBusy('')
    }
  }

  const inviteFriend = async () => {
    if (!detail?.group_run?.id || !inviteeId) return
    setBusy('invite')
    setNotice(null)
    try {
      const response = await api.post(`/group-runs/${detail.group_run.id}/invite`, { friend_id: inviteeId })
      setNotice({ type: 'success', text: response.data?.status === 'already_invited' ? t('groupRuns.alreadyInvited') : t('groupRuns.inviteSuccess') })
      setInviteeId('')
      await refreshDetail(detail.group_run.id)
      await load({ quiet: true })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('groupRuns.actionError') })
    } finally {
      setBusy('')
    }
  }

  const ownerAction = async (action, membershipId, name) => {
    if (!detail?.group_run?.id) return
    const message = action === 'cancel' ? t('groupRuns.cancelConfirm') : action === 'complete' ? t('groupRuns.completeConfirm') : t('groupRuns.removeConfirm', { name: name || t('groupRuns.athlete') })
    if (!window.confirm(message)) return
    setBusy(action)
    try {
      await api.patch(`/group-runs/${detail.group_run.id}`, { action, ...(membershipId ? { membership_id: membershipId } : {}) })
      setNotice({ type: 'success', text: t(`groupRuns.${action}Success`) })
      if (action === 'remove_member') await refreshDetail(detail.group_run.id)
      else setDetail(null)
      await load({ quiet: true })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('groupRuns.actionError') })
    } finally {
      setBusy('')
    }
  }

  const submitReport = async () => {
    if (!detail?.group_run?.id) return
    setBusy('report')
    try {
      await api.post(`/group-runs/${detail.group_run.id}/report`, { category: reportCategory, note: reportNote })
      setReportOpen(false)
      setReportNote('')
      setNotice({ type: 'success', text: t('groupRuns.reportSuccess') })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('groupRuns.actionError') })
    } finally {
      setBusy('')
    }
  }

  const startRun = () => {
    if (!detail?.group_run) return
    const startsAt = new Date(detail.group_run.starts_at).getTime()
    if (startsAt - Date.now() > 6 * 60 * 60 * 1000 && !window.confirm(t('groupRuns.startEarlyConfirm'))) return
    navigate('/warmup', { state: groupRunWarmupState(detail.group_run) })
  }

  return (
    <div>
      <Notice notice={notice} />
      <button type="button" className="pressable" onClick={() => setShowCreate(true)} style={{ width: '100%', minHeight: 48, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Plus size={19} />{t('groupRuns.plan')}</button>

      {loading ? (
        <div style={{ minHeight: 180, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}><RefreshCw size={24} className="animate-spin" aria-label={t('groupRuns.loading')} /></div>
      ) : (
        <>
          {invitations.length > 0 && <Section title={t('groupRuns.invitations')} count={invitations.length}>{invitations.map((run) => <GroupRunCard key={run.id} groupRun={run} busy={busy} onOpen={openDetail} onMembership={membershipAction} />)}</Section>}
          <Section title={t('groupRuns.upcoming')} count={upcoming.length}>
            {upcoming.length ? upcoming.map((run) => <GroupRunCard key={run.id} groupRun={run} busy={busy} onOpen={openDetail} onMembership={membershipAction} />) : (
              <div style={{ padding: '26px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, textAlign: 'center' }}><Users size={28} color="var(--text-muted)" style={{ margin: '0 auto 9px' }} /><h3 style={{ color: 'var(--text-primary)', fontSize: 15, margin: 0 }}>{t('groupRuns.emptyTitle')}</h3><p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '6px auto 0', maxWidth: 320 }}>{t('groupRuns.emptyBody')}</p></div>
            )}
          </Section>
          {past.length > 0 && <details style={{ marginTop: 20 }}><summary className="pressable" style={{ minHeight: 44, color: 'var(--text-muted)', fontSize: 13, fontWeight: 850, cursor: 'pointer' }}>{t('groupRuns.past')} · {past.length}</summary><div style={{ display: 'grid', gap: 10, marginTop: 8 }}>{past.map((run) => <GroupRunCard key={run.id} groupRun={run} busy={busy} onOpen={openDetail} onMembership={membershipAction} />)}</div></details>}
          <button type="button" className="pressable" onClick={() => load()} disabled={loading || Boolean(busy)} style={{ minHeight: 40, margin: '18px auto 0', border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800 }}><RefreshCw size={15} />{t('groupRuns.refresh')}</button>
        </>
      )}

      {showCreate && <GroupRunComposer friends={friends} busy={busy === 'create'} onClose={() => setShowCreate(false)} onSubmit={createGroupRun} />}

      {detail?.group_run && (
        <div role="dialog" aria-modal="true" aria-labelledby="group-run-detail-title" style={{ position: 'fixed', inset: 0, zIndex: 85, background: 'rgba(0,0,0,0.78)', display: 'grid', alignItems: 'end', justifyItems: 'center' }}>
          <div style={{ width: 'min(520px, 100%)', maxHeight: '94dvh', overflowY: 'auto', borderRadius: '8px 8px 0 0', border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', padding: 18, paddingBottom: 'calc(22px + env(safe-area-inset-bottom, 0px))', boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}><span style={{ color: 'var(--accent)', fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>{groupRunCountdown(detail.group_run)}</span><h2 id="group-run-detail-title" style={{ color: 'var(--text-primary)', fontSize: 22, fontWeight: 900, margin: '4px 0 0', overflowWrap: 'anywhere' }}>{detail.group_run.title}</h2></div>
              <button type="button" onClick={() => setDetail(null)} aria-label={t('groupRuns.close')} style={{ width: 44, height: 44, flex: '0 0 auto', border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><X size={21} /></button>
            </div>
            <p style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-muted)', fontSize: 12, margin: '12px 0 0' }}><CalendarClock size={16} />{formatGroupRunDate(detail.group_run)}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '5px 0 0' }}>{t('groupRuns.organizedBy', { name: detail.group_run.organizer?.name || t('groupRuns.athlete') })}</p>

            <section style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 16, paddingTop: 16 }}>
              <h3 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}>{t('groupRuns.workout')}</h3>
              <p style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 900, textTransform: 'capitalize', margin: '9px 0 0' }}>{workoutSummary(detail.group_run)}</p>
              {detail.group_run.pace_note && <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '5px 0 0' }}>{detail.group_run.pace_note}</p>}
              {detail.group_run.target_zone && <p style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 850, margin: '5px 0 0' }}>{detail.group_run.target_zone}</p>}
              {detail.group_run.workout_structure && <p style={{ whiteSpace: 'pre-line', color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.55, margin: '11px 0 0' }}>{detail.group_run.workout_structure}</p>}
              {compatibility && <p style={{ color: compatibility.state === 'match' ? 'var(--success)' : compatibility.state === 'different' ? 'var(--warning)' : 'var(--text-muted)', fontSize: 11, fontWeight: 800, margin: '10px 0 0' }}>{compatibility.label}</p>}
              <p style={{ color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.45, margin: '7px 0 0' }}>{t('groupRuns.planSafety')}</p>
            </section>

            <section style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 16, paddingTop: 16 }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}><MapPin size={18} color="var(--accent)" />{t('groupRuns.meetup')}</h3>
              <p style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850, margin: '9px 0 0' }}>{detail.group_run.meetup_area}</p>
              {detail.group_run.meetup_details ? <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '5px 0 0' }}>{detail.group_run.meetup_details}</p> : <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '5px 0 0' }}>{detail.group_run.membership?.status === 'invited' ? t('groupRuns.joinForLogistics') : t('groupRuns.logisticsExpired')}</p>}
              {detail.group_run.notes && <p style={{ color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.5, margin: '10px 0 0' }}>{detail.group_run.notes}</p>}
              {detail.group_run.route && <div style={{ marginTop: 13 }}><RoutePreviewMap route={detail.group_run.route} /></div>}
            </section>

            <section style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 16, paddingTop: 16 }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}><Users size={18} color="var(--accent)" />{t('groupRuns.attendees', { count: detail.members?.length || detail.group_run.participant_count || 1 })}</h3>
              {(detail.members || []).map((member, index) => <div key={member.membership_id || `${member.user?.name}-${index}`} style={{ minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottom: '1px solid var(--border-subtle)' }}><span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 800 }}>{member.masked ? t('groupRuns.hiddenAthlete') : member.is_self ? t('groupRuns.you') : member.user?.name || t('groupRuns.athlete')}{member.is_owner ? ` · ${t('groupRuns.organizer')}` : ''}</span>{member.owner_action?.membership_id && <button type="button" onClick={() => ownerAction('remove_member', member.owner_action.membership_id, member.user?.name)} aria-label={t('groupRuns.removeMember')} title={t('groupRuns.removeMember')} style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: 'var(--danger)', display: 'grid', placeItems: 'center' }}><UserMinus size={16} /></button>}</div>)}
              {detail.group_run.membership?.is_owner && (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 44px', gap: 8, marginTop: 12 }}><select value={inviteeId} onChange={(event) => setInviteeId(event.target.value)} style={{ minHeight: 44, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 10px' }}><option value="">{friends.length ? t('groupRuns.chooseFriend') : t('groupRuns.noFriends')}</option>{friends.map((friend) => <option key={friend.id} value={friend.user.id}>{friend.user.name}</option>)}</select><button type="button" onClick={inviteFriend} disabled={!inviteeId || Boolean(busy)} aria-label={t('groupRuns.invite')} title={t('groupRuns.invite')} style={{ width: 44, height: 44, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', opacity: !inviteeId ? 0.5 : 1 }}><UserPlus size={18} /></button></div>
              )}
            </section>

            {detail.group_run.membership?.status === 'invited' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 18 }}>
                <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => membershipAction(detail.group_run.id, 'join')} style={{ minHeight: 48, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900 }}>{t('groupRuns.join')}</button>
                <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => membershipAction(detail.group_run.id, 'decline')} style={{ minHeight: 48, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-muted)', fontWeight: 850 }}>{t('groupRuns.decline')}</button>
              </div>
            )}
            {detail.group_run.status === 'scheduled' && detail.group_run.membership?.status === 'going' && detail.group_run.meetup_details && <button type="button" className="pressable" onClick={startRun} style={{ width: '100%', minHeight: 50, marginTop: 18, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 950, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Navigation size={19} />{t('groupRuns.start')}</button>}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => membershipAction(detail.group_run.id, 'mute', !detail.group_run.membership?.muted)} style={{ minHeight: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-muted)', padding: '0 11px', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6 }}>{detail.group_run.membership?.muted ? <Bell size={15} /> : <BellOff size={15} />}{detail.group_run.membership?.muted ? t('groupRuns.unmute') : t('groupRuns.mute')}</button>
              {detail.group_run.membership?.is_owner ? detail.group_run.status === 'scheduled' && <>{new Date(detail.group_run.starts_at).getTime() <= Date.now() && <button type="button" onClick={() => ownerAction('complete')} style={{ minHeight: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--success)', padding: '0 11px', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6 }}><Check size={15} />{t('groupRuns.complete')}</button>}<button type="button" onClick={() => ownerAction('cancel')} style={{ minHeight: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--danger)', padding: '0 11px', fontSize: 11, fontWeight: 800 }}>{t('groupRuns.cancel')}</button></> : <><button type="button" onClick={() => setReportOpen(true)} style={{ minHeight: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-muted)', padding: '0 11px', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6 }}><Flag size={15} />{t('groupRuns.report')}</button>{detail.group_run.membership?.status === 'going' && <button type="button" onClick={() => membershipAction(detail.group_run.id, 'leave')} style={{ minHeight: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--danger)', padding: '0 11px', fontSize: 11, fontWeight: 800 }}>{t('groupRuns.leave')}</button>}</>}
            </div>
          </div>
        </div>
      )}

      {reportOpen && detail?.group_run && (
        <div role="dialog" aria-modal="true" aria-labelledby="group-run-report-title" style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.82)', display: 'grid', alignItems: 'end', justifyItems: 'center', padding: 12 }}>
          <div style={{ width: 'min(456px, 100%)', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', padding: 18, paddingBottom: 'calc(18px + env(safe-area-inset-bottom, 0px))' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><h2 id="group-run-report-title" style={{ color: 'var(--text-primary)', fontSize: 18, margin: 0 }}>{t('groupRuns.report')}</h2><button type="button" onClick={() => setReportOpen(false)} aria-label={t('groupRuns.close')} style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><X size={20} /></button></div>
            <select value={reportCategory} onChange={(event) => setReportCategory(event.target.value)} style={{ width: '100%', minHeight: 44, marginTop: 12, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 11px' }}>{REPORT_CATEGORIES.map((category) => <option key={category} value={category}>{t(`groupRuns.reportCategories.${category}`)}</option>)}</select>
            <textarea value={reportNote} onChange={(event) => setReportNote(event.target.value)} maxLength={500} rows={4} placeholder={t('groupRuns.reportNote')} style={{ width: '100%', minHeight: 92, marginTop: 10, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: 11, boxSizing: 'border-box', resize: 'vertical' }} />
            <button type="button" className="pressable" onClick={submitReport} disabled={busy === 'report'} style={{ width: '100%', minHeight: 46, marginTop: 12, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, opacity: busy === 'report' ? 0.55 : 1 }}>{busy === 'report' ? t('groupRuns.reporting') : t('groupRuns.submitReport')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
