import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ShieldCheck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import api from '../../lib/api'
import { activateModalDialog } from '../../lib/modalDialog'
import { phonePlanningClock } from '../../lib/planCandidates'
import { hyroxCandidateReviewModel } from '../../lib/planCalendar'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const RULES_VERSION = '2026-2027'
const EQUIPMENT = [
  ['ski_erg', 'SkiErg'], ['row_erg', 'RowErg'], ['sled_push', 'Sled push'],
  ['sled_pull', 'Sled pull'], ['wall_ball_target', 'Wall ball + target'],
  ['sandbag', 'Sandbag'], ['farmers_carry', 'Kettlebells / dumbbells for carry'],
  ['treadmill', 'Treadmill / indoor running'],
]

function localTodayISO() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return Boolean(value)
  } catch {
    return false
  }
}

function planFromPreview(preview = {}) {
  return preview?.plan?.plan_data || preview?.candidate?.plan_data || {}
}

export default function HyroxPlanSetup({ savedRaces = [], onClose, onComplete }) {
  const { t } = useTranslation()
  const dialogRef = useRef(null)
  const tx = (key, defaultValue, values = {}) => t(`hyrox.${key}`, { defaultValue, ...values })
  const [eventMode, setEventMode] = useState('event_date')
  const [eventName, setEventName] = useState('')
  const [eventLocalDate, setEventLocalDate] = useState('')
  const [eventTimezone, setEventTimezone] = useState(browserTimezone)
  const [location, setLocation] = useState('')
  const [eventFormat, setEventFormat] = useState('individual_open')
  const [eventCategory, setEventCategory] = useState('')
  const [rulesVersion] = useState(RULES_VERSION)
  const [runningPriority, setRunningPriority] = useState('maintain')
  const [equipment, setEquipment] = useState([])
  const [runDaysPerWeek, setRunDaysPerWeek] = useState(3)
  const [trainingDays, setTrainingDays] = useState(['Tue', 'Thu', 'Sat', 'Sun'])
  const [secondaryRaceId, setSecondaryRaceId] = useState('')
  const [ownedHyroxRace, setOwnedHyroxRace] = useState(null)
  const [candidate, setCandidate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const review = useMemo(() => candidate ? hyroxCandidateReviewModel(planFromPreview(candidate)) : null, [candidate])
  const secondaryRaces = useMemo(() => savedRaces.filter((race) => (
    String(race.event_kind || 'run_race') === 'run_race'
    && (!eventLocalDate || String(race.race_date) > eventLocalDate)
  )), [eventLocalDate, savedRaces])

  useEffect(() => activateModalDialog({
    dialog: dialogRef.current,
    onClose: () => { if (!busy) onClose?.() },
  }), [busy, onClose])

  const toggleEquipment = (key) => setEquipment((current) => (
    current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
  ))
  const toggleDay = (day) => setTrainingDays((current) => (
    current.includes(day) ? current.filter((item) => item !== day) : DAYS.filter((item) => [...current, day].includes(item))
  ))

  const validate = () => {
    if (!eventName.trim()) return tx('error.name', 'Enter the event or foundation name.')
    if (!validTimezone(eventTimezone)) return tx('error.timezone', 'Enter a valid IANA time zone, such as America/New_York.')
    if (eventMode === 'event_date' && (!/^\d{4}-\d{2}-\d{2}$/.test(eventLocalDate) || eventLocalDate < localTodayISO())) {
      return tx('error.date', 'Choose today or a future local event date.')
    }
    if (!eventFormat || !eventCategory || (eventFormat.startsWith('individual_') && eventCategory === 'mixed')) return tx('error.division', 'Choose a supported format and category.')
    if (![3, 4].includes(Number(runDaysPerWeek))) return tx('error.runs', 'Choose three or four run days per week.')
    if (trainingDays.length < runDaysPerWeek) return tx('error.days', 'Available training days must fit every weekly run exposure.')
    if (secondaryRaceId) {
      const race = secondaryRaces.find((item) => String(item.id) === String(secondaryRaceId))
      const gap = race ? Math.round((new Date(`${race.race_date}T12:00:00`) - new Date(`${eventLocalDate}T12:00:00`)) / 86400000) : 0
      if (gap < 21) return tx('error.secondary', 'The secondary running race must be at least 21 days after HYROX.')
    }
    return ''
  }

  const target = () => ({
    planMode: 'hyrox_build',
    runDaysPerWeek: Number(runDaysPerWeek),
    trainingDays,
    liftingEnabled: true,
    hyroxEquipment: equipment,
  })

  const eventPayload = () => ({
    race_name: eventName.trim(),
    race_date: eventLocalDate,
    event_local_date: eventLocalDate,
    event_timezone: eventTimezone.trim(),
    event_kind: 'hyrox',
    event_format: eventFormat,
    event_category: eventCategory,
    rules_version: rulesVersion,
    location: location.trim() || null,
    status: 'upcoming',
    event_config_json: { schemaVersion: 1, canonicalUnits: 'metric', equipment, runningPriority },
  })

  const requestPreview = async () => {
    const validationError = validate()
    if (validationError) { setError(validationError); return }
    setBusy(true)
    setError('')
    let savedRace = ownedHyroxRace
    try {
      const clock = phonePlanningClock()
      if (eventMode === 'foundation') {
        const { data } = await api.post('/plans/generate', {
          target: {
            ...target(),
            weeks: 8,
            hyroxEvent: {
              name: eventName.trim(), eventLocalDate: null, eventTimezone: eventTimezone.trim(),
              format: eventFormat, category: eventCategory, rulesVersion, runningPriority,
              canonicalUnits: 'metric',
            },
          },
          ...clock,
        })
        setCandidate(data)
        return
      }

      const saved = savedRace
        ? await api.patch(`/races/${encodeURIComponent(savedRace.id)}`, eventPayload())
        : await api.post('/races', eventPayload())
      savedRace = saved.data?.race
      setOwnedHyroxRace(savedRace)
      if (!savedRace?.id) throw new Error('The HYROX event could not be saved.')
      const raceIds = [savedRace.id, secondaryRaceId].filter(Boolean)
      const path = raceIds.length > 1 ? '/plans/generate-for-races' : `/plans/generate-for-race/${encodeURIComponent(savedRace.id)}`
      const { data } = await api.post(path, { race_ids: raceIds, target: target(), ...clock })
      setCandidate(data)
    } catch (err) {
      const prefix = savedRace ? 'Your HYROX event was saved, but the plan preview was not created. ' : ''
      setError(prefix + (err?.response?.data?.error || err?.message || 'Could not preview this plan.'))
    } finally {
      setBusy(false)
    }
  }

  const applyCandidate = async () => {
    if (!candidate || busy) return
    setBusy(true)
    setError('')
    try {
      const candidateId = String(candidate.candidate_id || '')
      const candidateHash = String(candidate.candidate_hash || '')
      if (!candidateId || !candidateHash) throw new Error('The reviewed plan is missing its apply token. Preview again.')
      await api.post(`/plans/candidates/${encodeURIComponent(candidateId)}/apply`, {
        candidate_hash: candidateHash,
        choice: 'train_for_target',
        ...phonePlanningClock(),
      })
      onComplete?.()
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Could not apply this plan. Your current calendar is unchanged.')
    } finally {
      setBusy(false)
    }
  }

  const inputStyle = { width: '100%', minWidth: 0, minHeight: 44, padding: '11px 12px', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 15 }

  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'grid', alignItems: 'end', justifyItems: 'center', boxSizing: 'border-box', overflow: 'hidden', paddingTop: 'max(10px, env(safe-area-inset-top, 0px))', paddingRight: 10, paddingBottom: 'max(10px, env(safe-area-inset-bottom, 0px))', paddingLeft: 10, background: 'rgba(0,0,0,0.76)' }}>
      <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="hyrox-setup-title" style={{ width: 'min(680px, 100%)', maxWidth: '100%', minWidth: 0, maxHeight: '100%', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', overflow: 'hidden', borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '16px 16px 0' }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, color: 'var(--accent)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>{tx('eyebrow', 'Worldwide event plan')}</p>
            <h2 id="hyrox-setup-title" style={{ margin: '4px 0 0', color: 'var(--text-primary)', fontSize: 24, fontWeight: 950 }}>{candidate ? tx('review.title', 'Review your HYROX plan') : tx('title', 'Build a HYROX plan')}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={tx('close', 'Close HYROX setup')} style={{ width: 44, height: 44, flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}><X size={19} /></button>
        </header>

        <div data-hyrox-scrollport style={{ minWidth: 0, minHeight: 0, overflowX: 'hidden', overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 16px 18px', scrollPaddingBottom: 18 }}>
          {error && <p role="alert" aria-live="assertive" style={{ margin: '12px 0 0', padding: 12, borderRadius: 8, background: 'var(--danger-dim)', color: 'var(--danger)', fontSize: 13, fontWeight: 750 }}>{error}</p>}

        {candidate && review ? (
          <div style={{ display: 'grid', gap: 12, marginTop: 16, minWidth: 0 }}>
            <div role="status" style={{ padding: 14, borderRadius: 10, background: 'var(--accent-dim)', border: '1px solid var(--accent)', minWidth: 0 }}>
              <p style={{ margin: 0, color: 'var(--accent)', fontSize: 12, fontWeight: 900 }}>{review.runwayLabel}</p>
              <p style={{ margin: '5px 0 0', color: 'var(--text-primary)', fontSize: 22, fontWeight: 950 }}>
                {review.daysRemaining == null ? tx('review.foundation', 'Eight-week foundation · no event date') : tx('review.days_value', '{{count}} days remaining', { count: review.daysRemaining })}
              </p>
              <p style={{ margin: '5px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>{review.sessionSummary}</p>
            </div>
            <dl style={{ display: 'grid', gap: 10, margin: 0, minWidth: 0 }}>
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-input)' }}>
                <dt style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Days remaining</dt>
                <dd style={{ margin: '4px 0 0', color: 'var(--text-primary)' }}>{review.daysRemaining == null ? 'No dated event' : review.daysRemaining}</dd>
              </div>
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-input)' }}>
                <dt style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Phase sequence</dt>
                <dd style={{ margin: '4px 0 0', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{review.phaseLabels.join(' → ')}</dd>
              </div>
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-input)' }}>
                <dt style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Week and session summary</dt>
                <dd style={{ margin: '4px 0 0', color: 'var(--text-primary)' }}>{review.weekCount} weeks · {review.sessionSummary}</dd>
              </div>
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-input)' }}>
                <dt style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Equipment and substitutions</dt>
                <dd style={{ margin: '4px 0 0', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{review.equipmentTruth}</dd>
              </div>
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-input)' }}>
                <dt style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Hard-day safety</dt>
                <dd style={{ margin: '4px 0 0', color: 'var(--text-primary)' }}>{review.safetyPolicy}</dd>
              </div>
              {review.recoveryTransition && (
                <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-input)' }}>
                  <dt style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', textTransform: 'uppercase' }}>After HYROX</dt>
                  <dd style={{ margin: '4px 0 0', color: 'var(--text-primary)' }}>{review.recoveryTransition}</dd>
                </div>
              )}
            </dl>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>Canonical station distances, loads, and repetitions remain metric. Locale conversion is display-only.</p>
            <button type="button" onClick={applyCandidate} disabled={busy} style={{ width: '100%', minHeight: 48, borderRadius: 8, border: 0, background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 15, fontWeight: 950, opacity: busy ? 0.6 : 1 }}>
              {busy ? tx('review.applying', 'Applying reviewed plan…') : tx('review.apply', 'Apply reviewed HYROX plan')}
            </button>
            <button type="button" onClick={() => { setCandidate(null); setError('') }} disabled={busy} style={{ width: '100%', minHeight: 44, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14, fontWeight: 800 }}><ChevronLeft size={16} style={{ display: 'inline', marginRight: 5, verticalAlign: -3 }} />Back to setup</button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 16, marginTop: 16, minWidth: 0 }}>
            <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
              <legend style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 900 }}>{tx('mode.legend', 'Plan mode')}</legend>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 8 }}>
                {[
                  ['event_date', tx('mode.dated', 'I have an event date')],
                  ['foundation', tx('mode.foundation', 'Build an 8-week foundation')],
                ].map(([value, label]) => (
                  <button key={value} type="button" aria-pressed={eventMode === value} onClick={() => { setEventMode(value); setCandidate(null); setSecondaryRaceId('') }} style={{ minWidth: 0, minHeight: 52, padding: '9px 10px', borderRadius: 8, background: eventMode === value ? 'var(--accent-dim)' : 'var(--bg-input)', color: eventMode === value ? 'var(--accent)' : 'var(--text-primary)', border: `1px solid ${eventMode === value ? 'var(--accent)' : 'var(--border-subtle)'}`, fontSize: 12, fontWeight: 850 }}>
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
            <section aria-labelledby="hyrox-schedule-title">
              <h3 id="hyrox-schedule-title" style={{ margin: 0, color: 'var(--text-primary)', fontSize: 14, fontWeight: 900 }}>{tx('schedule.title', 'Weekly availability')}</h3>
              <label style={{ display: 'grid', gap: 6, marginTop: 9 }}>
                <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('schedule.runs', 'Run days per week')}</span>
                <select value={runDaysPerWeek} onChange={(event) => setRunDaysPerWeek(Number(event.target.value))} style={inputStyle}>
                  <option value="3">3 run days</option><option value="4">4 run days</option>
                </select>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 5, marginTop: 9 }} aria-label={tx('schedule.days', 'Available training days')}>
                {DAYS.map((day) => {
                  const selected = trainingDays.includes(day)
                  return <button key={day} type="button" aria-pressed={selected} onClick={() => toggleDay(day)} style={{ minWidth: 0, minHeight: 44, padding: '8px 2px', borderRadius: 7, background: selected ? 'var(--accent-dim)' : 'var(--bg-input)', color: selected ? 'var(--accent)' : 'var(--text-muted)', border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`, fontSize: 10, fontWeight: 900 }}>{day}</button>
                })}
              </div>
            </section>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{eventMode === 'event_date' ? tx('field.name', 'Event name') : tx('field.foundation_name', 'Foundation block name')}</span>
              <input value={eventName} onChange={(event) => setEventName(event.target.value)} maxLength={200} placeholder={tx('field.name_placeholder', 'HYROX city or training block')} style={inputStyle} />
            </label>
            {eventMode === 'event_date' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, minWidth: 0 }}>
                <label style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('field.date', 'Exact local event date')}</span>
                  <input type="date" min={localTodayISO()} value={eventLocalDate} onChange={(event) => { setEventLocalDate(event.target.value); setSecondaryRaceId('') }} style={{ ...inputStyle, colorScheme: 'dark' }} />
                </label>
                <label style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('field.location', 'Event location')}</span>
                  <input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={200} placeholder={tx('field.location_placeholder', 'City, region, country')} style={inputStyle} />
                </label>
              </div>
            )}
            <label style={{ display: 'grid', gap: 6, minWidth: 0 }}>
              <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('field.timezone', 'IANA event time zone')}</span>
              <input value={eventTimezone} onChange={(event) => setEventTimezone(event.target.value)} placeholder="America/New_York" autoCapitalize="none" spellCheck="false" style={inputStyle} />
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{tx('field.timezone_help', 'Defaults from this browser. The local date never shifts through UTC conversion.')}</span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 10, minWidth: 0 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('field.format', 'Format / division')}</span>
                <select value={eventFormat} onChange={(event) => { setEventFormat(event.target.value); if (event.target.value.startsWith('individual_') && eventCategory === 'mixed') setEventCategory('') }} style={inputStyle}>
                  <option value="individual_open">Open</option>
                  <option value="individual_pro">Pro</option>
                  <option value="doubles">Doubles</option>
                  <option value="relay">Relay</option>
                </select>
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('field.category', 'Category')}</span>
                <select value={eventCategory} onChange={(event) => setEventCategory(event.target.value)} style={inputStyle}>
                  <option value="" disabled>Choose category</option>
                  <option value="women">Women</option><option value="men">Men</option>
                  {!eventFormat.startsWith('individual_') && <option value="mixed">Mixed</option>}
                </select>
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('field.rules', 'Metric rules version')}</span>
                <input readOnly value={rulesVersion} aria-label={tx('field.rules', 'Metric rules version')} style={inputStyle} />
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('field.running_priority', 'Running priority')}</span>
                <select value={runningPriority} onChange={(event) => setRunningPriority(event.target.value)} style={inputStyle}>
                  <option value="maintain">Maintain</option><option value="improve">Improve</option><option value="race_pr">Race PR alongside HYROX</option>
                </select>
              </label>
            </div>
            <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
              <legend style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 900 }}>{tx('equipment.legend', 'Equipment access')}</legend>
              <p style={{ margin: '4px 0 8px', color: 'var(--text-muted)', fontSize: 12 }}>{tx('equipment.help', 'Uncheck anything unavailable. The preview will identify pattern-only substitutions.')}</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8 }}>
                {EQUIPMENT.map(([key, label]) => (
                  <label key={key} style={{ minWidth: 0, minHeight: 44, display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 750 }}>
                    <input type="checkbox" checked={equipment.includes(key)} onChange={() => toggleEquipment(key)} />
                    <span style={{ overflowWrap: 'anywhere' }}>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {eventMode === 'event_date' && (
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>{tx('secondary.label', 'Optional secondary running race')}</span>
                <select value={secondaryRaceId} onChange={(event) => setSecondaryRaceId(event.target.value)} style={inputStyle}>
                  <option value="">No secondary race</option>
                  {secondaryRaces.map((race) => <option key={race.id} value={race.id}>{race.race_name} · {race.race_date}</option>)}
                </select>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{tx('secondary.help', 'The preview must show post-HYROX recovery before running-race-specific work.')}</span>
              </label>
            )}
            <p style={{ margin: 0, display: 'flex', gap: 8, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
              <ShieldCheck size={17} style={{ flex: '0 0 auto', color: 'var(--accent)' }} />
              <span>{tx('safety.profile', 'Your existing injury, comeback, readiness, and recovery signals remain authoritative. No duplicate override is collected here.')}</span>
            </p>
            <button type="button" onClick={requestPreview} disabled={busy} style={{ width: '100%', minHeight: 48, padding: '12px 14px', borderRadius: 8, border: 0, background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 15, fontWeight: 950, opacity: busy ? 0.6 : 1 }}>
              {busy ? tx('preview.loading', 'Building safe preview…') : tx('preview.action', 'Preview HYROX plan')}
            </button>
            <p style={{ margin: 0, display: 'flex', gap: 7, color: 'var(--text-muted)', fontSize: 11 }}><Check size={14} style={{ flex: '0 0 auto', color: 'var(--success)' }} />{tx('preview.consent', 'Nothing replaces the current calendar until you explicitly apply the reviewed candidate.')}</p>
          </div>
        )}
        </div>
      </section>
    </div>
  )
}
