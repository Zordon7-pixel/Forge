import { useId } from 'react'
import { formatHrZone } from '../lib/dailyExecutionCore'
import { humanizeMachineValue } from '../lib/goalBackwardPresentation'
import { buildDailyBriefContext, buildRestDayReasons } from '../lib/dashboardBrief'

function customerText(value, { casing = 'sentence' } = {}) {
  const raw = String(value ?? '').trim()
  if (!raw || raw === '--' || /\b(?:sha256:)?[a-f0-9]{32,}\b/i.test(raw) || /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(raw)) return ''
  if (/^[A-Z0-9_]+$/.test(raw) || /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(raw)) {
    return humanizeMachineValue(raw, { casing, fallback: '' })
  }
  return raw
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, (token) => humanizeMachineValue(token))
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (token) => humanizeMachineValue(token))
}

function matchingSession(execution, recommendation) {
  if (!execution?.hasPlan || !execution?.hasDay || execution?.surface?.status === 'blocked') return null
  const sessions = Array.isArray(execution.sessions) ? execution.sessions : []
  const missionId = String(recommendation?.planSessionId ?? '').trim()
  if (missionId) return sessions.find((session) => String(session?.id ?? '').trim() === missionId) || null
  if (recommendation?.recommendationType === 'strength') return execution.lift || null
  if (recommendation?.recommendationType !== 'rest') return execution.run || null
  return null
}

function missionTitle(recommendation, session) {
  const recommendationType = String(recommendation?.recommendationType || recommendation?.type || '').toLowerCase()
  if (recommendationType === 'rest') return 'Rest & recover'
  const title = customerText(session?.title || session?.label || session?.workout_name, { casing: 'title' })
  if (title) return title
  return customerText(recommendation?.recommendationType || recommendation?.type, { casing: 'title' })
}

function missionMetrics(recommendation, session) {
  const metrics = []
  const distance = Number(recommendation?.suggestedDistance || 0)
  const duration = Number(recommendation?.durationMinutes || 0)
  const pace = customerText(recommendation?.suggestedPace)
  const zone = customerText(formatHrZone(session) || recommendation?.targetZone)
  const effort = customerText(recommendation?.brief?.effort || recommendation?.intensity)

  if (duration > 0) metrics.push({ key: 'duration', label: 'Duration', value: `${recommendation.durationIsEstimated ? '~' : ''}${recommendation.durationMinutes} min${recommendation.durationIsEstimated ? ' · estimate' : ''}` })
  if (distance > 0) metrics.push({ key: 'distance', label: 'Distance', value: `${recommendation.suggestedDistance} mi` })
  if (effort) metrics.push({ key: 'effort', label: 'Effort', value: effort })
  if (pace) metrics.push({ key: 'pace', label: 'Pace', value: pace })
  if (zone && zone !== effort) metrics.push({ key: 'zone', label: 'Zone', value: zone })
  return metrics
}

function missionRationale(recommendation) {
  const interferenceReason = recommendation?.interference?.adjusted
    ? customerText(recommendation.interference.reason)
    : ''
  return interferenceReason
    || customerText(recommendation?.brief?.why)
    || customerText(recommendation?.reason)
}

export default function CoachsLogCard({
  recommendation,
  execution,
  weeklyRecap,
  readinessData,
  nextRace,
  expanded = false,
  onExpandedChange,
}) {
  const detailId = useId()
  if (!recommendation || execution?.surface?.status === 'blocked') return null

  const session = matchingSession(execution, recommendation)
  const title = missionTitle(recommendation, session)
  if (!title) return null

  const metrics = missionMetrics(recommendation, session)
  const rationale = missionRationale(recommendation)
  const restReasons = buildRestDayReasons({ recommendation, execution, weeklyRecap, readinessData, nextRace })
  const context = buildDailyBriefContext({ weeklyRecap, readinessData, nextRace })
  const isRestDay = restReasons.length > 0
  const visibleContext = isRestDay
    ? context.filter((item) => item.key === 'readiness')
    : context

  return (
    <section className="signature-coachs-log card-hero" aria-labelledby="signature-coachs-log-title" data-dashboard-card-family="brief" data-signature-coachs-log>
      <button
        type="button"
        className="signature-log-toggle"
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={`${expanded ? 'Close' : 'Open'} Coach's daily brief for ${title}`}
        onClick={() => onExpandedChange?.(!expanded)}
      >
        <span className="signature-log-heading">
          <span className="signature-log-kicker">Coach&apos;s daily brief</span>
          <h2 id="signature-coachs-log-title" className="signature-log-title">{title}</h2>
          <span className="signature-log-hint">{expanded ? 'Coaching details' : 'Tap to view coaching details'}</span>
        </span>
        <span className="signature-log-toggle-icon" aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>

      <div id={detailId} className="signature-log-details" hidden={!expanded}>
        {metrics.length > 0 && (
          <dl className="signature-mission-facts">
            {metrics.map((metric) => (
              <div key={metric.key} data-mission-fact={metric.key}>
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {(isRestDay || rationale) && (
          <div className="signature-rest-rationale">
            <p className="signature-rest-rationale-title">Why today matters</p>
            {isRestDay ? (
              <ul className="signature-rest-reasons" aria-label="Rest day reasons">
                {restReasons.map((reason) => (
                  <li key={reason.key}>
                    <span className="signature-rest-reason-marker" aria-hidden="true" />
                    <span>
                      <strong>{reason.label}</strong>
                      <span>{reason.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="signature-log-rationale"><p>{rationale}</p></div>
            )}
          </div>
        )}

        {visibleContext.length > 0 && (
          <div className="signature-log-context" aria-label="Today's coaching context">
            <p className="signature-log-context-title">Today&apos;s context</p>
            <dl>
              {visibleContext.map((item) => (
                <div key={item.key} data-brief-context={item.key}>
                  <dt>{item.label}</dt>
                  {item.value && <dd>{item.value}</dd>}
                  {item.detail && <dd className="signature-log-context-detail">{item.detail}</dd>}
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </section>
  )
}
