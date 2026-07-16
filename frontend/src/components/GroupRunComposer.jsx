import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Check, ChevronLeft, ChevronRight, MapPin, Route, Users, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { fetchDailyExecution } from '../lib/dailyExecution'
import { localDateTimeInput, planRunSnapshot } from '../lib/groupRuns'

const RoutePlanner = lazy(() => import('./RoutePlanner'))

const fieldStyle = {
  width: '100%',
  minHeight: 44,
  borderRadius: 8,
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  padding: '0 11px',
  boxSizing: 'border-box',
}

function initialForm() {
  return {
    title: '',
    starts_at: localDateTimeInput(24),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    duration_minutes: '60',
    run_type: 'social',
    goal_mode: 'distance',
    target_distance_miles: '3',
    target_duration_minutes: '45',
    pace_note: 'Conversational pace',
    target_zone: 'Zone 2',
    workout_structure: '',
    meetup_area: '',
    meetup_details: '',
    notes: '',
    participant_limit: '12',
    friend_ids: [],
  }
}

function FieldLabel({ children, htmlFor }) {
  return <label htmlFor={htmlFor} style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, fontWeight: 850, marginBottom: 6, textTransform: 'uppercase' }}>{children}</label>
}

export default function GroupRunComposer({ friends = [], busy = false, onClose, onSubmit }) {
  const { t } = useTranslation()
  const [step, setStep] = useState(1)
  const [form, setForm] = useState(initialForm)
  const [route, setRoute] = useState(null)
  const [planRun, setPlanRun] = useState(null)
  const [planLoading, setPlanLoading] = useState(false)
  const dateISO = form.starts_at.slice(0, 10)

  useEffect(() => {
    let active = true
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return undefined
    setPlanLoading(true)
    fetchDailyExecution(dateISO)
      .then((execution) => {
        if (active) setPlanRun(execution?.run || null)
      })
      .catch((error) => {
        console.error('[GroupRunComposer] scheduled run fetch failed:', error?.message)
        if (active) setPlanRun(null)
      })
      .finally(() => {
        if (active) setPlanLoading(false)
      })
    return () => { active = false }
  }, [dateISO])

  const routeWorkout = useMemo(() => ({
    distanceMiles: form.goal_mode === 'distance' ? Number(form.target_distance_miles || 0) : 0,
    rawType: form.run_type,
    typeLabel: form.run_type,
  }), [form.goal_mode, form.run_type, form.target_distance_miles])

  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    if (['goal_mode', 'target_distance_miles', 'run_type'].includes(key)) setRoute(null)
  }

  const useScheduledRun = () => {
    const snapshot = planRunSnapshot(planRun)
    if (!snapshot) return
    setForm((current) => ({
      ...current,
      ...Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, value ?? ''])),
      title: current.title || planRun?.title || 'Plan run with friends',
    }))
    setRoute(null)
  }

  const toggleFriend = (friendId) => {
    setForm((current) => ({
      ...current,
      friend_ids: current.friend_ids.includes(friendId)
        ? current.friend_ids.filter((id) => id !== friendId)
        : current.friend_ids.length < Math.max(1, Number(current.participant_limit || 2) - 1)
          ? [...current.friend_ids, friendId]
          : current.friend_ids,
    }))
  }

  const submit = (event) => {
    event.preventDefault()
    const startsAt = new Date(form.starts_at)
    onSubmit?.({
      title: form.title,
      starts_at: startsAt.toISOString(),
      timezone: form.timezone,
      duration_minutes: Number(form.duration_minutes),
      run_type: form.run_type,
      goal_mode: form.goal_mode,
      distance_target_miles: form.goal_mode === 'distance' ? Number(form.target_distance_miles) : null,
      time_target_minutes: form.goal_mode === 'time' ? Number(form.target_duration_minutes) : null,
      pace_note: form.pace_note,
      target_zone: form.target_zone,
      workout_structure: form.workout_structure,
      meetup_area: form.meetup_area,
      meetup_details: form.meetup_details,
      notes: form.notes,
      participant_limit: Number(form.participant_limit),
      friend_ids: form.friend_ids,
      route_json: route,
    })
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="group-run-create-title" style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.78)', display: 'grid', alignItems: 'end', justifyItems: 'center' }}>
      <form onSubmit={submit} style={{ width: 'min(520px, 100%)', maxHeight: '94dvh', overflowY: 'auto', borderRadius: '8px 8px 0 0', border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', padding: 18, paddingBottom: 'calc(22px + env(safe-area-inset-bottom, 0px))', boxSizing: 'border-box' }}>
        <div style={{ position: 'sticky', top: -18, zIndex: 3, margin: '-18px -18px 18px', padding: '14px 18px', background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <p style={{ color: 'var(--accent)', fontSize: 10, fontWeight: 900, textTransform: 'uppercase', margin: 0 }}>{t('groupRuns.step', { step, total: 2 })}</p>
            <h2 id="group-run-create-title" style={{ color: 'var(--text-primary)', fontSize: 19, fontWeight: 900, margin: '3px 0 0' }}>{t('groupRuns.plan')}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={t('groupRuns.close')} style={{ width: 44, height: 44, border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}><X size={21} /></button>
        </div>

        {step === 1 ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}><CalendarClock size={19} color="var(--accent)" /><h3 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}>{t('groupRuns.workout')}</h3></div>
            <div style={{ marginBottom: 13 }}>
              <FieldLabel htmlFor="group-run-title">{t('groupRuns.title')}</FieldLabel>
              <input id="group-run-title" required minLength={3} maxLength={60} value={form.title} onChange={(event) => update('title', event.target.value)} style={fieldStyle} placeholder={t('groupRuns.titlePlaceholder')} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 116px', gap: 8, marginBottom: 13 }}>
              <div><FieldLabel htmlFor="group-run-start">{t('groupRuns.starts')}</FieldLabel><input id="group-run-start" type="datetime-local" required value={form.starts_at} onChange={(event) => update('starts_at', event.target.value)} style={fieldStyle} /></div>
              <div><FieldLabel htmlFor="group-run-length">{t('groupRuns.expected')}</FieldLabel><input id="group-run-length" type="number" min="10" max="480" inputMode="numeric" value={form.duration_minutes} onChange={(event) => update('duration_minutes', event.target.value)} style={fieldStyle} /></div>
            </div>

            {planRun && (
              <button type="button" className="pressable" onClick={useScheduledRun} disabled={planLoading} style={{ width: '100%', minHeight: 44, marginBottom: 13, borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)', fontWeight: 900 }}>
                {t('groupRuns.useScheduled', { title: planRun.title || t('groupRuns.scheduledRun') })}
              </button>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 13 }}>
              <div><FieldLabel htmlFor="group-run-type">{t('groupRuns.runType')}</FieldLabel><select id="group-run-type" value={form.run_type} onChange={(event) => update('run_type', event.target.value)} style={fieldStyle}>{['social', 'easy', 'recovery', 'long', 'tempo', 'intervals', 'hills'].map((value) => <option key={value} value={value}>{t(`groupRuns.types.${value}`)}</option>)}</select></div>
              <div><FieldLabel htmlFor="group-run-goal">{t('groupRuns.goal')}</FieldLabel><select id="group-run-goal" value={form.goal_mode} onChange={(event) => update('goal_mode', event.target.value)} style={fieldStyle}>{['distance', 'time', 'open'].map((value) => <option key={value} value={value}>{t(`groupRuns.goals.${value}`)}</option>)}</select></div>
            </div>
            {form.goal_mode === 'distance' && <div style={{ marginBottom: 13 }}><FieldLabel htmlFor="group-run-distance">{t('groupRuns.distance')}</FieldLabel><input id="group-run-distance" type="number" min="0.25" max="100" step="0.1" inputMode="decimal" value={form.target_distance_miles} onChange={(event) => update('target_distance_miles', event.target.value)} style={fieldStyle} /></div>}
            {form.goal_mode === 'time' && <div style={{ marginBottom: 13 }}><FieldLabel htmlFor="group-run-duration">{t('groupRuns.duration')}</FieldLabel><input id="group-run-duration" type="number" min="10" max="360" inputMode="numeric" value={form.target_duration_minutes} onChange={(event) => update('target_duration_minutes', event.target.value)} style={fieldStyle} /></div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 116px', gap: 8, marginBottom: 13 }}>
              <div><FieldLabel htmlFor="group-run-pace">{t('groupRuns.pace')}</FieldLabel><input id="group-run-pace" maxLength={80} value={form.pace_note} onChange={(event) => update('pace_note', event.target.value)} style={fieldStyle} placeholder={t('groupRuns.pacePlaceholder')} /></div>
              <div><FieldLabel htmlFor="group-run-zone">{t('groupRuns.zone')}</FieldLabel><select id="group-run-zone" value={form.target_zone} onChange={(event) => update('target_zone', event.target.value)} style={fieldStyle}>{['', 'Zone 1', 'Zone 1-2', 'Zone 2', 'Zone 2-3', 'Zone 3', 'Zone 4', 'Zone 5', 'Effort-based'].map((value) => <option key={value || 'none'} value={value}>{value || t('groupRuns.noZone')}</option>)}</select></div>
            </div>
            <div style={{ marginBottom: 8 }}><FieldLabel htmlFor="group-run-structure">{t('groupRuns.structure')}</FieldLabel><textarea id="group-run-structure" required rows={4} maxLength={500} value={form.workout_structure} onChange={(event) => update('workout_structure', event.target.value)} style={{ ...fieldStyle, minHeight: 96, padding: 11, resize: 'vertical' }} placeholder={t('groupRuns.structurePlaceholder')} /></div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}><MapPin size={19} color="var(--accent)" /><h3 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}>{t('groupRuns.meetup')}</h3></div>
            <div style={{ marginBottom: 13 }}><FieldLabel htmlFor="group-run-area">{t('groupRuns.area')}</FieldLabel><input id="group-run-area" required minLength={2} maxLength={80} value={form.meetup_area} onChange={(event) => update('meetup_area', event.target.value)} style={fieldStyle} placeholder={t('groupRuns.areaPlaceholder')} /></div>
            <div style={{ marginBottom: 13 }}><FieldLabel htmlFor="group-run-details">{t('groupRuns.exactMeetup')}</FieldLabel><textarea id="group-run-details" required minLength={2} rows={3} maxLength={160} value={form.meetup_details} onChange={(event) => update('meetup_details', event.target.value)} style={{ ...fieldStyle, minHeight: 78, padding: 11, resize: 'vertical' }} placeholder={t('groupRuns.exactPlaceholder')} /></div>
            <div style={{ marginBottom: 13 }}><FieldLabel htmlFor="group-run-notes">{t('groupRuns.notes')}</FieldLabel><textarea id="group-run-notes" rows={3} maxLength={500} value={form.notes} onChange={(event) => update('notes', event.target.value)} style={{ ...fieldStyle, minHeight: 78, padding: 11, resize: 'vertical' }} placeholder={t('groupRuns.notesPlaceholder')} /></div>

            {form.goal_mode === 'distance' && Number(form.target_distance_miles) >= 0.5 && (
              <Suspense fallback={<p style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t('groupRuns.routeLoading')}</p>}>
                <RoutePlanner workout={routeWorkout} title={t('groupRuns.routeTitle')} startLabel={t('groupRuns.useRoute')} onStart={(nextRoute, surface) => setRoute({ ...nextRoute, surface })} />
              </Suspense>
            )}
            {route && <p role="status" style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--success)', fontSize: 12, fontWeight: 850, margin: '10px 0 14px' }}><Check size={16} />{t('groupRuns.routeReady')}</p>}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 0 8px' }}><Users size={19} color="var(--accent)" /><h3 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 900, margin: 0 }}>{t('groupRuns.inviteFriends')}</h3></div>
            {friends.length ? (
              <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
                {friends.map((friend) => {
                  const selected = form.friend_ids.includes(friend.user.id)
                  return (
                    <label key={friend.id} style={{ minHeight: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 800 }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{friend.user.name}{friend.user.handle ? ` · @${friend.user.handle}` : ''}</span>
                      <input type="checkbox" checked={selected} disabled={!selected && form.friend_ids.length >= Math.max(1, Number(form.participant_limit || 2) - 1)} onChange={() => toggleFriend(friend.user.id)} style={{ width: 20, height: 20, accentColor: 'var(--accent)' }} />
                    </label>
                  )
                })}
              </div>
            ) : <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>{t('groupRuns.noFriends')}</p>}
            <div style={{ marginTop: 14 }}><FieldLabel htmlFor="group-run-limit">{t('groupRuns.limit')}</FieldLabel><input id="group-run-limit" type="number" min="2" max="25" inputMode="numeric" value={form.participant_limit} onChange={(event) => { const value = event.target.value; setForm((current) => ({ ...current, participant_limit: value, friend_ids: current.friend_ids.slice(0, Math.max(1, Number(value || 2) - 1)) })) }} style={{ ...fieldStyle, maxWidth: 120 }} /></div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: step === 1 ? '1fr' : '0.7fr 1.3fr', gap: 8, marginTop: 20 }}>
          {step === 2 && <button type="button" className="pressable" onClick={() => setStep(1)} style={{ minHeight: 46, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}><ChevronLeft size={18} />{t('groupRuns.back')}</button>}
          {step === 1 ? (
            <button type="button" className="pressable" onClick={() => setStep(2)} disabled={!form.title.trim() || !form.starts_at || !form.workout_structure.trim()} style={{ minHeight: 48, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: !form.title.trim() || !form.starts_at || !form.workout_structure.trim() ? 0.55 : 1 }}>{t('groupRuns.next')}<ChevronRight size={18} /></button>
          ) : (
            <button type="submit" className="pressable" disabled={busy || !form.meetup_area.trim() || !form.meetup_details.trim()} style={{ minHeight: 48, borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: busy ? 0.55 : 1 }}><Route size={18} />{busy ? t('groupRuns.creating') : t('groupRuns.create')}</button>
          )}
        </div>
      </form>
    </div>
  )
}
