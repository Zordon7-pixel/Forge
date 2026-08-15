import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  Activity, Footprints, Dumbbell, Moon, ChevronDown, ChevronLeft, ChevronRight, Pencil,
  Compass, ShieldCheck,
} from 'lucide-react'
import {
  buildMonthGrid, addMonths, dayMarks, dayStatus, countdownDays, WEEKDAYS,
} from '../../lib/planCalendar'
import './forgedCalendar.css'

const MONTH_DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const PHASE_PURPOSE = Object.freeze({
  base: 'Establish consistent aerobic volume and durable movement before race-specific load increases.',
  build: 'Increase sustainable speed and long-run durability with controlled weekly progression.',
  deload: 'Reduce training stress so the previous work can be absorbed without losing rhythm.',
  peak: 'Practice the race demands at the highest sustainable load before the taper.',
  taper: 'Lower fatigue while preserving goal-pace familiarity and movement quality.',
  race: 'Arrive rested, confident, and ready to execute the prepared race strategy.',
})

function formatGoalTime(seconds) {
  const total = Math.round(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return null
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = total % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

function formatGoalPace(seconds) {
  const total = Math.round(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return null
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/mi`
}

function formatAnchorRunDate(value) {
  if (!value) return ''
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function sessionTarget(session) {
  if (session.kind === 'hyrox') {
    const stations = Array.isArray(session.raw?.stationSequence) ? session.raw.stationSequence.length : 0
    const runs = Array.isArray(session.raw?.runSequenceMeters) ? session.raw.runSequenceMeters.length : 0
    const relayStations = Number(session.raw?.athleteStationAssignment?.stationCount || 0)
    return [
      runs ? `${runs} × 1 km` : null,
      relayStations ? `${relayStations} team-assigned stations` : stations ? `${stations} station${stations === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ') || 'HYROX'
  }
  if (session.kind === 'lift') return String(session.prescription?.focus || 'Strength').replaceAll('_', ' ')
  if (session.prescriptionBasis === 'time' && session.durationMinutes > 0) return `${Math.round(session.durationMinutes)} min`
  if (session.distanceMiles > 0) return `${session.distanceIsEstimate ? '~' : ''}${session.distanceMiles.toFixed(1)} mi`
  return 'Run'
}

function sessionPurpose(session) {
  return session.prescription?.purpose
    || session.prescription?.description
    || session.raw?.purpose
    || session.raw?.description
    || (session.kind === 'lift'
      ? 'Preserve strength and movement quality alongside the running block.'
      : 'Develop the fitness required for the plan goal at a controlled dose.')
}

const FEASIBILITY_REASON_LABELS = Object.freeze({
  NO_PERFORMANCE_ANCHOR: 'No recent performance anchor is available yet.',
  ANCHOR_EXPIRED: 'The performance anchor is too old to support the target.',
  BROAD_EQUIVALENCY_ONLY: 'Current performance evidence gives only a broad pace estimate.',
  PACE_EQUIVALENCY_USED: 'Goal pace uses an equivalent recorded performance.',
  QUALITY_EXPOSURE_MISSING: 'The block needs another race-specific quality exposure.',
  PEAK_DEMAND_UNREACHABLE: 'The available weeks cannot safely reach the required peak load.',
  CHECKPOINT_UNPLACEABLE: 'There is not enough calendar space for a safe checkpoint.',
  RACE_SPACING_CONFLICT: 'The protected races are close enough to constrain recovery and sharpening.',
})

function readableReason(reason) {
  if (!reason) return ''
  return FEASIBILITY_REASON_LABELS[reason]
    || String(reason).replaceAll('_', ' ').toLowerCase().replace(/^./, (letter) => letter.toUpperCase())
}

function formatMinutes(totalMinutes) {
  const total = Math.round(Number(totalMinutes || 0))
  if (total <= 0) return null
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return hours ? `${hours}h${minutes ? ` ${minutes}m` : ''}` : `${minutes} min`
}

function qualityFallback(runs) {
  return runs.find(({ session }) => (
    /(hill|interval|repeat|tempo|threshold|fartlek|speed|race.?pace|benchmark)/i.test(
      [session.type, session.title, session.raw?.workout_id].filter(Boolean).join(' '),
    )
  )) || null
}

function targetFromMetadata(target, fallbackSession) {
  if (target && typeof target === 'object') {
    const distance = Number(target.distance_miles || target.distanceMiles || 0)
    const duration = Number(target.duration_min || target.durationMinutes || 0)
    const parts = [distance > 0 ? `${distance.toFixed(1)} mi` : null, formatMinutes(duration)].filter(Boolean)
    if (parts.length) return parts.join(' · ')
  }
  return fallbackSession ? sessionTarget(fallbackSession) : 'Not scheduled'
}

function weekOverview(week, strengthEnabled) {
  const sessions = (week?.days || []).flatMap((day) => (
    (day.sessions || []).map((session) => ({ day, session }))
  ))
  const runs = sessions.filter(({ session }) => session.kind === 'run')
  const lifts = sessions.filter(({ session }) => session.kind === 'lift')
  const hyrox = sessions.filter(({ session }) => session.kind === 'hyrox')
  const runExposures = runs.length + hyrox.filter(({ session }) => session.raw?.includesRun).length
  const totalMiles = runs.reduce((sum, { session }) => sum + Number(session.distanceMiles || 0), 0)
  const totalMinutes = runs.reduce((sum, { session }) => sum + Number(session.durationMinutes || 0), 0)
  const longRunEntry = runs
    .map(({ session }) => session)
    .filter((session) => ['long', 'race'].includes(String(session.type || '').toLowerCase())
      || String(session.raw?.workout_id || '').toLowerCase() === 'long_aerobic')
    .sort((left, right) => Number(right.distanceMiles || 0) - Number(left.distanceMiles || 0))[0]
  const explicitQuality = week?.keyQualitySession && typeof week.keyQualitySession === 'object'
    ? week.keyQualitySession
    : null
  const fallbackQuality = qualityFallback(runs)
  const keyQuality = explicitQuality
    ? {
        title: explicitQuality.title || String(explicitQuality.workout_id || '').replaceAll('_', ' '),
        purpose: explicitQuality.purpose || '',
      }
    : fallbackQuality
      ? { title: fallbackQuality.session.title, purpose: sessionPurpose(fallbackQuality.session) }
      : null
  const restDays = (week?.days || []).filter((day) => day.isRest).length
  const phasePurpose = PHASE_PURPOSE[week?.phase] || 'Progress the plan with a repeatable balance of training and recovery.'
  const explicitStrengthIntent = String(week?.strengthIntent || '')
  const strengthIntent = hyrox.length
    ? `${hyrox.length} HYROX session${hyrox.length === 1 ? '' : 's'} carry the station-strength and skill intent without becoming fake running mileage.`
    : !strengthEnabled
    ? 'Run-only mode; no strength session is required.'
    : lifts.length > 0 && /no strength/i.test(explicitStrengthIntent)
      ? `${lifts.length} scheduled strength session${lifts.length === 1 ? '' : 's'} preserve the selected strength floor.`
      : explicitStrengthIntent || (lifts.length
        ? `${lifts.length} scheduled strength session${lifts.length === 1 ? '' : 's'} support the running block.`
        : 'No strength session is scheduled this week.')
  const purpose = week?.purpose || (hyrox.length
    ? `${phasePurpose} HYROX work supplements the running foundation within the hard-day limit.`
    : lifts.length
    ? `${phasePurpose} Strength work supports the run goal without replacing recovery.`
    : phasePurpose)
  const whyAdvances = keyQuality?.purpose
    || (longRunEntry
      ? 'The planned quality and endurance doses progress race readiness while the remaining days protect recovery.'
      : purpose)
  return {
    sessions,
    summary: [
      `${runExposures} run exposure${runExposures === 1 ? '' : 's'}`,
      hyrox.length ? `${hyrox.length} HYROX exposure${hyrox.length === 1 ? '' : 's'}` : null,
      strengthEnabled && !hyrox.length ? `${lifts.length} lift${lifts.length === 1 ? '' : 's'}` : null,
      totalMiles > 0 ? `${totalMiles.toFixed(1)} planned mi` : null,
      totalMinutes > 0 ? formatMinutes(totalMinutes) : null,
      `${restDays} rest day${restDays === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · '),
    purpose,
    keyQuality,
    longRun: targetFromMetadata(week?.longRunTarget, longRunEntry),
    strengthIntent,
    whyAdvances,
    safetyNote: week?.safetyHold || week?.deloadReason || null,
  }
}

function weeksToGoals(model, week) {
  return (model?.goals || []).map((goal, index) => {
    const days = countdownDays(goal.dateISO, week.startISO)
    if (!Number.isFinite(days)) return null
    return `A${index + 1}: ${Math.max(0, Math.ceil(days / 7))} weeks`
  }).filter(Boolean).join(' · ')
}

function EvidenceSummary({ model }) {
  const why = model?.whyThisPlan
  if (!why) return null
  const baseline = why.baseline || model?.engineMetadata?.anchor?.weekly_baseline
  const endurance = why.endurance || model?.engineMetadata?.anchor?.recent_endurance
  const input = model?.inputSummary || {}
  const reasonCodes = Array.isArray(why.reason_codes) ? why.reason_codes : []
  const performance = model?.feasibility?.goals?.find((goal) => goal?.pace)?.pace
  const evidence = model?.trainingEvidence || []
  const baselineText = Number(baseline?.value) > 0
    ? `${Number(baseline.value).toFixed(1)} mi weekly baseline · ${String(baseline.confidence || 'recorded').replaceAll('_', ' ')}`
    : 'Weekly mileage baseline is not established yet.'
  const enduranceText = Number(endurance?.value) > 0
    ? `${Number(endurance.value).toFixed(1)} mi recent endurance anchor · ${String(endurance.confidence || 'recorded').replaceAll('_', ' ')}`
    : 'No recent endurance anchor is available.'
  return (
    <details style={{ marginTop: 12, minWidth: 0, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', overflow: 'hidden' }}>
      <summary style={{ minHeight: 48, padding: '12px 14px', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 800 }}>Why this plan</summary>
      <div style={{ padding: '0 14px 14px', minWidth: 0, color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
        {why.summary && <p style={{ margin: '0 0 10px', color: 'var(--text-primary)' }}>{why.summary}</p>}
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>{baselineText}</li>
          <li>{enduranceText}</li>
          {Number(input.recentRunCount || 0) > 0 && <li>{Number(input.recentRunCount)} recent run{Number(input.recentRunCount) === 1 ? '' : 's'} reviewed.</li>}
          {Number(input.mileageBaseline?.meaningfulRunCount || 0) > 0 && <li>{Number(input.mileageBaseline.meaningfulRunCount)} meaningful run{Number(input.mileageBaseline.meaningfulRunCount) === 1 ? '' : 's'} informed the baseline.</li>}
          {performance?.anchorClass && <li>Performance anchor: {String(performance.anchorClass).replaceAll('_', ' ')}{Number.isFinite(Number(performance.anchorAgeDays)) ? ` · ${Number(performance.anchorAgeDays)} days old` : ''}.</li>}
          {reasonCodes.map((reason) => <li key={reason}>{readableReason(reason)}</li>)}
          {evidence.length > 0 && <li>{evidence.length} reviewed evidence reference{evidence.length === 1 ? '' : 's'} support the programming rules.</li>}
        </ul>
      </div>
    </details>
  )
}

function PlanOverview({ model, currentWeekIndex }) {
  return (
    <section className="forged-overview" aria-labelledby="forged-plan-overview-title" style={{ minWidth: 0, maxWidth: '100%', overflowX: 'clip' }}>
      <div className="forged-overview-intro">
        <h3 id="forged-plan-overview-title">Plan overview</h3>
        <p>Review the complete block before opening individual workouts.</p>
      </div>
      {model?.feasibility?.label && (
        <div role="status" style={{ marginTop: 12, minWidth: 0, padding: 14, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', overflowWrap: 'anywhere' }}>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Goal feasibility</p>
          <p style={{ margin: '4px 0 0', color: 'var(--text-primary)', fontSize: 18, fontWeight: 900 }}>{model.feasibility.label}</p>
          {model.feasibility.goals.length > 1 && model.feasibility.goals.map((goal, index) => (
            <p key={goal.raceId || goal.raceName || index} style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>
              A{index + 1} · {goal.raceName || `Race ${index + 1}`}: <strong style={{ color: 'var(--text-primary)' }}>{goal.label || goal.status}</strong>
            </p>
          ))}
          {(model.feasibility.reasons || []).slice(0, 3).map((reason) => (
            <p key={reason} style={{ margin: '5px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>{readableReason(reason)}</p>
          ))}
        </div>
      )}
      <EvidenceSummary model={model} />
      <div className="forged-overview-weeks">
        {(model?.weeks || []).map((week, overviewIndex) => {
          const overview = weekOverview(week, model?.strengthEnabled)
          const resolvedWeekIndex = Number.isInteger(week.weekIndex) ? week.weekIndex : overviewIndex
          const isCurrent = resolvedWeekIndex === currentWeekIndex
          return (
            <details className="forged-overview-week" key={`overview-${resolvedWeekIndex}`} open={isCurrent}>
              <summary>
                <span className="forged-overview-week-main">
                  <span className="forged-overview-kicker">
                    Week {week.weekNumber} of {model.weekCount}{isCurrent ? ' · Current' : ''}
                  </span>
                  <strong>{week.bridgeWeek ? 'Bridge Week' : `${String(week.phase || 'training').replace(/^./, (letter) => letter.toUpperCase())} focus`}</strong>
                  <span>{weeksToGoals(model, week)}</span>
                  <span>{overview.summary}</span>
                </span>
                <ChevronDown size={18} aria-hidden="true" />
              </summary>
              <div className="forged-overview-week-body">
                <p className="forged-overview-purpose">{overview.purpose}</p>
                <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, margin: '12px 0 0', minWidth: 0 }}>
                  <div><dt style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Key quality</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{overview.keyQuality?.title || 'No quality session scheduled'}</dd></div>
                  <div><dt style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Long run</dt><dd style={{ margin: '2px 0 0' }}>{overview.longRun}</dd></div>
                  <div><dt style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Strength intent</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{overview.strengthIntent}</dd></div>
                  <div><dt style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Why it advances the goal</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{overview.whyAdvances}</dd></div>
                  {overview.safetyNote && <div><dt style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Safety hold / deload</dt><dd style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{overview.safetyNote}</dd></div>}
                </dl>
                <details style={{ marginTop: 12, minWidth: 0 }}>
                  <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer', fontWeight: 800 }}>Week schedule</summary>
                  <ol className="forged-overview-sessions" style={{ minWidth: 0 }}>
                    {overview.sessions.map(({ day, session }, sessionIndex) => (
                      <li key={`${day.dateISO || day.slot || resolvedWeekIndex}-${session.id || sessionIndex}`} style={{ minWidth: 0 }}>
                        <span className="forged-overview-session-head" style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap' }}>
                          <span>{day.dayLabel}</span>
                          <strong style={{ overflowWrap: 'anywhere' }}>{session.title}</strong>
                          <span>{sessionTarget(session)}</span>
                        </span>
                        {session.motivationalTitle && <p style={{ fontWeight: 800 }}>{session.motivationalTitle}</p>}
                        <p>{sessionPurpose(session)}</p>
                      </li>
                    ))}
                  </ol>
                </details>
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}

function Stamp({ kind, state, small }) {
  const Icon = kind === 'lift' ? Dumbbell : kind === 'rest' ? Moon : kind === 'hyrox' ? Activity : Footprints
  return (
    <span
      className={`forged-stamp forged-stamp--${kind}${small ? ' forged-stamp--sm' : ''}`}
      data-state={state || undefined}
      aria-label={`${kind} ${state || ''}`.trim()}
    >
      <Icon size={small ? 12 : 15} />
    </span>
  )
}

function recordedRunSummary(activities = []) {
  if (!activities.length) return ''
  const totalMiles = activities.reduce((sum, activity) => sum + Number(activity.distanceMiles || 0), 0)
  const runLabel = activities.length === 1 ? 'Recorded run' : `${activities.length} recorded runs`
  return totalMiles > 0 ? `${runLabel} · ${totalMiles.toFixed(2)} mi` : runLabel
}

function canonicalReasonLabel(value) {
  return String(value || '').replaceAll('_', ' ').toLowerCase().replace(/^./, (letter) => letter.toUpperCase())
}

function SurfaceManifestSummary({ surface }) {
  if (surface?.status !== 'accepted') return null
  const identity = surface.identity || {}
  const manifest = surface.manifest || {}
  return (
    <details style={{ minWidth: 0, marginBottom: 12, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-card)', overflow: 'hidden' }}>
      <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', padding: '10px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 900 }}>
        Canonical plan · plan r{identity.plan_revision} · surface r{manifest.surface_revision}
      </summary>
      <dl style={{ minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 7, margin: 0, padding: '0 12px 12px', overflowWrap: 'anywhere', fontSize: 11 }}>
        <div><dt style={{ fontWeight: 900 }}>Decision</dt><dd style={{ margin: 0 }}>{identity.decision_id} · {identity.decision_hash}</dd></div>
        <div><dt style={{ fontWeight: 900 }}>Candidate</dt><dd style={{ margin: 0 }}>{identity.candidate_id} · r{identity.candidate_revision} · {identity.candidate_hash}</dd></div>
        <div><dt style={{ fontWeight: 900 }}>Plan/session set</dt><dd style={{ margin: 0 }}>{identity.plan_id} · {identity.canonical_session_set_hash}</dd></div>
        <div><dt style={{ fontWeight: 900 }}>State and safety</dt><dd style={{ margin: 0 }}>Athlete state r{identity.athlete_state_revision} · {identity.safety_state_hash}</dd></div>
        <div><dt style={{ fontWeight: 900 }}>Safety action</dt><dd style={{ margin: 0 }}>{manifest.safety?.action || 'NORMAL'} · {(manifest.safety?.scope || []).join(', ') || 'No scoped restriction'}{manifest.safety?.reason_codes?.length ? ` · ${manifest.safety.reason_codes.join(' · ')}` : ''}</dd></div>
        <div><dt style={{ fontWeight: 900 }}>Goal revisions</dt><dd style={{ margin: 0 }}>{Object.entries(identity.goal_revisions || {}).map(([id, revision]) => `${id}: r${revision}`).join(' · ') || 'None'}</dd></div>
      </dl>
    </details>
  )
}

function CanonicalBriefTruth({ canonical }) {
  if (!canonical) return null
  const purposeReasonCodes = Array.isArray(canonical.purposeReasonCodes) ? canonical.purposeReasonCodes : []
  const targetProvenance = Array.isArray(canonical.targetProvenance) ? canonical.targetProvenance : []
  const capability = canonical.capability?.classification || 'NOT_EXPORTABLE'
  return (
    <span role="note" style={{ display: 'block', minWidth: 0, marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-input)', overflowWrap: 'anywhere', fontSize: 11 }}>
      <span style={{ display: 'block', margin: 0, fontWeight: 900 }}>{canonical.role} · {capability.replaceAll('_', ' ')}</span>
      {purposeReasonCodes.length > 0 && <span style={{ display: 'block', marginTop: 3 }}>Why: {purposeReasonCodes.map(canonicalReasonLabel).join(' · ')}</span>}
      <span style={{ display: 'block', marginTop: 3 }}>Target provenance: {targetProvenance.length} accepted source{targetProvenance.length === 1 ? '' : 's'} · {canonical.executability}</span>
    </span>
  )
}

function WeeklyBriefHeader({ brief, onOpenDay }) {
  if (!brief) return null
  const next = brief.days.find((day) => !day.isRest && day.state !== 'completed' && day.dateISO > (brief.today?.dateISO || ''))
  return (
    <section className="forged-weekly-brief" aria-label="Weekly Run Brief">
      <div className="forged-weekly-brief-kicker">
        <span><Compass size={14} aria-hidden="true" /> Weekly Run Brief</span>
        <span>{brief.dateRange}</span>
      </div>
      <h3 id="forged-weekly-brief-title">{brief.purpose}</h3>
      {brief.feasibility?.status && (
        <div role="status" style={{ minWidth: 0, marginTop: 8, overflowWrap: 'anywhere', fontSize: 12 }}>
          <strong>Goal feasibility:</strong> {canonicalReasonLabel(brief.feasibility.status)}
          {brief.feasibility.reasonCodes?.length > 0 && <span> · {brief.feasibility.reasonCodes.map(canonicalReasonLabel).join(' · ')}</span>}
        </div>
      )}
      <div className="forged-weekly-brief-totals" role="group" aria-label="Weekly training target">
        {brief.totalMilesLabel && <span>{brief.totalMilesLabel}</span>}
        {brief.totalTimeLabel && <span>{brief.totalTimeLabel}</span>}
        {brief.mixLabel && <span>{brief.mixLabel}</span>}
      </div>
      {brief.today && (
        <button type="button" className="forged-mission-card" onClick={() => onOpenDay(brief.today.rawDay)}>
          <span className="forged-mission-copy">
            <span className="forged-mission-label">Today&apos;s mission</span>
            <strong>{brief.today.title}</strong>
            <span>{brief.today.target} · {brief.today.readiness}</span>
            <CanonicalBriefTruth canonical={brief.today.canonical} />
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      )}
      {brief.today?.state === 'completed' && next && (
        <p className="forged-weekly-unlocked" role="status">Complete. Next up: {next.title} on {next.dayLabel}.</p>
      )}
      {brief.gearWarnings.length > 0 && (
        <details className="forged-gear-warning">
          <summary><ShieldCheck size={14} aria-hidden="true" /> Shoe rotation check</summary>
          <div>
            {brief.gearWarnings.map((warning) => <p key={warning}>{warning}</p>)}
            <Link to="/gear">Update Gear</Link>
          </div>
        </details>
      )}
      {!brief.gearAvailable && (
        <p className="forged-gear-unavailable" role="status">Gear could not be loaded, so Forge did not guess a shoe. <Link to="/gear">Review Gear</Link></p>
      )}
    </section>
  )
}

function WeekRow({ day, briefDay, isToday, completedSet, recordedRuns = [], onOpen }) {
  const marks = dayMarks(day, completedSet)
  const status = dayStatus(day, completedSet)
  const runSession = day.sessions.find((s) => s.kind === 'run')
  const liftSession = day.sessions.find((s) => s.kind === 'lift')
  const hyroxSession = day.sessions.find((s) => s.kind === 'hyrox')
  const hasRecordedRun = recordedRuns.length > 0
  const plannedIds = new Set(day.sessions.map((session) => String(session.id)))
  const unlinkedRun = recordedRuns.some((activity) => !activity.planSessionId || !plannedIds.has(String(activity.planSessionId)))
  const title = day.isRest && hasRecordedRun
    ? 'Recorded run'
    : day.isRest
    ? 'Rest day'
    : [hyroxSession?.title, runSession?.title, liftSession?.title].filter(Boolean).join(' + ') || 'Session'
  const runTarget = runSession?.prescriptionBasis === 'time' && runSession.durationMinutes > 0
    ? `${Math.round(runSession.durationMinutes)} min`
    : runSession && runSession.distanceMiles > 0
      ? `${runSession.distanceIsEstimate ? '~' : ''}${runSession.distanceMiles.toFixed(1)} mi`
      : (runSession ? 'Run' : '')
  const sub = day.isRest && hasRecordedRun
    ? `${recordedRunSummary(recordedRuns).replace(/^Recorded run · /, '')}${unlinkedRun ? ' · Not scheduled' : ''}`
    : day.isRest
    ? 'Recover'
    : [
        hyroxSession ? sessionTarget(hyroxSession) : '',
        runTarget,
        liftSession ? 'Lift' : '',
      ].filter(Boolean).join(' · ')
  const displayedTitle = day.isRest && hasRecordedRun ? title : briefDay?.title || title
  const displayedSub = day.isRest && hasRecordedRun
    ? sub
    : briefDay?.target || sub
  return (
    <button
      type="button"
      className="forged-day-row"
      data-today={isToday || undefined}
      data-rest={(day.isRest && !hasRecordedRun) || undefined}
      data-status={status}
      onClick={() => onOpen(day)}
    >
      <span className="forged-day-date">
        <span className="forged-day-dow">{day.dayLabel}</span>
        <span className="forged-day-num">{day.date ? day.date.getDate() : '–'}</span>
      </span>
      <span className="forged-day-main">
        <span className="forged-day-title">{displayedTitle}</span>
        <span className="forged-day-sub">{displayedSub || (isToday ? 'Today' : 'Planned')}</span>
        {briefDay && (
          <span className="forged-day-essentials">
            <span data-intensity={briefDay.intensity.key}>{briefDay.intensity.label}</span>
            {briefDay.footwear?.primary?.name && <span>{briefDay.footwear.primary.name}</span>}
            <span>{briefDay.readiness}</span>
          </span>
        )}
        <CanonicalBriefTruth canonical={briefDay?.canonical} />
        {!day.isRest && hasRecordedRun && (
          <span className="forged-day-recorded">{recordedRunSummary(recordedRuns)}{unlinkedRun ? ' · Not linked to plan' : ''}</span>
        )}
      </span>
      <span className="forged-day-stamps">
        {day.isRest && hasRecordedRun
          ? <Stamp kind="run" state="completed" small />
          : day.isRest
          ? <Stamp kind="rest" small />
          : marks.map((m) => <Stamp key={m.id} kind={m.kind} state={m.state} small />)}
      </span>
    </button>
  )
}

export default function ForgedCalendar({
  model,
  currentWeekIndex,
  weekCount,
  completedSet,
  todayISO,
  onPrevWeek,
  onNextWeek,
  onOpenDay,
  onEditGoal,
  recordedRunsByDate,
  weeklyBrief,
  canPrev,
  canNext,
}) {
  const [view, setView] = useState('week')
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const week = model?.getWeek(currentWeekIndex)
    return week?.startISO || todayISO
  })
  const touchStartX = useRef(null)

  const week = model?.getWeek(currentWeekIndex) || null
  const goal = model?.goal || {}
  const phase = model?.phaseForWeek(currentWeekIndex)
  const countdown = goal.dateISO ? countdownDays(goal.dateISO, todayISO) : null
  const goalTimeLabel = formatGoalTime(goal.goalTimeSeconds)
  const goalPaceLabel = goal.goalPaceLabel || formatGoalPace(goal.goalPaceSecondsPerMile)
  const anchoredBy = goal.anchoredBy || null
  const anchorRunDate = formatAnchorRunDate(anchoredBy?.runDate)

  const monthGrid = useMemo(
    () => (view === 'month' ? buildMonthGrid(model, monthAnchor, { todayISO, completedSet, recordedRunsByDate }) : null),
    [view, model, monthAnchor, todayISO, completedSet, recordedRunsByDate],
  )

  const weekProgress = useMemo(() => {
    const sessions = (week?.days || []).flatMap((day) => day.sessions || [])
    const total = sessions.length
    const completed = sessions.filter((session) => completedSet?.has(String(session.id))).length
    return { total, completed, percent: total ? Math.round((completed / total) * 100) : 0 }
  }, [week, completedSet])

  const handleTouchStart = (event) => { touchStartX.current = event.touches[0]?.clientX ?? null }
  const handleTouchEnd = (event) => {
    if (touchStartX.current === null) return
    const delta = (event.changedTouches[0]?.clientX ?? 0) - touchStartX.current
    if (Math.abs(delta) > 60) {
      if (delta < 0 && canNext) onNextWeek()
      else if (delta > 0 && canPrev) onPrevWeek()
    }
    touchStartX.current = null
  }

  return (
    <div className="forged-cal" style={{ width: '100%', maxWidth: '100%', minWidth: 0, overflowX: 'clip' }}>
      <SurfaceManifestSummary surface={model?.surface} />
      {/* Header */}
      <div className="rounded-lg p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div className="forged-cal-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              {typeof onEditGoal === 'function' ? (
                <button type="button" onClick={onEditGoal} aria-label={`Edit ${goal.name || 'upcoming race'}`} title="Edit upcoming race" style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: 0, border: 0, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left' }}>
                  <h2 className="text-lg font-bold" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{goal.name || 'Training plan'}</h2>
                  <span style={{ flex: '0 0 auto', width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}><Pencil size={15} /></span>
                </button>
              ) : (
                <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{goal.name || 'Training plan'}</h2>
              )}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {[
                phase ? `${phase} phase` : null,
                model?.modeLabel,
                Number.isFinite(countdown) && countdown >= 0 ? `${countdown} days to go` : null,
              ].filter(Boolean).join(' · ')}
            </p>
            {goalTimeLabel && goalPaceLabel && (
              <p className="text-xs mt-1 font-bold" style={{ color: 'var(--accent)' }}>
                {goal.goalTimeSource === 'performance_anchor' ? 'Auto target' : 'Goal'} {goalTimeLabel} · {goalPaceLabel}
              </p>
            )}
            {anchoredBy && anchorRunDate && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Target set from your {anchorRunDate} run
              </p>
            )}
          </div>
          <div className="forged-seg forged-seg--calendar" role="group" aria-label="Plan view">
            <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</button>
            <button type="button" aria-pressed={view === 'overview'} onClick={() => setView('overview')}>Overview</button>
            <button type="button" aria-pressed={view === 'month'} onClick={() => {
              setMonthAnchor(week?.startISO || todayISO)
              setView('month')
            }}>Month</button>
          </div>
        </div>
        {(model?.goals || []).length > 1 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" style={{ marginTop: 12 }} aria-label="Protected race goals">
            {model.goals.map((raceGoal, index) => (
              <div key={raceGoal.raceId || raceGoal.dateISO} className="rounded-lg p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-[10px] font-black uppercase" style={{ color: 'var(--accent)', margin: 0 }}>A{index + 1} · {raceGoal.role === 'final_peak' ? 'Final peak' : 'First peak'}</p>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)', margin: '4px 0 0' }}>{raceGoal.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)', margin: '3px 0 0' }}>
                  {formatAnchorRunDate(raceGoal.dateISO)} · {raceGoal.kind === 'hyrox' ? 'HYROX' : `${Number(raceGoal.distanceMiles || 0).toFixed(1)} mi`}
                  {raceGoal.goalTimeSeconds ? ` · ${formatGoalTime(raceGoal.goalTimeSeconds)}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {view === 'week' && (
        <div style={{ marginTop: 12 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <button
              type="button"
              onClick={onPrevWeek}
              disabled={!canPrev}
              aria-label="Previous week"
              className="rounded-lg"
              style={{ width: 44, height: 44, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', opacity: canPrev ? 1 : 0.4 }}
            >
              <ChevronLeft size={18} />
            </button>
            <div style={{ flex: 1, maxWidth: 180, textAlign: 'center', padding: '0 8px' }}>
              <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                Week {week?.weekNumber || currentWeekIndex + 1}{weekCount ? ` of ${weekCount}` : ''}
              </span>
              {weekProgress.total > 0 && (
                <>
                  <div
                    role="progressbar"
                    aria-label="Weekly workout completion"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow={weekProgress.percent}
                    style={{ height: 4, marginTop: 5, borderRadius: 4, overflow: 'hidden', background: 'var(--bg-input)' }}
                  >
                    <div style={{ width: `${weekProgress.percent}%`, height: '100%', background: 'var(--success)', borderRadius: 4 }} />
                  </div>
                  <span style={{ display: 'block', marginTop: 3, color: 'var(--text-muted)', fontSize: 10, fontWeight: 700 }}>
                    {weekProgress.percent}% complete this week
                  </span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={onNextWeek}
              disabled={!canNext}
              aria-label="Next week"
              className="rounded-lg"
              style={{ width: 44, height: 44, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', opacity: canNext ? 1 : 0.4 }}
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <WeeklyBriefHeader brief={weeklyBrief} onOpenDay={onOpenDay} />

          <div
            className="forged-week"
            data-swipe-back-ignore
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {(week?.days || []).map((day) => (
              <WeekRow
                key={day.dateISO || `${week?.weekIndex}-${day.slot}`}
                day={day}
                briefDay={weeklyBrief?.days?.find((briefDay) => briefDay.dateISO === day.dateISO)}
                isToday={day.dateISO === todayISO}
                completedSet={completedSet}
                recordedRuns={recordedRunsByDate?.get(day.dateISO) || []}
                onOpen={onOpenDay}
              />
            ))}
          </div>
        </div>
      )}

      {view === 'overview' && (
        <PlanOverview model={model} currentWeekIndex={currentWeekIndex} />
      )}

      {view === 'month' && monthGrid && (
        <div style={{ marginTop: 12 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setMonthAnchor((iso) => addMonths(iso, -1))}
              aria-label="Previous month"
              className="rounded-lg"
              style={{ width: 44, height: 44, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{monthGrid.monthLabel}</span>
            <button
              type="button"
              onClick={() => setMonthAnchor((iso) => addMonths(iso, 1))}
              aria-label="Next month"
              className="rounded-lg"
              style={{ width: 44, height: 44, display: 'grid', placeItems: 'center', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="forged-month">
            <div className="forged-month-head">
              {MONTH_DOW.map((label, index) => (
                <span key={`${WEEKDAYS[index]}-dow`} className="forged-month-dow">{label}</span>
              ))}
            </div>
            {monthGrid.rows.map((row, rowIndex) => (
              <div className="forged-month-week" key={`mw-${rowIndex}`}>
                {row.map((cell) => (
                  <button
                    type="button"
                    key={cell.dateISO}
                    className="forged-month-cell"
                    data-out={!cell.inMonth || undefined}
                    data-today={cell.isToday || undefined}
                    data-state={cell.state || undefined}
                    onClick={() => {
                      const day = model?.findDayByDate(cell.dateISO)
                      if (day || cell.hasRecordedRun) onOpenDay(day || { dateISO: cell.dateISO })
                    }}
                    aria-label={`${cell.dateISO}${cell.mark ? ` ${cell.mark}` : ''}`}
                  >
                    <span className="forged-month-num">{cell.dayOfMonth}</span>
                    <span className="forged-month-marks">
                      {cell.mark === 'hybrid' && <span className="forged-mark-dot forged-mark-dot--hybrid" />}
                      {cell.mark === 'hyrox' && <span aria-label="HYROX" style={{ color: 'var(--accent)', fontSize: 9, fontWeight: 950 }}>H</span>}
                      {cell.mark === 'run' && <span className="forged-mark-dot forged-mark-dot--run" />}
                      {cell.mark === 'lift' && <span className="forged-mark-dot forged-mark-dot--lift" />}
                      {cell.mark === 'rest' && <span className="forged-mark-dot forged-mark-dot--rest" />}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
