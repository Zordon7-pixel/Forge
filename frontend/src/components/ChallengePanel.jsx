import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bell,
  BellOff,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  Dumbbell,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trophy,
  UserPlus,
  X,
} from 'lucide-react'
import api from '../lib/api'

const TEMPLATE_OPTIONS = [
  'running_distance',
  'running_time',
  'running_consistency',
  'strength_consistency',
  'hybrid_balance',
]

function localDateInputValue() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}

function initialForm() {
  return {
    name: '',
    description: '',
    template_type: 'hybrid_balance',
    start_date: localDateInputValue(),
    duration_days: '14',
    run_target: '20',
    run_unit: 'miles',
    lift_target: '3',
    verification_policy: 'all_activity',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }
}

function templateNeedsRun(template) {
  return template !== 'strength_consistency'
}

function templateNeedsLift(template) {
  return template === 'strength_consistency' || template === 'hybrid_balance'
}

function targetText(challenge, t) {
  if (challenge.template_type === 'running_distance') {
    return t('challenges.distanceTarget', { value: challenge.run_target, unit: t(`challenges.unit.${challenge.run_unit}`) })
  }
  if (challenge.template_type === 'running_time') {
    return t('challenges.timeTarget', { value: challenge.run_target })
  }
  if (challenge.template_type === 'running_consistency') {
    return t('challenges.runDaysTarget', { value: challenge.run_target })
  }
  if (challenge.template_type === 'strength_consistency') {
    return t('challenges.liftTarget', { value: challenge.lift_target })
  }
  return t('challenges.hybridTarget', {
    run: challenge.run_target,
    unit: t(`challenges.unit.${challenge.run_unit}`),
    lifts: challenge.lift_target,
  })
}

function ChallengeCard({ challenge, busy, onOpen, onMembership }) {
  const { t } = useTranslation()
  const invited = challenge.membership?.status === 'invited'
  return (
    <article style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ color: invited ? 'var(--accent)' : 'var(--text-muted)', fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>
            {invited ? t('challenges.invitation') : t(`challenges.template.${challenge.template_type}`)}
          </span>
          <h3 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: '4px 0 0', overflowWrap: 'anywhere' }}>{challenge.name}</h3>
        </div>
        <span style={{ flex: '0 0 auto', color: 'var(--text-muted)', fontSize: 11, fontWeight: 800 }}>{challenge.participant_count}/{challenge.participant_limit}</span>
      </div>
      <p style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 800, margin: '12px 0 0' }}>{targetText(challenge, t)}</p>
      <p style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 11, margin: '6px 0 0' }}>
        <CalendarDays size={14} /> {challenge.start_date} - {challenge.end_date}
      </p>
      {invited ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 14 }}>
          <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => onMembership(challenge.id, 'join')} style={{ minHeight: 44, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}><Check size={17} />{t('challenges.join')}</button>
          <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => onMembership(challenge.id, 'decline')} style={{ minHeight: 44, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', color: 'var(--text-muted)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}><X size={17} />{t('challenges.decline')}</button>
        </div>
      ) : (
        <button type="button" className="pressable" onClick={() => onOpen(challenge.id)} disabled={Boolean(busy)} style={{ width: '100%', minHeight: 44, marginTop: 14, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px' }}>
          {t('challenges.open')}<ChevronRight size={18} />
        </button>
      )}
    </article>
  )
}

