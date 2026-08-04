import { useEffect, useId, useMemo, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import {
  RUN_LOCATION_STATUS,
  requestNativeRunLocation,
  requestWebRunLocation,
} from '../lib/runLocationAccess'
import { deriveTravelTrainingChoices } from '../lib/travelTraining'

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation')
const LOCATION_TIMEOUT_MS = 10_000

function dismissalKey(dateISO) {
  return `forge-travel-training-dismissed-${dateISO || 'unknown-date'}`
}

function readDismissed(dateISO) {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(dismissalKey(dateISO)) === '1'
  } catch (error) {
    console.warn('[TravelTrainingPrompt] dismissal state unavailable:', error?.message || error)
    return false
  }
}

function currentLocationPayload(result, date) {
  const position = result?.position
  const latitude = position?.latitude ?? position?.coords?.latitude
  const longitude = position?.longitude ?? position?.coords?.longitude
  const accuracy = position?.accuracy ?? position?.coords?.accuracy
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)
    || typeof longitude !== 'number' || !Number.isFinite(longitude)
    || typeof accuracy !== 'number' || !Number.isFinite(accuracy)) return null
  return { latitude, longitude, accuracy_meters: accuracy, date }
}

function requestForegroundLocation() {
  return Capacitor.isNativePlatform()
    ? requestNativeRunLocation(BackgroundGeolocation, LOCATION_TIMEOUT_MS)
    : requestWebRunLocation(typeof navigator === 'undefined' ? null : navigator.geolocation, LOCATION_TIMEOUT_MS)
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
  const [travelContext, setTravelContext] = useState(null)
  const result = useMemo(() => deriveTravelTrainingChoices({
    execution,
    checkinData,
    adaptationProposal,
    readiness,
    activeInjury,
    hasRunRecordedToday: runRecordedToday,
    travelContext,
  }), [execution, checkinData, adaptationProposal, readiness, activeInjury, runRecordedToday, travelContext])

  useEffect(() => {
    setDismissed(readDismissed(resolvedDate))
    setTravelContext(null)
    setError('')
    setLoadingChoice(null)
  }, [resolvedDate])

  useEffect(() => {
    let cancelled = false
    if (!result.needsLocation || dismissed || !resolvedDate) {
      setTravelContext(null)
      return () => { cancelled = true }
    }

    setTravelContext({ status: 'checking' })
    requestForegroundLocation()
      .then(async (locationResult) => {
        if (cancelled) return
        if (locationResult?.status !== RUN_LOCATION_STATUS.READY) {
          setTravelContext({ status: 'unknown', reason: `location_${locationResult?.status || 'unavailable'}` })
          return
        }
        const payload = currentLocationPayload(locationResult, resolvedDate)
        if (!payload) {
          setTravelContext({ status: 'unknown', reason: 'location_invalid' })
          return
        }
        try {
          const response = await api.post('/travel-context', payload)
          if (cancelled) return
          const status = String(response.data?.status || '').toLowerCase()
          setTravelContext(['away', 'home', 'unknown'].includes(status)
            ? {
                status,
                confidence: response.data?.confidence || null,
                distanceBand: response.data?.distanceBand || 'unknown',
                reason: response.data?.reason || null,
              }
            : { status: 'unknown', reason: 'context_invalid' })
        } catch (requestError) {
          if (!cancelled) {
            console.warn('[TravelTrainingPrompt] travel context unavailable:', requestError?.message || requestError)
            setTravelContext({ status: 'unknown', reason: 'context_unavailable' })
          }
        }
      })
      .catch((locationError) => {
        if (!cancelled) {
          console.warn('[TravelTrainingPrompt] foreground location unavailable:', locationError?.message || locationError)
          setTravelContext({ status: 'unknown', reason: 'location_unavailable' })
        }
      })
    return () => { cancelled = true }
  }, [dismissed, resolvedDate, result.needsLocation])

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
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(dismissalKey(resolvedDate), '1')
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
