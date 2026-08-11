import { useEffect, useMemo, useRef } from 'react'
import { AlertTriangle, Check, RefreshCw, Trash2, X } from 'lucide-react'
import { activateModalDialog } from '../../lib/modalDialog'

function candidatePlan(preview = {}) {
  return preview?.plan?.plan_data || preview?.candidate?.plan_data || {}
}

function retainedGoalNames(preview = {}) {
  const plan = candidatePlan(preview)
  const goals = Array.isArray(plan.goals) ? plan.goals : plan.goal ? [plan.goal] : []
  return goals.map((goal) => goal?.name || goal?.raceName).filter(Boolean)
}

function replacementSummary(preview = {}) {
  const plan = candidatePlan(preview)
  const weeks = Array.isArray(plan.weeks) ? plan.weeks : []
  const phases = [...new Set(weeks.map((week) => week?.phase).filter(Boolean))]
  const sessions = weeks.flatMap((week) => week?.days || [])
    .reduce((total, day) => total + (Array.isArray(day?.sessions) ? day.sessions.length : 0), 0)
  return `${weeks.length} reviewed week${weeks.length === 1 ? '' : 's'} · ${sessions} future session${sessions === 1 ? '' : 's'}${phases.length ? ` · ${phases.join(' → ').replaceAll('_', ' ')}` : ''}`
}

export default function RaceRemoveSheet({ state, applying = false, error = '', onClose, onConfirm }) {
  const dialogRef = useRef(null)
  const linked = Boolean(state?.preview?.requires_apply)
  const retained = useMemo(() => retainedGoalNames(state?.preview), [state?.preview])
  const replacement = useMemo(() => replacementSummary(state?.preview), [state?.preview])

  useEffect(() => activateModalDialog({
    dialog: dialogRef.current,
    onClose: () => {
      if (!applying) onClose?.()
    },
  }), [applying, onClose])

  if (!state?.race || !state?.preview) return null

  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 120, display: 'grid', alignItems: 'end', justifyItems: 'center', padding: 10, background: 'rgba(0,0,0,0.78)' }}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="race-remove-title"
        className="rounded-lg"
        style={{ width: 'min(560px, 100%)', maxWidth: '100%', minWidth: 0, maxHeight: 'calc(100dvh - 20px)', overflowY: 'auto', padding: 16, paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
      >
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, color: 'var(--danger)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Removal review</p>
            <h2 id="race-remove-title" style={{ margin: '4px 0 0', color: 'var(--text-primary)', fontSize: 22, fontWeight: 950, overflowWrap: 'anywhere' }}>Remove {state.race.race_name}?</h2>
          </div>
          <button type="button" onClick={onClose} disabled={applying} aria-label="Keep race" style={{ width: 44, height: 44, flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}><X size={19} /></button>
        </header>

        <p style={{ margin: '12px 0 0', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.55 }}>
          {linked
            ? 'This race is part of your active plan. Review the replacement calendar before removing it.'
            : 'This race is not linked to the active plan. It will be removed from Upcoming only after you confirm.'}
        </p>

        <div style={{ display: 'grid', gap: 9, marginTop: 16 }}>
          <article style={{ display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr)', gap: 10, padding: 12, borderRadius: 8, background: 'var(--danger-dim)', border: '1px solid var(--border-subtle)' }}>
            <Trash2 size={18} style={{ color: 'var(--danger)', marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              <strong style={{ color: 'var(--text-primary)' }}>Removed</strong>
              <p style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: 13, overflowWrap: 'anywhere' }}>{linked ? `${state.race.race_name} and its future plan sessions.` : `${state.race.race_name} from Upcoming. No active-plan session is removed.`}</p>
            </div>
          </article>
          <article style={{ display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr)', gap: 10, padding: 12, borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <RefreshCw size={18} style={{ color: 'var(--accent)', marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              <strong style={{ color: 'var(--text-primary)' }}>Rebuilt</strong>
              <p style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: 13, overflowWrap: 'anywhere' }}>{linked ? replacement : 'Nothing. Your active plan does not reference this race.'}</p>
            </div>
          </article>
          <article style={{ display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr)', gap: 10, padding: 12, borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
            <Check size={18} style={{ color: 'var(--success)', marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              <strong style={{ color: 'var(--text-primary)' }}>Retained</strong>
              <p style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>{retained.length ? `Plan goals: ${retained.join(', ')}.` : 'Your current plan and all unrelated upcoming races.'}</p>
            </div>
          </article>
        </div>

        <p style={{ margin: '14px 0 0', padding: 12, borderRadius: 8, color: 'var(--text-primary)', background: 'var(--bg-input)', fontSize: 13, lineHeight: 1.5 }}>
          <strong>Recorded history stays intact.</strong> Recorded runs, lifts, health data, check-ins, and training history are preserved.
        </p>

        {error && <p role="alert" aria-live="assertive" style={{ margin: '12px 0 0', padding: 12, borderRadius: 8, background: 'var(--danger-dim)', color: 'var(--danger)', fontSize: 13, fontWeight: 750 }}><AlertTriangle size={16} style={{ display: 'inline', marginRight: 6, verticalAlign: -3 }} />{error}</p>}

        <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onConfirm}
            disabled={applying}
            style={{ width: '100%', minHeight: 48, padding: '12px 14px', borderRadius: 8, border: '1px solid var(--danger)', background: 'var(--danger-dim)', color: 'var(--danger)', fontSize: 14, fontWeight: 950, opacity: applying ? 0.6 : 1 }}
          >
            {applying ? 'Applying safely…' : linked ? 'Remove and apply reviewed plan' : 'Remove race'}
          </button>
          <button type="button" onClick={onClose} disabled={applying} style={{ width: '100%', minHeight: 44, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 14, fontWeight: 800 }}>Keep race</button>
        </div>
      </section>
    </div>
  )
}