export default function ChallengePanel({ friends = [] }) {
  const { t } = useTranslation()
  const [challenges, setChallenges] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(initialForm)
  const [detail, setDetail] = useState(null)
  const [inviteeId, setInviteeId] = useState('')

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const response = await api.get('/challenges')
      setChallenges(response.data?.challenges || [])
    } catch (error) {
      console.error('[ChallengePanel] load failed:', error?.message)
      setNotice({ type: 'error', text: t('challenges.loadError') })
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  const invitations = useMemo(() => challenges.filter((challenge) => challenge.membership?.status === 'invited'), [challenges])
  const joined = useMemo(() => challenges.filter((challenge) => challenge.membership?.status === 'joined'), [challenges])

  const loadDetail = async (challengeId) => {
    setBusy(`detail-${challengeId}`)
    setNotice(null)
    try {
      const response = await api.get(`/challenges/${challengeId}`)
      setDetail(response.data)
      setInviteeId('')
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('challenges.actionError') })
    } finally {
      setBusy('')
    }
  }

  const refreshDetail = async (challengeId) => {
    const response = await api.get(`/challenges/${challengeId}`)
    setDetail(response.data)
  }

  const membershipAction = async (challengeId, action, muted) => {
    setBusy(`${action}-${challengeId}`)
    setNotice(null)
    try {
      await api.patch(`/challenges/${challengeId}/membership`, { action, ...(action === 'mute' ? { muted } : {}) })
      setNotice({ type: 'success', text: t(`challenges.${action}Success`) })
      await load({ quiet: true })
      if (action === 'join' || action === 'mute') await refreshDetail(challengeId)
      else if (detail?.challenge?.id === challengeId) setDetail(null)
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('challenges.actionError') })
    } finally {
      setBusy('')
    }
  }

  const createChallenge = async (event) => {
    event.preventDefault()
    setBusy('create')
    setNotice(null)
    try {
      const payload = {
        ...form,
        duration_days: Number(form.duration_days),
        run_target: templateNeedsRun(form.template_type) ? Number(form.run_target) : null,
        lift_target: templateNeedsLift(form.template_type) ? Number(form.lift_target) : null,
      }
      const response = await api.post('/challenges', payload)
      setForm(initialForm())
      setShowCreate(false)
      setNotice({ type: 'success', text: t('challenges.createSuccess') })
      await load({ quiet: true })
      await loadDetail(response.data.challenge_id)
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('challenges.actionError') })
    } finally {
      setBusy('')
    }
  }

  const inviteFriend = async () => {
    if (!detail?.challenge?.id || !inviteeId) return
    setBusy('invite')
    setNotice(null)
    try {
      const response = await api.post(`/challenges/${detail.challenge.id}/invite`, { friend_id: inviteeId })
      setNotice({ type: 'success', text: response.data?.status === 'already_invited' ? t('challenges.alreadyInvited') : t('challenges.inviteSuccess') })
      setInviteeId('')
      await refreshDetail(detail.challenge.id)
      await load({ quiet: true })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('challenges.actionError') })
    } finally {
      setBusy('')
    }
  }

  const cancelChallenge = async () => {
    if (!detail?.challenge?.id || !window.confirm(t('challenges.cancelConfirm'))) return
    setBusy('cancel')
    try {
      await api.patch(`/challenges/${detail.challenge.id}`, { action: 'cancel' })
      setDetail(null)
      setNotice({ type: 'success', text: t('challenges.cancelSuccess') })
      await load({ quiet: true })
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.error || t('challenges.actionError') })
    } finally {
      setBusy('')
    }
  }

  const leaveChallenge = () => {
    if (!detail?.challenge?.id || !window.confirm(t('challenges.leaveConfirm'))) return
    membershipAction(detail.challenge.id, 'leave')
  }

  const current = detail?.challenge
  const progress = detail?.my_progress

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {notice && (
        <div role="status" style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${notice.type === 'success' ? 'color-mix(in srgb, var(--success) 45%, transparent)' : 'color-mix(in srgb, var(--danger) 45%, transparent)'}`, background: notice.type === 'success' ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--danger) 12%, transparent)', color: notice.type === 'success' ? 'var(--success)' : 'var(--danger)', fontSize: 13, fontWeight: 750 }}>
          {notice.text}
        </div>
      )}

      {current && (
        <section style={{ borderTop: '2px solid var(--accent)', borderBottom: '1px solid var(--border-subtle)', padding: '16px 0 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ color: 'var(--accent)', fontSize: 10, fontWeight: 900, textTransform: 'uppercase', margin: 0 }}>{t(`challenges.template.${current.template_type}`)}</p>
              <h2 style={{ color: 'var(--text-primary)', fontSize: 20, fontWeight: 900, margin: '5px 0 0', overflowWrap: 'anywhere' }}>{current.name}</h2>
            </div>
            <button type="button" className="pressable" aria-label={t('challenges.close')} title={t('challenges.close')} onClick={() => setDetail(null)} style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><X size={20} /></button>
          </div>
          <p style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 850, margin: '14px 0 0' }}>{targetText(current, t)}</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '5px 0 0' }}>{current.start_date} - {current.end_date} · {current.participant_count}/{current.participant_limit}</p>

          {progress && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>
                <span>{t('challenges.yourProgress')}</span><span>{progress.percent}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-input)', overflow: 'hidden', marginTop: 8 }}>
                <div style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%`, height: '100%', background: 'var(--accent)' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: progress.run && progress.lift ? '1fr 1fr' : '1fr', gap: 8, marginTop: 10 }}>
                {progress.run && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}><Clock3 size={14} style={{ display: 'inline', marginRight: 5 }} />{progress.run.value}/{progress.run.target} {t(`challenges.unit.${progress.run.unit}`)}</p>}
                {progress.lift && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}><Dumbbell size={14} style={{ display: 'inline', marginRight: 5 }} />{progress.lift.value}/{progress.lift.target} {t('challenges.unit.sessions')}</p>}
              </div>
            </div>
          )}

          <p style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5, margin: '14px 0 0' }}>{t('challenges.planSafety')}</p>

          {current.membership?.role === 'owner' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 44px', gap: 8, marginTop: 16 }}>
              <select aria-label={t('challenges.chooseFriend')} value={inviteeId} onChange={(event) => setInviteeId(event.target.value)} style={{ minWidth: 0, width: '100%', minHeight: 44, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 10px' }}>
                <option value="">{friends.length ? t('challenges.chooseFriend') : t('challenges.noFriends')}</option>
                {friends.map((friend) => <option key={friend.user.id} value={friend.user.id}>{friend.user.name}{friend.user.handle ? ` (@${friend.user.handle})` : ''}</option>)}
              </select>
              <button type="button" className="pressable" title={t('challenges.inviteFriend')} aria-label={t('challenges.inviteFriend')} disabled={!inviteeId || Boolean(busy)} onClick={inviteFriend} style={{ width: 44, height: 44, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', opacity: !inviteeId || Boolean(busy) ? 0.5 : 1 }}><UserPlus size={18} /></button>
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            <button type="button" className="pressable" disabled={Boolean(busy)} onClick={() => membershipAction(current.id, 'mute', !current.membership?.muted)} style={{ minHeight: 40, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 11px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 800 }}>
              {current.membership?.muted ? <Bell size={15} /> : <BellOff size={15} />}{current.membership?.muted ? t('challenges.unmute') : t('challenges.mute')}
            </button>
            {current.membership?.role === 'owner' ? (
              <button type="button" className="pressable" disabled={Boolean(busy)} onClick={cancelChallenge} style={{ minHeight: 40, borderRadius: 8, border: '1px solid color-mix(in srgb, var(--danger) 45%, transparent)', background: 'transparent', color: 'var(--danger)', padding: '0 11px', fontSize: 12, fontWeight: 800 }}>{t('challenges.cancel')}</button>
            ) : (
              <button type="button" className="pressable" disabled={Boolean(busy)} onClick={leaveChallenge} style={{ minHeight: 40, borderRadius: 8, border: '1px solid color-mix(in srgb, var(--danger) 45%, transparent)', background: 'transparent', color: 'var(--danger)', padding: '0 11px', fontSize: 12, fontWeight: 800 }}>{t('challenges.leave')}</button>
            )}
          </div>
        </section>
      )}

      <button type="button" className="pressable" onClick={() => setShowCreate((value) => !value)} style={{ width: '100%', minHeight: 46, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {showCreate ? <X size={18} /> : <Plus size={18} />}{showCreate ? t('challenges.closeCreate') : t('challenges.create')}
      </button>

      {showCreate && (
        <form onSubmit={createChallenge} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 14, background: 'var(--bg-card)', display: 'grid', gap: 12 }}>
          <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('challenges.name')}
            <input required minLength={3} maxLength={60} value={form.name} onChange={(event) => setForm((currentForm) => ({ ...currentForm, name: event.target.value }))} style={{ width: '100%', minHeight: 44, marginTop: 6, boxSizing: 'border-box', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 11px' }} />
          </label>
          <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('challenges.templateLabel')}
            <select value={form.template_type} onChange={(event) => setForm((currentForm) => ({ ...currentForm, template_type: event.target.value }))} style={{ width: '100%', minHeight: 44, marginTop: 6, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 11px' }}>
              {TEMPLATE_OPTIONS.map((template) => <option key={template} value={template}>{t(`challenges.template.${template}`)}</option>)}
            </select>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
            <label style={{ minWidth: 0, color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('challenges.startDate')}
              <input type="date" required value={form.start_date} min={localDateInputValue()} onChange={(event) => setForm((currentForm) => ({ ...currentForm, start_date: event.target.value }))} style={{ width: '100%', minWidth: 0, minHeight: 44, marginTop: 6, boxSizing: 'border-box', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 8px' }} />
            </label>
            <label style={{ minWidth: 0, color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('challenges.duration')}
              <select value={form.duration_days} onChange={(event) => setForm((currentForm) => ({ ...currentForm, duration_days: event.target.value }))} style={{ width: '100%', minHeight: 44, marginTop: 6, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 8px' }}>
                {[7, 14, 30].map((days) => <option key={days} value={days}>{t('challenges.days', { count: days })}</option>)}
              </select>
            </label>
          </div>

          {templateNeedsRun(form.template_type) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
              <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{form.template_type === 'running_consistency' ? t('challenges.runDays') : form.template_type === 'running_time' ? t('challenges.runMinutes') : t('challenges.runDistance')}
                <input type="number" min="1" step={form.template_type === 'running_distance' || form.template_type === 'hybrid_balance' ? '0.1' : '1'} required value={form.run_target} onChange={(event) => setForm((currentForm) => ({ ...currentForm, run_target: event.target.value }))} style={{ width: '100%', minHeight: 44, marginTop: 6, boxSizing: 'border-box', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 11px' }} />
              </label>
              {(form.template_type === 'running_distance' || form.template_type === 'hybrid_balance') ? (
                <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('challenges.distanceUnit')}
                  <select value={form.run_unit} onChange={(event) => setForm((currentForm) => ({ ...currentForm, run_unit: event.target.value }))} style={{ width: '100%', minHeight: 44, marginTop: 6, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 8px' }}>
                    <option value="miles">{t('challenges.unit.miles')}</option>
                    <option value="kilometers">{t('challenges.unit.kilometers')}</option>
                  </select>
                </label>
              ) : <span />}
            </div>
          )}

          {templateNeedsLift(form.template_type) && (
            <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('challenges.liftSessions')}
              <input type="number" min="1" step="1" required value={form.lift_target} onChange={(event) => setForm((currentForm) => ({ ...currentForm, lift_target: event.target.value }))} style={{ width: '100%', minHeight: 44, marginTop: 6, boxSizing: 'border-box', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 11px' }} />
            </label>
          )}

          <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('challenges.verification')}
            <select value={form.verification_policy} onChange={(event) => setForm((currentForm) => ({ ...currentForm, verification_policy: event.target.value }))} style={{ width: '100%', minHeight: 44, marginTop: 6, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 11px' }}>
              <option value="all_activity">{t('challenges.allActivity')}</option>
              <option value="device_only">{t('challenges.deviceOnly')}</option>
            </select>
          </label>
          <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 850 }}>{t('challenges.description')}
            <textarea maxLength={280} rows={3} value={form.description} onChange={(event) => setForm((currentForm) => ({ ...currentForm, description: event.target.value }))} style={{ width: '100%', marginTop: 6, boxSizing: 'border-box', resize: 'vertical', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', padding: 11 }} />
          </label>
          <button type="submit" className="pressable" disabled={Boolean(busy)} style={{ minHeight: 46, border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, opacity: Boolean(busy) ? 0.55 : 1 }}>{busy === 'create' ? t('challenges.creating') : t('challenges.createSubmit')}</button>
        </form>
      )}

      {loading ? (
        <div style={{ minHeight: 160, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}><RefreshCw size={24} className="animate-spin" aria-label={t('challenges.loading')} /></div>
      ) : (
        <>
          <section style={{ display: 'grid', gap: 10 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, color: 'var(--text-primary)', fontSize: 16, fontWeight: 900 }}><Trophy size={18} color="var(--accent)" />{t('challenges.active')}</h2>
            {joined.length ? joined.map((challenge) => <ChallengeCard key={challenge.id} challenge={challenge} busy={busy} onOpen={loadDetail} onMembership={membershipAction} />) : (
              <div style={{ padding: '24px 8px', textAlign: 'center' }}>
                <Trophy size={28} color="var(--text-muted)" style={{ margin: '0 auto 10px' }} />
                <h3 style={{ color: 'var(--text-primary)', fontSize: 15, margin: 0 }}>{t('challenges.emptyTitle')}</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.55, maxWidth: 330, margin: '6px auto 0' }}>{t('challenges.emptyBody')}</p>
              </div>
            )}
          </section>
          {invitations.length > 0 && (
            <section style={{ display: 'grid', gap: 10 }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, color: 'var(--text-primary)', fontSize: 16, fontWeight: 900 }}><ShieldCheck size={18} color="var(--accent)" />{t('challenges.invitations')}</h2>
              {invitations.map((challenge) => <ChallengeCard key={challenge.id} challenge={challenge} busy={busy} onOpen={loadDetail} onMembership={membershipAction} />)}
            </section>
          )}
          <button type="button" className="pressable" onClick={() => load()} disabled={loading || Boolean(busy)} style={{ justifySelf: 'center', minHeight: 40, border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800 }}><RefreshCw size={15} />{t('challenges.refresh')}</button>
        </>
      )}
    </div>
  )
}
