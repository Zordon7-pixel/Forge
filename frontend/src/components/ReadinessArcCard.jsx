import { useId } from 'react'
import { humanizeMachineValue } from '../lib/goalBackwardPresentation'

const ARC_LENGTH = 72

function customerText(value) {
  const raw = String(value ?? '').trim()
  if (!raw || /\b(?:sha256:)?[a-f0-9]{32,}\b/i.test(raw) || /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(raw)) return ''
  return raw
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, (token) => humanizeMachineValue(token))
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (token) => humanizeMachineValue(token))
}

function stateMessage(state, readiness) {
  if (state.loading) return 'Loading today\'s recovery signals.'
  if (state.locked) return 'Upgrade to Forged Hybrid Pro to unlock today\'s readiness score.'
  if (state.error) return 'Couldn\'t load recovery readiness.'
  if (!readiness.available) return 'Sync Health data to unlock today\'s readiness score.'
  return ''
}

export default function ReadinessArcCard({
  readinessState,
  readiness,
  expanded = false,
  onExpandedChange,
  onOpenDetail,
}) {
  const detailsId = useId()
  const state = readinessState || { loading: true, error: false, locked: false, data: null }
  const normalized = readiness || { available: false, score: null, display: '--', band: null }
  const unavailableMessage = stateMessage(state, normalized)

  if (unavailableMessage) {
    const stateName = state.loading ? 'loading' : state.locked ? 'locked' : state.error ? 'error' : 'unavailable'
    return (
      <section
        className="signature-readiness-card signature-readiness-state"
        aria-labelledby="signature-readiness-title"
        aria-busy={state.loading || undefined}
        data-signature-readiness={stateName}
      >
        <p className="signature-kicker">Daily readiness</p>
        <h2 id="signature-readiness-title" className="signature-state-title">Recovery readiness</h2>
        <p className="signature-state-copy">{unavailableMessage}</p>
        {state.loading && <span className="signature-loading-line" aria-hidden="true" />}
      </section>
    )
  }

  const bandLabel = humanizeMachineValue(normalized.band, { fallback: '' })
  const verdict = customerText(state.data?.verdict)
  const drivers = (Array.isArray(state.data?.drivers) ? state.data.drivers : [])
    .map(customerText)
    .filter(Boolean)
    .slice(0, 2)
  const visualScore = Math.max(0, Math.min(100, normalized.score))
  const arcFill = (visualScore / 100) * ARC_LENGTH
  const canExpand = drivers.length > 1 || typeof onOpenDetail === 'function'

  return (
    <section
      className="signature-readiness-card"
      aria-labelledby="signature-readiness-title"
      data-signature-readiness="loaded"
    >
      <div className="signature-readiness-primary">
        <div className="signature-readiness-copy">
          <p className="signature-kicker">Daily readiness</p>
          <h2 id="signature-readiness-title" className="sr-only">Recovery readiness</h2>
          <p className="signature-score">
            <span data-readiness-score>{normalized.display}</span>
            <span className="signature-score-scale">/ 100</span>
          </p>
          {bandLabel && <p className="signature-readiness-band" data-readiness-band>{bandLabel}</p>}
          {verdict && <p className="signature-readiness-verdict">{verdict}</p>}
        </div>

        <div className="signature-arc" aria-hidden="true">
          <svg viewBox="0 0 144 144" focusable="false">
            <circle
              className="signature-arc-track"
              cx="72"
              cy="72"
              r="54"
              pathLength="100"
              transform="rotate(140 72 72)"
              strokeDasharray={`${ARC_LENGTH} 100`}
            />
            <circle
              className="signature-arc-progress"
              cx="72"
              cy="72"
              r="54"
              pathLength="100"
              transform="rotate(140 72 72)"
              strokeDasharray={`${arcFill} 100`}
              style={{ '--signature-arc-fill': `${arcFill} 100` }}
            />
          </svg>
        </div>
      </div>

      {drivers[0] && <p className="signature-readiness-driver">{drivers[0]}</p>}

      {canExpand && (
        <>
          <button
            type="button"
            className="signature-disclosure-button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => onExpandedChange?.(!expanded)}
          >
            {expanded ? 'Hide readiness details' : 'Show readiness details'}
            <span aria-hidden="true">{expanded ? '−' : '+'}</span>
          </button>
          <div id={detailsId} className="signature-expanded-copy" hidden={!expanded}>
            {drivers.slice(1).map((driver) => <p key={driver}>{driver}</p>)}
            {typeof onOpenDetail === 'function' && (
              <button type="button" className="signature-detail-button" onClick={onOpenDetail}>
                Open full readiness details
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
