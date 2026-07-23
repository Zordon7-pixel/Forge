import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Clock3, MapPin, X } from 'lucide-react'
import { activateModalDialog } from '../../lib/modalDialog'
import DurationPicker from '../DurationPicker'
import { normalizeDurationSeconds } from '../../lib/duration'

function localTodayISO() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function plausibleGoalTime(seconds, distanceMiles) {
  const distance = Number(distanceMiles)
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(distance) || distance <= 0) return false
  const pace = seconds / distance
  return pace >= 180 && pace <= 1800
}

function inputStyle() {
  return {
    width: '100%',
    minWidth: 0,
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    padding: '12px 14px',
    fontSize: 16,
  }
}

export default function RaceEditSheet({ race, onClose, onSave, saving = false, serverError = '' }) {
  const dialogRef = useRef(null)
  const [draft, setDraft] = useState(() => ({
    race_name: race?.race_name || '',
    race_date: race?.race_date || '',
    distance_miles: race?.distance_miles != null ? String(race.distance_miles) : '',
    location: race?.location || '',
    goal_time_seconds: normalizeDurationSeconds(race?.goal_time_seconds),
    notes: race?.notes || '',
  }))
  const [error, setError] = useState('')

  useEffect(() => {
    return activateModalDialog({
      dialog: dialogRef.current,
      onClose: () => {
        if (!saving) onClose?.()
      },
    })
  }, [onClose, saving])

  const update = (field) => (event) => {
    setError('')
    setDraft((current) => ({ ...current, [field]: event.target.value }))
  }

  const submit = async (event) => {
    event.preventDefault()
    const distance = Number(draft.distance_miles)
    if (!draft.race_name.trim()) return setError('Enter the race name.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.race_date) || draft.race_date < localTodayISO()) return setError('Choose today or a future race date.')
    if (!Number.isFinite(distance) || distance <= 0 || distance > 100) return setError('Distance must be between 0.1 and 100 miles.')
    if (draft.goal_time_seconds > 0 && !plausibleGoalTime(draft.goal_time_seconds, distance)) return setError('Choose a goal pace between 3:00 and 30:00 per mile.')

    const payload = {
      race_name: draft.race_name.trim(),
      race_date: draft.race_date,
      distance_miles: distance,
      location: draft.location.trim() || null,
      goal_time_seconds: draft.goal_time_seconds || null,
      notes: draft.notes.trim() || null,
      status: race.status || 'upcoming',
    }
    const affectsPlan = String(race.race_name || '').trim() !== payload.race_name
      || String(race.race_date || '') !== payload.race_date
      || Number(race.distance_miles || 0) !== Number(payload.distance_miles || 0)
      || Number(race.goal_time_seconds || 0) !== Number(payload.goal_time_seconds || 0)
      || String(race.location || '').trim() !== String(payload.location || '').trim()
    await onSave?.(payload, { affectsPlan })
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.76)', display: 'grid', alignItems: 'end', justifyItems: 'center', padding: 10 }}>
      <form
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="race-edit-title"
        onSubmit={submit}
        className="rounded-lg"
        style={{ width: 'min(620px, 100%)', maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - 18px)', overflowY: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', padding: 16, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase', margin: '0 0 4px' }}>Upcoming race</p>
            <h2 id="race-edit-title" style={{ color: 'var(--text-primary)', fontSize: 22, fontWeight: 950, margin: 0 }}>Edit race</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '5px 0 0' }}>Race details update immediately. Plan-changing edits can be reviewed before rebuilding the calendar.</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close race editor" title="Close" style={{ flex: '0 0 auto', width: 40, height: 40, display: 'grid', placeItems: 'center', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
            <X size={18} />
          </button>
        </div>

        {(error || serverError) && <p role="alert" style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--danger-dim)', color: 'var(--danger)', fontSize: 13, fontWeight: 700, margin: '0 0 14px' }}>{error || serverError}</p>}

        <div style={{ display: 'grid', gap: 13 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Race name</span>
            <input value={draft.race_name} onChange={update('race_name')} maxLength={200} autoComplete="off" style={inputStyle()} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}><CalendarDays size={15} color="var(--accent)" /> Race date</span>
              <input type="date" min={localTodayISO()} value={draft.race_date} onChange={update('race_date')} style={{ ...inputStyle(), colorScheme: 'dark' }} />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Distance (miles)</span>
              <input type="number" min="0.1" max="100" step="0.1" inputMode="decimal" value={draft.distance_miles} onChange={update('distance_miles')} style={inputStyle()} />
            </label>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}><Clock3 size={15} color="var(--accent)" /> Goal time</span>
            <DurationPicker
              value={draft.goal_time_seconds}
              onChange={(value) => {
                setError('')
                setDraft((current) => ({ ...current, goal_time_seconds: value }))
              }}
              disabled={saving}
              idPrefix="race-goal"
            />
            {!draft.goal_time_seconds && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>No time target selected.</span>}
          </div>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}><MapPin size={15} color="var(--accent)" /> Location</span>
            <input value={draft.location} onChange={update('location')} maxLength={200} placeholder="City, state or country" style={inputStyle()} />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 850 }}>Notes</span>
            <textarea value={draft.notes} onChange={update('notes')} maxLength={2000} rows={3} placeholder="Optional race notes" style={{ ...inputStyle(), resize: 'vertical' }} />
          </label>
        </div>

        <button type="submit" disabled={saving} style={{ width: '100%', minHeight: 48, marginTop: 18, border: 0, borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 15, fontWeight: 950, opacity: saving ? 0.65 : 1 }}>
          {saving ? 'Saving race...' : 'Save race'}
        </button>
      </form>
    </div>
  )
}
