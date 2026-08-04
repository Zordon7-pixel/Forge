import { useEffect, useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { deriveTravelTrainingChoices } from '../lib/travelTraining'

function dismissalKey(dateISO) {
  return `forge-travel-training-dismissed-${dateISO || 'unknown-date'}`
}

function readDismissed(dateISO) {
  if (typeof sessionStorage === 'undefined') return false
  try {
    return sessionStorage.getItem(dismissalKey(dateISO)) === '1'
  } catch (error) {
    console.warn('[TravelTrainingPrompt] dismissal state unavailable:', error?.message || error)
    return false
  }
}

export default function TravelTrainingPrompt({
  execution,
  checkinData,
  adaptationProposal,
  readiness,
  activeInjury,
  runRecordedToday,
  dateISO,
}) {
  const navigate = useNavigate()
  const titleId = useId()
  const resolvedDate = dateISO || execution?.date || null
  const [dismissed, setDismissed] = useState(() => readDismissed(resolvedDate))
  const [loadingChoice, setLoadingChoice] = useState(null)
  const [error, setError] = useState('')
  const result = useMemo(() => deriveTravelTrainingChoices({
    execution,
    checkinData,
    adaptationProposal,
    readiness,
    activeInjury,
    hasRunRecordedToday: runRecordedToday,
  }), [execution, checkinData, adaptationProposal, readiness, activeInjury, runRecordedToday])

  useEffect(() => {
    setDismissed(readDismissed(resolvedDate))
    setError('')
    setLoadingChoice(null)
  }, [resolvedDate])

  if (!result.shouldPrompt || dismissed) return null

  const choose = async (choice) => {
    if (!choice || loadingChoice) return
    setError('')

    if (choice.kind === 'scheduled_run' || choice.kind === 'recovery_run') {
      navigate('/log-run', { state: { ...choice.routeState, openRoutePlanner: true } })
      return
    }
    if (choice.kind === 'recovery') {
      navigate('/prep?mode=recovery')
      return
    }
    if (choice.kind === 'keep') {
      if (typeof sessionStorage !== 'undefined') {
        try {
          sessionStorage.setItem(dismissalKey(resolvedDate), '1')
        } catch (storageError) {
          console.warn('[TravelTrainingPrompt] could not save dismissal:', storageError?.message || storageError)
        }
      }
      setDismissed(true)
      return
    }
    if (choice.kind !== 'bodyweight_strength') return

    setLoadingChoice(choice.id)
    try {
      const response = await api.post('/plans/today/bodyweight-alternative', {
        date: resolvedDate,
        session_id: choice.sessionId,
      })
      const alternative = response.data?.alternative
      if (!alternative || String(alternative.id || '') !== String(choice.sessionId || '')) {
        throw new Error('The no-equipment session did not match today\'s scheduled lift.')
      }
      navigate('/log-lift', {
        state: {
          planSessionId: choice.sessionId,
          currentWeek: choice.currentWeek,
          scheduledLift: alternative,
        },
      })
    } catch (requestError) {
      setError(requestError?.response?.data?.error || requestError?.message || 'Could not build the no-equipment session. Please try again.')
    } finally {
      setLoadingChoice(null)
    }
  }

  return (
    <section
      aria-labelledby={titleId}
      className="min-w-0 overflow-hidden rounded-xl p-4"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--accent)' }}
    >
      <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>Travel-ready training</p>
      <h2 id={titleId} className="mt-1 break-words text-lg font-black" style={{ color: 'var(--text-primary)' }}>
        Training away or no gym today?
      </h2>
      <p className="mt-1 break-words text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
        Keep the plan useful without forcing catch-up mileage. Recovery or keeping today unchanged are always valid.
      </p>

      {error && (
        <p role="alert" aria-live="assertive" className="mt-3 break-words rounded-lg p-3 text-sm" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {loadingChoice && (
        <p role="status" aria-live="polite" className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          Building the exact no-equipment alternative…
        </p>
      )}

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {result.choices.map((choice, index) => {
          const busy = loadingChoice === choice.id
          return (
            <button
              key={`${choice.id}-${choice.kind}`}
              type="button"
              onClick={() => choose(choice)}
              disabled={Boolean(loadingChoice)}
              aria-label={`${choice.label}. ${choice.description}`}
              className="min-h-11 min-w-0 rounded-lg px-3 py-3 text-left disabled:opacity-60"
              style={index === 0
                ? { background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid var(--accent)' }
                : { background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            >
              <span className="block break-words text-sm font-black">{busy ? 'Building…' : choice.label}</span>
              <span className="mt-1 block break-words text-xs leading-5" style={{ color: index === 0 ? 'inherit' : 'var(--text-muted)' }}>
                {choice.description}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
